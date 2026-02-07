function createButtonInteractionHandler(deps) {
  const {
    AudioPlayerStatus,
    INTERACTION_TIMEOUT_MS,
    getGuildQueue,
    isSameVoiceChannel,
    announceNowPlayingAction,
    buildNowPlayingControls,
    formatQueueViewContent,
    buildQueueViewComponents,
    buildMoveMenu,
    getTrackIndexById,
    ensureTrackId,
    pendingSearches,
    pendingMoves,
    pendingQueuedActions,
    queueViews,
    logInfo,
    logError,
    sendNowPlaying,
  } = deps;

  return async function handleButtonInteraction(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Buttons can only be used in a server.", ephemeral: true });
      return;
    }

    const queue = getGuildQueue(interaction.guildId);
    const member = interaction.guild?.members?.resolve(interaction.user.id);
    const customId = interaction.customId || "";

    if (customId === "search_close") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can close this search.", ephemeral: true });
        return;
      }
      pendingSearches.delete(interaction.message.id);
      clearTimeout(pending.timeout);
      await interaction.update({ content: "Search closed.", components: [] });
      return;
    }

    if (customId.startsWith("np_")) {
      if (!queue.nowPlayingMessageId || interaction.message.id !== queue.nowPlayingMessageId) {
        await interaction.reply({ content: "That now playing message is no longer active.", ephemeral: true });
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
      } else if (customId === "np_queue") {
        if (!queue.current && !queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const pageSize = 10;
        const view = {
          guildId: interaction.guildId,
          page: 1,
          pageSize,
          ownerId: interaction.user.id,
          selectedTrackId: null,
          stale: false,
        };
        const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, { stale: view.stale });
        const message = await interaction.channel.send({
          content: pageData.content,
          components: buildQueueViewComponents(view, queue),
        });
        queueViews.set(message.id, {
          ...view,
          page: pageData.page,
        });
      } else if (customId === "np_skip") {
        await announceNowPlayingAction(queue, "skipped the track", interaction.user, member, interaction.message.channel);
        queue.player.stop(true);
      } else if (customId === "np_stop") {
        await announceNowPlayingAction(queue, "stopped playback and cleared the queue", interaction.user, member, interaction.message.channel);
        queue.tracks = [];
        queue.current = null;
        queue.playing = false;
        if (queue.player) {
          queue.player.stop(true);
        }
        if (queue.connection) {
          queue.connection.destroy();
          queue.connection = null;
        }
      }

      try {
        const controls = buildNowPlayingControls();
        await interaction.message.edit({ components: [controls] });
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
        const pageSize = 10;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const selectedTrack = queue.tracks[trackIndex];
        ensureTrackId(selectedTrack);
        const view = {
          guildId: interaction.guildId,
          page,
          pageSize,
          ownerId: interaction.user.id,
          selectedTrackId: selectedTrack.id,
          stale: false,
        };
        const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, { stale: view.stale });
        const message = await interaction.channel.send({
          content: pageData.content,
          components: buildQueueViewComponents(view, queue),
        });
        queueViews.set(message.id, {
          ...view,
          page: pageData.page,
        });
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_move") {
        const selectedIndex = trackIndex + 1;
        const pageSize = 10;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const moveMenu = buildMoveMenu(queue, selectedIndex, page, pageSize);
        const moveMessage = await interaction.channel.send({
          content: `Move **${pending.trackTitle || "selected track"}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
          components: moveMenu.components,
        });
        const timeout = setTimeout(async () => {
          const entry = pendingMoves.get(moveMessage.id);
          if (!entry) {
            return;
          }
          pendingMoves.delete(moveMessage.id);
          try {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          } catch (error) {
            logError("Failed to expire move request", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingMoves.set(moveMessage.id, {
          guildId: interaction.guildId,
          ownerId: interaction.user.id,
          sourceIndex: selectedIndex,
          trackId: pending.trackId,
          queueViewMessageId: null,
          page: moveMenu.page,
          pageSize,
          timeout,
        });
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_first") {
        const [moved] = queue.tracks.splice(trackIndex, 1);
        queue.tracks.unshift(moved);
        logInfo("Moved track to front via queued controls", { title: moved?.title, user: interaction.user.tag });
        await interaction.update({
          content: `Moved **${moved.title}** to position 1.`,
          components: [],
        });
        pendingQueuedActions.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        return;
      }

      if (customId === "queued_remove") {
        const [removed] = queue.tracks.splice(trackIndex, 1);
        logInfo("Removed track via queued controls", { title: removed?.title, user: interaction.user.tag });
        await interaction.update({
          content: `Removed **${removed.title}** from the queue.`,
          components: [],
        });
        pendingQueuedActions.delete(interaction.message.id);
        clearTimeout(pending.timeout);
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
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: "Move closed.", components: [] });
        return;
      }
      if (customId === "move_prev") {
        pending.page = Math.max(1, pending.page - 1);
      } else if (customId === "move_next") {
        pending.page += 1;
      } else if (customId === "move_first") {
        const guildQueue = getGuildQueue(interaction.guildId);
        const currentIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
        if (!currentIndex || !guildQueue.tracks[currentIndex - 1]) {
          await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
          return;
        }
        const [moved] = guildQueue.tracks.splice(currentIndex - 1, 1);
        guildQueue.tracks.unshift(moved);
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: `Moved **${moved.title}** to position 1.`, components: [] });

        const queueView = queueViews.get(pending.queueViewMessageId);
        if (queueView) {
          ensureTrackId(moved);
          queueView.selectedTrackId = moved.id;
          queueView.page = 1;
          queueView.stale = false;
          const pageData = formatQueueViewContent(guildQueue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
          queueViews.set(pending.queueViewMessageId, queueView);
          try {
            const viewMessage = await interaction.channel.messages.fetch(pending.queueViewMessageId);
            await viewMessage.edit({
              content: pageData.content,
              components: buildQueueViewComponents(queueView, guildQueue),
            });
          } catch (error) {
            logError("Failed to update queue view after move to first", error);
          }
        }
        return;
      }
      const guildQueue = getGuildQueue(interaction.guildId);
      const currentIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
      if (!currentIndex || !guildQueue.tracks[currentIndex - 1]) {
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: "Selected track no longer exists.", components: [] });
        return;
      }
      pending.sourceIndex = currentIndex;
      const moveMenu = buildMoveMenu(guildQueue, currentIndex, pending.page, pending.pageSize);
      pending.page = moveMenu.page;
      pendingMoves.set(interaction.message.id, pending);
      const track = guildQueue.tracks[pending.sourceIndex - 1];
      const title = track?.title || "selected track";
      await interaction.update({
        content: `Move **${title}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
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
        queueViews.delete(interaction.message.id);
        await interaction.update({ content: "Queue view closed.", components: [] });
        return;
      }

      if (customId === "queue_prev") {
        queueView.page = Math.max(1, queueView.page - 1);
      } else if (customId === "queue_next") {
        queueView.page += 1;
      } else if (customId === "queue_refresh") {
        // no-op; just re-render below
      } else if (customId === "queue_nowplaying") {
        queue.textChannel = interaction.channel;
        await sendNowPlaying(queue, true);
      } else if (customId === "queue_shuffle") {
        if (queue.tracks.length > 1) {
          for (let i = queue.tracks.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
          }
        }
        queueView.selectedTrackId = null;
      } else if (customId === "queue_clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
          return;
        }
        queue.tracks = [];
        queueView.selectedTrackId = null;
        logInfo("Cleared queue via queue view", { user: interaction.user.tag });
      } else if (customId === "queue_move") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const selectedTrack = queue.tracks[selectedIndex - 1];
        ensureTrackId(selectedTrack);
        const moveMenu = buildMoveMenu(queue, selectedIndex, queueView.page, queueView.pageSize);
        const moveMessage = await interaction.channel.send({
          content: `Move **${queue.tracks[selectedIndex - 1].title}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
          components: moveMenu.components,
        });
        const timeout = setTimeout(async () => {
          const entry = pendingMoves.get(moveMessage.id);
          if (!entry) {
            return;
          }
          pendingMoves.delete(moveMessage.id);
          try {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          } catch (error) {
            logError("Failed to expire move request", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingMoves.set(moveMessage.id, {
          guildId: interaction.guildId,
          ownerId: queueView.ownerId,
          sourceIndex: selectedIndex,
          trackId: selectedTrack.id,
          queueViewMessageId: interaction.message.id,
          page: moveMenu.page,
          pageSize: queueView.pageSize,
          timeout,
        });
      } else if (customId === "queue_remove") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to remove.", ephemeral: true });
          return;
        }
        const [removed] = queue.tracks.splice(selectedIndex - 1, 1);
        logInfo("Removed track via queue view", { title: removed?.title, user: interaction.user.tag });
        queueView.selectedTrackId = null;
      } else if (customId === "queue_front") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const [moved] = queue.tracks.splice(selectedIndex - 1, 1);
        queue.tracks.unshift(moved);
        logInfo("Moved track to front via queue view", { title: moved?.title, user: interaction.user.tag });
        queueView.selectedTrackId = moved.id || queueView.selectedTrackId;
        queueView.page = 1;
      }

      queueView.stale = false;
      const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
      queueView.page = pageData.page;
      queueViews.set(interaction.message.id, queueView);
      await interaction.update({
        content: pageData.content,
        components: buildQueueViewComponents(queueView, queue),
      });
    }
  };
}

module.exports = {
  createButtonInteractionHandler,
};
