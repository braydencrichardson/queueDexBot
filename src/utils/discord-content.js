const INVALID_DISCORD_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INLINE_BREAKS = /[\r\n\t]+/g;
const DISCORD_MARKDOWN_META = /([\\`*_~|>[\]()])/g;

function sanitizeDiscordText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(INVALID_DISCORD_CONTROL_CHARS, "");
}

function sanitizeInlineDiscordText(value) {
  return sanitizeDiscordText(value).replace(INLINE_BREAKS, " ").trim();
}

function escapeDiscordMarkdown(value) {
  return sanitizeInlineDiscordText(value).replace(DISCORD_MARKDOWN_META, "\\$1");
}

function sanitizeTrackForDiscord(track) {
  if (!track || typeof track !== "object") {
    return track;
  }

  if (track.title !== undefined && track.title !== null) {
    track.title = sanitizeInlineDiscordText(track.title);
  }
  if (track.requester !== undefined && track.requester !== null) {
    track.requester = sanitizeInlineDiscordText(track.requester);
  }
  if (track.channel !== undefined && track.channel !== null) {
    track.channel = sanitizeInlineDiscordText(track.channel);
  }
  if (track.artist !== undefined && track.artist !== null) {
    track.artist = sanitizeInlineDiscordText(track.artist);
  }
  if (track.author !== undefined && track.author !== null) {
    track.author = sanitizeInlineDiscordText(track.author);
  }
  if (track.url !== undefined && track.url !== null) {
    track.url = sanitizeDiscordText(track.url).trim();
  }
  if (track.displayUrl !== undefined && track.displayUrl !== null) {
    track.displayUrl = sanitizeDiscordText(track.displayUrl).trim();
  }

  return track;
}

module.exports = {
  escapeDiscordMarkdown,
  sanitizeDiscordText,
  sanitizeInlineDiscordText,
  sanitizeTrackForDiscord,
};
