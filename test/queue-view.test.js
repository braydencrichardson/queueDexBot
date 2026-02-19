const test = require("node:test");
const assert = require("node:assert/strict");

const { buildQueueViewComponents, formatQueueViewContent } = require("../src/ui/queueView");

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

test("formatQueueViewContent marks loop-generated tracks with loop indicators", () => {
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
        id: "single-loop",
        title: "Now",
        requester: "Requester",
        duration: 90,
        url: "https://youtu.be/current",
        source: "youtube",
        loopTag: "single",
      },
      {
        id: "queue-loop",
        title: "Earlier",
        requester: "Requester",
        duration: 120,
        url: "https://youtu.be/earlier",
        source: "youtube",
        loopTag: "queue",
      },
    ],
  };

  const result = formatQueueViewContent(queue, 1, 10, null, { stale: false, ownerName: "tester" });
  assert.equal(String(result.content).includes("**1.** ↺"), true);
  assert.equal(String(result.content).includes("**2.** ↺"), true);
});

test("buildQueueViewComponents includes open activity shortcut in footer controls", () => {
  const queue = {
    tracks: [
      {
        id: "track-1",
        title: "Song One",
        duration: 120,
      },
    ],
  };
  const view = {
    page: 1,
    pageSize: 10,
    selectedTrackId: null,
  };

  const components = buildQueueViewComponents(view, queue);
  const footerIds = components[4]?.components?.map((button) => button?.data?.custom_id) || [];

  assert.deepEqual(footerIds, ["queue_nowplaying", "queue_activity", "queue_close"]);
});
