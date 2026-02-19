const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApiServer } = require("../src/web/api-server");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createMockRequest({
  method,
  path,
  headers = {},
  body,
}) {
  const request = new EventEmitter();
  request.method = method;
  request.url = path;
  request.headers = {
    host: "test.local",
    ...headers,
  };
  request.destroy = () => {};

  process.nextTick(() => {
    if (body !== undefined) {
      request.emit("data", Buffer.from(String(body)));
    }
    request.emit("end");
  });

  return request;
}

function createMockResponse() {
  let statusCode = 200;
  const headers = new Map();
  const bodyChunks = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  return {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    end(content = "") {
      if (Buffer.isBuffer(content)) {
        bodyChunks.push(content);
      } else if (content instanceof Uint8Array) {
        bodyChunks.push(Buffer.from(content));
      } else {
        bodyChunks.push(Buffer.from(String(content)));
      }
      resolveDone();
    },
    async toResult() {
      await done;
      const bodyBuffer = Buffer.concat(bodyChunks);
      const rawBody = bodyBuffer.toString("utf8");
      let json = null;
      if (rawBody) {
        try {
          json = JSON.parse(rawBody);
        } catch {
          json = null;
        }
      }
      return {
        statusCode,
        headers,
        bodyBuffer,
        rawBody,
        json,
      };
    },
  };
}

async function dispatch(serverApi, requestOptions) {
  const request = createMockRequest(requestOptions);
  const response = createMockResponse();
  await serverApi.handleRequest(request, response);
  return response.toResult();
}

function createDiscordFetchMock() {
  return async (url, fetchOptions) => {
    const target = String(url || "");
    if (target === "https://discord.com/api/v10/users/@me") {
      return jsonResponse({
        id: "user-1",
        username: "userone",
        global_name: "User One",
      });
    }
    if (target === "https://discord.com/api/v10/users/@me/guilds") {
      return jsonResponse([{ id: "guild-1", name: "Guild One", owner: true, permissions: "0" }]);
    }
    throw new Error(`Unexpected fetch URL in test: ${target}`);
  };
}

async function createSessionCookie(serverApi) {
  const sessionResponse = await dispatch(serverApi, {
    method: "POST",
    path: "/auth/discord/activity/session",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      access_token: "access-token-1",
      scopes: ["identify", "guilds"],
    }),
  });

  assert.equal(sessionResponse.statusCode, 200);
  const setCookie = String(sessionResponse.headers.get("set-cookie") || "");
  assert.notEqual(setCookie, "");
  return setCookie.split(";")[0];
}

test("api control requires user to be in bot voice channel", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let pauseCalled = false;
  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "playing" },
      pause() {
        pauseCalled = true;
      },
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => null,
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/control",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "pause",
      }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json?.error, "Join the bot voice channel to use controls");
    assert.equal(pauseCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("api control allows playback action for user in same voice channel", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let pauseCalled = false;
  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "playing" },
      pause() {
        pauseCalled = true;
      },
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/control",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "pause",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(response.json?.action, "pause");
    assert.equal(response.json?.guildId, "guild-1");
    assert.equal(pauseCalled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("api control posts text-channel feedback for playback actions", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let pauseCalled = false;
  const sentMessages = [];
  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    textChannel: {
      async send(content) {
        sentMessages.push(String(content));
      },
    },
    player: {
      state: { status: "playing" },
      pause() {
        pauseCalled = true;
      },
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/control",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "pause",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(pauseCalled, true);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0], "**User One** paused playback.");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity control does not attach queue text channel from request context when no existing binding", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let pauseCalled = false;
  const sentMessages = [];
  let resolveTextChannelByIdCalled = false;
  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    textChannel: null,
    textChannelId: null,
    player: {
      state: { status: "playing" },
      pause() {
        pauseCalled = true;
      },
      unpause() {},
      stop() {},
    },
  };

  const resolvedTextChannel = {
    id: "text-123",
    name: "web-controls",
    async send(content) {
      sentMessages.push(String(content));
      return { id: "msg-1" };
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    resolveTextChannelById: async (_guildId, channelId) => {
      resolveTextChannelByIdCalled = true;
      return channelId === "text-123" ? resolvedTextChannel : null;
    },
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/control",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "pause",
        text_channel_id: "text-123",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(pauseCalled, true);
    assert.equal(queue.textChannelId, null);
    assert.equal(queue.textChannel, null);
    assert.equal(resolveTextChannelByIdCalled, false);
    assert.equal(sentMessages.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity control does not override an existing queue text channel binding", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let pauseCalled = false;
  const sentMessages = [];
  let resolveTextChannelByIdCalled = false;
  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    textChannel: {
      id: "text-bound",
      name: "general",
      async send(content) {
        sentMessages.push(String(content));
        return { id: "msg-1" };
      },
    },
    textChannelId: "text-bound",
    player: {
      state: { status: "playing" },
      pause() {
        pauseCalled = true;
      },
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    resolveTextChannelById: async () => {
      resolveTextChannelByIdCalled = true;
      return {
        id: "text-other",
        name: "voice-chat",
        async send() {
          return { id: "msg-2" };
        },
      };
    },
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/control",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "pause",
        text_channel_id: "text-other",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(pauseCalled, true);
    assert.equal(queue.textChannelId, "text-bound");
    assert.equal(queue.textChannel?.id, "text-bound");
    assert.equal(resolveTextChannelByIdCalled, false);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0], "**User One** paused playback.");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity state includes queue channel attachments and user event feed", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const activityFeed = Array.from({ length: 35 }, (_, index) => ({
    id: `evt-${index + 1}`,
    time: `2026-02-19T00:${String(index).padStart(2, "0")}:00.000Z`,
    level: "info",
    message: `Event ${index + 1}`,
    source: "api_queue_search:resolve",
  }));

  const queue = {
    current: null,
    tracks: [],
    voiceChannel: { id: "voice-1", name: "Lounge" },
    connection: { joinConfig: { channelId: "voice-1" } },
    textChannel: {
      id: "text-1",
      name: "music-feed",
      async send() {
        return null;
      },
    },
    activityFeed,
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const response = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/state?guild_id=guild-1",
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.data?.attachments?.voice?.id, "voice-1");
    assert.equal(response.json?.data?.attachments?.voice?.name, "Lounge");
    assert.equal(response.json?.data?.attachments?.text?.id, "text-1");
    assert.equal(response.json?.data?.attachments?.text?.name, "music-feed");
    assert.equal(response.json?.data?.access?.queueVoiceChannelId, "voice-1");
    assert.equal(response.json?.data?.access?.userVoiceChannelId, "voice-1");
    assert.equal(response.json?.data?.access?.sameVoiceChannel, true);
    assert.equal(response.json?.data?.access?.canStartSearch, true);
    assert.equal(Array.isArray(response.json?.data?.activityFeed), true);
    assert.equal(response.json?.data?.activityFeed?.length, 20);
    assert.equal(response.json?.data?.activityFeed?.[0]?.message, "Event 16");
    assert.equal(response.json?.data?.activityFeed?.[19]?.message, "Event 35");
  } finally {
    global.fetch = originalFetch;
  }
});

test("api control resume forwards ensure-voice options to queue service", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "paused" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  let applyControlArgs = null;
  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    queueService: {
      applyControlAction: async (queueArg, action, options) => {
        applyControlArgs = { queueArg, action, options };
        return { ok: true };
      },
      applyQueueAction: async () => ({ ok: true }),
    },
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/control",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "resume",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(applyControlArgs?.action, "resume");
    assert.equal(applyControlArgs?.queueArg, queue);
    assert.equal(applyControlArgs?.options?.ensureVoiceConnectionOnResume, true);
    assert.deepEqual(applyControlArgs?.options?.ensureVoiceConnectionOptions, {
      guildId: "guild-1",
      preferredVoiceChannelId: "voice-1",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity session endpoint enforces JSON content type", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/auth/discord/activity/session",
      headers: {
        "content-type": "text/plain",
      },
      body: "not json",
    });

    assert.equal(response.statusCode, 415);
    assert.equal(response.json?.error, "Expected Content-Type: application/json");
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth endpoints ignore malformed cookie encoding instead of returning server error", async () => {
  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
    },
  });

  const response = await dispatch(serverApi, {
    method: "GET",
    path: "/auth/me",
    headers: {
      cookie: "qdex_session=%E0%A4%A",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json?.authenticated, false);
});

test("auth refresh-guilds updates current session guild list", async () => {
  const originalFetch = global.fetch;
  let guildCallCount = 0;
  global.fetch = async (url) => {
    const target = String(url || "");
    if (target === "https://discord.com/api/v10/users/@me") {
      return jsonResponse({
        id: "user-1",
        username: "userone",
        global_name: "User One",
      });
    }
    if (target === "https://discord.com/api/v10/users/@me/guilds") {
      guildCallCount += 1;
      if (guildCallCount <= 1) {
        return jsonResponse([{ id: "guild-1", name: "Guild One", owner: true, permissions: "0" }]);
      }
      return jsonResponse([
        { id: "guild-1", name: "Guild One", owner: true, permissions: "0" },
        { id: "guild-2", name: "Guild Two", owner: false, permissions: "0" },
      ]);
    }
    throw new Error(`Unexpected fetch URL in test: ${target}`);
  };

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const beforeRefresh = await dispatch(serverApi, {
      method: "GET",
      path: "/auth/me",
      headers: {
        cookie,
      },
    });
    assert.equal(beforeRefresh.statusCode, 200);
    assert.equal(beforeRefresh.json?.guilds?.length, 1);

    const refreshResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/auth/refresh-guilds",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({}),
    });
    assert.equal(refreshResponse.statusCode, 200);
    assert.equal(refreshResponse.json?.ok, true);
    assert.equal(refreshResponse.json?.guilds?.length, 2);

    const afterRefresh = await dispatch(serverApi, {
      method: "GET",
      path: "/auth/me",
      headers: {
        cookie,
      },
    });
    assert.equal(afterRefresh.statusCode, 200);
    assert.equal(afterRefresh.json?.guilds?.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth refresh-guilds returns conflict when session lacks guilds scope", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const sessionResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/auth/discord/activity/session",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        access_token: "access-token-1",
        scopes: ["identify"],
      }),
    });
    assert.equal(sessionResponse.statusCode, 200);
    const cookie = String(sessionResponse.headers.get("set-cookie") || "").split(";")[0];

    const refreshResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/auth/refresh-guilds",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({}),
    });
    assert.equal(refreshResponse.statusCode, 409);
    assert.equal(
      refreshResponse.json?.error,
      "Session is missing guilds scope. Sign in again with guilds scope enabled."
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("api activity state denies access when session has no guild scope and membership check fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [],
    player: {
      state: { status: "idle" },
    },
  };
  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    isUserInGuild: async () => false,
    config: {
      cookieSecure: false,
    },
  });

  try {
    const sessionResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/auth/discord/activity/session",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        access_token: "access-token-1",
        scopes: ["identify"],
      }),
    });
    assert.equal(sessionResponse.statusCode, 200);
    const cookie = String(sessionResponse.headers.get("set-cookie") || "").split(";")[0];

    const stateResponse = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/state?guild_id=guild-1",
      headers: {
        cookie,
      },
    });

    assert.equal(stateResponse.statusCode, 403);
    assert.equal(stateResponse.json?.error, "Forbidden for this guild");
  } finally {
    global.fetch = originalFetch;
  }
});

test("api activity state allows no-guild-scope session when user membership check passes", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [],
    player: {
      state: { status: "idle" },
    },
  };
  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    isUserInGuild: async (guildId, userId) => guildId === "guild-1" && userId === "user-1",
    config: {
      cookieSecure: false,
    },
  });

  try {
    const sessionResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/auth/discord/activity/session",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        access_token: "access-token-1",
        scopes: ["identify"],
      }),
    });
    assert.equal(sessionResponse.statusCode, 200);
    const cookie = String(sessionResponse.headers.get("set-cookie") || "").split(";")[0];

    const stateResponse = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/state?guild_id=guild-1",
      headers: {
        cookie,
      },
    });

    assert.equal(stateResponse.statusCode, 200);
    assert.equal(stateResponse.json?.guildId, "guild-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth session persists across api server restarts when session store is enabled", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdex-session-store-"));
  const sessionStorePath = path.join(tempDir, "sessions.json");
  const serverConfig = {
    cookieSecure: false,
    sessionStoreEnabled: true,
    sessionStorePath,
  };

  try {
    const firstServer = createApiServer({
      queues: new Map(),
      config: serverConfig,
    });

    const cookie = await createSessionCookie(firstServer);
    const beforeRestart = await dispatch(firstServer, {
      method: "GET",
      path: "/auth/me",
      headers: {
        cookie,
      },
    });
    assert.equal(beforeRestart.statusCode, 200);
    assert.equal(beforeRestart.json?.authenticated, true);
    assert.equal(beforeRestart.json?.user?.id, "user-1");
    assert.equal(fs.existsSync(sessionStorePath), true);

    const restartedServer = createApiServer({
      queues: new Map(),
      config: serverConfig,
    });

    const afterRestart = await dispatch(restartedServer, {
      method: "GET",
      path: "/auth/me",
      headers: {
        cookie,
      },
    });
    assert.equal(afterRestart.statusCode, 200);
    assert.equal(afterRestart.json?.authenticated, true);
    assert.equal(afterRestart.json?.user?.id, "user-1");
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("activity queue endpoint returns paged queue data", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: { id: "now-1", title: "Now", duration: 100 },
    tracks: [
      { id: "t-1", title: "One", duration: 11 },
      { id: "t-2", title: "Two", duration: 22 },
      { id: "t-3", title: "Three", duration: 33 },
    ],
    loopMode: "off",
    player: { state: { status: "playing" } },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/queue?guild_id=guild-1&offset=1&limit=2",
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.guildId, "guild-1");
    assert.equal(response.json?.total, 3);
    assert.equal(Array.isArray(response.json?.tracks), true);
    assert.equal(response.json?.tracks.length, 2);
    assert.equal(response.json?.tracks[0]?.position, 2);
    assert.equal(response.json?.tracks[0]?.title, "Two");
    assert.equal(response.json?.tracks[1]?.position, 3);
    assert.equal(response.json?.tracks[1]?.title, "Three");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity thumbnail proxy returns image bytes for authenticated session", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url || "");
    if (target === "https://discord.com/api/v10/users/@me") {
      return jsonResponse({
        id: "user-1",
        username: "userone",
        global_name: "User One",
      });
    }
    if (target === "https://discord.com/api/v10/users/@me/guilds") {
      return jsonResponse([{ id: "guild-1", name: "Guild One", owner: true, permissions: "0" }]);
    }
    if (target === "https://i1.sndcdn.com/artworks-test-large.jpg") {
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
        },
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${target}`);
  };

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "GET",
      path: `/api/activity/thumbnail?src=${encodeURIComponent("https://i1.sndcdn.com/artworks-test-large.jpg")}`,
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.bodyBuffer.length > 0, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity thumbnail proxy rejects non-allowlisted hosts", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "GET",
      path: `/api/activity/thumbnail?src=${encodeURIComponent("https://example.com/test.jpg")}`,
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json?.error, "Thumbnail host is not allowed");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity thumbnail proxy rejects redirects to non-allowlisted hosts", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url || "");
    if (target === "https://discord.com/api/v10/users/@me") {
      return jsonResponse({
        id: "user-1",
        username: "userone",
        global_name: "User One",
      });
    }
    if (target === "https://discord.com/api/v10/users/@me/guilds") {
      return jsonResponse([{ id: "guild-1", name: "Guild One", owner: true, permissions: "0" }]);
    }
    if (target === "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://example.com/forbidden.jpg",
        },
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${target}`);
  };

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "GET",
      path: `/api/activity/thumbnail?src=${encodeURIComponent("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg")}`,
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json?.error, "Thumbnail redirect host is not allowed");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue action move reorders queue when authorized", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: { id: "now-1", title: "Now" },
    tracks: [
      { id: "t-1", title: "One" },
      { id: "t-2", title: "Two" },
      { id: "t-3", title: "Three" },
    ],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "playing" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/action",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "move",
        from_position: 3,
        to_position: 1,
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(response.json?.action, "move");
    assert.equal(response.json?.result?.moved?.title, "Three");
    assert.equal(response.json?.result?.fromPosition, 3);
    assert.equal(response.json?.result?.toPosition, 1);
    assert.deepEqual(queue.tracks.map((track) => track.title), ["Three", "One", "Two"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue action posts text-channel feedback for queue edits", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const sentMessages = [];
  const queue = {
    current: { id: "now-1", title: "Now" },
    tracks: [
      { id: "t-1", title: "One" },
      { id: "t-2", title: "Two" },
    ],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    textChannel: {
      async send(content) {
        sentMessages.push(String(content));
      },
    },
    player: {
      state: { status: "playing" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/action",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "remove",
        position: 2,
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0], "User One removed Two from the queue.");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue action returns validation errors for invalid queue positions", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: { id: "now-1", title: "Now" },
    tracks: [
      { id: "t-1", title: "One" },
      { id: "t-2", title: "Two" },
    ],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "playing" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/action",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "remove",
        position: 99,
      }),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(String(response.json?.error || "").includes("Invalid queue position"), true);
    assert.deepEqual(queue.tracks.map((track) => track.title), ["One", "Two"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue action requires user in bot voice channel", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: { id: "now-1", title: "Now" },
    tracks: [
      { id: "t-1", title: "One" },
      { id: "t-2", title: "Two" },
    ],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "playing" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => null,
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/action",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "shuffle",
      }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json?.error, "Join the bot voice channel to use controls");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search returns chooser options when direct resolve finds no tracks", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const resolveTracksCalls = [];
  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async (query, requester, options) => {
      resolveTracksCalls.push({ query, requester, options });
      return [];
    },
    getSearchOptionsForQuery: async () => ([
      {
        title: "First Result",
        url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        displayUrl: "https://youtu.be/aaaaaaaaaaa",
        duration: 111,
        source: "youtube",
        channel: "Artist One",
      },
      {
        title: "Second Result",
        url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
        displayUrl: "https://youtu.be/bbbbbbbbbbb",
        duration: 222,
        source: "youtube",
        channel: "Artist Two",
      },
    ]),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "example query",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(response.json?.mode, "chooser");
    assert.equal(response.json?.guildId, "guild-1");
    assert.equal(String(response.json?.search?.id || "").length > 0, true);
    assert.equal(Array.isArray(response.json?.search?.options), true);
    assert.equal(response.json?.search?.options?.length, 2);
    assert.equal(resolveTracksCalls.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search avoids direct resolve for plain text when chooser has no results", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  let resolveTracksCalls = 0;
  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async () => {
      resolveTracksCalls += 1;
      return [];
    },
    getSearchOptionsForQuery: async () => [],
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "plain text query",
      }),
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json?.error, "No results found.");
    assert.equal(resolveTracksCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search select queues selected chooser result and starts playback", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const sentMessages = [];
  const ensureVoiceConnectionCalls = [];
  const playNextCalls = [];
  const queue = {
    current: null,
    tracks: [],
    playing: false,
    voiceChannel: null,
    connection: null,
    textChannel: {
      async send(content) {
        sentMessages.push(String(content));
      },
    },
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async () => [],
    getSearchOptionsForQuery: async () => ([
      {
        title: "Selected Result",
        url: "https://www.youtube.com/watch?v=ccccccccccc",
        displayUrl: "https://youtu.be/ccccccccccc",
        duration: 150,
        source: "youtube",
        channel: "Artist Three",
      },
    ]),
    ensureQueueVoiceConnection: async (targetQueue, options) => {
      ensureVoiceConnectionCalls.push(options);
      targetQueue.voiceChannel = { id: options.preferredVoiceChannelId };
      targetQueue.connection = { joinConfig: { channelId: options.preferredVoiceChannelId } };
      return {
        ok: true,
        joined: true,
      };
    },
    getPlayNext: () => async (guildId) => {
      playNextCalls.push(guildId);
    },
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const searchResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "search term",
      }),
    });

    assert.equal(searchResponse.statusCode, 200);
    assert.equal(searchResponse.json?.mode, "chooser");
    const searchId = searchResponse.json?.search?.id;
    assert.equal(typeof searchId, "string");
    assert.notEqual(searchId, "");

    const selectResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search/select",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        search_id: searchId,
        option_index: 0,
      }),
    });

    assert.equal(selectResponse.statusCode, 200);
    assert.equal(selectResponse.json?.ok, true);
    assert.equal(selectResponse.json?.mode, "queued");
    assert.equal(selectResponse.json?.queued?.title, "Selected Result");
    assert.equal(selectResponse.json?.queuedPosition, 1);
    assert.equal(queue.tracks.length, 1);
    assert.equal(queue.tracks[0]?.title, "Selected Result");
    assert.equal(ensureVoiceConnectionCalls.length, 1);
    assert.equal(ensureVoiceConnectionCalls[0]?.preferredVoiceChannelId, "voice-1");
    assert.deepEqual(playNextCalls, ["guild-1"]);
    assert.equal(sentMessages.length, 1);
    assert.equal(String(sentMessages[0] || "").includes("**Queued:**"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search queues resolved tracks directly without chooser", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const ensureVoiceConnectionCalls = [];
  const queue = {
    current: null,
    tracks: [],
    playing: false,
    voiceChannel: null,
    connection: null,
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  let searchOptionsCalled = false;
  let resolveTracksCalls = 0;
  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async (_query, requester, options) => {
      resolveTracksCalls += 1;
      assert.equal(options?.allowSearchFallback, false);
      return [{
        title: "Direct Result",
        url: "https://www.youtube.com/watch?v=ddddddddddd",
        displayUrl: "https://youtu.be/ddddddddddd",
        duration: 210,
        source: "youtube",
        channel: "Artist Four",
        requester,
      }];
    },
    getSearchOptionsForQuery: async () => {
      searchOptionsCalled = true;
      return [];
    },
    ensureQueueVoiceConnection: async (_targetQueue, options) => {
      ensureVoiceConnectionCalls.push(options);
      return { ok: true };
    },
    getPlayNext: () => async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "https://youtu.be/ddddddddddd",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(response.json?.mode, "queued");
    assert.equal(response.json?.queuedCount, 1);
    assert.equal(response.json?.queued?.title, "Direct Result");
    assert.equal(response.json?.queuedPosition, 1);
    assert.equal(queue.tracks.length, 1);
    assert.equal(resolveTracksCalls, 1);
    assert.equal(searchOptionsCalled, false);
    assert.equal(ensureVoiceConnectionCalls.length, 1);
    assert.equal(ensureVoiceConnectionCalls[0]?.preferredVoiceChannelId, "voice-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search can replace an existing queued track by track id", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const sentMessages = [];
  const queue = {
    current: null,
    tracks: [
      {
        id: "track-old",
        title: "Old Track",
        url: "https://youtu.be/oldoldold01",
        displayUrl: "https://youtu.be/oldoldold01",
        duration: 101,
        source: "youtube",
        channel: "Old Artist",
        requester: "User One",
      },
      {
        id: "track-keep",
        title: "Keep Track",
        url: "https://youtu.be/keepkeep001",
        displayUrl: "https://youtu.be/keepkeep001",
        duration: 202,
        source: "youtube",
        channel: "Keep Artist",
        requester: "User One",
      },
    ],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    textChannel: {
      async send(content) {
        sentMessages.push(String(content));
      },
    },
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async (_query, requester) => ([{
      title: "Replacement Result",
      url: "https://www.youtube.com/watch?v=rrrrrrrrrrr",
      displayUrl: "https://youtu.be/rrrrrrrrrrr",
      duration: 187,
      source: "youtube",
      channel: "New Artist",
      requester,
    }]),
    getPlayNext: () => async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "https://youtu.be/rrrrrrrrrrr",
        replace_track_id: "track-old",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(response.json?.mode, "queued");
    assert.equal(response.json?.queuedCount, 1);
    assert.equal(response.json?.queuedPosition, 1);
    assert.equal(response.json?.replacement?.targetTrackId, "track-old");
    assert.equal(response.json?.replacement?.position, 1);
    assert.equal(response.json?.replacement?.previous?.title, "Old Track");
    assert.equal(queue.tracks.length, 2);
    assert.equal(queue.tracks[0]?.title, "Replacement Result");
    assert.equal(queue.tracks[1]?.title, "Keep Track");
    assert.equal(sentMessages.length, 1);
    assert.equal(String(sentMessages[0] || "").includes("**Replaced:**"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search chooser select can replace queued track by id", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [
      {
        id: "track-old",
        title: "Old Track",
        url: "https://youtu.be/oldoldold01",
        displayUrl: "https://youtu.be/oldoldold01",
        duration: 101,
        source: "youtube",
        channel: "Old Artist",
        requester: "User One",
      },
      {
        id: "track-keep",
        title: "Keep Track",
        url: "https://youtu.be/keepkeep001",
        displayUrl: "https://youtu.be/keepkeep001",
        duration: 202,
        source: "youtube",
        channel: "Keep Artist",
        requester: "User One",
      },
    ],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async () => [],
    getSearchOptionsForQuery: async () => ([
      {
        title: "Chooser Replacement",
        url: "https://www.youtube.com/watch?v=sssssssssss",
        displayUrl: "https://youtu.be/sssssssssss",
        duration: 233,
        source: "youtube",
        channel: "Chooser Artist",
      },
      {
        title: "Second Option",
        url: "https://www.youtube.com/watch?v=ttttttttttt",
        displayUrl: "https://youtu.be/ttttttttttt",
        duration: 222,
        source: "youtube",
        channel: "Other Artist",
      },
    ]),
    getPlayNext: () => async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const searchResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "replace me",
        replace_track_id: "track-old",
      }),
    });

    assert.equal(searchResponse.statusCode, 200);
    assert.equal(searchResponse.json?.mode, "chooser");
    assert.equal(searchResponse.json?.search?.replacement?.targetTrackId, "track-old");
    assert.equal(searchResponse.json?.search?.replacement?.position, 1);
    const searchId = String(searchResponse.json?.search?.id || "");
    assert.notEqual(searchId, "");

    const selectResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search/select",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        search_id: searchId,
        option_index: 0,
      }),
    });

    assert.equal(selectResponse.statusCode, 200);
    assert.equal(selectResponse.json?.ok, true);
    assert.equal(selectResponse.json?.mode, "queued");
    assert.equal(selectResponse.json?.queued?.title, "Chooser Replacement");
    assert.equal(selectResponse.json?.replacement?.targetTrackId, "track-old");
    assert.equal(selectResponse.json?.replacement?.position, 1);
    assert.equal(queue.tracks.length, 2);
    assert.equal(queue.tracks[0]?.title, "Chooser Replacement");
    assert.equal(queue.tracks[1]?.title, "Keep Track");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search replacement returns conflict when target track is missing", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [
      { id: "track-keep", title: "Keep Track" },
    ],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async () => ([{
      title: "Replacement Result",
      url: "https://www.youtube.com/watch?v=vvvvvvvvvvv",
      displayUrl: "https://youtu.be/vvvvvvvvvvv",
      duration: 199,
      source: "youtube",
      channel: "New Artist",
    }]),
    getPlayNext: () => async () => {},
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "https://youtu.be/vvvvvvvvvvv",
        replace_track_id: "track-missing",
      }),
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json?.error, "That queue item is no longer available for replacement.");
    assert.equal(queue.tracks.length, 1);
    assert.equal(queue.tracks[0]?.id, "track-keep");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search returns link-resolution error for unresolved URL query", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  let resolveTracksCalls = 0;
  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => "voice-1",
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async () => {
      resolveTracksCalls += 1;
      return [];
    },
    getSearchOptionsForQuery: async () => [],
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "https://youtu.be/invalid-id",
      }),
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json?.error, "Could not resolve that link.");
    assert.equal(resolveTracksCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity queue search requires caller voice channel when queue is not connected", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [],
    playing: false,
    voiceChannel: null,
    connection: null,
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => null,
    normalizeQueryInput: (value) => String(value || "").trim(),
    resolveTracks: async () => ([{
      title: "Direct Result",
      url: "https://www.youtube.com/watch?v=eeeeeeeeeee",
      displayUrl: "https://youtu.be/eeeeeeeeeee",
      duration: 99,
      source: "youtube",
      channel: "Artist Five",
    }]),
    config: {
      cookieSecure: false,
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/queue/search",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        query: "https://youtu.be/eeeeeeeeeee",
      }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json?.error, "Join a voice channel first.");
    assert.equal(queue.tracks.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth me includes admin flags when session user is configured as admin", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "GET",
      path: "/auth/me",
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.authenticated, true);
    assert.equal(response.json?.admin?.isAdmin, true);
    assert.equal(response.json?.admin?.bypassVoiceChannelCheck, false);
    assert.equal(response.json?.admin?.bypassGuildAccess, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity admin settings endpoint rejects non-admin users", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const serverApi = createApiServer({
    queues: new Map(),
    config: {
      cookieSecure: false,
      adminUserIds: ["different-user"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/admin/settings",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        bypass_voice_check: true,
      }),
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json?.error, "Forbidden");
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity admin can enable voice-check bypass for current session", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let pauseCalled = false;
  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "playing" },
      pause() {
        pauseCalled = true;
      },
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    getUserVoiceChannelId: async () => null,
    sendNowPlaying: async () => {},
    maybeRefreshNowPlayingUpNext: async () => {},
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const adminUpdateResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/admin/settings",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        bypass_voice_check: true,
      }),
    });

    assert.equal(adminUpdateResponse.statusCode, 200);
    assert.equal(adminUpdateResponse.json?.ok, true);
    assert.equal(adminUpdateResponse.json?.admin?.isAdmin, true);
    assert.equal(adminUpdateResponse.json?.admin?.bypassVoiceChannelCheck, true);
    assert.equal(adminUpdateResponse.json?.admin?.bypassGuildAccess, false);

    const authMeResponse = await dispatch(serverApi, {
      method: "GET",
      path: "/auth/me",
      headers: {
        cookie,
      },
    });

    assert.equal(authMeResponse.statusCode, 200);
    assert.equal(authMeResponse.json?.admin?.isAdmin, true);
    assert.equal(authMeResponse.json?.admin?.bypassVoiceChannelCheck, true);
    assert.equal(authMeResponse.json?.admin?.bypassGuildAccess, false);

    const controlResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/control",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
        action: "pause",
      }),
    });

    assert.equal(controlResponse.statusCode, 200);
    assert.equal(controlResponse.json?.ok, true);
    assert.equal(pauseCalled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("activity admin can enable guild-access bypass and control guild outside session guild list", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const queue = {
    current: null,
    tracks: [],
    player: {
      state: { status: "idle" },
      pause() {},
      unpause() {},
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-2", queue]]),
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const deniedBeforeToggle = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/state?guild_id=guild-2",
      headers: {
        cookie,
      },
    });

    assert.equal(deniedBeforeToggle.statusCode, 403);

    const adminUpdateResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/admin/settings",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        bypass_guild_access: true,
      }),
    });

    assert.equal(adminUpdateResponse.statusCode, 200);
    assert.equal(adminUpdateResponse.json?.ok, true);
    assert.equal(adminUpdateResponse.json?.admin?.isAdmin, true);
    assert.equal(adminUpdateResponse.json?.admin?.bypassGuildAccess, true);
    assert.equal(adminUpdateResponse.json?.admin?.bypassVoiceChannelCheck, false);

    const allowedAfterToggle = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/state?guild_id=guild-2",
      headers: {
        cookie,
      },
    });

    assert.equal(allowedAfterToggle.statusCode, 200);
    assert.equal(allowedAfterToggle.json?.guildId, "guild-2");
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin events endpoint returns filtered entries for admin users", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const serverApi = createApiServer({
    queues: new Map(),
    getAdminEvents: ({ minLevel, limit }) => ([
      { id: 1, time: "2026-01-01T00:00:00.000Z", level: minLevel, message: "event-1" },
    ].slice(0, limit)),
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/admin/events?level=warn&limit=5",
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.level, "warn");
    assert.equal(response.json?.limit, 5);
    assert.equal(Array.isArray(response.json?.events), true);
    assert.equal(response.json?.events.length, 1);
    assert.equal(response.json?.events[0]?.level, "warn");
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin guild list endpoint returns bot guild list for admin users", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  const serverApi = createApiServer({
    queues: new Map(),
    getBotGuilds: () => ([
      { id: "guild-1", name: "Guild One" },
      { id: "guild-2", name: "Guild Two" },
    ]),
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/admin/guilds",
      headers: {
        cookie,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(Array.isArray(response.json?.guilds), true);
    assert.equal(response.json?.guilds.length, 2);
    assert.equal(response.json?.guilds[0]?.id, "guild-1");
    assert.equal(response.json?.guilds[1]?.id, "guild-2");
    assert.equal(response.json?.total, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin provider endpoints return status and verification payloads", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let reinitializeCalled = false;
  const serverApi = createApiServer({
    queues: new Map(),
    getProviderStatus: () => ({
      soundcloud: { ready: true },
      youtube: { ready: false },
      spotify: { ready: true },
    }),
    verifyProviderAuthStatus: async () => ({
      overallOk: false,
      youtube: { ok: false, cookieCheck: { ok: false, reason: "expired" } },
    }),
    reinitializeProviders: async () => {
      reinitializeCalled = true;
      return { soundcloudReady: true, youtubeReady: true, spotifyReady: true };
    },
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const statusResponse = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/admin/providers/status",
      headers: {
        cookie,
      },
    });

    assert.equal(statusResponse.statusCode, 200);
    assert.equal(statusResponse.json?.ok, true);
    assert.equal(statusResponse.json?.providers?.soundcloud?.ready, true);
    assert.equal(statusResponse.json?.providers?.youtube?.ready, false);

    const verifyResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/admin/providers/verify",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({}),
    });

    assert.equal(verifyResponse.statusCode, 200);
    assert.equal(verifyResponse.json?.ok, true);
    assert.equal(verifyResponse.json?.verification?.overallOk, false);
    assert.equal(verifyResponse.json?.verification?.youtube?.ok, false);

    const reinitializeResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/admin/providers/reinitialize",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({}),
    });

    assert.equal(reinitializeResponse.statusCode, 200);
    assert.equal(reinitializeResponse.json?.ok, true);
    assert.equal(reinitializeCalled, true);
    assert.equal(reinitializeResponse.json?.result?.youtubeReady, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin discord gateway endpoints return watchdog status and trigger relogin", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let forceReloginCalls = 0;
  let lastReloginReason = null;
  const serverApi = createApiServer({
    queues: new Map(),
    getDiscordGatewayStatus: async () => ({
      enabled: true,
      started: true,
      invalidated: false,
      reloginInFlight: false,
      reloginAttempts: 2,
      nextReloginAt: 1234567890,
      disconnectedShardIds: ["0"],
      disconnectedShardCount: 1,
    }),
    forceDiscordRelogin: async ({ reason }) => {
      forceReloginCalls += 1;
      lastReloginReason = reason;
      return {
        accepted: true,
      };
    },
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);

    const statusResponse = await dispatch(serverApi, {
      method: "GET",
      path: "/api/activity/admin/discord/status",
      headers: {
        cookie,
      },
    });
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(statusResponse.json?.ok, true);
    assert.equal(statusResponse.json?.gateway?.enabled, true);
    assert.equal(statusResponse.json?.gateway?.disconnectedShardCount, 1);
    assert.deepEqual(statusResponse.json?.gateway?.disconnectedShardIds, ["0"]);

    const reloginResponse = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/admin/discord/relogin",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        reason: "manual test",
      }),
    });
    assert.equal(reloginResponse.statusCode, 200);
    assert.equal(reloginResponse.json?.ok, true);
    assert.equal(reloginResponse.json?.relogin?.accepted, true);
    assert.equal(forceReloginCalls, 1);
    assert.equal(String(lastReloginReason || "").includes("manual test"), true);
    assert.equal(reloginResponse.json?.gateway?.enabled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin queue force cleanup stops and clears selected guild queue", async () => {
  const originalFetch = global.fetch;
  global.fetch = createDiscordFetchMock();

  let stopCalled = false;
  const queue = {
    current: { id: "track-1", title: "Song" },
    tracks: [{ id: "t-1", title: "One" }],
    voiceChannel: { id: "voice-1" },
    connection: { joinConfig: { channelId: "voice-1" } },
    player: {
      state: { status: "playing" },
      stop() {},
    },
  };

  const serverApi = createApiServer({
    queues: new Map([["guild-1", queue]]),
    stopAndLeaveQueue: (targetQueue) => {
      stopCalled = true;
      targetQueue.current = null;
      targetQueue.tracks = [];
      targetQueue.connection = null;
      targetQueue.voiceChannel = null;
    },
    config: {
      cookieSecure: false,
      adminUserIds: ["user-1"],
    },
  });

  try {
    const cookie = await createSessionCookie(serverApi);
    const response = await dispatch(serverApi, {
      method: "POST",
      path: "/api/activity/admin/queue/force-cleanup",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        guild_id: "guild-1",
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(stopCalled, true);
    assert.equal(response.json?.data?.connected, false);
    assert.equal(response.json?.data?.queueLength, 0);
    assert.equal(response.json?.data?.nowPlaying, null);
  } finally {
    global.fetch = originalFetch;
  }
});
