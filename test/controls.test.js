const test = require("node:test");
const assert = require("node:assert/strict");

const { buildNowPlayingControls } = require("../src/ui/controls");

test("buildNowPlayingControls includes loop toggle and omits activity shortcut", () => {
  const row = buildNowPlayingControls();
  const customIds = row.components.map((component) => component?.data?.custom_id);

  assert.deepEqual(customIds, ["np_queue", "np_toggle", "np_loop", "np_skip", "np_stop"]);
});
