function loadEnvVars(sourceEnv = process.env) {
  return {
    token: sourceEnv.DISCORD_TOKEN,
    youtubeCookies: sourceEnv.YOUTUBE_COOKIES,
    youtubeCookiesPath: sourceEnv.YOUTUBE_COOKIES_PATH,
    youtubeUserAgent: sourceEnv.YOUTUBE_USER_AGENT,
    soundcloudUserAgent: sourceEnv.SOUNDCLOUD_USER_AGENT,
    ytdlpPath: sourceEnv.YTDLP_PATH || "yt-dlp",
    ytdlpPlayerClient: sourceEnv.YTDLP_PLAYER_CLIENT || "web",
    ytdlpFallbackPlayerClient: sourceEnv.YTDLP_FALLBACK_PLAYER_CLIENT || "android",
    ytdlpCookiesFromBrowser: sourceEnv.YTDLP_COOKIES_FROM_BROWSER,
    ytdlpJsRuntime: sourceEnv.YTDLP_JS_RUNTIME || "node",
    ytdlpRemoteComponents: sourceEnv.YTDLP_REMOTE_COMPONENTS || "ejs:github",
    ytdlpStream: sourceEnv.YTDLP_STREAM === "1",
    ytdlpConcurrentFragments: parseInt(sourceEnv.YTDLP_CONCURRENT_FRAGMENTS || "", 10),
    ytdlpStreamTimeoutMs: parseInt(sourceEnv.YTDLP_STREAM_TIMEOUT_MS || "12000", 10),
    interactionTimeoutMs: parseInt(sourceEnv.INTERACTION_TIMEOUT_MS || "45000", 10),
    devAlertChannelId: sourceEnv.DEV_ALERT_CHANNEL_ID,
    devLogChannelId: sourceEnv.DEV_LOG_CHANNEL_ID,
    botActivityName: sourceEnv.BOT_ACTIVITY_NAME || "music with /play",
    botActivityType: String(sourceEnv.BOT_ACTIVITY_TYPE || "LISTENING").toUpperCase(),
    spotifyClientId: sourceEnv.SPOTIFY_CLIENT_ID,
    spotifyClientSecret: sourceEnv.SPOTIFY_CLIENT_SECRET,
    spotifyRefreshToken: sourceEnv.SPOTIFY_REFRESH_TOKEN,
    spotifyMarket: sourceEnv.SPOTIFY_MARKET || "US",
  };
}

module.exports = {
  loadEnvVars,
};
