const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDevLogger } = require("../src/logging/dev-logger");

function createTempLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qdex-dev-logger-"));
}

test("sendDevAlert skips Discord send when messaging is unavailable", async () => {
  const logDir = createTempLogDir();
  let fetchCalls = 0;
  let sendCalls = 0;
  const client = {
    rest: { token: "test-token" },
    user: { id: "bot-1" },
    isReady: () => true,
    channels: {
      async fetch() {
        fetchCalls += 1;
        return {
          async send() {
            sendCalls += 1;
          },
        };
      },
    },
  };

  try {
    const logger = createDevLogger({
      client,
      canSendDiscordMessages: () => false,
      devAlertChannelId: "channel-1",
      pretty: false,
      logDir,
    });

    await logger.sendDevAlert("hello");
    assert.equal(fetchCalls, 0);
    assert.equal(sendCalls, 0);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("sendDevAlert suppresses missing-token send errors", async () => {
  const logDir = createTempLogDir();
  let fetchCalls = 0;
  let sendCalls = 0;
  const client = {
    rest: { token: "test-token" },
    user: { id: "bot-1" },
    isReady: () => true,
    channels: {
      async fetch() {
        fetchCalls += 1;
        return {
          async send() {
            sendCalls += 1;
            throw new Error("Expected token to be set for this request, but none was present");
          },
        };
      },
    },
  };

  const originalConsoleError = console.error;
  let consoleErrorCalls = 0;
  console.error = () => {
    consoleErrorCalls += 1;
  };

  try {
    const logger = createDevLogger({
      client,
      canSendDiscordMessages: () => true,
      devAlertChannelId: "channel-1",
      pretty: false,
      logDir,
    });

    await logger.sendDevAlert("hello");
    assert.equal(fetchCalls, 1);
    assert.equal(sendCalls, 1);
    assert.equal(consoleErrorCalls, 0);
  } finally {
    console.error = originalConsoleError;
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
