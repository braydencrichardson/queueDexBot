const test = require("node:test");
const assert = require("node:assert/strict");

const { loadEnvVars } = require("../src/config/env");
const {
  DEFAULT_PLAYBACK_LOADING_MESSAGE_DELAY_MS,
  DEFAULT_QUEUE_MOVE_MENU_PAGE_SIZE,
  DEFAULT_QUEUE_VIEW_PAGE_SIZE,
  DEFAULT_SEARCH_CHOOSER_MAX_RESULTS,
  DEFAULT_SOUND_CLOUD_REDIRECT_MAX_HOPS,
} = require("../src/config/constants");

test("loadEnvVars applies defaults for new tuning env vars", () => {
  const env = loadEnvVars({});

  assert.equal(env.botStatus, "online");
  assert.equal(env.queueViewPageSize, DEFAULT_QUEUE_VIEW_PAGE_SIZE);
  assert.equal(env.queueMoveMenuPageSize, DEFAULT_QUEUE_MOVE_MENU_PAGE_SIZE);
  assert.equal(env.playbackLoadingMessageDelayMs, DEFAULT_PLAYBACK_LOADING_MESSAGE_DELAY_MS);
  assert.equal(env.soundcloudRedirectMaxHops, DEFAULT_SOUND_CLOUD_REDIRECT_MAX_HOPS);
  assert.equal(env.searchChooserMaxResults, DEFAULT_SEARCH_CHOOSER_MAX_RESULTS);
});

test("loadEnvVars clamps and normalizes configurable values", () => {
  const env = loadEnvVars({
    BOT_STATUS: "DND",
    QUEUE_VIEW_PAGE_SIZE: "99",
    QUEUE_MOVE_MENU_PAGE_SIZE: "0",
    PLAYBACK_LOADING_MESSAGE_DELAY_MS: "-1",
    SOUNDCLOUD_REDIRECT_MAX_HOPS: "100",
  });

  assert.equal(env.botStatus, "dnd");
  assert.equal(env.queueViewPageSize, 25);
  assert.equal(env.queueMoveMenuPageSize, 1);
  assert.equal(env.playbackLoadingMessageDelayMs, 0);
  assert.equal(env.soundcloudRedirectMaxHops, 20);
});

test("loadEnvVars clamps configured values at both bounds and normalizes/falls back status", () => {
  const clampedMax = loadEnvVars({
    BOT_STATUS: "idle",
    QUEUE_VIEW_PAGE_SIZE: "500",
    QUEUE_MOVE_MENU_PAGE_SIZE: "500",
    PLAYBACK_LOADING_MESSAGE_DELAY_MS: "999999",
    SOUNDCLOUD_REDIRECT_MAX_HOPS: "999",
    SEARCH_CHOOSER_MAX_RESULTS: "999",
  });
  assert.equal(clampedMax.botStatus, "idle");
  assert.equal(clampedMax.queueViewPageSize, 25);
  assert.equal(clampedMax.queueMoveMenuPageSize, 25);
  assert.equal(clampedMax.playbackLoadingMessageDelayMs, 60000);
  assert.equal(clampedMax.soundcloudRedirectMaxHops, 20);
  assert.equal(clampedMax.searchChooserMaxResults, 25);

  const clampedMin = loadEnvVars({
    BOT_STATUS: "NOT_A_STATUS",
    QUEUE_VIEW_PAGE_SIZE: "-500",
    QUEUE_MOVE_MENU_PAGE_SIZE: "-500",
    PLAYBACK_LOADING_MESSAGE_DELAY_MS: "-500",
    SOUNDCLOUD_REDIRECT_MAX_HOPS: "-500",
    SEARCH_CHOOSER_MAX_RESULTS: "-500",
  });
  assert.equal(clampedMin.botStatus, "online");
  assert.equal(clampedMin.queueViewPageSize, 1);
  assert.equal(clampedMin.queueMoveMenuPageSize, 1);
  assert.equal(clampedMin.playbackLoadingMessageDelayMs, 0);
  assert.equal(clampedMin.soundcloudRedirectMaxHops, 1);
  assert.equal(clampedMin.searchChooserMaxResults, 1);
});
