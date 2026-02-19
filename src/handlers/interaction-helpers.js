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
  const guild = queue?.voiceChannel?.guild;
  const botMember = guild?.members?.me;
  if (botMember) {
    const liveVoiceChannelId = String(botMember.voice?.channelId || botMember.voice?.channel?.id || "").trim();
    return liveVoiceChannelId || null;
  }

  const queuedVoiceChannelId = String(queue?.voiceChannel?.id || "").trim();
  if (queuedVoiceChannelId) {
    return queuedVoiceChannelId;
  }

  const connectionVoiceChannelId = String(queue?.connection?.joinConfig?.channelId || "").trim();
  return connectionVoiceChannelId || null;
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

async function queueSearchSelection(options) {
  const {
    interaction,
    queue,
    pendingSearches,
    pendingQueuedActions,
    selected,
    requesterId,
    interactionTimeoutMs,
    ensureTrackId,
    getQueuedTrackIndex,
    buildQueuedActionComponents,
    maybeRefreshNowPlayingUpNext = async () => {},
    playNext,
    logInfo,
    logError,
    queueLogMessage = "Queued from search chooser",
    queuedNoticeFormatter = () => "Queued.",
  } = options;

  clearMapEntryWithTimeout(pendingSearches, interaction.message.id);

  queue.textChannel = interaction.channel;
  ensureTrackId(selected);
  queue.tracks.push(selected);
  await maybeRefreshNowPlayingUpNext(queue);
  if (typeof logInfo === "function") {
    logInfo(queueLogMessage, {
      title: selected.title,
      guildId: interaction.guildId,
      requesterId,
    });
  }

  const queuedIndex = getQueuedTrackIndex(queue, selected);
  const position = queuedIndex >= 0 ? queuedIndex + 1 : null;
  const showQueuedControls = queuedIndex >= 0;
  await interaction.update({
    content: queuedNoticeFormatter(selected, position),
    components: showQueuedControls ? buildQueuedActionComponents({ includeMoveControls: queuedIndex >= 1 }) : [],
  });

  if (showQueuedControls) {
    setExpiringMapEntry({
      store: pendingQueuedActions,
      key: interaction.message.id,
      timeoutMs: interactionTimeoutMs,
      logError,
      errorMessage: "Failed to expire queued action controls",
      onExpire: async () => {
        await interaction.message.edit({ components: [] });
      },
      entry: {
        guildId: interaction.guildId,
        ownerId: interaction.user.id,
        trackId: selected.id,
        trackTitle: selected.title,
      },
    });
  }

  if (!queue.playing && typeof playNext === "function") {
    playNext(interaction.guildId).catch((error) => {
      if (typeof logError === "function") {
        logError("Error starting playback", error);
      }
    });
  }
}

module.exports = {
  clearMapEntryWithTimeout,
  getQueueVoiceChannelId,
  getVoiceChannelCheck,
  queueSearchSelection,
  setExpiringMapEntry,
};
