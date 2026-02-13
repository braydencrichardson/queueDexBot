const { sanitizeInlineDiscordText } = require("../utils/discord-content");
const { DEFAULT_PLAYBACK_LOADING_MESSAGE_DELAY_MS } = require("../config/constants");

function createQueuePlayback(deps) {
  const {
    client,
    playdl,
    createAudioResource,
    StreamType,
    createYoutubeResource,
    getGuildQueue,
    queueViews,
    pendingMoves,
    formatQueueViewContent,
    buildQueueViewComponents,
    buildMoveMenu,
    formatMovePrompt,
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

  function buildQueueEndedMessage() {
    return "Queue finished. Leaving voice channel.";
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
      metadata: {
        source: track.source || "unknown",
        pipeline: "play-dl-passthrough",
        inputType: stream.type ?? StreamType.Arbitrary,
      },
    });
  }

  function markQueueViewsStale(guildId) {
    for (const [messageId, view] of queueViews.entries()) {
      if (view.guildId === guildId) {
        queueViews.set(messageId, { ...view, stale: true });
      }
    }
  }

  async function resolveChannel(channelId) {
    if (!channelId || !client) {
      return null;
    }
    const cached = client.channels?.cache?.get(channelId);
    if (cached) {
      return cached;
    }
    if (!client.channels?.fetch) {
      return null;
    }
    try {
      return await client.channels.fetch(channelId);
    } catch {
      return null;
    }
  }

  async function refreshQueueViews(guildId, queue) {
    if (typeof formatQueueViewContent !== "function" || typeof buildQueueViewComponents !== "function") {
      return;
    }
    for (const [messageId, rawView] of queueViews.entries()) {
      if (rawView.guildId !== guildId) {
        continue;
      }
      const view = { ...rawView };
      if (view.selectedTrackId && !queue.tracks.some((track) => track?.id === view.selectedTrackId)) {
        view.selectedTrackId = null;
      }
      const channel = await resolveChannel(view.channelId);
      if (!channel?.messages?.fetch) {
        queueViews.set(messageId, { ...view, stale: true });
        continue;
      }
      const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, {
        stale: false,
        ownerName: view.ownerName,
      });
      view.page = pageData.page;
      const payload = {
        content: pageData.content,
        components: buildQueueViewComponents(view, queue),
      };
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit(payload);
        queueViews.set(messageId, { ...view, stale: false });
      } catch {
        queueViews.set(messageId, { ...view, stale: true });
      }
    }
  }

  async function refreshPendingMoves(guildId, queue) {
    if (!pendingMoves || typeof buildMoveMenu !== "function" || typeof formatMovePrompt !== "function") {
      return;
    }
    for (const [messageId, pending] of pendingMoves.entries()) {
      if (pending.guildId !== guildId) {
        continue;
      }
      const sourceIndex = pending.trackId ? queue.tracks.findIndex((track) => track?.id === pending.trackId) + 1 : pending.sourceIndex;
      const channel = await resolveChannel(pending.channelId);
      if (!sourceIndex || !queue.tracks[sourceIndex - 1]) {
        clearTimeout(pending.timeout);
        pendingMoves.delete(messageId);
        if (channel?.messages?.fetch) {
          try {
            const message = await channel.messages.fetch(messageId);
            await message.edit({ content: "Selected track no longer exists.", components: [] });
          } catch {
            // ignore cleanup errors
          }
        }
        continue;
      }
      const moveMenu = buildMoveMenu(queue, sourceIndex, pending.page, pending.pageSize);
      pending.page = moveMenu.page;
      pending.sourceIndex = sourceIndex;
      pendingMoves.set(messageId, pending);
      if (!channel?.messages?.fetch) {
        continue;
      }
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({
          content: formatMovePrompt(queue.tracks[sourceIndex - 1], moveMenu.page, moveMenu.totalPages),
          components: moveMenu.components,
        });
      } catch {
        // keep pending interaction state even if message edit fails
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
        } else {
          await sendPlaybackNotice(queue, buildQueueEndedMessage());
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
      await refreshQueueViews(guildId, queue);
      await refreshPendingMoves(guildId, queue);

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
