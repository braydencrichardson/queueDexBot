const test = require("node:test");
const assert = require("node:assert/strict");

const { createButtonInteractionHandler } = require("../src/handlers/interaction-buttons");

test("np_stop uses stopAndLeaveQueue to stop consistently", async () => {
  const queue = {
    nowPlayingMessageId: "msg-1",
    tracks: [{ title: "Song" }],
    current: { title: "Song" },
    playing: true,
    player: {
      state: { status: "playing" },
    },
    connection: { destroy() {} },
  };

  let announceCalled = false;
  let stopCalled = false;
  let deferred = false;
  let editedComponents = null;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
    announceNowPlayingAction: async () => {
      announceCalled = true;
    },
    buildNowPlayingControls: () => ({ type: "row" }),
    formatQueueViewContent: () => ({ content: "", page: 1 }),
    buildQueueViewComponents: () => [],
    buildMoveMenu: () => ({ components: [], page: 1, totalPages: 1 }),
    getTrackIndexById: () => -1,
    ensureTrackId: () => {},
    pendingSearches: new Map(),
    pendingMoves: new Map(),
    pendingQueuedActions: new Map(),
    queueViews: new Map(),
    logInfo: () => {},
    logError: () => {},
    sendNowPlaying: async () => null,
    stopAndLeaveQueue: () => {
      stopCalled = true;
      queue.playing = false;
      queue.current = null;
      queue.voiceChannel = null;
    },
  });

  await handler({
    guildId: "guild-1",
    customId: "np_stop",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" } }),
      },
    },
    message: {
      id: "msg-1",
      channel: {},
      edit: async ({ components }) => {
        editedComponents = components;
      },
    },
    deferUpdate: async () => {
      deferred = true;
    },
    reply: async () => {},
    channel: { send: async () => ({ id: "x" }) },
  });

  assert.equal(announceCalled, true);
  assert.equal(stopCalled, true);
  assert.equal(queue.playing, false);
  assert.equal(queue.current, null);
  assert.equal(queue.voiceChannel, null);
  assert.deepEqual(editedComponents, []);
  assert.equal(deferred, true);
});

test("search_queue_first queues first option and starts playback when idle", async () => {
  const queue = {
    tracks: [{ id: "existing", title: "Existing Track" }],
    playing: false,
    current: null,
  };
  const pendingSearches = new Map();
  pendingSearches.set("search-msg-1", {
    requesterId: "user-1",
    options: [
      {
        id: "opt-1",
        title: "First Result",
        requester: "Requester",
        source: "youtube",
        url: "https://youtu.be/SqD_8FGk89o",
      },
      {
        id: "opt-2",
        title: "Second Result",
        requester: "Requester",
        source: "youtube",
        url: "https://youtu.be/IrdYueB9pY4",
      },
    ],
    timeout: setTimeout(() => {}, 1000),
  });
  const pendingQueuedActions = new Map();
  let updatedPayload = null;
  let playNextGuildId = null;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
    announceNowPlayingAction: async () => {},
    buildNowPlayingControls: () => ({ type: "row" }),
    buildQueuedActionComponents: () => [{ type: "queued-row" }],
    formatQueueViewContent: () => ({ content: "", page: 1 }),
    buildQueueViewComponents: () => [],
    buildMoveMenu: () => ({ components: [], page: 1, totalPages: 1 }),
    getQueuedTrackIndex: (guildQueue, track) => guildQueue.tracks.indexOf(track),
    getTrackIndexById: () => -1,
    ensureTrackId: () => {},
    pendingSearches,
    pendingMoves: new Map(),
    pendingQueuedActions,
    queueViews: new Map(),
    logInfo: () => {},
    logError: () => {},
    playNext: async (guildId) => {
      playNextGuildId = guildId;
    },
    sendNowPlaying: async () => null,
    stopAndLeaveQueue: () => {},
  });

  const interaction = {
    guildId: "guild-1",
    customId: "search_queue_first",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" } }),
      },
    },
    message: {
      id: "search-msg-1",
      edit: async () => {},
    },
    channel: {
      id: "channel-1",
      send: async () => ({ id: "sent-msg-1" }),
    },
    update: async (payload) => {
      updatedPayload = payload;
    },
    reply: async () => {},
  };

  await handler(interaction);

  assert.equal(pendingSearches.has("search-msg-1"), false);
  assert.equal(queue.tracks.length, 2);
  assert.equal(queue.tracks[1].title, "First Result");
  assert.equal(queue.textChannel, interaction.channel);
  assert.equal(playNextGuildId, "guild-1");
  assert.equal(String(updatedPayload?.content || "").includes("**Queued:** First Result"), true);
  assert.deepEqual(updatedPayload?.components, [{ type: "queued-row" }]);
  clearTimeout(pendingQueuedActions.get("search-msg-1")?.timeout);
});

test("np_toggle refreshes now playing content immediately", async () => {
  const queue = {
    nowPlayingMessageId: "msg-1",
    tracks: [{ title: "Song" }],
    current: { title: "Song" },
    playing: true,
    player: {
      state: { status: "playing" },
      pauseCalled: false,
      pause() {
        this.pauseCalled = true;
      },
      unpause() {},
    },
    connection: { destroy() {} },
  };

  let announceCalled = false;
  let sendNowPlayingArgs = null;
  let deferred = false;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
    announceNowPlayingAction: async () => {
      announceCalled = true;
    },
    buildNowPlayingControls: () => ({ type: "row" }),
    formatQueueViewContent: () => ({ content: "", page: 1 }),
    buildQueueViewComponents: () => [],
    buildMoveMenu: () => ({ components: [], page: 1, totalPages: 1 }),
    getTrackIndexById: () => -1,
    ensureTrackId: () => {},
    pendingSearches: new Map(),
    pendingMoves: new Map(),
    pendingQueuedActions: new Map(),
    queueViews: new Map(),
    logInfo: () => {},
    logError: () => {},
    sendNowPlaying: async (q, forceNew) => {
      sendNowPlayingArgs = { q, forceNew };
    },
    stopAndLeaveQueue: () => {},
  });

  await handler({
    guildId: "guild-1",
    customId: "np_toggle",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" } }),
      },
    },
    message: {
      id: "msg-1",
      channel: {},
      edit: async () => {},
    },
    deferUpdate: async () => {
      deferred = true;
    },
    reply: async () => {},
    channel: { send: async () => ({ id: "x" }) },
  });

  assert.equal(queue.player.pauseCalled, true);
  assert.equal(announceCalled, true);
  assert.deepEqual(sendNowPlayingArgs, { q: queue, forceNew: false });
  assert.equal(deferred, true);
});

test("queue_nowplaying opens now playing and closes queue view controls", async () => {
  const queue = {
    tracks: [{ id: "t1", title: "Song 1" }],
    current: { id: "c1", title: "Now Playing" },
    playing: true,
    player: {
      state: { status: "playing" },
    },
  };
  const queueViews = new Map();
  queueViews.set("queue-msg-1", {
    guildId: "guild-1",
    ownerId: "user-1",
    channelId: "text-1",
    page: 1,
    pageSize: 10,
    selectedTrackId: null,
    stale: false,
    timeout: setTimeout(() => {}, 60000),
  });

  let sendNowPlayingArgs = null;
  let deferred = false;
  let closedPayload = null;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
    announceNowPlayingAction: async () => {},
    buildNowPlayingControls: () => ({ type: "row" }),
    formatQueueViewContent: () => ({ content: "", page: 1 }),
    buildQueueViewComponents: () => [],
    buildMoveMenu: () => ({ components: [], page: 1, totalPages: 1 }),
    getTrackIndexById: () => -1,
    ensureTrackId: () => {},
    pendingSearches: new Map(),
    pendingMoves: new Map(),
    pendingQueuedActions: new Map(),
    queueViews,
    logInfo: () => {},
    logError: () => {},
    sendNowPlaying: async (q, forceNew) => {
      sendNowPlayingArgs = { q, forceNew };
    },
    stopAndLeaveQueue: () => {},
  });

  const interaction = {
    guildId: "guild-1",
    customId: "queue_nowplaying",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" } }),
      },
    },
    message: { id: "queue-msg-1" },
    channel: { id: "text-1" },
    client: {
      channels: {
        cache: new Map([
          ["text-1", {
            messages: {
              fetch: async () => ({
                edit: async (payload) => {
                  closedPayload = payload;
                },
              }),
            },
          }],
        ]),
      },
    },
    deferUpdate: async () => {
      deferred = true;
    },
    reply: async () => {},
    update: async () => {
      throw new Error("should not call update when queue_nowplaying is used");
    },
  };

  await handler(interaction);

  assert.deepEqual(sendNowPlayingArgs, { q: queue, forceNew: true });
  assert.equal(queue.textChannel, interaction.channel);
  assert.equal(deferred, true);
  assert.equal(queueViews.has("queue-msg-1"), false);
  assert.deepEqual(closedPayload, { content: "Queue view closed (now playing opened).", components: [] });
});
