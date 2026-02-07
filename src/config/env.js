const {
  DEFAULT_INTERACTION_TIMEOUT_MS,
  DEFAULT_PLAYBACK_LOADING_MESSAGE_DELAY_MS,
  DEFAULT_QUEUE_INACTIVITY_TIMEOUT_MS,
  DEFAULT_QUEUE_MOVE_MENU_PAGE_SIZE,
  DEFAULT_QUEUE_VIEW_TIMEOUT_MS,
  DEFAULT_QUEUE_VIEW_PAGE_SIZE,
  DEFAULT_SEARCH_CHOOSER_MAX_RESULTS,
  DEFAULT_SOUND_CLOUD_REDIRECT_MAX_HOPS,
  DEFAULT_TRACK_RESOLVER_HTTP_TIMEOUT_MS,
  DEFAULT_YTDLP_STREAM_TIMEOUT_MS,
} = require("./constants");

function loadEnvVars(sourceEnv = process.env) {
  function parseIntOrDefault(value, fallback) {
    const parsed = parseInt(value || "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function parseIntClamped(value, fallback, min, max) {
    const parsed = parseIntOrDefault(value, fallback);
    return Math.min(max, Math.max(min, parsed));
  }

  const parsedSearchChooserMaxResults = parseInt(
    sourceEnv.SEARCH_CHOOSER_MAX_RESULTS || String(DEFAULT_SEARCH_CHOOSER_MAX_RESULTS),
    10
  );
  const searchChooserMaxResults = Number.isFinite(parsedSearchChooserMaxResults)
    ? Math.min(25, Math.max(1, parsedSearchChooserMaxResults))
    : DEFAULT_SEARCH_CHOOSER_MAX_RESULTS;
  const validBotStatuses = new Set(["online", "idle", "dnd", "invisible"]);
  const parsedBotStatus = String(sourceEnv.BOT_STATUS || "online").trim().toLowerCase();
  const botStatus = validBotStatuses.has(parsedBotStatus) ? parsedBotStatus : "online";

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
    ytdlpStreamTimeoutMs: parseIntOrDefault(sourceEnv.YTDLP_STREAM_TIMEOUT_MS, DEFAULT_YTDLP_STREAM_TIMEOUT_MS),
    trackResolverHttpTimeoutMs: parseIntOrDefault(sourceEnv.TRACK_RESOLVER_HTTP_TIMEOUT_MS, DEFAULT_TRACK_RESOLVER_HTTP_TIMEOUT_MS),
    soundcloudRedirectMaxHops: parseIntClamped(sourceEnv.SOUNDCLOUD_REDIRECT_MAX_HOPS, DEFAULT_SOUND_CLOUD_REDIRECT_MAX_HOPS, 1, 20),
    playbackLoadingMessageDelayMs: parseIntClamped(
      sourceEnv.PLAYBACK_LOADING_MESSAGE_DELAY_MS,
      DEFAULT_PLAYBACK_LOADING_MESSAGE_DELAY_MS,
      0,
      60000
    ),
    searchChooserMaxResults,
    queueViewPageSize: parseIntClamped(sourceEnv.QUEUE_VIEW_PAGE_SIZE, DEFAULT_QUEUE_VIEW_PAGE_SIZE, 1, 25),
    queueViewTimeoutMs: parseIntOrDefault(sourceEnv.QUEUE_VIEW_TIMEOUT_MS, DEFAULT_QUEUE_VIEW_TIMEOUT_MS),
    queueMoveMenuPageSize: parseIntClamped(sourceEnv.QUEUE_MOVE_MENU_PAGE_SIZE, DEFAULT_QUEUE_MOVE_MENU_PAGE_SIZE, 1, 25),
    queueInactivityTimeoutMs: parseIntOrDefault(sourceEnv.QUEUE_INACTIVITY_TIMEOUT_MS, DEFAULT_QUEUE_INACTIVITY_TIMEOUT_MS),
    interactionTimeoutMs: parseIntOrDefault(sourceEnv.INTERACTION_TIMEOUT_MS, DEFAULT_INTERACTION_TIMEOUT_MS),
    devAlertChannelId: sourceEnv.DEV_ALERT_CHANNEL_ID,
    devLogChannelId: sourceEnv.DEV_LOG_CHANNEL_ID,
    botStatus,
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
