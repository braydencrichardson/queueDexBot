const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { LOOP_MODES } = require("../queue/loop");

function buildQueuedActionComponents(options = {}) {
  const { includeMoveControls = true } = options;
  const buttons = [
    new ButtonBuilder()
      .setCustomId("queued_view")
      .setLabel("View Queue")
      .setEmoji("📜")
      .setStyle(ButtonStyle.Secondary),
  ];
  if (includeMoveControls) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("queued_move")
        .setLabel("Move To")
        .setEmoji("↔️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("queued_first")
        .setLabel("Move to First")
        .setEmoji("⏫")
        .setStyle(ButtonStyle.Primary)
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId("queued_remove")
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
  );
  const row = new ActionRowBuilder().addComponents(...buttons);
  return [row];
}

function normalizeLoopMode(loopMode) {
  const value = String(loopMode || "").trim().toLowerCase();
  if (value === LOOP_MODES.SINGLE || value === LOOP_MODES.QUEUE) {
    return value;
  }
  return LOOP_MODES.OFF;
}

function getLoopButtonConfig(loopMode) {
  const normalized = normalizeLoopMode(loopMode);
  if (normalized === LOOP_MODES.SINGLE) {
    return { label: "Loop", style: ButtonStyle.Primary, emoji: "🔂" };
  }
  if (normalized === LOOP_MODES.QUEUE) {
    return { label: "Loop", style: ButtonStyle.Success, emoji: "🔁" };
  }
  return { label: "Loop", style: ButtonStyle.Secondary, emoji: "❌" };
}

function buildNowPlayingControls(options = {}) {
  const { loopMode = LOOP_MODES.OFF } = options;
  const loopButton = getLoopButtonConfig(loopMode);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("np_queue")
      .setLabel("View Queue")
      .setEmoji("📜")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("np_toggle")
      .setLabel("Play/Pause")
      .setEmoji("⏯️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("np_loop")
      .setLabel(loopButton.label)
      .setEmoji(loopButton.emoji)
      .setStyle(loopButton.style),
    new ButtonBuilder()
      .setCustomId("np_skip")
      .setLabel("Skip")
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("np_stop")
      .setLabel("Stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger)
  );
}

module.exports = {
  buildPlaylistQueuedComponents(requesterId) {
    const safeRequesterId = String(requesterId || "").trim();
    const customId = safeRequesterId ? `playlist_view_queue:${safeRequesterId}` : "playlist_view_queue";
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel("View Queue")
          .setEmoji("📜")
          .setStyle(ButtonStyle.Secondary)
      ),
    ];
  },
  buildQueuedActionComponents,
  buildNowPlayingControls,
};
