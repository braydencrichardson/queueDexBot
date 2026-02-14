function clearMapEntryWithTimeout(store, key) {
  const existingEntry = store.get(key);
  if (!existingEntry) {
    return null;
  }
  store.delete(key);
  if (existingEntry.timeout) {
    clearTimeout(existingEntry.timeout);
  }
  return existingEntry;
}

function setExpiringMapEntry(options) {
  const {
    store,
    key,
    entry: entryData,
    timeoutMs,
    onExpire,
    logError,
    errorMessage = "Failed to expire pending interaction",
  } = options;

  const existingEntry = store.get(key);
  if (existingEntry?.timeout) {
    clearTimeout(existingEntry.timeout);
  }

  const timeout = setTimeout(async () => {
    try {
      const activeEntry = store.get(key);
      if (!activeEntry) {
        return;
      }
      store.delete(key);
      if (typeof onExpire === "function") {
        await onExpire(activeEntry);
      }
    } catch (error) {
      if (typeof logError === "function") {
        logError(errorMessage, error);
      }
    }
  }, timeoutMs);

  const storedEntry = { ...entryData, timeout };
  store.set(key, storedEntry);
  return storedEntry;
}

function getQueueVoiceChannelId(queue) {
  return queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || null;
}

function getVoiceChannelCheck(member, queue, action = "control playback") {
  if (!member?.voice?.channel) {
    return "Join a voice channel first.";
  }
  const queueVoiceChannelId = getQueueVoiceChannelId(queue);
  if (!queueVoiceChannelId || member.voice.channel.id !== queueVoiceChannelId) {
    return `Join my voice channel to ${action}.`;
  }
  return null;
}

module.exports = {
  clearMapEntryWithTimeout,
  getQueueVoiceChannelId,
  getVoiceChannelCheck,
  setExpiringMapEntry,
};
