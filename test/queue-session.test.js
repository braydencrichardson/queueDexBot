const test = require("node:test");
const assert = require("node:assert/strict");

const { createQueueSession } = require("../src/queue/session");

function formatDuration(seconds) {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function createSession(overrides = {}) {
  const player = overrides.player || {
    state: {},
    on: () => {},
    stop: () => {},
  };
  return createQueueSession({
    queues: new Map(),
    createAudioPlayer: () => player,
    NoSubscriberBehavior: { Pause: "pause" },
    AudioPlayerStatus: { Idle: "idle", Playing: "playing" },
    formatDuration,
    buildNowPlayingControls: () => ({}),
    logInfo: () => {},
    logError: () => {},
    getPlayNext: () => async () => {},
    ...overrides.deps,
  });
}

test("isSameVoiceChannel returns false when member is not in voice channel", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: { id: "vc-1" } };
  const member = { voice: { channel: null } };

  assert.equal(isSameVoiceChannel(member, queue), false);
});

test("isSameVoiceChannel returns true when member and queue voice channel IDs match", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: { id: "vc-1" } };
  const member = { voice: { channel: { id: "vc-1" } } };

  assert.equal(isSameVoiceChannel(member, queue), true);
});

test("isSameVoiceChannel falls back to connection join channel ID", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: null, connection: { joinConfig: { channelId: "vc-1" } } };
  const member = { voice: { channel: { id: "vc-1" } } };

  assert.equal(isSameVoiceChannel(member, queue), true);
});

test("isSameVoiceChannel returns false when queue has no known voice channel", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: null, connection: null };
  const member = { voice: { channel: { id: "vc-1" } } };

  assert.equal(isSameVoiceChannel(member, queue), false);
});

test("sendNowPlaying includes block progress bar for timed tracks", async () => {
  const player = {
    state: { resource: { playbackDuration: 30000 } },
    on: () => {},
    stop: () => {},
  };
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession({
    player,
    deps: {
      showNowPlayingProgress: true,
    },
  });

  let sentPayload = null;
  const message = {
    id: "np-1",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 180,
    url: "https://youtu.be/example",
    source: "youtube",
  };
  queue.tracks = [];
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  const content = String(sentPayload?.content || "");
  assert.equal(content.includes("**Progress:** ▶️ [███░░░░░░░░░░░░░░░░░] 0:30 / 3:00"), true);

  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying includes activity links when provided by callback", async () => {
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession({
    deps: {
      getNowPlayingActivityLinks: async () => ({
        inviteUrl: "https://discord.gg/activity-test",
        webUrl: "https://activity.example.com",
      }),
    },
  });

  let sentPayload = null;
  const message = {
    id: "np-activity",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 180,
    url: "https://youtu.be/example",
    source: "youtube",
  };
  queue.tracks = [];
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  const content = String(sentPayload?.content || "");
  assert.equal(
    content.includes("**Activity:** Open Activity: <https://discord.gg/activity-test> | Web: <https://activity.example.com>"),
    true
  );

  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying hides progress by default when now-playing progress is disabled", async () => {
  const player = {
    state: { resource: { playbackDuration: 30000 } },
    on: () => {},
    stop: () => {},
  };
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession({ player });

  let sentPayload = null;
  const message = {
    id: "np-hidden-progress",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 180,
    url: "https://youtu.be/example",
    source: "youtube",
  };
  queue.tracks = [];
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  const content = String(sentPayload?.content || "");
  assert.equal(content.includes("**Progress:**"), false);

  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying renders 0:00 elapsed when playback duration has not advanced yet", async () => {
  const player = {
    state: { resource: { playbackDuration: 0 } },
    on: () => {},
    stop: () => {},
  };
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession({
    player,
    deps: {
      showNowPlayingProgress: true,
    },
  });

  let sentPayload = null;
  const message = {
    id: "np-1",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 180,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
  };
  queue.tracks = [];
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  const content = String(sentPayload?.content || "");
  assert.equal(content.includes("0:00 / 3:00"), true);

  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying shows pause icon in progress when player is paused", async () => {
  const player = {
    state: { status: "paused", resource: { playbackDuration: 30000 } },
    on: () => {},
    stop: () => {},
  };
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession({
    player,
    deps: {
      AudioPlayerStatus: { Idle: "idle", Playing: "playing", Paused: "paused", AutoPaused: "autopaused" },
      showNowPlayingProgress: true,
    },
  });

  let sentPayload = null;
  const message = {
    id: "np-1",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 180,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
  };
  queue.tracks = [];
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  const content = String(sentPayload?.content || "");
  assert.equal(content.includes("**Progress:** ⏸️ [███"), true);

  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying updates existing now playing message with a single edit", async () => {
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession();
  const editCalls = [];
  const existingMessage = {
    id: "np-1",
    channel: { id: "text-1" },
    async edit(payload) {
      editCalls.push(payload);
    },
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 89,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
  };
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        return existingMessage;
      },
    },
    async send() {
      throw new Error("should not send when editing existing message");
    },
  };
  queue.nowPlayingMessageId = "np-1";
  queue.nowPlayingChannelId = "text-1";

  await sendNowPlaying(queue, false);

  assert.equal(editCalls.length, 1);
  assert.equal(typeof editCalls[0], "object");
  assert.equal(String(editCalls[0].content || "").includes("https://soundcloud.com/sleepmethods/piggy"), true);

  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying shows queue-loop marker for loop-generated up-next tracks", async () => {
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession();
  let sentPayload = null;
  const message = {
    id: "np-1",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Current",
    requester: "Requester",
    duration: 180,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
  };
  queue.tracks = [
    {
      id: "track-2",
      title: "Looped",
      requester: "Requester",
      duration: 180,
      url: "https://soundcloud.com/sleepmethods/piggy",
      source: "soundcloud",
      loopTag: "queue",
      loopSourceTrackKey: "track-1",
    },
  ];
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  assert.equal(String(sentPayload?.content || "").includes("**Up next:** ↺"), true);
  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying shows current track as up next for single-track queue loop", async () => {
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession();
  let sentPayload = null;
  const message = {
    id: "np-1",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.loopMode = "queue";
  queue.current = {
    id: "track-1",
    title: "Current",
    requester: "Requester",
    duration: 180,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
  };
  queue.tracks = [];
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  const content = String(sentPayload?.content || "");
  assert.equal(content.includes("**Up next:** ↺ Current"), true);
  assert.equal(content.includes("**Up next:** (empty)"), false);
  assert.equal(content.includes("**Loop:**"), false);
  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying with forceNew deletes previous now playing message", async () => {
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession();
  let previousDeleted = false;
  let sentPayload = null;

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 89,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
  };
  queue.nowPlayingMessageId = "np-old";
  queue.nowPlayingChannelId = "text-1";
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch(id) {
        if (id === "np-old") {
          return {
            async delete() {
              previousDeleted = true;
            },
          };
        }
        throw new Error("unexpected fetch id");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return {
        id: "np-new",
        channel: { id: "text-1" },
        async edit() {},
      };
    },
  };

  await sendNowPlaying(queue, true);

  assert.equal(previousDeleted, true);
  assert.equal(String(sentPayload?.content || "").includes("**Now playing:**"), true);
  assert.equal(queue.nowPlayingMessageId, "np-new");

  stopAndLeaveQueue(queue, "cleanup");
});

test("sendNowPlaying marks up-next as preloaded when ready", async () => {
  const { getGuildQueue, sendNowPlaying, stopAndLeaveQueue } = createSession();
  let sentPayload = null;
  const message = {
    id: "np-1",
    channel: { id: "text-1" },
    async edit() {},
  };

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Now",
    requester: "Requester",
    duration: 89,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
  };
  queue.tracks = [{
    id: "track-2",
    title: "Next",
    requester: "Requester",
    duration: 120,
    url: "https://youtu.be/next",
    source: "youtube",
  }];
  queue.preloadedNextTrackKey = "track-2";
  queue.preloadedNextResource = { id: "resource-next" };
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        throw new Error("not used in forceNew mode");
      },
    },
    async send(payload) {
      sentPayload = payload;
      return message;
    },
  };

  await sendNowPlaying(queue, true);

  const content = String(sentPayload?.content || "");
  assert.equal(content.includes("**Up next:** ●"), true);

  stopAndLeaveQueue(queue, "cleanup");
});

test("stopAndLeaveQueue clears now playing progress timer state", () => {
  const { stopAndLeaveQueue } = createSession();
  const queue = {
    tracks: [{ id: "x" }],
    current: { id: "x" },
    nowPlayingMessageId: "np-1",
    nowPlayingChannelId: "text-1",
    nowPlayingUpNextKey: "x",
    nowPlayingProgressStartTimeout: setTimeout(() => {}, 60000),
    nowPlayingProgressInterval: setInterval(() => {}, 60000),
    nowPlayingProgressTrackKey: "x",
    playing: true,
    inactivityTimeout: null,
    pausedForInactivity: false,
    inactivityNoticeMessageId: null,
    inactivityNoticeChannelId: null,
    player: { stop: () => {} },
    connection: null,
    voiceChannel: { id: "vc-1" },
  };

  stopAndLeaveQueue(queue, "cleanup");

  assert.equal(queue.nowPlayingProgressStartTimeout, null);
  assert.equal(queue.nowPlayingProgressInterval, null);
  assert.equal(queue.nowPlayingProgressTrackKey, null);
  assert.equal(queue.nowPlayingMessageId, null);
  assert.equal(queue.nowPlayingChannelId, null);
});

test("stopAndLeaveQueue archives now playing message when one is active", async () => {
  const { stopAndLeaveQueue } = createSession();
  let cleanedPayload = null;
  const queue = {
    tracks: [{ id: "x" }],
    current: {
      id: "x",
      title: "Song",
      requester: "Requester",
      duration: 89,
      url: "https://soundcloud.com/sleepmethods/piggy",
      source: "soundcloud",
      artist: "sleepmethods",
    },
    nowPlayingMessageId: "np-1",
    nowPlayingChannelId: "text-1",
    nowPlayingTrackSnapshot: null,
    nowPlayingUpNextKey: "x",
    nowPlayingProgressStartTimeout: null,
    nowPlayingProgressInterval: null,
    nowPlayingProgressTrackKey: "x",
    playing: true,
    inactivityTimeout: null,
    pausedForInactivity: false,
    inactivityNoticeMessageId: null,
    inactivityNoticeChannelId: null,
    textChannel: {
      id: "text-1",
      messages: {
        async fetch() {
          return {
            async edit(payload) {
              cleanedPayload = payload;
            },
          };
        },
      },
    },
    player: { stop: () => {} },
    connection: null,
    voiceChannel: { id: "vc-1" },
  };

  stopAndLeaveQueue(queue, "cleanup");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(String(cleanedPayload?.content || "").includes("**Played:**"), true);
  assert.deepEqual(cleanedPayload?.components, []);
});

test("idle cleanup archives completed now playing message and clears controls", async () => {
  const listeners = new Map();
  const player = {
    state: {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    stop: () => {},
  };
  let playNextGuildId = null;
  const { getGuildQueue, ensurePlayerListeners } = createSession({
    player,
    deps: {
      getPlayNext: () => async (guildId) => {
        playNextGuildId = guildId;
      },
    },
  });

  let cleanedPayload = null;
  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 89,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
    artist: "sleepmethods",
  };
  queue.nowPlayingTrackSnapshot = { ...queue.current };
  queue.nowPlayingMessageId = "np-1";
  queue.nowPlayingChannelId = "text-1";
  queue.textChannel = {
    id: "text-1",
    messages: {
      async fetch() {
        return {
          async edit(payload) {
            cleanedPayload = payload;
          },
        };
      },
    },
  };

  ensurePlayerListeners(queue, "guild-1");
  listeners.get("idle")();
  await new Promise((resolve) => setImmediate(resolve));

  const content = String(cleanedPayload?.content || "");
  assert.equal(content.includes("**Played:**"), true);
  assert.equal(content.includes("**Progress:**"), false);
  assert.equal(content.includes("**Up next:**"), false);
  assert.equal(content.includes("**Remaining:**"), false);
  assert.deepEqual(cleanedPayload?.components, []);
  assert.equal(queue.nowPlayingMessageId, null);
  assert.equal(queue.nowPlayingChannelId, null);
  assert.equal(playNextGuildId, "guild-1");
});

test("idle cleanup resolves original now playing channel when queue text channel changed", async () => {
  const listeners = new Map();
  const player = {
    state: {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    stop: () => {},
  };
  let cleanedPayload = null;
  let resolvedChannelId = null;

  const { getGuildQueue, ensurePlayerListeners } = createSession({
    player,
    deps: {
      getPlayNext: () => async () => {},
      resolveNowPlayingChannelById: async (channelId) => {
        resolvedChannelId = channelId;
        return {
          messages: {
            async fetch() {
              return {
                async edit(payload) {
                  cleanedPayload = payload;
                },
              };
            },
          },
        };
      },
    },
  });

  const queue = getGuildQueue("guild-1");
  queue.current = {
    id: "track-1",
    title: "Song",
    requester: "Requester",
    duration: 89,
    url: "https://soundcloud.com/sleepmethods/piggy",
    source: "soundcloud",
    artist: "sleepmethods",
  };
  queue.nowPlayingTrackSnapshot = { ...queue.current };
  queue.nowPlayingMessageId = "np-1";
  queue.nowPlayingChannelId = "old-channel";
  queue.textChannel = { id: "new-channel" };

  ensurePlayerListeners(queue, "guild-1");
  listeners.get("idle")();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(resolvedChannelId, "old-channel");
  assert.equal(String(cleanedPayload?.content || "").includes("**Played:**"), true);
  assert.deepEqual(cleanedPayload?.components, []);
});
