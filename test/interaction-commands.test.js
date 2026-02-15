const test = require("node:test");
const assert = require("node:assert/strict");

const { createCommandInteractionHandler } = require("../src/handlers/interaction-commands");

function createDeps(overrides = {}) {
  const queue = overrides.queue || {
    tracks: [],
    current: null,
    voiceChannel: { id: "vc-bot" },
    connection: null,
    player: { id: "player-1" },
  };

  return {
    queue,
    deps: {
      INTERACTION_TIMEOUT_MS: 45000,
      QUEUE_VIEW_PAGE_SIZE: 10,
      QUEUE_VIEW_TIMEOUT_MS: 300000,
      joinVoiceChannel: () => ({
        on: () => {},
        subscribe: () => {},
        destroy: () => {},
      }),
      getGuildQueue: () => queue,
      formatQueueViewContent: () => ({ content: "", page: 1 }),
      buildQueueViewComponents: () => [],
      buildQueuedActionComponents: () => [],
      buildPlaylistQueuedComponents: () => [],
      ensureTrackId: () => {},
      getQueuedTrackIndex: () => -1,
      enqueueTracks: () => {},
      pendingQueuedActions: new Map(),
      queueViews: new Map(),
      logInfo: () => {},
      logError: () => {},
      sendNowPlaying: async () => {},
      maybeRefreshNowPlayingUpNext: async () => {},
      playNext: async () => {},
      normalizeQueryInput: (value) => value,
      ensureSodiumReady: async () => {},
      ensurePlayerListeners: () => {},
      trySendSearchChooser: async () => false,
      getSearchOptionsForQuery: async () => [],
      resolveTracks: async () => [],
      isSpotifyUrl: () => false,
      hasSpotifyCredentials: () => true,
      stopAndLeaveQueue: () => {},
      ...overrides.deps,
    },
  };
}

test("stop replies ephemerally when nothing is playing and queue is empty", async () => {
  let replyPayload = null;
  let stopCalled = false;
  const { deps } = createDeps({
    deps: {
      stopAndLeaveQueue: () => {
        stopCalled = true;
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: null } },
    commandName: "stop",
    options: {},
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(stopCalled, false);
  assert.deepEqual(replyPayload, { content: "Nothing is playing and the queue is empty.", ephemeral: true });
});

test("stop requires caller in voice channel when there is active playback", async () => {
  let replyPayload = null;
  let stopCalled = false;
  const queue = {
    tracks: [],
    current: { title: "Now Playing" },
    voiceChannel: { id: "vc-bot" },
    connection: null,
    player: { id: "player-1" },
  };
  const { deps } = createDeps({
    queue,
    deps: {
      stopAndLeaveQueue: () => {
        stopCalled = true;
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: null } },
    commandName: "stop",
    options: {},
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(stopCalled, false);
  assert.deepEqual(replyPayload, { content: "Join a voice channel first.", ephemeral: true });
});

test("queue clear reports already empty before voice-channel checks", async () => {
  let replyPayload = null;
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: { id: "vc-bot" },
    connection: null,
    player: { id: "player-1" },
  };
  const { deps } = createDeps({ queue });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: null } },
    commandName: "queue",
    options: {
      getSubcommand: () => "clear",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.deepEqual(replyPayload, { content: "Queue is already empty.", ephemeral: true });
});

test("queue clear requires user in voice channel before mutating queue", async () => {
  let replyPayload = null;
  const queue = {
    tracks: [{ title: "Track 1" }],
    current: { title: "Now Playing" },
    voiceChannel: { id: "vc-bot" },
    connection: null,
    player: { id: "player-1" },
  };
  const { deps } = createDeps({ queue });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: null } },
    commandName: "queue",
    options: {
      getSubcommand: () => "clear",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(queue.tracks.length, 1);
  assert.deepEqual(replyPayload, { content: "Join a voice channel first.", ephemeral: true });
});

test("join command connects bot to caller voice channel", async () => {
  let replyPayload = null;
  let sodiumReadyCalled = false;
  let ensureListenersCalled = false;
  let subscribeCalledWith = null;
  const connection = {
    on: () => {},
    subscribe: (player) => {
      subscribeCalledWith = player;
    },
    destroy: () => {},
  };
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: null,
    connection: null,
    player: { id: "player-1" },
  };
  const voiceChannel = {
    id: "vc-1",
    name: "General",
    guild: { id: "guild-1", voiceAdapterCreator: {} },
  };
  const { deps } = createDeps({
    queue,
    deps: {
      ensureSodiumReady: async () => {
        sodiumReadyCalled = true;
      },
      ensurePlayerListeners: () => {
        ensureListenersCalled = true;
      },
      joinVoiceChannel: () => connection,
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: voiceChannel } },
    commandName: "join",
    options: {},
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(sodiumReadyCalled, true);
  assert.equal(ensureListenersCalled, true);
  assert.equal(queue.voiceChannel, voiceChannel);
  assert.equal(queue.connection, connection);
  assert.equal(subscribeCalledWith, queue.player);
  assert.equal(replyPayload, "Joined **General**.");
});

test("queue loop single injects a tagged loop item at position 1", async () => {
  let refreshedQueue = null;
  let replyPayload = null;
  const queue = {
    tracks: [{ id: "next-1", title: "Next", url: "https://youtu.be/next" }],
    current: { id: "now-1", title: "Now", url: "https://youtu.be/now" },
    voiceChannel: { id: "vc-1" },
    connection: null,
    player: { id: "player-1" },
    loopMode: "off",
  };
  let generatedId = 1;
  const { deps } = createDeps({
    queue,
    deps: {
      ensureTrackId: (track) => {
        if (!track.id) {
          track.id = `generated-${generatedId++}`;
        }
      },
      maybeRefreshNowPlayingUpNext: async (guildQueue) => {
        refreshedQueue = guildQueue;
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: { id: "vc-1" } } },
    commandName: "queue",
    options: {
      getSubcommand: () => "loop",
      getString: () => "single",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(queue.loopMode, "single");
  assert.equal(queue.tracks[0].loopTag, "single");
  assert.equal(queue.tracks[0].loopSourceTrackKey, "now-1");
  assert.equal(refreshedQueue, queue);
  assert.equal(String(replyPayload).includes("Loop mode set to **single**"), true);
});

test("queue loop off removes generated loop entries", async () => {
  let replyPayload = null;
  const queue = {
    tracks: [
      {
        id: "loop-1",
        title: "Now",
        url: "https://youtu.be/now",
        loopTag: "single",
        loopSourceTrackKey: "now-1",
      },
      {
        id: "loop-2",
        title: "Now",
        url: "https://youtu.be/now",
        loopTag: "queue",
        loopSourceTrackKey: "now-1",
      },
      { id: "next-1", title: "Next", url: "https://youtu.be/next" },
    ],
    current: { id: "now-1", title: "Now", url: "https://youtu.be/now" },
    voiceChannel: { id: "vc-1" },
    connection: null,
    player: { id: "player-1" },
    loopMode: "single",
  };
  const { deps } = createDeps({ queue });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: { id: "vc-1" } } },
    commandName: "queue",
    options: {
      getSubcommand: () => "loop",
      getString: () => "off",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(queue.loopMode, "off");
  assert.equal(queue.tracks.length, 1);
  assert.equal(replyPayload, "Loop mode set to **off**.");
});

test("queue loop updates active queue view when loop-generated tracks are removed", async () => {
  let replyPayload = null;
  let editedPayload = null;
  const queue = {
    tracks: [
      {
        id: "loop-1",
        title: "Now",
        url: "https://youtu.be/now",
        loopTag: "single",
        loopSourceTrackKey: "now-1",
      },
      { id: "next-1", title: "Next", url: "https://youtu.be/next" },
    ],
    current: { id: "now-1", title: "Now", url: "https://youtu.be/now" },
    voiceChannel: { id: "vc-1" },
    connection: null,
    player: { id: "player-1" },
    loopMode: "single",
  };
  const queueViews = new Map([
    ["queue-view-1", {
      guildId: "guild-1",
      ownerId: "user-1",
      ownerName: "User",
      page: 1,
      pageSize: 10,
      selectedTrackId: "loop-1",
      stale: false,
      channelId: "text-1",
      timeout: setTimeout(() => {}, 5000),
    }],
  ]);
  const { deps } = createDeps({
    queue,
    deps: {
      queueViews,
      formatQueueViewContent: (guildQueue) => ({
        content: `tracks:${guildQueue.tracks.length}`,
        page: 1,
      }),
      buildQueueViewComponents: () => [],
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    client: {
      channels: {
        cache: new Map([
          ["text-1", {
            messages: {
              fetch: async () => ({
                edit: async (payload) => {
                  editedPayload = payload;
                },
              }),
            },
          }],
        ]),
      },
    },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: { id: "vc-1" } } },
    commandName: "queue",
    options: {
      getSubcommand: () => "loop",
      getString: () => "off",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(queue.loopMode, "off");
  assert.equal(queue.tracks.length, 1);
  assert.equal(String(replyPayload).includes("Loop mode set to **off**"), true);
  assert.equal(editedPayload?.content, "tracks:1");
  clearTimeout(queueViews.get("queue-view-1")?.timeout);
});
