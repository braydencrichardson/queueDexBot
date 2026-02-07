let nextTrackId = 1;
const { sanitizeTrackForDiscord } = require("../utils/discord-content");

function enqueueTracks(queue, tracks) {
  if (!tracks?.length) {
    return;
  }
  tracks.forEach(ensureTrackId);
  queue.tracks.push(...tracks);
}

function ensureTrackId(track) {
  if (!track) {
    return;
  }
  sanitizeTrackForDiscord(track);
  if (!track.id) {
    track.id = `t_${Date.now()}_${nextTrackId++}`;
  }
}

function getTrackIndexById(queue, trackId) {
  if (!queue?.tracks?.length || !trackId) {
    return -1;
  }
  return queue.tracks.findIndex((entry) => entry?.id === trackId);
}

function getQueuedTrackIndex(queue, track) {
  if (!queue?.tracks?.length || !track) {
    return -1;
  }
  if (track.id) {
    return getTrackIndexById(queue, track.id);
  }
  return queue.tracks.findIndex((entry) =>
    entry?.url === track.url && entry?.title === track.title && entry?.requester === track.requester
  );
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds <= 0) {
    return "";
  }
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

module.exports = {
  enqueueTracks,
  ensureTrackId,
  getTrackIndexById,
  getQueuedTrackIndex,
  formatDuration,
};
