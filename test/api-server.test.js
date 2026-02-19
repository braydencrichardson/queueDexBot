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
