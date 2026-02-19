function getQueueVoiceChannelId(queue) {
  const guild = queue?.voiceChannel?.guild;
  const botMember = guild?.members?.me;
  if (botMember) {
    const liveVoiceChannelId = String(botMember.voice?.channelId || botMember.voice?.channel?.id || "").trim();
    if (liveVoiceChannelId) {
      return liveVoiceChannelId;
    }
  }

  const queuedVoiceChannelId = String(queue?.voiceChannel?.id || "").trim();
  if (queuedVoiceChannelId) {
    return queuedVoiceChannelId;
  }

  const connectionVoiceChannelId = String(queue?.connection?.joinConfig?.channelId || "").trim();
  return connectionVoiceChannelId || null;
}

module.exports = {
  getQueueVoiceChannelId,
};
