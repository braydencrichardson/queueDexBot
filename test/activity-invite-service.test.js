const test = require("node:test");
const assert = require("node:assert/strict");
const { InviteTargetType } = require("discord.js");

const { createActivityInviteService } = require("../src/activity/invite-service");

test("activity invite service reuses invite per guild/channel/app and rotates when channel changes", async () => {
  const service = createActivityInviteService();
  const createInviteCalls = [];

  function createVoiceChannel(guildId, channelId, name, inviteCode) {
    return {
      id: channelId,
      name,
      guild: { id: guildId },
      createInvite: async (options) => {
        createInviteCalls.push({
          guildId,
          channelId,
          options,
        });
        return {
          code: inviteCode,
          url: `https://discord.gg/${inviteCode}`,
          expiresTimestamp: Date.now() + 30 * 60 * 1000,
        };
      },
    };
  }

  const voiceChannelOne = createVoiceChannel("guild-1", "voice-1", "General", "abc123");
  const voiceChannelTwo = createVoiceChannel("guild-1", "voice-2", "Hangout", "def456");

  const first = await service.getOrCreateInvite({
    voiceChannel: voiceChannelOne,
    applicationId: "app-1",
    reason: "first",
  });
  const second = await service.getOrCreateInvite({
    voiceChannel: voiceChannelOne,
    applicationId: "app-1",
    reason: "second",
  });
  const third = await service.getOrCreateInvite({
    voiceChannel: voiceChannelTwo,
    applicationId: "app-1",
    reason: "third",
  });

  assert.equal(first.reused, false);
  assert.equal(first.url, "https://discord.gg/abc123");
  assert.equal(second.reused, true);
  assert.equal(second.url, "https://discord.gg/abc123");
  assert.equal(third.reused, false);
  assert.equal(third.url, "https://discord.gg/def456");
  assert.equal(createInviteCalls.length, 2);
  assert.equal(createInviteCalls[0].options.targetType, InviteTargetType.EmbeddedApplication);
  assert.equal(createInviteCalls[0].options.targetApplication, "app-1");
  assert.equal(createInviteCalls[0].options.unique, false);
  assert.equal(createInviteCalls[0].options.maxAge, 7200);
});
