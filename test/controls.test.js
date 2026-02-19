const test = require("node:test");
const assert = require("node:assert/strict");

const { buildNowPlayingControls } = require("../src/ui/controls");

test("buildNowPlayingControls includes activity shortcut and omits loop toggle", () => {
  const row = buildNowPlayingControls();
  const customIds = row.components.map((component) => component?.data?.custom_id);

  assert.deepEqual(customIds, ["np_queue", "np_activity", "np_toggle", "np_skip", "np_stop"]);
});
