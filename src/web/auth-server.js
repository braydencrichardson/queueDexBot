const crypto = require("node:crypto");
const http = require("node:http");

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

  function toTrackSummary(track) {
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

  return {
    connected: Boolean(queue.connection),
    nowPlaying: toTrackSummary(queue.current),
    upNext: Array.isArray(queue.tracks) ? queue.tracks.slice(0, 5).map(toTrackSummary) : [],
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

function createAuthServer(options) {
  const {
    queues,
    logInfo = () => {},
    logError = () => {},
    isBotInGuild = () => true,
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
  const port = Number(config.port) || 8787;
  const sessionTtlMs = Number.isFinite(config.sessionTtlMs) && config.sessionTtlMs > 0
    ? config.sessionTtlMs
    : DEFAULT_SESSION_TTL_MS;
  const cookieName = String(config.cookieName || "qdex_session").trim() || "qdex_session";
  const cookieSecure = toBoolean(config.cookieSecure, true);
  const cookieSameSite = cookieSecure ? "None" : "Lax";

  const oauthConfigured = Boolean(oauthClientId && oauthClientSecret);
  const pendingWebStates = new Map();
  const sessions = new Map();

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
    });
    return sessions.get(sessionId);
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

  async function handleActivityControl(request, response) {
    const session = getSessionFromRequest(request);
    if (!session) {
      sendJson(response, 401, { error: "Unauthorized" });
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
    if (!guildId) {
      sendJson(response, 400, { error: "Missing guild_id" });
      return;
    }
    if (!canAccessGuild(session, guildId)) {
      sendJson(response, 403, { error: "Forbidden for this guild" });
      return;
    }

    const queue = queues?.get?.(guildId);
    if (!queue) {
      sendJson(response, 404, { error: "Queue is not initialized for this guild" });
      return;
    }

    if (!action) {
      sendJson(response, 400, { error: "Missing action" });
      return;
    }

    const hasCurrent = Boolean(queue.current);
    try {
      if (action === "pause") {
        if (!hasCurrent) {
          sendJson(response, 409, { error: "Nothing is playing." });
          return;
        }
        queue.player.pause();
      } else if (action === "resume") {
        if (!hasCurrent) {
          sendJson(response, 409, { error: "Nothing is playing." });
          return;
        }
        queue.player.unpause();
      } else if (action === "skip") {
        if (!hasCurrent) {
          sendJson(response, 409, { error: "Nothing is playing." });
          return;
        }
        queue.player.stop(true);
      } else if (action === "stop") {
        if (typeof stopAndLeaveQueue === "function") {
          stopAndLeaveQueue(queue, "Stopping playback and clearing queue (Activity/web control)");
        } else {
          stopQueueFallback(queue);
        }
      } else if (action === "clear") {
        queue.tracks = [];
      } else {
        sendJson(response, 400, { error: `Unsupported action: ${action}` });
        return;
      }

      if (action === "clear") {
        await maybeRefreshNowPlayingUpNext(queue);
      }
      if (action === "pause" || action === "resume") {
        await sendNowPlaying(queue, false);
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

  async function handleActivityExchange(request, response) {
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

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;
    try {
      if (request.method === "GET" && pathname === "/auth/health") {
        sendJson(response, 200, {
          ok: true,
          oauthConfigured,
          webRedirectConfigured: Boolean(oauthWebRedirectUri),
          activityRedirectConfigured: Boolean(oauthActivityRedirectUri),
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
        });
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

      if (request.method === "POST" && pathname === "/api/activity/control") {
        await handleActivityControl(request, response);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      logError("Auth server request failed", error);
      sendJson(response, 500, { error: "Internal server error" });
    }
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
        logInfo("Auth/API server listening", {
          host,
          port,
          oauthConfigured,
          oauthWebRedirectUri: oauthWebRedirectUri || null,
          oauthActivityRedirectUri: oauthActivityRedirectUri || null,
        });
      });
      server.on("error", (error) => {
        logError("Auth/API server error", error);
      });
      return server;
    },
  };
}

module.exports = {
  createAuthServer,
};
