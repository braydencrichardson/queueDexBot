const test = require("node:test");
const assert = require("node:assert/strict");

const { loadEnvVars } = require("../src/config/env");

test("loadEnvVars applies defaults for new tuning env vars", () => {
  const env = loadEnvVars({});

  assert.equal(env.botStatus, "online");
  assert.equal(env.queueViewPageSize, 10);
  assert.equal(env.queueMoveMenuPageSize, 25);
  assert.equal(env.playbackLoadingMessageDelayMs, 5000);
  assert.equal(env.soundcloudRedirectMaxHops, 5);
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
