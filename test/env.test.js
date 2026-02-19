const test = require("node:test");
const assert = require("node:assert/strict");

const { loadEnvVars } = require("../src/config/env");

test("loadEnvVars applies defaults for env-backed non-secret settings", () => {
  const env = loadEnvVars({});

  assert.equal(env.applicationId, undefined);
  assert.equal(env.ytdlpPath, "yt-dlp");
  assert.equal(env.ytdlpPlayerClient, "web");
  assert.equal(env.ytdlpFallbackPlayerClient, "android");
  assert.equal(env.ytdlpJsRuntime, "node");
  assert.equal(env.ytdlpRemoteComponents, "ejs:github");
  assert.equal(env.ytdlpStream, false);
  assert.equal(Number.isNaN(env.ytdlpConcurrentFragments), true);
  assert.equal(env.oauthClientId, undefined);
  assert.equal(env.oauthClientSecret, undefined);
  assert.equal(env.oauthWebRedirectUri, undefined);
  assert.equal(env.oauthActivityRedirectUri, undefined);
  assert.equal(env.oauthScopes, "identify guilds");
  assert.equal(env.authServerEnabled, true);
  assert.equal(env.authServerHost, "127.0.0.1");
  assert.equal(Number.isNaN(env.authServerPort), true);
  assert.equal(Number.isNaN(env.authSessionTtlMs), true);
  assert.equal(env.authSessionCookieName, "qdex_session");
  assert.equal(env.authSessionCookieSecure, true);
  assert.equal(env.logLevel, "info");
  assert.equal(env.logDir, "logs");
  assert.equal(env.logServiceName, "controller");
  assert.equal(env.logPretty, true);
  assert.equal(env.logMaxSizeBytes, 10 * 1024 * 1024);
  assert.equal(env.logMaxFiles, 10);
  assert.equal(env.devLogLevel, "info");
  assert.equal(env.devAlertLevel, "error");
});

test("loadEnvVars keeps secrets and optional endpoints as provided", () => {
  const env = loadEnvVars({
    DISCORD_TOKEN: "token",
    APPLICATION_ID: "app123",
    YOUTUBE_COOKIES: "cookie=value",
    YOUTUBE_COOKIES_PATH: "./cookies.json",
    YOUTUBE_USER_AGENT: "Mozilla/5.0 Test",
    SOUNDCLOUD_USER_AGENT: "Mozilla/5.0 SoundCloud",
    DEV_ALERT_CHANNEL_ID: "123",
    DEV_LOG_CHANNEL_ID: "456",
    SPOTIFY_CLIENT_ID: "abc",
    SPOTIFY_CLIENT_SECRET: "def",
    SPOTIFY_REFRESH_TOKEN: "ghi",
    YTDLP_STREAM: "1",
    YTDLP_CONCURRENT_FRAGMENTS: "8",
    DISCORD_OAUTH_CLIENT_SECRET: "oauthsecret",
    DISCORD_OAUTH_REDIRECT_URI_WEB: "https://app.example.com/auth/discord/web/callback",
    DISCORD_OAUTH_REDIRECT_URI_ACTIVITY: "https://activity.example.com",
    DISCORD_OAUTH_SCOPES: "identify guilds",
    AUTH_SERVER_ENABLED: "0",
    AUTH_SERVER_HOST: "0.0.0.0",
    AUTH_SERVER_PORT: "8787",
    AUTH_SESSION_TTL_MS: "3600000",
    AUTH_SESSION_COOKIE_NAME: "qdex_cookie",
    AUTH_SESSION_COOKIE_SECURE: "0",
    LOG_LEVEL: "debug",
    LOG_DIR: "/tmp/queuedex-logs",
    LOG_SERVICE_NAME: "worker",
    LOG_PRETTY: "0",
    LOG_MAX_SIZE_BYTES: "5mb",
    LOG_MAX_FILES: "42",
    DEV_LOG_LEVEL: "debug",
    DEV_ALERT_LEVEL: "warn",
  });

  assert.equal(env.token, "token");
  assert.equal(env.applicationId, "app123");
  assert.equal(env.youtubeCookies, "cookie=value");
  assert.equal(env.youtubeCookiesPath, "./cookies.json");
  assert.equal(env.youtubeUserAgent, "Mozilla/5.0 Test");
  assert.equal(env.soundcloudUserAgent, "Mozilla/5.0 SoundCloud");
  assert.equal(env.devAlertChannelId, "123");
  assert.equal(env.devLogChannelId, "456");
  assert.equal(env.spotifyClientId, "abc");
  assert.equal(env.spotifyClientSecret, "def");
  assert.equal(env.spotifyRefreshToken, "ghi");
  assert.equal(env.ytdlpStream, true);
  assert.equal(env.ytdlpConcurrentFragments, 8);
  assert.equal(env.oauthClientId, "app123");
  assert.equal(env.oauthClientSecret, "oauthsecret");
  assert.equal(env.oauthWebRedirectUri, "https://app.example.com/auth/discord/web/callback");
  assert.equal(env.oauthActivityRedirectUri, "https://activity.example.com");
  assert.equal(env.oauthScopes, "identify guilds");
  assert.equal(env.authServerEnabled, false);
  assert.equal(env.authServerHost, "0.0.0.0");
  assert.equal(env.authServerPort, 8787);
  assert.equal(env.authSessionTtlMs, 3600000);
  assert.equal(env.authSessionCookieName, "qdex_cookie");
  assert.equal(env.authSessionCookieSecure, false);
  assert.equal(env.logLevel, "debug");
  assert.equal(env.logDir, "/tmp/queuedex-logs");
  assert.equal(env.logServiceName, "worker");
  assert.equal(env.logPretty, false);
  assert.equal(env.logMaxSizeBytes, 5 * 1024 * 1024);
  assert.equal(env.logMaxFiles, 42);
  assert.equal(env.devLogLevel, "debug");
  assert.equal(env.devAlertLevel, "warn");
});

test("loadEnvVars prefers explicit oauth client id over application id", () => {
  const env = loadEnvVars({
    APPLICATION_ID: "app123",
    DISCORD_OAUTH_CLIENT_ID: "oauth456",
  });

  assert.equal(env.applicationId, "app123");
  assert.equal(env.oauthClientId, "oauth456");
});
