function createSelectMenuInteractionHandler(deps) {
  const {
    INTERACTION_TIMEOUT_MS,
    getGuildQueue,
    isSameVoiceChannel,
    buildQueueViewComponents,
    buildQueuedActionComponents,
    formatQueueViewContent,
    getTrackIndexById,
    ensureTrackId,
    getQueuedTrackIndex,
    pendingSearches,
    pendingMoves,
    pendingQueuedActions,
    queueViews,
    logInfo,
    logError,
    playNext,
  } = deps;

  return async function handleSelectMenuInteraction(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Menus can only be used in a server.", ephemeral: true });
      return;
    }
    if (interaction.customId === "search_select") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can choose a result.", ephemeral: true });
        return;
      }
      const member = interaction.guild?.members?.resolve(interaction.user.id);
      const queue = getGuildQueue(interaction.guildId);
      if (!isSameVoiceChannel(member, queue)) {
        await interaction.reply({ content: "Join my voice channel to choose a result.", ephemeral: true });
        return;
      }
      const index = parseInt(interaction.values?.[0], 10);
      if (!Number.isFinite(index) || index < 0 || index >= pending.options.length) {
        await interaction.reply({ content: "Invalid selection.", ephemeral: true });
        return;
      }
      const selected = pending.options[index];
      pendingSearches.delete(interaction.message.id);
      clearTimeout(pending.timeout);

      queue.textChannel = interaction.channel;
      ensureTrackId(selected);
      queue.tracks.push(selected);
      logInfo("Queued from search chooser", {
        title: selected.title,
        guildId: interaction.guildId,
        requesterId: pending.requesterId,
      });

      const queuedIndex = getQueuedTrackIndex(queue, selected);
      const positionText = queuedIndex >= 0 ? ` (position ${queuedIndex + 1})` : "";
      const showQueuedControls = queuedIndex >= 1;
      await interaction.update({
        content: `Queued: **${selected.title}**${positionText} (requested by **${selected.requester || "unknown"}**).`,
        components: showQueuedControls ? buildQueuedActionComponents() : [],
      });
      if (showQueuedControls) {
        const timeout = setTimeout(async () => {
          try {
            const entry = pendingQueuedActions.get(interaction.message.id);
            if (!entry) {
              return;
            }
            pendingQueuedActions.delete(interaction.message.id);
            await interaction.message.edit({ components: [] });
          } catch (error) {
            logError("Failed to expire queued action controls", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingQueuedActions.set(interaction.message.id, {
          guildId: interaction.guildId,
          ownerId: interaction.user.id,
          trackId: selected.id,
          trackTitle: selected.title,
          timeout,
        });
      }

      if (!queue.playing) {
        playNext(interaction.guildId).catch((error) => {
          logError("Error starting playback", error);
        });
      }
      return;
    }

    if (interaction.customId === "queue_move_select") {
      const pending = pendingMoves.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That move request has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can move tracks.", ephemeral: true });
        return;
      }
      const queue = getGuildQueue(interaction.guildId);
      const sourceIndex = pending.trackId ? getTrackIndexById(queue, pending.trackId) + 1 : pending.sourceIndex;
      const destIndex = parseInt(interaction.values?.[0], 10);
      if (!sourceIndex || !queue.tracks[sourceIndex - 1]) {
        await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
        return;
      }
      if (!Number.isFinite(destIndex) || destIndex < 1 || destIndex > queue.tracks.length) {
        await interaction.reply({ content: "Invalid destination.", ephemeral: true });
        return;
      }

      const [moved] = queue.tracks.splice(sourceIndex - 1, 1);
      queue.tracks.splice(destIndex - 1, 0, moved);

      pendingMoves.delete(interaction.message.id);
      clearTimeout(pending.timeout);
      await interaction.update({ content: `Moved **${moved.title}** to position ${destIndex}.`, components: [] });

      const queueView = queueViews.get(pending.queueViewMessageId);
      if (queueView) {
        ensureTrackId(moved);
        queueView.selectedTrackId = moved.id;
        queueView.page = Math.floor((destIndex - 1) / queueView.pageSize) + 1;
        queueView.stale = false;
        const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
        queueViews.set(pending.queueViewMessageId, queueView);
        try {
          const viewMessage = await interaction.channel.messages.fetch(pending.queueViewMessageId);
          await viewMessage.edit({
            content: pageData.content,
            components: buildQueueViewComponents(queueView, queue),
          });
        } catch (error) {
          logError("Failed to update queue view after move", error);
        }
      }
      return;
    }

    const queueView = queueViews.get(interaction.message.id);
    if (!queueView) {
      await interaction.reply({ content: "That queue view has expired.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== queueView.ownerId) {
      await interaction.reply({ content: "Only the requester can control this queue view.", ephemeral: true });
      return;
    }
    if (interaction.customId === "queue_select") {
      const selectedId = interaction.values?.[0];
      if (selectedId) {
        queueView.selectedTrackId = selectedId;
      }
      queueView.stale = false;
      const queue = getGuildQueue(interaction.guildId);
      const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
      queueViews.set(interaction.message.id, queueView);
      await interaction.update({
        content: pageData.content,
        components: buildQueueViewComponents(queueView, queue),
      });
    }
  };
}

module.exports = {
  createSelectMenuInteractionHandler,
};
