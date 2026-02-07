const { Client, Intents } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");
const playdl = require("play-dl");
const sodium = require("libsodium-wrappers");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const https = require("https");
const { PassThrough } = require("stream");
const { createDevLogger } = require("./src/logging/dev-logger");
const { searchYouTubeOptions, searchYouTubePreferred, getYoutubeId, toShortYoutubeUrl } = require("./src/providers/youtube-search");
const { createTrackResolver } = require("./src/providers/track-resolver");
const { enqueueTracks, ensureTrackId, getTrackIndexById, getQueuedTrackIndex, formatDuration } = require("./src/queue/utils");
const { createQueuePlayback } = require("./src/queue/playback");
const { createQueueSession } = require("./src/queue/session");
const { buildQueueViewComponents, formatQueueViewContent, buildMoveMenu } = require("./src/ui/queueView");
const { buildQueuedActionComponents, buildNowPlayingControls } = require("./src/ui/controls");
const { createSearchChooser } = require("./src/ui/search-chooser");
const { registerInteractionHandler } = require("./src/handlers/interaction");
const { registerReadyHandler } = require("./src/handlers/ready");
const { registerVoiceStateHandler } = require("./src/handlers/voice-state");

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const YOUTUBE_COOKIES = process.env.YOUTUBE_COOKIES;
const YOUTUBE_COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH;
const YOUTUBE_USER_AGENT = process.env.YOUTUBE_USER_AGENT;
const SOUNDCLOUD_USER_AGENT = process.env.SOUNDCLOUD_USER_AGENT;
const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";
const YTDLP_PLAYER_CLIENT = process.env.YTDLP_PLAYER_CLIENT || "web";
const YTDLP_FALLBACK_PLAYER_CLIENT = process.env.YTDLP_FALLBACK_PLAYER_CLIENT || "android";
const YTDLP_COOKIES_FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER;
const YTDLP_JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || "node";
const YTDLP_REMOTE_COMPONENTS = process.env.YTDLP_REMOTE_COMPONENTS || "ejs:github";
const YTDLP_STREAM = process.env.YTDLP_STREAM === "1";
const YTDLP_CONCURRENT_FRAGMENTS = parseInt(process.env.YTDLP_CONCURRENT_FRAGMENTS || "", 10);
const YTDLP_STREAM_TIMEOUT_MS = parseInt(process.env.YTDLP_STREAM_TIMEOUT_MS || "12000", 10);
const INTERACTION_TIMEOUT_MS = parseInt(process.env.INTERACTION_TIMEOUT_MS || "45000", 10);
const DEV_ALERT_CHANNEL_ID = process.env.DEV_ALERT_CHANNEL_ID;
const DEV_LOG_CHANNEL_ID = process.env.DEV_LOG_CHANNEL_ID;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const SPOTIFY_MARKET = process.env.SPOTIFY_MARKET || "US";

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const SEARCH_CHOOSER_MAX_RESULTS = 5;

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Intents.FLAGS.GUILD_VOICE_STATES,
  ],
  partials: ["MESSAGE", "CHANNEL", "REACTION"],
});

const queues = new Map();
const queueViews = new Map();
const pendingSearches = new Map();
const pendingMoves = new Map();
const pendingQueuedActions = new Map();
const { logInfo, logError } = createDevLogger({
  client,
  devAlertChannelId: DEV_ALERT_CHANNEL_ID,
  devLogChannelId: DEV_LOG_CHANNEL_ID,
});

let soundcloudReady = false;
let soundcloudClientId = null;
let youtubeReady = false;
let youtubeCookieWarned = false;
let youtubeCookieHeader = null;
let youtubeCookiesNetscapePath = null;
let youtubeCookieCheckOnFailure = false;
let youtubeCookieAlerted = false;
let spotifyReady = false;

function hasSpotifyCredentials() {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REFRESH_TOKEN);
}

function parseCookiesInput(rawInput) {
  if (!rawInput) {
    return null;
  }
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return trimmed
    .split(";")
    .map((entry) => {
      const [rawKey, ...rest] = entry.split("=");
      const key = rawKey?.trim();
      if (!key) {
        return null;
      }
      return { name: key, value: rest.join("=").trim() };
    })
    .filter(Boolean);
}

function cookiesToHeader(cookiesInput) {
  if (!Array.isArray(cookiesInput)) {
    return null;
  }
  const parts = cookiesInput
    .map((cookie) => {
      if (!cookie?.name || cookie?.value === undefined) {
        return null;
      }
      return `${cookie.name}=${cookie.value}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

function filterYoutubeCookies(cookiesInput) {
  if (!Array.isArray(cookiesInput)) {
    return [];
  }
  return cookiesInput.filter((cookie) => {
    const domain = cookie?.domain || "";
    return domain.includes("youtube.com");
  });
}

function toNetscapeCookieLine(cookie) {
  const domain = cookie.domain || "";
  const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
  const pathValue = cookie.path || "/";
  const secure = cookie.secure ? "TRUE" : "FALSE";
  const expiry = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
  const name = String(cookie.name || "").replace(/\t|\n/g, " ");
  const value = String(cookie.value ?? "").replace(/\t|\n/g, " ");
  return `${domain}\t${includeSubdomains}\t${pathValue}\t${secure}\t${expiry}\t${name}\t${value}`;
}

function writeNetscapeCookies(cookiesInput) {
  const lines = ["# Netscape HTTP Cookie File"];
  cookiesInput.forEach((cookie) => {
    if (!cookie?.name || cookie?.value === undefined || !cookie?.domain) {
      return;
    }
    lines.push(toNetscapeCookieLine(cookie));
  });
  const filePath = path.join("/tmp", "yt-dlp-cookies.txt");
  fs.writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

function loadYoutubeCookies() {
  if (YOUTUBE_COOKIES_PATH) {
    try {
      const fileContents = fs.readFileSync(YOUTUBE_COOKIES_PATH, "utf8");
      return parseCookiesInput(fileContents);
    } catch (error) {
    logError("Failed to read YOUTUBE_COOKIES_PATH", error);
      return null;
    }
  }

  const defaultPath = path.join(process.cwd(), ".cookies.json");
  if (fs.existsSync(defaultPath)) {
    try {
      const fileContents = fs.readFileSync(defaultPath, "utf8");
      return parseCookiesInput(fileContents);
    } catch (error) {
      logError("Failed to read default .cookies.json", error);
    }
  }

  return parseCookiesInput(YOUTUBE_COOKIES);
}

async function ensureSoundcloudReady() {
  if (soundcloudReady) {
    return;
  }
  try {
    const clientId = await playdl.getFreeClientID();
    await playdl.setToken({
      soundcloud: {
        client_id: clientId,
      },
    });
    soundcloudClientId = clientId;
    soundcloudReady = true;
    logInfo("SoundCloud client ID initialized");
  } catch (error) {
    logError("SoundCloud initialization failed", error);
  }
}

async function ensureYoutubeReady() {
  if (youtubeReady) {
    return;
  }
  const cookiesInput = loadYoutubeCookies();
  if (!cookiesInput || !cookiesInput.length) {
    if (!youtubeCookieWarned) {
      logInfo("YouTube cookies missing or invalid. Use a JSON array on one line or set YOUTUBE_COOKIES_PATH.");
      youtubeCookieWarned = true;
    }
    return;
  }
  try {
    const filteredCookies = filterYoutubeCookies(cookiesInput);
    youtubeCookieHeader = cookiesToHeader(filteredCookies) || null;
    youtubeCookiesNetscapePath = writeNetscapeCookies(filteredCookies);
    if (youtubeCookieHeader || YOUTUBE_USER_AGENT) {
      await playdl.setToken({
        youtube: youtubeCookieHeader
          ? {
              cookie: youtubeCookieHeader,
            }
          : undefined,
        useragent: YOUTUBE_USER_AGENT ? [YOUTUBE_USER_AGENT] : undefined,
      });
    }
    youtubeReady = true;
    logInfo("YouTube cookies initialized", {
      count: cookiesInput.length,
      source: YOUTUBE_COOKIES_PATH ? "YOUTUBE_COOKIES_PATH" : fs.existsSync(path.join(process.cwd(), ".cookies.json")) ? ".cookies.json" : "YOUTUBE_COOKIES",
    });
    const cookieCheck = await checkYoutubeCookiesLoggedIn(youtubeCookieHeader);
    if (!cookieCheck.ok) {
      logInfo("YouTube cookies may be invalid or expired.", cookieCheck);
      if (!youtubeCookieAlerted) {
        youtubeCookieAlerted = true;
        await sendDevAlert("YouTube cookies may be invalid or expired. Check logs for details.");
      }
    }
  } catch (error) {
    logError("YouTube cookie initialization failed", error);
  }
}

async function ensureSpotifyReady() {
  if (spotifyReady) {
    return;
  }
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
    throw new Error("Spotify credentials missing. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN.");
  }
  await playdl.setToken({
    spotify: {
      client_id: SPOTIFY_CLIENT_ID,
      client_secret: SPOTIFY_CLIENT_SECRET,
      refresh_token: SPOTIFY_REFRESH_TOKEN,
      market: SPOTIFY_MARKET,
    },
  });
  spotifyReady = true;
}

const {
  getSpotifySearchOptions,
  isProbablyUrl,
  isSpotifyUrl,
  resolveTracks,
} = createTrackResolver({
  playdl,
  searchYouTubeOptions,
  searchYouTubePreferred,
  getYoutubeId,
  toShortYoutubeUrl,
  ensureSoundcloudReady,
  ensureYoutubeReady,
  ensureSpotifyReady,
  hasSpotifyCredentials,
  getSoundcloudClientId: () => soundcloudClientId,
  searchChooserMaxResults: SEARCH_CHOOSER_MAX_RESULTS,
  soundcloudUserAgent: SOUNDCLOUD_USER_AGENT,
  youtubeUserAgent: YOUTUBE_USER_AGENT,
  logInfo,
  logError,
});

async function ensureSodiumReady() {
  try {
    await sodium.ready;
  } catch (error) {
    logError("libsodium failed to initialize", error);
  }
}

let playNext = async () => {
  throw new Error("playNext not initialized");
};

const {
  announceNowPlayingAction,
  ensurePlayerListeners,
  getGuildQueue,
  isSameVoiceChannel,
  sendNowPlaying,
  stopAndLeaveQueue,
} = createQueueSession({
  queues,
  createAudioPlayer,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  formatDuration,
  buildNowPlayingControls,
  logInfo,
  logError,
  getPlayNext: () => playNext,
});

const { maybeSendSearchChooser } = createSearchChooser({
  playdl,
  isSpotifyUrl,
  hasSpotifyCredentials,
  getSpotifySearchOptions,
  isProbablyUrl,
  searchYouTubeOptions,
  formatDuration,
  interactionTimeoutMs: INTERACTION_TIMEOUT_MS,
  pendingSearches,
  logInfo,
  logError,
  searchChooserMaxResults: SEARCH_CHOOSER_MAX_RESULTS,
});

function normalizeQueryInput(input) {
  const trimmed = input.trim();
  return trimmed.replace(/^\/?play\s+/i, "");
}

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
  const args = [
    "-f",
    "bestaudio/best",
    "-o",
    outputPath,
    "--extract-audio",
    "--audio-format",
    "opus",
    "--audio-quality",
    "0",
    "--no-playlist",
    "--no-progress",
    ...(Number.isFinite(YTDLP_CONCURRENT_FRAGMENTS)
      ? ["--concurrent-fragments", String(YTDLP_CONCURRENT_FRAGMENTS)]
      : []),
    ...(YTDLP_JS_RUNTIME ? ["--js-runtimes", YTDLP_JS_RUNTIME] : []),
    ...(YTDLP_REMOTE_COMPONENTS ? ["--remote-components", YTDLP_REMOTE_COMPONENTS] : []),
    "--extractor-args",
    `youtube:player_client=${playerClient}`,
    "--referer",
    "https://www.youtube.com/",
    ...headers.flatMap((header) => ["--add-header", header]),
    ...(useCookies && youtubeCookiesNetscapePath ? ["--cookies", youtubeCookiesNetscapePath] : []),
    ...(useCookies && YTDLP_COOKIES_FROM_BROWSER ? ["--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER] : []),
    ...(YOUTUBE_USER_AGENT ? ["--user-agent", YOUTUBE_USER_AGENT] : []),
    url,
  ];
  const ytdlp = spawn(YTDLP_PATH, args, {
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

  const actualPath = outputPath.replace("%(ext)s", "opus");
  return actualPath;
}

function spawnYoutubeStream(url, playerClient, useCookies) {
  const headers = [
    "Origin: https://www.youtube-nocookie.com",
    "Sec-Fetch-Dest: audio",
    "Sec-Fetch-Mode: cors",
    "Sec-Fetch-Site: cross-site",
  ];
  const args = [
    "-f",
    "bestaudio/best",
    "-o",
    "-",
    "--no-playlist",
    "--no-progress",
    ...(YTDLP_JS_RUNTIME ? ["--js-runtimes", YTDLP_JS_RUNTIME] : []),
    ...(YTDLP_REMOTE_COMPONENTS ? ["--remote-components", YTDLP_REMOTE_COMPONENTS] : []),
    "--extractor-args",
    `youtube:player_client=${playerClient}`,
    "--referer",
    "https://www.youtube.com/",
    ...headers.flatMap((header) => ["--add-header", header]),
    ...(useCookies && youtubeCookiesNetscapePath ? ["--cookies", youtubeCookiesNetscapePath] : []),
    ...(useCookies && YTDLP_COOKIES_FROM_BROWSER ? ["--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER] : []),
    ...(YOUTUBE_USER_AGENT ? ["--user-agent", YOUTUBE_USER_AGENT] : []),
    url,
  ];
  const ytdlp = spawn(YTDLP_PATH, args, {
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
    }, Number.isFinite(YTDLP_STREAM_TIMEOUT_MS) ? YTDLP_STREAM_TIMEOUT_MS : 12000);

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
  });
}

async function maybeCheckYoutubeCookiesOnFailure() {
  if (youtubeCookieCheckOnFailure || !youtubeCookieHeader) {
    return;
  }
  youtubeCookieCheckOnFailure = true;
  const cookieCheck = await checkYoutubeCookiesLoggedIn(youtubeCookieHeader);
  if (!cookieCheck.ok) {
    logInfo("YouTube cookies may be invalid or expired.", cookieCheck);
    if (!youtubeCookieAlerted) {
      youtubeCookieAlerted = true;
      await sendDevAlert("YouTube cookies may be invalid or expired. Check logs for details.");
    }
  }
}

async function createYoutubeResource(url) {
  const clients = [YTDLP_PLAYER_CLIENT];
  if (YTDLP_FALLBACK_PLAYER_CLIENT && YTDLP_FALLBACK_PLAYER_CLIENT !== YTDLP_PLAYER_CLIENT) {
    clients.push(YTDLP_FALLBACK_PLAYER_CLIENT);
  }
  if (YTDLP_STREAM) {
    for (const client of clients) {
      const useCookies = client === YTDLP_PLAYER_CLIENT;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await createYoutubeStreamResource(url, attempt, client, useCookies);
        } catch (error) {
          logInfo("yt-dlp stream attempt failed", { attempt, client, error });
          await maybeCheckYoutubeCookiesOnFailure();
        }
      }
    }
  }

  let lastError = null;
  for (const client of clients) {
    const useCookies = client === YTDLP_PLAYER_CLIENT;
    try {
      const filePath = await downloadYoutubeAudio(url, client, useCookies);
      const stream = fs.createReadStream(filePath);
      stream.on("close", () => {
        fs.unlink(filePath, () => {});
      });
      return createAudioResource(stream, {
        inputType: StreamType.OggOpus,
      });
    } catch (error) {
      lastError = error;
      logInfo("yt-dlp download failed for client", { client, error });
      await maybeCheckYoutubeCookiesOnFailure();
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("yt-dlp download failed");
}

function checkYoutubeCookiesLoggedIn(cookieHeader) {
  if (!cookieHeader) {
    return Promise.resolve({ ok: false, reason: "missing_cookie_header" });
  }
  const headers = {
    "User-Agent": YOUTUBE_USER_AGENT || "Mozilla/5.0",
    Cookie: cookieHeader,
    "Accept-Language": "en-US,en;q=0.9",
  };
  const checkUrl = (url) =>
    new Promise((resolve) => {
      https
        .get(url, { headers }, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            const location = String(res.headers.location || "");
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
              const needsLogin = /ServiceLogin|accounts\.google\.com/i.test(location);
              resolve({ ok: !needsLogin, reason: needsLogin ? "redirect_to_login" : "redirect" });
              return;
            }
            const body = data.slice(0, 20000);
            if (/signin|sign in/i.test(body)) {
              resolve({ ok: false, reason: "signin_marker" });
              return;
            }
            resolve({ ok: true, reason: "ok" });
          });
        })
        .on("error", () => resolve({ ok: false, reason: "request_failed" }));
    });

  return (async () => {
    const primary = await checkUrl("https://www.youtube.com/feed/subscriptions");
    if (primary.ok) {
      return { ...primary, url: "subscriptions" };
    }
    const secondary = await checkUrl("https://www.youtube.com/account");
    return { ...secondary, url: "account", fallbackFrom: primary.reason };
  })();
}

({ playNext } = createQueuePlayback({
  playdl,
  createAudioResource,
  StreamType,
  createYoutubeResource,
  getGuildQueue,
  queueViews,
  sendNowPlaying,
  logInfo,
  logError,
}));

registerReadyHandler(client, { logInfo });
registerVoiceStateHandler(client, { queues, stopAndLeaveQueue });

registerInteractionHandler(client, {
  AudioPlayerStatus,
  INTERACTION_TIMEOUT_MS,
  joinVoiceChannel,
  getGuildQueue,
  isSameVoiceChannel,
  announceNowPlayingAction,
  buildNowPlayingControls,
  formatQueueViewContent,
  buildQueueViewComponents,
  buildMoveMenu,
  buildQueuedActionComponents,
  getTrackIndexById,
  ensureTrackId,
  getQueuedTrackIndex,
  enqueueTracks,
  pendingSearches,
  pendingMoves,
  pendingQueuedActions,
  queueViews,
  logInfo,
  logError,
  sendNowPlaying,
  playNext,
  normalizeQueryInput,
  ensureSodiumReady,
  ensurePlayerListeners,
  maybeSendSearchChooser,
  resolveTracks,
  isSpotifyUrl,
  hasSpotifyCredentials,
  stopAndLeaveQueue,
});

client.login(TOKEN);
