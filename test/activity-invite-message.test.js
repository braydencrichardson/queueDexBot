const test = require("node:test");
const assert = require("node:assert/strict");

const { formatActivityInviteResponse } = require("../src/activity/invite-message");

test("formatActivityInviteResponse includes optional web URL when valid", () => {
  const content = formatActivityInviteResponse({
    inviteUrl: "https://discord.gg/test123",
    reused: true,
    voiceChannelName: "General",
    activityWebUrl: "https://activity.example.com",
  });

  assert.equal(content.includes("Activity: <https://discord.gg/test123>"), true);
  assert.equal(content.includes("Web: <https://activity.example.com/>"), true);
});

test("formatActivityInviteResponse ignores invalid web URL", () => {
  const content = formatActivityInviteResponse({
    inviteUrl: "https://discord.gg/test123",
    reused: false,
    voiceChannelName: "General",
    activityWebUrl: "javascript:alert(1)",
  });

  assert.equal(content.includes("Activity: <https://discord.gg/test123>"), true);
  assert.equal(content.includes("Web:"), false);
});
