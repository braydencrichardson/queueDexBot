const { sanitizeInlineDiscordText } = require("../utils/discord-content");
const { formatTrackPrimary, formatTrackSecondary } = require("../ui/messages");
const {
  DEFAULT_NOW_PLAYING_PROGRESS_INTERVAL_MS,
  DEFAULT_NOW_PLAYING_PROGRESS_INITIAL_DELAY_MS,
} = require("../config/constants");

const NOW_PLAYING_PROGRESS_INTERVAL_MS = DEFAULT_NOW_PLAYING_PROGRESS_INTERVAL_MS;
const NOW_PLAYING_PROGRESS_INITIAL_DELAY_MS = DEFAULT_NOW_PLAYING_PROGRESS_INITIAL_DELAY_MS;
const NOW_PLAYING_PROGRESS_BAR_WIDTH = 20;

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
    resolveNowPlayingChannelById = async () => null,
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
        nowPlayingTrackSnapshot: null,
        nowPlayingProgressInterval: null,
        nowPlayingProgressStartTimeout: null,
        nowPlayingProgressTrackKey: null,
        nowPlayingProgressMarker: null,
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

  function getCurrentTrackKey(queue) {
    const track = queue?.current;
    if (!track) {
      return null;
    }
    return String(track.id || `${track.url || ""}|${track.title || ""}|${track.requester || ""}`);
  }

  function getPlaybackElapsedSeconds(queue) {
    const playbackMs = queue?.player?.state?.resource?.playbackDuration;
    if (!Number.isFinite(playbackMs) || playbackMs < 0) {
      return null;
    }
    return Math.floor(playbackMs / 1000);
  }

  function getTrackDurationSeconds(track) {
    if (!Number.isFinite(track?.duration) || track.duration <= 0) {
      return null;
    }
    return Math.floor(track.duration);
  }

  function buildProgressBar(elapsedSec, durationSec) {
    const clampedElapsed = Math.max(0, Math.min(elapsedSec, durationSec));
    const ratio = clampedElapsed / durationSec;
    const filled = Math.max(0, Math.min(NOW_PLAYING_PROGRESS_BAR_WIDTH, Math.round(ratio * NOW_PLAYING_PROGRESS_BAR_WIDTH)));
    return `[${"█".repeat(filled)}${"░".repeat(NOW_PLAYING_PROGRESS_BAR_WIDTH - filled)}]`;
  }

  function formatPlaybackProgress(queue) {
    const durationSec = getTrackDurationSeconds(queue?.current);
    const elapsedFromPlayer = getPlaybackElapsedSeconds(queue);

    if (!durationSec && elapsedFromPlayer === null) {
      return null;
    }

    const statusIcon = getPlaybackStatusIcon(queue);
    const statusPrefix = statusIcon ? `${statusIcon} ` : "";

    if (durationSec) {
      const elapsedSec = Math.max(0, Math.min(elapsedFromPlayer ?? 0, durationSec));
      const bar = buildProgressBar(elapsedSec, durationSec);
      return `**Progress:** ${statusPrefix}${bar} ${formatProgressTimestamp(elapsedSec)} / ${formatDuration(durationSec)}`;
    }

    const elapsedSec = Math.max(0, elapsedFromPlayer ?? 0);
    return `**Progress:** ${statusPrefix}${formatProgressTimestamp(elapsedSec)} / unknown`;
  }

  function clearNowPlayingProgressUpdates(queue) {
    if (queue?.nowPlayingProgressStartTimeout) {
      clearTimeout(queue.nowPlayingProgressStartTimeout);
      queue.nowPlayingProgressStartTimeout = null;
    }
    if (queue?.nowPlayingProgressInterval) {
      clearInterval(queue.nowPlayingProgressInterval);
      queue.nowPlayingProgressInterval = null;
    }
    if (queue) {
      queue.nowPlayingProgressTrackKey = null;
      queue.nowPlayingProgressMarker = null;
    }
  }

  function getPlaybackProgressMarker(queue) {
    const elapsedFromPlayer = getPlaybackElapsedSeconds(queue);
    const durationSec = getTrackDurationSeconds(queue?.current);
    if (!durationSec && elapsedFromPlayer === null) {
      return null;
    }
    if (durationSec) {
      const elapsedSec = Math.max(0, Math.min(elapsedFromPlayer ?? 0, durationSec));
      return `${elapsedSec}/${durationSec}`;
    }
    const elapsedSec = Math.max(0, elapsedFromPlayer ?? 0);
    return `${elapsedSec}/unknown`;
  }

  function formatProgressTimestamp(seconds) {
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
    return formatDuration(safeSeconds) || "0:00";
  }

  function getPlaybackStatusIcon(queue) {
    const status = queue?.player?.state?.status;
    const playingStatus = AudioPlayerStatus?.Playing;
    const pausedStatus = AudioPlayerStatus?.Paused;
    const autoPausedStatus = AudioPlayerStatus?.AutoPaused;

    if (playingStatus !== undefined && status === playingStatus) {
      return "▶️";
    }
    if (
      (pausedStatus !== undefined && status === pausedStatus) ||
      (autoPausedStatus !== undefined && status === autoPausedStatus)
    ) {
      return "⏸️";
    }
    return queue?.current ? "▶️" : "";
  }

  async function refreshNowPlayingProgress(queue, expectedTrackKey) {
    if (!queue?.current || !queue?.textChannel || !queue?.nowPlayingMessageId) {
      clearNowPlayingProgressUpdates(queue);
      return;
    }
    const activeTrackKey = getCurrentTrackKey(queue);
    if (!activeTrackKey || expectedTrackKey !== activeTrackKey) {
      clearNowPlayingProgressUpdates(queue);
      return;
    }
    const marker = getPlaybackProgressMarker(queue);
    if (marker && queue.nowPlayingProgressMarker === marker) {
      return;
    }
    await sendNowPlaying(queue, false);
  }

  function ensureNowPlayingProgressUpdates(queue) {
    if (!queue?.current || !queue?.textChannel || !queue?.nowPlayingMessageId) {
      clearNowPlayingProgressUpdates(queue);
      return;
    }

    const trackKey = getCurrentTrackKey(queue);
    if (!trackKey) {
      clearNowPlayingProgressUpdates(queue);
      return;
    }
    if (queue.nowPlayingProgressInterval && queue.nowPlayingProgressTrackKey === trackKey) {
      return;
    }

    clearNowPlayingProgressUpdates(queue);
    queue.nowPlayingProgressTrackKey = trackKey;
    queue.nowPlayingProgressStartTimeout = setTimeout(() => {
      queue.nowPlayingProgressStartTimeout = null;
      queue.nowPlayingProgressInterval = setInterval(() => {
        refreshNowPlayingProgress(queue, trackKey).catch((error) => {
          logError("Failed to refresh now playing progress", error);
        });
      }, NOW_PLAYING_PROGRESS_INTERVAL_MS);
      if (typeof queue.nowPlayingProgressInterval?.unref === "function") {
        queue.nowPlayingProgressInterval.unref();
      }
    }, NOW_PLAYING_PROGRESS_INITIAL_DELAY_MS);
    if (typeof queue.nowPlayingProgressStartTimeout?.unref === "function") {
      queue.nowPlayingProgressStartTimeout.unref();
    }
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
    const progress = formatPlaybackProgress(queue);
    if (progress) {
      lines.push(progress);
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

  function formatCompletedNowPlaying(track) {
    if (!track) {
      return "**Played:** unknown track";
    }
    const lines = [];
    const primary = formatTrackPrimary(track, {
      formatDuration,
      includeRequester: true,
    });
    const secondary = formatTrackSecondary(track, {
      includeArtist: true,
      includeLink: true,
      embeddableLink: true,
    });
    lines.push(`**Played:** ${primary}`);
    if (secondary) {
      lines.push(`↳ ${secondary}`);
    }
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
    const controls = buildNowPlayingControls();
    const payload = { content, components: [controls] };
    queue.nowPlayingUpNextKey = getUpNextKey(queue);
    let message = null;

    if (!forceNew && queue.nowPlayingMessageId && queue.nowPlayingChannelId === queue.textChannel.id) {
      try {
        message = await queue.textChannel.messages.fetch(queue.nowPlayingMessageId);
        await message.edit(payload);
      } catch {
        message = null;
      }
    }

    if (!message) {
      try {
        message = await queue.textChannel.send(payload);
      } catch (error) {
        logError("Failed to send now playing message", error);
        return null;
      }
    }

    queue.nowPlayingMessageId = message.id;
    queue.nowPlayingChannelId = message.channel.id;
    queue.nowPlayingTrackSnapshot = queue.current ? { ...queue.current } : null;
    queue.nowPlayingProgressMarker = getPlaybackProgressMarker(queue);

    ensureNowPlayingProgressUpdates(queue);

    return message;
  }

  async function cleanupCompletedNowPlaying(cleanupContext) {
    const messageId = cleanupContext?.messageId;
    const channelId = cleanupContext?.channelId;
    const trackSnapshot = cleanupContext?.trackSnapshot || null;
    if (!messageId || !channelId) {
      return;
    }

    let cleanupChannel = null;
    if (cleanupContext?.textChannel?.id === channelId && cleanupContext.textChannel?.messages?.fetch) {
      cleanupChannel = cleanupContext.textChannel;
    } else {
      cleanupChannel = await resolveNowPlayingChannelById(channelId);
    }
    if (!cleanupChannel?.messages?.fetch) {
      return;
    }

    try {
      const message = await cleanupChannel.messages.fetch(messageId);
      await message.edit({
        content: formatCompletedNowPlaying(trackSnapshot),
        components: [],
      });
    } catch (error) {
      logError("Failed to clean up completed now playing message", error);
    }
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
      const cleanupContext = {
        messageId: queue.nowPlayingMessageId,
        channelId: queue.nowPlayingChannelId,
        textChannel: queue.textChannel,
        trackSnapshot: queue.nowPlayingTrackSnapshot || queue.current || null,
      };

      clearNowPlayingProgressUpdates(queue);
      queue.nowPlayingMessageId = null;
      queue.nowPlayingChannelId = null;
      queue.nowPlayingUpNextKey = null;
      queue.nowPlayingTrackSnapshot = null;

      playNext(guildId).catch((error) => {
        logError("Error playing next track", error);
      });
      cleanupCompletedNowPlaying(cleanupContext).catch((error) => {
        logError("Failed to clean up completed now playing message", error);
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
    const cleanupContext = {
      messageId: queue?.nowPlayingMessageId,
      channelId: queue?.nowPlayingChannelId,
      textChannel: queue?.textChannel,
      trackSnapshot: queue?.nowPlayingTrackSnapshot || queue?.current || null,
    };
    if (cleanupContext.messageId && cleanupContext.channelId) {
      cleanupCompletedNowPlaying(cleanupContext).catch((error) => {
        logError("Failed to clean up stopped now playing message", error);
      });
    }

    queue.tracks = [];
    queue.current = null;
    queue.nowPlayingMessageId = null;
    queue.nowPlayingChannelId = null;
    queue.nowPlayingUpNextKey = null;
    queue.nowPlayingTrackSnapshot = null;
    queue.playing = false;
    if (queue.inactivityTimeout) {
      clearTimeout(queue.inactivityTimeout);
      queue.inactivityTimeout = null;
    }
    queue.pausedForInactivity = false;
    queue.inactivityNoticeMessageId = null;
    queue.inactivityNoticeChannelId = null;
    clearNowPlayingProgressUpdates(queue);
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
