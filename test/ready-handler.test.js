const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { registerReadyHandler } = require("../src/handlers/ready");

test("ready handler reapplies presence on repeated clientReady events and runs onReady once", async () => {
  const client = new EventEmitter();
  const presenceCalls = [];
  let onReadyCalls = 0;
  const infoLogs = [];

  client.user = {
    tag: "qDexBot#0001",
    setPresence(payload) {
      presenceCalls.push(payload);
    },
  };

  registerReadyHandler(client, {
    logInfo: (message) => {
      infoLogs.push(message);
    },
    logError: () => {},
    presence: {
      status: "online",
      activityName: "start with /join",
      activityType: "LISTENING",
    },
    onReady: async () => {
      onReadyCalls += 1;
    },
  });

  client.emit("clientReady");
  client.emit("clientReady");

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(onReadyCalls, 1);
  assert.equal(presenceCalls.length, 2);
  assert.deepEqual(presenceCalls[0], {
    status: "online",
    activities: [{ name: "start with /join", type: "LISTENING" }],
  });
  assert.deepEqual(presenceCalls[1], {
    status: "online",
    activities: [{ name: "start with /join", type: "LISTENING" }],
  });
  assert.equal(infoLogs.filter((entry) => String(entry).includes("Logged in as")).length, 2);
});
