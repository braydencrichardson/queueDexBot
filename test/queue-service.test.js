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

test("resume ensures voice connection before unpausing when configured", async () => {
  let ensureVoiceConnectionArgs = null;
  let unpauseCalled = false;
  const service = createQueueService({
    ensureVoiceConnection: async (queue, options) => {
      ensureVoiceConnectionArgs = { queue, options };
      return { ok: true };
    },
  });
  const queue = {
    current: { id: "track-1" },
    player: {
      unpause() {
        unpauseCalled = true;
      },
    },
  };

  const result = await service.resume(queue, {
    ensureVoiceConnection: true,
    ensureVoiceConnectionOptions: { guildId: "guild-1", preferredVoiceChannelId: "voice-1" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "resume");
  assert.equal(unpauseCalled, true);
  assert.deepEqual(ensureVoiceConnectionArgs, {
    queue,
    options: { guildId: "guild-1", preferredVoiceChannelId: "voice-1" },
  });
});

test("resume fails without unpause when voice reconnect fails", async () => {
  let unpauseCalled = false;
  const service = createQueueService({
    ensureVoiceConnection: async () => ({
      ok: false,
      statusCode: 503,
      error: "Voice connection unavailable",
    }),
  });
  const queue = {
    current: { id: "track-1" },
    player: {
      unpause() {
        unpauseCalled = true;
      },
    },
  };

  const result = await service.resume(queue, {
    ensureVoiceConnection: true,
    ensureVoiceConnectionOptions: { guildId: "guild-1" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "VOICE_CONNECTION_FAILED");
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, "Voice connection unavailable");
  assert.equal(unpauseCalled, false);
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

test("shuffle fails with fewer than two tracks", async () => {
  const service = createQueueService();
  const queue = {
    tracks: [{ title: "Only track" }],
  };

  const result = await service.shuffle(queue);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INSUFFICIENT_TRACKS");
  assert.equal(result.statusCode, 409);
});

test("removeAt removes selected track and refreshes queue summary", async () => {
  let refreshed = false;
  const service = createQueueService({
    maybeRefreshNowPlayingUpNext: async () => {
      refreshed = true;
    },
  });
  const queue = {
    tracks: [{ title: "A" }, { title: "B" }, { title: "C" }],
  };

  const result = await service.removeAt(queue, 2, {
    refreshNowPlayingUpNext: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "remove");
  assert.equal(result.removed.title, "B");
  assert.equal(queue.tracks.length, 2);
  assert.equal(queue.tracks[0].title, "A");
  assert.equal(queue.tracks[1].title, "C");
  assert.equal(refreshed, true);
});

test("move reorders tracks", async () => {
  const service = createQueueService();
  const queue = {
    tracks: [{ title: "A" }, { title: "B" }, { title: "C" }],
  };

  const result = await service.move(queue, 3, 1);

  assert.equal(result.ok, true);
  assert.equal(result.action, "move");
  assert.equal(result.moved.title, "C");
  assert.deepEqual(queue.tracks.map((track) => track.title), ["C", "A", "B"]);
});

test("moveToFront promotes track to first position", async () => {
  const service = createQueueService();
  const queue = {
    tracks: [{ title: "A" }, { title: "B" }, { title: "C" }],
  };

  const result = await service.moveToFront(queue, 2);

  assert.equal(result.ok, true);
  assert.equal(result.action, "move_to_front");
  assert.equal(result.moved.title, "B");
  assert.deepEqual(queue.tracks.map((track) => track.title), ["B", "A", "C"]);
});

test("setLoopMode syncs loop state and refreshes outputs", async () => {
  let refreshedUpNext = false;
  let refreshedNowPlaying = false;
  let generatedId = 0;
  const service = createQueueService({
    maybeRefreshNowPlayingUpNext: async () => {
      refreshedUpNext = true;
    },
    sendNowPlaying: async () => {
      refreshedNowPlaying = true;
    },
    ensureTrackId: (track) => {
      if (!track.id) {
        generatedId += 1;
        track.id = `generated-${generatedId}`;
      }
    },
  });
  const queue = {
    current: {
      id: "now-1",
      title: "Now",
      url: "https://youtu.be/now",
    },
    tracks: [],
    loopMode: "off",
  };

  const result = await service.setLoopMode(queue, "single", {
    refreshNowPlayingUpNext: true,
    refreshNowPlaying: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "loop");
  assert.equal(result.loopResult.previousMode, "off");
  assert.equal(result.loopResult.mode, "single");
  assert.equal(refreshedUpNext, true);
  assert.equal(refreshedNowPlaying, true);
  assert.equal(queue.tracks[0].loopTag, "single");
  assert.equal(Boolean(queue.tracks[0].id), true);
});

test("applyQueueAction routes to move and validates params", async () => {
  const service = createQueueService();
  const queue = {
    tracks: [{ title: "A" }, { title: "B" }, { title: "C" }],
  };

  const moveResult = await service.applyQueueAction(queue, "move", {
    fromPosition: 1,
    toPosition: 3,
  });

  assert.equal(moveResult.ok, true);
  assert.equal(moveResult.action, "move");
  assert.deepEqual(queue.tracks.map((track) => track.title), ["B", "C", "A"]);

  const invalidResult = await service.applyQueueAction(queue, "remove", {
    position: 99,
  });
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.code, "INVALID_POSITION");
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
