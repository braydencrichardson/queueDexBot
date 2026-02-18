import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

const root = document.getElementById("app");
const SDK_READY_TIMEOUT_MS = 10000;
const UPTIME_INTERVAL_MS = 1000;
const API_POLL_INTERVAL_MS = 5000;
const DEFAULT_EMBEDDED_OAUTH_SCOPES = "identify";
const DEFAULT_WEB_OAUTH_SCOPES = "identify guilds";
const BUILD_ID = typeof __QDEX_ACTIVITY_BUILD__ !== "undefined" ? __QDEX_ACTIVITY_BUILD__ : "dev-unknown";

const TAB_PLAYER = "player";
const TAB_QUEUE = "queue";
const TAB_DEBUG = "debug";

const state = {
  mode: "unknown",
  connectedAt: null,
  sdkContext: {
    guildId: null,
    channelId: null,
    instanceId: null,
  },
  activeTab: TAB_PLAYER,
  selectedGuildId: null,
  authSummary: null,
  queueSummary: null,
  notice: "",
  noticeError: false,
  hasMountedDashboard: false,
};

let liveTicker = null;
let statePoller = null;
const debugEvents = [];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getApiUrl(path) {
  const rawBase = String(import.meta.env.VITE_ACTIVITY_API_BASE || "").trim();
  if (!rawBase) {
    return path;
  }
  const normalizedBase = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
  return `${normalizedBase}${path}`;
}

function parseScopes(rawValue, fallback) {
  return String(rawValue || fallback)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function sanitizeEmbeddedScopes(scopes) {
  const blockedScopes = new Set(["guilds", "rpc"]);
  const sanitized = scopes.filter((scope) => !blockedScopes.has(scope));
  if (!sanitized.includes("identify")) {
    sanitized.push("identify");
  }
  return sanitized;
}

function getAuthorizeMode() {
  const mode = String(import.meta.env.VITE_DISCORD_AUTHORIZE_MODE || "auto").trim().toLowerCase();
  if (mode === "rpc" || mode === "web" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function resolveOAuthRedirectUri() {
  const configured = String(import.meta.env.VITE_DISCORD_OAUTH_REDIRECT_URI || "").trim();
  if (configured) {
    return configured;
  }
  return `${window.location.origin}${window.location.pathname}`;
}

function isDiscordSaysUrl(urlValue) {
  try {
    const parsed = new URL(urlValue);
    return parsed.hostname.endsWith(".discordsays.com");
  } catch {
    return false;
  }
}

function pushDebugEvent(stage, details = "") {
  const line = `[${new Date().toISOString()}] ${stage}${details ? `: ${details}` : ""}`;
  debugEvents.push(line);
  if (debugEvents.length > 30) {
    debugEvents.shift();
  }
  console.info("[activity]", line);
}

function formatDebugEvents(limit = 12) {
  return debugEvents.slice(-limit).join("\n");
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString();
}

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const segments = [];
  if (hours > 0) {
    segments.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    segments.push(`${minutes}m`);
  }
  segments.push(`${seconds}s`);
  return segments.join(" ");
}

function formatTrackDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "unknown";
  }
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function stopLiveTicker() {
  if (liveTicker) {
    clearInterval(liveTicker);
    liveTicker = null;
  }
}

function stopStatePoller() {
  if (statePoller) {
    clearInterval(statePoller);
    statePoller = null;
  }
}

function renderStatus({ title, subtitle, rows = [], error = false, includeTrace = false }) {
  const traceRows = includeTrace ? [{ label: "Trace", value: formatDebugEvents() || "none" }] : [];
  const allRows = [{ label: "Build", value: BUILD_ID }, ...rows, ...traceRows];
  const rowHtml = allRows
    .map(({ label, value }) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  root.innerHTML = `
    <section class="shell shell-animated">
      <p class="kicker">queueDexBot Activity</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle${error ? " error" : ""}">${escapeHtml(subtitle)}</p>
      <dl>${rowHtml}</dl>
    </section>
  `;
}

function getWebLoginUrl() {
  const redirectPath = `${window.location.pathname}${window.location.search}`;
  const loginUrl = new URL(getApiUrl("/auth/discord/web/start"), window.location.origin);
  loginUrl.searchParams.set("redirect", redirectPath);
  loginUrl.searchParams.set("scopes", String(import.meta.env.VITE_WEB_OAUTH_SCOPES || DEFAULT_WEB_OAUTH_SCOPES));
  return loginUrl.toString();
}

function renderWebLogin() {
  state.mode = "web";
  state.notice = "";
  state.noticeError = false;

  root.innerHTML = `
    <section class="shell shell-animated">
      <p class="kicker">queueDexBot Activity</p>
      <h1>Web Sign In Required</h1>
      <p class="subtitle">Sign in with Discord to load queue controls in browser mode.</p>
      <div class="action-row">
        <a class="btn btn-primary" href="${escapeHtml(getWebLoginUrl())}">Sign in with Discord</a>
      </div>
      <dl>
        <dt>Mode</dt><dd>web</dd>
        <dt>Build</dt><dd>${escapeHtml(BUILD_ID)}</dd>
      </dl>
    </section>
  `;
}

function getCurrentQueueData() {
  return state.queueSummary?.data || null;
}

function getUserLabel() {
  const user = state.authSummary?.user;
  if (!user) {
    return "unknown";
  }
  if (user.globalName) {
    return `${user.globalName} (@${user.username || "unknown"})`;
  }
  if (user.username) {
    return `@${user.username}`;
  }
  return "unknown";
}

function getGuildOptionList() {
  const guilds = Array.isArray(state.authSummary?.guilds) ? state.authSummary.guilds : [];
  return guilds.filter((entry) => entry?.id && entry?.name);
}

function getGuildSelectionMarkup() {
  const guildOptions = getGuildOptionList();
  if (!guildOptions.length) {
    const fallbackGuildId = state.selectedGuildId || state.sdkContext.guildId || "unknown";
    return `
      <div class="guild-picker">
        <label>Guild</label>
        <span class="guild-readonly">${escapeHtml(fallbackGuildId)}</span>
      </div>
    `;
  }

  const selectedGuildId = state.selectedGuildId || guildOptions[0].id;
  const optionMarkup = guildOptions
    .map((guild) => `<option value="${escapeHtml(guild.id)}"${guild.id === selectedGuildId ? " selected" : ""}>${escapeHtml(guild.name)} (${escapeHtml(guild.id)})</option>`)
    .join("");
  return `
    <div class="guild-picker">
      <label for="guild-select">Guild</label>
      <select id="guild-select">${optionMarkup}</select>
    </div>
  `;
}

function getQueueListMarkup() {
  const queue = getCurrentQueueData();
  const items = Array.isArray(queue?.upNext) ? queue.upNext.filter(Boolean) : [];
  if (!items.length) {
    return `<p class="muted">No queued tracks.</p>`;
  }
  return `
    <ol class="queue-list">
      ${items.map((track) => `<li>${escapeHtml(track.title || "Unknown")} <span class="muted">(${escapeHtml(formatTrackDuration(track.duration))})</span></li>`).join("")}
    </ol>
  `;
}

function renderDashboard() {
  const queue = getCurrentQueueData();
  const mode = state.mode || "unknown";
  const queueStatusText = queue
    ? `${queue.playerStatus || "idle"} | ${queue.connected ? "connected" : "not connected"} | ${queue.queueLength || 0} queued`
    : "unavailable";
  const nowPlayingText = queue?.nowPlaying
    ? `${queue.nowPlaying.title || "Unknown"} (${formatTrackDuration(queue.nowPlaying.duration)})`
    : "Nothing currently playing";
  const connectedAtText = state.connectedAt ? formatTime(state.connectedAt) : "unknown";
  const guildCount = Array.isArray(state.authSummary?.guilds) ? state.authSummary.guilds.length : 0;
  const noticeMarkup = state.notice
    ? `<p class="subtitle ${state.noticeError ? "error" : ""}">${escapeHtml(state.notice)}</p>`
    : "";

  const shellClass = state.hasMountedDashboard ? "shell" : "shell shell-animated";
  root.innerHTML = `
    <section class="${shellClass}">
      <div class="top-row">
        <p class="kicker">queueDexBot Activity</p>
        <span class="chip chip-ok">Connected</span>
      </div>
      <h1>queueDexBot Control Panel</h1>
      <p class="subtitle">Use tabs for player, queue, and diagnostics.</p>
      ${noticeMarkup}
      <div class="toolbar">
        ${getGuildSelectionMarkup()}
        <div class="toolbar-actions">
          <button type="button" class="btn" id="refresh-now">Refresh</button>
          ${mode === "web" ? '<button type="button" class="btn" id="logout-web">Logout</button>' : ""}
        </div>
      </div>
      <nav class="menu-tabs">
        <button type="button" class="tab-btn${state.activeTab === TAB_PLAYER ? " active" : ""}" data-tab="${TAB_PLAYER}">Player</button>
        <button type="button" class="tab-btn${state.activeTab === TAB_QUEUE ? " active" : ""}" data-tab="${TAB_QUEUE}">Queue</button>
        <button type="button" class="tab-btn${state.activeTab === TAB_DEBUG ? " active" : ""}" data-tab="${TAB_DEBUG}">Debug</button>
      </nav>
      <section class="menu-panel${state.activeTab === TAB_PLAYER ? " active" : ""}" data-panel="${TAB_PLAYER}">
        <article class="panel-card">
          <h2>Playback</h2>
          <dl>
            <dt>Status</dt><dd id="queue-status">${escapeHtml(queueStatusText)}</dd>
            <dt>Now Playing</dt><dd id="queue-now-playing">${escapeHtml(nowPlayingText)}</dd>
            <dt>Last Update</dt><dd id="queue-updated-at">${escapeHtml(formatTime(queue?.updatedAt || Date.now()))}</dd>
          </dl>
          <div class="action-row">
            <button type="button" class="btn btn-primary" data-action="pause">Pause</button>
            <button type="button" class="btn btn-primary" data-action="resume">Resume</button>
            <button type="button" class="btn btn-primary" data-action="skip">Skip</button>
            <button type="button" class="btn btn-danger" data-action="stop">Stop</button>
            <button type="button" class="btn" data-action="clear">Clear Queue</button>
          </div>
        </article>
      </section>
      <section class="menu-panel${state.activeTab === TAB_QUEUE ? " active" : ""}" data-panel="${TAB_QUEUE}">
        <article class="panel-card">
          <h2>Queue Overview</h2>
          <dl>
            <dt>Loop</dt><dd id="queue-loop">${escapeHtml(queue?.loopMode || "off")}</dd>
            <dt>Queue Length</dt><dd>${escapeHtml(String(queue?.queueLength || 0))}</dd>
            <dt>Up Next</dt><dd>${getQueueListMarkup()}</dd>
          </dl>
        </article>
      </section>
      <section class="menu-panel${state.activeTab === TAB_DEBUG ? " active" : ""}" data-panel="${TAB_DEBUG}">
        <article class="panel-card">
          <h2>Session / Debug</h2>
          <dl>
            <dt>Mode</dt><dd>${escapeHtml(mode)}</dd>
            <dt>Build</dt><dd>${escapeHtml(BUILD_ID)}</dd>
            <dt>User</dt><dd>${escapeHtml(getUserLabel())}</dd>
            <dt>Guilds In Scope</dt><dd>${escapeHtml(String(guildCount))}</dd>
            <dt>Connected At</dt><dd>${escapeHtml(connectedAtText)}</dd>
            <dt>Uptime</dt><dd id="uptime">0s</dd>
            <dt>Guild</dt><dd>${escapeHtml(state.sdkContext.guildId || state.selectedGuildId || "unknown")}</dd>
            <dt>Channel</dt><dd>${escapeHtml(state.sdkContext.channelId || "n/a")}</dd>
            <dt>Instance</dt><dd>${escapeHtml(state.sdkContext.instanceId || "n/a")}</dd>
            <dt>Trace</dt><dd>${escapeHtml(formatDebugEvents() || "none")}</dd>
          </dl>
        </article>
      </section>
      <p class="footer-note">Local clock: <span id="clock">${escapeHtml(formatTime(new Date()))}</span></p>
    </section>
  `;

  wireDashboardEvents();
  state.hasMountedDashboard = true;
}

function wireDashboardEvents() {
  root.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.getAttribute("data-tab");
      if (!tab) {
        return;
      }
      state.activeTab = tab;
      renderDashboard();
    });
  });

  const guildSelect = root.querySelector("#guild-select");
  if (guildSelect) {
    guildSelect.addEventListener("change", () => {
      const nextGuildId = String(guildSelect.value || "").trim();
      if (!nextGuildId || nextGuildId === state.selectedGuildId) {
        return;
      }
      state.selectedGuildId = nextGuildId;
      setGuildQueryParam(nextGuildId);
      void refreshDashboardData();
    });
  }

  root.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      if (!action) {
        return;
      }
      void sendControlAction(action);
    });
  });

  const refreshButton = root.querySelector("#refresh-now");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      void refreshDashboardData();
    });
  }

  const logoutButton = root.querySelector("#logout-web");
  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      void logoutWebSession();
    });
  }
}

function setGuildQueryParam(guildId) {
  const url = new URL(window.location.href);
  if (guildId) {
    url.searchParams.set("guild_id", guildId);
  } else {
    url.searchParams.delete("guild_id");
  }
  window.history.replaceState({}, "", url.toString());
}

function startLiveTicker() {
  stopLiveTicker();
  liveTicker = setInterval(() => {
    const uptimeNode = root.querySelector("#uptime");
    const clockNode = root.querySelector("#clock");
    if (uptimeNode) {
      const connectedAt = state.connectedAt || new Date();
      uptimeNode.textContent = formatUptime(Date.now() - connectedAt.getTime());
    }
    if (clockNode) {
      clockNode.textContent = formatTime(new Date());
    }
  }, UPTIME_INTERVAL_MS);
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(getApiUrl(path), options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const errorMessage = payload?.error || `Request failed (${response.status})`;
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchAuthSummaryOrNull() {
  try {
    return await fetchJson("/auth/me", { credentials: "include" });
  } catch (error) {
    if (error?.status === 401) {
      return null;
    }
    throw error;
  }
}

async function createActivitySessionFromAccessToken(accessToken, scopes = []) {
  await fetchJson("/auth/discord/activity/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      access_token: accessToken,
      scopes,
    }),
  });
}

async function authorizeEmbeddedSession(discordSdk, clientId) {
  pushDebugEvent("auth.direct.start", "attempt authenticate() without OAuth code exchange");
  try {
    const directAuth = await discordSdk.commands.authenticate({});
    const directAccessToken = String(directAuth?.access_token || "").trim();
    const directScopes = Array.isArray(directAuth?.scopes) ? directAuth.scopes : [];
    if (directAccessToken) {
      pushDebugEvent("auth.direct.success", `scopes=${directScopes.join(",") || "unknown"}`);
      pushDebugEvent("auth.session.start", "creating backend session from SDK access token");
      await createActivitySessionFromAccessToken(directAccessToken, directScopes);
      pushDebugEvent("auth.session.success", "backend session created");
      return;
    }
    pushDebugEvent("auth.direct.empty", "authenticate() returned without access_token");
  } catch (error) {
    pushDebugEvent("auth.direct.failed", error?.message || String(error));
  }

  const requestedScopes = parseScopes(import.meta.env.VITE_DISCORD_OAUTH_SCOPES, DEFAULT_EMBEDDED_OAUTH_SCOPES);
  const oauthScopes = sanitizeEmbeddedScopes(requestedScopes);
  const exchangeRedirectUri = resolveOAuthRedirectUri();
  const authorizeMode = getAuthorizeMode();
  const authorizeRequestBase = {
    client_id: clientId,
    response_type: "code",
    state: globalThis.crypto?.randomUUID?.() || `${Date.now()}`,
    scope: oauthScopes,
  };
  const authorizeRpcRequest = {
    ...authorizeRequestBase,
    prompt: "none",
  };
  const authorizeWebRequest = {
    ...authorizeRequestBase,
    redirect_uri: exchangeRedirectUri,
  };

  pushDebugEvent("auth.authorize.config", `mode=${authorizeMode}; scopes=${oauthScopes.join(",")}; redirectUri=${exchangeRedirectUri}`);
  if (isDiscordSaysUrl(exchangeRedirectUri)) {
    pushDebugEvent(
      "auth.authorize.redirect.warning",
      "redirectUri is a discordsays.com URL. Set VITE_DISCORD_OAUTH_REDIRECT_URI to your registered Activity domain."
    );
  }
  if (requestedScopes.join(" ") !== oauthScopes.join(" ")) {
    pushDebugEvent("auth.authorize.scopes.sanitized", `requested=${requestedScopes.join(",")} -> effective=${oauthScopes.join(",")}`);
  }

  let authorizeResult;
  if (authorizeMode === "rpc") {
    pushDebugEvent("auth.authorize.attempt", "rpc/no redirect_uri");
    authorizeResult = await discordSdk.commands.authorize(authorizeRpcRequest);
  } else if (authorizeMode === "web") {
    pushDebugEvent("auth.authorize.attempt", "web/with redirect_uri");
    authorizeResult = await discordSdk.commands.authorize(authorizeWebRequest);
  } else {
    try {
      pushDebugEvent("auth.authorize.attempt", "auto step1 rpc/no redirect_uri");
      authorizeResult = await discordSdk.commands.authorize(authorizeRpcRequest);
    } catch (error) {
      const firstMessage = String(error?.message || error);
      const normalizedFirst = firstMessage.toLowerCase();
      const missingRedirect =
        normalizedFirst.includes('missing "redirect_uri"') ||
        normalizedFirst.includes("missing redirect_uri");
      if (!missingRedirect) {
        pushDebugEvent("auth.authorize.failed", `auto step1 non-retriable: ${firstMessage}`);
        throw new Error(`Authorize failed (auto/rpc step): ${firstMessage}`);
      }

      pushDebugEvent("auth.authorize.retry", `auto step2 due to missing redirect: ${firstMessage}`);
      try {
        authorizeResult = await discordSdk.commands.authorize(authorizeWebRequest);
      } catch (retryError) {
        const secondMessage = String(retryError?.message || retryError);
        pushDebugEvent("auth.authorize.failed", `auto step2 failed: ${secondMessage}`);
        throw new Error(
          `Authorize failed after both strategies. rpc/no-redirect => ${firstMessage} | web/with-redirect => ${secondMessage}`
        );
      }
    }
  }

  pushDebugEvent("auth.authorize.success");
  const code = String(authorizeResult?.code || "").trim();
  if (!code) {
    throw new Error("Discord authorize did not return an OAuth code");
  }

  pushDebugEvent("auth.exchange.start");
  const exchange = await fetchJson("/auth/discord/activity/exchange", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      code,
      scopes: oauthScopes.join(" "),
      redirectUri: exchangeRedirectUri,
    }),
  });

  const accessToken = String(exchange?.access_token || "").trim();
  if (!accessToken) {
    throw new Error("OAuth exchange response did not include an access token");
  }

  pushDebugEvent("auth.exchange.success");
  pushDebugEvent("auth.authenticate.start");
  await discordSdk.commands.authenticate({
    access_token: accessToken,
  });
  pushDebugEvent("auth.authenticate.success");
}

function resolveInitialGuildId() {
  const query = new URLSearchParams(window.location.search);
  const preferredGuildId = String(query.get("guild_id") || "").trim();
  if (!preferredGuildId) {
    return null;
  }
  return preferredGuildId;
}

function updateSelectedGuildFromAuth() {
  const guilds = getGuildOptionList();
  if (state.mode === "embedded" && state.sdkContext.guildId) {
    state.selectedGuildId = state.sdkContext.guildId;
    setGuildQueryParam(state.selectedGuildId);
    return;
  }

  const preferredGuildId = resolveInitialGuildId();
  if (preferredGuildId && guilds.some((guild) => guild.id === preferredGuildId)) {
    state.selectedGuildId = preferredGuildId;
    return;
  }
  if (!state.selectedGuildId && guilds.length) {
    state.selectedGuildId = guilds[0].id;
    setGuildQueryParam(state.selectedGuildId);
  }
}

async function refreshDashboardData() {
  const authSummary = await fetchAuthSummaryOrNull();
  if (!authSummary) {
    if (state.mode === "web") {
      renderWebLogin();
      return;
    }
    throw new Error("Session is not authenticated.");
  }

  state.authSummary = authSummary;
  updateSelectedGuildFromAuth();

  if (state.selectedGuildId) {
    state.queueSummary = await fetchJson(`/api/activity/state?guild_id=${encodeURIComponent(state.selectedGuildId)}`, {
      credentials: "include",
    });
  } else {
    state.queueSummary = null;
  }

  renderDashboard();
}

async function sendControlAction(action) {
  if (!state.selectedGuildId) {
    state.notice = "Select a guild first.";
    state.noticeError = true;
    renderDashboard();
    return;
  }
  pushDebugEvent("control.start", `${action} guild=${state.selectedGuildId}`);
  try {
    const payload = await fetchJson("/api/activity/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        action,
        guild_id: state.selectedGuildId,
      }),
    });
    state.queueSummary = {
      guildId: payload.guildId,
      data: payload.data || null,
    };
    state.notice = `Action applied: ${action}`;
    state.noticeError = false;
    pushDebugEvent("control.success", action);
    renderDashboard();
  } catch (error) {
    state.notice = `Action failed (${action}): ${error?.message || String(error)}`;
    state.noticeError = true;
    pushDebugEvent("control.failed", state.notice);
    renderDashboard();
  }
}

async function logoutWebSession() {
  try {
    await fetchJson("/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    pushDebugEvent("web.logout.success");
  } catch (error) {
    pushDebugEvent("web.logout.failed", error?.message || String(error));
  }
  state.authSummary = null;
  state.queueSummary = null;
  state.selectedGuildId = null;
  renderWebLogin();
}

function startStatePolling() {
  stopStatePoller();
  statePoller = setInterval(() => {
    refreshDashboardData().catch((error) => {
      pushDebugEvent("data.refresh.poll.failed", error?.message || String(error));
      if (state.mode !== "web") {
        state.notice = `Refresh failed: ${error?.message || String(error)}`;
        state.noticeError = true;
        renderDashboard();
      }
    });
  }, API_POLL_INTERVAL_MS);
}

async function bootstrapEmbeddedMode() {
  const clientId = String(import.meta.env.VITE_DISCORD_CLIENT_ID || "").trim();
  if (!clientId) {
    renderStatus({
      title: "Missing client id",
      subtitle: "Set VITE_DISCORD_CLIENT_ID in apps/activity/.env before launching this Activity.",
      error: true,
      rows: [{ label: "Expected var", value: "VITE_DISCORD_CLIENT_ID" }],
    });
    return;
  }

  const discordSdk = new DiscordSDK(clientId);
  pushDebugEvent("sdk.create.success");
  renderStatus({
    title: "Connecting to Discord",
    subtitle: "Waiting for Embedded App SDK handshake...",
    rows: [{ label: "Mode", value: "embedded" }],
  });

  pushDebugEvent("sdk.ready.start");
  await withTimeout(
    discordSdk.ready(),
    SDK_READY_TIMEOUT_MS,
    "Connection timed out. Please close and relaunch this Activity from Discord."
  );
  pushDebugEvent("sdk.ready.success");

  renderStatus({
    title: "Authorizing session",
    subtitle: "Exchanging embedded OAuth code with queueDexBot backend...",
    rows: [{ label: "Mode", value: "embedded" }],
  });

  await authorizeEmbeddedSession(discordSdk, clientId);
  state.mode = "embedded";
  state.connectedAt = new Date();
  state.sdkContext.guildId = discordSdk.guildId || null;
  state.sdkContext.channelId = discordSdk.channelId || null;
  state.sdkContext.instanceId = discordSdk.instanceId || null;
  state.selectedGuildId = discordSdk.guildId || null;
  setGuildQueryParam(state.selectedGuildId);

  await refreshDashboardData();
  startLiveTicker();
  startStatePolling();
}

async function bootstrapWebMode() {
  state.mode = "web";
  state.connectedAt = new Date();
  state.sdkContext.guildId = null;
  state.sdkContext.channelId = null;
  state.sdkContext.instanceId = null;

  renderStatus({
    title: "Loading Web Session",
    subtitle: "Checking existing Discord web login session...",
    rows: [{ label: "Mode", value: "web" }],
  });

  const authSummary = await fetchAuthSummaryOrNull();
  if (!authSummary) {
    pushDebugEvent("web.auth.none");
    renderWebLogin();
    return;
  }

  state.authSummary = authSummary;
  state.selectedGuildId = resolveInitialGuildId();
  updateSelectedGuildFromAuth();
  await refreshDashboardData();
  startLiveTicker();
  startStatePolling();
}

async function bootstrap() {
  debugEvents.length = 0;
  stopLiveTicker();
  stopStatePoller();
  state.hasMountedDashboard = false;
  pushDebugEvent("bootstrap.start", `build=${BUILD_ID}`);

  try {
    const query = new URLSearchParams(window.location.search);
    const hasFrameId = query.has("frame_id");
    if (hasFrameId) {
      await bootstrapEmbeddedMode();
      return;
    }
    await bootstrapWebMode();
  } catch (error) {
    const message = String(error?.message || "");
    const isTimeout = message.toLowerCase().includes("timed out");
    pushDebugEvent("bootstrap.failed", message);
    renderStatus({
      title: "Failed to initialize",
      subtitle: isTimeout
        ? "Connection timed out. Please close and relaunch this Activity from Discord."
        : "Initialization failed. Please reload and try again.",
      error: true,
      rows: [{ label: "Error", value: error?.message || String(error) }],
      includeTrace: true,
    });
  }
}

void bootstrap();
