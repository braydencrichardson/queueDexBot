const { MessageActionRow, MessageButton } = require("discord.js");

function buildQueuedActionComponents(options = {}) {
  const { includeMoveControls = true } = options;
  const buttons = [
    new MessageButton()
      .setCustomId("queued_view")
      .setLabel("View Queue")
      .setEmoji("📜")
      .setStyle("SECONDARY"),
  ];
  if (includeMoveControls) {
    buttons.push(
      new MessageButton()
        .setCustomId("queued_move")
        .setLabel("Move To")
        .setEmoji("↔️")
        .setStyle("SECONDARY"),
      new MessageButton()
        .setCustomId("queued_first")
        .setLabel("Move to First")
        .setEmoji("⏫")
        .setStyle("PRIMARY")
    );
  }
  buttons.push(
    new MessageButton()
      .setCustomId("queued_remove")
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle("DANGER")
  );
  const row = new MessageActionRow().addComponents(...buttons);
  return [row];
}

function buildNowPlayingControls() {
  return new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("np_queue")
      .setLabel("View Queue")
      .setEmoji("📜")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("np_toggle")
      .setLabel("Play/Pause")
      .setEmoji("⏯️")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("np_skip")
      .setLabel("Skip")
      .setEmoji("⏭️")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("np_stop")
      .setLabel("Stop")
      .setEmoji("⏹️")
      .setStyle("DANGER")
  );
}

module.exports = {
  buildPlaylistQueuedComponents(requesterId) {
    const safeRequesterId = String(requesterId || "").trim();
    const customId = safeRequesterId ? `playlist_view_queue:${safeRequesterId}` : "playlist_view_queue";
    return [
      new MessageActionRow().addComponents(
        new MessageButton()
          .setCustomId(customId)
          .setLabel("View Queue")
          .setEmoji("📜")
          .setStyle("SECONDARY")
      ),
    ];
  },
  buildQueuedActionComponents,
  buildNowPlayingControls,
};
