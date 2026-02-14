const { sanitizeInlineDiscordText } = require("../utils/discord-content");
const { PLAYBACK_LOADING_MESSAGE_DELAY_MS } = require("../config/constants");

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
    : PLAYBACK_LOADING_MESSAGE_DELAY_MS;
  const RESOURCE_DISPOSE_KEY = "__queueDexDispose";

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
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type ?? StreamType.Arbitrary,
      metadata: {
        source: track.source || "unknown",
        pipeline: "play-dl-passthrough",
        inputType: stream.type ?? StreamType.Arbitrary,
      },
    });
    if (typeof stream.stream?.destroy === "function") {
      resource[RESOURCE_DISPOSE_KEY] = () => {
        stream.stream.destroy();
      };
    }
    return resource;
  }

  function getTrackKey(track) {
    if (!track) {
      return null;
    }
    return String(track.id || `${track.url || ""}|${track.title || ""}|${track.requester || ""}`);
  }

  function bumpPreloadGeneration(queue) {
    const current = Number.isFinite(queue?.nextTrackPreloadGeneration) ? queue.nextTrackPreloadGeneration : 0;
    const next = current + 1;
    queue.nextTrackPreloadGeneration = next;
    return next;
  }

  function disposeResource(resource) {
    if (!resource) {
      return;
    }
    const dispose = resource[RESOURCE_DISPOSE_KEY];
    if (typeof dispose === "function") {
      try {
        dispose();
      } catch (error) {
        logError("Failed to dispose preloaded resource", error);
      }
      return;
    }
    if (typeof resource.playStream?.destroy === "function") {
      try {
        resource.playStream.destroy();
      } catch (error) {
        logError("Failed to destroy preloaded resource stream", error);
      }
    }
  }

  function clearPreloadedResource(queue, { dispose = true } = {}) {
    if (dispose && queue?.preloadedNextResource) {
      disposeResource(queue.preloadedNextResource);
    }
    bumpPreloadGeneration(queue);
    queue.preloadedNextTrackKey = null;
    queue.preloadedNextResource = null;
    queue.nextTrackPreloadInFlightKey = null;
    queue.nextTrackPreloadPromise = null;
  }

  async function ensureNextTrackPreload(queue) {
    if (!queue?.current) {
      clearPreloadedResource(queue);
      return null;
    }
    const nextTrack = queue?.tracks?.[0];
    const nextTrackKey = getTrackKey(nextTrack);
    if (!nextTrack?.url || !nextTrackKey) {
      clearPreloadedResource(queue);
      return null;
    }
    if (queue.preloadedNextTrackKey === nextTrackKey && queue.preloadedNextResource) {
      return queue.preloadedNextResource;
    }
    if (queue.nextTrackPreloadInFlightKey === nextTrackKey && queue.nextTrackPreloadPromise) {
      return queue.nextTrackPreloadPromise;
    }
    if (queue.preloadedNextTrackKey && queue.preloadedNextTrackKey !== nextTrackKey && queue.preloadedNextResource) {
      disposeResource(queue.preloadedNextResource);
      queue.preloadedNextTrackKey = null;
      queue.preloadedNextResource = null;
    }

    const generation = bumpPreloadGeneration(queue);
    queue.nextTrackPreloadInFlightKey = nextTrackKey;
    const preloadPromise = createTrackResource(nextTrack)
      .then((resource) => {
        const isStillCurrentPreload = queue.nextTrackPreloadGeneration === generation
          && queue.nextTrackPreloadInFlightKey === nextTrackKey;
        if (!isStillCurrentPreload) {
          return null;
        }
        queue.preloadedNextTrackKey = nextTrackKey;
        queue.preloadedNextResource = resource;
        logInfo("Preloaded next track resource", { title: nextTrack.title, source: nextTrack.source });
        return resource;
      })
      .catch((error) => {
        const isStillCurrentPreload = queue.nextTrackPreloadGeneration === generation
          && queue.nextTrackPreloadInFlightKey === nextTrackKey;
        if (isStillCurrentPreload) {
          queue.preloadedNextTrackKey = null;
          queue.preloadedNextResource = null;
        }
        logInfo("Failed to preload next track resource", {
          title: nextTrack.title,
          source: nextTrack.source,
          error,
        });
        return null;
      })
      .finally(() => {
        const isStillCurrentPreload = queue.nextTrackPreloadGeneration === generation
          && queue.nextTrackPreloadInFlightKey === nextTrackKey;
        if (isStillCurrentPreload) {
          queue.nextTrackPreloadInFlightKey = null;
          queue.nextTrackPreloadPromise = null;
        }
      });
    queue.nextTrackPreloadPromise = preloadPromise;
    return preloadPromise;
  }

  async function resolveResourceForTrack(queue, track) {
    const trackKey = getTrackKey(track);
    if (trackKey && queue.preloadedNextTrackKey === trackKey && queue.preloadedNextResource) {
      const resource = queue.preloadedNextResource;
      clearPreloadedResource(queue, { dispose: false });
      logInfo("Using preloaded track resource", { title: track.title, source: track.source });
      return resource;
    }

    if (trackKey && queue.nextTrackPreloadInFlightKey === trackKey && queue.nextTrackPreloadPromise) {
      logInfo("Waiting for in-flight preload before playback transition", {
        title: track.title,
        source: track.source,
      });
      const inFlightResource = await queue.nextTrackPreloadPromise;
      if (inFlightResource && queue.preloadedNextTrackKey === trackKey && queue.preloadedNextResource) {
        const resource = queue.preloadedNextResource;
        clearPreloadedResource(queue, { dispose: false });
        logInfo("Using preloaded track resource after waiting for in-flight preload", {
          title: track.title,
          source: track.source,
        });
        return resource;
      }
    }
    const resource = await createTrackResource(track);
    clearPreloadedResource(queue);
    return resource;
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
        clearPreloadedResource(queue);
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
        resource = await resolveResourceForTrack(queue, next);
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
      ensureNextTrackPreload(queue).catch((error) => {
        logInfo("Failed to preload next track after playback start", error);
      });
      return;
    }
  }

  return {
    createTrackResource,
    ensureNextTrackPreload,
    playNext,
  };
}

module.exports = {
  createQueuePlayback,
};
