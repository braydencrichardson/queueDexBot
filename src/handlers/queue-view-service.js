function createQueueViewService(deps) {
  const {
    queueViews,
    formatQueueViewContent,
    buildQueueViewComponents,
  } = deps;

  function resolveOwnerName(interaction) {
    return interaction.member?.displayName || interaction.user?.username || interaction.user?.tag || "requester";
  }

  function createFromInteraction(interaction, options) {
    const {
      page = 1,
      pageSize,
      selectedTrackId = null,
      stale = false,
    } = options;
    return {
      guildId: interaction.guildId,
      page,
      pageSize,
      ownerId: interaction.user.id,
      ownerName: resolveOwnerName(interaction),
      selectedTrackId,
      stale,
    };
  }

  function buildPayload(queue, view) {
    const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, {
      stale: view.stale,
      ownerName: view.ownerName,
    });
    view.page = pageData.page;
    return {
      content: pageData.content,
      components: buildQueueViewComponents(view, queue),
    };
  }

  function remember(messageId, view) {
    queueViews.set(messageId, { ...view });
  }

  async function sendToChannel(channel, queue, view) {
    const payload = buildPayload(queue, view);
    const message = await channel.send(payload);
    remember(message.id, view);
    return message;
  }

  async function reply(interaction, queue, view) {
    const payload = buildPayload(queue, view);
    const message = await interaction.reply({
      ...payload,
      fetchReply: true,
    });
    remember(message.id, view);
    return message;
  }

  async function updateInteraction(interaction, queue, view) {
    const payload = buildPayload(queue, view);
    remember(interaction.message.id, view);
    await interaction.update(payload);
  }

  async function editMessage(channel, messageId, queue, view, options = {}) {
    const { logError, errorMessage = "Failed to update queue view" } = options;
    const payload = buildPayload(queue, view);
    remember(messageId, view);
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit(payload);
      return true;
    } catch (error) {
      if (typeof logError === "function") {
        logError(errorMessage, error);
      }
      return false;
    }
  }

  return {
    createFromInteraction,
    sendToChannel,
    reply,
    updateInteraction,
    editMessage,
  };
}

module.exports = {
  createQueueViewService,
};
