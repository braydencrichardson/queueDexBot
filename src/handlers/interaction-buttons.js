const {
  QUEUE_MOVE_MENU_PAGE_SIZE: CONFIG_QUEUE_MOVE_MENU_PAGE_SIZE,
  QUEUE_VIEW_PAGE_SIZE: CONFIG_QUEUE_VIEW_PAGE_SIZE,
} = require("../config/constants");
const { createQueueViewService } = require("./queue-view-service");
const {
  clearMapEntryWithTimeout,
  getVoiceChannelCheck,
  setExpiringMapEntry,
} = require("./interaction-helpers");
const {
  formatMovePrompt,
  formatQueueClearedNotice,
  formatQueueRemovedNotice,
  formatMovedMessage,
  formatQueuedMessage,
  formatRemovedMessage,
} = require("../ui/messages");
const { formatDuration } = require("../queue/utils");
const {
  moveQueuedTrackToFront,
  moveQueuedTrackToPosition,
  removeQueuedTrackAt,
  shuffleQueuedTracks,
} = require("../queue/operations");

function createButtonInteractionHandler(deps) {
  const {
    AudioPlayerStatus,
    INTERACTION_TIMEOUT_MS,
    QUEUE_VIEW_PAGE_SIZE,
    QUEUE_VIEW_TIMEOUT_MS,
    QUEUE_MOVE_MENU_PAGE_SIZE,
    getGuildQueue,
    isSameVoiceChannel,
    announceNowPlayingAction,
    buildNowPlayingControls,
    buildQueuedActionComponents,
    formatQueueViewContent,
    buildQueueViewComponents,
    buildMoveMenu,
    getQueuedTrackIndex,
    getTrackIndexById,
    ensureTrackId,
    pendingSearches,
    pendingMoves,
    pendingQueuedActions,
    queueViews,
    logInfo,
    logError,
    playNext,
    sendNowPlaying,
    maybeRefreshNowPlayingUpNext = async () => {},
    stopAndLeaveQueue,
  } = deps;
  const queueViewPageSize = Number.isFinite(QUEUE_VIEW_PAGE_SIZE) ? QUEUE_VIEW_PAGE_SIZE : CONFIG_QUEUE_VIEW_PAGE_SIZE;
  const queueMoveMenuPageSize = Number.isFinite(QUEUE_MOVE_MENU_PAGE_SIZE)
    ? QUEUE_MOVE_MENU_PAGE_SIZE
    : CONFIG_QUEUE_MOVE_MENU_PAGE_SIZE;
  const queueViewService = createQueueViewService({
    queueViews,
    formatQueueViewContent,
    buildQueueViewComponents,
    queueViewTimeoutMs: QUEUE_VIEW_TIMEOUT_MS,
    logError,
  });
  async function sendQueueActionNotice(channel, content) {
    if (!channel?.send || !content) {
      return;
    }
    try {
      await channel.send(content);
    } catch (error) {
      logError("Failed to send queue action notice", error);
    }
  }
  function getActorName(interaction, member) {
    return member?.displayName || interaction.user?.username || interaction.user?.tag || "Someone";
  }

  return async function handleButtonInteraction(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Buttons can only be used in a server.", ephemeral: true });
      return;
    }

    const queue = getGuildQueue(interaction.guildId);
    const member = interaction.guild?.members?.resolve(interaction.user.id);
    const customId = interaction.customId || "";

    if (customId.startsWith("playlist_view_queue")) {
      const ownerId = customId.split(":")[1];
      if (ownerId && ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Only the requester can use this queue shortcut.", ephemeral: true });
        return;
      }
      if (!queue.current && !queue.tracks.length) {
        await interaction.reply({ content: "Queue is empty.", ephemeral: true });
        return;
      }
      const pageSize = queueViewPageSize;
      const view = queueViewService.createFromInteraction(interaction, {
        page: 1,
        pageSize,
        selectedTrackId: null,
        stale: false,
      });
      await queueViewService.sendToChannel(interaction.channel, queue, view);
      await interaction.deferUpdate();
      return;
    }

    if (customId === "search_close" || customId === "search_queue_first") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can use this search.", ephemeral: true });
        return;
      }
      if (customId === "search_queue_first") {
        const selected = pending.options?.[0];
        if (!selected) {
          clearMapEntryWithTimeout(pendingSearches, interaction.message.id);
          await interaction.update({ content: "Search had no selectable results.", components: [] });
          return;
        }
        if (!isSameVoiceChannel(member, queue)) {
          await interaction.reply({ content: "Join my voice channel to choose a result.", ephemeral: true });
          return;
        }
        clearMapEntryWithTimeout(pendingSearches, interaction.message.id);
        queue.textChannel = interaction.channel;
        ensureTrackId(selected);
        queue.tracks.push(selected);
        await maybeRefreshNowPlayingUpNext(queue);
        logInfo("Queued first result from search chooser", {
          title: selected.title,
          guildId: interaction.guildId,
          requesterId: pending.requesterId,
        });

        const queuedIndex = getQueuedTrackIndex(queue, selected);
        const position = queuedIndex >= 0 ? queuedIndex + 1 : null;
        const showQueuedControls = queuedIndex >= 0;
        await interaction.update({
          content: formatQueuedMessage(selected, position, formatDuration),
          components: showQueuedControls ? buildQueuedActionComponents({ includeMoveControls: queuedIndex >= 1 }) : [],
        });

        if (showQueuedControls) {
          setExpiringMapEntry({
            store: pendingQueuedActions,
            key: interaction.message.id,
            timeoutMs: INTERACTION_TIMEOUT_MS,
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

        if (!queue.playing) {
          playNext(interaction.guildId).catch((error) => {
            logError("Error starting playback", error);
          });
        }
        return;
      }
      clearMapEntryWithTimeout(pendingSearches, interaction.message.id);
      await interaction.update({ content: "Search closed.", components: [] });
      return;
    }

    if (customId.startsWith("np_")) {
      if (!queue.nowPlayingMessageId || interaction.message.id !== queue.nowPlayingMessageId) {
        await interaction.reply({
          content: "That now playing message is no longer active. Use /playing to post a new one.",
          ephemeral: true,
        });
        return;
      }
      if (!isSameVoiceChannel(member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
        return;
      }

      if (customId === "np_toggle") {
        if (queue.player.state.status === AudioPlayerStatus.Playing) {
          queue.player.pause();
          await announceNowPlayingAction(queue, "paused playback", interaction.user, member, interaction.message.channel);
        } else {
          queue.player.unpause();
          await announceNowPlayingAction(queue, "resumed playback", interaction.user, member, interaction.message.channel);
        }
        await sendNowPlaying(queue, false);
      } else if (customId === "np_queue") {
        if (!queue.current && !queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const pageSize = queueViewPageSize;
        const view = queueViewService.createFromInteraction(interaction, {
          page: 1,
          pageSize,
          selectedTrackId: null,
          stale: false,
        });
        await queueViewService.sendToChannel(interaction.channel, queue, view);
      } else if (customId === "np_skip") {
        await announceNowPlayingAction(queue, "skipped the track", interaction.user, member, interaction.message.channel);
        queue.player.stop(true);
      } else if (customId === "np_stop") {
        await announceNowPlayingAction(queue, "stopped playback and cleared the queue", interaction.user, member, interaction.message.channel);
        stopAndLeaveQueue(queue, "Stopping playback and clearing queue");
      }

      try {
        if (customId === "np_stop") {
          await interaction.message.edit({ components: [] });
        } else {
          const controls = buildNowPlayingControls();
          await interaction.message.edit({ components: [controls] });
        }
      } catch (error) {
        logError("Failed to refresh now playing controls", error);
      }

      await interaction.deferUpdate();
      return;
    }

    if (customId.startsWith("queued_")) {
      const pending = pendingQueuedActions.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That queued action has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can use these controls.", ephemeral: true });
        return;
      }
      const trackIndex = getTrackIndexById(queue, pending.trackId);
      if (trackIndex < 0) {
        await interaction.reply({ content: "That track is no longer in the queue.", ephemeral: true });
        return;
      }

      if (customId === "queued_view") {
        const pageSize = queueViewPageSize;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const selectedTrack = queue.tracks[trackIndex];
        ensureTrackId(selectedTrack);
        const view = queueViewService.createFromInteraction(interaction, {
          page,
          pageSize,
          selectedTrackId: selectedTrack.id,
          stale: false,
        });
        await queueViewService.sendToChannel(interaction.channel, queue, view);
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_move") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const selectedIndex = trackIndex + 1;
        const pageSize = queueMoveMenuPageSize;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const moveMenu = buildMoveMenu(queue, selectedIndex, page, pageSize);
        const moveMessage = await interaction.channel.send({
          content: formatMovePrompt({ title: pending.trackTitle || "selected track" }, moveMenu.page, moveMenu.totalPages),
          components: moveMenu.components,
        });
        setExpiringMapEntry({
          store: pendingMoves,
          key: moveMessage.id,
          timeoutMs: INTERACTION_TIMEOUT_MS,
          logError,
          errorMessage: "Failed to expire move request",
          onExpire: async () => {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          },
          entry: {
            guildId: interaction.guildId,
            ownerId: interaction.user.id,
            sourceIndex: selectedIndex,
            trackId: pending.trackId,
            queueViewMessageId: null,
            channelId: interaction.channel?.id,
            page: moveMenu.page,
            pageSize,
          },
        });
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_first") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const moved = moveQueuedTrackToFront(queue, trackIndex + 1);
        await maybeRefreshNowPlayingUpNext(queue);
        logInfo("Moved track to front via queued controls", { title: moved?.title, user: interaction.user.tag });
        await interaction.update({
          content: formatMovedMessage(moved, 1),
          components: [],
        });
        clearMapEntryWithTimeout(pendingQueuedActions, interaction.message.id);
        return;
      }

      if (customId === "queued_remove") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const removed = removeQueuedTrackAt(queue, trackIndex + 1);
        await maybeRefreshNowPlayingUpNext(queue);
        logInfo("Removed track via queued controls", { title: removed?.title, user: interaction.user.tag });
        await sendQueueActionNotice(
          interaction.channel,
          formatQueueRemovedNotice(removed, getActorName(interaction, member))
        );
        await interaction.update({
          content: formatRemovedMessage(removed),
          components: [],
        });
        clearMapEntryWithTimeout(pendingQueuedActions, interaction.message.id);
        return;
      }
    }

    if (customId.startsWith("move_")) {
      const pending = pendingMoves.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That move request has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can control this move request.", ephemeral: true });
        return;
      }
      if (customId === "move_close") {
        clearMapEntryWithTimeout(pendingMoves, interaction.message.id);
        await interaction.update({ content: "Move closed.", components: [] });
        return;
      }
      if (customId === "move_prev") {
        pending.page = Math.max(1, pending.page - 1);
      } else if (customId === "move_next") {
        pending.page += 1;
      } else if (customId === "move_first") {
        const guildQueue = getGuildQueue(interaction.guildId);
        const voiceChannelCheck = getVoiceChannelCheck(member, guildQueue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const currentIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
        if (!currentIndex || !guildQueue.tracks[currentIndex - 1]) {
          await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
          return;
        }
        const moved = moveQueuedTrackToFront(guildQueue, currentIndex);
        await maybeRefreshNowPlayingUpNext(guildQueue);
        clearMapEntryWithTimeout(pendingMoves, interaction.message.id);
        await interaction.update({ content: formatMovedMessage(moved, 1), components: [] });

        const queueView = queueViews.get(pending.queueViewMessageId);
        if (queueView) {
          ensureTrackId(moved);
          queueView.selectedTrackId = moved.id;
          queueView.page = 1;
          queueView.stale = false;
          await queueViewService.editMessage(interaction.channel, pending.queueViewMessageId, guildQueue, queueView, {
            logError,
            errorMessage: "Failed to update queue view after move to first",
          });
        }
        return;
      }
      const guildQueue = getGuildQueue(interaction.guildId);
      const currentIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
      if (!currentIndex || !guildQueue.tracks[currentIndex - 1]) {
        clearMapEntryWithTimeout(pendingMoves, interaction.message.id);
        await interaction.update({ content: "Selected track no longer exists.", components: [] });
        return;
      }
      pending.sourceIndex = currentIndex;
      const updatedIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
      pending.sourceIndex = updatedIndex || pending.sourceIndex;
      const moveMenu = buildMoveMenu(guildQueue, pending.sourceIndex, pending.page, pending.pageSize);
      pending.page = moveMenu.page;
      pendingMoves.set(interaction.message.id, pending);
      const track = guildQueue.tracks[pending.sourceIndex - 1];
      const title = track?.title || "selected track";
      await interaction.update({
        content: formatMovePrompt({ title }, moveMenu.page, moveMenu.totalPages),
        components: moveMenu.components,
      });
      return;
    }

    if (customId.startsWith("queue_")) {
      const queueView = queueViews.get(interaction.message.id);
      if (!queueView) {
        await interaction.reply({ content: "That queue view has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== queueView.ownerId) {
        await interaction.reply({ content: "Only the requester can control this queue view.", ephemeral: true });
        return;
      }

      if (customId === "queue_close") {
        await interaction.deferUpdate();
        await queueViewService.closeByMessageId(interaction.message.id, interaction, "Queue view closed.");
        return;
      }

      if (customId === "queue_prev") {
        queueView.page = Math.max(1, queueView.page - 1);
      } else if (customId === "queue_next") {
        queueView.page += 1;
      } else if (customId === "queue_select_prev" || customId === "queue_select_next" || customId === "queue_select_last") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId)
          : -1;
        let nextIndex;
        if (customId === "queue_select_last") {
          nextIndex = queue.tracks.length - 1;
        } else if (selectedIndex < 0) {
          nextIndex = customId === "queue_select_prev" ? queue.tracks.length - 1 : 0;
        } else if (customId === "queue_select_prev") {
          nextIndex = (selectedIndex - 1 + queue.tracks.length) % queue.tracks.length;
        } else {
          nextIndex = (selectedIndex + 1) % queue.tracks.length;
        }
        const nextTrack = queue.tracks[nextIndex];
        ensureTrackId(nextTrack);
        queueView.selectedTrackId = nextTrack.id;
        queueView.page = Math.floor(nextIndex / queueView.pageSize) + 1;
      } else if (customId === "queue_refresh") {
        // no-op; just re-render below
      } else if (customId === "queue_nowplaying") {
        queue.textChannel = interaction.channel;
        await sendNowPlaying(queue, true);
        await interaction.deferUpdate();
        await queueViewService.closeByMessageId(
          interaction.message.id,
          interaction,
          "Queue view closed (now playing opened)."
        );
        return;
      } else if (customId === "queue_shuffle") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        shuffleQueuedTracks(queue);
        await maybeRefreshNowPlayingUpNext(queue);
        queueView.selectedTrackId = null;
      } else if (customId === "queue_clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const removedCount = queue.tracks.length;
        queue.tracks = [];
        await maybeRefreshNowPlayingUpNext(queue);
        queueView.selectedTrackId = null;
        logInfo("Cleared queue via queue view", { user: interaction.user.tag });
        await sendQueueActionNotice(
          interaction.channel,
          formatQueueClearedNotice(removedCount, getActorName(interaction, member))
        );
      } else if (customId === "queue_move") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const selectedTrack = queue.tracks[selectedIndex - 1];
        ensureTrackId(selectedTrack);
        const movePageSize = queueMoveMenuPageSize;
        const movePage = Math.floor((selectedIndex - 1) / movePageSize) + 1;
        const moveMenu = buildMoveMenu(queue, selectedIndex, movePage, movePageSize);
        const moveMessage = await interaction.channel.send({
          content: formatMovePrompt(queue.tracks[selectedIndex - 1], moveMenu.page, moveMenu.totalPages),
          components: moveMenu.components,
        });
        setExpiringMapEntry({
          store: pendingMoves,
          key: moveMessage.id,
          timeoutMs: INTERACTION_TIMEOUT_MS,
          logError,
          errorMessage: "Failed to expire move request",
          onExpire: async () => {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          },
          entry: {
            guildId: interaction.guildId,
            ownerId: queueView.ownerId,
            sourceIndex: selectedIndex,
            trackId: selectedTrack.id,
            queueViewMessageId: interaction.message.id,
            channelId: interaction.channel?.id,
            page: moveMenu.page,
            pageSize: movePageSize,
          },
        });
      } else if (customId === "queue_backward" || customId === "queue_forward") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const step = customId === "queue_backward" ? -1 : 1;
        const targetIndex = selectedIndex + step;
        if (targetIndex < 1 || targetIndex > queue.tracks.length) {
          await interaction.reply({ content: "Track is already at the edge.", ephemeral: true });
          return;
        }
        const moved = moveQueuedTrackToPosition(queue, selectedIndex, targetIndex);
        await maybeRefreshNowPlayingUpNext(queue);
        ensureTrackId(moved);
        queueView.selectedTrackId = moved.id || queueView.selectedTrackId;
        queueView.page = Math.floor((targetIndex - 1) / queueView.pageSize) + 1;
      } else if (customId === "queue_remove") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to remove.", ephemeral: true });
          return;
        }
        const removed = removeQueuedTrackAt(queue, selectedIndex);
        await maybeRefreshNowPlayingUpNext(queue);
        logInfo("Removed track via queue view", { title: removed?.title, user: interaction.user.tag });
        await sendQueueActionNotice(
          interaction.channel,
          formatQueueRemovedNotice(removed, getActorName(interaction, member))
        );
        queueView.selectedTrackId = null;
      } else if (customId === "queue_front") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const moved = moveQueuedTrackToFront(queue, selectedIndex);
        await maybeRefreshNowPlayingUpNext(queue);
        logInfo("Moved track to front via queue view", { title: moved?.title, user: interaction.user.tag });
        queueView.selectedTrackId = moved.id || queueView.selectedTrackId;
        queueView.page = 1;
      }

      queueView.stale = false;
      await queueViewService.updateInteraction(interaction, queue, queueView);
    }
  };
}

module.exports = {
  createButtonInteractionHandler,
};
