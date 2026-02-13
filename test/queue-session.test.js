const test = require("node:test");
const assert = require("node:assert/strict");

const { createQueueSession } = require("../src/queue/session");

function createSession() {
  return createQueueSession({
    queues: new Map(),
    createAudioPlayer: () => ({
      on: () => {},
      stop: () => {},
    }),
    NoSubscriberBehavior: { Pause: "pause" },
    AudioPlayerStatus: { Idle: "idle", Playing: "playing" },
    formatDuration: () => "",
    buildNowPlayingControls: () => ({}),
    logInfo: () => {},
    logError: () => {},
    getPlayNext: () => async () => {},
  });
}

test("isSameVoiceChannel returns false when member is not in voice channel", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: { id: "vc-1" } };
  const member = { voice: { channel: null } };

  assert.equal(isSameVoiceChannel(member, queue), false);
});

test("isSameVoiceChannel returns true when member and queue voice channel IDs match", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: { id: "vc-1" } };
  const member = { voice: { channel: { id: "vc-1" } } };

  assert.equal(isSameVoiceChannel(member, queue), true);
});

test("isSameVoiceChannel falls back to connection join channel ID", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: null, connection: { joinConfig: { channelId: "vc-1" } } };
  const member = { voice: { channel: { id: "vc-1" } } };

  assert.equal(isSameVoiceChannel(member, queue), true);
});

test("isSameVoiceChannel returns false when queue has no known voice channel", () => {
  const { isSameVoiceChannel } = createSession();
  const queue = { voiceChannel: null, connection: null };
  const member = { voice: { channel: { id: "vc-1" } } };

  assert.equal(isSameVoiceChannel(member, queue), false);
});
