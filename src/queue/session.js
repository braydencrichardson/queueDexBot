const { sanitizeInlineDiscordText } = require("../utils/discord-content");
const { formatTrackPrimary, formatTrackSecondary } = require("../ui/messages");

function createQueueSession(deps) {
  const {
    queues,
    createAudioPlayer,
    NoSubscriberBehavior,
    AudioPlayerStatus,
    formatDuration,
    buildNowPlayingControls,
    logInfo,
    logError,
    getPlayNext,
  } = deps;
  function getGuildQueue(guildId) {
    if (!queues.has(guildId)) {
      queues.set(guildId, {
        textChannel: null,
        voiceChannel: null,
        connection: null,
        player: createAudioPlayer({
          behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
        }),
        tracks: [],
        current: null,
        nowPlayingMessageId: null,
        nowPlayingChannelId: null,
        nowPlayingUpNextKey: null,
        inactivityTimeout: null,
        inactivityNoticeMessageId: null,
        inactivityNoticeChannelId: null,
        pausedForInactivity: false,
        playing: false,
        playerListenersReady: false,
      });
    }
    return queues.get(guildId);
  }

  function formatNowPlaying(queue) {
    if (!queue.current) {
      return "Nothing is playing.";
    }
    const remaining = queue.tracks.length;
    const nextTrack = queue.tracks[0];
    const lines = [];
    const nowPrimary = formatTrackPrimary(queue.current, {
      formatDuration,
      includeRequester: true,
    });
    const nowSecondary = formatTrackSecondary(queue.current, {
      includeArtist: true,
      includeLink: true,
      embeddableLink: true,
    });
    lines.push(`**Now playing:** ${nowPrimary}`);
    if (nowSecondary) {
      lines.push(`↳ ${nowSecondary}`);
    }
    if (nextTrack) {
      const nextPrimary = formatTrackPrimary(nextTrack, {
        formatDuration,
        includeRequester: true,
      });
      const nextSecondary = formatTrackSecondary(nextTrack, {
        includeArtist: true,
        includeLink: true,
        embeddableLink: false,
      });
      lines.push(`**Up next:** ${nextPrimary}`);
      if (nextSecondary) {
        lines.push(`↳ ${nextSecondary}`);
      }
    } else {
      lines.push("**Up next:** (empty)");
    }
    lines.push(`**Remaining:** ${remaining}`);
    return lines.join("\n");
  }

  function getUpNextKey(queue) {
    const next = queue?.tracks?.[0];
    if (!next) {
      return "empty";
    }
    return String(next.id || `${next.url || ""}|${next.title || ""}|${next.requester || ""}`);
  }

  async function sendNowPlaying(queue, forceNew = false) {
    if (!queue.textChannel || !queue.current) {
      return null;
    }

    const content = formatNowPlaying(queue);
    queue.nowPlayingUpNextKey = getUpNextKey(queue);
    let message = null;

    if (!forceNew && queue.nowPlayingMessageId && queue.nowPlayingChannelId === queue.textChannel.id) {
      try {
        message = await queue.textChannel.messages.fetch(queue.nowPlayingMessageId);
        await message.edit(content);
      } catch {
        message = null;
      }
    }

    if (!message) {
      try {
        message = await queue.textChannel.send(content);
      } catch (error) {
        logError("Failed to send now playing message", error);
        return null;
      }
    }

    queue.nowPlayingMessageId = message.id;
    queue.nowPlayingChannelId = message.channel.id;

    const controls = buildNowPlayingControls();

    try {
      await message.edit({ content, components: [controls] });
    } catch (error) {
      logError("Failed to update now playing controls", error);
    }

    return message;
  }

  async function maybeRefreshNowPlayingUpNext(queue) {
    if (!queue?.current || !queue?.nowPlayingMessageId || !queue?.textChannel) {
      return;
    }
    const nextKey = getUpNextKey(queue);
    if (queue.nowPlayingUpNextKey === nextKey) {
      return;
    }
    await sendNowPlaying(queue, false);
  }

  function getDisplayName(member, user) {
    return sanitizeInlineDiscordText(member?.displayName || user?.tag || user?.username || "Unknown user");
  }

  async function announceNowPlayingAction(queue, action, user, member, messageChannel) {
    const displayName = getDisplayName(member, user);
    logInfo(`Now playing reaction: ${action}`, { user: displayName, userId: user?.id });

    const channel = messageChannel || queue?.textChannel;
    if (!channel?.send) {
      return;
    }
    try {
      await channel.send(`**${displayName}** ${action}.`);
    } catch (error) {
      logError("Failed to announce now playing action", error);
    }
  }

  function ensurePlayerListeners(queue, guildId) {
    if (queue.playerListenersReady) {
      return;
    }

    queue.player.on(AudioPlayerStatus.Idle, () => {
      const playNext = getPlayNext();
      playNext(guildId).catch((error) => {
        logError("Error playing next track", error);
      });
    });

    queue.player.on(AudioPlayerStatus.Playing, () => {
      const resourceMetadata = queue.player.state?.resource?.metadata;
      if (resourceMetadata) {
        logInfo("Audio resource playback started", resourceMetadata);
      } else {
        logInfo("Audio resource playback started", { metadata: null });
      }
    });

    queue.player.on("error", (error) => {
      logError("Audio player error", error);
      const playNext = getPlayNext();
      playNext(guildId).catch((playError) => {
        logError("Error recovering from player error", playError);
      });
    });

    queue.playerListenersReady = true;
  }

  function stopAndLeaveQueue(queue, reason) {
    logInfo(reason);
    queue.tracks = [];
    queue.current = null;
    queue.nowPlayingUpNextKey = null;
    queue.playing = false;
    if (queue.inactivityTimeout) {
      clearTimeout(queue.inactivityTimeout);
      queue.inactivityTimeout = null;
    }
    queue.pausedForInactivity = false;
    queue.inactivityNoticeMessageId = null;
    queue.inactivityNoticeChannelId = null;
    if (queue.player) {
      queue.player.stop(true);
    }
    if (queue.connection) {
      queue.connection.destroy();
      queue.connection = null;
    }
    queue.voiceChannel = null;
  }

  function getQueueVoiceChannelId(queue) {
    return queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || null;
  }

  function isSameVoiceChannel(member, queue) {
    const memberChannelId = member?.voice?.channel?.id;
    if (!memberChannelId) {
      return false;
    }
    const queueChannelId = getQueueVoiceChannelId(queue);
    if (!queueChannelId) {
      return false;
    }
    return memberChannelId === queueChannelId;
  }

  return {
    announceNowPlayingAction,
    ensurePlayerListeners,
    getGuildQueue,
    isSameVoiceChannel,
    maybeRefreshNowPlayingUpNext,
    sendNowPlaying,
    stopAndLeaveQueue,
  };
}

module.exports = {
  createQueueSession,
};
