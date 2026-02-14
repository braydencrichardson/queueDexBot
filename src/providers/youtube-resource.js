const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { PassThrough } = require("stream");

const YT_AUDIO_FORMAT_SELECTOR =
  "bestaudio[vcodec=none][channels=2]/bestaudio[vcodec=none]/bestaudio[channels=2]/bestaudio/best";
const RESOURCE_DISPOSE_KEY = "__queueDexDispose";

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

  async function createYoutubeStreamResource(url, attempt, playerClient, useCookies, options = {}) {
    const { onStartupSleep } = options;
    const { process: ytdlp, stderrRef } = spawnYoutubeStream(url, playerClient, useCookies);
    const passthrough = new PassThrough();
    const stream = ytdlp.stdout;
    let started = false;
    let stderrProbeBuffer = "";
    const baseStartupTimeoutMs = Number.isFinite(ytdlpStreamTimeoutMs) ? ytdlpStreamTimeoutMs : 12000;

    const startPromise = new Promise((resolve, reject) => {
      const startTimeMs = Date.now();
      let effectiveTimeoutMs = baseStartupTimeoutMs;
      let timeoutHandle = null;
      let longestSleepMs = 0;

      function scheduleTimeout() {
        const elapsedMs = Date.now() - startTimeMs;
        const remainingMs = Math.max(1, effectiveTimeoutMs - elapsedMs);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        timeoutHandle = setTimeout(() => {
          if (!started) {
            reject(new Error("yt-dlp stream timeout"));
          }
        }, remainingMs);
      }

      function clearStartupWaitState() {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        ytdlp.stderr?.off?.("data", onStderrData);
      }

      function onStderrData(chunk) {
        if (started) {
          return;
        }
        stderrProbeBuffer += chunk.toString();
        if (stderrProbeBuffer.length > 1000) {
          stderrProbeBuffer = stderrProbeBuffer.slice(-1000);
        }
        const sleepMatches = [...stderrProbeBuffer.matchAll(/Sleeping\s+(\d+(?:\.\d+)?)\s+seconds/gi)];
        if (!sleepMatches.length) {
          return;
        }
        const lastSleep = sleepMatches[sleepMatches.length - 1];
        const sleepSeconds = parseFloat(lastSleep[1]);
        if (!Number.isFinite(sleepSeconds) || sleepSeconds <= 0) {
          return;
        }
        const sleepMs = Math.ceil(sleepSeconds * 1000);
        if (sleepMs <= longestSleepMs) {
          return;
        }
        longestSleepMs = sleepMs;
        const extendedTimeoutMs = Math.max(baseStartupTimeoutMs, sleepMs + 5000);
        if (extendedTimeoutMs > effectiveTimeoutMs) {
          effectiveTimeoutMs = extendedTimeoutMs;
          scheduleTimeout();
          logInfo("yt-dlp requested startup sleep; extending stream startup wait", {
            attempt,
            playerClient,
            sleepSeconds,
            startupTimeoutMs: effectiveTimeoutMs,
          });
          if (typeof onStartupSleep === "function") {
            Promise.resolve(
              onStartupSleep({
                url,
                attempt,
                playerClient,
                sleepSeconds,
                startupTimeoutMs: effectiveTimeoutMs,
              })
            ).catch((error) => {
              logInfo("onStartupSleep callback failed", { error });
            });
          }
        }
      }

      const onData = (chunk) => {
        if (!started) {
          started = true;
          clearStartupWaitState();
          passthrough.write(chunk);
          stream.pipe(passthrough);
          resolve();
        }
      };

      const onError = (error) => {
        if (!started) {
          clearStartupWaitState();
          reject(error);
        }
      };

      const onClose = (code) => {
        if (!started) {
          clearStartupWaitState();
          reject(new Error(`yt-dlp stream closed early (${code})`));
        }
      };

      scheduleTimeout();
      ytdlp.stderr?.on?.("data", onStderrData);
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
    const resource = createAudioResource(passthrough, {
      inputType: StreamType.Arbitrary,
      metadata: {
        source: "youtube",
        pipeline: "yt-dlp-stream-passthrough",
        inputType: StreamType.Arbitrary,
      },
    });
    resource[RESOURCE_DISPOSE_KEY] = () => {
      passthrough.destroy();
      if (!ytdlp.killed) {
        ytdlp.kill("SIGKILL");
      }
    };
    return resource;
  }

  async function createYoutubeResource(url, options = {}) {
    const clients = [ytdlpPlayerClient];
    if (ytdlpFallbackPlayerClient && ytdlpFallbackPlayerClient !== ytdlpPlayerClient) {
      clients.push(ytdlpFallbackPlayerClient);
    }

    if (ytdlpStream) {
      for (const client of clients) {
        const useCookies = client === ytdlpPlayerClient;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            return await createYoutubeStreamResource(url, attempt, client, useCookies, options);
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
        let cleaned = false;
        const cleanupFile = () => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          fs.unlink(filePath, () => {});
        };
        stream.on("close", cleanupFile);
        stream.on("error", cleanupFile);
        const resource = createAudioResource(stream, {
          inputType: StreamType.OggOpus,
          metadata: {
            source: "youtube",
            pipeline: "yt-dlp-download-opus",
            inputType: StreamType.OggOpus,
          },
        });
        resource[RESOURCE_DISPOSE_KEY] = () => {
          stream.destroy();
          cleanupFile();
        };
        return resource;
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
