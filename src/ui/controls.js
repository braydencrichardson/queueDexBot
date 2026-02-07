const { MessageActionRow, MessageButton } = require("discord.js");

function buildQueuedActionComponents() {
  const row = new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("queued_view")
      .setLabel("View Queue")
      .setEmoji("📜")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queued_move")
      .setLabel("Move")
      .setEmoji("↔️")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("queued_first")
      .setLabel("Move to First")
      .setEmoji("⏫")
      .setStyle("PRIMARY"),
    new MessageButton()
      .setCustomId("queued_remove")
      .setLabel("Remove")
      .setEmoji("🗑️")
      .setStyle("DANGER")
  );
  return [row];
}

function buildNowPlayingControls() {
  return new MessageActionRow().addComponents(
    new MessageButton()
      .setCustomId("np_toggle")
      .setLabel("Play/Pause")
      .setEmoji("⏯️")
      .setStyle("SECONDARY"),
    new MessageButton()
      .setCustomId("np_queue")
      .setLabel("Queue")
      .setEmoji("📜")
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
  buildQueuedActionComponents,
  buildNowPlayingControls,
};
