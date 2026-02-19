const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags } = require("discord.js");

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
  assert.deepEqual(replyPayload, { content: "Nothing is playing and the queue is empty.", flags: MessageFlags.Ephemeral });
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
  assert.deepEqual(replyPayload, { content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
});

test("leave text unbinds the existing queue text channel", async () => {
  let replyPayload = null;
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: { id: "vc-bot" },
    connection: null,
    textChannel: { id: "text-1", name: "music" },
    textChannelId: "text-1",
    player: { id: "player-1" },
  };
  const { deps } = createDeps({ queue });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-2",
    channel: { id: "text-2" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: null } },
    commandName: "leave",
    options: {
      getSubcommand: () => "text",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(queue.textChannel, null);
  assert.equal(queue.textChannelId, null);
  assert.deepEqual(replyPayload, {
    content: "Unbound queue updates from <#text-1>.",
    flags: MessageFlags.Ephemeral,
  });
});

test("leave text reports when no queue text channel is bound", async () => {
  let replyPayload = null;
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: { id: "vc-bot" },
    connection: null,
    textChannel: null,
    textChannelId: null,
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
    commandName: "leave",
    options: {
      getSubcommand: () => "text",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.deepEqual(replyPayload, {
    content: "No text channel is currently bound.",
    flags: MessageFlags.Ephemeral,
  });
});

test("leave voice reports when bot is not in a voice channel", async () => {
  let replyPayload = null;
  let stopCalled = false;
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: null,
    connection: null,
    textChannel: { id: "text-1" },
    textChannelId: "text-1",
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
    member: { voice: { channel: { id: "vc-1" } } },
    commandName: "leave",
    options: {
      getSubcommand: () => "voice",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(stopCalled, false);
  assert.deepEqual(replyPayload, {
    content: "I am not connected to a voice channel.",
    flags: MessageFlags.Ephemeral,
  });
});

test("leave voice requires caller in bot voice channel", async () => {
  let replyPayload = null;
  let stopCalled = false;
  const queue = {
    tracks: [],
    current: { title: "Now Playing" },
    voiceChannel: { id: "vc-bot" },
    connection: null,
    textChannel: { id: "text-1" },
    textChannelId: "text-1",
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
    commandName: "leave",
    options: {
      getSubcommand: () => "voice",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(stopCalled, false);
  assert.deepEqual(replyPayload, { content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
});

test("leave voice disconnects and preserves existing text binding", async () => {
  let replyPayload = null;
  let stopReason = null;
  const originalTextChannel = { id: "text-1", name: "general" };
  const queue = {
    tracks: [{ id: "t1", title: "Track 1" }],
    current: { title: "Now Playing" },
    voiceChannel: { id: "vc-bot" },
    connection: { joinConfig: { channelId: "vc-bot" } },
    textChannel: originalTextChannel,
    textChannelId: "text-1",
    player: { id: "player-1" },
  };
  const { deps } = createDeps({
    queue,
    deps: {
      stopAndLeaveQueue: (_queue, reason) => {
        stopReason = reason;
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-2",
    channel: { id: "text-2" },
    user: { id: "user-1", tag: "User#0001" },
    member: { voice: { channel: { id: "vc-bot" } } },
    commandName: "leave",
    options: {
      getSubcommand: () => "voice",
    },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handler(interaction);

  assert.equal(stopReason, "Leaving voice channel via /leave voice");
  assert.equal(queue.textChannel, originalTextChannel);
  assert.equal(queue.textChannelId, "text-1");
  assert.deepEqual(replyPayload, {
    content: "Left the voice channel and cleared the queue.",
    flags: MessageFlags.Ephemeral,
  });
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

  assert.deepEqual(replyPayload, { content: "Queue is already empty.", flags: MessageFlags.Ephemeral });
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
  assert.deepEqual(replyPayload, { content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
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
  assert.equal(replyPayload?.flags, MessageFlags.Ephemeral);
  assert.equal(
    String(replyPayload?.content || "").includes("Joined **General** and bound updates to <#text-1>."),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("**Activity:** <https://discord.gg/2KxydpY> | Web: <https://qdexbot.app/>"),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("Use `/play <song name or URL>` here to start music, or open the Activity/Web UI to queue tracks."),
    true
  );
});

test("join command clears stale queue voice state when bot is disconnected", async () => {
  let replyPayload = null;
  let staleConnectionDestroyed = false;
  let joinCalled = false;
  const staleConnection = {
    on: () => {},
    subscribe: () => {},
    destroy: () => {
      staleConnectionDestroyed = true;
    },
  };
  const newConnection = {
    on: () => {},
    subscribe: () => {},
    destroy: () => {},
  };
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: { id: "vc-1" },
    connection: staleConnection,
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
      joinVoiceChannel: () => {
        joinCalled = true;
        return newConnection;
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    guild: {
      members: {
        me: {
          voice: {
            channelId: null,
          },
        },
      },
    },
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

  assert.equal(staleConnectionDestroyed, true);
  assert.equal(joinCalled, true);
  assert.equal(queue.connection, newConnection);
  assert.equal(queue.voiceChannel, voiceChannel);
  assert.equal(replyPayload?.flags, MessageFlags.Ephemeral);
  assert.equal(
    String(replyPayload?.content || "").includes("Joined **General** and bound updates to <#text-1>."),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("**Activity:** <https://discord.gg/2KxydpY> | Web: <https://qdexbot.app/>"),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("Use `/play <song name or URL>` here to start music, or open the Activity/Web UI to queue tracks."),
    true
  );
});

test("join command reports already connected based on live bot voice state", async () => {
  let replyPayload = null;
  let joinCalled = false;
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
      joinVoiceChannel: () => {
        joinCalled = true;
        return {
          on: () => {},
          subscribe: () => {},
          destroy: () => {},
        };
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    guild: {
      channels: {
        cache: new Map([["vc-1", voiceChannel]]),
      },
      members: {
        me: {
          voice: {
            channelId: "vc-1",
            channel: voiceChannel,
          },
        },
      },
    },
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

  assert.equal(joinCalled, false);
  assert.equal(replyPayload?.flags, MessageFlags.Ephemeral);
  assert.equal(
    String(replyPayload?.content || "").includes("Already in your voice channel. Bound updates to <#text-1>."),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("**Activity:** <https://discord.gg/2KxydpY> | Web: <https://qdexbot.app/>"),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("Use `/play <song name or URL>` here to start music, or open the Activity/Web UI to queue tracks."),
    true
  );
});

test("join posts now-playing controls when first text-channel bind happens during active playback", async () => {
  let replyPayload = null;
  let sendNowPlayingCalls = 0;
  let sendNowPlayingArgs = null;
  const voiceChannel = {
    id: "vc-1",
    name: "General",
    guild: { id: "guild-1", voiceAdapterCreator: {} },
  };
  const queue = {
    tracks: [],
    current: { id: "track-now", title: "Now Playing" },
    voiceChannel: null,
    connection: null,
    textChannel: null,
    textChannelId: null,
    player: {
      id: "player-1",
      state: { status: "playing" },
    },
  };

  const { deps } = createDeps({
    queue,
    deps: {
      sendNowPlaying: async (...args) => {
        sendNowPlayingCalls += 1;
        sendNowPlayingArgs = args;
        return { id: "now-playing-message-1" };
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    guild: {
      channels: {
        cache: new Map([["vc-1", voiceChannel]]),
      },
      members: {
        me: {
          voice: {
            channelId: "vc-1",
            channel: voiceChannel,
          },
        },
      },
    },
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

  assert.equal(sendNowPlayingCalls, 1);
  assert.deepEqual(sendNowPlayingArgs, [queue, true]);
  assert.equal(replyPayload?.flags, MessageFlags.Ephemeral);
});

test("join does not post now-playing controls when text channel was already attached", async () => {
  let sendNowPlayingCalls = 0;
  let replyPayload = null;
  const voiceChannel = {
    id: "vc-1",
    name: "General",
    guild: { id: "guild-1", voiceAdapterCreator: {} },
  };
  const queue = {
    tracks: [],
    current: { id: "track-now", title: "Now Playing" },
    voiceChannel: voiceChannel,
    connection: null,
    textChannel: { id: "text-1" },
    textChannelId: "text-1",
    player: {
      id: "player-1",
      state: { status: "playing" },
    },
  };

  const { deps } = createDeps({
    queue,
    deps: {
      sendNowPlaying: async () => {
        sendNowPlayingCalls += 1;
        return { id: "now-playing-message-1" };
      },
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    guild: {
      channels: {
        cache: new Map([["vc-1", voiceChannel]]),
      },
      members: {
        me: {
          voice: {
            channelId: "vc-1",
            channel: voiceChannel,
          },
        },
      },
    },
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

  assert.equal(sendNowPlayingCalls, 0);
  assert.equal(
    String(replyPayload?.content || "").includes("I am already in your voice channel and this text channel is already attached."),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("**Activity:** <https://discord.gg/2KxydpY> | Web: <https://qdexbot.app/>"),
    true
  );
  assert.equal(
    String(replyPayload?.content || "").includes("Use `/play <song name or URL>` here to start music, or open the Activity/Web UI to queue tracks."),
    true
  );
});

test("play resolves tracks before joining voice", async () => {
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: null,
    connection: null,
    player: { id: "player-1" },
  };
  const voiceChannel = {
    id: "vc-1",
    guild: { id: "guild-1", voiceAdapterCreator: {} },
  };
  let joinCalled = false;
  let resolveCalled = false;
  const { deps } = createDeps({
    queue,
    deps: {
      joinVoiceChannel: () => {
        joinCalled = true;
        return {
          on: () => {},
          subscribe: () => {},
          destroy: () => {},
        };
      },
      resolveTracks: async () => {
        resolveCalled = true;
        assert.equal(joinCalled, false);
        return [{
          id: "t1",
          title: "Track 1",
          url: "https://youtu.be/example",
          source: "youtube",
        }];
      },
      enqueueTracks: (guildQueue, tracks) => {
        guildQueue.tracks.push(...tracks);
      },
      getQueuedTrackIndex: (guildQueue, track) => guildQueue.tracks.indexOf(track),
      buildQueuedActionComponents: () => [],
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { displayName: "User", voice: { channel: voiceChannel } },
    commandName: "play",
    options: {
      getString: () => "test query",
    },
    deferReply: async () => {},
    editReply: async () => ({ id: "msg-1", edit: async () => {} }),
    followUp: async () => {},
    reply: async () => {},
  };

  await handler(interaction);

  assert.equal(resolveCalled, true);
  assert.equal(joinCalled, true);
  assert.equal(queue.voiceChannel, voiceChannel);
  assert.equal(queue.tracks.length, 1);
  clearTimeout(deps.pendingQueuedActions.get("msg-1")?.timeout);
});

test("play does not join voice when no tracks are found", async () => {
  const queue = {
    tracks: [],
    current: null,
    voiceChannel: null,
    connection: null,
    player: { id: "player-1" },
  };
  const voiceChannel = {
    id: "vc-1",
    guild: { id: "guild-1", voiceAdapterCreator: {} },
  };
  let joinCalled = false;
  let editReplyPayload = null;
  let resolveCalls = 0;
  const { deps } = createDeps({
    queue,
    deps: {
      joinVoiceChannel: () => {
        joinCalled = true;
        return {
          on: () => {},
          subscribe: () => {},
          destroy: () => {},
        };
      },
      resolveTracks: async () => {
        resolveCalls += 1;
        return [];
      },
      getSearchOptionsForQuery: async () => [],
      trySendSearchChooser: async () => false,
    },
  });
  const handler = createCommandInteractionHandler(deps);
  const interaction = {
    isCommand: () => true,
    guildId: "guild-1",
    channelId: "text-1",
    channel: { id: "text-1" },
    user: { id: "user-1", tag: "User#0001" },
    member: { displayName: "User", voice: { channel: voiceChannel } },
    commandName: "play",
    options: {
      getString: () => "missing song",
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      editReplyPayload = payload;
    },
    followUp: async () => {},
    reply: async () => {},
  };

  await handler(interaction);

  assert.equal(resolveCalls, 2);
  assert.equal(joinCalled, false);
  assert.equal(editReplyPayload, "No results found.");
});

test("playing reports an error when now playing controls cannot be posted", async () => {
  let deferReplyPayload = null;
  let editReplyPayload = null;
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
      sendNowPlaying: async () => null,
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
    commandName: "playing",
    options: {},
    deferReply: async (payload) => {
      deferReplyPayload = payload;
    },
    editReply: async (payload) => {
      editReplyPayload = payload;
    },
    reply: async () => {},
  };

  await handler(interaction);

  assert.deepEqual(deferReplyPayload, { flags: MessageFlags.Ephemeral });
  assert.deepEqual(editReplyPayload, {
    content: "I couldn't post now playing controls right now. I may be reconnecting to Discord, or I might not have send permissions in this channel.",
  });
});

test("queue loop single injects a tagged loop item at position 1", async () => {
  let refreshedQueue = null;
  let sendNowPlayingArgs = null;
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
      sendNowPlaying: async (guildQueue, forceNew) => {
        sendNowPlayingArgs = { guildQueue, forceNew };
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
  assert.deepEqual(sendNowPlayingArgs, { guildQueue: queue, forceNew: false });
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
