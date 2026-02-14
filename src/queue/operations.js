function isValidQueuePosition(queue, position) {
  return Number.isFinite(position) && position >= 1 && position <= (queue?.tracks?.length || 0);
}

function shuffleQueuedTracks(queue) {
  if (!queue?.tracks || queue.tracks.length < 2) {
    return false;
  }
  for (let i = queue.tracks.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
  }
  return true;
}

function moveQueuedTrackToPosition(queue, fromPosition, toPosition) {
  if (!isValidQueuePosition(queue, fromPosition) || !isValidQueuePosition(queue, toPosition)) {
    return null;
  }
  const [moved] = queue.tracks.splice(fromPosition - 1, 1);
  queue.tracks.splice(toPosition - 1, 0, moved);
  return moved;
}

function moveQueuedTrackToFront(queue, position) {
  if (!isValidQueuePosition(queue, position)) {
    return null;
  }
  const [moved] = queue.tracks.splice(position - 1, 1);
  queue.tracks.unshift(moved);
  return moved;
}

function removeQueuedTrackAt(queue, position) {
  if (!isValidQueuePosition(queue, position)) {
    return null;
  }
  const [removed] = queue.tracks.splice(position - 1, 1);
  return removed;
}

module.exports = {
  isValidQueuePosition,
  moveQueuedTrackToFront,
  moveQueuedTrackToPosition,
  removeQueuedTrackAt,
  shuffleQueuedTracks,
};
