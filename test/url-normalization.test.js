const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeIncomingUrl } = require("../src/utils/url-normalization");

test("normalizeIncomingUrl upgrades http URLs to https", () => {
  assert.equal(
    normalizeIncomingUrl("http://example.com/path?a=1"),
    "https://example.com/path?a=1"
  );
});

test("normalizeIncomingUrl normalizes youtube.com host to www", () => {
  assert.equal(
    normalizeIncomingUrl("http://youtube.com/watch?v=SqD_8FGk89o"),
    "https://www.youtube.com/watch?v=SqD_8FGk89o"
  );
});

test("normalizeIncomingUrl leaves non-URLs unchanged", () => {
  assert.equal(normalizeIncomingUrl("not a url"), "not a url");
});
