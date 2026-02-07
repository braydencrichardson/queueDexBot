const { MessageActionRow, MessageButton, MessageSelectMenu } = require("discord.js");
const {
  ensureTrackId,
  getTrackIndexById,
  formatDuration,
} = require("../queue/utils");
const { sanitizeDiscordText, sanitizeInlineDiscordText } = require("../utils/discord-content");
const {
  DEFAULT_QUEUE_MOVE_MENU_PAGE_SIZE,
  DISCORD_MESSAGE_SAFE_MAX_LENGTH,
  DISCORD_SELECT_LABEL_MAX_LENGTH,
  DISCORD_SELECT_LABEL_TRUNCATE_LENGTH,
  QUEUE_PREVIEW_LINE_CLAMP_MAX_LENGTH,
  QUEUE_PREVIEW_LINE_CLAMP_SLICE_LENGTH,
} = require("../config/constants");

function formatQueuePage(queue, page, pageSize, selectedTrackId) {
  const totalPages = Math.max(1, Math.ceil(queue.tracks.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const totalQueued = (queue.current ? 1 : 0) + queue.tracks.length;
  const totalSeconds = [queue.current, ...queue.tracks]
    .filter(Boolean)
    .reduce((sum, track) => sum + (typeof track.duration === "number" ? track.duration : 0), 0);
  const totalDuration = formatDuration(totalSeconds);
  const lines = [
    `Total queued: ${totalQueued}${totalDuration ? ` (${totalDuration})` : ""}`,
  ];
  if (queue.current) {
    const nowDuration = formatDuration(queue.current.duration);
    const nowTitle = sanitizeInlineDiscordText(queue.current.title);
    const nowRequester = sanitizeInlineDiscordText(queue.current.requester);
    const nowDisplayUrl = sanitizeDiscordText(queue.current.displayUrl || queue.current.url);
    const nowLink = (queue.current.source === "youtube" || queue.current.source === "soundcloud") && nowDisplayUrl
      ? ` (<${nowDisplayUrl}>)`
      : "";
    lines.push(`Now playing: ${nowTitle}${nowDuration ? ` (**${nowDuration}**)` : ""}${nowRequester ? ` (requested by **${nowRequester}**)` : ""}${nowLink}`);
  }
  if (queue.tracks.length) {
    lines.push(`Up next (page ${safePage}/${totalPages}):`);
    const preview = queue.tracks
      .slice(startIndex, startIndex + pageSize)
      .map((track, index) => {
        ensureTrackId(track);
        const duration = formatDuration(track.duration);
        const safeTitle = sanitizeInlineDiscordText(track.title);
        const safeRequester = sanitizeInlineDiscordText(track.requester);
        const displayUrl = sanitizeDiscordText(track.displayUrl || track.url);
        const link = (track.source === "youtube" || track.source === "soundcloud") && displayUrl
          ? ` (<${displayUrl}>)`
          : "";
        const number = startIndex + index + 1;
        const numberText = track.id && track.id === selectedTrackId ? `**${number}.**` : `${number}.`;
        const firstLine = `${numberText} ${safeTitle}${duration ? ` (**${duration}**)` : ""}${safeRequester ? ` (requested by **${safeRequester}**)` : ""}`;
        const secondLine = link ? `   ${link}` : null;
        return secondLine ? [firstLine, secondLine] : [firstLine];
      });
    const maxLength = DISCORD_MESSAGE_SAFE_MAX_LENGTH;
    let previewLines = preview.flat();
    let content = [...lines, previewLines.join("\n")].join("\n");
    if (content.length > maxLength) {
      const stripLink = (line) => line.replace(/\s*\(<https?:\/\/[^>]+>\)/g, "");
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

  lines.push("Up next: (empty)");
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
      .setCustomId("queue_remove")
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle("DANGER")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_move")
      .setLabel("Move")
      .setEmoji("↔️")
      .setStyle("SECONDARY")
      .setDisabled(!options.length || !queueView.selectedTrackId),
    new MessageButton()
      .setCustomId("queue_front")
      .setLabel("Move to First")
      .setEmoji("⏫")
      .setStyle("PRIMARY")
      .setDisabled(!options.length || !queueView.selectedTrackId)
  );

  const navRow = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queue_prev")
      .setLabel("Prev")
      .setEmoji("⬅️")
      .setStyle("SECONDARY")
      .setDisabled(safePage <= 1),
    new MessageButton()
      .setCustomId("queue_next")
      .setLabel("Next")
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

  return [selectRow, actionRow, navRow, navRow2];
}

function formatQueueViewContent(queue, page, pageSize, selectedTrackId, { stale, ownerName } = {}) {
  const pageData = formatQueuePage(queue, page, pageSize, selectedTrackId);
  const safeOwnerName = sanitizeInlineDiscordText(ownerName || "requester");
  const headerLines = [
    `_Controls limited to ${safeOwnerName}._`,
  ];
  if (stale) {
    headerLines.unshift("_Queue view may be stale — press Refresh._");
  }
  if (selectedTrackId) {
    const selectedIndex = getTrackIndexById(queue, selectedTrackId);
    if (selectedIndex >= 0) {
      const selectedTrack = queue.tracks[selectedIndex];
      const selectedTitle = sanitizeInlineDiscordText(selectedTrack.title);
      return {
        ...pageData,
        content: `${headerLines.join("\n")}\n${pageData.content}\nSelected: ${selectedIndex + 1}. ${selectedTitle}`,
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
      .setLabel("Prev")
      .setEmoji("⬅️")
      .setStyle("SECONDARY")
      .setDisabled(safePage <= 1),
    new MessageButton()
      .setCustomId("move_next")
      .setLabel("Next")
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
