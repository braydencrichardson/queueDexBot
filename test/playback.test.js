const test = require("node:test");
const assert = require("node:assert/strict");

const { createQueuePlayback } = require("../src/queue/playback");

test("playNext clears state and destroys connection when queue is empty", async () => {
  const queue = {
    tracks: [],
    playing: true,
    current: { title: "Old" },
    voiceChannel: { id: "vc-1" },
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
  assert.equal(queue.voiceChannel, null);
});

test("playNext notifies channel when queue ends naturally", async () => {
  const sentMessages = [];
  const queue = {
    tracks: [],
    playing: true,
    current: { title: "Old" },
    voiceChannel: { id: "vc-1" },
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
    textChannel: {
      async send(content) {
        sentMessages.push(content);
        return { delete: async () => {} };
      },
    },
  };

  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => ({}),
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(sentMessages.includes("Queue finished. Leaving voice channel."), true);
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

test("playNext skips malformed tracks, notifies channel once, and continues playback", async () => {
  const validTrack = { source: "youtube", url: "https://youtu.be/ok", title: "Playable" };
  const sentMessages = [];
  const queue = {
    tracks: [
      { source: "soundcloud", title: undefined, url: undefined, id: "bad-1" },
      { source: "soundcloud", title: undefined, url: undefined, id: "bad-2" },
      validTrack,
    ],
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
    textChannel: {
      async send(content) {
        sentMessages.push(content);
        return { delete: async () => {} };
      },
    },
  };

  let nowPlayingCalled = false;
  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => "yt-resource",
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => {
      nowPlayingCalled = true;
    },
    loadingMessageDelayMs: 0,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(queue.current, validTrack);
  assert.equal(queue.player.played, "yt-resource");
  assert.equal(nowPlayingCalled, true);
  assert.equal(sentMessages.some((text) => String(text).includes("Skipped 2 malformed queue entries")), true);
});

test("playNext notifies channel and leaves when no playable tracks remain", async () => {
  const sentMessages = [];
  const queue = {
    tracks: [
      { source: "soundcloud", title: undefined, url: undefined, id: "bad-1" },
      { source: "soundcloud", title: undefined, url: undefined, id: "bad-2" },
    ],
    playing: true,
    current: { title: "Old" },
    voiceChannel: { id: "vc-1" },
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
    textChannel: {
      async send(content) {
        sentMessages.push(content);
        return { delete: async () => {} };
      },
    },
  };

  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => ({}) ,
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    loadingMessageDelayMs: 0,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(queue.playing, false);
  assert.equal(queue.current, null);
  assert.equal(queue.connection, null);
  assert.equal(queue.voiceChannel, null);
  assert.equal(sentMessages.some((text) => String(text).includes("No playable tracks remain; leaving voice channel.")), true);
});
