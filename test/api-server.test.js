const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

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
      bodyChunks.push(Buffer.from(String(content)));
      resolveDone();
    },
    async toResult() {
      await done;
      const rawBody = Buffer.concat(bodyChunks).toString("utf8");
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
