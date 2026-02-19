const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createQueueService } = require("../queue/service");
const { enqueueTracks, formatDuration, getQueuedTrackIndex } = require("../queue/utils");
const { listQueueEvents } = require("../queue/event-feed");
const { formatQueuedMessage, formatQueuedPlaylistMessage } = require("../ui/messages");
const {
  buildControlActionFeedback,
  buildQueueActionFeedback,
  sendQueueFeedback,
} = require("../queue/action-feedback");

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_OAUTH_SCOPES = "identify guilds";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_SESSION_STORE_PATH = path.join("data", "auth-sessions.json");
const MAX_JSON_BODY_BYTES = 64 * 1024;
const STATE_TTL_MS = 5 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const THUMBNAIL_PROXY_TIMEOUT_MS = 8000;
const THUMBNAIL_PROXY_MAX_BYTES = 5 * 1024 * 1024;
const THUMBNAIL_PROXY_CACHE_TTL_MS = 10 * 60 * 1000;
const THUMBNAIL_PROXY_CACHE_MAX_ENTRIES = 400;
const ACTIVITY_SEARCH_CHOOSER_TTL_MS = 90 * 1000;
const ACTIVITY_USER_FEED_LIMIT = 20;
const THUMBNAIL_PROXY_ALLOWED_HOST_SUFFIXES = [
  "ytimg.com",
  "ggpht.com",
  "sndcdn.com",
  "scdn.co",
];

function parseCookies(cookieHeader) {
  const parsed = {};
  String(cookieHeader || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        return;
      }
      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      parsed[key] = decodeURIComponent(value);
    });
  return parsed;
}

function serializeCookie({
  name,
  value,
  path = "/",
  httpOnly = true,
  secure = true,
  sameSite = "None",
  maxAgeSeconds = null,
}) {
  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds >= 0) {
    segments.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  }
  if (httpOnly) {
    segments.push("HttpOnly");
  }
  if (secure) {
    segments.push("Secure");
  }
  return segments.join("; ");
}

function setCommonHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", JSON_CONTENT_TYPE);
  setCommonHeaders(response);
  response.end(JSON.stringify(payload));
}

function sendRedirect(response, statusCode, location) {
  response.statusCode = statusCode;
  response.setHeader("Location", location);
  setCommonHeaders(response);
  response.end();
}

function sendText(response, statusCode, content) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  setCommonHeaders(response);
  response.end(content);
}

function createTaskLimiter(maxConcurrent = 1) {
  const concurrency = Number.isFinite(maxConcurrent) && maxConcurrent > 0
    ? Math.max(1, Math.floor(maxConcurrent))
    : 1;
  let active = 0;
  const pending = [];

  function runNext() {
    if (active >= concurrency || pending.length === 0) {
      return;
    }
    const nextTask = pending.shift();
    active += 1;
    Promise.resolve()
      .then(() => nextTask.task())
      .then(nextTask.resolve, nextTask.reject)
      .finally(() => {
        active = Math.max(0, active - 1);
        runNext();
      });
  }

  return async function runWithLimit(task) {
    return new Promise((resolve, reject) => {
      pending.push({ task, resolve, reject });
      runNext();
    });
  };
}

function isLikelyUrlQuery(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return false;
    }
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

async function readJsonBody(request, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (error) {
        reject(new Error("Invalid JSON payload"));
      }
    });
    request.on("error", reject);
  });
}

function hasJsonContentType(request) {
  const contentType = String(request?.headers?.["content-type"] || "").toLowerCase();
  return contentType.includes("application/json");
}

function requireJsonRequest(request, response) {
  if (hasJsonContentType(request)) {
    return true;
  }
  sendJson(response, 415, { error: "Expected Content-Type: application/json" });
  return false;
}

function summarizeUser(userPayload) {
  if (!userPayload || typeof userPayload !== "object") {
    return null;
  }
  return {
    id: userPayload.id || null,
    username: userPayload.username || null,
    globalName: userPayload.global_name || null,
    avatar: userPayload.avatar || null,
  };
}

function summarizeGuild(guildPayload) {
  if (!guildPayload || typeof guildPayload !== "object") {
    return null;
  }
  return {
    id: guildPayload.id || null,
    name: guildPayload.name || null,
    owner: Boolean(guildPayload.owner),
    permissions: guildPayload.permissions || null,
  };
}

function normalizeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const parsed = new URL(normalized);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "https:" && protocol !== "http:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getYoutubeVideoIdFromValue(value) {
  if (!value) {
    return null;
  }
  const raw = String(value).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || "").toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id || "") ? id : null;
    }
    if (host.endsWith("youtube.com")) {
      const queryId = parsed.searchParams.get("v");
      if (/^[a-zA-Z0-9_-]{11}$/.test(queryId || "")) {
        return queryId;
      }
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if ((pathParts[0] === "shorts" || pathParts[0] === "embed") && /^[a-zA-Z0-9_-]{11}$/.test(pathParts[1] || "")) {
        return pathParts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function summarizeTrackArtist(track) {
  if (!track || typeof track !== "object") {
    return null;
  }
  if (track.artist) {
    return String(track.artist);
  }
  if (track.channel) {
    return String(track.channel);
  }
  const spotifyArtists = Array.isArray(track?.spotifyMeta?.artists)
    ? track.spotifyMeta.artists.filter(Boolean)
    : [];
  return spotifyArtists[0] || null;
}

function summarizeTrackDisplayUrl(track) {
  const displayUrl = normalizeExternalUrl(track?.displayUrl);
  if (displayUrl) {
    return displayUrl;
  }
  return normalizeExternalUrl(track?.url);
}

function summarizeTrackThumbnailUrl(track) {
  if (!track || typeof track !== "object") {
    return null;
  }
  const directCandidates = [
    track.thumbnailUrl,
    track.thumbnail,
    track.thumbnail_url,
    track.artworkUrl,
    track.artwork_url,
    track.artwork,
    track.imageUrl,
    track.image_url,
    track.image,
    track.coverUrl,
    track.cover_url,
    track.cover,
    track.posterUrl,
    track.poster_url,
    track.poster,
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeExternalUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const source = String(track.source || "").toLowerCase();
  const youtubeId = getYoutubeVideoIdFromValue(track?.url)
    || getYoutubeVideoIdFromValue(track?.displayUrl)
    || getYoutubeVideoIdFromValue(track?.id);
  if (youtubeId && source.includes("youtube")) {
    return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
  }
  return null;
}

function summarizeTrack(track) {
  if (!track) {
    return null;
  }
  const normalizedUrl = normalizeExternalUrl(track.url);
  const displayUrl = summarizeTrackDisplayUrl(track) || normalizedUrl;
  return {
    id: track.id || null,
    title: track.title || "Unknown",
    url: normalizedUrl || null,
    displayUrl: displayUrl || null,
    duration: Number.isFinite(track.duration) ? track.duration : null,
    source: track.source || "unknown",
    artist: summarizeTrackArtist(track),
    channel: track.channel || null,
    thumbnailUrl: summarizeTrackThumbnailUrl(track),
    requester: track.requester || null,
    pendingResolve: Boolean(track.pendingResolve),
  };
}

function getPlaybackElapsedSeconds(queue) {
  const playbackMs = queue?.player?.state?.resource?.playbackDuration;
  if (!Number.isFinite(playbackMs) || playbackMs < 0) {
    return null;
  }
  return Math.floor(playbackMs / 1000);
}

function getTrackDurationSeconds(track) {
  if (!Number.isFinite(track?.duration) || track.duration <= 0) {
    return null;
  }
  return Math.floor(track.duration);
}

function summarizePlaybackProgress(queue) {
  const durationSec = getTrackDurationSeconds(queue?.current);
  const elapsedFromPlayer = getPlaybackElapsedSeconds(queue);
  if (!durationSec && elapsedFromPlayer === null) {
    return null;
  }

  if (durationSec) {
    const elapsedSec = Math.max(0, Math.min(elapsedFromPlayer ?? 0, durationSec));
    return {
      elapsedSec,
      durationSec,
      ratio: durationSec > 0 ? elapsedSec / durationSec : 0,
    };
  }

  const elapsedSec = Math.max(0, elapsedFromPlayer ?? 0);
  return {
    elapsedSec,
    durationSec: null,
    ratio: null,
  };
}

function summarizeQueue(queue) {
  if (!queue) {
    return {
      connected: false,
      nowPlaying: null,
      playbackProgress: null,
      upNext: [],
      queueLength: 0,
      loopMode: "off",
      playerStatus: "idle",
      attachments: {
        voice: null,
        text: null,
      },
      activityFeed: [],
      updatedAt: Date.now(),
    };
  }

  return {
    connected: Boolean(queue.connection),
    nowPlaying: summarizeTrack(queue.current),
    playbackProgress: summarizePlaybackProgress(queue),
    upNext: Array.isArray(queue.tracks) ? queue.tracks.slice(0, 5).map(summarizeTrack) : [],
    queueLength: Array.isArray(queue.tracks) ? queue.tracks.length : 0,
    loopMode: queue.loopMode || "off",
    playerStatus: queue?.player?.state?.status || "idle",
    attachments: summarizeQueueAttachments(queue),
    activityFeed: listQueueEvents(queue, { limit: ACTIVITY_USER_FEED_LIMIT }),
    updatedAt: Date.now(),
  };
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function normalizeScopes(rawScopes) {
  const normalized = String(rawScopes || DEFAULT_OAUTH_SCOPES)
    .trim()
    .replace(/\s+/g, " ");
  return normalized || DEFAULT_OAUTH_SCOPES;
}

function toFiniteInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.trunc(numeric);
}

function normalizeUserIdList(rawIds) {
  if (Array.isArray(rawIds)) {
    return rawIds
      .map((id) => String(id || "").trim())
      .filter(Boolean);
  }
  return String(rawIds || "")
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAllowedThumbnailHost(hostname) {
  const normalizedHostname = String(hostname || "").trim().toLowerCase();
  if (!normalizedHostname) {
    return false;
  }
  return THUMBNAIL_PROXY_ALLOWED_HOST_SUFFIXES.some((suffix) =>
    normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`)
  );
}

function getQueueVoiceChannelId(queue) {
  return String(queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || "").trim() || null;
}

function summarizeChannelAttachment(channel, fallbackId = null) {
  const id = String(channel?.id || fallbackId || "").trim() || null;
  if (!id) {
    return null;
  }
  const rawName = String(channel?.name || "").trim();
  return {
    id,
    name: rawName || null,
  };
}

function summarizeQueueAttachments(queue) {
  if (!queue) {
    return {
      voice: null,
      text: null,
    };
  }
  const voiceChannelId = getQueueVoiceChannelId(queue);
  const textChannelId = String(
    queue?.textChannel?.id
    || queue?.textChannelId
    || queue?.nowPlayingChannelId
    || ""
  ).trim() || null;
  return {
    voice: summarizeChannelAttachment(queue?.voiceChannel, voiceChannelId),
    text: summarizeChannelAttachment(queue?.textChannel, textChannelId),
  };
}

function buildVoiceAccessHint({
  canStartSearch,
  bypassVoiceCheck,
  queueVoiceChannelId,
  userVoiceChannelId,
  sameVoiceChannel,
}) {
  if (canStartSearch) {
    return null;
  }
  if (bypassVoiceCheck) {
    return null;
  }
  if (queueVoiceChannelId) {
    if (!userVoiceChannelId) {
      return "Join the bot voice channel before searching.";
    }
    if (!sameVoiceChannel) {
      return "Join the same voice channel as the bot before searching.";
    }
  }
  return "Join a voice channel before searching.";
}

async function exchangeDiscordCode({
  clientId,
  clientSecret,
  code,
  redirectUri = null,
  scopes = DEFAULT_OAUTH_SCOPES,
}) {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("scope", normalizeScopes(scopes));
  if (redirectUri) {
    body.set("redirect_uri", redirectUri);
  }

  const response = await fetch(`${DISCORD_API_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch {
      details = "";
    }
    throw new Error(`Discord token exchange failed (${response.status}): ${details || response.statusText}`);
  }

  return response.json();
}

async function fetchDiscordResource(accessToken, routePath) {
  const response = await fetch(`${DISCORD_API_BASE_URL}${routePath}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch {
      details = "";
    }
    throw new Error(`Discord API request failed (${response.status}) ${routePath}: ${details || response.statusText}`);
  }
  return response.json();
}

function createApiServer(options) {
  const {
    queues,
    logInfo = () => {},
    logError = () => {},
    isBotInGuild = () => true,
    getQueueForGuild = null,
    getBotGuilds = () => [],
    getUserVoiceChannelId = async () => null,
    resolveTextChannelById = async () => null,
    getAdminEvents = () => [],
    getProviderStatus = () => null,
    verifyProviderAuthStatus = async () => null,
    reinitializeProviders = async () => null,
    getDiscordGatewayStatus = async () => null,
    forceDiscordRelogin = async () => null,
    queueService = null,
    stopAndLeaveQueue = null,
    maybeRefreshNowPlayingUpNext = async () => {},
    sendNowPlaying = async () => {},
    normalizeQueryInput = (value) => String(value || "").trim(),
    resolveTracks = async () => [],
    getSearchOptionsForQuery = async () => [],
    ensureQueueVoiceConnection = null,
    ensureTrackId = null,
    getPlayNext = () => null,
    config = {},
  } = options || {};

  const oauthClientId = String(config.oauthClientId || "").trim();
  const oauthClientSecret = String(config.oauthClientSecret || "").trim();
  const oauthWebRedirectUri = String(config.oauthWebRedirectUri || "").trim();
  const oauthActivityRedirectUri = String(config.oauthActivityRedirectUri || "").trim();
  const oauthScopes = normalizeScopes(config.oauthScopes || DEFAULT_OAUTH_SCOPES);

  const host = String(config.host || "127.0.0.1").trim() || "127.0.0.1";
  const parsedPort = Number(config.port);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
    ? parsedPort
    : 8787;
  const sessionTtlMs = Number.isFinite(config.sessionTtlMs) && config.sessionTtlMs > 0
    ? config.sessionTtlMs
    : DEFAULT_SESSION_TTL_MS;
  const cookieName = String(config.cookieName || "qdex_session").trim() || "qdex_session";
  const cookieSecure = toBoolean(config.cookieSecure, true);
  const cookieSameSite = cookieSecure ? "None" : "Lax";
  const sessionStoreEnabled = toBoolean(config.sessionStoreEnabled, true);
  const rawSessionStorePath = String(config.sessionStorePath || DEFAULT_SESSION_STORE_PATH).trim() || DEFAULT_SESSION_STORE_PATH;
  const sessionStorePath = path.resolve(rawSessionStorePath);
  const adminUserIds = new Set(normalizeUserIdList(config.adminUserIds));
  const activityQueueSearchConcurrency = Number.isFinite(Number(config.activityQueueSearchConcurrency))
    ? Math.max(1, Math.floor(Number(config.activityQueueSearchConcurrency)))
    : 1;

  const oauthConfigured = Boolean(oauthClientId && oauthClientSecret);
  const pendingWebStates = new Map();
  const sessions = new Map();
  const thumbnailCache = new Map();
  const activitySearchChoosers = new Map();
  const runActivitySearchTask = createTaskLimiter(activityQueueSearchConcurrency);
  const stopQueueAction = typeof stopAndLeaveQueue === "function"
    ? stopAndLeaveQueue
    : (queue, reason) => {
      logInfo("Using API stop fallback queue cleanup", { reason });
      stopQueueFallback(queue);
    };
  const controlService = queueService || createQueueService({
    stopAndLeaveQueue: stopQueueAction,
    maybeRefreshNowPlayingUpNext,
    sendNowPlaying,
  });

  function normalizePersistedSessionUser(user) {
    if (!user || typeof user !== "object") {
      return null;
    }
    const id = String(user.id || "").trim() || null;
    const username = String(user.username || "").trim() || null;
    const globalName = String(user.globalName || user.global_name || "").trim() || null;
    const avatar = String(user.avatar || "").trim() || null;
    if (!id && !username) {
      return null;
    }
    return {
      id,
      username,
      globalName,
      avatar,
    };
  }

  function normalizePersistedSessionGuild(guild) {
    if (!guild || typeof guild !== "object") {
      return null;
    }
    const id = String(guild.id || "").trim() || null;
    if (!id) {
      return null;
    }
    const name = String(guild.name || "").trim() || null;
    return {
      id,
      name,
      owner: Boolean(guild.owner),
      permissions: guild.permissions || null,
    };
  }

  function serializeSessionForStore(session) {
    if (!session || typeof session !== "object") {
      return null;
    }
    return {
      id: String(session.id || "").trim() || null,
      createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
      expiresAt: Number.isFinite(session.expiresAt) ? session.expiresAt : Date.now(),
      user: normalizePersistedSessionUser(session.user),
      guilds: Array.isArray(session.guilds)
        ? session.guilds.map(normalizePersistedSessionGuild).filter(Boolean)
        : [],
      scopes: normalizeScopes(session.scopes || oauthScopes),
      accessToken: String(session.accessToken || "").trim() || null,
      tokenType: String(session.tokenType || "Bearer").trim() || "Bearer",
      adminBypassVoiceChannelCheck: Boolean(session.adminBypassVoiceChannelCheck),
      adminBypassGuildAccess: Boolean(session.adminBypassGuildAccess),
    };
  }

  function normalizeStoredSession(rawSession) {
    if (!rawSession || typeof rawSession !== "object") {
      return null;
    }
    const id = String(rawSession.id || "").trim();
    if (!id) {
      return null;
    }
    const now = Date.now();
    const createdAt = Number.isFinite(rawSession.createdAt) ? rawSession.createdAt : now;
    const expiresAt = Number.isFinite(rawSession.expiresAt) ? rawSession.expiresAt : (now - 1);
    if (expiresAt <= now) {
      return null;
    }
    const user = normalizePersistedSessionUser(rawSession.user);
    if (!user?.id) {
      return null;
    }
    return {
      id,
      createdAt,
      expiresAt,
      user,
      guilds: Array.isArray(rawSession.guilds)
        ? rawSession.guilds.map(normalizePersistedSessionGuild).filter(Boolean)
        : [],
      scopes: normalizeScopes(rawSession.scopes || oauthScopes),
      accessToken: String(rawSession.accessToken || "").trim() || null,
      tokenType: String(rawSession.tokenType || "Bearer").trim() || "Bearer",
      adminBypassVoiceChannelCheck: Boolean(rawSession.adminBypassVoiceChannelCheck),
      adminBypassGuildAccess: Boolean(rawSession.adminBypassGuildAccess),
    };
  }

  function persistSessionsToStore() {
    if (!sessionStoreEnabled) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(sessionStorePath), { recursive: true });
      const payload = {
        version: 1,
        savedAt: Date.now(),
        sessions: Array.from(sessions.values())
          .map(serializeSessionForStore)
          .filter(Boolean),
      };
      fs.writeFileSync(sessionStorePath, JSON.stringify(payload), "utf8");
    } catch (error) {
      logError("Failed to persist auth session store", {
        sessionStorePath,
        error,
      });
    }
  }

  function loadSessionsFromStore() {
    if (!sessionStoreEnabled) {
      return;
    }
    if (!fs.existsSync(sessionStorePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(sessionStorePath, "utf8");
      if (!String(raw || "").trim()) {
        return;
      }
      const parsed = JSON.parse(raw);
      const rawSessions = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.sessions) ? parsed.sessions : []);
      let loadedCount = 0;
      let droppedCount = 0;
      rawSessions.forEach((entry) => {
        const normalized = normalizeStoredSession(entry);
        if (!normalized) {
          droppedCount += 1;
          return;
        }
        sessions.set(normalized.id, normalized);
        loadedCount += 1;
      });
      if (droppedCount > 0) {
        persistSessionsToStore();
      }
      logInfo("Loaded auth sessions from store", {
        sessionStorePath,
        loadedCount,
        droppedCount,
      });
    } catch (error) {
      logError("Failed to load auth session store", {
        sessionStorePath,
        error,
      });
    }
  }

  function createSession(payload) {
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + sessionTtlMs;
    sessions.set(sessionId, {
      id: sessionId,
      createdAt: Date.now(),
      expiresAt,
      user: payload.user || null,
      guilds: payload.guilds || [],
      scopes: payload.scopes || oauthScopes,
      accessToken: payload.accessToken || null,
      tokenType: payload.tokenType || "Bearer",
      adminBypassVoiceChannelCheck: false,
      adminBypassGuildAccess: false,
    });
    persistSessionsToStore();
    return sessions.get(sessionId);
  }

  function isAdminUserId(userId) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) {
      return false;
    }
    return adminUserIds.has(normalizedUserId);
  }

  function getSessionAdminSettings(session) {
    const isAdmin = isAdminUserId(session?.user?.id);
    return {
      isAdmin,
      bypassVoiceChannelCheck: isAdmin && Boolean(session?.adminBypassVoiceChannelCheck),
      bypassGuildAccess: isAdmin && Boolean(session?.adminBypassGuildAccess),
    };
  }

  async function getActivityVoiceAccessState({ guildId, queue, session, admin }) {
    const normalizedGuildId = String(guildId || "").trim();
    const queueVoiceChannelId = getQueueVoiceChannelId(queue);
    const bypassVoiceCheck = Boolean(admin?.bypassVoiceChannelCheck);
    const userId = String(session?.user?.id || "").trim();
    let userVoiceChannelId = null;

    if (userId && normalizedGuildId) {
      try {
        userVoiceChannelId = await getUserVoiceChannelId(normalizedGuildId, userId);
      } catch (error) {
        logError("Failed to resolve user voice channel for activity state", {
          guildId: normalizedGuildId,
          userId,
          error,
        });
      }
    }

    const normalizedUserVoiceChannelId = String(userVoiceChannelId || "").trim() || null;
    const sameVoiceChannel = Boolean(
      queueVoiceChannelId
      && normalizedUserVoiceChannelId
      && normalizedUserVoiceChannelId === queueVoiceChannelId
    );
    const canUseControls = bypassVoiceCheck || !queueVoiceChannelId || sameVoiceChannel;
    const canStartSearch = bypassVoiceCheck || (queueVoiceChannelId
      ? sameVoiceChannel
      : Boolean(normalizedUserVoiceChannelId));
    return {
      bypassVoiceCheck,
      queueVoiceChannelId,
      userVoiceChannelId: normalizedUserVoiceChannelId,
      sameVoiceChannel,
      canUseControls,
      canStartSearch,
      searchBlockedHint: buildVoiceAccessHint({
        canStartSearch,
        bypassVoiceCheck,
        queueVoiceChannelId,
        userVoiceChannelId: normalizedUserVoiceChannelId,
        sameVoiceChannel,
      }),
    };
  }

  function getSessionFromRequest(request) {
    const authorization = String(request.headers.authorization || "").trim();
    if (authorization.toLowerCase().startsWith("bearer ")) {
      const bearerToken = authorization.slice("bearer ".length).trim();
      if (bearerToken) {
        const sessionFromBearer = sessions.get(bearerToken);
        if (sessionFromBearer && sessionFromBearer.expiresAt > Date.now()) {
          return sessionFromBearer;
        }
      }
    }

    const cookies = parseCookies(request.headers.cookie);
    const sessionId = cookies[cookieName];
    if (!sessionId) {
      return null;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      sessions.delete(session.id);
      persistSessionsToStore();
      return null;
    }
    return session;
  }

  loadSessionsFromStore();

  function resolveQueueForGuild(guildId, { createIfMissing = false } = {}) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) {
      return null;
    }
    if (createIfMissing && typeof getQueueForGuild === "function") {
      return getQueueForGuild(normalizedGuildId);
    }
    return queues?.get?.(normalizedGuildId) || null;
  }

  function canAccessGuild(session, guildId) {
    if (!session || !guildId) {
      return false;
    }
    let botInGuild = true;
    try {
      botInGuild = Boolean(isBotInGuild(guildId));
    } catch (error) {
      logError("Failed to evaluate bot guild membership check", error);
      botInGuild = true;
    }
    if (!botInGuild) {
      return false;
    }

    const adminSettings = getSessionAdminSettings(session);
    if (adminSettings.isAdmin && adminSettings.bypassGuildAccess) {
      return true;
    }

    if (!Array.isArray(session.guilds) || !session.guilds.length) {
      // If guilds scope wasn't granted, we can't verify membership server-side.
      return true;
    }
    return session.guilds.some((guild) => guild?.id === guildId);
  }

  function stopQueueFallback(queue) {
    if (!queue) {
      return;
    }
    queue.tracks = [];
    queue.current = null;
    queue.playing = false;
    if (queue.player) {
      queue.suppressNextIdle = true;
      queue.player.stop(true);
    }
    if (queue.connection) {
      try {
        queue.connection.destroy();
      } catch {
        // Ignore best-effort cleanup errors in fallback.
      }
      queue.connection = null;
    }
    queue.voiceChannel = null;
  }

  async function resolveAuthorizedActivityContext({
    request,
    response,
    guildId,
    requireQueue = true,
    createQueueIfMissing = false,
    requireVoiceChannelMatch = false,
    requireAdmin = false,
  }) {
    const session = getSessionFromRequest(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized" });
      return null;
    }

    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) {
      sendJson(response, 400, { error: "Missing guild_id" });
      return null;
    }

    if (!canAccessGuild(session, normalizedGuildId)) {
      sendJson(response, 403, { error: "Forbidden for this guild" });
      return null;
    }

    const queue = resolveQueueForGuild(normalizedGuildId, {
      createIfMissing: Boolean(requireQueue && createQueueIfMissing),
    });
    if (requireQueue && !queue) {
      sendJson(response, 404, { error: "Queue is not initialized for this guild" });
      return null;
    }

    const adminSettings = getSessionAdminSettings(session);
    if (requireAdmin && !adminSettings.isAdmin) {
      sendJson(response, 403, { error: "Forbidden" });
      return null;
    }

    if (requireVoiceChannelMatch && queue && !adminSettings.bypassVoiceChannelCheck) {
      const queueVoiceChannelId = getQueueVoiceChannelId(queue);
      if (queueVoiceChannelId) {
        const userId = String(session?.user?.id || "").trim();
        if (!userId) {
          sendJson(response, 401, { error: "Session user is unavailable" });
          return null;
        }

        let userVoiceChannelId = null;
        try {
          userVoiceChannelId = await getUserVoiceChannelId(normalizedGuildId, userId);
        } catch (error) {
          logError("Failed to resolve user voice channel for activity request", {
            guildId: normalizedGuildId,
            userId,
            error,
          });
          sendJson(response, 500, { error: "Failed to verify voice channel access" });
          return null;
        }

        const normalizedUserVoiceChannelId = String(userVoiceChannelId || "").trim() || null;
        if (!normalizedUserVoiceChannelId) {
          sendJson(response, 403, { error: "Join the bot voice channel to use controls" });
          return null;
        }
        if (normalizedUserVoiceChannelId !== queueVoiceChannelId) {
          sendJson(response, 403, { error: "You must be in the same voice channel as the bot" });
          return null;
        }
      }
    }

    return {
      session,
      admin: adminSettings,
      guildId: normalizedGuildId,
      queue,
    };
  }

  function resolveAdminSessionContext(request, response) {
    const session = getSessionFromRequest(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized" });
      return null;
    }
    const adminSettings = getSessionAdminSettings(session);
    if (!adminSettings.isAdmin) {
      sendJson(response, 403, { error: "Forbidden" });
      return null;
    }
    return {
      session,
      admin: adminSettings,
    };
  }

  async function refreshSessionGuilds(session) {
    if (!session) {
      throw new Error("Session is unavailable");
    }
    const accessToken = String(session.accessToken || "").trim();
    if (!accessToken) {
      const error = new Error("Session access token is unavailable");
      error.code = "NO_ACCESS_TOKEN";
      throw error;
    }
    const scopes = String(session.scopes || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!scopes.includes("guilds")) {
      const error = new Error("Session missing guilds scope");
      error.code = "MISSING_GUILDS_SCOPE";
      throw error;
    }

    const guildPayload = await fetchDiscordResource(accessToken, "/users/@me/guilds");
    const guilds = Array.isArray(guildPayload)
      ? guildPayload.map(summarizeGuild).filter(Boolean)
      : [];
    session.guilds = guilds;
    persistSessionsToStore();
    return guilds;
  }

  function summarizeQueueActionResult(result) {
    if (!result || typeof result !== "object") {
      return null;
    }

    const payload = {
      action: result.action || null,
    };
    if (Number.isFinite(result.removedCount)) {
      payload.removedCount = result.removedCount;
    }
    if (Number.isFinite(result.position)) {
      payload.position = result.position;
    }
    if (Number.isFinite(result.fromPosition)) {
      payload.fromPosition = result.fromPosition;
    }
    if (Number.isFinite(result.toPosition)) {
      payload.toPosition = result.toPosition;
    }
    if (result.moved) {
      payload.moved = summarizeTrack(result.moved);
    }
    if (result.removed) {
      payload.removed = summarizeTrack(result.removed);
    }
    if (result.loopResult) {
      payload.loop = {
        previousMode: result.loopResult.previousMode || "off",
        mode: result.loopResult.mode || "off",
        changed: Boolean(result.loopResult.changed),
        inserted: Boolean(result.loopResult.inserted),
        removed: Number.isFinite(result.loopResult.removed) ? result.loopResult.removed : 0,
      };
    }
    return payload;
  }

  function getSessionRequesterName(session) {
    const globalName = String(session?.user?.globalName || session?.user?.global_name || "").trim();
    if (globalName) {
      return globalName;
    }
    const username = String(session?.user?.username || "").trim();
    if (username) {
      return username;
    }
    const userId = String(session?.user?.id || "").trim();
    if (userId) {
      return userId;
    }
    return "Requester";
  }

  function summarizeSearchOption(track, index) {
    return {
      index,
      durationLabel: formatDuration(track?.duration),
      ...summarizeTrack(track),
    };
  }

  function pruneExpiredActivitySearchChoosers(now = Date.now()) {
    activitySearchChoosers.forEach((entry, chooserId) => {
      if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
        activitySearchChoosers.delete(chooserId);
      }
    });
  }

  function createActivitySearchChooser({ guildId, requesterId, query, options }) {
    const normalizedOptions = Array.isArray(options) ? options.slice(0, 10) : [];
    if (!normalizedOptions.length) {
      return null;
    }
    pruneExpiredActivitySearchChoosers();
    const chooserId = crypto.randomUUID();
    const expiresAt = Date.now() + ACTIVITY_SEARCH_CHOOSER_TTL_MS;
    activitySearchChoosers.set(chooserId, {
      id: chooserId,
      guildId: String(guildId || "").trim(),
      requesterId: String(requesterId || "").trim(),
      query: String(query || "").trim(),
      options: normalizedOptions,
      createdAt: Date.now(),
      expiresAt,
    });
    return activitySearchChoosers.get(chooserId);
  }

  function getActivitySearchChooser(chooserId) {
    const normalizedChooserId = String(chooserId || "").trim();
    if (!normalizedChooserId) {
      return null;
    }
    const chooser = activitySearchChoosers.get(normalizedChooserId);
    if (!chooser) {
      return null;
    }
    if (!Number.isFinite(chooser.expiresAt) || chooser.expiresAt <= Date.now()) {
      activitySearchChoosers.delete(normalizedChooserId);
      return null;
    }
    return chooser;
  }

  function clearActivitySearchChooser(chooserId) {
    const normalizedChooserId = String(chooserId || "").trim();
    if (!normalizedChooserId) {
      return false;
    }
    return activitySearchChoosers.delete(normalizedChooserId);
  }

  async function ensureActivityQueueVoiceConnection({ queue, guildId, session, admin }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) {
      return {
        ok: false,
        statusCode: 400,
        error: "Missing guild_id",
      };
    }

    const sessionUserId = String(session?.user?.id || "").trim();
    const queueVoiceChannelId = getQueueVoiceChannelId(queue);
    let preferredVoiceChannelId = queueVoiceChannelId;

    if (!preferredVoiceChannelId) {
      if (!sessionUserId) {
        return {
          ok: false,
          statusCode: 401,
          error: "Session user is unavailable",
        };
      }
      let userVoiceChannelId = null;
      try {
        userVoiceChannelId = await getUserVoiceChannelId(normalizedGuildId, sessionUserId);
      } catch (error) {
        logError("Failed to resolve user voice channel for activity queue search", {
          guildId: normalizedGuildId,
          userId: sessionUserId,
          error,
        });
        return {
          ok: false,
          statusCode: 500,
          error: "Failed to verify voice channel access",
        };
      }

      preferredVoiceChannelId = String(userVoiceChannelId || "").trim() || null;
      if (!preferredVoiceChannelId && !admin?.bypassVoiceChannelCheck) {
        return {
          ok: false,
          statusCode: 403,
          error: "Join a voice channel first.",
        };
      }
    }

    if (!preferredVoiceChannelId) {
      return {
        ok: true,
        skipped: true,
      };
    }

    if (typeof ensureQueueVoiceConnection !== "function") {
      if (queue?.connection) {
        return {
          ok: true,
          reused: true,
          channelId: preferredVoiceChannelId,
        };
      }
      return {
        ok: false,
        statusCode: 500,
        error: "Voice connection service is unavailable.",
      };
    }

    try {
      const connectionResult = await ensureQueueVoiceConnection(queue, {
        guildId: normalizedGuildId,
        preferredVoiceChannelId,
      });
      if (connectionResult && connectionResult.ok === false) {
        return {
          ok: false,
          statusCode: Number.isFinite(connectionResult.statusCode) ? connectionResult.statusCode : 500,
          error: connectionResult.error || "Failed to join voice channel.",
        };
      }
      return {
        ok: true,
        ...connectionResult,
      };
    } catch (error) {
      logError("Failed to establish voice connection for activity queue search", {
        guildId: normalizedGuildId,
        preferredVoiceChannelId,
        error,
      });
      return {
        ok: false,
        statusCode: 500,
        error: "I couldn't join your voice channel.",
      };
    }
  }

  async function maybeAttachQueueTextChannel({ queue, guildId, body, source }) {
    if (!queue || !body || typeof body !== "object") {
      return false;
    }

    const requestedTextChannelId = String(body.text_channel_id ?? body.textChannelId ?? "").trim();
    if (!requestedTextChannelId) {
      return false;
    }

    const currentTextChannelId = String(queue?.textChannel?.id || queue?.textChannelId || "").trim() || null;
    if (currentTextChannelId === requestedTextChannelId && queue?.textChannel?.send) {
      queue.textChannelId = currentTextChannelId;
      return true;
    }

    if (typeof resolveTextChannelById !== "function") {
      return false;
    }

    try {
      const resolvedChannel = await resolveTextChannelById(guildId, requestedTextChannelId);
      if (!resolvedChannel?.send) {
        return false;
      }
      queue.textChannel = resolvedChannel;
      queue.textChannelId = String(resolvedChannel.id || requestedTextChannelId).trim();
      logInfo("Attached queue text channel from activity/web request", {
        guildId,
        textChannelId: queue.textChannelId,
        source: source || "unknown",
      });
      return true;
    } catch (error) {
      logError("Failed to attach queue text channel from activity/web request", {
        guildId,
        requestedTextChannelId,
        source: source || "unknown",
        error,
      });
      return false;
    }
  }

  async function queueTracksFromActivityRequest({ context, tracks, source }) {
    const queue = context?.queue;
    if (!queue || !Array.isArray(tracks) || !tracks.length) {
      return {
        ok: false,
        statusCode: 400,
        error: "No tracks to queue",
      };
    }

    const voiceResult = await ensureActivityQueueVoiceConnection({
      queue,
      guildId: context.guildId,
      session: context.session,
      admin: context.admin,
    });
    if (!voiceResult.ok) {
      return voiceResult;
    }

    if (!Array.isArray(queue.tracks)) {
      queue.tracks = [];
    }

    const requesterName = getSessionRequesterName(context.session);
    const hadAnythingQueuedBefore = Boolean(queue.current) || queue.tracks.length > 0;
    const queuedTracks = tracks
      .filter((track) => track && typeof track === "object")
      .map((track) => ({ ...track }));

    queuedTracks.forEach((track) => {
      if (!String(track.requester || "").trim()) {
        track.requester = requesterName;
      }
      if (typeof ensureTrackId === "function") {
        ensureTrackId(track);
      }
    });

    enqueueTracks(queue, queuedTracks);
    await maybeRefreshNowPlayingUpNext(queue);

    const queuedTrackPositions = queuedTracks.map((track) => {
      const queuedIndex = getQueuedTrackIndex(queue, track);
      return queuedIndex >= 0 ? queuedIndex + 1 : null;
    });

    logInfo("Queued tracks from activity/web queue search", {
      source: source || "unknown",
      guildId: context.guildId,
      userId: context?.session?.user?.id || null,
      count: queuedTracks.length,
      first: queuedTracks[0]?.title || null,
    });

    let feedbackContent = "";
    if (queuedTracks.length === 1) {
      const position = Number.isFinite(queuedTrackPositions[0]) ? queuedTrackPositions[0] : (hadAnythingQueuedBefore ? queue.tracks.length : null);
      feedbackContent = formatQueuedMessage(queuedTracks[0], position, formatDuration);
    } else {
      feedbackContent = formatQueuedPlaylistMessage(queuedTracks.length, requesterName);
    }
    await sendQueueFeedback({
      queue,
      content: feedbackContent,
      logInfo,
      logError,
      context: `api_queue_search:${source || "resolve"}`,
    });

    const playNextFn = typeof getPlayNext === "function" ? getPlayNext() : null;
    if (!queue.playing && typeof playNextFn === "function") {
      playNextFn(context.guildId).catch((error) => {
        logError("Error starting playback from activity/web queue search", {
          guildId: context.guildId,
          source: source || "unknown",
          error,
        });
      });
    }

    return {
      ok: true,
      queuedTracks,
      queuedTrackPositions,
      requesterName,
      data: summarizeQueue(queue),
    };
  }

  async function handleActivityQueueSearch(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const guildId = String(body.guild_id || body.guildId || "").trim();
    const rawQuery = String(body.query || "").trim();
    if (!rawQuery) {
      sendJson(response, 400, { error: "Missing query" });
      return;
    }

    const context = await resolveAuthorizedActivityContext({
      request,
      response,
      guildId,
      requireQueue: true,
      createQueueIfMissing: true,
      requireVoiceChannelMatch: true,
    });
    if (!context) {
      return;
    }
    await maybeAttachQueueTextChannel({
      queue: context.queue,
      guildId: context.guildId,
      body,
      source: "queue_search",
    });

    const normalizedQuery = String(normalizeQueryInput(rawQuery) || "").trim();
    if (!normalizedQuery) {
      sendJson(response, 400, { error: "Missing query" });
      return;
    }

    const requesterName = getSessionRequesterName(context.session);
    const queryIsUrl = isLikelyUrlQuery(normalizedQuery);
    if (!queryIsUrl) {
      let searchOptions = [];
      try {
        searchOptions = await runActivitySearchTask(
          () => getSearchOptionsForQuery(normalizedQuery, requesterName)
        );
      } catch (error) {
        logError("Failed to fetch activity/web search chooser options", {
          guildId: context.guildId,
          query: normalizedQuery,
          error,
        });
      }
      if (Array.isArray(searchOptions) && searchOptions.length) {
        const chooser = createActivitySearchChooser({
          guildId: context.guildId,
          requesterId: context.session?.user?.id || "",
          query: normalizedQuery,
          options: searchOptions,
        });
        sendJson(response, 200, {
          ok: true,
          mode: "chooser",
          guildId: context.guildId,
          search: {
            id: chooser.id,
            query: chooser.query,
            expiresAt: chooser.expiresAt,
            timeoutMs: ACTIVITY_SEARCH_CHOOSER_TTL_MS,
            options: chooser.options.map((track, index) => summarizeSearchOption(track, index)),
          },
          data: summarizeQueue(context.queue),
        });
        return;
      }
      sendJson(response, 404, { error: "No results found." });
      return;
    }

    let tracks = [];
    try {
      tracks = await runActivitySearchTask(
        () => resolveTracks(normalizedQuery, requesterName, {
          allowSearchFallback: false,
        })
      );
    } catch (error) {
      logError("Failed to resolve activity/web queue search", {
        guildId: context.guildId,
        query: normalizedQuery,
        error,
      });
      sendJson(response, 502, { error: error.message || "Could not load that track or playlist." });
      return;
    }

    if (!tracks.length) {
      let searchOptions = [];
      try {
        searchOptions = await runActivitySearchTask(
          () => getSearchOptionsForQuery(normalizedQuery, requesterName)
        );
      } catch (error) {
        logError("Failed to fetch activity/web search chooser options", {
          guildId: context.guildId,
          query: normalizedQuery,
          error,
        });
      }
      if (Array.isArray(searchOptions) && searchOptions.length) {
        const chooser = createActivitySearchChooser({
          guildId: context.guildId,
          requesterId: context.session?.user?.id || "",
          query: normalizedQuery,
          options: searchOptions,
        });
        sendJson(response, 200, {
          ok: true,
          mode: "chooser",
          guildId: context.guildId,
          search: {
            id: chooser.id,
            query: chooser.query,
            expiresAt: chooser.expiresAt,
            timeoutMs: ACTIVITY_SEARCH_CHOOSER_TTL_MS,
            options: chooser.options.map((track, index) => summarizeSearchOption(track, index)),
          },
          data: summarizeQueue(context.queue),
        });
        return;
      }

      sendJson(response, 404, { error: "Could not resolve that link." });
      return;
    }

    const queueResult = await queueTracksFromActivityRequest({
      context,
      tracks,
      source: "direct",
    });
    if (!queueResult.ok) {
      sendJson(response, queueResult.statusCode || 400, {
        error: queueResult.error || "Failed to queue tracks",
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      mode: "queued",
      guildId: context.guildId,
      queuedCount: queueResult.queuedTracks.length,
      queued: queueResult.queuedTracks.length === 1
        ? summarizeTrack(queueResult.queuedTracks[0])
        : null,
      queuedPosition: queueResult.queuedTracks.length === 1
        ? (Number.isFinite(queueResult.queuedTrackPositions?.[0]) ? queueResult.queuedTrackPositions[0] : null)
        : null,
      data: queueResult.data,
    });
  }

  async function handleActivityQueueSearchSelect(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const guildId = String(body.guild_id || body.guildId || "").trim();
    const searchId = String(body.search_id || body.searchId || "").trim();
    if (!searchId) {
      sendJson(response, 400, { error: "Missing search_id" });
      return;
    }

    const context = await resolveAuthorizedActivityContext({
      request,
      response,
      guildId,
      requireQueue: true,
      createQueueIfMissing: true,
      requireVoiceChannelMatch: true,
    });
    if (!context) {
      return;
    }
    await maybeAttachQueueTextChannel({
      queue: context.queue,
      guildId: context.guildId,
      body,
      source: "queue_search_select",
    });

    const chooser = getActivitySearchChooser(searchId);
    if (!chooser) {
      sendJson(response, 410, { error: "That search has expired." });
      return;
    }
    if (chooser.guildId !== context.guildId) {
      sendJson(response, 400, { error: "Search chooser does not match the selected guild." });
      return;
    }
    const sessionUserId = String(context.session?.user?.id || "").trim();
    if (!sessionUserId || chooser.requesterId !== sessionUserId) {
      sendJson(response, 403, { error: "Only the requester can choose a result." });
      return;
    }

    const queueFirst = toBoolean(body.queue_first ?? body.queueFirst, false);
    const optionIndex = queueFirst
      ? 0
      : toFiniteInteger(body.option_index ?? body.optionIndex);
    if (!Number.isFinite(optionIndex)) {
      sendJson(response, 400, { error: "Missing option_index" });
      return;
    }
    if (optionIndex < 0 || optionIndex >= chooser.options.length) {
      sendJson(response, 400, {
        error: `Invalid option index. Choose 0-${Math.max(chooser.options.length - 1, 0)}.`,
      });
      return;
    }

    const selectedTrack = chooser.options[optionIndex];
    clearActivitySearchChooser(searchId);
    const queueResult = await queueTracksFromActivityRequest({
      context,
      tracks: [selectedTrack],
      source: "chooser",
    });
    if (!queueResult.ok) {
      sendJson(response, queueResult.statusCode || 400, {
        error: queueResult.error || "Failed to queue search result",
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      mode: "queued",
      guildId: context.guildId,
      queuedCount: 1,
      queued: summarizeTrack(queueResult.queuedTracks[0]),
      queuedPosition: Number.isFinite(queueResult.queuedTrackPositions?.[0]) ? queueResult.queuedTrackPositions[0] : null,
      data: queueResult.data,
    });
  }

  async function handleActivityControl(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const action = String(body.action || "").trim().toLowerCase();
    const guildId = String(body.guild_id || body.guildId || "").trim();
    if (!action) {
      sendJson(response, 400, { error: "Missing action" });
      return;
    }

    const context = await resolveAuthorizedActivityContext({
      request,
      response,
      guildId,
      requireQueue: true,
      requireVoiceChannelMatch: true,
    });
    if (!context) {
      return;
    }
    await maybeAttachQueueTextChannel({
      queue: context.queue,
      guildId: context.guildId,
      body,
      source: "control",
    });

    const { session, queue } = context;
    const isResumeAction = action === "resume";
    const ensureVoiceConnectionOptions = {
      guildId,
    };
    if (isResumeAction) {
      const sessionUserId = String(session?.user?.id || "").trim();
      if (sessionUserId) {
        try {
          const userVoiceChannelId = await getUserVoiceChannelId(guildId, sessionUserId);
          const normalizedUserVoiceChannelId = String(userVoiceChannelId || "").trim() || null;
          if (normalizedUserVoiceChannelId) {
            ensureVoiceConnectionOptions.preferredVoiceChannelId = normalizedUserVoiceChannelId;
          }
        } catch (error) {
          logError("Failed to resolve user voice channel for resume ensure-connection", {
            guildId,
            userId: sessionUserId,
            error,
          });
        }
      }
    }

    try {
      const result = await controlService.applyControlAction(queue, action, {
        refreshNowPlayingUpNextOnClear: true,
        refreshNowPlayingOnPauseResume: true,
        ensureVoiceConnectionOnResume: isResumeAction,
        ensureVoiceConnectionOptions,
        stopReason: "Stopping playback and clearing queue (Activity/web control)",
      });
      if (!result.ok) {
        sendJson(response, result.statusCode || 400, {
          error: result.error || "Failed to apply action",
        });
        return;
      }

      logInfo("Applied activity/web control action", {
        action,
        guildId,
        user: session?.user?.username || session?.user?.id || "unknown",
      });
      await sendQueueFeedback({
        queue,
        content: buildControlActionFeedback(action, {
          sessionUser: session?.user,
          result,
        }),
        logInfo,
        logError,
        context: `api_control:${action}`,
      });

      sendJson(response, 200, {
        ok: true,
        action,
        guildId,
        data: summarizeQueue(queue),
      });
    } catch (error) {
      logError("Failed to apply activity/web control action", { action, guildId, error });
      sendJson(response, 500, { error: error.message || "Failed to apply action" });
    }
  }

  async function handleActivityQueueAction(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const action = String(body.action || "").trim().toLowerCase();
    const guildId = String(body.guild_id || body.guildId || "").trim();
    if (!action) {
      sendJson(response, 400, { error: "Missing action" });
      return;
    }

    const context = await resolveAuthorizedActivityContext({
      request,
      response,
      guildId,
      requireQueue: true,
      requireVoiceChannelMatch: true,
    });
    if (!context) {
      return;
    }
    await maybeAttachQueueTextChannel({
      queue: context.queue,
      guildId: context.guildId,
      body,
      source: "queue_action",
    });

    const { session, queue } = context;
    const fromPosition = toFiniteInteger(body.from_position ?? body.fromPosition);
    const toPosition = toFiniteInteger(body.to_position ?? body.toPosition);
    const position = toFiniteInteger(body.position);
    const mode = body.mode === undefined || body.mode === null
      ? undefined
      : String(body.mode).trim().toLowerCase();

    try {
      const result = await controlService.applyQueueAction(queue, action, {
        fromPosition,
        toPosition,
        position,
        mode,
        refreshNowPlayingUpNextOnClear: true,
        refreshNowPlayingUpNextOnShuffle: true,
        refreshNowPlayingUpNextOnMove: true,
        refreshNowPlayingUpNextOnRemove: true,
        refreshNowPlayingUpNextOnLoop: true,
        refreshNowPlayingOnLoop: true,
      });
      if (!result.ok) {
        sendJson(response, result.statusCode || 400, {
          error: result.error || "Failed to apply queue action",
        });
        return;
      }

      logInfo("Applied activity/web queue action", {
        action,
        guildId,
        fromPosition,
        toPosition,
        position,
        mode,
        user: session?.user?.username || session?.user?.id || "unknown",
      });
      await sendQueueFeedback({
        queue,
        content: buildQueueActionFeedback(action, {
          sessionUser: session?.user,
          result,
        }),
        logInfo,
        logError,
        context: `api_queue:${action}`,
      });

      sendJson(response, 200, {
        ok: true,
        action,
        guildId,
        result: summarizeQueueActionResult(result),
        data: summarizeQueue(queue),
      });
    } catch (error) {
      logError("Failed to apply activity/web queue action", {
        action,
        guildId,
        fromPosition,
        toPosition,
        position,
        mode,
        error,
      });
      sendJson(response, 500, { error: error.message || "Failed to apply queue action" });
    }
  }

  async function handleAdminSettings(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    const session = getSessionFromRequest(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const adminSettings = getSessionAdminSettings(session);
    if (!adminSettings.isAdmin) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const hasVoiceBypassField = Object.hasOwn(body, "bypass_voice_check")
      || Object.hasOwn(body, "bypassVoiceCheck")
      || Object.hasOwn(body, "bypassVoiceChannelCheck");
    const hasGuildBypassField = Object.hasOwn(body, "bypass_guild_access")
      || Object.hasOwn(body, "bypassGuildAccess")
      || Object.hasOwn(body, "controlAllGuilds");
    if (!hasVoiceBypassField && !hasGuildBypassField) {
      sendJson(response, 400, { error: "Missing admin setting field" });
      return;
    }

    if (hasVoiceBypassField) {
      const bypassVoiceChannelCheck = toBoolean(
        body.bypass_voice_check ?? body.bypassVoiceCheck ?? body.bypassVoiceChannelCheck,
        false
      );
      session.adminBypassVoiceChannelCheck = bypassVoiceChannelCheck;
    }
    if (hasGuildBypassField) {
      const bypassGuildAccess = toBoolean(
        body.bypass_guild_access ?? body.bypassGuildAccess ?? body.controlAllGuilds,
        false
      );
      session.adminBypassGuildAccess = bypassGuildAccess;
    }
    persistSessionsToStore();

    const settings = getSessionAdminSettings(session);

    logInfo("Updated activity admin settings", {
      userId: session?.user?.id || null,
      bypassVoiceChannelCheck: settings.bypassVoiceChannelCheck,
      bypassGuildAccess: settings.bypassGuildAccess,
    });

    sendJson(response, 200, {
      ok: true,
      admin: settings,
    });
  }

  async function handleAdminGuildList(request, response) {
    const context = resolveAdminSessionContext(request, response);
    if (!context) {
      return;
    }

    let guilds;
    try {
      guilds = await getBotGuilds();
    } catch (error) {
      logError("Failed to load bot guild list for admin endpoint", error);
      sendJson(response, 500, { error: "Failed to load guild list" });
      return;
    }

    const normalizedGuilds = Array.isArray(guilds)
      ? guilds
        .map((guild) => ({
          id: String(guild?.id || "").trim(),
          name: String(guild?.name || "").trim() || null,
        }))
        .filter((guild) => guild.id)
      : [];

    sendJson(response, 200, {
      guilds: normalizedGuilds,
      total: normalizedGuilds.length,
      fetchedAt: Date.now(),
    });
  }

  async function handleAdminEvents(request, response, requestUrl) {
    const context = resolveAdminSessionContext(request, response);
    if (!context) {
      return;
    }

    const level = String(requestUrl.searchParams.get("level") || "info").trim().toLowerCase();
    const limitParam = toFiniteInteger(requestUrl.searchParams.get("limit"));
    const limit = limitParam === null ? 100 : Math.min(500, Math.max(1, limitParam));

    let events = [];
    try {
      events = await getAdminEvents({
        minLevel: level,
        limit,
      });
    } catch (error) {
      logError("Failed to load admin events", error);
      sendJson(response, 500, { error: "Failed to load admin events" });
      return;
    }

    sendJson(response, 200, {
      level,
      limit,
      events: Array.isArray(events) ? events : [],
      fetchedAt: Date.now(),
    });
  }

  async function handleAdminProviderStatus(request, response) {
    const context = resolveAdminSessionContext(request, response);
    if (!context) {
      return;
    }

    let status = null;
    try {
      status = await getProviderStatus();
    } catch (error) {
      logError("Failed to load provider status", error);
      sendJson(response, 500, { error: "Failed to load provider status" });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      providers: status,
      fetchedAt: Date.now(),
    });
  }

  async function handleAdminProviderVerify(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    const context = resolveAdminSessionContext(request, response);
    if (!context) {
      return;
    }

    try {
      const verification = await verifyProviderAuthStatus();
      sendJson(response, 200, {
        ok: true,
        verification,
      });
    } catch (error) {
      logError("Failed to verify provider auth status", error);
      sendJson(response, 500, { error: "Failed to verify provider auth status" });
    }
  }

  async function handleAdminProviderReinitialize(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    const context = resolveAdminSessionContext(request, response);
    if (!context) {
      return;
    }

    try {
      const result = await reinitializeProviders();
      sendJson(response, 200, {
        ok: true,
        result: result && typeof result === "object" ? result : null,
      });
    } catch (error) {
      logError("Failed to reinitialize providers from admin endpoint", error);
      sendJson(response, 500, { error: "Failed to reinitialize providers" });
    }
  }

  async function handleAdminDiscordGatewayStatus(request, response) {
    const context = resolveAdminSessionContext(request, response);
    if (!context) {
      return;
    }

    let gateway = null;
    try {
      gateway = await getDiscordGatewayStatus();
    } catch (error) {
      logError("Failed to load Discord gateway status", error);
      sendJson(response, 500, { error: "Failed to load Discord gateway status" });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      gateway: gateway && typeof gateway === "object" ? gateway : null,
      fetchedAt: Date.now(),
    });
  }

  async function handleAdminDiscordGatewayRelogin(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    const context = resolveAdminSessionContext(request, response);
    if (!context) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const requestedReason = String(body.reason || "").trim();
    const reasonSuffix = requestedReason || "manual admin action";
    const reason = `api-admin:${context?.session?.user?.id || "unknown-user"}:${reasonSuffix}`.slice(0, 240);

    let reloginResult = null;
    try {
      reloginResult = await forceDiscordRelogin({
        reason,
        actor: {
          userId: context?.session?.user?.id || null,
          username: context?.session?.user?.username || null,
        },
      });
    } catch (error) {
      logError("Admin Discord relogin request failed", {
        reason,
        userId: context?.session?.user?.id || null,
        error,
      });
      sendJson(response, 500, { error: "Failed to trigger Discord relogin" });
      return;
    }

    const gateway = await (async () => {
      try {
        return await getDiscordGatewayStatus();
      } catch {
        return null;
      }
    })();

    logInfo("Admin requested Discord relogin", {
      reason,
      userId: context?.session?.user?.id || null,
    });

    sendJson(response, 200, {
      ok: true,
      relogin: reloginResult && typeof reloginResult === "object"
        ? reloginResult
        : { accepted: Boolean(reloginResult) },
      gateway: gateway && typeof gateway === "object" ? gateway : null,
      triggeredAt: Date.now(),
    });
  }

  async function handleAdminQueueForceCleanup(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const guildId = String(body.guild_id || body.guildId || "").trim();
    const context = await resolveAuthorizedActivityContext({
      request,
      response,
      guildId,
      requireQueue: true,
      requireVoiceChannelMatch: false,
      requireAdmin: true,
    });
    if (!context) {
      return;
    }

    stopQueueAction(context.queue, "Admin force cleanup from activity/web");
    sendJson(response, 200, {
      ok: true,
      guildId: context.guildId,
      data: summarizeQueue(context.queue),
    });
  }

  async function handleAdminQueueRefreshNowPlaying(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const guildId = String(body.guild_id || body.guildId || "").trim();
    const context = await resolveAuthorizedActivityContext({
      request,
      response,
      guildId,
      requireQueue: true,
      requireVoiceChannelMatch: false,
      requireAdmin: true,
    });
    if (!context) {
      return;
    }

    try {
      await maybeRefreshNowPlayingUpNext(context.queue);
      await sendNowPlaying(context.queue, false);
      sendJson(response, 200, {
        ok: true,
        guildId: context.guildId,
      });
    } catch (error) {
      logError("Failed to refresh now playing from admin endpoint", {
        guildId: context.guildId,
        error,
      });
      sendJson(response, 500, { error: "Failed to refresh now playing" });
    }
  }

  async function handleActivityQueueList(request, response, requestUrl) {
    const guildId = String(requestUrl.searchParams.get("guild_id") || "").trim();
    const context = await resolveAuthorizedActivityContext({
      request,
      response,
      guildId,
      requireQueue: false,
      requireVoiceChannelMatch: false,
    });
    if (!context) {
      return;
    }

    const { queue } = context;
    const offsetParam = toFiniteInteger(requestUrl.searchParams.get("offset"));
    const limitParam = toFiniteInteger(requestUrl.searchParams.get("limit"));
    const offset = offsetParam === null ? 0 : Math.max(0, offsetParam);
    const limit = limitParam === null ? 100 : Math.min(200, Math.max(1, limitParam));

    const allTracks = Array.isArray(queue?.tracks) ? queue.tracks : [];
    const tracks = allTracks
      .slice(offset, offset + limit)
      .map((track, index) => ({
        position: offset + index + 1,
        ...summarizeTrack(track),
      }));

    sendJson(response, 200, {
      guildId: context.guildId,
      offset,
      limit,
      total: allTracks.length,
      nowPlaying: summarizeTrack(queue?.current),
      playbackProgress: summarizePlaybackProgress(queue),
      loopMode: queue?.loopMode || "off",
      tracks,
      updatedAt: Date.now(),
    });
  }

  function getCachedThumbnail(sourceUrl) {
    const cached = thumbnailCache.get(sourceUrl);
    if (!cached) {
      return null;
    }
    if (!Number.isFinite(cached.expiresAt) || cached.expiresAt <= Date.now()) {
      thumbnailCache.delete(sourceUrl);
      return null;
    }
    return cached;
  }

  function setCachedThumbnail(sourceUrl, payload) {
    if (!sourceUrl || !payload?.body || !payload?.contentType) {
      return;
    }
    if (thumbnailCache.size >= THUMBNAIL_PROXY_CACHE_MAX_ENTRIES) {
      const oldestKey = thumbnailCache.keys().next().value;
      if (oldestKey) {
        thumbnailCache.delete(oldestKey);
      }
    }
    thumbnailCache.set(sourceUrl, {
      contentType: payload.contentType,
      body: payload.body,
      expiresAt: Date.now() + THUMBNAIL_PROXY_CACHE_TTL_MS,
    });
  }

  function sendThumbnail(response, contentType, body) {
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType || "application/octet-stream");
    response.setHeader("Content-Length", String(body.length));
    response.setHeader("Cache-Control", "private, max-age=900");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(body);
  }

  async function handleActivityThumbnail(request, response, requestUrl) {
    const session = getSessionFromRequest(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const rawSourceUrl = String(requestUrl.searchParams.get("src") || "").trim();
    const sourceUrl = normalizeExternalUrl(rawSourceUrl);
    if (!sourceUrl) {
      sendJson(response, 400, { error: "Missing or invalid src query parameter" });
      return;
    }

    let parsedSourceUrl;
    try {
      parsedSourceUrl = new URL(sourceUrl);
    } catch {
      sendJson(response, 400, { error: "Invalid thumbnail source URL" });
      return;
    }

    if (String(parsedSourceUrl.protocol || "").toLowerCase() !== "https:") {
      sendJson(response, 400, { error: "Only https thumbnail URLs are supported" });
      return;
    }
    if (!isAllowedThumbnailHost(parsedSourceUrl.hostname)) {
      sendJson(response, 403, { error: "Thumbnail host is not allowed" });
      return;
    }

    const cached = getCachedThumbnail(sourceUrl);
    if (cached) {
      sendThumbnail(response, cached.contentType, cached.body);
      return;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, THUMBNAIL_PROXY_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(sourceUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "queueDexBot-thumbnail-proxy/1.0",
        },
      });
    } catch (error) {
      const isTimeout = String(error?.name || "").toLowerCase() === "aborterror";
      sendJson(response, isTimeout ? 504 : 502, {
        error: isTimeout ? "Thumbnail request timed out" : "Failed to fetch thumbnail",
      });
      return;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!upstream.ok) {
      sendJson(response, upstream.status === 404 ? 404 : 502, {
        error: upstream.status === 404 ? "Thumbnail not found" : `Thumbnail fetch failed (${upstream.status})`,
      });
      return;
    }

    const contentType = String(upstream.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) {
      sendJson(response, 415, { error: "Thumbnail response was not an image" });
      return;
    }

    let body;
    try {
      const buffer = await upstream.arrayBuffer();
      if (!buffer || buffer.byteLength <= 0) {
        sendJson(response, 502, { error: "Thumbnail response body was empty" });
        return;
      }
      if (buffer.byteLength > THUMBNAIL_PROXY_MAX_BYTES) {
        sendJson(response, 413, { error: "Thumbnail response exceeded max size" });
        return;
      }
      body = Buffer.from(buffer);
    } catch {
      sendJson(response, 502, { error: "Failed reading thumbnail response" });
      return;
    }

    setCachedThumbnail(sourceUrl, { contentType, body });
    sendThumbnail(response, contentType, body);
  }

  async function handleActivityExchange(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    if (!oauthConfigured) {
      sendJson(response, 503, {
        error: "OAuth is not configured",
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const code = String(body.code || "").trim();
    if (!code) {
      sendJson(response, 400, { error: "Missing OAuth code" });
      return;
    }

    const requestedScopes = normalizeScopes(body.scopes || oauthScopes);
    const redirectUri = String(body.redirectUri || oauthActivityRedirectUri || "").trim() || null;

    try {
      const token = await exchangeDiscordCode({
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        code,
        redirectUri,
        scopes: requestedScopes,
      });

      const user = await fetchDiscordResource(token.access_token, "/users/@me");
      let guilds = [];
      if (String(token.scope || requestedScopes).split(" ").includes("guilds")) {
        try {
          const guildPayload = await fetchDiscordResource(token.access_token, "/users/@me/guilds");
          guilds = Array.isArray(guildPayload) ? guildPayload.map(summarizeGuild).filter(Boolean) : [];
        } catch (error) {
          logError("Failed to fetch user guilds during activity auth exchange", error);
        }
      }

      const session = createSession({
        user: summarizeUser(user),
        guilds,
        scopes: token.scope || requestedScopes,
        accessToken: token.access_token,
        tokenType: token.token_type || "Bearer",
      });

      const maxAgeSeconds = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
      response.setHeader("Set-Cookie", serializeCookie({
        name: cookieName,
        value: session.id,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        maxAgeSeconds,
      }));
      sendJson(response, 200, {
        access_token: token.access_token,
        token_type: token.token_type || "Bearer",
        expires_in: token.expires_in,
        scope: token.scope || requestedScopes,
        session: {
          id: session.id,
          expiresAt: session.expiresAt,
        },
        user: session.user,
        guilds: session.guilds,
      });
    } catch (error) {
      logError("Activity OAuth code exchange failed", error);
      sendJson(response, 502, { error: error.message || "OAuth exchange failed" });
    }
  }

  async function handleActivitySession(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Invalid request body" });
      return;
    }

    const accessToken = String(body.access_token || "").trim();
    if (!accessToken) {
      sendJson(response, 400, { error: "Missing access_token" });
      return;
    }

    const scopeSource = Array.isArray(body.scopes)
      ? body.scopes.join(" ")
      : body.scopes;
    const requestedScopes = normalizeScopes(scopeSource || oauthScopes);

    try {
      const user = await fetchDiscordResource(accessToken, "/users/@me");
      let guilds = [];
      if (String(requestedScopes).split(" ").includes("guilds")) {
        try {
          const guildPayload = await fetchDiscordResource(accessToken, "/users/@me/guilds");
          guilds = Array.isArray(guildPayload) ? guildPayload.map(summarizeGuild).filter(Boolean) : [];
        } catch (error) {
          logError("Failed to fetch user guilds during activity session bootstrap", error);
        }
      }

      const session = createSession({
        user: summarizeUser(user),
        guilds,
        scopes: requestedScopes,
        accessToken,
        tokenType: "Bearer",
      });

      const maxAgeSeconds = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
      response.setHeader("Set-Cookie", serializeCookie({
        name: cookieName,
        value: session.id,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        maxAgeSeconds,
      }));
      sendJson(response, 200, {
        ok: true,
        session: {
          id: session.id,
          expiresAt: session.expiresAt,
        },
        user: session.user,
        guilds: session.guilds,
      });
    } catch (error) {
      logError("Activity session bootstrap from access token failed", error);
      sendJson(response, 401, { error: error.message || "Invalid access token" });
    }
  }

  async function handleRefreshGuilds(request, response) {
    if (!requireJsonRequest(request, response)) {
      return;
    }

    const session = getSessionFromRequest(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const guilds = await refreshSessionGuilds(session);
      sendJson(response, 200, {
        ok: true,
        guilds,
        refreshedAt: Date.now(),
      });
    } catch (error) {
      if (error?.code === "MISSING_GUILDS_SCOPE") {
        sendJson(response, 409, { error: "Session is missing guilds scope. Sign in again with guilds scope enabled." });
        return;
      }
      if (error?.code === "NO_ACCESS_TOKEN") {
        sendJson(response, 409, { error: "Session cannot refresh guilds because access token is unavailable." });
        return;
      }
      logError("Failed to refresh session guild list", error);
      sendJson(response, 502, { error: error.message || "Failed to refresh guild list" });
    }
  }

  function buildWebAuthorizeUrl(state, redirectPath, scopes) {
    pendingWebStates.set(state, {
      createdAt: Date.now(),
      redirectPath: redirectPath || "/",
      scopes: normalizeScopes(scopes),
    });
    const params = new URLSearchParams({
      client_id: oauthClientId,
      response_type: "code",
      redirect_uri: oauthWebRedirectUri,
      scope: normalizeScopes(scopes),
      state,
      prompt: "consent",
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async function handleWebStart(requestUrl, response) {
    if (!oauthConfigured || !oauthWebRedirectUri) {
      sendJson(response, 503, { error: "Web OAuth start is not configured" });
      return;
    }

    const redirectPath = String(requestUrl.searchParams.get("redirect") || "/").trim();
    const safeRedirectPath = redirectPath.startsWith("/") ? redirectPath : "/";
    const scopes = normalizeScopes(requestUrl.searchParams.get("scopes") || oauthScopes);
    const state = crypto.randomUUID();
    const authorizeUrl = buildWebAuthorizeUrl(state, safeRedirectPath, scopes);
    sendRedirect(response, 302, authorizeUrl);
  }

  async function handleWebCallback(requestUrl, response) {
    if (!oauthConfigured || !oauthWebRedirectUri) {
      sendJson(response, 503, { error: "Web OAuth callback is not configured" });
      return;
    }

    const code = String(requestUrl.searchParams.get("code") || "").trim();
    const state = String(requestUrl.searchParams.get("state") || "").trim();
    const error = String(requestUrl.searchParams.get("error") || "").trim();
    if (error) {
      sendText(response, 400, `OAuth failed: ${error}`);
      return;
    }
    if (!code || !state) {
      sendText(response, 400, "Missing OAuth callback parameters.");
      return;
    }
    const pendingState = pendingWebStates.get(state);
    pendingWebStates.delete(state);
    if (!pendingState) {
      sendText(response, 400, "OAuth state is invalid or expired.");
      return;
    }

    try {
      const token = await exchangeDiscordCode({
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        code,
        redirectUri: oauthWebRedirectUri,
        scopes: pendingState.scopes,
      });
      const user = await fetchDiscordResource(token.access_token, "/users/@me");
      let guilds = [];
      if (String(token.scope || pendingState.scopes).split(" ").includes("guilds")) {
        try {
          const guildPayload = await fetchDiscordResource(token.access_token, "/users/@me/guilds");
          guilds = Array.isArray(guildPayload) ? guildPayload.map(summarizeGuild).filter(Boolean) : [];
        } catch (guildError) {
          logError("Failed to fetch user guilds during web auth callback", guildError);
        }
      }
      const session = createSession({
        user: summarizeUser(user),
        guilds,
        scopes: token.scope || pendingState.scopes,
        accessToken: token.access_token,
        tokenType: token.token_type || "Bearer",
      });
      const maxAgeSeconds = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
      response.setHeader("Set-Cookie", serializeCookie({
        name: cookieName,
        value: session.id,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        maxAgeSeconds,
      }));
      sendRedirect(response, 302, pendingState.redirectPath || "/");
    } catch (callbackError) {
      logError("Web OAuth callback failed", callbackError);
      sendText(response, 502, `OAuth callback failed: ${callbackError.message || String(callbackError)}`);
    }
  }

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;
    try {
      if (request.method === "GET" && pathname === "/auth/health") {
        sendJson(response, 200, {
          ok: true,
          oauthConfigured,
          webRedirectConfigured: Boolean(oauthWebRedirectUri),
          activityRedirectConfigured: Boolean(oauthActivityRedirectUri),
          adminUserCount: adminUserIds.size,
          now: Date.now(),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/auth/discord/web/start") {
        await handleWebStart(requestUrl, response);
        return;
      }

      if (request.method === "GET" && pathname === "/auth/discord/web/callback") {
        await handleWebCallback(requestUrl, response);
        return;
      }

      if (request.method === "POST" && pathname === "/auth/discord/activity/exchange") {
        await handleActivityExchange(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/auth/discord/activity/session") {
        await handleActivitySession(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/auth/me") {
        const session = getSessionFromRequest(request);
        if (!session) {
          sendJson(response, 401, { authenticated: false });
          return;
        }
        let visibleGuilds = Array.isArray(session.guilds) ? session.guilds : [];
        visibleGuilds = visibleGuilds.filter((guild) => {
          const guildId = String(guild?.id || "").trim();
          if (!guildId) {
            return false;
          }
          try {
            return Boolean(isBotInGuild(guildId));
          } catch (error) {
            logError("Failed to filter guild list for /auth/me response", error);
            return true;
          }
        });
        sendJson(response, 200, {
          authenticated: true,
          session: {
            id: session.id,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            scopes: session.scopes,
          },
          user: session.user,
          guilds: visibleGuilds,
          admin: getSessionAdminSettings(session),
        });
        return;
      }

      if (request.method === "POST" && pathname === "/auth/refresh-guilds") {
        await handleRefreshGuilds(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/auth/logout") {
        const session = getSessionFromRequest(request);
        if (session) {
          sessions.delete(session.id);
          persistSessionsToStore();
        }
        response.setHeader("Set-Cookie", serializeCookie({
          name: cookieName,
          value: "",
          secure: cookieSecure,
          sameSite: cookieSameSite,
          maxAgeSeconds: 0,
        }));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/state") {
        const session = getSessionFromRequest(request);
        if (!session) {
          sendJson(response, 401, { error: "Unauthorized" });
          return;
        }
        const guildId = String(requestUrl.searchParams.get("guild_id") || "").trim();
        if (!guildId) {
          sendJson(response, 400, { error: "Missing guild_id query parameter" });
          return;
        }
        if (!canAccessGuild(session, guildId)) {
          sendJson(response, 403, { error: "Forbidden for this guild" });
          return;
        }
        const queue = queues?.get?.(guildId);
        const admin = getSessionAdminSettings(session);
        const data = summarizeQueue(queue);
        data.access = await getActivityVoiceAccessState({
          guildId,
          queue,
          session,
          admin,
        });
        sendJson(response, 200, {
          guildId,
          data,
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/queue") {
        await handleActivityQueueList(request, response, requestUrl);
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/thumbnail") {
        await handleActivityThumbnail(request, response, requestUrl);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/control") {
        await handleActivityControl(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/queue/action") {
        await handleActivityQueueAction(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/queue/search") {
        await handleActivityQueueSearch(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/queue/search/select") {
        await handleActivityQueueSearchSelect(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/admin/settings") {
        await handleAdminSettings(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/admin/events") {
        await handleAdminEvents(request, response, requestUrl);
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/admin/guilds") {
        await handleAdminGuildList(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/admin/providers/status") {
        await handleAdminProviderStatus(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/admin/providers/verify") {
        await handleAdminProviderVerify(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/admin/providers/reinitialize") {
        await handleAdminProviderReinitialize(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/admin/discord/status") {
        await handleAdminDiscordGatewayStatus(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/admin/discord/relogin") {
        await handleAdminDiscordGatewayRelogin(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/admin/queue/force-cleanup") {
        await handleAdminQueueForceCleanup(request, response);
        return;
      }

      if (request.method === "POST" && pathname === "/api/activity/admin/queue/refresh-now-playing") {
        await handleAdminQueueRefreshNowPlaying(request, response);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      logError("Auth/API server request failed", error);
      sendJson(response, 500, { error: "Internal server error" });
    }
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      logError("API/Auth server request failed", error);
      sendJson(response, 500, { error: "Internal server error" });
    });
  });

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    pendingWebStates.forEach((entry, state) => {
      if (!entry || now - entry.createdAt > STATE_TTL_MS) {
        pendingWebStates.delete(state);
      }
    });
    pruneExpiredActivitySearchChoosers(now);
    let removedSessions = 0;
    sessions.forEach((session, sessionId) => {
      if (!session || session.expiresAt <= now) {
        sessions.delete(sessionId);
        removedSessions += 1;
      }
    });
    if (removedSessions > 0) {
      persistSessionsToStore();
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  if (typeof cleanupInterval.unref === "function") {
    cleanupInterval.unref();
  }

  return {
    start() {
      server.listen(port, host, () => {
        logInfo("API/Auth server listening", {
          host,
          port,
          oauthConfigured,
          oauthWebRedirectUri: oauthWebRedirectUri || null,
          oauthActivityRedirectUri: oauthActivityRedirectUri || null,
          sessionStoreEnabled,
          sessionStorePath: sessionStoreEnabled ? sessionStorePath : null,
          sessionCount: sessions.size,
        });
      });
      server.on("error", (error) => {
        logError("API/Auth server error", error);
      });
      return server;
    },
    handleRequest,
  };
}

module.exports = {
  createApiServer,
};
