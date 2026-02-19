import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./style.css";

const root = document.getElementById("app");
const SDK_READY_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(import.meta.env.VITE_DISCORD_SDK_READY_TIMEOUT_MS || "1000"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
})();
const UPTIME_INTERVAL_MS = 1000;
const API_POLL_INTERVAL_MS = 5000;
const API_PENDING_TIMEOUT_MS = 9000;
const API_DISCONNECTED_TIMEOUT_MS = 20000;
const DEBUG_TAB_VISIBILITY_TIMEOUT_MS = 30000;
const PIP_MAX_WIDTH_PX = 420;
const PIP_MAX_HEIGHT_PX = 260;
const QUEUE_LIST_LIMIT = 200;
const ADMIN_EVENTS_LIMIT = 120;
const PREF_SHOW_GUILD_IDS = "qdex_show_guild_ids";
const PREF_ADMIN_EVENTS_STICK_BOTTOM = "qdex_admin_events_stick_bottom";
const DEFAULT_EMBEDDED_OAUTH_SCOPES = "identify";
const DEFAULT_WEB_OAUTH_SCOPES = "identify guilds";
const BUILD_ID = typeof __QDEX_ACTIVITY_BUILD__ !== "undefined" ? __QDEX_ACTIVITY_BUILD__ : "dev-unknown";

const TAB_PLAYER = "player";
const TAB_UP_NEXT = "up_next";
const TAB_QUEUE = "queue";
const TAB_DEBUG = "debug";
const TAB_ADMIN = "admin";
const THEME_DARK = "dark";
const THEME_LIGHT = "light";
const CONNECTION_STATUS_DISCONNECTED = "disconnected";
const CONNECTION_STATUS_AUTHORIZING = "authorizing";
const CONNECTION_STATUS_PENDING = "pending";
const CONNECTION_STATUS_CONNECTED = "connected";
const CONNECTION_STATUS_API_ONLY = "api_only";

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
  activeTab: TAB_UP_NEXT,
  selectedGuildId: null,
  authSummary: null,
  queueSummary: null,
  queueList: null,
  adminProviders: null,
  adminGatewayStatus: null,
  adminEvents: [],
  adminEventsLevel: "info",
  adminBotGuilds: [],
  adminVerification: null,
  adminEventsStickToBottom: loadBooleanPreference(PREF_ADMIN_EVENTS_STICK_BOTTOM, true),
  adminEventsOffsetFromBottom: null,
  showGuildIdsInSelector: loadBooleanPreference(PREF_SHOW_GUILD_IDS, false),
  themeMode: THEME_DARK,
  debugTabVisible: false,
  connectionStatus: CONNECTION_STATUS_DISCONNECTED,
  discordSdkConnected: false,
  lastApiAttemptAt: null,
  lastApiSuccessAt: null,
  consecutiveApiFailures: 0,
  notice: "",
  noticeError: false,
  hasMountedDashboard: false,
  queueDrag: {
    active: false,
    pending: false,
    fromPosition: null,
    targetInsertBefore: null,
  },
};

let liveTicker = null;
let statePoller = null;
let debugTabHideTimer = null;
let viewportWatcherBound = false;
const debugEvents = [];
const failedThumbnailUrls = new Set();
const MAX_FAILED_THUMBNAILS = 600;
const thumbnailDataUrlCache = new Map();
const thumbnailDataUrlInFlight = new Map();
const MAX_THUMBNAIL_DATA_URL_CACHE = 220;

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

function setPipBodyMode(enabled) {
  if (!document?.body?.classList) {
    return;
  }
  document.body.classList.toggle("pip-active", Boolean(enabled));
}

function setThemeBodyMode(mode) {
  if (!document?.body?.classList) {
    return;
  }
  const nextMode = mode === THEME_LIGHT ? THEME_LIGHT : THEME_DARK;
  document.body.classList.toggle("theme-dark", nextMode === THEME_DARK);
  document.body.classList.toggle("theme-light", nextMode === THEME_LIGHT);
}

function applyThemeMode(mode) {
  state.themeMode = mode === THEME_LIGHT ? THEME_LIGHT : THEME_DARK;
  setThemeBodyMode(state.themeMode);
}

function isPipViewport() {
  const width = Math.max(0, Number(window.innerWidth) || 0);
  const height = Math.max(0, Number(window.innerHeight) || 0);
  return width <= PIP_MAX_WIDTH_PX && height <= PIP_MAX_HEIGHT_PX;
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

function formatProgressTimestamp(seconds) {
  const total = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
  if (!/^https?:\/\//i.test(normalized)) {
    return null;
  }
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

function getYoutubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
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
      const parts = parsed.pathname.split("/").filter(Boolean);
      if ((parts[0] === "shorts" || parts[0] === "embed") && /^[a-zA-Z0-9_-]{11}$/.test(parts[1] || "")) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function getTrackLinkUrl(track) {
  if (!track || typeof track !== "object") {
    return null;
  }
  return normalizeHttpUrl(track.displayUrl) || normalizeHttpUrl(track.url);
}

function getTrackArtistText(track) {
  if (!track || typeof track !== "object") {
    return null;
  }
  const artist = String(track.artist || track.channel || "").trim();
  if (artist) {
    return artist;
  }
  return null;
}

function getTrackThumbnailUrl(track) {
  if (!track || typeof track !== "object") {
    return null;
  }
  const directThumbnail = normalizeHttpUrl(track.thumbnailUrl || track.thumbnail || track.artworkUrl || track.artwork_url);
  if (directThumbnail && !failedThumbnailUrls.has(directThumbnail)) {
    return directThumbnail;
  }
  const source = String(track.source || "").toLowerCase();
  const youtubeId = getYoutubeVideoId(track.url) || getYoutubeVideoId(track.displayUrl);
  if (youtubeId && source.includes("youtube")) {
    const youtubeThumbnail = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
    if (!failedThumbnailUrls.has(youtubeThumbnail)) {
      return youtubeThumbnail;
    }
  }
  return null;
}

function getTrackSummaryMarkup(track, options = {}) {
  if (!track) {
    return `<p class="muted track-summary-empty">Nothing currently playing.</p>`;
  }

  const compact = Boolean(options.compact);
  const pip = Boolean(options.pip);
  const includeDuration = options.includeDuration !== false;
  const linkUrl = getTrackLinkUrl(track);
  const thumbnailUrl = getTrackThumbnailUrl(track);
  const title = String(track?.title || "Unknown");
  const artist = getTrackArtistText(track);

  const metaBits = [];
  if (includeDuration) {
    metaBits.push(formatTrackDuration(track?.duration));
  }
  if (track?.pendingResolve) {
    metaBits.push("resolving");
  }
  const metaText = metaBits.filter(Boolean).join(" • ");

  const titleMarkup = linkUrl
    ? `<a class="track-summary-title-link" href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
    : `<span class="track-summary-title-text">${escapeHtml(title)}</span>`;

  const thumbInner = thumbnailUrl
    ? `<img class="track-summary-thumb-image" data-thumb-src="${escapeHtml(thumbnailUrl)}" alt="">`
    : `<span class="track-summary-thumb-placeholder" aria-hidden="true"></span>`;

  const thumbMarkup = linkUrl
    ? `<a class="track-summary-thumb-link" href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener noreferrer">${thumbInner}</a>`
    : `<span class="track-summary-thumb-link track-summary-thumb-static">${thumbInner}</span>`;

  const className = [
    "track-summary",
    compact ? "track-summary-compact" : "",
    pip ? "track-summary-pip" : "",
  ].filter(Boolean).join(" ");

  return `
    <div class="${className}">
      ${thumbMarkup}
      <div class="track-summary-body">
        <div class="track-summary-title">${titleMarkup}</div>
        ${artist ? `<p class="track-summary-artist">${escapeHtml(artist)}</p>` : ""}
        ${metaText ? `<p class="track-summary-meta">${escapeHtml(metaText)}</p>` : ""}
      </div>
    </div>
  `;
}

function rememberFailedThumbnailUrl(url) {
  if (!url) {
    return;
  }
  if (failedThumbnailUrls.size >= MAX_FAILED_THUMBNAILS) {
    const oldest = failedThumbnailUrls.values().next().value;
    if (oldest) {
      failedThumbnailUrls.delete(oldest);
    }
  }
  failedThumbnailUrls.add(url);
}

function rememberThumbnailDataUrl(url, dataUrl) {
  if (!url || !dataUrl) {
    return;
  }
  if (thumbnailDataUrlCache.size >= MAX_THUMBNAIL_DATA_URL_CACHE) {
    const oldest = thumbnailDataUrlCache.keys().next().value;
    if (oldest) {
      thumbnailDataUrlCache.delete(oldest);
    }
  }
  thumbnailDataUrlCache.set(url, dataUrl);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        reject(new Error("Failed converting thumbnail blob to data URL"));
        return;
      }
      resolve(dataUrl);
    };
    reader.onerror = () => {
      reject(new Error("Failed reading thumbnail blob"));
    };
    reader.readAsDataURL(blob);
  });
}

async function fetchThumbnailDataUrlViaProxy(sourceUrl) {
  const cached = thumbnailDataUrlCache.get(sourceUrl);
  if (cached) {
    return cached;
  }

  const inFlight = thumbnailDataUrlInFlight.get(sourceUrl);
  if (inFlight) {
    return inFlight;
  }

  const proxyPath = `/api/activity/thumbnail?src=${encodeURIComponent(sourceUrl)}`;
  const requestTask = (async () => {
    const response = await fetch(getApiUrl(proxyPath), {
      credentials: "include",
    });
    if (!response.ok) {
      const proxyError = new Error(`Thumbnail proxy request failed (${response.status})`);
      proxyError.status = response.status;
      throw proxyError;
    }
    const blob = await response.blob();
    if (!String(blob?.type || "").toLowerCase().startsWith("image/")) {
      throw new Error("Thumbnail proxy returned non-image content");
    }
    const dataUrl = await blobToDataUrl(blob);
    rememberThumbnailDataUrl(sourceUrl, dataUrl);
    return dataUrl;
  })();

  thumbnailDataUrlInFlight.set(sourceUrl, requestTask);
  requestTask.finally(() => {
    thumbnailDataUrlInFlight.delete(sourceUrl);
  });
  return requestTask;
}

function replaceThumbnailWithPlaceholder(imageNode) {
  if (!imageNode?.parentNode || !document?.createElement) {
    return;
  }
  const placeholder = document.createElement("span");
  placeholder.className = "track-summary-thumb-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  imageNode.replaceWith(placeholder);
}

function hydrateTrackThumbnails() {
  const embeddedMode = state.mode === "embedded";
  root.querySelectorAll("img.track-summary-thumb-image[data-thumb-src]").forEach((image) => {
    if (image.dataset.thumbReady === "1") {
      return;
    }
    image.dataset.thumbReady = "1";
    const thumbSrc = normalizeHttpUrl(image.getAttribute("data-thumb-src"));
    if (!thumbSrc || failedThumbnailUrls.has(thumbSrc)) {
      replaceThumbnailWithPlaceholder(image);
      return;
    }

    if (embeddedMode) {
      void fetchThumbnailDataUrlViaProxy(thumbSrc)
        .then((dataUrl) => {
          if (!image.isConnected) {
            return;
          }
          image.setAttribute("src", dataUrl);
        })
        .catch((error) => {
          if (error?.status !== 401) {
            rememberFailedThumbnailUrl(thumbSrc);
          }
          if (image.isConnected) {
            replaceThumbnailWithPlaceholder(image);
          }
        });
      return;
    }

    image.addEventListener("error", () => {
      rememberFailedThumbnailUrl(thumbSrc);
      replaceThumbnailWithPlaceholder(image);
    }, { once: true });
    image.setAttribute("src", thumbSrc);
  });
}

function setConnectionStatus(nextStatus) {
  state.connectionStatus = nextStatus;
}

function markApiAttempt() {
  state.lastApiAttemptAt = new Date();
}

function markApiSuccess() {
  state.lastApiSuccessAt = new Date();
  state.consecutiveApiFailures = 0;
  updateConnectionStatusFromTelemetry();
}

function markApiFailure() {
  state.consecutiveApiFailures += 1;
  updateConnectionStatusFromTelemetry();
}

function updateConnectionStatusFromTelemetry() {
  if (state.connectionStatus === CONNECTION_STATUS_AUTHORIZING && !state.lastApiSuccessAt) {
    return;
  }

  if (!state.lastApiSuccessAt) {
    setConnectionStatus(CONNECTION_STATUS_DISCONNECTED);
    return;
  }

  const ageMs = Date.now() - state.lastApiSuccessAt.getTime();
  if (ageMs >= API_DISCONNECTED_TIMEOUT_MS) {
    setConnectionStatus(CONNECTION_STATUS_DISCONNECTED);
    return;
  }

  if (state.consecutiveApiFailures > 0 || ageMs >= API_PENDING_TIMEOUT_MS) {
    setConnectionStatus(CONNECTION_STATUS_PENDING);
    return;
  }

  setConnectionStatus(CONNECTION_STATUS_CONNECTED);
}

function getConnectionStatusPresentation() {
  updateConnectionStatusFromTelemetry();
  const sdkUnavailableInEmbedded = state.mode === "embedded" && !state.discordSdkConnected;
  const sdkUnavailableHint = "Discord SDK is not connected for this Activity session.";
  if (state.connectionStatus === CONNECTION_STATUS_AUTHORIZING) {
    return {
      statusKey: CONNECTION_STATUS_AUTHORIZING,
      label: "Authorizing",
      chipClass: "chip-authorizing",
      hint: "Authorizing session.",
    };
  }
  if (state.connectionStatus === CONNECTION_STATUS_PENDING) {
    return {
      statusKey: CONNECTION_STATUS_PENDING,
      label: "Pending",
      chipClass: "chip-pending",
      hint: sdkUnavailableInEmbedded
        ? `API heartbeat is delayed. ${sdkUnavailableHint}`
        : "API heartbeat is delayed.",
    };
  }
  if (state.connectionStatus === CONNECTION_STATUS_DISCONNECTED) {
    return {
      statusKey: CONNECTION_STATUS_DISCONNECTED,
      label: "Disconnected",
      chipClass: "chip-disconnected",
      hint: sdkUnavailableInEmbedded
        ? `API heartbeat timed out. ${sdkUnavailableHint}`
        : "API heartbeat timed out.",
    };
  }
  if (sdkUnavailableInEmbedded) {
    return {
      statusKey: CONNECTION_STATUS_API_ONLY,
      label: "API Only",
      chipClass: "chip-api-only",
      hint: "Connected to API, but not connected to Discord SDK in this Activity session.",
    };
  }
  return {
    statusKey: CONNECTION_STATUS_CONNECTED,
    label: "Connected",
    chipClass: "chip-ok",
    hint: "Connected to API.",
  };
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

function stopDebugTabHideTimer() {
  if (debugTabHideTimer) {
    clearTimeout(debugTabHideTimer);
    debugTabHideTimer = null;
  }
}

function hideDebugTab() {
  stopDebugTabHideTimer();
  state.debugTabVisible = false;
  if (state.activeTab === TAB_DEBUG) {
    state.activeTab = TAB_UP_NEXT;
  }
}

function scheduleDebugTabAutoHide() {
  stopDebugTabHideTimer();
  debugTabHideTimer = setTimeout(() => {
    if (!state.debugTabVisible) {
      return;
    }
    hideDebugTab();
    renderDashboard();
  }, DEBUG_TAB_VISIBILITY_TIMEOUT_MS);
}

function showDebugTabAndOpen() {
  state.debugTabVisible = true;
  state.activeTab = TAB_DEBUG;
  scheduleDebugTabAutoHide();
  renderDashboard();
}

function ensureViewportWatcher() {
  if (viewportWatcherBound) {
    return;
  }
  viewportWatcherBound = true;
  let pendingRaf = null;
  window.addEventListener("resize", () => {
    if (pendingRaf) {
      cancelAnimationFrame(pendingRaf);
    }
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      if (!state.mode || state.mode === "unknown") {
        return;
      }
      renderDashboard();
    });
  });
}

function renderStatus({ title, subtitle, rows = [], error = false, includeTrace = false }) {
  setThemeBodyMode(state.themeMode);
  setPipBodyMode(false);
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
  setThemeBodyMode(state.themeMode);
  setPipBodyMode(false);
  state.mode = "web";
  state.discordSdkConnected = false;
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
    return `<span class="guild-compact-readonly">${escapeHtml(getGuildLabel(matched, { includeId: state.showGuildIdsInSelector }))}</span>`;
  }

  if (!guildOptions.length) {
    return `<span class="guild-compact-readonly">${escapeHtml(selectedGuildId)}</span>`;
  }

  const optionMarkup = guildOptions
    .map((guild) => `<option value="${escapeHtml(guild.id)}"${guild.id === selectedGuildId ? " selected" : ""}>${escapeHtml(getGuildLabel(guild, { includeId: state.showGuildIdsInSelector }))}</option>`)
    .join("");
  return `<select id="guild-select" class="guild-compact-select" aria-label="Guild">${optionMarkup}</select>`;
}

function getQueueListData() {
  return state.queueList;
}

function parseQueuePosition(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function getQueueTotalCount() {
  const queueList = getQueueListData();
  const tracks = Array.isArray(queueList?.tracks) ? queueList.tracks : [];
  return Number.isFinite(queueList?.total) ? queueList.total : tracks.length;
}

function getQueueDropSlotMarkup(insertBeforePosition, options = {}) {
  const position = parseQueuePosition(insertBeforePosition) || 1;
  const disabled = Boolean(options.disabled);
  return `
    <li class="queue-drop-slot${disabled ? " queue-drop-slot-disabled" : ""}" data-queue-drop-slot="1" data-insert-before="${escapeHtml(String(position))}"${disabled ? ' data-disabled="1"' : ""}>
      <span class="queue-drop-slot-line" aria-hidden="true"></span>
    </li>
  `;
}

function clearQueueDragDomState() {
  root.querySelector(".queue-track-list")?.classList.remove("queue-track-list-dragging");
  root.querySelectorAll(".queue-drop-slot.active").forEach((slot) => slot.classList.remove("active"));
  root.querySelectorAll(".queue-track-row-dragging").forEach((row) => row.classList.remove("queue-track-row-dragging"));
}

function clearQueueDragState() {
  state.queueDrag.active = false;
  state.queueDrag.pending = false;
  state.queueDrag.fromPosition = null;
  state.queueDrag.targetInsertBefore = null;
  clearQueueDragDomState();
}

function setQueueDragTarget(insertBeforePosition) {
  const normalized = parseQueuePosition(insertBeforePosition);
  state.queueDrag.targetInsertBefore = normalized;
  root.querySelectorAll("[data-queue-drop-slot]").forEach((slot) => {
    const slotTarget = parseQueuePosition(slot.getAttribute("data-insert-before"));
    slot.classList.toggle("active", Boolean(normalized) && slotTarget === normalized);
  });
}

function getRowDropInsertBeforePosition(row, clientY) {
  const position = parseQueuePosition(row?.getAttribute?.("data-position"));
  if (!position) {
    return null;
  }
  const rect = row.getBoundingClientRect();
  const midpoint = rect.top + (rect.height / 2);
  const y = Number.isFinite(clientY) ? clientY : midpoint;
  return y < midpoint ? position : position + 1;
}

function beginQueueDrag(position, sourceRow, dataTransfer) {
  const normalizedPosition = parseQueuePosition(position);
  const total = getQueueTotalCount();
  if (!normalizedPosition || total < 2 || normalizedPosition > total || state.queueDrag.pending) {
    return false;
  }

  state.queueDrag.active = true;
  state.queueDrag.pending = false;
  state.queueDrag.fromPosition = normalizedPosition;
  state.queueDrag.targetInsertBefore = null;
  clearQueueDragDomState();

  root.querySelector(".queue-track-list")?.classList.add("queue-track-list-dragging");
  sourceRow?.classList.add("queue-track-row-dragging");

  if (dataTransfer) {
    dataTransfer.effectAllowed = "move";
    dataTransfer.setData("text/plain", String(normalizedPosition));
  }
  return true;
}

async function submitQueueDragMove(insertBeforePosition) {
  const total = getQueueTotalCount();
  const fromPosition = parseQueuePosition(state.queueDrag.fromPosition);
  if (!fromPosition || total < 2 || fromPosition > total) {
    clearQueueDragState();
    return;
  }

  const normalizedInsertBefore = parseQueuePosition(insertBeforePosition);
  const boundedInsertBefore = normalizedInsertBefore
    ? Math.max(1, Math.min(normalizedInsertBefore, total + 1))
    : fromPosition;

  let toPosition = boundedInsertBefore;
  if (boundedInsertBefore > fromPosition) {
    toPosition -= 1;
  }
  toPosition = Math.max(1, Math.min(total, toPosition));

  state.queueDrag.active = false;
  clearQueueDragDomState();
  if (toPosition === fromPosition) {
    clearQueueDragState();
    return;
  }

  state.queueDrag.pending = true;
  try {
    await sendQueueAction("move", {
      from_position: fromPosition,
      to_position: toPosition,
    });
  } finally {
    clearQueueDragState();
  }
}

function getQueueLoopMode() {
  const queue = getCurrentQueueData();
  const queueList = getQueueListData();
  return queueList?.loopMode || queue?.loopMode || "off";
}

function getQueueStatusText(queue, queueList) {
  if (!queue) {
    return "unavailable";
  }
  const queueLength = Number.isFinite(queueList?.total)
    ? queueList.total
    : (queue.queueLength || 0);
  return `${queue.playerStatus || "idle"} | ${queue.connected ? "connected" : "not connected"} | ${queueLength} queued`;
}

function getQueueUpdatedAtText(queue) {
  if (!Number.isFinite(queue?.updatedAt)) {
    return "unknown";
  }
  return formatTime(queue.updatedAt);
}

function getPlaybackProgressSnapshot() {
  const queue = getCurrentQueueData();
  const queueList = getQueueListData();
  const progress = queue?.playbackProgress || queueList?.playbackProgress || null;
  if (!progress) {
    return null;
  }

  const durationSec = Number.isFinite(progress.durationSec) && progress.durationSec > 0
    ? Math.floor(progress.durationSec)
    : null;
  let elapsedSec = Number.isFinite(progress.elapsedSec) && progress.elapsedSec >= 0
    ? Math.floor(progress.elapsedSec)
    : 0;

  const playerStatus = String(queue?.playerStatus || "").toLowerCase();
  const isPlaying = playerStatus === "playing";
  const updatedAtMs = Number.isFinite(queue?.updatedAt) ? queue.updatedAt : Date.now();
  if (isPlaying) {
    const driftSec = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
    elapsedSec += driftSec;
  }

  if (durationSec) {
    elapsedSec = Math.max(0, Math.min(elapsedSec, durationSec));
  } else {
    elapsedSec = Math.max(0, elapsedSec);
  }

  const ratio = durationSec ? Math.max(0, Math.min(1, elapsedSec / durationSec)) : 0;
  return {
    elapsedSec,
    durationSec,
    ratio,
    hasDuration: Boolean(durationSec),
    isPlaying,
  };
}

function getPlaybackProgressMarkup(options = {}) {
  const pip = Boolean(options?.pip);
  const progress = getPlaybackProgressSnapshot();
  if (!progress) {
    return `<p class="muted playback-progress-empty">Progress unavailable.</p>`;
  }

  const max = progress.hasDuration ? progress.durationSec : 1;
  const value = progress.hasDuration ? progress.elapsedSec : 0;
  const leftLabel = formatProgressTimestamp(progress.elapsedSec);
  const rightLabel = progress.hasDuration ? formatProgressTimestamp(progress.durationSec) : "unknown";
  const percent = progress.hasDuration ? Math.max(0, Math.min(100, Math.round(progress.ratio * 100))) : 0;

  if (pip) {
    return `
      <div class="playback-progress-wrap playback-progress-wrap-pip">
        <label class="playback-progress-label" for="playback-progress-time">Progress</label>
        <div class="progress-bar-static" aria-hidden="true">
          <span id="playback-progress-fill" class="progress-bar-fill" style="width:${escapeHtml(String(percent))}%"></span>
        </div>
        <div class="playback-progress-time" id="playback-progress-time">${escapeHtml(`${leftLabel} / ${rightLabel}`)}</div>
      </div>
    `;
  }

  return `
    <div class="playback-progress-wrap">
      <label class="playback-progress-label" for="playback-progress-slider">Progress</label>
      <input
        id="playback-progress-slider"
        class="playback-progress-slider"
        type="range"
        min="0"
        max="${escapeHtml(String(max))}"
        value="${escapeHtml(String(value))}"
        disabled
      >
      <div class="playback-progress-time" id="playback-progress-time">${escapeHtml(`${leftLabel} / ${rightLabel}`)}</div>
    </div>
  `;
}

function getPlaybackReadyStateMarkup(options = {}) {
  const pip = Boolean(options?.pip);
  return `
    <div class="playback-ready-state${pip ? " playback-ready-state-pip" : ""}">
      <p class="playback-ready-title">Ready</p>
      <p class="playback-ready-subtitle">Queue tracks to start playback.</p>
    </div>
  `;
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
  const canReorder = total > 1;

  return `
    ${truncatedNotice}
    <ul class="queue-track-list">
      ${tracks.map((track, index) => {
        const position = Number.isFinite(track?.position) ? track.position : index + 1;
        const isFirst = position <= 1;
        const isLast = position >= total;
        return `
          ${getQueueDropSlotMarkup(position, { disabled: !canReorder })}
          <li class="queue-track-row" data-queue-track-row="1" data-position="${escapeHtml(String(position))}">
            <button
              type="button"
              class="queue-drag-handle"
              data-track-drag-handle="1"
              data-position="${escapeHtml(String(position))}"
              draggable="${canReorder ? "true" : "false"}"
              aria-label="Drag to move track at position ${escapeHtml(String(position))}"
              title="Drag to move track"${canReorder ? "" : " disabled"}
            >
              <span class="queue-drag-grip" aria-hidden="true"></span>
            </button>
            <div class="queue-track-main">
              <span class="queue-track-pos">#${escapeHtml(String(position))}</span>
              ${getTrackSummaryMarkup(track, { compact: true, includeDuration: true })}
            </div>
            <div class="queue-track-actions">
              <button type="button" class="btn btn-mini" data-track-action="top" data-position="${escapeHtml(String(position))}"${isFirst ? " disabled" : ""}>Top</button>
              <button type="button" class="btn btn-mini" data-track-action="up" data-position="${escapeHtml(String(position))}"${isFirst ? " disabled" : ""}>↑</button>
              <button type="button" class="btn btn-mini" data-track-action="down" data-position="${escapeHtml(String(position))}"${isLast ? " disabled" : ""}>↓</button>
              <button type="button" class="btn btn-mini btn-danger" data-track-action="remove" data-position="${escapeHtml(String(position))}">Remove</button>
            </div>
          </li>${index === tracks.length - 1 ? getQueueDropSlotMarkup(position + 1, { disabled: !canReorder }) : ""}
        `;
      }).join("")}
    </ul>
  `;
}

function getUpNextTrackListMarkup() {
  const queueList = getQueueListData();
  const tracks = Array.isArray(queueList?.tracks) ? queueList.tracks : [];
  const total = Number.isFinite(queueList?.total) ? queueList.total : tracks.length;
  if (!tracks.length) {
    return "";
  }

  const hiddenCount = Math.max(0, total - tracks.length);
  return `
    <ul class="up-next-track-list">
      ${tracks.map((track, index) => {
        const position = Number.isFinite(track?.position) ? track.position : index + 1;
        return `
          <li class="up-next-track-row">
            <span class="up-next-track-pos">#${escapeHtml(String(position))}</span>
            ${getTrackSummaryMarkup(track, { compact: true, includeDuration: true })}
          </li>
        `;
      }).join("")}
    </ul>
    ${hiddenCount > 0
    ? `<p class="muted up-next-more">+${escapeHtml(String(hiddenCount))} more queued</p>`
    : ""}
  `;
}

function getAdminPanelMarkup(adminState) {
  if (!adminState.isAdmin) {
    return "";
  }

  const providerStatus = state.adminProviders;
  const gatewayStatus = state.adminGatewayStatus;
  const verification = state.adminVerification;
  const events = Array.isArray(state.adminEvents) ? state.adminEvents : [];

  const providerSummary = providerStatus
    ? `SC:${providerStatus?.soundcloud?.ready ? "ready" : "not-ready"} | YT:${providerStatus?.youtube?.ready ? "ready" : "not-ready"} | SP:${providerStatus?.spotify?.ready ? "ready" : "not-ready"}`
    : "not loaded";

  const verificationSummary = verification
    ? `${verification.overallOk ? "ok" : "issues"} (${Number.isFinite(verification.durationMs) ? `${verification.durationMs}ms` : "n/a"})`
    : "not run";

  const gatewaySummary = gatewayStatus
    ? [
      gatewayStatus.enabled ? "watchdog enabled" : "watchdog disabled",
      gatewayStatus.invalidated ? "session invalidated" : "session valid",
      gatewayStatus.reloginInFlight ? "relogin in flight" : "idle",
      `${Number.isFinite(gatewayStatus.disconnectedShardCount) ? gatewayStatus.disconnectedShardCount : 0} disconnected shard(s)`,
    ].join(" | ")
    : "not loaded";
  const gatewayDisconnectedShards = Array.isArray(gatewayStatus?.disconnectedShardIds) && gatewayStatus.disconnectedShardIds.length
    ? gatewayStatus.disconnectedShardIds.join(", ")
    : "none";
  const gatewayNextReloginAt = Number.isFinite(gatewayStatus?.nextReloginAt) && gatewayStatus.nextReloginAt > 0
    ? new Date(gatewayStatus.nextReloginAt).toISOString()
    : "n/a";

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
          <h2>Discord Gateway</h2>
          <p class="muted">Gateway lifecycle and reconnect watchdog diagnostics for this bot process.</p>
          <dl>
            <dt>Status</dt><dd>${escapeHtml(gatewaySummary)}</dd>
            <dt>Relogin Attempts</dt><dd>${escapeHtml(String(Number.isFinite(gatewayStatus?.reloginAttempts) ? gatewayStatus.reloginAttempts : 0))}</dd>
            <dt>Next Retry</dt><dd>${escapeHtml(gatewayNextReloginAt)}</dd>
            <dt>Disconnected Shards</dt><dd>${escapeHtml(gatewayDisconnectedShards)}</dd>
          </dl>
          <div class="action-row">
            <button type="button" class="btn" data-admin-action="gateway-refresh">Refresh Gateway</button>
            <button type="button" class="btn btn-danger" data-admin-action="gateway-relogin">Force Re-Login</button>
          </div>
          <pre class="admin-log-view">${escapeHtml(toPrettyJson(gatewayStatus || {}))}</pre>
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
    state.activeTab = TAB_UP_NEXT;
  }
  if (!state.debugTabVisible && state.activeTab === TAB_DEBUG) {
    state.activeTab = TAB_UP_NEXT;
  }
  const queueStatusText = getQueueStatusText(queue, queueList);
  const queueUpdatedAtText = getQueueUpdatedAtText(queue);
  const activeNowPlaying = queueList?.nowPlaying || queue?.nowPlaying;
  const hasNowPlaying = Boolean(activeNowPlaying);
  const nowPlayingSummaryMarkup = getTrackSummaryMarkup(activeNowPlaying, { includeDuration: true });
  const nowPlayingPipMarkup = getTrackSummaryMarkup(activeNowPlaying, { pip: true, includeDuration: true });
  const upNextTrackListMarkup = getUpNextTrackListMarkup();
  const hasUpNextTracks = Boolean(upNextTrackListMarkup);
  const pipMode = isPipViewport();
  const playbackProgressMarkup = hasNowPlaying ? getPlaybackProgressMarkup({ pip: pipMode }) : "";
  const themeToggleLabel = state.themeMode === THEME_DARK ? "Light Mode" : "Dark Mode";
  const queueLength = Number.isFinite(queueList?.total)
    ? queueList.total
    : (queue?.queueLength || 0);
  const loopMode = getQueueLoopMode();
  const connectedAtText = state.connectedAt ? formatTime(state.connectedAt) : "unknown";
  const guildCount = Array.isArray(state.authSummary?.guilds) ? state.authSummary.guilds.length : 0;
  const connection = getConnectionStatusPresentation();
  const showDebugTabButton = state.debugTabVisible || state.activeTab === TAB_DEBUG;
  const noticeMarkup = state.notice
    ? `<p class="command-feedback ${state.noticeError ? "error" : ""}">${escapeHtml(state.notice)}</p>`
    : "";

  const playbackCardMarkup = pipMode
    ? `
      <article class="panel-card panel-card-pip">
        <div class="pip-card-header">
          <h2>Now Playing</h2>
          <span
            id="pip-connection-dot"
            class="connection-dot connection-dot-${escapeHtml(connection.statusKey)}"
            title="${escapeHtml(connection.hint)}"
            aria-label="${escapeHtml(connection.label)}"
          ></span>
        </div>
        ${hasNowPlaying ? nowPlayingPipMarkup : getPlaybackReadyStateMarkup({ pip: true })}
        ${hasNowPlaying ? playbackProgressMarkup : ""}
      </article>
    `
    : `
      <article class="panel-card">
        <h2>Playback</h2>
        ${hasNowPlaying
    ? `
          <div id="queue-now-playing" class="now-playing-section">
            ${nowPlayingSummaryMarkup}
          </div>
          ${playbackProgressMarkup}
          <div class="action-row">
            <button type="button" class="btn btn-primary" data-action="pause">Pause</button>
            <button type="button" class="btn btn-primary" data-action="resume">Resume</button>
            <button type="button" class="btn btn-primary" data-action="skip">Skip</button>
            <button type="button" class="btn btn-danger" data-action="stop">Stop</button>
            <button type="button" class="btn" data-action="clear">Clear Queue</button>
          </div>
        `
    : getPlaybackReadyStateMarkup()}
      </article>
    `;

  const topUtilityActionsMarkup = pipMode
    ? ""
    : `
      <div class="top-row-secondary">
        <button type="button" class="btn" id="refresh-now">Refresh</button>
        ${mode === "web" ? '<button type="button" class="btn" id="logout-web">Logout</button>' : ""}
        <button type="button" class="btn btn-secondary" id="theme-toggle">${escapeHtml(themeToggleLabel)}</button>
      </div>
    `;

  const menuSectionsMarkup = pipMode
    ? ""
    : `
      <nav class="menu-tabs">
        <button type="button" class="tab-btn${state.activeTab === TAB_UP_NEXT ? " active" : ""}" data-tab="${TAB_UP_NEXT}">Queue</button>
        <button type="button" class="tab-btn${state.activeTab === TAB_QUEUE ? " active" : ""}" data-tab="${TAB_QUEUE}">Queue Edit</button>
        ${adminState.isAdmin
          ? `<button type="button" class="tab-btn${state.activeTab === TAB_ADMIN ? " active" : ""}" data-tab="${TAB_ADMIN}">Admin</button>`
          : ""}
        ${showDebugTabButton
          ? `<button type="button" class="tab-btn${state.activeTab === TAB_DEBUG ? " active" : ""}" data-tab="${TAB_DEBUG}">Debug</button>`
          : ""}
      </nav>
      <section class="menu-panel${state.activeTab === TAB_UP_NEXT ? " active" : ""}" data-panel="${TAB_UP_NEXT}">
        <article class="panel-card">
          <div class="queue-header-row">
            <h2>Queue</h2>
            <p class="queue-remaining">Remaining: <strong>${escapeHtml(String(queueLength))}</strong></p>
          </div>
          ${hasUpNextTracks ? upNextTrackListMarkup : ""}
        </article>
      </section>
      <section class="menu-panel${state.activeTab === TAB_QUEUE ? " active" : ""}" data-panel="${TAB_QUEUE}">
        <article class="panel-card">
          <div class="queue-header-row">
            <h2>Queue Edit</h2>
            <p class="queue-remaining">Remaining: <strong>${escapeHtml(String(queueLength))}</strong></p>
          </div>
          <div class="queue-toolbar">
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
            <dt>Connection</dt><dd>${escapeHtml(connection.label.toLowerCase())}</dd>
            <dt>Build</dt><dd>${escapeHtml(BUILD_ID)}</dd>
            <dt>User</dt><dd>${escapeHtml(getUserLabel())}</dd>
            <dt>Guilds In Scope</dt><dd>${escapeHtml(String(guildCount))}</dd>
            <dt>Connected At</dt><dd>${escapeHtml(connectedAtText)}</dd>
            <dt>Uptime</dt><dd id="uptime">0s</dd>
            <dt>Browser Time</dt><dd id="browser-time">${escapeHtml(formatTime(Date.now()))}</dd>
            <dt>Queue Status</dt><dd id="debug-queue-status">${escapeHtml(queueStatusText)}</dd>
            <dt>Queue Last Update</dt><dd id="debug-queue-updated-at">${escapeHtml(queueUpdatedAtText)}</dd>
            <dt>Guild</dt><dd>${escapeHtml(state.sdkContext.guildId || state.selectedGuildId || "unknown")}</dd>
            <dt>Channel</dt><dd>${escapeHtml(state.sdkContext.channelId || "n/a")}</dd>
            <dt>Instance</dt><dd>${escapeHtml(state.sdkContext.instanceId || "n/a")}</dd>
            <dt>Trace</dt><dd>${escapeHtml(formatDebugEvents() || "none")}</dd>
          </dl>
          <label class="toggle-row">
            <input type="checkbox" id="debug-show-guild-ids"${state.showGuildIdsInSelector ? " checked" : ""}>
            <span>Show guild IDs in selector labels</span>
          </label>
        </article>
      </section>
    `;

  const topBarMarkup = pipMode
    ? ""
    : `
      <div class="top-row">
        <div class="top-row-main">
          <p class="kicker">queueDexBot</p>
          ${getGuildSelectionMarkup()}
        </div>
        <button
          type="button"
          id="connection-status-btn"
          class="chip chip-button top-row-status ${connection.chipClass}"
          title="${escapeHtml(`${connection.hint} Click to open debug tools.`)}"
          aria-label="${escapeHtml(`${connection.label}. Click to open debug tools.`)}"
        >${escapeHtml(connection.label)}</button>
      </div>
    `;

  const feedbackMarkup = pipMode ? "" : noticeMarkup;
  const shellClass = state.hasMountedDashboard ? "shell" : "shell shell-animated";
  setThemeBodyMode(state.themeMode);
  setPipBodyMode(pipMode);
  root.innerHTML = `
    <section class="${shellClass}${pipMode ? " pip-mode" : ""}">
      ${topBarMarkup}
      ${topUtilityActionsMarkup}
      <section class="playback-panel${pipMode ? " pip" : ""}">
        ${playbackCardMarkup}
      </section>
      ${menuSectionsMarkup}
      ${feedbackMarkup}
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
  hydrateTrackThumbnails();

  root.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.getAttribute("data-tab");
      if (!tab) {
        return;
      }
      const wasDebugTab = state.activeTab === TAB_DEBUG;
      const nextTab = state.activeTab === tab ? TAB_PLAYER : tab;
      if (wasDebugTab && nextTab !== TAB_DEBUG && state.debugTabVisible) {
        scheduleDebugTabAutoHide();
      } else if (nextTab === TAB_DEBUG && state.debugTabVisible) {
        scheduleDebugTabAutoHide();
      }
      state.activeTab = nextTab;
      renderDashboard();
    });
  });

  const connectionStatusButton = root.querySelector("#connection-status-btn");
  if (connectionStatusButton) {
    connectionStatusButton.addEventListener("click", () => {
      showDebugTabAndOpen();
    });
  }

  const guildSelect = root.querySelector("#guild-select");
  if (guildSelect) {
    guildSelect.addEventListener("change", () => {
      const nextGuildId = String(guildSelect.value || "").trim();
      if (!nextGuildId || nextGuildId === state.selectedGuildId) {
        return;
      }
      clearQueueDragState();
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

  root.querySelectorAll("[data-track-drag-handle]").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      const position = parseQueuePosition(handle.getAttribute("data-position"));
      const sourceRow = handle.closest("[data-queue-track-row]");
      const started = beginQueueDrag(position, sourceRow, event.dataTransfer);
      if (!started) {
        event.preventDefault();
      }
    });

    handle.addEventListener("dragend", () => {
      if (state.queueDrag.pending) {
        clearQueueDragDomState();
        return;
      }
      clearQueueDragState();
    });
  });

  root.querySelectorAll("[data-queue-drop-slot]").forEach((slot) => {
    slot.addEventListener("dragenter", (event) => {
      if (!state.queueDrag.active || slot.getAttribute("data-disabled") === "1") {
        return;
      }
      event.preventDefault();
      const insertBefore = parseQueuePosition(slot.getAttribute("data-insert-before"));
      if (insertBefore) {
        setQueueDragTarget(insertBefore);
      }
    });

    slot.addEventListener("dragover", (event) => {
      if (!state.queueDrag.active || slot.getAttribute("data-disabled") === "1") {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const insertBefore = parseQueuePosition(slot.getAttribute("data-insert-before"));
      if (insertBefore) {
        setQueueDragTarget(insertBefore);
      }
    });

    slot.addEventListener("drop", (event) => {
      if (!state.queueDrag.active || slot.getAttribute("data-disabled") === "1") {
        return;
      }
      event.preventDefault();
      const insertBefore = parseQueuePosition(slot.getAttribute("data-insert-before"));
      if (!insertBefore) {
        clearQueueDragState();
        return;
      }
      void submitQueueDragMove(insertBefore);
    });
  });

  root.querySelectorAll("[data-queue-track-row]").forEach((row) => {
    row.addEventListener("dragenter", (event) => {
      if (!state.queueDrag.active) {
        return;
      }
      event.preventDefault();
      const insertBefore = getRowDropInsertBeforePosition(row, event.clientY);
      if (insertBefore) {
        setQueueDragTarget(insertBefore);
      }
    });

    row.addEventListener("dragover", (event) => {
      if (!state.queueDrag.active) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const insertBefore = getRowDropInsertBeforePosition(row, event.clientY);
      if (insertBefore) {
        setQueueDragTarget(insertBefore);
      }
    });

    row.addEventListener("drop", (event) => {
      if (!state.queueDrag.active) {
        return;
      }
      event.preventDefault();
      const insertBefore = getRowDropInsertBeforePosition(row, event.clientY)
        || parseQueuePosition(state.queueDrag.targetInsertBefore);
      if (!insertBefore) {
        clearQueueDragState();
        return;
      }
      void submitQueueDragMove(insertBefore);
    });
  });

  root.querySelectorAll("[data-track-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-track-action");
      const position = parseQueuePosition(button.getAttribute("data-position"));
      if (!action || !position) {
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

  const logoutButton = root.querySelector("#logout-web");
  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      void logoutWebSession();
    });
  }

  const themeToggleButton = root.querySelector("#theme-toggle");
  if (themeToggleButton) {
    themeToggleButton.addEventListener("click", () => {
      const nextMode = state.themeMode === THEME_DARK ? THEME_LIGHT : THEME_DARK;
      applyThemeMode(nextMode);
      renderDashboard();
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
      if (action === "gateway-refresh") {
        void refreshAdminPanelDataAndRender("Discord gateway status refreshed.");
        return;
      }
      if (action === "gateway-relogin") {
        void sendAdminCommand("/api/activity/admin/discord/relogin", {
          reason: "manual force relogin from admin UI",
        });
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
    if (uptimeNode) {
      const connectedAt = state.connectedAt || new Date();
      uptimeNode.textContent = formatUptime(Date.now() - connectedAt.getTime());
    }

    const browserTimeNode = root.querySelector("#browser-time");
    if (browserTimeNode) {
      browserTimeNode.textContent = formatTime(Date.now());
    }

    const queue = getCurrentQueueData();
    const queueList = getQueueListData();
    const debugQueueStatusNode = root.querySelector("#debug-queue-status");
    if (debugQueueStatusNode) {
      debugQueueStatusNode.textContent = getQueueStatusText(queue, queueList);
    }
    const debugQueueUpdatedAtNode = root.querySelector("#debug-queue-updated-at");
    if (debugQueueUpdatedAtNode) {
      debugQueueUpdatedAtNode.textContent = getQueueUpdatedAtText(queue);
    }

    const connectionStatusNode = root.querySelector("#connection-status-btn");
    if (connectionStatusNode) {
      const connection = getConnectionStatusPresentation();
      connectionStatusNode.className = `chip chip-button top-row-status ${connection.chipClass}`;
      connectionStatusNode.textContent = connection.label;
      connectionStatusNode.title = `${connection.hint} Click to open debug tools.`;
      connectionStatusNode.setAttribute("aria-label", `${connection.label}. Click to open debug tools.`);
    }

    const pipConnectionDot = root.querySelector("#pip-connection-dot");
    if (pipConnectionDot) {
      const connection = getConnectionStatusPresentation();
      pipConnectionDot.className = `connection-dot connection-dot-${connection.statusKey}`;
      pipConnectionDot.title = connection.hint;
      pipConnectionDot.setAttribute("aria-label", connection.label);
    }

    const progressSliderNode = root.querySelector("#playback-progress-slider");
    const progressFillNode = root.querySelector("#playback-progress-fill");
    const progressTimeNode = root.querySelector("#playback-progress-time");
    if (progressTimeNode || progressSliderNode || progressFillNode) {
      const progress = getPlaybackProgressSnapshot();
      if (progress) {
        if (progressSliderNode) {
          progressSliderNode.max = String(progress.hasDuration ? progress.durationSec : 1);
          progressSliderNode.value = String(progress.hasDuration ? progress.elapsedSec : 0);
        }
        if (progressFillNode) {
          const percent = progress.hasDuration ? Math.max(0, Math.min(100, Math.round(progress.ratio * 100))) : 0;
          progressFillNode.style.width = `${percent}%`;
        }
        const leftLabel = formatProgressTimestamp(progress.elapsedSec);
        const rightLabel = progress.hasDuration ? formatProgressTimestamp(progress.durationSec) : "unknown";
        if (progressTimeNode) {
          progressTimeNode.textContent = `${leftLabel} / ${rightLabel}`;
        }
      }
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
  markApiAttempt();
  let response;
  try {
    response = await fetch(getApiUrl(path), options);
  } catch (error) {
    markApiFailure();
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    markApiFailure();
    const errorMessage = payload?.error || `Request failed (${response.status})`;
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }
  markApiSuccess();
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

async function refreshAdminGatewayStatus() {
  if (!getAdminState().isAdmin) {
    state.adminGatewayStatus = null;
    return;
  }
  const payload = await fetchJson("/api/activity/admin/discord/status", {
    credentials: "include",
  });
  state.adminGatewayStatus = payload?.gateway || null;
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
    state.adminGatewayStatus = null;
    state.adminEvents = [];
    state.adminVerification = null;
    return;
  }
  const refreshResults = await Promise.allSettled([
    refreshAdminProvidersStatus(),
    refreshAdminGatewayStatus(),
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
    if (path === "/api/activity/admin/discord/relogin" && payload?.gateway) {
      state.adminGatewayStatus = payload.gateway;
    }

    await refreshAdminPanelData();
    if (path === "/api/activity/admin/discord/relogin") {
      state.notice = "Discord relogin requested.";
    } else {
      state.notice = "Admin command applied.";
    }
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
  state.adminGatewayStatus = null;
  state.adminEvents = [];
  state.adminBotGuilds = [];
  state.adminVerification = null;
  state.selectedGuildId = null;
  state.debugTabVisible = false;
  state.lastApiAttemptAt = null;
  state.lastApiSuccessAt = null;
  state.consecutiveApiFailures = 0;
  clearQueueDragState();
  setConnectionStatus(CONNECTION_STATUS_DISCONNECTED);
  stopDebugTabHideTimer();
  renderWebLogin();
}

function startStatePolling() {
  stopStatePoller();
  statePoller = setInterval(() => {
    if (state.queueDrag.active || state.queueDrag.pending) {
      return;
    }
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

  setConnectionStatus(CONNECTION_STATUS_AUTHORIZING);
  state.discordSdkConnected = false;
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
  state.discordSdkConnected = true;

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
  setConnectionStatus(CONNECTION_STATUS_AUTHORIZING);
  state.discordSdkConnected = false;
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

async function bootstrapEmbeddedFallback(failureMessage) {
  const reason = String(failureMessage || "unknown");
  pushDebugEvent("bootstrap.embedded.fallback.start", reason);

  state.mode = "embedded";
  state.discordSdkConnected = false;
  state.connectedAt = new Date();
  state.sdkContext.guildId = null;
  state.sdkContext.channelId = null;
  state.sdkContext.instanceId = null;
  state.selectedGuildId = resolveInitialGuildId();

  try {
    await refreshDashboardData();
    state.notice = "Discord SDK handshake failed. Using existing session fallback; relaunch Activity if controls stop responding.";
    state.noticeError = false;
    pushDebugEvent("bootstrap.embedded.fallback.success", state.selectedGuildId || "no-guild");
    renderDashboard();
    startLiveTicker();
    startStatePolling();
    return true;
  } catch (error) {
    pushDebugEvent("bootstrap.embedded.fallback.failed", error?.message || String(error));
    return false;
  }
}

async function bootstrap() {
  debugEvents.length = 0;
  applyThemeMode(state.themeMode);
  stopLiveTicker();
  stopStatePoller();
  stopDebugTabHideTimer();
  ensureViewportWatcher();
  state.hasMountedDashboard = false;
  state.debugTabVisible = false;
  state.discordSdkConnected = false;
  state.lastApiAttemptAt = null;
  state.lastApiSuccessAt = null;
  state.consecutiveApiFailures = 0;
  setConnectionStatus(CONNECTION_STATUS_DISCONNECTED);
  pushDebugEvent("bootstrap.start", `build=${BUILD_ID}`);
  const query = new URLSearchParams(window.location.search);
  const hasFrameId = query.has("frame_id");

  try {
    if (hasFrameId) {
      await bootstrapEmbeddedMode();
      return;
    }
    await bootstrapWebMode();
  } catch (error) {
    setConnectionStatus(CONNECTION_STATUS_DISCONNECTED);
    const message = String(error?.message || "");
    const isTimeout = message.toLowerCase().includes("timed out");
    pushDebugEvent("bootstrap.failed", message);
    if (hasFrameId) {
      const fallbackSucceeded = await bootstrapEmbeddedFallback(message);
      if (fallbackSucceeded) {
        return;
      }
    }
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
