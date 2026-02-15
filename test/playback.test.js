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

test("playNext uses preloaded resource for current track when cache key matches", async () => {
  const track = { id: "abc", source: "youtube", url: "https://youtu.be/abc", title: "Song" };
  const preloadedResource = { id: "preloaded-resource" };
  const queue = {
    tracks: [track],
    preloadedNextTrackKey: "abc",
    preloadedNextResource: preloadedResource,
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

  let youtubeCreateCalls = 0;
  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => {
      youtubeCreateCalls += 1;
      return "yt-resource";
    },
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(queue.player.played, preloadedResource);
  assert.equal(youtubeCreateCalls, 0);
  assert.equal(queue.preloadedNextTrackKey, null);
  assert.equal(queue.preloadedNextResource, null);
});

test("playNext uses soundcloud resource provider for soundcloud tracks", async () => {
  const track = { source: "soundcloud", url: "https://soundcloud.com/example/track", title: "Song" };
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

  let soundcloudCreateCalls = 0;
  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => {
      throw new Error("youtube provider should not be used for soundcloud track");
    },
    createSoundcloudResource: async () => {
      soundcloudCreateCalls += 1;
      return "sc-resource";
    },
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(soundcloudCreateCalls, 1);
  assert.equal(queue.player.played, "sc-resource");
});

test("playNext preloads the next track immediately after current playback starts", async () => {
  const currentTrack = { id: "current", source: "youtube", url: "https://youtu.be/current", title: "Current", duration: 12 };
  const upNextTrack = { id: "next", source: "youtube", url: "https://youtu.be/next", title: "Next" };
  const queue = {
    tracks: [currentTrack, upNextTrack],
    playing: false,
    current: null,
    connection: {
      subscribe() {},
      destroy() {},
    },
    player: {
      play() {},
    },
    textChannel: null,
  };

  const createdResources = [];
  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async (url) => {
      const resource = { url };
      createdResources.push(resource);
      return resource;
    },
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createdResources.length, 2);
  assert.equal(createdResources[0].url, currentTrack.url);
  assert.equal(queue.preloadedNextTrackKey, "next");
  assert.deepEqual(queue.preloadedNextResource, createdResources[1]);
});

test("ensureNextTrackPreload ignores stale in-flight preload results after queue reorder", async () => {
  const currentTrack = { id: "current", source: "youtube", url: "https://youtu.be/current", title: "Current" };
  const firstTrack = { id: "first", source: "youtube", url: "https://youtu.be/first", title: "First" };
  const secondTrack = { id: "second", source: "youtube", url: "https://youtu.be/second", title: "Second" };
  const queue = {
    current: currentTrack,
    tracks: [firstTrack, secondTrack],
  };

  const resolvers = new Map();
  const { ensureNextTrackPreload } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async (url) => new Promise((resolve) => {
      resolvers.set(url, resolve);
    }),
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  const preloadFirstPromise = ensureNextTrackPreload(queue);
  queue.tracks = [secondTrack, firstTrack];
  const preloadSecondPromise = ensureNextTrackPreload(queue);

  resolvers.get(firstTrack.url)({ id: "resource-first" });
  await preloadFirstPromise;
  assert.equal(queue.preloadedNextTrackKey ?? null, null);

  resolvers.get(secondTrack.url)({ id: "resource-second" });
  await preloadSecondPromise;

  assert.equal(queue.preloadedNextTrackKey, "second");
  assert.deepEqual(queue.preloadedNextResource, { id: "resource-second" });
});

test("playNext reuses in-flight preload when skipped before preload completes", async () => {
  const currentTrack = { id: "current", source: "youtube", url: "https://youtu.be/current", title: "Current" };
  const nextTrack = { id: "next", source: "youtube", url: "https://youtu.be/next", title: "Next" };
  const queue = {
    tracks: [currentTrack, nextTrack],
    playing: false,
    current: null,
    connection: {
      subscribe() {},
      destroy() {},
    },
    player: {
      played: [],
      play(resource) {
        this.played.push(resource);
      },
    },
    textChannel: null,
  };

  let resolveNextResource;
  let nextLoadCalls = 0;
  const logMessages = [];
  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async (url) => {
      if (url === currentTrack.url) {
        return { id: "resource-current" };
      }
      if (url === nextTrack.url) {
        nextLoadCalls += 1;
        return new Promise((resolve) => {
          resolveNextResource = resolve;
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: (message) => {
      logMessages.push(message);
    },
    logError: () => {},
  });

  await playNext("guild-1");
  const skipTransition = playNext("guild-1");
  resolveNextResource({ id: "resource-next" });
  await skipTransition;

  assert.equal(nextLoadCalls, 1);
  assert.equal(queue.player.played.length, 2);
  assert.deepEqual(queue.player.played[1], { id: "resource-next" });
  assert.equal(logMessages.includes("Waiting for in-flight preload before playback transition"), true);
});

test("ensureNextTrackPreload disposes stale cached resource when preload target changes", async () => {
  const queue = {
    current: { id: "current", source: "youtube", url: "https://youtu.be/current", title: "Current" },
    tracks: [{ id: "next", source: "youtube", url: "https://youtu.be/next", title: "Next" }],
    preloadedNextTrackKey: "old",
    preloadedNextResource: {
      __queueDexDispose: () => {},
    },
  };

  let disposed = 0;
  queue.preloadedNextResource.__queueDexDispose = () => {
    disposed += 1;
  };

  const { ensureNextTrackPreload } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async () => ({ id: "resource-next" }),
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await ensureNextTrackPreload(queue);

  assert.equal(disposed, 1);
  assert.equal(queue.preloadedNextTrackKey, "next");
  assert.deepEqual(queue.preloadedNextResource, { id: "resource-next" });
});

test("playNext with queue loop re-appends the finished track to the end", async () => {
  const previousTrack = { id: "a", source: "youtube", url: "https://youtu.be/a", title: "A" };
  const nextTrack = { id: "b", source: "youtube", url: "https://youtu.be/b", title: "B" };
  const queue = {
    loopMode: "queue",
    current: previousTrack,
    tracks: [nextTrack],
    playing: true,
    connection: {
      subscribe() {},
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

  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async (url) => ({ url }),
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(queue.current.id, "b");
  assert.equal(queue.tracks.length, 1);
  assert.equal(queue.tracks[0].title, "A");
  assert.notEqual(queue.tracks[0].id, "a");
  assert.equal(queue.tracks[0].loopTag, "queue");
  assert.equal(queue.tracks[0].loopSourceTrackKey, "a");
});

test("playNext with single loop keeps next position primed with another loop clone", async () => {
  const currentTrack = { id: "a", source: "youtube", url: "https://youtu.be/a", title: "A" };
  const nextTrack = { id: "b", source: "youtube", url: "https://youtu.be/b", title: "B" };
  const queue = {
    loopMode: "single",
    current: currentTrack,
    tracks: [nextTrack],
    playing: true,
    connection: {
      subscribe() {},
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

  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async (url) => ({ url }),
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");

  assert.equal(queue.current.title, "A");
  assert.equal(queue.current.loopTag, "single");
  assert.equal(queue.current.loopSourceTrackKey, "a");
  assert.notEqual(queue.current.id, "a");
  assert.equal(queue.tracks[0].loopTag, "single");
  assert.equal(queue.tracks[0].loopSourceTrackKey, "a");
  assert.notEqual(queue.tracks[0].id, queue.current.id);
  assert.equal(queue.tracks[1].id, "b");
});

test("single loop survives repeated skip transitions without losing the loop slot", async () => {
  const currentTrack = { id: "a", source: "youtube", url: "https://youtu.be/a", title: "A" };
  const queue = {
    loopMode: "single",
    current: currentTrack,
    tracks: [],
    playing: true,
    connection: {
      subscribe() {},
      destroy() {},
    },
    player: {
      played: [],
      play(resource) {
        this.played.push(resource);
      },
    },
    textChannel: null,
  };

  const { playNext } = createQueuePlayback({
    playdl: { stream: async () => ({ stream: null, type: null }) },
    createAudioResource: () => ({}),
    StreamType: { Arbitrary: "arbitrary" },
    createYoutubeResource: async (url) => ({ url }),
    getGuildQueue: () => queue,
    queueViews: new Map(),
    sendNowPlaying: async () => null,
    logInfo: () => {},
    logError: () => {},
  });

  await playNext("guild-1");
  const firstLoopCurrentId = queue.current.id;
  assert.equal(queue.tracks[0].loopTag, "single");

  await playNext("guild-1");
  assert.notEqual(queue.current.id, firstLoopCurrentId);
  assert.equal(queue.current.loopTag, "single");
  assert.equal(queue.tracks[0].loopTag, "single");
});
