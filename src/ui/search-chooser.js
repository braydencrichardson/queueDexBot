const { MessageActionRow, MessageButton, MessageSelectMenu } = require("discord.js");
const { sanitizeDiscordText, sanitizeInlineDiscordText } = require("../utils/discord-content");
const { formatTrackSummary } = require("./messages");
const { setExpiringMapEntry } = require("../handlers/interaction-helpers");
const {
  DISCORD_SELECT_LABEL_MAX_LENGTH,
  DISCORD_SELECT_LABEL_TRUNCATE_LENGTH,
} = require("../config/constants");

function createSearchChooser(deps) {
  const {
    formatDuration,
    interactionTimeoutMs,
    pendingSearches,
    logInfo,
    logError,
  } = deps;

  function formatSearchChooserMessage(query, requesterId, tracks, timeoutMs) {
    const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
    const safeQuery = sanitizeDiscordText(query);
    const lines = [
      `Search results for **${safeQuery}** (requested by <@${requesterId}>).`,
      `Choose a result within ${timeoutSeconds}s to queue a track.`,
    ];
    tracks.forEach((track, index) => {
      const channel = sanitizeInlineDiscordText(track.channel);
      const summary = formatTrackSummary(track, { formatDuration, includeRequester: false, includeLink: true });
      lines.push(`${index + 1}. ${summary}${channel ? ` | channel: ${channel}` : ""}`);
    });
    return lines.join("\n");
  }

  async function trySendSearchChooser(interaction, query, requesterId, options) {
    const chooserOptions = Array.isArray(options) ? options : [];
    if (!chooserOptions.length) {
      return false;
    }

    const content = formatSearchChooserMessage(query, requesterId, chooserOptions, interactionTimeoutMs);
    const menuOptions = chooserOptions.map((track, index) => {
      const safeTitle = sanitizeInlineDiscordText(track.title);
      const safeChannel = sanitizeInlineDiscordText(track.channel);
      const baseLabel = `${index + 1}. ${safeTitle}`;
      const label = baseLabel.length > DISCORD_SELECT_LABEL_MAX_LENGTH
        ? `${baseLabel.slice(0, DISCORD_SELECT_LABEL_TRUNCATE_LENGTH)}...`
        : baseLabel;
      const duration = formatDuration(track.duration);
      const channelParts = [];
      if (safeChannel) {
        channelParts.push(`Channel: ${safeChannel}`);
      }
      if (duration) {
        channelParts.push(duration);
      }
      const channel = channelParts.length ? channelParts.join(" • ") : null;
      return {
        label,
        value: String(index),
        description: channel || undefined,
      };
    });
    const selectRow = new MessageActionRow().addComponents(
      new MessageSelectMenu()
        .setCustomId("search_select")
        .setPlaceholder("Choose a result")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(menuOptions)
    );
    const controlRow = new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId("search_queue_first")
        .setLabel("Queue First")
        .setEmoji("⏩")
        .setStyle("PRIMARY"),
      new MessageButton()
        .setCustomId("search_close")
        .setLabel("Close")
        .setEmoji("❌")
        .setStyle("SECONDARY")
    );
    const message = await interaction.editReply({ content, components: [selectRow, controlRow], fetchReply: true });

    setExpiringMapEntry({
      store: pendingSearches,
      key: message.id,
      timeoutMs: interactionTimeoutMs,
      logError,
      errorMessage: "Failed to expire search chooser",
      onExpire: async () => {
        await message.edit({ content: `Search expired for **${sanitizeDiscordText(query)}**.`, components: [] });
      },
      entry: {
        guildId: interaction.guildId,
        requesterId,
        options: chooserOptions,
      },
    });

    logInfo("Posted search chooser", {
      query,
      requesterId,
      results: chooserOptions.length,
    });

    return true;
  }

  return {
    trySendSearchChooser,
  };
}

module.exports = {
  createSearchChooser,
};
