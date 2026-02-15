function createQueueViewService(deps) {
  const {
    queueViews,
    formatQueueViewContent,
    buildQueueViewComponents,
    queueViewTimeoutMs = 300000,
    logError,
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
      channelId: interaction.channelId || interaction.channel?.id || null,
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

  async function resolveChannel(client, channelId) {
    if (!client || !channelId) {
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

  function clearViewTimeout(entry) {
    if (entry?.timeout) {
      clearTimeout(entry.timeout);
    }
  }

  function scheduleViewTimeout(messageId, view, client) {
    const timeoutMs = Number.isFinite(queueViewTimeoutMs) && queueViewTimeoutMs > 0 ? queueViewTimeoutMs : 300000;
    return setTimeout(async () => {
      const current = queueViews.get(messageId);
      if (!current) {
        return;
      }
      queueViews.delete(messageId);
      const channel = await resolveChannel(client, current.channelId);
      if (!channel?.messages?.fetch) {
        return;
      }
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ content: "Queue view expired.", components: [] });
      } catch {
        // message likely deleted or inaccessible
      }
    }, timeoutMs);
  }

  function remember(messageId, view, channelId = null, client = null) {
    const existing = queueViews.get(messageId);
    clearViewTimeout(existing);
    const next = { ...view, channelId: channelId || view.channelId || existing?.channelId || null };
    next.timeout = scheduleViewTimeout(messageId, next, client);
    queueViews.set(messageId, next);
  }

  async function closeOtherViewsForOwner(ownerId, guildId, keepMessageId, client) {
    for (const [messageId, existing] of queueViews.entries()) {
      if (messageId === keepMessageId) {
        continue;
      }
      if (existing.ownerId !== ownerId || existing.guildId !== guildId) {
        continue;
      }
      clearViewTimeout(existing);
      queueViews.delete(messageId);
      const channel = await resolveChannel(client, existing.channelId);
      if (!channel?.messages?.fetch) {
        continue;
      }
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ content: "Queue view closed (new view opened).", components: [] });
      } catch (error) {
        if (typeof logError === "function") {
          logError("Failed to close previous queue view", error);
        }
      }
    }
  }

  async function closeByMessageId(messageId, interactionOrClient = null, reason = "Queue view closed.") {
    const existing = queueViews.get(messageId);
    if (!existing) {
      return;
    }
    clearViewTimeout(existing);
    queueViews.delete(messageId);
    const client = interactionOrClient?.client || interactionOrClient;
    const channel = await resolveChannel(client, existing.channelId);
    if (!channel?.messages?.fetch) {
      return;
    }
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit({ content: reason, components: [] });
    } catch (error) {
      if (typeof logError === "function") {
        logError("Failed to close queue view", error);
      }
    }
  }

  async function sendToChannel(channel, queue, view) {
    await closeOtherViewsForOwner(view.ownerId, view.guildId, null, channel?.client);
    const payload = buildPayload(queue, view);
    const message = await channel.send(payload);
    remember(message.id, view, message.channel?.id, channel?.client);
    return message;
  }

  async function reply(interaction, queue, view) {
    await closeOtherViewsForOwner(view.ownerId, view.guildId, null, interaction.client);
    const payload = buildPayload(queue, view);
    const message = await interaction.reply({
      ...payload,
      fetchReply: true,
    });
    remember(message.id, view, message.channel?.id || interaction.channelId, interaction.client);
    return message;
  }

  async function updateInteraction(interaction, queue, view) {
    const payload = buildPayload(queue, view);
    await interaction.update(payload);
    remember(interaction.message.id, view, interaction.channelId || interaction.message?.channel?.id, interaction.client);
  }

  async function editMessage(channel, messageId, queue, view, options = {}) {
    const { logError, errorMessage = "Failed to update queue view" } = options;
    const payload = buildPayload(queue, view);
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit(payload);
      remember(messageId, view, message.channel?.id || view.channelId, channel?.client);
      return true;
    } catch (error) {
      if (typeof logError === "function") {
        logError(errorMessage, error);
      }
      return false;
    }
  }

  async function refreshGuildViews(guildId, queue, client) {
    if (!guildId || !queue || !client) {
      return 0;
    }
    let refreshedCount = 0;
    for (const [messageId, storedView] of queueViews.entries()) {
      if (storedView.guildId !== guildId) {
        continue;
      }
      const view = { ...storedView, stale: false };
      if (view.selectedTrackId && !queue.tracks.some((track) => track?.id === view.selectedTrackId)) {
        view.selectedTrackId = null;
      }
      const channel = await resolveChannel(client, view.channelId);
      if (!channel?.messages?.fetch) {
        queueViews.set(messageId, { ...view, stale: true });
        continue;
      }
      const edited = await editMessage(channel, messageId, queue, view, {
        logError,
        errorMessage: "Failed to refresh queue view",
      });
      if (!edited) {
        const current = queueViews.get(messageId);
        if (current) {
          queueViews.set(messageId, { ...current, stale: true });
        }
        continue;
      }
      refreshedCount += 1;
    }
    return refreshedCount;
  }

  return {
    closeByMessageId,
    createFromInteraction,
    sendToChannel,
    reply,
    updateInteraction,
    editMessage,
    refreshGuildViews,
  };
}

module.exports = {
  createQueueViewService,
};
