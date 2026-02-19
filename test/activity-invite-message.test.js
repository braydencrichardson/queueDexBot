const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appendActivityWebLine,
  formatActivityInviteResponse,
  getActivityInviteFailureMessage,
} = require("../src/activity/invite-message");

test("formatActivityInviteResponse includes optional web URL when valid", () => {
  const content = formatActivityInviteResponse({
    inviteUrl: "https://discord.gg/test123",
    reused: true,
    voiceChannelName: "General",
    activityWebUrl: "https://activity.example.com",
  });

  assert.equal(content.includes("**Activity:** <https://discord.gg/test123>"), true);
  assert.equal(content.includes("Web: <https://activity.example.com/>"), true);
});

test("formatActivityInviteResponse ignores invalid web URL", () => {
  const content = formatActivityInviteResponse({
    inviteUrl: "https://discord.gg/test123",
    reused: false,
    voiceChannelName: "General",
    activityWebUrl: "javascript:alert(1)",
  });

  assert.equal(content.includes("**Activity:** <https://discord.gg/test123>"), true);
  assert.equal(content.includes("Web:"), false);
});

test("appendActivityWebLine adds one normalized web line and avoids duplicates", () => {
  const lines = ["**Activity:** <https://discord.gg/test123>"];
  const first = appendActivityWebLine(lines, "https://activity.example.com");
  const second = appendActivityWebLine(lines, "https://activity.example.com/");

  assert.equal(first, true);
  assert.equal(second, false);
  assert.deepEqual(lines, [
    "**Activity:** <https://discord.gg/test123>",
    "**Activity:** Web: <https://activity.example.com/>",
  ]);
});

test("getActivityInviteFailureMessage maps known Discord API error codes", () => {
  assert.equal(
    getActivityInviteFailureMessage({ code: 50234 }),
    "This app is not Activities-enabled yet (missing EMBEDDED flag). Enable Activities for this application in the Discord Developer Portal, then try again."
  );
  assert.equal(
    getActivityInviteFailureMessage({ code: 50013 }),
    "I couldn't create an Activity invite in this voice channel. Check that I can create invites there."
  );
  assert.equal(
    getActivityInviteFailureMessage({ code: 50001 }),
    "I couldn't create an Activity invite in this voice channel. Check that I can create invites there."
  );
  assert.equal(
    getActivityInviteFailureMessage({ code: 12345 }),
    "Couldn't create an Activity invite right now. Try again in a moment."
  );
});
