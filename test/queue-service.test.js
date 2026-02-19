const test = require("node:test");
const assert = require("node:assert/strict");

const { createQueueService } = require("../src/queue/service");

test("pause fails when nothing is currently playing", async () => {
  const service = createQueueService();
  const queue = {
    current: null,
    player: {
      pause() {
        throw new Error("should not pause");
      },
    },
  };

  const result = await service.pause(queue);
  assert.equal(result.ok, false);
  assert.equal(result.code, "NOTHING_PLAYING");
  assert.equal(result.statusCode, 409);
});

test("applyControlAction pause refreshes now playing when configured", async () => {
  let pauseCalled = false;
  let sendNowPlayingArgs = null;
  const service = createQueueService({
    sendNowPlaying: async (queue, forceNew) => {
      sendNowPlayingArgs = { queue, forceNew };
    },
  });
  const queue = {
    current: { id: "track-1" },
    player: {
      pause() {
        pauseCalled = true;
      },
    },
  };

  const result = await service.applyControlAction(queue, "pause", {
    refreshNowPlayingOnPauseResume: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "pause");
  assert.equal(pauseCalled, true);
  assert.deepEqual(sendNowPlayingArgs, { queue, forceNew: false });
});

test("clear returns removed count and refreshes now playing up next when configured", async () => {
  let refreshCalledWith = null;
  const service = createQueueService({
    maybeRefreshNowPlayingUpNext: async (queue) => {
      refreshCalledWith = queue;
    },
  });
  const queue = {
    tracks: [{ title: "A" }, { title: "B" }, { title: "C" }],
  };

  const result = await service.clear(queue, {
    refreshNowPlayingUpNext: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "clear");
  assert.equal(result.removedCount, 3);
  assert.deepEqual(queue.tracks, []);
  assert.equal(refreshCalledWith, queue);
});

test("stop delegates with provided reason", async () => {
  let stopped = null;
  const service = createQueueService({
    stopAndLeaveQueue: (queue, reason) => {
      stopped = { queue, reason };
    },
  });
  const queue = { guildId: "guild-1" };

  const result = await service.stop(queue, {
    reason: "test-stop",
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "stop");
  assert.deepEqual(stopped, { queue, reason: "test-stop" });
});

test("applyControlAction rejects unsupported action", async () => {
  const service = createQueueService();
  const result = await service.applyControlAction({}, "dance");

  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED_ACTION");
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, "Unsupported action: dance");
});
