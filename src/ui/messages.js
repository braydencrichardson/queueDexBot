const { escapeDiscordMarkdown, sanitizeDiscordText, sanitizeInlineDiscordText } = require("../utils/discord-content");

function getTrackDisplayUrl(track, { embeddable = false } = {}) {
  const raw = track?.displayUrl || track?.url;
  const safeUrl = sanitizeDiscordText(raw).trim();
  if (!safeUrl) {
    return "";
  }
  return embeddable ? safeUrl : `<${safeUrl}>`;
}

function getTrackRawUrl(track) {
  const raw = track?.displayUrl || track?.url;
  const safeUrl = sanitizeDiscordText(raw).trim();
  return safeUrl || "";
}

function formatTruncatedClickableUrl(track, { startChars = 12, endChars = 8 } = {}) {
  const rawUrl = getTrackRawUrl(track);
  if (!rawUrl) {
    return "";
  }
  if (rawUrl.length <= startChars + endChars + 1) {
    return `[${rawUrl}](<${rawUrl}>)`;
  }
  const display = `${rawUrl.slice(0, startChars)}…${rawUrl.slice(-endChars)}`;
  return `[${display}](<${rawUrl}>)`;
}

function getTrackTitle(track) {
  const spotifyMetaTitle = track?.pendingResolve ? track?.spotifyMeta?.name : null;
  return escapeDiscordMarkdown(track?.title || spotifyMetaTitle) || "unknown track";
}

function getTrackRequester(track) {
  return escapeDiscordMarkdown(track?.requester) || "";
}

function getTrackArtist(track) {
  if (track?.pendingResolve) {
    const spotifyMetaArtists = Array.isArray(track?.spotifyMeta?.artists)
      ? track.spotifyMeta.artists.filter(Boolean).join(", ")
      : "";
    // For pending Spotify rows, avoid falling back to generic "Spotify" channel labels.
    return escapeDiscordMarkdown(spotifyMetaArtists) || "";
  }
  return escapeDiscordMarkdown(
    track?.artist || track?.channel || track?.author || track?.uploader || track?.channelName
  ) || "";
}

function getTrackDuration(track, formatDuration) {
  if (typeof formatDuration !== "function") {
    return "";
  }
  return formatDuration(track?.duration);
}

function formatTrackPrimary(track, { formatDuration, includeRequester = true } = {}) {
  const title = getTrackTitle(track);
  const duration = getTrackDuration(track, formatDuration);
  const requester = includeRequester ? getTrackRequester(track) : "";
  let text = track?.pendingResolve ? `*${title}*` : title;
  if (duration) {
    text += ` (**${duration}**)`;
  }
  if (requester) {
    text += ` (requested by **${requester}**)`;
  }
  return text;
}

function formatTrackSecondary(
  track,
  {
    includeArtist = true,
    includeLink = true,
    embeddableLink = false,
    truncateLinkDisplay = false,
    linkStartChars = 12,
    linkEndChars = 8,
  } = {}
) {
  const artist = includeArtist ? getTrackArtist(track) : "";
  const link = includeLink
    ? (truncateLinkDisplay
      ? formatTruncatedClickableUrl(track, { startChars: linkStartChars, endChars: linkEndChars })
      : getTrackDisplayUrl(track, { embeddable: embeddableLink }))
    : "";
  if (!artist && !link) {
    return "";
  }
  if (artist && link) {
    return `**Artist:** ${artist} (${link})`;
  }
  if (artist) {
    return `**Artist:** ${artist}`;
  }
  return `(${link})`;
}

function formatTrackLink(track, { embeddable = false } = {}) {
  return getTrackDisplayUrl(track, { embeddable });
}

function formatTrackSummary(track, { formatDuration, includeRequester = true, includeLink = false } = {}) {
  const primary = formatTrackPrimary(track, { formatDuration, includeRequester });
  const secondary = formatTrackSecondary(track, { includeArtist: false, includeLink });
  return secondary ? `${primary} | ${secondary}` : primary;
}

function formatQueuedMessage(track, position, formatDuration) {
  const summary = formatTrackPrimary(track, { formatDuration, includeRequester: true });
  const positionPart = Number.isFinite(position) && position > 0 ? ` | position ${position}` : "";
  return `**Queued:** ${summary}${positionPart}.`;
}

function formatQueuedPlaylistMessage(count, requester) {
  const safeRequester = escapeDiscordMarkdown(requester) || "unknown";
  return `**Queued:** ${count} tracks from playlist (requested by **${safeRequester}**).`;
}

function formatMovedMessage(track, destinationIndex) {
  const title = getTrackTitle(track);
  return `**Moved:** ${title} -> position ${destinationIndex}.`;
}

function formatRemovedMessage(track) {
  return `**Removed:** ${getTrackTitle(track)}.`;
}

function formatMovePrompt(track, page, totalPages) {
  return `**Move:** ${getTrackTitle(track)} to position (page ${page}/${totalPages}):`;
}

function formatQueueRemovedNotice(track, actorName = "") {
  const title = getTrackTitle(track);
  const actor = escapeDiscordMarkdown(actorName);
  if (actor) {
    return `${actor} removed ${title} from the queue.`;
  }
  return `Removed ${title} from the queue.`;
}

function formatQueueClearedNotice(removedCount, actorName = "") {
  const actor = escapeDiscordMarkdown(actorName);
  const countText = Number.isFinite(removedCount) && removedCount > 0 ? ` (${removedCount} removed)` : "";
  if (actor) {
    return `${actor} cleared the queue${countText}.`;
  }
  return `Cleared the queue${countText}.`;
}

module.exports = {
  formatMovePrompt,
  formatQueueClearedNotice,
  formatQueueRemovedNotice,
  formatMovedMessage,
  formatQueuedMessage,
  formatQueuedPlaylistMessage,
  formatRemovedMessage,
  formatTruncatedClickableUrl,
  formatTrackPrimary,
  formatTrackLink,
  formatTrackSecondary,
  formatTrackSummary,
};
