const { MessageActionRow, MessageButton, MessageSelectMenu } = require("discord.js");

function createSearchChooser(deps) {
  const {
    playdl,
    isSpotifyUrl,
    hasSpotifyCredentials,
    getSpotifySearchOptions,
    isProbablyUrl,
    searchYouTubeOptions,
    formatDuration,
    interactionTimeoutMs,
    pendingSearches,
    logInfo,
    logError,
    searchChooserMaxResults,
  } = deps;

  function formatSearchChooserMessage(query, requesterId, tracks, timeoutMs) {
    const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
    const lines = [
      `Search results for **${query}** (requested by <@${requesterId}>).`,
      `Choose a result within ${timeoutSeconds}s to queue a track.`,
    ];
    tracks.forEach((track, index) => {
      const duration = formatDuration(track.duration);
      const displayUrl = track.displayUrl || track.url;
      const link = displayUrl ? ` (<${displayUrl}>)` : "";
      lines.push(`${index + 1}. ${track.title}${duration ? ` (**${duration}**)` : ""}${link}`);
      if (track.channel) {
        lines.push(`   ${track.channel}`);
      }
    });
    return lines.join("\n");
  }

  async function maybeSendSearchChooser(interaction, query, requesterName, requesterId) {
    let options = [];
    if (isSpotifyUrl(query) && !hasSpotifyCredentials()) {
      const spotifyType = playdl.sp_validate(query);
      if (spotifyType === "track") {
        options = await getSpotifySearchOptions(query, requesterName);
      } else {
        return false;
      }
    } else if (!isProbablyUrl(query)) {
      options = await searchYouTubeOptions(query, requesterName, null, searchChooserMaxResults);
    }

    if (!options.length) {
      return false;
    }

    const content = formatSearchChooserMessage(query, requesterId, options, interactionTimeoutMs);
    const menuOptions = options.map((track, index) => {
      const baseLabel = `${index + 1}. ${track.title}`;
      const label = baseLabel.length > 100 ? `${baseLabel.slice(0, 97)}...` : baseLabel;
      const duration = formatDuration(track.duration);
      const channelParts = [];
      if (track.channel) {
        channelParts.push(`Channel: ${track.channel}`);
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
        .setCustomId("search_close")
        .setLabel("Close")
        .setEmoji("❌")
        .setStyle("SECONDARY")
    );
    const message = await interaction.editReply({ content, components: [selectRow, controlRow], fetchReply: true });

    const timeout = setTimeout(async () => {
      const entry = pendingSearches.get(message.id);
      if (!entry) {
        return;
      }
      pendingSearches.delete(message.id);
      try {
        await message.edit({ content: `Search expired for **${query}**.`, components: [] });
      } catch (error) {
        logError("Failed to expire search chooser", error);
      }
    }, interactionTimeoutMs);

    pendingSearches.set(message.id, {
      guildId: interaction.guildId,
      requesterId,
      options,
      timeout,
    });

    logInfo("Posted search chooser", {
      query,
      requesterId,
      results: options.length,
    });

    return true;
  }

  return {
    maybeSendSearchChooser,
  };
}

module.exports = {
  createSearchChooser,
};
