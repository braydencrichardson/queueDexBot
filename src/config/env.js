function parseBooleanEnv(rawValue, fallback = false) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseIntEnv(rawValue, fallback = NaN, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = parseInt(rawValue || "", 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  if (parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function parseByteSizeEnv(rawValue, fallbackBytes) {
  const text = String(rawValue || "").trim();
  if (!text) {
    return fallbackBytes;
  }

  const numericMatch = text.match(/^(\d+)([kmg]b?|b)?$/i);
  if (!numericMatch) {
    return fallbackBytes;
  }
  const numeric = parseInt(numericMatch[1], 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackBytes;
  }
  const suffix = String(numericMatch[2] || "b").toLowerCase();
  const multiplier = suffix.startsWith("k")
    ? 1024
    : suffix.startsWith("m")
      ? 1024 * 1024
      : suffix.startsWith("g")
        ? 1024 * 1024 * 1024
        : 1;
  return numeric * multiplier;
}

function parseIdListEnv(rawValue) {
  const values = String(rawValue || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!values.length) {
    return [];
  }
  return Array.from(new Set(values));
}

function loadEnvVars(sourceEnv = process.env) {
  const oauthClientId = sourceEnv.DISCORD_OAUTH_CLIENT_ID || sourceEnv.APPLICATION_ID;
  return {
    token: sourceEnv.DISCORD_TOKEN,
    applicationId: sourceEnv.APPLICATION_ID,
    youtubeCookies: sourceEnv.YOUTUBE_COOKIES,
    youtubeCookiesPath: sourceEnv.YOUTUBE_COOKIES_PATH,
    youtubeUserAgent: sourceEnv.YOUTUBE_USER_AGENT,
    soundcloudCookies: sourceEnv.SOUNDCLOUD_COOKIES,
    soundcloudCookiesPath: sourceEnv.SOUNDCLOUD_COOKIES_PATH,
    soundcloudUserAgent: sourceEnv.SOUNDCLOUD_USER_AGENT,
    ytdlpPath: sourceEnv.YTDLP_PATH || "yt-dlp",
    ytdlpPlayerClient: sourceEnv.YTDLP_PLAYER_CLIENT || "web",
    ytdlpFallbackPlayerClient: sourceEnv.YTDLP_FALLBACK_PLAYER_CLIENT || "android",
    ytdlpCookiesFromBrowser: sourceEnv.YTDLP_COOKIES_FROM_BROWSER,
    ytdlpJsRuntime: sourceEnv.YTDLP_JS_RUNTIME || "node",
    ytdlpRemoteComponents: sourceEnv.YTDLP_REMOTE_COMPONENTS || "ejs:github",
    ytdlpStream: sourceEnv.YTDLP_STREAM === "1",
    ytdlpConcurrentFragments: parseInt(sourceEnv.YTDLP_CONCURRENT_FRAGMENTS || "", 10),
    devAlertChannelId: sourceEnv.DEV_ALERT_CHANNEL_ID,
    devLogChannelId: sourceEnv.DEV_LOG_CHANNEL_ID,
    spotifyClientId: sourceEnv.SPOTIFY_CLIENT_ID,
    spotifyClientSecret: sourceEnv.SPOTIFY_CLIENT_SECRET,
    spotifyRefreshToken: sourceEnv.SPOTIFY_REFRESH_TOKEN,
    oauthClientId,
    oauthClientSecret: sourceEnv.DISCORD_OAUTH_CLIENT_SECRET,
    oauthWebRedirectUri: sourceEnv.DISCORD_OAUTH_REDIRECT_URI_WEB,
    oauthActivityRedirectUri: sourceEnv.DISCORD_OAUTH_REDIRECT_URI_ACTIVITY,
    oauthScopes: sourceEnv.DISCORD_OAUTH_SCOPES || "identify guilds",
    activityWebUrl: sourceEnv.ACTIVITY_WEB_URL,
    activityInvitePrewarmOnPlaybackStart: parseBooleanEnv(
      sourceEnv.ACTIVITY_INVITE_PREWARM_ON_PLAYBACK_START,
      false
    ),
    nowPlayingShowProgress: parseBooleanEnv(sourceEnv.NOW_PLAYING_SHOW_PROGRESS, false),
    discordGatewayWatchdogEnabled: parseBooleanEnv(sourceEnv.DISCORD_GATEWAY_WATCHDOG_ENABLED, true),
    discordGatewayWatchdogCheckIntervalMs: parseIntEnv(
      sourceEnv.DISCORD_GATEWAY_WATCHDOG_CHECK_INTERVAL_MS,
      5000,
      { min: 1000, max: 600000 }
    ),
    discordGatewayWatchdogDisconnectThresholdMs: parseIntEnv(
      sourceEnv.DISCORD_GATEWAY_WATCHDOG_DISCONNECT_THRESHOLD_MS,
      20000,
      { min: 1000, max: 900000 }
    ),
    discordGatewayWatchdogBackoffBaseMs: parseIntEnv(
      sourceEnv.DISCORD_GATEWAY_WATCHDOG_BACKOFF_BASE_MS,
      8000,
      { min: 1000, max: 900000 }
    ),
    discordGatewayWatchdogBackoffMaxMs: parseIntEnv(
      sourceEnv.DISCORD_GATEWAY_WATCHDOG_BACKOFF_MAX_MS,
      120000,
      { min: 1000, max: 3600000 }
    ),
    authServerEnabled: parseBooleanEnv(sourceEnv.AUTH_SERVER_ENABLED, true),
    authServerHost: sourceEnv.AUTH_SERVER_HOST || "127.0.0.1",
    authServerPort: parseInt(sourceEnv.AUTH_SERVER_PORT || "", 10),
    authSessionTtlMs: parseInt(sourceEnv.AUTH_SESSION_TTL_MS || "", 10),
    authSessionCookieName: sourceEnv.AUTH_SESSION_COOKIE_NAME || "qdex_session",
    authSessionCookieSecure: parseBooleanEnv(sourceEnv.AUTH_SESSION_COOKIE_SECURE, true),
    authSessionStoreEnabled: parseBooleanEnv(sourceEnv.AUTH_SESSION_STORE_ENABLED, true),
    authSessionStorePath: sourceEnv.AUTH_SESSION_STORE_PATH || "data/auth-sessions.json",
    authAdminUserIds: parseIdListEnv(sourceEnv.AUTH_ADMIN_USER_IDS),
    logLevel: String(sourceEnv.LOG_LEVEL || "info").trim().toLowerCase() || "info",
    logDir: sourceEnv.LOG_DIR || "logs",
    logServiceName: sourceEnv.LOG_SERVICE_NAME || "controller",
    logPretty: parseBooleanEnv(sourceEnv.LOG_PRETTY, true),
    logMaxSizeBytes: parseByteSizeEnv(
      sourceEnv.LOG_MAX_SIZE_BYTES || sourceEnv.LOG_MAX_SIZE,
      10 * 1024 * 1024
    ),
    logMaxFiles: parseIntEnv(sourceEnv.LOG_MAX_FILES, 10, { min: 0, max: 1000 }),
    devLogLevel: String(sourceEnv.DEV_LOG_LEVEL || "info").trim().toLowerCase() || "info",
    devAlertLevel: String(sourceEnv.DEV_ALERT_LEVEL || "error").trim().toLowerCase() || "error",
  };
}

module.exports = {
  loadEnvVars,
};
