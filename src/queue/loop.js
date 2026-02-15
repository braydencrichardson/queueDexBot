const { getTrackKey } = require("./track-key");

const LOOP_MODES = Object.freeze({
  OFF: "off",
  SINGLE: "single",
  QUEUE: "queue",
});

const LOOP_SINGLE_TRACK_TAG = "single";
const LOOP_QUEUE_TRACK_TAG = "queue";

function normalizeLoopMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  if (value === LOOP_MODES.SINGLE || value === LOOP_MODES.QUEUE) {
    return value;
  }
  return LOOP_MODES.OFF;
}

function getQueueLoopMode(queue) {
  return normalizeLoopMode(queue?.loopMode);
}

function isSingleLoopTrack(track) {
  return track?.loopTag === LOOP_SINGLE_TRACK_TAG;
}

function isQueueLoopTrack(track) {
  return track?.loopTag === LOOP_QUEUE_TRACK_TAG;
}

function isLoopTrack(track) {
  return isSingleLoopTrack(track) || isQueueLoopTrack(track);
}

function getLoopSourceTrackKey(track) {
  if (!track) {
    return null;
  }
  if (isLoopTrack(track) && track.loopSourceTrackKey) {
    return String(track.loopSourceTrackKey);
  }
  return getTrackKey(track);
}

function cloneTrack(track, ensureTrackId, { loopTag = null, loopSourceKey = null } = {}) {
  const clone = { ...track };
  delete clone.id;
  delete clone.loopTag;
  delete clone.loopSourceTrackKey;
  if (loopTag) {
    clone.loopTag = String(loopTag);
  }
  if (loopSourceKey) {
    clone.loopSourceTrackKey = String(loopSourceKey);
  }
  if (typeof ensureTrackId === "function") {
    ensureTrackId(clone);
  }
  return clone;
}

function removeLoopTracks(queue, { removeSingle = true, removeQueue = true } = {}) {
  if (!Array.isArray(queue?.tracks) || !queue.tracks.length) {
    return 0;
  }
  const before = queue.tracks.length;
  queue.tracks = queue.tracks.filter((track) => {
    if (removeSingle && isSingleLoopTrack(track)) {
      return false;
    }
    if (removeQueue && isQueueLoopTrack(track)) {
      return false;
    }
    return true;
  });
  return before - queue.tracks.length;
}

function syncSingleLoopTrack(queue, ensureTrackId) {
  if (!queue) {
    return { inserted: false, removed: 0 };
  }
  if (!Array.isArray(queue.tracks)) {
    queue.tracks = [];
  }

  const currentSourceKey = getLoopSourceTrackKey(queue.current);
  let keptFront = null;
  let removed = 0;
  const remaining = [];

  queue.tracks.forEach((track, index) => {
    if (isQueueLoopTrack(track)) {
      removed += 1;
      return;
    }
    if (!isSingleLoopTrack(track)) {
      remaining.push(track);
      return;
    }
    const isMatchingFront = index === 0
      && currentSourceKey
      && String(track.loopSourceTrackKey || "") === String(currentSourceKey);
    if (!keptFront && isMatchingFront) {
      keptFront = track;
      return;
    }
    removed += 1;
  });

  if (!currentSourceKey || !queue.current?.url) {
    if (keptFront) {
      removed += 1;
    }
    queue.tracks = remaining;
    return { inserted: false, removed };
  }

  if (keptFront) {
    queue.tracks = [keptFront, ...remaining];
    return { inserted: false, removed };
  }

  const loopedTrack = cloneTrack(queue.current, ensureTrackId, {
    loopTag: LOOP_SINGLE_TRACK_TAG,
    loopSourceKey: currentSourceKey,
  });
  queue.tracks = [loopedTrack, ...remaining];
  return { inserted: true, removed };
}

function syncLoopState(queue, ensureTrackId) {
  const mode = getQueueLoopMode(queue);
  if (mode === LOOP_MODES.SINGLE) {
    return syncSingleLoopTrack(queue, ensureTrackId);
  }
  if (mode === LOOP_MODES.QUEUE) {
    return {
      inserted: false,
      removed: removeLoopTracks(queue, { removeSingle: true, removeQueue: false }),
    };
  }
  return {
    inserted: false,
    removed: removeLoopTracks(queue, { removeSingle: true, removeQueue: true }),
  };
}

function setQueueLoopMode(queue, mode, ensureTrackId) {
  if (!queue) {
    return {
      previousMode: LOOP_MODES.OFF,
      mode: LOOP_MODES.OFF,
      changed: false,
      inserted: false,
      removed: 0,
    };
  }
  const previousMode = getQueueLoopMode(queue);
  const nextMode = normalizeLoopMode(mode);
  queue.loopMode = nextMode;
  const syncResult = syncLoopState(queue, ensureTrackId);
  return {
    previousMode,
    mode: nextMode,
    changed: previousMode !== nextMode,
    inserted: syncResult.inserted,
    removed: syncResult.removed,
  };
}

function prepareQueueForNextTrack(queue, ensureTrackId) {
  const mode = getQueueLoopMode(queue);
  if (mode === LOOP_MODES.SINGLE) {
    const syncResult = syncSingleLoopTrack(queue, ensureTrackId);
    return { mode, requeuedCurrent: false, ...syncResult };
  }

  const removed = removeLoopTracks(queue, { removeSingle: true, removeQueue: false });
  if (mode === LOOP_MODES.QUEUE && queue?.current?.url) {
    const sourceKey = getLoopSourceTrackKey(queue.current);
    const replayTrack = cloneTrack(queue.current, ensureTrackId, {
      loopTag: LOOP_QUEUE_TRACK_TAG,
      loopSourceKey: sourceKey,
    });
    if (!Array.isArray(queue.tracks)) {
      queue.tracks = [];
    }
    queue.tracks.push(replayTrack);
    return {
      mode,
      requeuedCurrent: true,
      inserted: false,
      removed,
    };
  }
  return {
    mode,
    requeuedCurrent: false,
    inserted: false,
    removed,
  };
}

function clearLoopState(queue) {
  if (!queue) {
    return 0;
  }
  queue.loopMode = LOOP_MODES.OFF;
  return removeLoopTracks(queue, { removeSingle: true, removeQueue: true });
}

module.exports = {
  LOOP_MODES,
  clearLoopState,
  getQueueLoopMode,
  prepareQueueForNextTrack,
  setQueueLoopMode,
  syncLoopState,
};
