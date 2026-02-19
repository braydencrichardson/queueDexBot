const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createSpotifyApiClient } = require("../src/providers/spotify-api-client");

function jsonResponse(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload),
  };
}

function createHttpsMock(responseHandlers) {
  let index = 0;
  const requests = [];

  return {
    requests,
    request(options, callback) {
      const req = new EventEmitter();
      let body = "";
      req.setTimeout = () => {};
      req.write = (chunk) => {
        body += String(chunk);
      };
      req.destroy = (error) => {
        process.nextTick(() => {
          req.emit("error", error || new Error("request destroyed"));
        });
      };
      req.end = () => {
        const handler = responseHandlers[index];
        index += 1;
        if (!handler) {
          process.nextTick(() => {
            req.emit("error", new Error(`Missing mock response for request #${index}`));
          });
          return;
        }

        let response;
        try {
          response = typeof handler === "function"
            ? handler({ options, body, index: index - 1, requests })
            : handler;
        } catch (error) {
          process.nextTick(() => {
            req.emit("error", error);
          });
          return;
        }

        requests.push({ options, body });
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = response.statusCode || 0;
          res.headers = response.headers || {};
          callback(res);
          if (response.body !== undefined && response.body !== null) {
            res.emit("data", Buffer.from(String(response.body)));
          }
          res.emit("end");
        });
      };
      return req;
    },
  };
}

function createClient(overrides = {}) {
  return createSpotifyApiClient({
    clientId: "spotify-client-id",
    clientSecret: "spotify-client-secret",
    refreshToken: "spotify-refresh-token",
    ...overrides,
  });
}

test("spotify API client retries 429 with Retry-After header", async () => {
  const delays = [];
  const logEvents = [];
  const httpsMock = createHttpsMock([
    jsonResponse(200, { access_token: "token-user", expires_in: 3600 }),
    jsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "2" }),
    jsonResponse(200, { id: "track-123", name: "Recovered Track" }),
  ]);
  const client = createClient({
    httpsModule: httpsMock,
    sleep: async (ms) => {
      delays.push(ms);
    },
    logInfo: (message, data) => {
      logEvents.push({ message, data });
    },
  });

  const track = await client.getTrackById("track-123");

  assert.equal(track?.id, "track-123");
  assert.deepEqual(delays, [2000]);
  assert.equal(
    logEvents.some((entry) => entry.message === "Spotify API rate limited; retrying request"),
    true
  );
});

test("spotify API client retries album request after 429", async () => {
  const delays = [];
  const httpsMock = createHttpsMock([
    jsonResponse(200, { access_token: "token-user", expires_in: 3600 }),
    jsonResponse(429, {}, { "retry-after": "0" }),
    jsonResponse(200, {
      name: "Album One",
      tracks: {
        items: [{ id: "track-1", name: "Track One" }],
        next: null,
      },
    }),
  ]);
  const client = createClient({
    httpsModule: httpsMock,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  const tracks = await client.getAlbumTracksById("album-1");

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].album?.name, "Album One");
  assert.equal(delays.length, 1);
});

test("spotify API client stops retrying after configured 429 attempts", async () => {
  const delays = [];
  const httpsMock = createHttpsMock([
    jsonResponse(200, { access_token: "token-user", expires_in: 3600 }),
    jsonResponse(429, {}, {}),
    jsonResponse(429, {}, {}),
  ]);
  const client = createClient({
    httpsModule: httpsMock,
    rateLimitMaxRetries: 1,
    rateLimitDefaultDelayMs: 321,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  await assert.rejects(
    () => client.getTrackById("track-rate-limited"),
    (error) => error?.statusCode === 429
  );
  assert.deepEqual(delays, [321]);
});

test("spotify API client skips retry when Retry-After is excessively large", async () => {
  const delays = [];
  const httpsMock = createHttpsMock([
    jsonResponse(200, { access_token: "token-user", expires_in: 3600 }),
    jsonResponse(429, {}, { "retry-after": "72015" }),
  ]);
  const client = createClient({
    httpsModule: httpsMock,
    sleep: async (ms) => {
      delays.push(ms);
    },
    rateLimitRetryAfterCeilingMs: 30000,
  });

  await assert.rejects(
    () => client.getAlbumTracksById("album-rate-limited"),
    (error) => error?.statusCode === 429
  );
  assert.deepEqual(delays, []);
  assert.equal(httpsMock.requests.length, 2);
});
