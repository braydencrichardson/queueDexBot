const { sanitizeDiscordText, sanitizeInlineDiscordText } = require("../utils/discord-content");

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
    const nowDuration = formatDuration(queue.current.duration);
    const nextDuration = formatDuration(nextTrack?.duration);
    const currentTitle = sanitizeInlineDiscordText(queue.current.title);
    const currentRequester = sanitizeInlineDiscordText(queue.current.requester);
    const nextTitle = sanitizeInlineDiscordText(nextTrack?.title);
    const nextRequester = sanitizeInlineDiscordText(nextTrack?.requester);
    const displayUrl = sanitizeDiscordText(queue.current.displayUrl || queue.current.url);
    const nowLink = (queue.current.source === "youtube" || queue.current.source === "soundcloud") && displayUrl
      ? ` (${displayUrl})`
      : "";
    const nowLine = `Now playing: ${currentTitle}${nowDuration ? ` (**${nowDuration}**)` : ""}${currentRequester ? ` (requested by **${currentRequester}**)` : ""}${nowLink}`;
    const nextLine = nextTrack
      ? `Up next: ${nextTitle}${nextDuration ? ` (**${nextDuration}**)` : ""}${nextRequester ? ` (requested by **${nextRequester}**)` : ""}`
      : "Up next: (empty)";
    const countLine = `Remaining: ${remaining}`;
    return `${nowLine}\n${nextLine}\n${countLine}`;
  }

  async function sendNowPlaying(queue, forceNew = false) {
    if (!queue.textChannel || !queue.current) {
      return null;
    }

    const content = formatNowPlaying(queue);
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

  function isSameVoiceChannel(member, queue) {
    if (!queue.voiceChannel) {
      return true;
    }
    return member?.voice?.channel?.id === queue.voiceChannel.id;
  }

  return {
    announceNowPlayingAction,
    ensurePlayerListeners,
    getGuildQueue,
    isSameVoiceChannel,
    sendNowPlaying,
    stopAndLeaveQueue,
  };
}

module.exports = {
  createQueueSession,
};
