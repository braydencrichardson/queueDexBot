const { createQueueViewService } = require("./queue-view-service");
const { clearMapEntryWithTimeout, getVoiceChannelCheck, queueSearchSelection } = require("./interaction-helpers");
const { formatMovedMessage, formatQueuedMessage } = require("../ui/messages");
const { formatDuration } = require("../queue/utils");
const { isValidQueuePosition, moveQueuedTrackToPosition } = require("../queue/operations");

function createSelectMenuInteractionHandler(deps) {
  const {
    INTERACTION_TIMEOUT_MS,
    QUEUE_VIEW_TIMEOUT_MS,
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
    maybeRefreshNowPlayingUpNext = async () => {},
  } = deps;
  const queueViewService = createQueueViewService({
    queueViews,
    formatQueueViewContent,
    buildQueueViewComponents,
    queueViewTimeoutMs: QUEUE_VIEW_TIMEOUT_MS,
    logError,
  });

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
        await interaction.reply({
          content: `Invalid selection. Choose an option between 1 and ${pending.options.length}.`,
          ephemeral: true,
        });
        return;
      }
      const selected = pending.options[index];
      await queueSearchSelection({
        interaction,
        queue,
        pendingSearches,
        pendingQueuedActions,
        selected,
        requesterId: pending.requesterId,
        interactionTimeoutMs: INTERACTION_TIMEOUT_MS,
        ensureTrackId,
        getQueuedTrackIndex,
        buildQueuedActionComponents,
        maybeRefreshNowPlayingUpNext,
        playNext,
        logInfo,
        logError,
        queueLogMessage: "Queued from search chooser",
        queuedNoticeFormatter: (track, position) => formatQueuedMessage(track, position, formatDuration),
      });
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
      const member = interaction.guild?.members?.resolve(interaction.user.id);
      const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
        return;
      }
      if (!sourceIndex || !queue.tracks[sourceIndex - 1]) {
        await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
        return;
      }
      if (!isValidQueuePosition(queue, destIndex)) {
        await interaction.reply({
          content: `Invalid destination. Choose 1-${queue.tracks.length}.`,
          ephemeral: true,
        });
        return;
      }

      const moved = moveQueuedTrackToPosition(queue, sourceIndex, destIndex);
      await maybeRefreshNowPlayingUpNext(queue);

      clearMapEntryWithTimeout(pendingMoves, interaction.message.id);
      await interaction.update({ content: formatMovedMessage(moved, destIndex), components: [] });

      const queueView = queueViews.get(pending.queueViewMessageId);
      if (queueView) {
        ensureTrackId(moved);
        queueView.selectedTrackId = moved.id;
        queueView.page = Math.floor((destIndex - 1) / queueView.pageSize) + 1;
        queueView.stale = false;
        await queueViewService.editMessage(interaction.channel, pending.queueViewMessageId, queue, queueView, {
          logError,
          errorMessage: "Failed to update queue view after move",
        });
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
      await queueViewService.updateInteraction(interaction, queue, queueView);
    }
  };
}

module.exports = {
  createSelectMenuInteractionHandler,
};
