function registerVoiceStateHandler(client, deps) {
  const { queues, stopAndLeaveQueue } = deps;

  client.on("voiceStateUpdate", (oldState, newState) => {
    const guildId = newState.guild?.id || oldState.guild?.id;
    if (!guildId) {
      return;
    }
    const queue = queues.get(guildId);
    if (!queue?.voiceChannel) {
      return;
    }
    const channel = newState.guild.channels.cache.get(queue.voiceChannel.id) || queue.voiceChannel;
    if (!channel?.members) {
      return;
    }
    const listeners = channel.members.filter((member) => !member.user.bot);
    if (listeners.size === 0) {
      stopAndLeaveQueue(queue, "Voice channel empty. Stopping playback and leaving.");
    }
  });
}

module.exports = {
  registerVoiceStateHandler,
};
