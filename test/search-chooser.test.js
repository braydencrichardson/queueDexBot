const test = require("node:test");
const assert = require("node:assert/strict");

const { createSearchChooser } = require("../src/ui/search-chooser");

test("trySendSearchChooser renders chooser when options are provided", async () => {
  const pendingSearches = new Map();
  const chooser = createSearchChooser({
    formatDuration: (seconds) => String(seconds),
    interactionTimeoutMs: 5000,
    pendingSearches,
    logInfo: () => {},
    logError: () => {},
  });

  const message = { id: "msg-1", edit: async () => {} };
  const interaction = {
    guildId: "guild-1",
    editReply: async () => message,
  };
  const options = [
    {
      title: "Result 1",
      url: "https://youtu.be/SqD_8FGk89o",
      duration: 120,
      channel: "Channel 1",
    },
  ];

  const handled = await chooser.trySendSearchChooser(interaction, "https://youtu.be/ok", "user-1", options);

  assert.equal(handled, true);
  assert.equal(pendingSearches.has("msg-1"), true);
  clearTimeout(pendingSearches.get("msg-1").timeout);
});

test("trySendSearchChooser no-ops when no options are provided", async () => {
  const pendingSearches = new Map();
  const chooser = createSearchChooser({
    formatDuration: (seconds) => String(seconds),
    interactionTimeoutMs: 5000,
    pendingSearches,
    logInfo: () => {},
    logError: () => {},
  });

  const interaction = {
    guildId: "guild-1",
    editReply: async () => ({ id: "msg-unused", edit: async () => {} }),
  };

  assert.equal(await chooser.trySendSearchChooser(interaction, "query", "user-1", []), false);
  assert.equal(await chooser.trySendSearchChooser(interaction, "query", "user-1"), false);
  assert.equal(pendingSearches.size, 0);
});
