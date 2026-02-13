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

test("stop replies ephemerally when user is not in a voice channel", async () => {
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
  assert.deepEqual(replyPayload, { content: "Join a voice channel first.", ephemeral: true });
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
