const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { PassThrough } = require("stream");

const YT_AUDIO_FORMAT_SELECTOR =
  "bestaudio[vcodec=none][channels=2]/bestaudio[vcodec=none]/bestaudio[channels=2]/bestaudio/best";

function createYoutubeResourceFactory(deps) {
  const {
    createAudioResource,
    StreamType,
    logInfo,
    tryCheckYoutubeCookiesOnFailure,
    getYoutubeCookiesNetscapePath,
    config,
  } = deps;

  const {
    ytdlpPath,
    ytdlpPlayerClient,
    ytdlpFallbackPlayerClient,
    ytdlpCookiesFromBrowser,
    ytdlpJsRuntime,
    ytdlpRemoteComponents,
    ytdlpStream,
    ytdlpConcurrentFragments,
    ytdlpStreamTimeoutMs,
    youtubeUserAgent,
  } = config;

  function extractYoutubeId(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes("youtu.be")) {
        return parsed.pathname.replace("/", "");
      }
      return parsed.searchParams.get("v");
    } catch {
      return null;
    }
  }

  async function downloadYoutubeAudio(url, playerClient, useCookies) {
    const videoId = extractYoutubeId(url) || `unknown-${Date.now()}`;
    const outputPath = path.join("/tmp", `yt-dlp-${videoId}.%(ext)s`);
    const headers = [
      "Origin: https://www.youtube-nocookie.com",
      "Sec-Fetch-Dest: audio",
      "Sec-Fetch-Mode: cors",
      "Sec-Fetch-Site: cross-site",
    ];
    const cookiesPath = getYoutubeCookiesNetscapePath();
    const args = [
      "-f",
      YT_AUDIO_FORMAT_SELECTOR,
      "-o",
      outputPath,
      "--extract-audio",
      "--audio-format",
      "opus",
      "--audio-quality",
      "0",
      "--no-playlist",
      "--no-progress",
      ...(Number.isFinite(ytdlpConcurrentFragments)
        ? ["--concurrent-fragments", String(ytdlpConcurrentFragments)]
        : []),
      ...(ytdlpJsRuntime ? ["--js-runtimes", ytdlpJsRuntime] : []),
      ...(ytdlpRemoteComponents ? ["--remote-components", ytdlpRemoteComponents] : []),
      "--extractor-args",
      `youtube:player_client=${playerClient}`,
      "--referer",
      "https://www.youtube.com/",
      ...headers.flatMap((header) => ["--add-header", header]),
      ...(useCookies && cookiesPath ? ["--cookies", cookiesPath] : []),
      ...(useCookies && ytdlpCookiesFromBrowser ? ["--cookies-from-browser", ytdlpCookiesFromBrowser] : []),
      ...(youtubeUserAgent ? ["--user-agent", youtubeUserAgent] : []),
      url,
    ];
    const ytdlp = spawn(ytdlpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    ytdlp.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    const exitCode = await new Promise((resolve) => {
      ytdlp.on("close", resolve);
    });

    if (exitCode !== 0) {
      logInfo("yt-dlp exited with error", { code: exitCode, stderr });
      throw new Error("yt-dlp download failed");
    }

    return outputPath.replace("%(ext)s", "opus");
  }

  function spawnYoutubeStream(url, playerClient, useCookies) {
    const headers = [
      "Origin: https://www.youtube-nocookie.com",
      "Sec-Fetch-Dest: audio",
      "Sec-Fetch-Mode: cors",
      "Sec-Fetch-Site: cross-site",
    ];
    const cookiesPath = getYoutubeCookiesNetscapePath();
    const args = [
      "-f",
      YT_AUDIO_FORMAT_SELECTOR,
      "-o",
      "-",
      "--no-playlist",
      "--no-progress",
      ...(ytdlpJsRuntime ? ["--js-runtimes", ytdlpJsRuntime] : []),
      ...(ytdlpRemoteComponents ? ["--remote-components", ytdlpRemoteComponents] : []),
      "--extractor-args",
      `youtube:player_client=${playerClient}`,
      "--referer",
      "https://www.youtube.com/",
      ...headers.flatMap((header) => ["--add-header", header]),
      ...(useCookies && cookiesPath ? ["--cookies", cookiesPath] : []),
      ...(useCookies && ytdlpCookiesFromBrowser ? ["--cookies-from-browser", ytdlpCookiesFromBrowser] : []),
      ...(youtubeUserAgent ? ["--user-agent", youtubeUserAgent] : []),
      url,
    ];
    const ytdlp = spawn(ytdlpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    ytdlp.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });
    ytdlp.on("close", (exitCode) => {
      if (exitCode !== 0) {
        logInfo("yt-dlp stream exited with error", { code: exitCode, stderr });
        ytdlp.stdout.destroy(new Error("yt-dlp stream failed"));
      }
    });
    return { process: ytdlp, stderrRef: () => stderr };
  }

  async function createYoutubeStreamResource(url, attempt, playerClient, useCookies) {
    const { process: ytdlp, stderrRef } = spawnYoutubeStream(url, playerClient, useCookies);
    const passthrough = new PassThrough();
    const stream = ytdlp.stdout;
    let started = false;

    const startPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error("yt-dlp stream timeout"));
        }
      }, Number.isFinite(ytdlpStreamTimeoutMs) ? ytdlpStreamTimeoutMs : 12000);

      const onData = (chunk) => {
        if (!started) {
          started = true;
          clearTimeout(timeout);
          passthrough.write(chunk);
          stream.pipe(passthrough);
          resolve();
        }
      };

      const onError = (error) => {
        if (!started) {
          clearTimeout(timeout);
          reject(error);
        }
      };

      const onClose = (code) => {
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(`yt-dlp stream closed early (${code})`));
        }
      };

      stream.once("data", onData);
      stream.once("error", onError);
      ytdlp.once("close", onClose);
    });

    try {
      await startPromise;
    } catch (error) {
      ytdlp.kill("SIGKILL");
      throw new Error(`yt-dlp stream failed (attempt ${attempt}): ${error.message || error}`);
    }

    stream.on("end", () => {
      passthrough.end();
    });
    stream.on("error", (error) => {
      passthrough.destroy(error);
    });

    logInfo("yt-dlp stream started", { attempt, stderr: stderrRef() });
    return createAudioResource(passthrough, {
      inputType: StreamType.Arbitrary,
      metadata: {
        source: "youtube",
        pipeline: "yt-dlp-stream-passthrough",
        inputType: StreamType.Arbitrary,
      },
    });
  }

  async function createYoutubeResource(url) {
    const clients = [ytdlpPlayerClient];
    if (ytdlpFallbackPlayerClient && ytdlpFallbackPlayerClient !== ytdlpPlayerClient) {
      clients.push(ytdlpFallbackPlayerClient);
    }

    if (ytdlpStream) {
      for (const client of clients) {
        const useCookies = client === ytdlpPlayerClient;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            return await createYoutubeStreamResource(url, attempt, client, useCookies);
          } catch (error) {
            logInfo("yt-dlp stream attempt failed", { attempt, client, error });
            await tryCheckYoutubeCookiesOnFailure();
          }
        }
      }
    }

    let lastError = null;
    for (const client of clients) {
      const useCookies = client === ytdlpPlayerClient;
      try {
        const filePath = await downloadYoutubeAudio(url, client, useCookies);
        const stream = fs.createReadStream(filePath);
        stream.on("close", () => {
          fs.unlink(filePath, () => {});
        });
        return createAudioResource(stream, {
          inputType: StreamType.OggOpus,
          metadata: {
            source: "youtube",
            pipeline: "yt-dlp-download-opus",
            inputType: StreamType.OggOpus,
          },
        });
      } catch (error) {
        lastError = error;
        logInfo("yt-dlp download failed for client", { client, error });
        await tryCheckYoutubeCookiesOnFailure();
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error("yt-dlp download failed");
  }

  return {
    createYoutubeResource,
  };
}

module.exports = {
  createYoutubeResourceFactory,
};
