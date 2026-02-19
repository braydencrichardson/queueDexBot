const crypto = require("node:crypto");
const http = require("node:http");
const { createQueueService } = require("../queue/service");

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_OAUTH_SCOPES = "identify guilds";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const STATE_TTL_MS = 5 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

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

function summarizeTrack(track) {
  if (!track) {
    return null;
  }
  return {
    id: track.id || null,
    title: track.title || "Unknown",
    url: track.url || null,
    duration: Number.isFinite(track.duration) ? track.duration : null,
    source: track.source || "unknown",
    requester: track.requester || null,
    pendingResolve: Boolean(track.pendingResolve),
  };
}

function summarizeQueue(queue) {
  if (!queue) {
    return {
      connected: false,
      nowPlaying: null,
      upNext: [],
      queueLength: 0,
      loopMode: "off",
      playerStatus: "idle",
      updatedAt: Date.now(),
    };
  }

  return {
    connected: Boolean(queue.connection),
    nowPlaying: summarizeTrack(queue.current),
    upNext: Array.isArray(queue.tracks) ? queue.tracks.slice(0, 5).map(summarizeTrack) : [],
    queueLength: Array.isArray(queue.tracks) ? queue.tracks.length : 0,
    loopMode: queue.loopMode || "off",
    playerStatus: queue?.player?.state?.status || "idle",
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

function getQueueVoiceChannelId(queue) {
  return String(queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || "").trim() || null;
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
    getBotGuilds = () => [],
    getUserVoiceChannelId = async () => null,
    getAdminEvents = () => [],
    getProviderStatus = () => null,
    verifyProviderAuthStatus = async () => null,
    reinitializeProviders = async () => null,
    queueService = null,
    stopAndLeaveQueue = null,
    maybeRefreshNowPlayingUpNext = async () => {},
    sendNowPlaying = async () => {},
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
  const adminUserIds = new Set(normalizeUserIdList(config.adminUserIds));

  const oauthConfigured = Boolean(oauthClientId && oauthClientSecret);
  const pendingWebStates = new Map();
  const sessions = new Map();
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
      return null;
    }
    return session;
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

    const queue = queues?.get?.(normalizedGuildId);
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

    const { session, queue } = context;

    try {
      const result = await controlService.applyControlAction(queue, action, {
        refreshNowPlayingUpNextOnClear: true,
        refreshNowPlayingOnPauseResume: true,
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
      loopMode: queue?.loopMode || "off",
      tracks,
      updatedAt: Date.now(),
    });
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
        sendJson(response, 200, {
          guildId,
          data: summarizeQueue(queue),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/activity/queue") {
        await handleActivityQueueList(request, response, requestUrl);
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
    sessions.forEach((session, sessionId) => {
      if (!session || session.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    });
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
