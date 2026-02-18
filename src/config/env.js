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
    authServerEnabled: parseBooleanEnv(sourceEnv.AUTH_SERVER_ENABLED, true),
    authServerHost: sourceEnv.AUTH_SERVER_HOST || "127.0.0.1",
    authServerPort: parseInt(sourceEnv.AUTH_SERVER_PORT || "", 10),
    authSessionTtlMs: parseInt(sourceEnv.AUTH_SESSION_TTL_MS || "", 10),
    authSessionCookieName: sourceEnv.AUTH_SESSION_COOKIE_NAME || "qdex_session",
    authSessionCookieSecure: parseBooleanEnv(sourceEnv.AUTH_SESSION_COOKIE_SECURE, true),
  };
}

module.exports = {
  loadEnvVars,
};
