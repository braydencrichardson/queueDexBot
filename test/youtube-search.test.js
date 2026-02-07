const test = require("node:test");
const assert = require("node:assert/strict");

const { getYoutubeId, toShortYoutubeUrl } = require("../src/providers/youtube-search");

test("getYoutubeId extracts IDs from common URL formats", () => {
  assert.equal(getYoutubeId("IrdYueB9pY4"), "IrdYueB9pY4");
  assert.equal(getYoutubeId("https://www.youtube.com/watch?v=IrdYueB9pY4"), "IrdYueB9pY4");
  assert.equal(getYoutubeId("https://youtu.be/IrdYueB9pY4"), "IrdYueB9pY4");
  assert.equal(getYoutubeId("https://www.youtube.com/shorts/IrdYueB9pY4"), "IrdYueB9pY4");
});

test("getYoutubeId returns null for invalid inputs", () => {
  assert.equal(getYoutubeId(""), null);
  assert.equal(getYoutubeId("not-a-url"), null);
  assert.equal(getYoutubeId("https://example.com/video"), null);
});

test("toShortYoutubeUrl normalizes to youtu.be when possible", () => {
  assert.equal(
    toShortYoutubeUrl("https://www.youtube.com/shorts/eLvXS6J_ETQ"),
    "https://youtu.be/eLvXS6J_ETQ"
  );
  assert.equal(toShortYoutubeUrl("eLvXS6J_ETQ"), "https://youtu.be/eLvXS6J_ETQ");
  assert.equal(toShortYoutubeUrl("https://example.com/video"), "https://example.com/video");
});
