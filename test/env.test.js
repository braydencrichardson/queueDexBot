const test = require("node:test");
const assert = require("node:assert/strict");

const { loadEnvVars } = require("../src/config/env");

test("loadEnvVars applies defaults for env-backed non-secret settings", () => {
  const env = loadEnvVars({});

  assert.equal(env.ytdlpPath, "yt-dlp");
  assert.equal(env.ytdlpPlayerClient, "web");
  assert.equal(env.ytdlpFallbackPlayerClient, "android");
  assert.equal(env.ytdlpJsRuntime, "node");
  assert.equal(env.ytdlpRemoteComponents, "ejs:github");
  assert.equal(env.ytdlpStream, false);
  assert.equal(Number.isNaN(env.ytdlpConcurrentFragments), true);
});

test("loadEnvVars keeps secrets and optional endpoints as provided", () => {
  const env = loadEnvVars({
    DISCORD_TOKEN: "token",
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
  });

  assert.equal(env.token, "token");
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
});
