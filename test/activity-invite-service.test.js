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

test("activity invite service clears pending entry after invite failure so retries can succeed", async () => {
  const service = createActivityInviteService();
  let createInviteCalls = 0;
  let shouldFailFirstAttempt = true;

  const voiceChannel = {
    id: "voice-1",
    name: "General",
    guild: { id: "guild-1" },
    createInvite: async () => {
      createInviteCalls += 1;
      if (shouldFailFirstAttempt) {
        shouldFailFirstAttempt = false;
        const error = new Error("Missing Permissions");
        error.code = 50013;
        throw error;
      }
      return {
        code: "retry-ok",
        url: "https://discord.gg/retry-ok",
        expiresTimestamp: Date.now() + 15 * 60 * 1000,
      };
    },
  };

  await assert.rejects(
    service.getOrCreateInvite({
      voiceChannel,
      applicationId: "app-1",
      reason: "first-fails",
    }),
    (error) => error?.code === 50013
  );

  const second = await service.getOrCreateInvite({
    voiceChannel,
    applicationId: "app-1",
    reason: "retry-works",
  });

  assert.equal(createInviteCalls, 2);
  assert.equal(second.reused, false);
  assert.equal(second.url, "https://discord.gg/retry-ok");
});
