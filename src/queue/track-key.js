function getTrackKey(track) {
  if (!track) {
    return null;
  }
  return String(track.id || `${track.url || ""}|${track.title || ""}|${track.requester || ""}`);
}

module.exports = {
  getTrackKey,
};
