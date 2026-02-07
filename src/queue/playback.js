const { sanitizeInlineDiscordText } = require("../utils/discord-content");
const { DEFAULT_PLAYBACK_LOADING_MESSAGE_DELAY_MS } = require("../config/constants");

function createQueuePlayback(deps) {
  const {
    playdl,
    createAudioResource,
    StreamType,
    createYoutubeResource,
    getGuildQueue,
    queueViews,
    sendNowPlaying,
    loadingMessageDelayMs,
    logInfo,
    logError,
  } = deps;
  const loadingDelayMs = Number.isFinite(loadingMessageDelayMs) && loadingMessageDelayMs >= 0
    ? loadingMessageDelayMs
    : DEFAULT_PLAYBACK_LOADING_MESSAGE_DELAY_MS;
  async function createTrackResource(track) {
    if (!track?.url) {
      logInfo("Track missing URL", track);
      throw new Error("Track URL missing");
    }
    if (track.source === "youtube") {
      return createYoutubeResource(track.url);
    }

    const stream = await playdl.stream(track.url);
    return createAudioResource(stream.stream, {
      inputType: stream.type ?? StreamType.Arbitrary,
    });
  }

  function markQueueViewsStale(guildId) {
    for (const [messageId, view] of queueViews.entries()) {
      if (view.guildId === guildId) {
        queueViews.set(messageId, { ...view, stale: true });
      }
    }
  }

  async function playNext(guildId) {
    const queue = getGuildQueue(guildId);
    const next = queue.tracks.shift();

    if (!next) {
      queue.playing = false;
      queue.current = null;
      if (queue.connection) {
        queue.connection.destroy();
        queue.connection = null;
      }
      queue.voiceChannel = null;
      return;
    }

    queue.playing = true;
    queue.current = next;
    markQueueViewsStale(guildId);

    let loadingTimeout = null;
    let loadingMessage = null;
    if (queue.textChannel) {
      loadingTimeout = setTimeout(async () => {
        try {
          const title = sanitizeInlineDiscordText(next.title);
          loadingMessage = await queue.textChannel.send(`Loading **${title}**...`);
        } catch (error) {
          logError("Failed to send loading message", error);
        }
      }, loadingDelayMs);
    }

    let resource;
    try {
      resource = await createTrackResource(next);
    } catch (error) {
      logError("Failed to create audio resource", error);
      if (loadingTimeout) {
        clearTimeout(loadingTimeout);
        loadingTimeout = null;
      }
      if (loadingMessage) {
        try {
          await loadingMessage.delete();
        } catch (deleteError) {
          logError("Failed to delete loading message", deleteError);
        }
      }
      playNext(guildId).catch((playError) => {
        logError("Error skipping failed track", playError);
      });
      return;
    }
    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
    }
    if (loadingMessage) {
      try {
        await loadingMessage.delete();
      } catch (deleteError) {
        logError("Failed to delete loading message", deleteError);
      }
    }

    queue.player.play(resource);

    if (queue.connection) {
      queue.connection.subscribe(queue.player);
    }

    await sendNowPlaying(queue, true);
  }

  return {
    createTrackResource,
    playNext,
  };
}

module.exports = {
  createQueuePlayback,
};
