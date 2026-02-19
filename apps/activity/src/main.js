import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

const root = document.getElementById("app");
const SDK_READY_TIMEOUT_MS = 10000;
const UPTIME_INTERVAL_MS = 1000;
const API_POLL_INTERVAL_MS = 5000;
const QUEUE_LIST_LIMIT = 200;
const ADMIN_EVENTS_LIMIT = 120;
const PREF_SHOW_GUILD_IDS = "qdex_show_guild_ids";
const PREF_ADMIN_EVENTS_STICK_BOTTOM = "qdex_admin_events_stick_bottom";
const DEFAULT_EMBEDDED_OAUTH_SCOPES = "identify";
const DEFAULT_WEB_OAUTH_SCOPES = "identify guilds";
const BUILD_ID = typeof __QDEX_ACTIVITY_BUILD__ !== "undefined" ? __QDEX_ACTIVITY_BUILD__ : "dev-unknown";

const TAB_PLAYER = "player";
const TAB_QUEUE = "queue";
const TAB_DEBUG = "debug";
const TAB_ADMIN = "admin";

function loadBooleanPreference(key, fallback) {
  try {
    const storage = globalThis?.localStorage;
    if (!storage) {
      return fallback;
    }
    const raw = storage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw === "1";
  } catch {
    return fallback;
  }
}

function saveBooleanPreference(key, value) {
  try {
    const storage = globalThis?.localStorage;
    if (!storage) {
      return;
    }
    storage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore local preference persistence failures
  }
}

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
  queueList: null,
  adminProviders: null,
  adminEvents: [],
  adminEventsLevel: "info",
  adminBotGuilds: [],
  adminVerification: null,
  adminEventsStickToBottom: loadBooleanPreference(PREF_ADMIN_EVENTS_STICK_BOTTOM, true),
  adminEventsOffsetFromBottom: null,
  showGuildIdsInSelector: loadBooleanPreference(PREF_SHOW_GUILD_IDS, false),
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

function toPrettyJson(value) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value ?? "");
  }
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
  const adminState = getAdminState();
  if (adminState.isAdmin && adminState.bypassGuildAccess) {
    const adminGuilds = Array.isArray(state.adminBotGuilds) ? state.adminBotGuilds : [];
    const normalizedAdminGuilds = adminGuilds.filter((entry) => entry?.id && entry?.name);
    if (normalizedAdminGuilds.length) {
      return normalizedAdminGuilds;
    }
  }

  const userGuilds = Array.isArray(state.authSummary?.guilds) ? state.authSummary.guilds : [];
  return userGuilds.filter((entry) => entry?.id && entry?.name);
}

function getAdminState() {
  const admin = state.authSummary?.admin || null;
  return {
    isAdmin: Boolean(admin?.isAdmin),
    bypassVoiceChannelCheck: Boolean(admin?.bypassVoiceChannelCheck),
    bypassGuildAccess: Boolean(admin?.bypassGuildAccess),
  };
}

function getGuildLabel(guild, { includeId = false } = {}) {
  const id = String(guild?.id || "").trim();
  const name = String(guild?.name || "").trim();
  if (!id && !name) {
    return "unknown";
  }
  if (!includeId || !id) {
    return name || id;
  }
  if (!name) {
    return id;
  }
  return `${name} (${id})`;
}

function getGuildSelectionMarkup() {
  const guildOptions = getGuildOptionList();
  const selectedGuildId = state.selectedGuildId || guildOptions[0]?.id || state.sdkContext.guildId || "unknown";

  if (state.mode === "embedded") {
    const matched = guildOptions.find((guild) => guild.id === selectedGuildId) || { id: selectedGuildId, name: selectedGuildId };
    return `
      <div class="guild-picker">
        <label>Guild</label>
        <span class="guild-readonly">${escapeHtml(getGuildLabel(matched, { includeId: state.showGuildIdsInSelector }))}</span>
      </div>
    `;
  }

  if (!guildOptions.length) {
    const fallbackGuildId = selectedGuildId;
    return `
      <div class="guild-picker">
        <label>Guild</label>
        <span class="guild-readonly">${escapeHtml(fallbackGuildId)}</span>
      </div>
    `;
  }

  const optionMarkup = guildOptions
    .map((guild) => `<option value="${escapeHtml(guild.id)}"${guild.id === selectedGuildId ? " selected" : ""}>${escapeHtml(getGuildLabel(guild, { includeId: state.showGuildIdsInSelector }))}</option>`)
    .join("");
  return `
    <div class="guild-picker">
      <label for="guild-select">Guild</label>
      <select id="guild-select">${optionMarkup}</select>
    </div>
  `;
}

function getQueueListData() {
  return state.queueList;
}

function getQueueLoopMode() {
  const queue = getCurrentQueueData();
  const queueList = getQueueListData();
  return queueList?.loopMode || queue?.loopMode || "off";
}

function getQueueTrackListMarkup() {
  const queueList = getQueueListData();
  const tracks = Array.isArray(queueList?.tracks) ? queueList.tracks : [];
  const total = Number.isFinite(queueList?.total) ? queueList.total : tracks.length;
  if (!tracks.length) {
    return `<p class="muted">No queued tracks.</p>`;
  }

  const truncatedNotice = total > tracks.length
    ? `<p class="muted">Showing ${tracks.length} of ${total} queued tracks.</p>`
    : "";

  return `
    ${truncatedNotice}
    <ul class="queue-track-list">
      ${tracks.map((track, index) => {
        const position = Number.isFinite(track?.position) ? track.position : index + 1;
        const isFirst = position <= 1;
        const isLast = position >= total;
        return `
          <li class="queue-track-row">
            <div class="queue-track-main">
              <span class="queue-track-pos">#${escapeHtml(String(position))}</span>
              <span class="queue-track-title">${escapeHtml(track?.title || "Unknown")}</span>
              <span class="queue-track-meta">${escapeHtml(formatTrackDuration(track?.duration))}</span>
            </div>
            <div class="queue-track-actions">
              <button type="button" class="btn btn-mini" data-track-action="top" data-position="${escapeHtml(String(position))}"${isFirst ? " disabled" : ""}>Top</button>
              <button type="button" class="btn btn-mini" data-track-action="up" data-position="${escapeHtml(String(position))}"${isFirst ? " disabled" : ""}>↑</button>
              <button type="button" class="btn btn-mini" data-track-action="down" data-position="${escapeHtml(String(position))}"${isLast ? " disabled" : ""}>↓</button>
              <button type="button" class="btn btn-mini btn-danger" data-track-action="remove" data-position="${escapeHtml(String(position))}">Remove</button>
            </div>
          </li>
        `;
      }).join("")}
    </ul>
  `;
}

function getAdminPanelMarkup(adminState) {
  if (!adminState.isAdmin) {
    return "";
  }

  const providerStatus = state.adminProviders;
  const verification = state.adminVerification;
  const events = Array.isArray(state.adminEvents) ? state.adminEvents : [];

  const providerSummary = providerStatus
    ? `SC:${providerStatus?.soundcloud?.ready ? "ready" : "not-ready"} | YT:${providerStatus?.youtube?.ready ? "ready" : "not-ready"} | SP:${providerStatus?.spotify?.ready ? "ready" : "not-ready"}`
    : "not loaded";

  const verificationSummary = verification
    ? `${verification.overallOk ? "ok" : "issues"} (${Number.isFinite(verification.durationMs) ? `${verification.durationMs}ms` : "n/a"})`
    : "not run";

  const eventLines = events.length
    ? events.map((entry) => {
      const head = `[${entry?.time || "unknown"}] [${entry?.level || "info"}] ${entry?.message || ""}`;
      const dataText = entry?.data === undefined ? "" : ` ${toPrettyJson(entry.data)}`;
      return `${head}${dataText}`;
    }).join("\n")
    : "No admin events yet.";

  return `
      <section class="menu-panel${state.activeTab === TAB_ADMIN ? " active" : ""}" data-panel="${TAB_ADMIN}">
        <article class="panel-card">
          <h2>Admin Overrides</h2>
          <p class="muted">These controls apply only to your current web/activity session.</p>
          <label class="toggle-row">
            <input type="checkbox" id="admin-bypass-voice-check"${adminState.bypassVoiceChannelCheck ? " checked" : ""}>
            <span>Bypass voice channel presence check for API controls</span>
          </label>
          <label class="toggle-row">
            <input type="checkbox" id="admin-bypass-guild-access"${adminState.bypassGuildAccess ? " checked" : ""}>
            <span>Allow selecting any guild the bot is in</span>
          </label>
        </article>
        <article class="panel-card">
          <h2>Provider Health</h2>
          <dl>
            <dt>Status</dt><dd>${escapeHtml(providerSummary)}</dd>
            <dt>Verify</dt><dd>${escapeHtml(verificationSummary)}</dd>
          </dl>
          <div class="action-row">
            <button type="button" class="btn" data-admin-action="providers-refresh">Refresh Status</button>
            <button type="button" class="btn" data-admin-action="providers-verify">Verify Cookie/Auth</button>
            <button type="button" class="btn btn-danger" data-admin-action="providers-reinitialize">Reinitialize Providers</button>
          </div>
          <pre class="admin-log-view">${escapeHtml(toPrettyJson(providerStatus || {}))}</pre>
          <pre class="admin-log-view">${escapeHtml(toPrettyJson(verification || {}))}</pre>
        </article>
        <article class="panel-card">
          <h2>Queue Repair</h2>
          <p class="muted">Applies to selected guild: <strong>${escapeHtml(state.selectedGuildId || "none")}</strong></p>
          <div class="action-row">
            <button type="button" class="btn btn-danger" data-admin-action="queue-force-cleanup">Force Cleanup</button>
            <button type="button" class="btn" data-admin-action="queue-refresh-now-playing">Refresh Now Playing Message</button>
          </div>
        </article>
        <article class="panel-card">
          <h2>Admin Event Feed</h2>
          <div class="queue-toolbar">
            <label for="admin-events-level">Level</label>
            <select id="admin-events-level">
              <option value="debug"${state.adminEventsLevel === "debug" ? " selected" : ""}>debug+</option>
              <option value="info"${state.adminEventsLevel === "info" ? " selected" : ""}>info+</option>
              <option value="warn"${state.adminEventsLevel === "warn" ? " selected" : ""}>warn+</option>
              <option value="error"${state.adminEventsLevel === "error" ? " selected" : ""}>error+</option>
            </select>
            <label class="toggle-row-inline">
              <input type="checkbox" id="admin-events-stick-bottom"${state.adminEventsStickToBottom ? " checked" : ""}>
              <span>Stick to bottom</span>
            </label>
            <button type="button" class="btn" data-admin-action="events-refresh">Refresh Events</button>
          </div>
          <pre id="admin-events-view" class="admin-log-view">${escapeHtml(eventLines)}</pre>
        </article>
      </section>
  `;
}

function renderDashboard() {
  const existingAdminEventsView = root.querySelector("#admin-events-view");
  if (existingAdminEventsView) {
    state.adminEventsOffsetFromBottom = existingAdminEventsView.scrollHeight
      - existingAdminEventsView.scrollTop
      - existingAdminEventsView.clientHeight;
  }

  const queue = getCurrentQueueData();
  const queueList = getQueueListData();
  const mode = state.mode || "unknown";
  const adminState = getAdminState();
  if (!adminState.isAdmin && state.activeTab === TAB_ADMIN) {
    state.activeTab = TAB_PLAYER;
  }
  const queueStatusText = queue
    ? `${queue.playerStatus || "idle"} | ${queue.connected ? "connected" : "not connected"} | ${queue.queueLength || 0} queued`
    : "unavailable";
  const activeNowPlaying = queueList?.nowPlaying || queue?.nowPlaying;
  const nowPlayingText = activeNowPlaying
    ? `${activeNowPlaying.title || "Unknown"} (${formatTrackDuration(activeNowPlaying.duration)})`
    : "Nothing currently playing";
  const queueLength = Number.isFinite(queueList?.total)
    ? queueList.total
    : (queue?.queueLength || 0);
  const loopMode = getQueueLoopMode();
  const connectedAtText = state.connectedAt ? formatTime(state.connectedAt) : "unknown";
  const guildCount = Array.isArray(state.authSummary?.guilds) ? state.authSummary.guilds.length : 0;
  const noticeMarkup = state.notice
    ? `<p class="subtitle ${state.noticeError ? "error" : ""}">${escapeHtml(state.notice)}</p>`
    : "";
  const tabSubtitle = adminState.isAdmin
    ? "Use tabs for player, queue, admin, and diagnostics."
    : "Use tabs for player, queue, and diagnostics.";

  const shellClass = state.hasMountedDashboard ? "shell" : "shell shell-animated";
  root.innerHTML = `
    <section class="${shellClass}">
      <div class="top-row">
        <p class="kicker">queueDexBot Activity</p>
        <span class="chip chip-ok">Connected</span>
      </div>
      <h1>queueDexBot Control Panel</h1>
      <p class="subtitle">${escapeHtml(tabSubtitle)}</p>
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
        ${adminState.isAdmin
          ? `<button type="button" class="tab-btn${state.activeTab === TAB_ADMIN ? " active" : ""}" data-tab="${TAB_ADMIN}">Admin</button>`
          : ""}
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
          <p class="muted">Now playing: ${escapeHtml(nowPlayingText)}</p>
          <dl>
            <dt>Loop</dt><dd id="queue-loop">${escapeHtml(loopMode)}</dd>
            <dt>Queue Length</dt><dd>${escapeHtml(String(queueLength))}</dd>
          </dl>
          <div class="queue-toolbar">
            <button type="button" class="btn" data-queue-action="refresh">Refresh Queue</button>
            <button type="button" class="btn" data-queue-action="shuffle">Shuffle</button>
            <button type="button" class="btn btn-danger" data-queue-action="clear">Clear</button>
            <select id="queue-loop-mode">
              <option value="off"${loopMode === "off" ? " selected" : ""}>Loop Off</option>
              <option value="queue"${loopMode === "queue" ? " selected" : ""}>Loop Queue</option>
              <option value="single"${loopMode === "single" ? " selected" : ""}>Loop Single</option>
            </select>
          </div>
          ${getQueueTrackListMarkup()}
        </article>
      </section>
      ${getAdminPanelMarkup(adminState)}
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
          <label class="toggle-row">
            <input type="checkbox" id="debug-show-guild-ids"${state.showGuildIdsInSelector ? " checked" : ""}>
            <span>Show guild IDs in selector labels</span>
          </label>
          <div class="action-row">
            <button type="button" class="btn" id="debug-refresh-guilds">Refresh Guild Memberships</button>
          </div>
        </article>
      </section>
      <p class="footer-note">Local clock: <span id="clock">${escapeHtml(formatTime(new Date()))}</span></p>
    </section>
  `;

  wireDashboardEvents();

  const adminEventsView = root.querySelector("#admin-events-view");
  if (adminEventsView) {
    if (state.adminEventsStickToBottom) {
      adminEventsView.scrollTop = adminEventsView.scrollHeight;
    } else if (Number.isFinite(state.adminEventsOffsetFromBottom)) {
      const nextScrollTop = adminEventsView.scrollHeight
        - adminEventsView.clientHeight
        - state.adminEventsOffsetFromBottom;
      adminEventsView.scrollTop = Math.max(0, nextScrollTop);
    }
  }

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

  root.querySelectorAll("[data-queue-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-queue-action");
      if (!action) {
        return;
      }
      if (action === "refresh") {
        void refreshDashboardData();
        return;
      }
      void sendQueueAction(action);
    });
  });

  const queueLoopModeSelect = root.querySelector("#queue-loop-mode");
  if (queueLoopModeSelect) {
    queueLoopModeSelect.addEventListener("change", () => {
      const mode = String(queueLoopModeSelect.value || "").trim().toLowerCase();
      if (!mode || mode === getQueueLoopMode()) {
        return;
      }
      void sendQueueAction("loop", { mode });
    });
  }

  root.querySelectorAll("[data-track-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-track-action");
      const positionRaw = button.getAttribute("data-position");
      const position = Number.parseInt(String(positionRaw || ""), 10);
      if (!action || !Number.isFinite(position) || position <= 0) {
        return;
      }
      if (action === "top") {
        void sendQueueAction("move_to_front", { position });
        return;
      }
      if (action === "up") {
        if (position <= 1) {
          return;
        }
        void sendQueueAction("move", { from_position: position, to_position: position - 1 });
        return;
      }
      if (action === "down") {
        const total = Number.isFinite(state.queueList?.total) ? state.queueList.total : 0;
        if (total && position >= total) {
          return;
        }
        void sendQueueAction("move", { from_position: position, to_position: position + 1 });
        return;
      }
      if (action === "remove") {
        void sendQueueAction("remove", { position });
      }
    });
  });

  const refreshButton = root.querySelector("#refresh-now");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      void refreshDashboardData();
    });
  }

  const refreshGuildsButton = root.querySelector("#debug-refresh-guilds");
  if (refreshGuildsButton) {
    refreshGuildsButton.addEventListener("click", () => {
      void refreshGuildMemberships();
    });
  }

  const logoutButton = root.querySelector("#logout-web");
  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      void logoutWebSession();
    });
  }

  const bypassVoiceCheckToggle = root.querySelector("#admin-bypass-voice-check");
  if (bypassVoiceCheckToggle) {
    bypassVoiceCheckToggle.addEventListener("change", () => {
      void sendAdminSettings({
        bypass_voice_check: Boolean(bypassVoiceCheckToggle.checked),
      });
    });
  }

  const bypassGuildAccessToggle = root.querySelector("#admin-bypass-guild-access");
  if (bypassGuildAccessToggle) {
    bypassGuildAccessToggle.addEventListener("change", () => {
      void sendAdminSettings({
        bypass_guild_access: Boolean(bypassGuildAccessToggle.checked),
      });
    });
  }

  root.querySelectorAll("[data-admin-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-admin-action");
      if (!action) {
        return;
      }
      if (action === "providers-refresh") {
        void refreshAdminPanelDataAndRender("Admin status refreshed.");
        return;
      }
      if (action === "providers-verify") {
        void sendAdminCommand("/api/activity/admin/providers/verify");
        return;
      }
      if (action === "providers-reinitialize") {
        void sendAdminCommand("/api/activity/admin/providers/reinitialize");
        return;
      }
      if (action === "queue-force-cleanup") {
        void sendAdminGuildCommand("/api/activity/admin/queue/force-cleanup");
        return;
      }
      if (action === "queue-refresh-now-playing") {
        void sendAdminGuildCommand("/api/activity/admin/queue/refresh-now-playing");
        return;
      }
      if (action === "events-refresh") {
        void refreshAdminPanelDataAndRender("Admin events refreshed.");
      }
    });
  });

  const adminEventsLevelSelect = root.querySelector("#admin-events-level");
  if (adminEventsLevelSelect) {
    adminEventsLevelSelect.addEventListener("change", () => {
      const nextLevel = String(adminEventsLevelSelect.value || "").trim().toLowerCase();
      if (!nextLevel || nextLevel === state.adminEventsLevel) {
        return;
      }
      state.adminEventsLevel = nextLevel;
      void refreshAdminPanelDataAndRender();
    });
  }

  const adminEventsStickBottomToggle = root.querySelector("#admin-events-stick-bottom");
  if (adminEventsStickBottomToggle) {
    adminEventsStickBottomToggle.addEventListener("change", () => {
      state.adminEventsStickToBottom = Boolean(adminEventsStickBottomToggle.checked);
      saveBooleanPreference(PREF_ADMIN_EVENTS_STICK_BOTTOM, state.adminEventsStickToBottom);
      renderDashboard();
    });
  }

  const showGuildIdsToggle = root.querySelector("#debug-show-guild-ids");
  if (showGuildIdsToggle) {
    showGuildIdsToggle.addEventListener("change", () => {
      state.showGuildIdsInSelector = Boolean(showGuildIdsToggle.checked);
      saveBooleanPreference(PREF_SHOW_GUILD_IDS, state.showGuildIdsInSelector);
      renderDashboard();
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

  if (state.selectedGuildId && guilds.some((guild) => guild.id === state.selectedGuildId)) {
    return;
  }

  const preferredGuildId = resolveInitialGuildId();
  if (preferredGuildId && guilds.some((guild) => guild.id === preferredGuildId)) {
    state.selectedGuildId = preferredGuildId;
    setGuildQueryParam(state.selectedGuildId);
    return;
  }
  if (guilds.length) {
    state.selectedGuildId = guilds[0].id;
    setGuildQueryParam(state.selectedGuildId);
    return;
  }

  state.selectedGuildId = null;
  setGuildQueryParam(null);
}

async function refreshAdminProvidersStatus() {
  if (!getAdminState().isAdmin) {
    state.adminProviders = null;
    return;
  }
  const payload = await fetchJson("/api/activity/admin/providers/status", {
    credentials: "include",
  });
  state.adminProviders = payload?.providers || null;
}

async function refreshAdminGuildList() {
  const adminState = getAdminState();
  if (!adminState.isAdmin || !adminState.bypassGuildAccess) {
    state.adminBotGuilds = [];
    return;
  }

  const payload = await fetchJson("/api/activity/admin/guilds", {
    credentials: "include",
  });
  const guilds = Array.isArray(payload?.guilds) ? payload.guilds : [];
  state.adminBotGuilds = guilds
    .filter((guild) => guild?.id)
    .map((guild) => ({
      id: String(guild.id),
      name: String(guild.name || guild.id),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function refreshAdminEvents() {
  if (!getAdminState().isAdmin) {
    state.adminEvents = [];
    return;
  }
  const level = encodeURIComponent(state.adminEventsLevel || "info");
  const payload = await fetchJson(`/api/activity/admin/events?level=${level}&limit=${ADMIN_EVENTS_LIMIT}`, {
    credentials: "include",
  });
  state.adminEvents = Array.isArray(payload?.events) ? payload.events : [];
}

async function refreshAdminPanelData() {
  if (!getAdminState().isAdmin) {
    state.adminProviders = null;
    state.adminEvents = [];
    state.adminVerification = null;
    return;
  }
  const refreshResults = await Promise.allSettled([
    refreshAdminProvidersStatus(),
    refreshAdminEvents(),
    refreshAdminGuildList(),
  ]);
  refreshResults.forEach((result) => {
    if (result.status === "rejected") {
      pushDebugEvent("admin.refresh.failed", result.reason?.message || String(result.reason));
    }
  });
}

async function refreshAdminPanelDataAndRender(successNotice = "") {
  try {
    await refreshAdminPanelData();
    if (successNotice) {
      state.notice = successNotice;
      state.noticeError = false;
    }
  } catch (error) {
    state.notice = `Admin refresh failed: ${error?.message || String(error)}`;
    state.noticeError = true;
  }
  renderDashboard();
}

async function refreshGuildMemberships() {
  pushDebugEvent("guilds.refresh.start");
  try {
    await fetchJson("/auth/refresh-guilds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({}),
    });

    state.notice = "Guild membership list refreshed.";
    state.noticeError = false;
    pushDebugEvent("guilds.refresh.success");
    await refreshDashboardData();
  } catch (error) {
    state.notice = `Guild refresh failed: ${error?.message || String(error)}`;
    state.noticeError = true;
    pushDebugEvent("guilds.refresh.failed", state.notice);
    renderDashboard();
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
  await refreshAdminPanelData();
  updateSelectedGuildFromAuth();

  await refreshQueueDataForSelectedGuild();

  renderDashboard();
}

async function refreshQueueDataForSelectedGuild() {
  if (!state.selectedGuildId) {
    state.queueSummary = null;
    state.queueList = null;
    return;
  }

  const encodedGuildId = encodeURIComponent(state.selectedGuildId);
  const [queueSummary, queueList] = await Promise.all([
    fetchJson(`/api/activity/state?guild_id=${encodedGuildId}`, {
      credentials: "include",
    }),
    fetchJson(`/api/activity/queue?guild_id=${encodedGuildId}&offset=0&limit=${QUEUE_LIST_LIMIT}`, {
      credentials: "include",
    }),
  ]);
  state.queueSummary = queueSummary;
  state.queueList = queueList;
}

async function refreshQueueListForSelectedGuild() {
  if (!state.selectedGuildId) {
    state.queueList = null;
    return;
  }
  const encodedGuildId = encodeURIComponent(state.selectedGuildId);
  state.queueList = await fetchJson(`/api/activity/queue?guild_id=${encodedGuildId}&offset=0&limit=${QUEUE_LIST_LIMIT}`, {
    credentials: "include",
  });
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
    await refreshQueueListForSelectedGuild();
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

async function sendQueueAction(action, actionOptions = {}) {
  if (!state.selectedGuildId) {
    state.notice = "Select a guild first.";
    state.noticeError = true;
    renderDashboard();
    return;
  }
  pushDebugEvent("queue.action.start", `${action} guild=${state.selectedGuildId}`);
  try {
    const payload = await fetchJson("/api/activity/queue/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        action,
        guild_id: state.selectedGuildId,
        ...actionOptions,
      }),
    });
    state.queueSummary = {
      guildId: payload.guildId,
      data: payload.data || null,
    };
    await refreshQueueListForSelectedGuild();
    state.notice = `Queue action applied: ${action}`;
    state.noticeError = false;
    pushDebugEvent("queue.action.success", action);
    renderDashboard();
  } catch (error) {
    state.notice = `Queue action failed (${action}): ${error?.message || String(error)}`;
    state.noticeError = true;
    pushDebugEvent("queue.action.failed", state.notice);
    renderDashboard();
  }
}

async function sendAdminCommand(path, body = {}) {
  const adminState = getAdminState();
  if (!adminState.isAdmin) {
    state.notice = "Admin access is required for this action.";
    state.noticeError = true;
    renderDashboard();
    return null;
  }

  pushDebugEvent("admin.command.start", path);
  try {
    const payload = await fetchJson(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(body || {}),
    });

    if (path === "/api/activity/admin/providers/verify" && payload?.verification) {
      state.adminVerification = payload.verification;
    }
    if (path === "/api/activity/admin/providers/reinitialize") {
      state.adminVerification = null;
    }

    await refreshAdminPanelData();
    state.notice = "Admin command applied.";
    state.noticeError = false;
    pushDebugEvent("admin.command.success", path);
    renderDashboard();
    return payload;
  } catch (error) {
    state.notice = `Admin command failed: ${error?.message || String(error)}`;
    state.noticeError = true;
    pushDebugEvent("admin.command.failed", state.notice);
    renderDashboard();
    return null;
  }
}

async function sendAdminGuildCommand(path) {
  if (!state.selectedGuildId) {
    state.notice = "Select a guild first.";
    state.noticeError = true;
    renderDashboard();
    return;
  }

  const payload = await sendAdminCommand(path, {
    guild_id: state.selectedGuildId,
  });
  if (!payload) {
    return;
  }

  if (path === "/api/activity/admin/queue/force-cleanup" && payload?.data) {
    state.queueSummary = {
      guildId: payload.guildId || state.selectedGuildId,
      data: payload.data,
    };
    await refreshQueueListForSelectedGuild();
    renderDashboard();
    return;
  }

  if (path === "/api/activity/admin/queue/refresh-now-playing") {
    await refreshQueueDataForSelectedGuild();
    renderDashboard();
  }
}

async function sendAdminSettings(settings) {
  const adminState = getAdminState();
  if (!adminState.isAdmin) {
    state.notice = "Admin access is required for this action.";
    state.noticeError = true;
    renderDashboard();
    return;
  }
  pushDebugEvent("admin.settings.start");
  try {
    const payload = await fetchJson("/api/activity/admin/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(settings || {}),
    });
    state.authSummary = {
      ...(state.authSummary || {}),
      admin: {
        ...(state.authSummary?.admin || {}),
        ...(payload?.admin || {}),
      },
    };
    await refreshAdminPanelData();
    updateSelectedGuildFromAuth();
    await refreshQueueDataForSelectedGuild();
    const bypassEnabled = Boolean(payload?.admin?.bypassVoiceChannelCheck);
    const guildBypassEnabled = Boolean(payload?.admin?.bypassGuildAccess);
    state.notice = `Admin settings updated: voice bypass ${bypassEnabled ? "enabled" : "disabled"}, all-guild access ${guildBypassEnabled ? "enabled" : "disabled"}.`;
    state.noticeError = false;
    pushDebugEvent("admin.settings.success", `voiceBypass=${bypassEnabled}; guildBypass=${guildBypassEnabled}`);
    renderDashboard();
  } catch (error) {
    state.notice = `Admin setting update failed: ${error?.message || String(error)}`;
    state.noticeError = true;
    pushDebugEvent("admin.settings.failed", state.notice);
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
  state.queueList = null;
  state.adminProviders = null;
  state.adminEvents = [];
  state.adminBotGuilds = [];
  state.adminVerification = null;
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
