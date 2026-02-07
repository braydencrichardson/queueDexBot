const test = require("node:test");
const assert = require("node:assert/strict");

const {
  enqueueTracks,
  ensureTrackId,
  getTrackIndexById,
  getQueuedTrackIndex,
  formatDuration,
} = require("../src/queue/utils");

test("enqueueTracks assigns IDs and appends in order", () => {
  const queue = { tracks: [] };
  const tracks = [
    { title: "First", url: "https://example.com/1", requester: "u1" },
    { title: "Second", url: "https://example.com/2", requester: "u2" },
  ];

  enqueueTracks(queue, tracks);

  assert.equal(queue.tracks.length, 2);
  assert.equal(queue.tracks[0].title, "First");
  assert.equal(queue.tracks[1].title, "Second");
  assert.match(queue.tracks[0].id, /^t_\d+_\d+$/);
  assert.match(queue.tracks[1].id, /^t_\d+_\d+$/);
});

test("ensureTrackId keeps existing IDs unchanged", () => {
  const track = { id: "fixed-id", title: "Song" };

  ensureTrackId(track);

  assert.equal(track.id, "fixed-id");
});

test("ensureTrackId sanitizes control characters in track metadata", () => {
  const track = {
    title: "Bad\u0000Title\nLine",
    requester: "Req\u0007User\r\nName",
    channel: "Chan\u0000nel\tName",
  };

  ensureTrackId(track);

  assert.equal(track.title, "BadTitle Line");
  assert.equal(track.requester, "ReqUser Name");
  assert.equal(track.channel, "Channel Name");
  assert.match(track.id, /^t_\d+_\d+$/);
});

test("getTrackIndexById returns index or -1", () => {
  const queue = {
    tracks: [{ id: "a" }, { id: "b" }, { id: "c" }],
  };

  assert.equal(getTrackIndexById(queue, "b"), 1);
  assert.equal(getTrackIndexById(queue, "missing"), -1);
});

test("getQueuedTrackIndex matches by ID first, then fallback fields", () => {
  const byIdQueue = {
    tracks: [{ id: "x1", title: "One", url: "u1", requester: "r1" }],
  };
  assert.equal(getQueuedTrackIndex(byIdQueue, { id: "x1" }), 0);

  const fallbackQueue = {
    tracks: [{ title: "One", url: "u1", requester: "r1" }],
  };
  assert.equal(getQueuedTrackIndex(fallbackQueue, { title: "One", url: "u1", requester: "r1" }), 0);
  assert.equal(getQueuedTrackIndex(fallbackQueue, { title: "Nope", url: "u1", requester: "r1" }), -1);
});

test("formatDuration formats mm:ss and hh:mm:ss", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(-5), "");
  assert.equal(formatDuration(NaN), "");
});
