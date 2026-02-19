const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createDiscordReconnectWatchdog } = require("../src/bot/discord-reconnect-watchdog");

function createMockClient() {
  const client = new EventEmitter();
  client.user = null;
  client.isReady = () => false;
  return client;
}

test("watchdog forces relogin after shard disconnect exceeds threshold and resets attempts on ready", async () => {
  let fakeNow = 0;
  const reloginCalls = [];
  const client = createMockClient();
  const watchdog = createDiscordReconnectWatchdog({
    client,
    logInfo: () => {},
    logError: () => {},
    relogin: async (context) => {
      reloginCalls.push(context);
    },
    checkIntervalMs: 600000,
    disconnectThresholdMs: 1000,
    backoffBaseMs: 1000,
    backoffMaxMs: 8000,
    now: () => fakeNow,
  });

  watchdog.start();

  client.emit("shardDisconnect", { code: 1006, reason: "abnormal", wasClean: false }, 0);
  await watchdog.runCheck();
  assert.equal(reloginCalls.length, 0);

  fakeNow = 1001;
  await watchdog.runCheck();
  assert.equal(reloginCalls.length, 1);
  assert.equal(reloginCalls[0].attempt, 1);
  assert.deepEqual(reloginCalls[0].shardIds, ["0"]);

  client.emit("clientReady");
  client.emit("shardDisconnect", { code: 1006, reason: "abnormal", wasClean: false }, 0);
  fakeNow = 2005;
  await watchdog.runCheck();
  assert.equal(reloginCalls.length, 2);
  assert.equal(reloginCalls[1].attempt, 1);

  watchdog.stop();
});

test("watchdog applies backoff between failed relogin attempts", async () => {
  let fakeNow = 0;
  let reloginCallCount = 0;
  const attempts = [];
  const client = createMockClient();
  const watchdog = createDiscordReconnectWatchdog({
    client,
    logInfo: () => {},
    logError: () => {},
    relogin: async (context) => {
      attempts.push(context.attempt);
      reloginCallCount += 1;
      throw new Error("handshake timeout");
    },
    checkIntervalMs: 600000,
    disconnectThresholdMs: 1000,
    backoffBaseMs: 1000,
    backoffMaxMs: 4000,
    now: () => fakeNow,
  });

  watchdog.start();

  client.emit("shardDisconnect", { code: 1006, reason: "abnormal", wasClean: false }, 0);
  fakeNow = 1200;
  await watchdog.runCheck();
  assert.equal(reloginCallCount, 1);
  assert.deepEqual(attempts, [1]);

  fakeNow = 1500;
  await watchdog.runCheck();
  assert.equal(reloginCallCount, 1);

  fakeNow = 2200;
  await watchdog.runCheck();
  assert.equal(reloginCallCount, 2);
  assert.deepEqual(attempts, [1, 2]);

  watchdog.stop();
});
