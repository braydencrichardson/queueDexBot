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

  async function sendPlaybackNotice(queue, content) {
    if (!queue?.textChannel || !content) {
      return;
    }
    try {
      await queue.textChannel.send(content);
    } catch (error) {
      logError("Failed to send playback notice", error);
    }
  }

  function buildSkipSummaryMessage(stats, { foundPlayableTrack }) {
    const parts = [];
    if (stats.malformedCount > 0) {
      parts.push(`Skipped ${stats.malformedCount} malformed queue entr${stats.malformedCount === 1 ? "y" : "ies"} (missing URL).`);
    }
    if (stats.loadFailureCount > 0) {
      parts.push(`Skipped ${stats.loadFailureCount} track${stats.loadFailureCount === 1 ? "" : "s"} that failed to load.`);
    }
    if (!parts.length) {
      return null;
    }
    if (foundPlayableTrack) {
      parts.push("Playing the next available track.");
    } else {
      parts.push("No playable tracks remain; leaving voice channel.");
    }
    return parts.join(" ");
  }

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
    const skipStats = {
      malformedCount: 0,
      loadFailureCount: 0,
    };

    while (true) {
      const next = queue.tracks.shift();
      if (!next) {
        const summary = buildSkipSummaryMessage(skipStats, { foundPlayableTrack: false });
        if (summary) {
          await sendPlaybackNotice(queue, summary);
        }
        queue.playing = false;
        queue.current = null;
        if (queue.connection) {
          queue.connection.destroy();
          queue.connection = null;
        }
        queue.voiceChannel = null;
        return;
      }

      if (!next.url) {
        skipStats.malformedCount += 1;
        logInfo("Skipping malformed queued track (missing URL)", {
          id: next.id,
          source: next.source,
          requester: next.requester,
        });
        continue;
      }

      queue.playing = true;
      queue.current = next;
      markQueueViewsStale(guildId);

      let loadingTimeout = null;
      let loadingMessage = null;
      if (queue.textChannel) {
        loadingTimeout = setTimeout(async () => {
          try {
            const title = sanitizeInlineDiscordText(next.title || "unknown track");
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
        skipStats.loadFailureCount += 1;
        queue.current = null;
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
        continue;
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

      const summary = buildSkipSummaryMessage(skipStats, { foundPlayableTrack: true });
      if (summary) {
        await sendPlaybackNotice(queue, summary);
      }

      queue.player.play(resource);

      if (queue.connection) {
        queue.connection.subscribe(queue.player);
      }

      await sendNowPlaying(queue, true);
      return;
    }
  }

  return {
    createTrackResource,
    playNext,
  };
}

module.exports = {
  createQueuePlayback,
};
