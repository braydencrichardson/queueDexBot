const test = require("node:test");
const assert = require("node:assert/strict");

const { createQueuePlayback } = require("../src/queue/playback");

test("playNext clears state and destroys connection when queue is empty", async () => {
  const queue = {
    tracks: [],
    playing: true,
    current: { title: "Old" },
    connection: {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    },
    player: {
      play() {
        throw new Error("should not play");
      },
    },
    textChannel: null,
  };

  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => ({}) ,
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(queue.playing, false);
  assert.equal(queue.current, null);
  assert.equal(queue.connection, null);
});

test("playNext plays next track, subscribes connection, marks queue view stale, and sends now playing", async () => {
  const track = { source: "youtube", url: "https://youtu.be/abc", title: "Song" };
  const queue = {
    tracks: [track],
    playing: false,
    current: null,
    connection: {
      subscribedWith: null,
      subscribe(player) {
        this.subscribedWith = player;
      },
      destroy() {},
    },
    player: {
      played: null,
      play(resource) {
        this.played = resource;
      },
    },
    textChannel: null,
  };

  const queueViews = new Map([["msg-1", { guildId: "guild-1", stale: false }]]);
  let nowPlayingCalled = false;

  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => "yt-resource",
    getGuildQueue: () => queue,
    queueViews,
    sendNowPlaying: async (q, forceNew) => {
      nowPlayingCalled = true;
      assert.equal(q, queue);
      assert.equal(forceNew, true);
    },
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(queue.playing, true);
  assert.equal(queue.current, track);
  assert.equal(queue.tracks.length, 0);
  assert.equal(queue.player.played, "yt-resource");
  assert.equal(queue.connection.subscribedWith, queue.player);
  assert.equal(queueViews.get("msg-1").stale, true);
  assert.equal(nowPlayingCalled, true);
});
