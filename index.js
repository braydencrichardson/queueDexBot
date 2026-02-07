const { Client, Intents, MessageActionRow, MessageButton, MessageSelectMenu } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");
const ytdl = require("@distube/ytdl-core");
const yts = require("yt-search");
const playdl = require("play-dl");
const sodium = require("libsodium-wrappers");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const https = require("https");
const { PassThrough } = require("stream");
const util = require("util");

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
let nextTrackId = 1;

function formatLogMessage(stamp, message, data) {
  let line = `[${stamp}] ${message}`;
  if (data !== undefined) {
    let dataText = "";
    if (typeof data === "string") {
      dataText = data;
    } else {
      try {
        dataText = JSON.stringify(data);
      } catch {
        dataText = util.inspect(data, { depth: 2, breakLength: 80 });
      }
    }
    if (dataText) {
      line += ` ${dataText}`;
    }
  }
  return line;
}

function logInfo(message, data) {
  const stamp = new Date().toISOString();
  const line = formatLogMessage(stamp, message, data);
  if (data !== undefined) {
    console.log(`[${stamp}] ${message}`, data);
    void sendDevLog(line);
    return;
  }
  console.log(`[${stamp}] ${message}`);
  void sendDevLog(line);
}

function logError(message, error) {
  const stamp = new Date().toISOString();
  const line = formatLogMessage(stamp, message, error);
  if (error !== undefined) {
    console.error(`[${stamp}] ${message}`, error);
  } else {
    console.error(`[${stamp}] ${message}`);
  }
  void sendDevLog(line);
  void sendDevAlert(line);
}

async function sendDevAlert(message) {
  if (!DEV_ALERT_CHANNEL_ID || !client?.user) {
    return;
  }
  try {
    const channel = await client.channels.fetch(DEV_ALERT_CHANNEL_ID);
    if (!channel?.send) {
      return;
    }
    await channel.send(message);
  } catch (error) {
    console.log("Failed to send dev alert", error);
  }
}

async function sendDevLog(message) {
  if (!DEV_LOG_CHANNEL_ID || !client?.user) {
    return;
  }
  try {
    const channel = await client.channels.fetch(DEV_LOG_CHANNEL_ID);
    if (!channel?.send) {
      return;
    }
    const trimmed = String(message || "").slice(0, 1900);
    if (!trimmed) {
      return;
    }
    await channel.send(trimmed);
  } catch (error) {
    console.log("Failed to send dev log", error);
  }
}

let soundcloudReady = false;
let soundcloudClientId = null;
let youtubeReady = false;
let youtubeAgent = null;
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
    youtubeAgent = ytdl.createAgent(filteredCookies);
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

function getYoutubeId(value) {
  if (!value) {
    return null;
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      return url.pathname.replace("/", "");
    }
    if (url.hostname.endsWith("youtube.com")) {
      const id = url.searchParams.get("v");
      if (id) {
        return id;
      }
      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/")[2];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function toShortYoutubeUrl(value) {
  const id = getYoutubeId(value);
  if (!id) {
    return value;
  }
  return `https://youtu.be/${id}`;
}

function toSoundcloudPermalink(value) {
  if (!value) {
    return value;
  }
  try {
    const url = new URL(value);
    const decodedPath = decodeURIComponent(url.pathname);
    const parts = decodedPath.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    if (last.startsWith("soundcloud:tracks:")) {
      const id = last.split(":").pop();
      return id ? `https://soundcloud.com/tracks/${id}` : value;
    }
    if (url.hostname === "api.soundcloud.com" && parts[0] === "tracks" && parts[1]) {
      return `https://soundcloud.com/tracks/${parts[1]}`;
    }
  } catch {
    return value;
  }
  return value;
}

function getSoundcloudTrackId(value) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.hostname === "api.soundcloud.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "tracks" && parts[1]) {
        return parts[1];
      }
    }
  } catch {
    // ignore
  }
  const decoded = decodeURIComponent(String(value));
  const tokenMatch = decoded.match(/soundcloud:tracks:(\d+)/);
  if (tokenMatch) {
    return tokenMatch[1];
  }
  const idMatch = decoded.match(/soundcloud\.com\/tracks\/(\d+)/);
  if (idMatch) {
    return idMatch[1];
  }
  return null;
}

async function resolveSoundcloudDisplayUrl(trackUrl, permalinkUrl) {
  const direct = toSoundcloudPermalink(permalinkUrl || trackUrl);
  if (direct && !direct.includes("soundcloud.com/tracks/")) {
    return direct;
  }
  if (!soundcloudClientId) {
    return direct;
  }
  const trackId = getSoundcloudTrackId(trackUrl);
  if (!trackId) {
    return direct;
  }
  try {
    const trackInfo = await httpGetJson(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${soundcloudClientId}`);
    return trackInfo?.permalink_url || direct;
  } catch (error) {
    logError("SoundCloud permalink lookup failed", error);
    return direct;
  }
}

function tokenizeQuery(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\(\)\[\]{}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseQueryParts(query) {
  const raw = String(query || "");
  const parts = raw.split(" - ").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { artist: parts[0], title: parts.slice(1).join(" - ") };
  }
  return { title: raw.trim() };
}

function scoreYouTubeVideo(video, requiredTokens, artistTokens, matchOptions) {
  const title = String(video.title || "").toLowerCase();
  const titleTokens = new Set(tokenizeQuery(title));
  const requiredMatches = requiredTokens.filter((token) => titleTokens.has(token)).length;
  const artistMatches = artistTokens.filter((token) => titleTokens.has(token)).length;
  const minTitleRatio = matchOptions?.minTitleMatchRatio ?? 0.5;
  const minArtistRatio = matchOptions?.minArtistMatchRatio ?? 0.5;
  if (requiredTokens.length && requiredMatches / requiredTokens.length < minTitleRatio) {
    return -Infinity;
  }
  if (artistTokens.length && artistMatches / artistTokens.length < minArtistRatio) {
    return -Infinity;
  }
  let score = requiredMatches * 2 + artistMatches * 3;
  if (title.includes("official audio")) score += 3;
  if (title.includes("official music video")) score += 3;
  if (title.includes("official")) score += 1;
  if (title.includes("audio")) score += 2;
  if (title.includes("music video")) score += 2;
  if (title.includes("lyric")) score += 1;
  if (title.includes("live")) score -= 2;
  if (title.includes("cover")) score -= 2;
  return score;
}

function pickYouTubeVideo(videos, query, matchOptions) {
  if (!Array.isArray(videos) || !videos.length) {
    return null;
  }
  const parsed = parseQueryParts(query);
  const requiredTokens = tokenizeQuery(parsed.title || query);
  const artistTokens = tokenizeQuery(parsed.artist || "");
  const scored = videos
    .filter((video) => typeof video.seconds === "number" && video.seconds > 30)
    .map((video) => ({
      video,
      score: scoreYouTubeVideo(video, requiredTokens, artistTokens, matchOptions),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);

  if (scored.length) {
    return scored[0].video;
  }

  return videos[0];
}

function rankYouTubeVideos(videos, query, matchOptions) {
  if (!Array.isArray(videos) || !videos.length) {
    return [];
  }
  const parsed = parseQueryParts(query);
  const requiredTokens = tokenizeQuery(parsed.title || query);
  const artistTokens = tokenizeQuery(parsed.artist || "");
  const scored = videos
    .filter((video) => typeof video.seconds === "number" && video.seconds > 30)
    .map((video) => ({
      video,
      score: scoreYouTubeVideo(video, requiredTokens, artistTokens, matchOptions),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.video);

  return scored.length ? scored : videos;
}

async function searchYouTubeOptions(query, requester, matchOptions, limit = 5) {
  const variants = [
    `${query} official audio`,
    `${query} official music video`,
    `${query} audio`,
    `${query} lyrics`,
    query,
  ];
  const baseQuery = String(query || "");
  for (const searchQuery of variants) {
    const results = await yts(searchQuery);
    const ranked = rankYouTubeVideos(results.videos, baseQuery, matchOptions);
    if (ranked.length) {
      return ranked.slice(0, limit).map((video) => ({
        title: video.title,
        url: toShortYoutubeUrl(video.videoId || video.url),
        channel: video.author?.name || video.channel?.name || null,
        source: "youtube",
        duration: typeof video.seconds === "number" ? video.seconds : null,
        requester,
      }));
    }
  }
  return [];
}

async function searchYouTubePreferred(query, requester, matchOptions) {
  const variants = [
    `${query} official audio`,
    `${query} official music video`,
    `${query} audio`,
    `${query} lyrics`,
    query,
  ];
  const baseQuery = String(query || "");
  for (const searchQuery of variants) {
    const results = await yts(searchQuery);
    const top = pickYouTubeVideo(results.videos, baseQuery, matchOptions);
    if (top) {
      const id = top.videoId || getYoutubeId(top.url);
      return {
        title: top.title,
        url: toShortYoutubeUrl(id || top.url),
        source: "youtube",
        duration: typeof top.seconds === "number" ? top.seconds : null,
        requester,
      };
    }
  }
  return null;
}

function isSpotifyUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith("spotify.com");
  } catch {
    return false;
  }
}

async function fetchSpotifyOembed(url) {
  try {
    const embedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const data = await httpGetJson(embedUrl);
    if (data?.author_name || data?.title) {
      return data;
    }
    const id = getSpotifyId(url);
    if (id) {
      const altUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(`spotify:track:${id}`)}`;
      const altData = await httpGetJson(altUrl);
      return altData || data;
    }
    return data;
  } catch (error) {
    logError("Spotify oEmbed failed", error);
    return null;
  }
}

async function fetchSpotifyMeta(url) {
  try {
    const headers = {
      "User-Agent": YOUTUBE_USER_AGENT || "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
    };
    const html = await httpGetText(url, headers);
    let { title, artist, album } = extractSpotifyMetaFromHtml(html);

    if (!title) {
      const id = getSpotifyId(url);
      if (id) {
        const embedUrl = `https://open.spotify.com/embed/track/${id}`;
        const embedHtml = await httpGetText(embedUrl, headers);
        const embedMeta = extractSpotifyMetaFromHtml(embedHtml);
        title = title || embedMeta.title;
        artist = artist || embedMeta.artist;
        album = album || embedMeta.album;
      }
    }
    if (!title && !artist) {
      logInfo("Spotify meta tags missing", {
        length: html.length,
        hasOgTitle: html.includes("og:title"),
        hasOgDesc: html.includes("og:description"),
      });
    }
    return { title, artist, album };
  } catch (error) {
    logError("Spotify page meta failed", error);
    return null;
  }
}

function buildSpotifyQueries({ name, artists, album }) {
  const parts = [];
  const artistText = Array.isArray(artists) ? artists.filter(Boolean).join(" ") : artists;
  if (name && artistText) {
    parts.push(`${artistText} - ${name}`);
  }
  if (name && artistText && album) {
    parts.push(`${name} ${artistText} ${album}`);
  }
  if (name && artistText) {
    parts.push(`${name} ${artistText}`);
  }
  if (name && album) {
    parts.push(`${name} ${album}`);
  }
  if (name) {
    parts.push(name);
  }
  return Array.from(new Set(parts));
}

function isProbablyUrl(value) {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return Boolean(url?.protocol && url?.hostname);
  } catch {
    return false;
  }
}

async function getSpotifySearchOptions(url, requester) {
  const embed = await fetchSpotifyOembed(url);
  const meta = await fetchSpotifyMeta(url);
  const title = embed?.title || meta?.title;
  const author = embed?.author_name || meta?.artist;
  logInfo("Spotify oEmbed data", {
    title: embed?.title,
    author: embed?.author_name,
    url: embed?.url,
  });
  if (meta) {
    logInfo("Spotify meta data", meta);
  }
  if (!title) {
    return [];
  }
  const queries = buildSpotifyQueries({
    name: title,
    artists: author ? [author] : [],
    album: meta?.album,
  });
  for (const query of queries) {
    const options = await searchYouTubeOptions(query, requester, {
      minArtistMatchRatio: 1,
      minTitleMatchRatio: 0.6,
    }, SEARCH_CHOOSER_MAX_RESULTS);
    if (options.length) {
      return options;
    }
  }
  return [];
}

async function resolveSpotifyTracks(url, type, requester) {
  const hasCredentials = hasSpotifyCredentials();
  if (type === "track" && !hasCredentials) {
    const options = await getSpotifySearchOptions(url, requester);
    return options.length ? [options[0]] : [];
  }

  if (!hasCredentials) {
    throw new Error("Spotify playlists and albums require API credentials (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN).");
  }

  await ensureSpotifyReady();
  const info = await playdl.spotify(url);
  if (info.type === "track") {
    logInfo("Spotify track data", {
      name: info.name,
      artists: Array.isArray(info.artists) ? info.artists.map((artist) => artist.name) : [],
      album: info.album?.name,
    });
    const queries = buildSpotifyQueries({
      name: info.name,
      artists: Array.isArray(info.artists) ? info.artists.map((artist) => artist.name) : [],
      album: info.album?.name,
    });
    for (const query of queries) {
      const track = await searchYouTubePreferred(query, requester, {
        minArtistMatchRatio: 1,
        minTitleMatchRatio: 0.6,
      });
      if (track) {
        return [track];
      }
    }
    return [];
  }

  if (info.type === "playlist" || info.type === "album") {
    logInfo("Spotify list data", {
      type: info.type,
      name: info.name,
      totalTracks: info.total_tracks,
    });
    const tracks = await info.all_tracks();
    const results = [];
    for (const track of tracks) {
      const queries = buildSpotifyQueries({
        name: track.name,
        artists: Array.isArray(track.artists) ? track.artists.map((artist) => artist.name) : [],
        album: track.album?.name,
      });
      for (const query of queries) {
        const match = await searchYouTubePreferred(query, requester, {
          minArtistMatchRatio: 1,
          minTitleMatchRatio: 0.6,
        });
        if (match) {
          results.push(match);
          break;
        }
      }
    }
    return results;
  }

  return [];
}

async function ensureSodiumReady() {
  try {
    await sodium.ready;
  } catch (error) {
    logError("libsodium failed to initialize", error);
  }
}

function getGuildQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      textChannel: null,
      voiceChannel: null,
      connection: null,
      player: createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      }),
      tracks: [],
      current: null,
      nowPlayingMessageId: null,
      nowPlayingChannelId: null,
      nowPlayingDeleteTimeout: null,
      playing: false,
      playerListenersReady: false,
    });
  }
  return queues.get(guildId);
}

function formatNowPlaying(queue) {
  if (!queue.current) {
    return "Nothing is playing.";
  }
  const remaining = queue.tracks.length;
  const nextTrack = queue.tracks[0];
  const nowDuration = formatDuration(queue.current.duration);
  const nowRequester = queue.current.requester ? ` (requested by ${queue.current.requester})` : "";
  const nextDuration = formatDuration(nextTrack?.duration);
  const displayUrl = queue.current.displayUrl || queue.current.url;
  const nowLink = (queue.current.source === "youtube" || queue.current.source === "soundcloud") && displayUrl
    ? ` (${displayUrl})`
    : "";
  const nowLine = `Now playing: ${queue.current.title}${nowDuration ? ` (**${nowDuration}**)` : ""}${nowRequester ? ` (requested by **${queue.current.requester}**)` : ""}${nowLink}`;
  const nextLine = nextTrack
    ? `Up next: ${nextTrack.title}${nextDuration ? ` (**${nextDuration}**)` : ""}${nextTrack.requester ? ` (requested by **${nextTrack.requester}**)` : ""}`
    : "Up next: (empty)";
  const countLine = `Remaining: ${remaining}`;
  return `${nowLine}\n${nextLine}\n${countLine}`;
}

function formatQueuePage(queue, page, pageSize, selectedTrackId) {
  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const totalQueued = (queue.current ? 1 : 0) + queue.tracks.length;
  const totalSeconds = [queue.current, ...queue.tracks]
    .filter(Boolean)
    .reduce((sum, track) => sum + (typeof track.duration === "number" ? track.duration : 0), 0);
  const totalDuration = formatDuration(totalSeconds);
  const lines = [
    `Total queued: ${totalQueued}${totalDuration ? ` (${totalDuration})` : ""}`,
  ];
  if (queue.current) {
    const nowDuration = formatDuration(queue.current.duration);
    const nowDisplayUrl = queue.current.displayUrl || queue.current.url;
    const nowLink = (queue.current.source === "youtube" || queue.current.source === "soundcloud") && nowDisplayUrl
      ? ` (<${nowDisplayUrl}>)`
      : "";
    lines.push(`Now playing: ${queue.current.title}${nowDuration ? ` (**${nowDuration}**)` : ""}${queue.current.requester ? ` (requested by **${queue.current.requester}**)` : ""}${nowLink}`);
  }
  if (queue.tracks.length) {
    lines.push(`Up next (page ${safePage}/${totalPages}):`);
    const preview = queue.tracks
      .slice(startIndex, startIndex + pageSize)
      .map((track, index) => {
        ensureTrackId(track);
        const duration = formatDuration(track.duration);
        const displayUrl = track.displayUrl || track.url;
        const link = (track.source === "youtube" || track.source === "soundcloud") && displayUrl
          ? ` (<${displayUrl}>)`
          : "";
        const number = startIndex + index + 1;
        const numberText = track.id && track.id === selectedTrackId ? `**${number}.**` : `${number}.`;
        const firstLine = `${numberText} ${track.title}${duration ? ` (**${duration}**)` : ""}${track.requester ? ` (requested by **${track.requester}**)` : ""}`;
        const secondLine = link ? `   ${link}` : null;
        return secondLine ? [firstLine, secondLine] : [firstLine];
      });
    const maxLength = 1900;
    let previewLines = preview.flat();
    let content = [...lines, previewLines.join("\n")].join("\n");
    if (content.length > maxLength) {
      const stripLink = (line) => line.replace(/\s*\(<https?:\/\/[^>]+>\)/g, "");
      const stripRequester = (line) => line.replace(/\s*\(requested by \*\*[^)]+\*\*\)/g, "");
      const clampLine = (line) => (line.length > 140 ? `${line.slice(0, 137)}…` : line);
      const previewNoLinks = previewLines.map(stripLink);
      const previewNoLinksNoRequester = previewNoLinks.map(stripRequester).map(clampLine);
      content = [...lines, previewNoLinksNoRequester.join("\n")].join("\n");
      previewLines = previewNoLinksNoRequester;
    }
    while (content.length > maxLength && previewLines.length > 1) {
      previewLines.pop();
      content = [...lines, previewLines.join("\n")].join("\n");
    }
    if (content.length > maxLength) {
      content = `${content.slice(0, maxLength - 1)}…`;
    }
    return { content, page: safePage, totalPages };
  } else {
    lines.push("Up next: (empty)");
  }
  return { content: lines.join("\n"), page: safePage, totalPages };
}

function buildQueueViewComponents(queueView, queue) {
  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / queueView.pageSize));
  const safePage = Math.min(Math.max(queueView.page, 1), totalPages);
  const startIndex = (safePage - 1) * queueView.pageSize;
  const options = queue.tracks
    .slice(startIndex, startIndex + queueView.pageSize)
    .map((track, index) => {
      ensureTrackId(track);
      const absoluteIndex = startIndex + index + 1;
      const duration = formatDuration(track.duration);
      const labelBase = `${absoluteIndex}. ${track.title}`;
      const label = labelBase.length > 100 ? `${labelBase.slice(0, 97)}...` : labelBase;
      return {
        label,
        value: track.id,
        description: duration ? `Duration: ${duration}` : undefined,
        default: queueView.selectedTrackId === track.id,
      };
    });

  const selectRow = new MessageActionRow().addComponents(
    new MessageSelectMenu()
      .setCustomId("queue_select")
      .setPlaceholder(options.length ? "Select a track" : "Queue is empty")
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(options.length === 0)
      .addOptions(options.length ? options : [{ label: "Empty", value: "0" }])
  );

  const actionRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_remove")
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle("DANGER")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_move")
      .setLabel("Move")
      .setEmoji("↔️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_front")
      .setLabel("Move to First")
      .setEmoji("⏫")
      .setStyle("PRIMARY")
      .setDisabled(!options.length || !queueView.selectedTrackId)
  );

  const navRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_prev")
      .setLabel("Prev")
      .setEmoji("⬅️")
      .setStyle("SECONDARY")
      .setDisabled(safePage <= 1),
    new MessageButton()
      .setCustomId("queue_next")
      .setLabel("Next")
      .setEmoji("➡️")
      .setStyle("SECONDARY")
      .setDisabled(safePage >= totalPages),
    new MessageButton()
      .setCustomId("queue_refresh")
      .setLabel("Refresh")
      .setEmoji("🔃")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queue_shuffle")
      .setLabel("Shuffle")
      .setEmoji("🔀")
      .setStyle("SECONDARY")
      .setDisabled(queue.tracks.length < 2),
    new MessageButton()
      .setCustomId("queue_clear")
      .setLabel("Clear")
      .setEmoji("⚠️")
      .setStyle("DANGER")
      .setDisabled(queue.tracks.length === 0)
  );

  const navRow2 = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_nowplaying")
      .setLabel("Now Playing")
      .setEmoji("🎶")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queue_close")
      .setLabel("Close")
      .setEmoji("❌")
      .setStyle("SECONDARY")
  );

  return [selectRow, actionRow, navRow, navRow2];
}

function formatQueueViewContent(queue, page, pageSize, selectedTrackId, { stale } = {}) {
  const pageData = formatQueuePage(queue, page, pageSize, selectedTrackId);
  const headerLines = [
    "_Controls limited to requester._",
  ];
  if (stale) {
    headerLines.unshift("_Queue view may be stale — press Refresh._");
  }
  if (selectedTrackId) {
    const selectedIndex = getTrackIndexById(queue, selectedTrackId);
    if (selectedIndex >= 0) {
      const selectedTrack = queue.tracks[selectedIndex];
      return {
        ...pageData,
        content: `${headerLines.join("\n")}\n${pageData.content}\nSelected: ${selectedIndex + 1}. ${selectedTrack.title}`,
      };
    }
  }
  return { ...pageData, content: `${headerLines.join("\n")}\n${pageData.content}` };
}

function buildMoveMenu(queue, selectedIndex, page = 1, pageSize = 25) {
  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const options = queue.tracks.slice(startIndex, startIndex + pageSize).map((track, index) => {
    const position = startIndex + index + 1;
    const labelBase = `${position}. ${track.title}`;
    const label = labelBase.length > 100 ? `${labelBase.slice(0, 97)}...` : labelBase;
    const description = position === selectedIndex ? "Current position" : undefined;
    return { label, value: String(position), description };
  });

  const selectRow = new MessageActionRow().addComponents(
    new MessageSelectMenu()
      .setCustomId("queue_move_select")
      .setPlaceholder("Move selected track to position…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options.length ? options : [{ label: "Empty", value: "0" }])
      .setDisabled(options.length === 0)
  );

  const controlRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("move_prev")
      .setLabel("Prev")
      .setEmoji("⬅️")
      .setStyle("SECONDARY")
      .setDisabled(safePage <= 1),
    new MessageButton()
      .setCustomId("move_next")
      .setLabel("Next")
      .setEmoji("➡️")
      .setStyle("SECONDARY")
      .setDisabled(safePage >= totalPages),
    new MessageButton()
      .setCustomId("move_first")
      .setLabel("Move to First")
      .setEmoji("⏫")
      .setStyle("PRIMARY"),
    new MessageButton()
      .setCustomId("move_close")
      .setLabel("Close")
      .setEmoji("❌")
      .setStyle("SECONDARY")
  );

  return { components: [selectRow, controlRow], page: safePage, totalPages };
}

function formatSearchChooserMessage(query, requesterId, tracks, timeoutMs) {
  const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
  const lines = [
    `Search results for **${query}** (requested by <@${requesterId}>).`,
    `Choose a result within ${timeoutSeconds}s to queue a track.`,
  ];
  tracks.forEach((track, index) => {
    const duration = formatDuration(track.duration);
    const displayUrl = track.displayUrl || track.url;
    const link = displayUrl ? ` (<${displayUrl}>)` : "";
    lines.push(`${index + 1}. ${track.title}${duration ? ` (**${duration}**)` : ""}${link}`);
    if (track.channel) {
      lines.push(`   ${track.channel}`);
    }
  });
  return lines.join("\n");
}

async function maybeSendSearchChooser(interaction, query, requesterName, requesterId) {
  let options = [];
  if (isSpotifyUrl(query) && !hasSpotifyCredentials()) {
    const spotifyType = playdl.sp_validate(query);
    if (spotifyType === "track") {
      options = await getSpotifySearchOptions(query, requesterName);
    } else {
      return false;
    }
  } else if (!isProbablyUrl(query)) {
    options = await searchYouTubeOptions(query, requesterName, null, SEARCH_CHOOSER_MAX_RESULTS);
  }

  if (!options.length) {
    return false;
  }

  const content = formatSearchChooserMessage(query, requesterId, options, INTERACTION_TIMEOUT_MS);
  const menuOptions = options.map((track, index) => {
    const baseLabel = `${index + 1}. ${track.title}`;
    const label = baseLabel.length > 100 ? `${baseLabel.slice(0, 97)}...` : baseLabel;
    const duration = formatDuration(track.duration);
    const channelParts = [];
    if (track.channel) {
      channelParts.push(`Channel: ${track.channel}`);
    }
    if (duration) {
      channelParts.push(duration);
    }
    const channel = channelParts.length ? channelParts.join(" • ") : null;
    return {
      label,
      value: String(index),
      description: channel || undefined,
    };
  });
  const selectRow = new MessageActionRow().addComponents(
    new MessageSelectMenu()
      .setCustomId("search_select")
      .setPlaceholder("Choose a result")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(menuOptions)
  );
  const controlRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("search_close")
      .setLabel("Close")
      .setEmoji("❌")
      .setStyle("SECONDARY")
  );
  const message = await interaction.editReply({ content, components: [selectRow, controlRow], fetchReply: true });

  const timeout = setTimeout(async () => {
    const entry = pendingSearches.get(message.id);
    if (!entry) {
      return;
    }
    pendingSearches.delete(message.id);
    try {
      await message.edit({ content: `Search expired for **${query}**.`, components: [] });
    } catch (error) {
      logError("Failed to expire search chooser", error);
    }
  }, INTERACTION_TIMEOUT_MS);

  pendingSearches.set(message.id, {
    guildId: interaction.guildId,
    requesterId,
    options,
    timeout,
  });

  logInfo("Posted search chooser", {
    query,
    requesterId,
    results: options.length,
  });

  return true;
}

async function sendNowPlaying(queue, forceNew = false) {
  if (!queue.textChannel || !queue.current) {
    return null;
  }

  const content = formatNowPlaying(queue);
  let message = null;

  if (!forceNew && queue.nowPlayingMessageId && queue.nowPlayingChannelId === queue.textChannel.id) {
    try {
      message = await queue.textChannel.messages.fetch(queue.nowPlayingMessageId);
      await message.edit(content);
    } catch {
      message = null;
    }
  }

  if (!message) {
    try {
      message = await queue.textChannel.send(content);
    } catch (error) {
      logError("Failed to send now playing message", error);
      return null;
    }
  }

  queue.nowPlayingMessageId = message.id;
  queue.nowPlayingChannelId = message.channel.id;
  if (queue.nowPlayingDeleteTimeout) {
    clearTimeout(queue.nowPlayingDeleteTimeout);
    queue.nowPlayingDeleteTimeout = null;
  }

  const controls = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("np_toggle")
      .setLabel("Play/Pause")
      .setEmoji("⏯️")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("np_queue")
      .setLabel("Queue")
      .setEmoji("📜")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("np_skip")
      .setLabel("Skip")
      .setEmoji("⏭️")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("np_stop")
      .setLabel("Stop")
      .setEmoji("⏹️")
      .setStyle("DANGER")
  );

  try {
    await message.edit({ content, components: [controls] });
  } catch (error) {
    logError("Failed to update now playing controls", error);
  }

  return message;
}

function getDisplayName(member, user) {
  return member?.displayName || user?.tag || user?.username || "Unknown user";
}

async function announceNowPlayingAction(queue, action, user, member, messageChannel) {
  const displayName = getDisplayName(member, user);
  logInfo(`Now playing reaction: ${action}`, { user: displayName, userId: user?.id });

  const channel = messageChannel || queue?.textChannel;
  if (!channel?.send) {
    return;
  }
  try {
    await channel.send(`**${displayName}** ${action}.`);
  } catch (error) {
    logError("Failed to announce now playing action", error);
  }
}

function ensurePlayerListeners(queue, guildId) {
  if (queue.playerListenersReady) {
    return;
  }

  queue.player.on(AudioPlayerStatus.Idle, () => {
    playNext(guildId).catch((error) => {
      logError("Error playing next track", error);
    });
  });

  queue.player.on("error", (error) => {
    logError("Audio player error", error);
    playNext(guildId).catch((playError) => {
      logError("Error recovering from player error", playError);
    });
  });

  queue.playerListenersReady = true;
}

function stopAndLeaveQueue(queue, reason) {
  logInfo(reason);
  queue.tracks = [];
  queue.current = null;
  queue.playing = false;
  if (queue.nowPlayingDeleteTimeout) {
    clearTimeout(queue.nowPlayingDeleteTimeout);
    queue.nowPlayingDeleteTimeout = null;
  }
  if (queue.player) {
    queue.player.stop(true);
  }
  if (queue.connection) {
    queue.connection.destroy();
    queue.connection = null;
  }
  queue.voiceChannel = null;
}

function isSameVoiceChannel(member, queue) {
  if (!queue.voiceChannel) {
    return true;
  }
  return member?.voice?.channel?.id === queue.voiceChannel.id;
}

function normalizeQueryInput(input) {
  const trimmed = input.trim();
  return trimmed.replace(/^\/?play\s+/i, "");
}

function enqueueTracks(queue, tracks, front = false) {
  if (!tracks?.length) {
    return;
  }
  tracks.forEach(ensureTrackId);
  if (front) {
    queue.tracks.unshift(...tracks.reverse());
  } else {
    queue.tracks.push(...tracks);
  }
}

function ensureTrackId(track) {
  if (!track) {
    return;
  }
  if (!track.id) {
    track.id = `t_${Date.now()}_${nextTrackId++}`;
  }
}

function getTrackIndexById(queue, trackId) {
  if (!queue?.tracks?.length || !trackId) {
    return -1;
  }
  return queue.tracks.findIndex((entry) => entry?.id === trackId);
}

function getQueuedTrackIndex(queue, track) {
  if (!queue?.tracks?.length || !track) {
    return -1;
  }
  if (track.id) {
    return getTrackIndexById(queue, track.id);
  }
  return queue.tracks.findIndex((entry) =>
    entry?.url === track.url && entry?.title === track.title && entry?.requester === track.requester
  );
}

function buildQueuedActionComponents() {
  const row = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queued_view")
      .setLabel("View Queue")
      .setEmoji("📜")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queued_move")
      .setLabel("Move")
      .setEmoji("↔️")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queued_first")
      .setLabel("Move to First")
      .setEmoji("⏫")
      .setStyle("PRIMARY"),
    new MessageButton()
      .setCustomId("queued_remove")
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle("DANGER")
  );
  return [row];
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds <= 0) {
    return "";
  }
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
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

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function httpGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(data);
        });
      })
      .on("error", reject);
  });
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

function resolveRedirect(url, maxHops = 5) {
  if (maxHops <= 0) {
    return Promise.resolve(url);
  }
  const headers = {
    "User-Agent": SOUNDCLOUD_USER_AGENT || YOUTUBE_USER_AGENT || "Mozilla/5.0",
  };
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          resolve(resolveRedirect(nextUrl, maxHops - 1));
          return;
        }
        resolve(url);
      })
      .on("error", reject);
  });
}

function decodeHtml(value) {
  if (!value) {
    return value;
  }
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractSpotifyMetaFromHtml(html) {
  if (!html) {
    return { title: null, artist: null, album: null };
  }
  const ogTitle = html.match(/<meta[^>]+property=['"]og:title['"][^>]+content=['"]([^'"]+)['"]/i);
  const ogDesc = html.match(/<meta[^>]+property=['"]og:description['"][^>]+content=['"]([^'"]+)['"]/i);
  const titleTag = html.match(/<title>([^<]+)<\/title>/i);
  let title = ogTitle ? decodeHtml(ogTitle[1]) : null;
  let artist = null;
  let album = null;

  if (!title && titleTag) {
    const rawTitle = decodeHtml(titleTag[1]);
    const cleaned = rawTitle.replace(/^Spotify\s*-\s*/i, "").trim();
    if (cleaned) {
      title = cleaned;
    }
  }

  if (title && title.toLowerCase() === "spotify") {
    title = null;
  }

  if (ogDesc) {
    const parts = decodeHtml(ogDesc[1])
      .split(" · ")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      artist = parts[1];
    }
    if (parts.length >= 3 && parts[0].toLowerCase().includes("album")) {
      album = parts[1];
    }
  }

  if (!title || !artist) {
    const trackBlock = html.match(/"track"\s*:\s*{[\s\S]*?}\s*,/);
    const block = trackBlock ? trackBlock[0] : html;
    if (!title) {
      const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) {
        title = decodeHtml(nameMatch[1]);
      }
    }
    if (!artist) {
      const artistMatch = block.match(/"artists"\s*:\s*\[\s*{[^}]*"name"\s*:\s*"([^"]+)"/);
      if (artistMatch) {
        artist = decodeHtml(artistMatch[1]);
      }
    }
    if (!album) {
      const albumMatch = block.match(/"album"\s*:\s*{[^}]*"name"\s*:\s*"([^"]+)"/);
      if (albumMatch) {
        album = decodeHtml(albumMatch[1]);
      }
    }
    if (!artist) {
      const subtitleMatch = block.match(/"subtitle"\s*:\s*"([^"]+)"/);
      if (subtitleMatch) {
        artist = decodeHtml(subtitleMatch[1]);
      }
    }
  }

  return { title, artist, album };
}

function getSpotifyId(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("spotify.com")) {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "track") {
      return parts[1];
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveSoundcloudDiscover(url, slug, requester) {
  if (!soundcloudClientId) {
    return [];
  }
  const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${soundcloudClientId}`;
  const data = await httpGetJson(resolveUrl);
  if (data?.kind === "track") {
    return [{
      title: data.title,
      url: data.permalink_url,
      source: "soundcloud",
      duration: Math.round((data.duration || 0) / 1000),
    }];
  }
  if (data?.kind === "playlist") {
    if (Array.isArray(data.tracks) && data.tracks.length) {
      return data.tracks.map((track) => ({
        title: track.title,
        url: track.permalink_url,
        source: "soundcloud",
        duration: Math.round((track.duration || 0) / 1000),
      }));
    }
    if (data.id) {
      const playlistUrl = `https://api-v2.soundcloud.com/playlists/${data.id}?client_id=${soundcloudClientId}`;
      const playlist = await httpGetJson(playlistUrl);
      if (Array.isArray(playlist?.tracks)) {
        return playlist.tracks.map((track) => ({
          title: track.title,
          url: track.permalink_url,
          source: "soundcloud",
          duration: Math.round((track.duration || 0) / 1000),
          requester,
        }));
      }
    }
  }
  if (slug) {
    const discoverUrl = `https://api-v2.soundcloud.com/discover/sets/${encodeURIComponent(slug)}?client_id=${soundcloudClientId}`;
    const discover = await httpGetJson(discoverUrl);
    const tracks = discover?.collection || [];
    if (Array.isArray(tracks) && tracks.length) {
      return tracks
        .filter((track) => track?.kind === "track")
        .map((track) => ({
          title: track.title,
          url: track.permalink_url,
          source: "soundcloud",
          duration: Math.round((track.duration || 0) / 1000),
          requester,
        }));
    }
  }
  return [];
}

async function resolveTracks(query, requester) {
  await ensureSoundcloudReady();
  await ensureYoutubeReady();
  let normalizedSoundcloud = query;
  let isSoundcloudUrl = false;
  let soundcloudDiscoverSlug = null;
  let soundcloudDiscoverFailed = false;
  let url = null;
  try {
    url = new URL(query);
  } catch {
    url = null;
  }
  if (url && url.hostname === "on.soundcloud.com") {
    try {
      const resolved = await resolveRedirect(url.toString());
      if (resolved && resolved !== url.toString()) {
        normalizedSoundcloud = resolved;
        url = new URL(resolved);
      }
    } catch (error) {
      logError("SoundCloud short link resolve failed", error);
    }
  }
  if (url && url.hostname.endsWith("soundcloud.com")) {
    isSoundcloudUrl = true;
    if (url.pathname.startsWith("/discover/sets/")) {
      soundcloudDiscoverSlug = url.pathname.replace("/discover/sets/", "").split("/")[0];
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    url.search = "";
    url.hash = "";
    if (lastPart && lastPart.startsWith("s-")) {
      pathParts.pop();
      url.pathname = `/${pathParts.join("/")}`;
      url.searchParams.set("secret_token", lastPart);
    }
    normalizedSoundcloud = url.toString();
  }

  const soundcloudCandidates = [];
  if (isSoundcloudUrl) {
    soundcloudCandidates.push(normalizedSoundcloud);
    if (query !== normalizedSoundcloud) {
      soundcloudCandidates.push(query);
    }
  }

  async function resolveSoundcloudCandidate(candidate) {
    const type = await playdl.so_validate(candidate);
    if (type === "track") {
      const track = await playdl.soundcloud(candidate);
      const displayUrl = await resolveSoundcloudDisplayUrl(track.url, track.permalink_url);
      return [{
        title: track.name,
        url: track.url,
        displayUrl,
        source: "soundcloud",
        duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
        requester,
      }];
    }

    if (type === "playlist") {
      const playlist = await playdl.soundcloud(candidate);
      const tracks = await playlist.all_tracks();
      return Promise.all(tracks.map(async (track) => ({
        title: track.name,
        url: track.url,
        displayUrl: await resolveSoundcloudDisplayUrl(track.url, track.permalink_url),
        source: "soundcloud",
        duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
        requester,
      })));
    }

    const info = await playdl.soundcloud(candidate);
    if (info.type === "track") {
      const displayUrl = await resolveSoundcloudDisplayUrl(info.url, info.permalink_url);
      return [{
        title: info.name,
        url: info.url,
        displayUrl,
        source: "soundcloud",
        duration: info.durationInSec ?? Math.round((info.durationInMs || 0) / 1000),
        requester,
      }];
    }
    if (info.type === "playlist") {
      const tracks = await info.all_tracks();
      return Promise.all(tracks.map(async (track) => ({
        title: track.name,
        url: track.url,
        displayUrl: await resolveSoundcloudDisplayUrl(track.url, track.permalink_url),
        source: "soundcloud",
        duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
        requester,
      })));
    }

    return [];
  }

  if (soundcloudDiscoverSlug) {
    try {
      const apiTracks = await resolveSoundcloudDiscover(query, soundcloudDiscoverSlug, requester);
      if (apiTracks.length) {
        return apiTracks;
      }
    } catch (error) {
      soundcloudDiscoverFailed = true;
      logError("SoundCloud discover resolve failed", error);
    }
  }

  if (soundcloudCandidates.length) {
    for (const candidate of soundcloudCandidates) {
      try {
        const tracks = await resolveSoundcloudCandidate(candidate);
        if (tracks.length) {
          return tracks;
        }
      } catch (error) {
        logInfo("SoundCloud candidate failed", { candidate, error });
      }
    }
  }

  if (soundcloudDiscoverSlug) {
    try {
      const results = await playdl.search(soundcloudDiscoverSlug, {
        limit: 1,
        source: { soundcloud: "playlists" },
      });
      if (results.length) {
        const playlist = await playdl.soundcloud(results[0].url);
        const tracks = await playlist.all_tracks();
        return tracks.map((track) => ({
          title: track.name,
          url: track.url,
          source: "soundcloud",
          duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
          requester,
        }));
      }
    } catch (error) {
      logError("SoundCloud discover search failed", error);
    }
  }

  if (soundcloudDiscoverFailed) {
    throw new Error(
      "SoundCloud discover links are personalized and cannot be resolved by the public API. Use a direct playlist link instead."
    );
  }

  if (isSpotifyUrl(query)) {
    const spotifyType = playdl.sp_validate(query);
    if (spotifyType) {
      const spotifyTracks = await resolveSpotifyTracks(query, spotifyType, requester);
      if (spotifyTracks.length) {
        return spotifyTracks;
      }
    }
  }

  const ytType = playdl.yt_validate(query);
  if (ytType === "video") {
    const info = await playdl.video_basic_info(query);
    const videoId = info.video_details.id || getYoutubeId(query);
    const videoUrl = toShortYoutubeUrl(videoId || info.video_details.url || query);
    return [{
      title: info.video_details.title,
      url: videoUrl,
      source: "youtube",
      duration: info.video_details.durationInSec ?? null,
      requester,
    }];
  }

  if (ytType === "playlist") {
    const playlist = await playdl.playlist_info(query, { incomplete: true });
    await playlist.fetch();
    return playlist.videos.map((item) => ({
      title: item.title,
      url: toShortYoutubeUrl(item.id || item.url),
      source: "youtube",
      duration: item.durationInSec ?? null,
      requester,
    })).filter((track) => track.url);
  }

  const searchResult = await searchYouTubePreferred(query, requester);
  if (!searchResult) {
    return [];
  }

  return [searchResult];
}

async function createTrackResource(track) {
  if (!track?.url) {
    logInfo("Track missing URL", track);
    throw new Error("Track URL missing");
  }
  if (track.source === "youtube") {
    return createYoutubeResource(track.url);
  }

  const stream = await playdl.stream(track.url);
  return createAudioResource(stream.stream, {
    inputType: stream.type ?? StreamType.Arbitrary,
  });
}

function markQueueViewsStale(guildId) {
  for (const [messageId, view] of queueViews.entries()) {
    if (view.guildId === guildId) {
      queueViews.set(messageId, { ...view, stale: true });
    }
  }
}

async function playNext(guildId) {
  const queue = getGuildQueue(guildId);
  const next = queue.tracks.shift();

  if (!next) {
    queue.playing = false;
    queue.current = null;
    if (queue.connection) {
      queue.connection.destroy();
      queue.connection = null;
    }
    return;
  }

  queue.playing = true;
  queue.current = next;
  markQueueViewsStale(guildId);

  let loadingTimeout = null;
  let loadingMessage = null;
  if (queue.textChannel) {
    loadingTimeout = setTimeout(async () => {
      try {
        loadingMessage = await queue.textChannel.send(`Loading **${next.title}**...`);
      } catch (error) {
        logError("Failed to send loading message", error);
      }
    }, 5000);
  }

  let resource;
  try {
    resource = await createTrackResource(next);
  } catch (error) {
    logError("Failed to create audio resource", error);
    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
      loadingTimeout = null;
    }
    if (loadingMessage) {
      try {
        await loadingMessage.delete();
      } catch (deleteError) {
        logError("Failed to delete loading message", deleteError);
      }
    }
    playNext(guildId).catch((playError) => {
      logError("Error skipping failed track", playError);
    });
    return;
  }
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
  }
  if (loadingMessage) {
    try {
      await loadingMessage.delete();
    } catch (deleteError) {
      logError("Failed to delete loading message", deleteError);
    }
  }

  queue.player.play(resource);

  if (queue.connection) {
    queue.connection.subscribe(queue.player);
  }

  await sendNowPlaying(queue, true);
}

client.on("ready", () => {
  logInfo(`Logged in as ${client.user.tag}`);
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) {
    return;
  }
  const queue = queues.get(guildId);
  if (!queue?.voiceChannel) {
    return;
  }
  const channel = newState.guild.channels.cache.get(queue.voiceChannel.id) || queue.voiceChannel;
  if (!channel?.members) {
    return;
  }
  const listeners = channel.members.filter((member) => !member.user.bot);
  if (listeners.size === 0) {
    stopAndLeaveQueue(queue, "Voice channel empty. Stopping playback and leaving.");
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Buttons can only be used in a server.", ephemeral: true });
      return;
    }

    const queue = getGuildQueue(interaction.guildId);
    const member = interaction.guild?.members?.resolve(interaction.user.id);
    const customId = interaction.customId || "";

    if (customId === "search_close") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can close this search.", ephemeral: true });
        return;
      }
      pendingSearches.delete(interaction.message.id);
      clearTimeout(pending.timeout);
      await interaction.update({ content: "Search closed.", components: [] });
      return;
    }

    if (customId.startsWith("np_")) {
      if (!queue.nowPlayingMessageId || interaction.message.id !== queue.nowPlayingMessageId) {
        await interaction.reply({ content: "That now playing message is no longer active.", ephemeral: true });
        return;
      }
      if (!isSameVoiceChannel(member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
        return;
      }

      if (customId === "np_toggle") {
        if (queue.player.state.status === AudioPlayerStatus.Playing) {
          queue.player.pause();
          await announceNowPlayingAction(queue, "paused playback", interaction.user, member, interaction.message.channel);
        } else {
          queue.player.unpause();
          await announceNowPlayingAction(queue, "resumed playback", interaction.user, member, interaction.message.channel);
        }
      } else if (customId === "np_queue") {
        if (!queue.current && !queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const pageSize = 10;
        const view = {
          guildId: interaction.guildId,
          page: 1,
          pageSize,
          ownerId: interaction.user.id,
          selectedTrackId: null,
          stale: false,
        };
        const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, { stale: view.stale });
        const message = await interaction.channel.send({
          content: pageData.content,
          components: buildQueueViewComponents(view, queue),
        });
        queueViews.set(message.id, {
          ...view,
          page: pageData.page,
        });
      } else if (customId === "np_skip") {
        await announceNowPlayingAction(queue, "skipped the track", interaction.user, member, interaction.message.channel);
        queue.player.stop(true);
      } else if (customId === "np_stop") {
        await announceNowPlayingAction(queue, "stopped playback and cleared the queue", interaction.user, member, interaction.message.channel);
        queue.tracks = [];
        queue.current = null;
        queue.playing = false;
        if (queue.player) {
          queue.player.stop(true);
        }
        if (queue.connection) {
          queue.connection.destroy();
          queue.connection = null;
        }
      }

      try {
        const controls = new MessageActionRow().addComponents(
          new MessageButton()
            .setCustomId("np_toggle")
            .setLabel("Play/Pause")
            .setEmoji("⏯️")
            .setStyle("SECONDARY"),
          new MessageButton()
            .setCustomId("np_queue")
            .setLabel("Queue")
            .setEmoji("📜")
            .setStyle("SECONDARY"),
          new MessageButton()
            .setCustomId("np_skip")
            .setLabel("Skip")
            .setEmoji("⏭️")
            .setStyle("SECONDARY"),
          new MessageButton()
            .setCustomId("np_stop")
            .setLabel("Stop")
            .setEmoji("⏹️")
            .setStyle("DANGER")
        );
        await interaction.message.edit({ components: [controls] });
      } catch (error) {
        logError("Failed to refresh now playing controls", error);
      }

      await interaction.deferUpdate();
      return;
    }

    if (customId.startsWith("queued_")) {
      const pending = pendingQueuedActions.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That queued action has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can use these controls.", ephemeral: true });
        return;
      }
      const trackIndex = getTrackIndexById(queue, pending.trackId);
      if (trackIndex < 0) {
        await interaction.reply({ content: "That track is no longer in the queue.", ephemeral: true });
        return;
      }

      if (customId === "queued_view") {
        const pageSize = 10;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const selectedTrack = queue.tracks[trackIndex];
        ensureTrackId(selectedTrack);
        const view = {
          guildId: interaction.guildId,
          page,
          pageSize,
          ownerId: interaction.user.id,
          selectedTrackId: selectedTrack.id,
          stale: false,
        };
        const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, { stale: view.stale });
        const message = await interaction.channel.send({
          content: pageData.content,
          components: buildQueueViewComponents(view, queue),
        });
        queueViews.set(message.id, {
          ...view,
          page: pageData.page,
        });
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_move") {
        const selectedIndex = trackIndex + 1;
        const pageSize = 10;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const moveMenu = buildMoveMenu(queue, selectedIndex, page, pageSize);
        const moveMessage = await interaction.channel.send({
          content: `Move **${pending.trackTitle || "selected track"}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
          components: moveMenu.components,
        });
        const timeout = setTimeout(async () => {
          const entry = pendingMoves.get(moveMessage.id);
          if (!entry) {
            return;
          }
          pendingMoves.delete(moveMessage.id);
          try {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          } catch (error) {
            logError("Failed to expire move request", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingMoves.set(moveMessage.id, {
          guildId: interaction.guildId,
          ownerId: interaction.user.id,
          sourceIndex: selectedIndex,
          trackId: pending.trackId,
          queueViewMessageId: null,
          page: moveMenu.page,
          pageSize,
          timeout,
        });
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_first") {
        const [moved] = queue.tracks.splice(trackIndex, 1);
        queue.tracks.unshift(moved);
        logInfo("Moved track to front via queued controls", { title: moved?.title, user: interaction.user.tag });
        await interaction.update({
          content: `Moved **${moved.title}** to position 1.`,
          components: [],
        });
        pendingQueuedActions.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        return;
      }

      if (customId === "queued_remove") {
        const [removed] = queue.tracks.splice(trackIndex, 1);
        logInfo("Removed track via queued controls", { title: removed?.title, user: interaction.user.tag });
        await interaction.update({
          content: `Removed **${removed.title}** from the queue.`,
          components: [],
        });
        pendingQueuedActions.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        return;
      }
    }

    if (customId.startsWith("move_")) {
      const pending = pendingMoves.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That move request has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can control this move request.", ephemeral: true });
        return;
      }
      if (customId === "move_close") {
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: "Move closed.", components: [] });
        return;
      }
      if (customId === "move_prev") {
        pending.page = Math.max(1, pending.page - 1);
      } else if (customId === "move_next") {
        pending.page += 1;
      } else if (customId === "move_first") {
        const queue = getGuildQueue(interaction.guildId);
        const currentIndex = pending.trackId ? getTrackIndexById(queue, pending.trackId) + 1 : pending.sourceIndex;
        if (!currentIndex || !queue.tracks[currentIndex - 1]) {
          await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
          return;
        }
        const [moved] = queue.tracks.splice(currentIndex - 1, 1);
        queue.tracks.unshift(moved);
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: `Moved **${moved.title}** to position 1.`, components: [] });

        const queueView = queueViews.get(pending.queueViewMessageId);
        if (queueView) {
          ensureTrackId(moved);
          queueView.selectedTrackId = moved.id;
          queueView.page = 1;
          queueView.stale = false;
          const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
          queueViews.set(pending.queueViewMessageId, queueView);
          try {
            const viewMessage = await interaction.channel.messages.fetch(pending.queueViewMessageId);
            await viewMessage.edit({
              content: pageData.content,
              components: buildQueueViewComponents(queueView, queue),
            });
          } catch (error) {
            logError("Failed to update queue view after move to first", error);
          }
        }
        return;
      }
      const queue = getGuildQueue(interaction.guildId);
      const currentIndex = pending.trackId ? getTrackIndexById(queue, pending.trackId) + 1 : pending.sourceIndex;
      if (!currentIndex || !queue.tracks[currentIndex - 1]) {
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: "Selected track no longer exists.", components: [] });
        return;
      }
      pending.sourceIndex = currentIndex;
      const moveMenu = buildMoveMenu(queue, currentIndex, pending.page, pending.pageSize);
      pending.page = moveMenu.page;
      pendingMoves.set(interaction.message.id, pending);
      const track = queue.tracks[pending.sourceIndex - 1];
      const title = track?.title || "selected track";
      await interaction.update({
        content: `Move **${title}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
        components: moveMenu.components,
      });
      return;
    }

    if (customId.startsWith("queue_")) {
      const queueView = queueViews.get(interaction.message.id);
      if (!queueView) {
        await interaction.reply({ content: "That queue view has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== queueView.ownerId) {
        await interaction.reply({ content: "Only the requester can control this queue view.", ephemeral: true });
        return;
      }

      if (customId === "queue_close") {
        queueViews.delete(interaction.message.id);
        await interaction.update({ content: "Queue view closed.", components: [] });
        return;
      }

      if (customId === "queue_prev") {
        queueView.page = Math.max(1, queueView.page - 1);
      } else if (customId === "queue_next") {
        queueView.page += 1;
      } else if (customId === "queue_refresh") {
        // no-op; just re-render below
      } else if (customId === "queue_nowplaying") {
        queue.textChannel = interaction.channel;
        await sendNowPlaying(queue, true);
      } else if (customId === "queue_shuffle") {
        if (queue.tracks.length > 1) {
          for (let i = queue.tracks.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
          }
        }
        queueView.selectedTrackId = null;
      } else if (customId === "queue_clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
          return;
        }
        queue.tracks = [];
        queueView.selectedTrackId = null;
        logInfo("Cleared queue via queue view", { user: interaction.user.tag });
      } else if (customId === "queue_move") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const selectedTrack = queue.tracks[selectedIndex - 1];
        ensureTrackId(selectedTrack);
        const moveMenu = buildMoveMenu(queue, selectedIndex, queueView.page, queueView.pageSize);
        const moveMessage = await interaction.channel.send({
          content: `Move **${queue.tracks[selectedIndex - 1].title}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
          components: moveMenu.components,
        });
        const timeout = setTimeout(async () => {
          const entry = pendingMoves.get(moveMessage.id);
          if (!entry) {
            return;
          }
          pendingMoves.delete(moveMessage.id);
          try {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          } catch (error) {
            logError("Failed to expire move request", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingMoves.set(moveMessage.id, {
          guildId: interaction.guildId,
          ownerId: queueView.ownerId,
          sourceIndex: selectedIndex,
          trackId: selectedTrack.id,
          queueViewMessageId: interaction.message.id,
          page: moveMenu.page,
          pageSize: queueView.pageSize,
          timeout,
        });
      } else if (customId === "queue_remove") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to remove.", ephemeral: true });
          return;
        }
        const [removed] = queue.tracks.splice(selectedIndex - 1, 1);
        logInfo("Removed track via queue view", { title: removed?.title, user: interaction.user.tag });
        queueView.selectedTrackId = null;
      } else if (customId === "queue_front") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const [moved] = queue.tracks.splice(selectedIndex - 1, 1);
        queue.tracks.unshift(moved);
        logInfo("Moved track to front via queue view", { title: moved?.title, user: interaction.user.tag });
        queueView.selectedTrackId = moved.id || queueView.selectedTrackId;
        queueView.page = 1;
      }

      queueView.stale = false;
      const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
      queueView.page = pageData.page;
      queueViews.set(interaction.message.id, queueView);
      await interaction.update({
        content: pageData.content,
        components: buildQueueViewComponents(queueView, queue),
      });
      return;
    }
  }

  if (interaction.isSelectMenu()) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Menus can only be used in a server.", ephemeral: true });
      return;
    }
    if (interaction.customId === "search_select") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can choose a result.", ephemeral: true });
        return;
      }
      const member = interaction.guild?.members?.resolve(interaction.user.id);
      const queue = getGuildQueue(interaction.guildId);
      if (!isSameVoiceChannel(member, queue)) {
        await interaction.reply({ content: "Join my voice channel to choose a result.", ephemeral: true });
        return;
      }
      const index = parseInt(interaction.values?.[0], 10);
      if (!Number.isFinite(index) || index < 0 || index >= pending.options.length) {
        await interaction.reply({ content: "Invalid selection.", ephemeral: true });
        return;
      }
      const selected = pending.options[index];
      pendingSearches.delete(interaction.message.id);
      clearTimeout(pending.timeout);

      queue.textChannel = interaction.channel;
      ensureTrackId(selected);
      queue.tracks.push(selected);
      logInfo("Queued from search chooser", {
        title: selected.title,
        guildId: interaction.guildId,
        requesterId: pending.requesterId,
      });

      const queuedIndex = getQueuedTrackIndex(queue, selected);
      const positionText = queuedIndex >= 0 ? ` (position ${queuedIndex + 1})` : "";
      const showQueuedControls = queuedIndex >= 1;
      await interaction.update({
        content: `Queued: **${selected.title}**${positionText} (requested by **${selected.requester || "unknown"}**).`,
        components: showQueuedControls ? buildQueuedActionComponents() : [],
      });
      if (showQueuedControls) {
        const timeout = setTimeout(async () => {
          const entry = pendingQueuedActions.get(interaction.message.id);
          if (!entry) {
            return;
          }
          pendingQueuedActions.delete(interaction.message.id);
          try {
            await interaction.message.edit({ components: [] });
          } catch (error) {
            logError("Failed to expire queued action controls", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingQueuedActions.set(interaction.message.id, {
          guildId: interaction.guildId,
          ownerId: interaction.user.id,
          trackId: selected.id,
          trackTitle: selected.title,
          timeout,
        });
      }

      if (!queue.playing) {
        playNext(interaction.guildId).catch((error) => {
          logError("Error starting playback", error);
        });
      }
      return;
    }

    if (interaction.customId === "queue_move_select") {
      const pending = pendingMoves.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That move request has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can move tracks.", ephemeral: true });
        return;
      }
      const queue = getGuildQueue(interaction.guildId);
      const sourceIndex = pending.trackId ? getTrackIndexById(queue, pending.trackId) + 1 : pending.sourceIndex;
      const destIndex = parseInt(interaction.values?.[0], 10);
      if (!sourceIndex || !queue.tracks[sourceIndex - 1]) {
        await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
        return;
      }
      if (!Number.isFinite(destIndex) || destIndex < 1 || destIndex > queue.tracks.length) {
        await interaction.reply({ content: "Invalid destination.", ephemeral: true });
        return;
      }

      const [moved] = queue.tracks.splice(sourceIndex - 1, 1);
      const adjustedIndex = destIndex > sourceIndex ? destIndex - 1 : destIndex;
      queue.tracks.splice(adjustedIndex - 1, 0, moved);

      pendingMoves.delete(interaction.message.id);
      clearTimeout(pending.timeout);
      await interaction.update({ content: `Moved **${moved.title}** to position ${destIndex}.`, components: [] });

      const queueView = queueViews.get(pending.queueViewMessageId);
      if (queueView) {
        ensureTrackId(moved);
        queueView.selectedTrackId = moved.id;
        queueView.page = Math.floor((adjustedIndex - 1) / queueView.pageSize) + 1;
        queueView.stale = false;
        const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
        queueViews.set(pending.queueViewMessageId, queueView);
        try {
          const viewMessage = await interaction.channel.messages.fetch(pending.queueViewMessageId);
          await viewMessage.edit({
            content: pageData.content,
            components: buildQueueViewComponents(queueView, queue),
          });
        } catch (error) {
          logError("Failed to update queue view after move", error);
        }
      }
      return;
    }

    const queueView = queueViews.get(interaction.message.id);
    if (!queueView) {
      await interaction.reply({ content: "That queue view has expired.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== queueView.ownerId) {
      await interaction.reply({ content: "Only the requester can control this queue view.", ephemeral: true });
      return;
    }
    if (interaction.customId === "queue_select") {
      const selectedId = interaction.values?.[0];
      if (selectedId) {
        queueView.selectedTrackId = selectedId;
      }
      queueView.stale = false;
      const queue = getGuildQueue(interaction.guildId);
      const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
      queueViews.set(interaction.message.id, queueView);
      await interaction.update({
        content: pageData.content,
        components: buildQueueViewComponents(queueView, queue),
      });
      return;
    }
  }

  if (!interaction.isCommand()) {
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({ content: "Commands can only be used in a server.", ephemeral: true });
    return;
  }

  const queue = getGuildQueue(interaction.guildId);
  queue.textChannel = interaction.channel;

  logInfo("Slash command received", {
    guild: interaction.guildId,
    channel: interaction.channelId,
    user: interaction.user.tag,
    command: interaction.commandName,
  });

  if (interaction.commandName === "play" || interaction.commandName === "playnext") {
    const enqueueAtFront = interaction.commandName === "playnext";
    const query = normalizeQueryInput(interaction.options.getString("query", true));
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
      return;
    }

    if (queue.voiceChannel && queue.voiceChannel.id !== voiceChannel.id) {
      await interaction.reply({ content: "I am already playing in another voice channel.", ephemeral: true });
      return;
    }

    await interaction.deferReply();
    logInfo("Resolving track(s)", { query });
    const requester = interaction.member?.displayName || interaction.user.tag;
    const requesterId = interaction.user.id;

    queue.voiceChannel = voiceChannel;

    if (!queue.connection) {
      await ensureSodiumReady();
      queue.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });
      queue.connection.on("error", (error) => {
      logError("Voice connection error", error);
      });
      ensurePlayerListeners(queue, interaction.guildId);
    }

    try {
      const handled = await maybeSendSearchChooser(interaction, query, requester, requesterId);
      if (handled) {
        return;
      }
    } catch (error) {
      logError("Failed to send search chooser", error);
    }

    let tracks;
    try {
      tracks = await resolveTracks(query, requester);
    } catch (error) {
      logError("Failed to resolve tracks", error);
      const message = error?.message?.includes("SoundCloud discover links")
        || error?.message?.includes("Spotify")
        ? error.message
        : "Could not load that track or playlist.";
      await interaction.editReply(message);
      return;
    }

    if (!tracks.length) {
      await interaction.editReply("No results found.");
      return;
    }

    enqueueTracks(queue, tracks, enqueueAtFront);
    logInfo("Queued tracks", {
      count: tracks.length,
      first: tracks[0]?.title,
      front: enqueueAtFront,
    });

    if (tracks.length === 1) {
      const queuedIndex = getQueuedTrackIndex(queue, tracks[0]);
      const positionText = queuedIndex >= 0 ? ` (position ${queuedIndex + 1})` : "";
      const showQueuedControls = queuedIndex >= 1;
      const message = await interaction.editReply({
        content: `Queued${enqueueAtFront ? " next" : ""}: **${tracks[0].title}**${positionText}`,
        components: showQueuedControls ? buildQueuedActionComponents() : [],
        fetchReply: true,
      });
      if (showQueuedControls) {
        const timeout = setTimeout(async () => {
          const entry = pendingQueuedActions.get(message.id);
          if (!entry) {
            return;
          }
          pendingQueuedActions.delete(message.id);
          try {
            await message.edit({ components: [] });
          } catch (error) {
            logError("Failed to expire queued action controls", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        ensureTrackId(tracks[0]);
        pendingQueuedActions.set(message.id, {
          guildId: interaction.guildId,
          ownerId: interaction.user.id,
          trackId: tracks[0].id,
          trackTitle: tracks[0].title,
          timeout,
        });
      }
    } else {
      await interaction.editReply(`Queued ${tracks.length} tracks${enqueueAtFront ? " to the front" : ""} from playlist.`);
    }

    if (isSpotifyUrl(query) && !hasSpotifyCredentials()) {
      try {
        await interaction.followUp({
          content: "Spotify links without credentials only include the track title. For best results, use `/play Artist - Title`.",
          ephemeral: true,
        });
        logInfo("Sent Spotify hint message", { user: interaction.user.tag });
      } catch (error) {
        logError("Failed to send Spotify hint message", error);
      }
    }

    if (!queue.playing) {
      playNext(interaction.guildId).catch((error) => {
        logError("Error starting playback", error);
      });
    }
    return;
  }

  if (interaction.commandName === "playing") {
    if (!queue.current) {
      await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await sendNowPlaying(queue, true);
    await interaction.editReply({ content: "Posted now playing controls." });
    return;
  }

  if (interaction.commandName === "pause") {
    if (!queue.current) {
      await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
      return;
    }
    if (!isSameVoiceChannel(interaction.member, queue)) {
      await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
      return;
    }
    queue.player.pause();
    logInfo("Pausing playback");
    await interaction.reply("Paused.");
    return;
  }

  if (interaction.commandName === "resume") {
    if (!queue.current) {
      await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
      return;
    }
    if (!isSameVoiceChannel(interaction.member, queue)) {
      await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
      return;
    }
    queue.player.unpause();
    logInfo("Resuming playback");
    await interaction.reply("Resumed.");
    return;
  }

  if (interaction.commandName === "skip") {
    if (!queue.current) {
      await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
      return;
    }
    if (!isSameVoiceChannel(interaction.member, queue)) {
      await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
      return;
    }
    logInfo("Skipping track");
    queue.player.stop(true);
    await interaction.reply("Skipped.");
    return;
  }

  if (interaction.commandName === "stop") {
    if (!isSameVoiceChannel(interaction.member, queue)) {
      await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
      return;
    }
    stopAndLeaveQueue(queue, "Stopping playback and clearing queue");
    await interaction.reply("Stopped and cleared the queue.");
    return;
  }

  if (interaction.commandName === "queue") {
    const sub = interaction.options.getSubcommand();

    if (sub === "view") {
      if (!queue.current && !queue.tracks.length) {
        await interaction.reply("Queue is empty.");
        return;
      }
      const pageSize = 10;
      const view = {
        guildId: interaction.guildId,
        page: 1,
        pageSize,
        ownerId: interaction.user.id,
        selectedTrackId: null,
        stale: false,
      };
      const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, { stale: view.stale });
      const message = await interaction.reply({
        content: pageData.content,
        components: buildQueueViewComponents(view, queue),
        fetchReply: true,
      });
      queueViews.set(message.id, {
        ...view,
        page: pageData.page,
      });
      return;
    }

    if (sub === "clear") {
      if (!queue.tracks.length) {
        await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
        return;
      }
      queue.tracks = [];
      await interaction.reply("Cleared the queue.");
      return;
    }

    if (sub === "shuffle") {
      if (queue.tracks.length < 2) {
        await interaction.reply({ content: "Need at least two tracks to shuffle.", ephemeral: true });
        return;
      }
      for (let i = queue.tracks.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
      }
      await interaction.reply("Shuffled the queue.");
      return;
    }

    if (sub === "remove") {
      if (!queue.tracks.length) {
        await interaction.reply({ content: "Queue is empty.", ephemeral: true });
        return;
      }
      const index = interaction.options.getInteger("index", true);
      if (index < 1 || index > queue.tracks.length) {
        await interaction.reply({ content: "Invalid queue position.", ephemeral: true });
        return;
      }
      const removed = queue.tracks.splice(index - 1, 1)[0];
      await interaction.reply(`Removed **${removed.title}**.`);
      return;
    }

    if (sub === "move") {
      if (queue.tracks.length < 2) {
        await interaction.reply({ content: "Need at least two tracks in the queue.", ephemeral: true });
        return;
      }
      const from = interaction.options.getInteger("from", true);
      const to = interaction.options.getInteger("to", true);
      if (from < 1 || from > queue.tracks.length || to < 1 || to > queue.tracks.length) {
        await interaction.reply({ content: "Invalid queue positions.", ephemeral: true });
        return;
      }
      const [moved] = queue.tracks.splice(from - 1, 1);
      queue.tracks.splice(to - 1, 0, moved);
      await interaction.reply(`Moved **${moved.title}** from ${from} to ${to}.`);
      return;
    }
  }
});

client.login(TOKEN);
