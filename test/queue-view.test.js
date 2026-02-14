const test = require("node:test");
const assert = require("node:assert/strict");

const { formatQueueViewContent } = require("../src/ui/queueView");

test("formatQueueViewContent marks preloaded up-next track with a dot", () => {
  const queue = {
    current: {
      id: "current",
      title: "Now",
      requester: "Requester",
      duration: 90,
      url: "https://youtu.be/current",
      source: "youtube",
    },
    tracks: [
      {
        id: "next",
        title: "Next",
        requester: "Requester",
        duration: 120,
        url: "https://youtu.be/next",
        source: "youtube",
      },
    ],
    preloadedNextTrackKey: "next",
    preloadedNextResource: { id: "resource-next" },
  };

  const result = formatQueueViewContent(queue, 1, 10, null, { stale: false, ownerName: "tester" });
  assert.equal(String(result.content).includes("**1.** ●"), true);
});
