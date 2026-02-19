const test = require("node:test");
const assert = require("node:assert/strict");

const { createAdminEventFeed } = require("../src/web/admin-event-feed");

test("admin event feed redacts sensitive payload keys", () => {
  const feed = createAdminEventFeed({ maxEntries: 10 });
  feed.push({
    level: "error",
    message: "OAuth failure",
    data: {
      access_token: "abc123",
      nested: {
        cookie: "SID=secret",
      },
      safe: "ok",
    },
  });

  const events = feed.list({ minLevel: "info", limit: 5 });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.access_token, "[REDACTED]");
  assert.equal(events[0].data.nested.cookie, "[REDACTED]");
  assert.equal(events[0].data.safe, "ok");
});

test("admin event feed applies level filter and limit", () => {
  const feed = createAdminEventFeed({ maxEntries: 10 });
  feed.push({ level: "info", message: "info event" });
  feed.push({ level: "warn", message: "warn event" });
  feed.push({ level: "error", message: "error event" });

  const events = feed.list({ minLevel: "warn", limit: 2 });
  assert.equal(events.length, 2);
  assert.equal(events[0].level, "warn");
  assert.equal(events[1].level, "error");
});
