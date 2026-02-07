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
  assert.deepEqual(editedComponents, [{ type: "row" }]);
  assert.equal(deferred, true);
});
