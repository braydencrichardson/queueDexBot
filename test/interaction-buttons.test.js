const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags } = require("discord.js");

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

  const sentMessages = [];
  let stopCalled = false;
  let deferred = false;
  let editedComponents = null;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
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
    channel: {
      send: async (content) => {
        sentMessages.push(String(content));
        return { id: "x" };
      },
    },
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], "**User#0001** stopped playback and cleared the queue.");
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

  const sentMessages = [];
  let sendNowPlayingArgs = null;
  let deferred = false;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
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
    channel: {
      send: async (content) => {
        sentMessages.push(String(content));
        return { id: "x" };
      },
    },
  });

  assert.equal(queue.player.pauseCalled, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], "**User#0001** paused playback.");
  assert.deepEqual(sendNowPlayingArgs, { q: queue, forceNew: false });
  assert.equal(deferred, true);
});

test("np_toggle resume ensures voice reconnect through queue service", async () => {
  const queue = {
    nowPlayingMessageId: "msg-1",
    tracks: [{ title: "Song" }],
    current: { title: "Song" },
    playing: true,
    player: {
      state: { status: "paused" },
      pause() {},
      unpause() {},
    },
    connection: { destroy() {} },
  };

  let queueServiceArgs = null;
  const sentMessages = [];
  let sendNowPlayingArgs = null;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
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
    queueService: {
      resume: async (q, options) => {
        queueServiceArgs = { q, options };
        return { ok: true };
      },
    },
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
        resolve: () => ({
          user: { id: "user-1" },
          voice: { channel: { id: "voice-1" } },
        }),
      },
    },
    message: {
      id: "msg-1",
      channel: {},
      edit: async () => {},
    },
    deferUpdate: async () => {},
    reply: async () => {},
    followUp: async () => {},
    channel: {
      send: async (content) => {
        sentMessages.push(String(content));
        return { id: "x" };
      },
    },
  });

  assert.deepEqual(queueServiceArgs, {
    q: queue,
    options: {
      refreshNowPlaying: false,
      ensureVoiceConnection: true,
      ensureVoiceConnectionOptions: {
        guildId: "guild-1",
        preferredVoiceChannel: { id: "voice-1" },
      },
    },
  });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0], "**User#0001** resumed playback.");
  assert.deepEqual(sendNowPlayingArgs, { q: queue, forceNew: false });
});

test("np_toggle resume failure does not announce success and reports error", async () => {
  const queue = {
    nowPlayingMessageId: "msg-1",
    tracks: [{ title: "Song" }],
    current: { title: "Song" },
    playing: true,
    player: {
      state: { status: "paused" },
      pause() {},
      unpause() {},
    },
    connection: { destroy() {} },
  };

  const sentMessages = [];
  let sendNowPlayingCalled = false;
  let followUpPayload = null;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
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
    queueService: {
      resume: async () => ({
        ok: false,
        error: "I couldn't rejoin the voice channel.",
      }),
    },
    sendNowPlaying: async () => {
      sendNowPlayingCalled = true;
    },
    stopAndLeaveQueue: () => {},
  });

  await handler({
    guildId: "guild-1",
    customId: "np_toggle",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({
          user: { id: "user-1" },
          voice: { channel: { id: "voice-1" } },
        }),
      },
    },
    message: {
      id: "msg-1",
      channel: {},
      edit: async () => {},
    },
    deferUpdate: async () => {},
    reply: async () => {},
    followUp: async (payload) => {
      followUpPayload = payload;
    },
    channel: {
      send: async (content) => {
        sentMessages.push(String(content));
        return { id: "x" };
      },
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(sendNowPlayingCalled, false);
  assert.equal(followUpPayload?.content, "I couldn't rejoin the voice channel.");
  assert.equal(followUpPayload?.flags, MessageFlags.Ephemeral);
});

test("np_loop cycles loop mode and refreshes controls with the new mode", async () => {
  const queue = {
    nowPlayingMessageId: "msg-1",
    tracks: [{ id: "next-1", title: "Next", url: "https://youtu.be/next" }],
    current: { id: "now-1", title: "Now", url: "https://youtu.be/now" },
    loopMode: "off",
    playing: true,
    player: {
      state: { status: "playing" },
      pause() {},
      unpause() {},
    },
    connection: { destroy() {} },
  };

  const sentMessages = [];
  let sendNowPlayingArgs = null;
  let refreshCalledWith = null;
  let deferred = false;
  let generatedId = 1;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
    buildNowPlayingControls: () => ({ type: "row" }),
    formatQueueViewContent: () => ({ content: "", page: 1 }),
    buildQueueViewComponents: () => [],
    buildMoveMenu: () => ({ components: [], page: 1, totalPages: 1 }),
    getTrackIndexById: () => -1,
    ensureTrackId: (track) => {
      if (!track.id) {
        track.id = `generated-${generatedId++}`;
      }
    },
    pendingSearches: new Map(),
    pendingMoves: new Map(),
    pendingQueuedActions: new Map(),
    queueViews: new Map(),
    logInfo: () => {},
    logError: () => {},
    maybeRefreshNowPlayingUpNext: async (q) => {
      refreshCalledWith = q;
    },
    sendNowPlaying: async (q, forceNew) => {
      sendNowPlayingArgs = { q, forceNew };
    },
    stopAndLeaveQueue: () => {},
  });

  await handler({
    guildId: "guild-1",
    customId: "np_loop",
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
    channel: {
      send: async (content) => {
        sentMessages.push(String(content));
        return { id: "x" };
      },
    },
  });

  assert.equal(queue.loopMode, "queue");
  assert.equal(queue.tracks[0].loopTag, undefined);
  assert.equal(queue.tracks[0].loopSourceTrackKey, undefined);
  assert.equal(refreshCalledWith, queue);
  assert.deepEqual(sendNowPlayingArgs, { q: queue, forceNew: false });
  assert.equal(sentMessages.length, 1);
  assert.equal(String(sentMessages[0]).includes("set loop mode to **queue**"), true);
  assert.equal(deferred, true);
});

test("np_loop refreshes active queue views when loop-generated tracks are removed", async () => {
  const queue = {
    nowPlayingMessageId: "np-msg-1",
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
    loopMode: "single",
    playing: true,
    player: {
      state: { status: "playing" },
      pause() {},
      unpause() {},
    },
    connection: { destroy() {} },
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

  let queueViewEditPayload = null;
  let deferred = false;

  const handler = createButtonInteractionHandler({
    AudioPlayerStatus: { Playing: "playing" },
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
    announceNowPlayingAction: async () => {},
    buildNowPlayingControls: ({ loopMode }) => ({ type: "row", loopMode }),
    formatQueueViewContent: (guildQueue) => ({ content: `tracks:${guildQueue.tracks.length}`, page: 1 }),
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
    maybeRefreshNowPlayingUpNext: async () => {},
    sendNowPlaying: async () => {},
    stopAndLeaveQueue: () => {},
  });

  await handler({
    guildId: "guild-1",
    customId: "np_loop",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" } }),
      },
    },
    client: {
      channels: {
        cache: new Map([
          ["text-1", {
            messages: {
              fetch: async (messageId) => ({
                id: messageId,
                edit: async (payload) => {
                  queueViewEditPayload = payload;
                },
              }),
            },
          }],
        ]),
      },
    },
    message: {
      id: "np-msg-1",
      channel: {},
      edit: async () => {},
    },
    deferUpdate: async () => {
      deferred = true;
    },
    reply: async () => {},
    channel: { send: async () => ({ id: "x" }) },
  });

  assert.equal(queue.loopMode, "off");
  assert.equal(queue.tracks.length, 1);
  assert.equal(queueViewEditPayload?.content, "tracks:1");
  assert.equal(deferred, true);
  clearTimeout(queueViews.get("queue-view-1")?.timeout);
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
      return { id: "np-msg-1" };
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

test("queue_nowplaying keeps queue view open and reports failure when now playing cannot be posted", async () => {
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

  let deferred = false;
  let closedPayload = null;
  let followUpPayload = null;

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
    sendNowPlaying: async () => null,
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
    followUp: async (payload) => {
      followUpPayload = payload;
    },
    reply: async () => {},
    update: async () => {
      throw new Error("should not call update when queue_nowplaying is used");
    },
  };

  await handler(interaction);

  assert.equal(queue.textChannel, interaction.channel);
  assert.equal(deferred, true);
  assert.equal(queueViews.has("queue-msg-1"), true);
  assert.equal(closedPayload, null);
  assert.deepEqual(followUpPayload, {
    content: "Couldn't open now playing controls right now. I may be reconnecting to Discord, or I might not have send permissions in this channel.",
    flags: MessageFlags.Ephemeral,
  });
  clearTimeout(queueViews.get("queue-msg-1")?.timeout);
});

test("np_activity replies with an ephemeral activity invite link", async () => {
  let inviteCallCount = 0;
  let replyPayload = null;
  let deferred = false;
  const queue = {
    nowPlayingMessageId: "np-msg-1",
    tracks: [{ id: "t1", title: "Song 1" }],
    current: { id: "c1", title: "Now Playing" },
    voiceChannel: {
      id: "voice-1",
      name: "Music VC",
      guild: { id: "guild-1" },
      createInvite: async () => {
        inviteCallCount += 1;
        return {
          code: "np-activity",
          url: "https://discord.gg/np-activity",
          expiresTimestamp: Date.now() + 15 * 60 * 1000,
        };
      },
    },
    player: {
      state: { status: "playing" },
    },
  };

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
    queueViews: new Map(),
    logInfo: () => {},
    logError: () => {},
    sendNowPlaying: async () => {},
    stopAndLeaveQueue: () => {},
  });

  await handler({
    guildId: "guild-1",
    customId: "np_activity",
    applicationId: "app-1",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" }, voice: { channel: { id: "voice-1" } } }),
      },
    },
    message: { id: "np-msg-1", channel: {}, edit: async () => {} },
    deferUpdate: async () => {
      deferred = true;
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
    channel: { send: async () => ({ id: "x" }) },
  });

  assert.equal(inviteCallCount, 1);
  assert.equal(deferred, false);
  assert.deepEqual(replyPayload, {
    content: "Created an Activity invite for **Music VC**.\nhttps://discord.gg/np-activity",
    flags: MessageFlags.Ephemeral,
  });
});

test("queue_activity replies with invite link without closing queue view", async () => {
  let replyPayload = null;
  let queueViewEdited = false;
  const queue = {
    tracks: [{ id: "t1", title: "Song 1" }],
    current: { id: "c1", title: "Now Playing" },
    voiceChannel: {
      id: "voice-1",
      name: "Music VC",
      guild: { id: "guild-1" },
      createInvite: async () => ({
        code: "queue-activity",
        url: "https://discord.gg/queue-activity",
        expiresTimestamp: Date.now() + 15 * 60 * 1000,
      }),
    },
    player: {
      state: { status: "playing" },
    },
  };
  const queueViews = new Map([
    ["queue-msg-1", {
      guildId: "guild-1",
      ownerId: "user-1",
      channelId: "text-1",
      page: 1,
      pageSize: 10,
      selectedTrackId: null,
      stale: false,
      timeout: setTimeout(() => {}, 60000),
    }],
  ]);

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
    sendNowPlaying: async () => {},
    stopAndLeaveQueue: () => {},
  });

  await handler({
    guildId: "guild-1",
    customId: "queue_activity",
    applicationId: "app-1",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" }, voice: { channel: { id: "voice-1" } } }),
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
                edit: async () => {
                  queueViewEdited = true;
                },
              }),
            },
          }],
        ]),
      },
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
    update: async () => {
      throw new Error("queue_activity should not call update");
    },
  });

  assert.equal(queueViewEdited, false);
  assert.equal(queueViews.has("queue-msg-1"), true);
  assert.deepEqual(replyPayload, {
    content: "Created an Activity invite for **Music VC**.\nhttps://discord.gg/queue-activity",
    flags: MessageFlags.Ephemeral,
  });
  clearTimeout(queueViews.get("queue-msg-1")?.timeout);
});

test("np_activity includes configured web activity URL in invite response", async () => {
  let replyPayload = null;
  const queue = {
    nowPlayingMessageId: "np-msg-2",
    tracks: [{ id: "t2", title: "Song 2" }],
    current: { id: "c2", title: "Now Playing 2" },
    voiceChannel: {
      id: "voice-2",
      name: "General",
      guild: { id: "guild-1" },
      createInvite: async () => ({
        code: "np-web-link",
        url: "https://discord.gg/np-web-link",
        expiresTimestamp: Date.now() + 15 * 60 * 1000,
      }),
    },
    player: {
      state: { status: "playing" },
    },
  };

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
    queueViews: new Map(),
    logInfo: () => {},
    logError: () => {},
    sendNowPlaying: async () => {},
    stopAndLeaveQueue: () => {},
    activityWebUrl: "https://activity.example.com",
  });

  await handler({
    guildId: "guild-1",
    customId: "np_activity",
    applicationId: "app-1",
    user: { id: "user-1", tag: "User#0001" },
    guild: {
      members: {
        resolve: () => ({ user: { id: "user-1" }, voice: { channel: { id: "voice-2" } } }),
      },
    },
    message: { id: "np-msg-2", channel: {}, edit: async () => {} },
    reply: async (payload) => {
      replyPayload = payload;
    },
    channel: { send: async () => ({ id: "x" }) },
  });

  assert.equal(String(replyPayload?.content || "").includes("https://discord.gg/np-web-link"), true);
  assert.equal(String(replyPayload?.content || "").includes("Web: <https://activity.example.com/>"), true);
});
