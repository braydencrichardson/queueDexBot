const test = require("node:test");
const assert = require("node:assert/strict");

const { createSelectMenuInteractionHandler } = require("../src/handlers/interaction-select-menus");

test("queue_move_select moves track to exact requested destination when moving downward", async () => {
  const queue = {
    tracks: [
      { id: "t1", title: "A" },
      { id: "t2", title: "B" },
      { id: "t3", title: "C" },
      { id: "t4", title: "D" },
      { id: "t5", title: "E" },
    ],
  };
  const pendingMoves = new Map();
  pendingMoves.set("move-msg-1", {
    ownerId: "user-1",
    sourceIndex: 2,
    trackId: "t2",
    queueViewMessageId: null,
    timeout: setTimeout(() => {}, 1000),
  });

  let updateContent = null;
  const handler = createSelectMenuInteractionHandler({
    INTERACTION_TIMEOUT_MS: 45000,
    getGuildQueue: () => queue,
    isSameVoiceChannel: () => true,
    buildQueueViewComponents: () => [],
    buildQueuedActionComponents: () => [],
    formatQueueViewContent: () => ({ content: "", page: 1 }),
    getTrackIndexById: (guildQueue, id) => guildQueue.tracks.findIndex((track) => track.id === id),
    ensureTrackId: () => {},
    getQueuedTrackIndex: () => -1,
    pendingSearches: new Map(),
    pendingMoves,
    pendingQueuedActions: new Map(),
    queueViews: new Map(),
    logInfo: () => {},
    logError: () => {},
    playNext: async () => {},
  });

  await handler({
    guildId: "guild-1",
    customId: "queue_move_select",
    values: ["5"],
    user: { id: "user-1" },
    message: { id: "move-msg-1" },
    update: async ({ content }) => {
      updateContent = content;
    },
    reply: async () => {},
    channel: {
      messages: {
        fetch: async () => ({ edit: async () => {} }),
      },
    },
  });

  clearTimeout(pendingMoves.get("move-msg-1")?.timeout);
  assert.deepEqual(queue.tracks.map((track) => track.id), ["t1", "t3", "t4", "t5", "t2"]);
  assert.equal(updateContent, "**Moved:** B -> position 5.");
});
