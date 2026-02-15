const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LOOP_MODES,
  prepareQueueForNextTrack,
  setQueueLoopMode,
  syncLoopState,
} = require("../src/queue/loop");

function createEnsureTrackId() {
  let counter = 1;
  return (track) => {
    if (!track.id) {
      track.id = `track-${counter++}`;
    }
  };
}

test("setQueueLoopMode(single) inserts tagged loop track at the front", () => {
  const ensureTrackId = createEnsureTrackId();
  const queue = {
    loopMode: LOOP_MODES.OFF,
    current: { id: "now-1", title: "Current", url: "https://youtu.be/current" },
    tracks: [{ id: "next-1", title: "Next", url: "https://youtu.be/next" }],
  };

  const result = setQueueLoopMode(queue, LOOP_MODES.SINGLE, ensureTrackId);

  assert.equal(result.mode, LOOP_MODES.SINGLE);
  assert.equal(queue.tracks.length, 2);
  assert.equal(queue.tracks[0].loopTag, "single");
  assert.equal(queue.tracks[0].loopSourceTrackKey, "now-1");
  assert.equal(queue.tracks[0].title, queue.current.title);
  assert.notEqual(queue.tracks[0].id, queue.current.id);
});

test("setQueueLoopMode(off) removes previously generated loop tracks", () => {
  const ensureTrackId = createEnsureTrackId();
  const queue = {
    loopMode: LOOP_MODES.QUEUE,
    current: { id: "now-1", title: "Current", url: "https://youtu.be/current" },
    tracks: [
      {
        id: "loop-1",
        title: "Current",
        url: "https://youtu.be/current",
        loopTag: "single",
        loopSourceTrackKey: "now-1",
      },
      {
        id: "loop-2",
        title: "Current",
        url: "https://youtu.be/current",
        loopTag: "queue",
        loopSourceTrackKey: "now-1",
      },
      { id: "next-1", title: "Next", url: "https://youtu.be/next" },
    ],
  };

  const result = setQueueLoopMode(queue, LOOP_MODES.OFF, ensureTrackId);

  assert.equal(result.mode, LOOP_MODES.OFF);
  assert.equal(result.removed, 2);
  assert.equal(queue.tracks.length, 1);
  assert.equal(queue.tracks[0].id, "next-1");
});

test("prepareQueueForNextTrack(queue) appends finished track back to queue", () => {
  const ensureTrackId = createEnsureTrackId();
  const queue = {
    loopMode: LOOP_MODES.QUEUE,
    current: {
      id: "loop-generated",
      title: "Now",
      url: "https://youtu.be/now",
      loopTag: "single",
      loopSourceTrackKey: "original-id",
    },
    tracks: [{ id: "next-1", title: "Next", url: "https://youtu.be/next" }],
  };

  const result = prepareQueueForNextTrack(queue, ensureTrackId);

  assert.equal(result.mode, LOOP_MODES.QUEUE);
  assert.equal(result.requeuedCurrent, true);
  assert.equal(queue.tracks.length, 2);
  assert.equal(queue.tracks[1].title, "Now");
  assert.equal(queue.tracks[1].loopTag, "queue");
  assert.equal(queue.tracks[1].loopSourceTrackKey, "original-id");
  assert.notEqual(queue.tracks[1].id, queue.current.id);
});

test("syncLoopState(single) keeps one matching front loop track and removes stale extras", () => {
  const ensureTrackId = createEnsureTrackId();
  const queue = {
    loopMode: LOOP_MODES.SINGLE,
    current: { id: "now-1", title: "Current", url: "https://youtu.be/current" },
    tracks: [
      {
        id: "loop-keep",
        title: "Current",
        url: "https://youtu.be/current",
        loopTag: "single",
        loopSourceTrackKey: "now-1",
      },
      {
        id: "loop-stale",
        title: "Old",
        url: "https://youtu.be/old",
        loopTag: "single",
        loopSourceTrackKey: "old-id",
      },
      { id: "next-1", title: "Next", url: "https://youtu.be/next" },
    ],
  };

  const result = syncLoopState(queue, ensureTrackId);

  assert.equal(result.inserted, false);
  assert.equal(result.removed, 1);
  assert.equal(queue.tracks.length, 2);
  assert.equal(queue.tracks[0].id, "loop-keep");
  assert.equal(queue.tracks[1].id, "next-1");
});

test("setQueueLoopMode(single) removes queue-generated loop tracks", () => {
  const ensureTrackId = createEnsureTrackId();
  const queue = {
    loopMode: LOOP_MODES.QUEUE,
    current: { id: "now-1", title: "Current", url: "https://youtu.be/current" },
    tracks: [
      {
        id: "queue-loop-1",
        title: "Current",
        url: "https://youtu.be/current",
        loopTag: "queue",
        loopSourceTrackKey: "now-1",
      },
      { id: "next-1", title: "Next", url: "https://youtu.be/next" },
    ],
  };

  const result = setQueueLoopMode(queue, LOOP_MODES.SINGLE, ensureTrackId);

  assert.equal(result.mode, LOOP_MODES.SINGLE);
  assert.equal(result.removed, 1);
  assert.equal(queue.tracks[0].loopTag, "single");
  assert.equal(queue.tracks[1].id, "next-1");
});
