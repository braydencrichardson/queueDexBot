const { MessageActionRow, MessageButton, MessageSelectMenu } = require("discord.js");
const {
  ensureTrackId,
  getTrackIndexById,
  formatDuration,
} = require("../queue/utils");
const { escapeDiscordMarkdown, sanitizeInlineDiscordText } = require("../utils/discord-content");
const { formatTrackPrimary, formatTrackSecondary } = require("./messages");
const {
  DEFAULT_QUEUE_MOVE_MENU_PAGE_SIZE,
  DISCORD_MESSAGE_SAFE_MAX_LENGTH,
  DISCORD_SELECT_LABEL_MAX_LENGTH,
  DISCORD_SELECT_LABEL_TRUNCATE_LENGTH,
  QUEUE_PREVIEW_LINE_CLAMP_MAX_LENGTH,
  QUEUE_PREVIEW_LINE_CLAMP_SLICE_LENGTH,
} = require("../config/constants");

function formatQueuePage(queue, page, pageSize, selectedTrackId) {
  function getTrackKey(track) {
    if (!track) {
      return null;
    }
    return String(track.id || `${track.url || ""}|${track.title || ""}|${track.requester || ""}`);
  }

  function isTrackPreloaded(track) {
    const trackKey = getTrackKey(track);
    if (!trackKey) {
      return false;
    }
    return queue?.preloadedNextTrackKey === trackKey && Boolean(queue?.preloadedNextResource);
  }

  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const totalQueued = (queue.current ? 1 : 0) + queue.tracks.length;
  const totalSeconds = [queue.current, ...queue.tracks]
    .filter(Boolean)
    .reduce((sum, track) => sum + (typeof track.duration === "number" ? track.duration : 0), 0);
  const totalDuration = formatDuration(totalSeconds);
  const lines = [
    `**Total queued:** ${totalQueued}${totalDuration ? ` (**${totalDuration}**)` : ""}`,
  ];
  if (queue.current) {
    const nowPrimary = formatTrackPrimary(queue.current, {
      formatDuration,
      includeRequester: true,
    });
    const nowSecondary = formatTrackSecondary(queue.current, {
      includeArtist: true,
      includeLink: true,
    });
    lines.push(`**Now playing:** ${nowPrimary}`);
    if (nowSecondary) {
      lines.push(`↳ ${nowSecondary}`);
    }
  }
  if (queue.tracks.length) {
    lines.push(`**Up next:** (page ${safePage}/${totalPages})`);
    const preview = queue.tracks
      .slice(startIndex, startIndex + pageSize)
      .map((track, index) => {
        ensureTrackId(track);
        const number = startIndex + index + 1;
        const selectedMark = track.id && track.id === selectedTrackId ? "▶ " : "•  ";
        const primary = formatTrackPrimary(track, {
          formatDuration,
          includeRequester: true,
        });
        const secondary = formatTrackSecondary(track, {
          includeArtist: true,
          includeLink: true,
        });
        const preloadMarker = isTrackPreloaded(track) ? "● " : "";
        const firstLine = `${selectedMark}**${number}.** ${preloadMarker}${primary}`;
        return secondary ? [firstLine, `   ↳ ${secondary}`] : [firstLine];
      });
    const maxLength = DISCORD_MESSAGE_SAFE_MAX_LENGTH;
    let previewLines = preview.flat();
    let content = [...lines, previewLines.join("\n")].join("\n");
    if (content.length > maxLength) {
      const previewWithTruncatedLinks = queue.tracks
        .slice(startIndex, startIndex + pageSize)
        .map((track, index) => {
          ensureTrackId(track);
          const number = startIndex + index + 1;
          const isSelected = Boolean(track.id && track.id === selectedTrackId);
          const selectedMark = isSelected ? "▶ " : "•  ";
          const primary = formatTrackPrimary(track, {
            formatDuration,
            includeRequester: true,
          });
          const secondary = formatTrackSecondary(track, {
            includeArtist: true,
            includeLink: true,
            truncateLinkDisplay: !isSelected,
          });
          const preloadMarker = isTrackPreloaded(track) ? "● " : "";
          const firstLine = `${selectedMark}**${number}.** ${preloadMarker}${primary}`;
          return secondary ? [firstLine, `   ↳ ${secondary}`] : [firstLine];
        });
      const truncatedPreviewLines = previewWithTruncatedLinks.flat();
      const truncatedContent = [...lines, truncatedPreviewLines.join("\n")].join("\n");
      if (truncatedContent.length <= maxLength) {
        previewLines = truncatedPreviewLines;
        content = truncatedContent;
      }
    }
    if (content.length > maxLength) {
      const previewWithPriorityLinks = queue.tracks
        .slice(startIndex, startIndex + pageSize)
        .map((track, index) => {
          ensureTrackId(track);
          const number = startIndex + index + 1;
          const isSelected = Boolean(track.id && track.id === selectedTrackId);
          const selectedMark = isSelected ? "▶ " : "•  ";
          const primary = formatTrackPrimary(track, {
            formatDuration,
            includeRequester: true,
          });
          const keepLink = isSelected || index === 0;
          const secondary = formatTrackSecondary(track, {
            includeArtist: true,
            includeLink: keepLink,
          });
          const preloadMarker = isTrackPreloaded(track) ? "● " : "";
          const firstLine = `${selectedMark}**${number}.** ${preloadMarker}${primary}`;
          return secondary ? [firstLine, `   ↳ ${secondary}`] : [firstLine];
        });
      const priorityPreviewLines = previewWithPriorityLinks.flat();
      const priorityContent = [...lines, priorityPreviewLines.join("\n")].join("\n");
      if (priorityContent.length <= maxLength) {
        previewLines = priorityPreviewLines;
        content = priorityContent;
      }
    }
    if (content.length > maxLength) {
      const stripLink = (line) => line.replace(/\s*\((<https?:\/\/[^>]+>|\[[^\]]+\]\(<https?:\/\/[^>]+>\))\)/g, "");
      const stripRequester = (line) => line.replace(/\s*\(requested by \*\*[^)]+\*\*\)/g, "");
      const clampLine = (line) => (
        line.length > QUEUE_PREVIEW_LINE_CLAMP_MAX_LENGTH
          ? `${line.slice(0, QUEUE_PREVIEW_LINE_CLAMP_SLICE_LENGTH)}…`
          : line
      );
      const previewNoLinks = previewLines.map(stripLink);
      const previewNoLinksNoRequester = previewNoLinks.map(stripRequester).map(clampLine);
      content = [...lines, previewNoLinksNoRequester.join("\n")].join("\n");
      previewLines = previewNoLinksNoRequester;
    }
    while (content.length > maxLength && previewLines.length > 1) {
      previewLines.pop();
      content = [...lines, previewLines.join("\n")].join("\n");
    }
    if (content.length > maxLength) {
      content = `${content.slice(0, maxLength - 1)}…`;
    }
    return { content, page: safePage, totalPages };
  }

  lines.push("**Up next:** (empty)");
  return { content: lines.join("\n"), page: safePage, totalPages };
}

function buildQueueViewComponents(queueView, queue) {
  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / queueView.pageSize));
  const safePage = Math.min(Math.max(queueView.page, 1), totalPages);
  const startIndex = (safePage - 1) * queueView.pageSize;
  const options = queue.tracks
    .slice(startIndex, startIndex + queueView.pageSize)
    .map((track, index) => {
      ensureTrackId(track);
      const absoluteIndex = startIndex + index + 1;
      const duration = formatDuration(track.duration);
      const labelBase = `${absoluteIndex}. ${sanitizeInlineDiscordText(track.title)}`;
      const label = labelBase.length > DISCORD_SELECT_LABEL_MAX_LENGTH
        ? `${labelBase.slice(0, DISCORD_SELECT_LABEL_TRUNCATE_LENGTH)}...`
        : labelBase;
      return {
        label,
        value: track.id,
        description: duration ? `Duration: ${duration}` : undefined,
        default: queueView.selectedTrackId === track.id,
      };
    });

  const selectRow = new MessageActionRow().addComponents(
    new MessageSelectMenu()
      .setCustomId("queue_select")
      .setPlaceholder(options.length ? "Select a track" : "Queue is empty")
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(options.length === 0)
      .addOptions(options.length ? options : [{ label: "Empty", value: "0" }])
  );

  const actionRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_backward")
      .setLabel("Move Up")
      .setEmoji("⬆️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_forward")
      .setLabel("Move Down")
      .setEmoji("⬇️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_move")
      .setLabel("Move To")
      .setEmoji("↔️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_front")
      .setLabel("Move to First")
      .setEmoji("⏫")
      .setStyle("PRIMARY")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_remove")
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle("DANGER")
      .setDisabled(!options.length || !queueView.selectedTrackId)
  );

  const selectNavRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_select_prev")
      .setLabel("Select Previous")
      .setEmoji("⬅️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length),
    new MessageButton()
      .setCustomId("queue_select_next")
      .setLabel("Select Next")
      .setEmoji("➡️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length),
    new MessageButton()
      .setCustomId("queue_select_last")
      .setLabel("Select Last")
      .setEmoji("⏭️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length)
  );

  const navRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_prev")
      .setLabel("Previous Page")
      .setEmoji("⬅️")
      .setStyle("SECONDARY")
      .setDisabled(safePage <= 1),
    new MessageButton()
      .setCustomId("queue_next")
      .setLabel("Next Page")
      .setEmoji("➡️")
      .setStyle("SECONDARY")
      .setDisabled(safePage >= totalPages),
    new MessageButton()
      .setCustomId("queue_refresh")
      .setLabel("Refresh")
      .setEmoji("🔃")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queue_shuffle")
      .setLabel("Shuffle")
      .setEmoji("🔀")
      .setStyle("SECONDARY")
      .setDisabled(queue.tracks.length < 2),
    new MessageButton()
      .setCustomId("queue_clear")
      .setLabel("Clear")
      .setEmoji("⚠️")
      .setStyle("DANGER")
      .setDisabled(queue.tracks.length === 0)
  );

  const navRow2 = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_nowplaying")
      .setLabel("Now Playing")
      .setEmoji("🎶")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queue_close")
      .setLabel("Close")
      .setEmoji("❌")
      .setStyle("SECONDARY")
  );

  return [selectRow, navRow, actionRow, selectNavRow, navRow2];
}

function formatQueueViewContent(queue, page, pageSize, selectedTrackId, { stale, ownerName } = {}) {
  const pageData = formatQueuePage(queue, page, pageSize, selectedTrackId);
  const safeOwnerName = escapeDiscordMarkdown(ownerName || "requester");
  const headerLines = [
    `_**Queue** controls limited to **${safeOwnerName}.**_`,
  ];
  if (stale) {
    headerLines.unshift("_Queue view may be stale — press Refresh._");
  }
  if (selectedTrackId) {
    const selectedIndex = getTrackIndexById(queue, selectedTrackId);
    if (selectedIndex >= 0) {
      const selectedTrack = queue.tracks[selectedIndex];
      const selectedTitle = escapeDiscordMarkdown(selectedTrack.title);
        return {
          ...pageData,
          content: `${headerLines.join("\n")}\n${pageData.content}\n**Selected:** ${selectedIndex + 1}. ${selectedTitle}`,
        };
      }
    }
  return { ...pageData, content: `${headerLines.join("\n")}\n${pageData.content}` };
}

function buildMoveMenu(queue, selectedIndex, page = 1, pageSize = DEFAULT_QUEUE_MOVE_MENU_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const options = queue.tracks.slice(startIndex, startIndex + pageSize).map((track, index) => {
    const position = startIndex + index + 1;
    const labelBase = `${position}. ${sanitizeInlineDiscordText(track.title)}`;
    const label = labelBase.length > DISCORD_SELECT_LABEL_MAX_LENGTH
      ? `${labelBase.slice(0, DISCORD_SELECT_LABEL_TRUNCATE_LENGTH)}...`
      : labelBase;
    const description = position === selectedIndex ? "Current position" : undefined;
    return { label, value: String(position), description };
  });

  const selectRow = new MessageActionRow().addComponents(
    new MessageSelectMenu()
      .setCustomId("queue_move_select")
      .setPlaceholder("Move selected track to position…")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options.length ? options : [{ label: "Empty", value: "0" }])
      .setDisabled(options.length === 0)
  );

  const controlRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("move_prev")
      .setLabel("Previous Page")
      .setEmoji("⬅️")
      .setStyle("SECONDARY")
      .setDisabled(safePage <= 1),
    new MessageButton()
      .setCustomId("move_next")
      .setLabel("Next Page")
      .setEmoji("➡️")
      .setStyle("SECONDARY")
      .setDisabled(safePage >= totalPages),
    new MessageButton()
      .setCustomId("move_first")
      .setLabel("Move to First")
      .setEmoji("⏫")
      .setStyle("PRIMARY"),
    new MessageButton()
      .setCustomId("move_close")
      .setLabel("Close")
      .setEmoji("❌")
      .setStyle("SECONDARY")
  );
  return { components: [selectRow, controlRow], page: safePage, totalPages };
}

module.exports = {
  buildMoveMenu,
  buildQueueViewComponents,
  formatQueueViewContent,
};
