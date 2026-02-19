const {
  isValidQueuePosition,
  moveQueuedTrackToFront,
  moveQueuedTrackToPosition,
  removeQueuedTrackAt,
  shuffleQueuedTracks,
} = require("./operations");
const { setQueueLoopMode } = require("./loop");

const CONTROL_ACTIONS = Object.freeze({
  PAUSE: "pause",
  RESUME: "resume",
  SKIP: "skip",
  STOP: "stop",
  CLEAR: "clear",
});

const QUEUE_ACTIONS = Object.freeze({
  CLEAR: "clear",
  SHUFFLE: "shuffle",
  MOVE: "move",
  MOVE_TO_FRONT: "move_to_front",
  REMOVE: "remove",
  LOOP: "loop",
});

function createFailure(code, statusCode, error, data = {}) {
  return {
    ok: false,
    code,
    statusCode,
    error,
    ...data,
  };
}

function createSuccess(action, data = {}) {
  return {
    ok: true,
    action,
    ...data,
  };
}

function formatPositionRange(queue) {
  const max = Number.isFinite(queue?.tracks?.length) ? queue.tracks.length : 0;
  return `1-${Math.max(1, max)}`;
}

function createQueueService(deps = {}) {
  const {
    stopAndLeaveQueue = () => {},
    maybeRefreshNowPlayingUpNext = async () => {},
    sendNowPlaying = async () => {},
    ensureTrackId = null,
  } = deps;

  async function pause(queue, options = {}) {
    const { refreshNowPlaying = false } = options;
    if (!queue?.current) {
      return createFailure("NOTHING_PLAYING", 409, "Nothing is playing.");
    }
    queue.player.pause();
    if (refreshNowPlaying) {
      await sendNowPlaying(queue, false);
    }
    return createSuccess(CONTROL_ACTIONS.PAUSE);
  }

  async function resume(queue, options = {}) {
    const { refreshNowPlaying = false } = options;
    if (!queue?.current) {
      return createFailure("NOTHING_PLAYING", 409, "Nothing is playing.");
    }
    queue.player.unpause();
    if (refreshNowPlaying) {
      await sendNowPlaying(queue, false);
    }
    return createSuccess(CONTROL_ACTIONS.RESUME);
  }

  async function skip(queue) {
    if (!queue?.current) {
      return createFailure("NOTHING_PLAYING", 409, "Nothing is playing.");
    }
    queue.player.stop(true);
    return createSuccess(CONTROL_ACTIONS.SKIP);
  }

  async function stop(queue, options = {}) {
    const { reason = "Stopping playback and clearing queue" } = options;
    stopAndLeaveQueue(queue, reason);
    return createSuccess(CONTROL_ACTIONS.STOP);
  }

  async function clear(queue, options = {}) {
    const { refreshNowPlayingUpNext = false } = options;
    const removedCount = Array.isArray(queue?.tracks) ? queue.tracks.length : 0;
    if (queue) {
      queue.tracks = [];
    }
    if (refreshNowPlayingUpNext) {
      await maybeRefreshNowPlayingUpNext(queue);
    }
    return createSuccess(QUEUE_ACTIONS.CLEAR, { removedCount });
  }

  async function shuffle(queue, options = {}) {
    const { refreshNowPlayingUpNext = false } = options;
    if (!Array.isArray(queue?.tracks) || queue.tracks.length < 2) {
      return createFailure("INSUFFICIENT_TRACKS", 409, "Need at least two queued tracks to shuffle.");
    }

    const changed = shuffleQueuedTracks(queue);
    if (!changed) {
      return createFailure("INSUFFICIENT_TRACKS", 409, "Need at least two queued tracks to shuffle.");
    }

    if (refreshNowPlayingUpNext) {
      await maybeRefreshNowPlayingUpNext(queue);
    }
    return createSuccess(QUEUE_ACTIONS.SHUFFLE);
  }

  async function removeAt(queue, position, options = {}) {
    const { refreshNowPlayingUpNext = false } = options;
    if (!isValidQueuePosition(queue, position)) {
      return createFailure(
        "INVALID_POSITION",
        400,
        `Invalid queue position. Choose ${formatPositionRange(queue)}.`,
        { position }
      );
    }

    const removed = removeQueuedTrackAt(queue, position);
    if (!removed) {
      return createFailure("INVALID_POSITION", 400, "Track does not exist at that position.", { position });
    }

    if (refreshNowPlayingUpNext) {
      await maybeRefreshNowPlayingUpNext(queue);
    }
    return createSuccess(QUEUE_ACTIONS.REMOVE, { removed, position });
  }

  async function move(queue, fromPosition, toPosition, options = {}) {
    const { refreshNowPlayingUpNext = false } = options;
    if (!isValidQueuePosition(queue, fromPosition) || !isValidQueuePosition(queue, toPosition)) {
      return createFailure(
        "INVALID_POSITION",
        400,
        `Invalid queue positions. Choose ${formatPositionRange(queue)}.`,
        { fromPosition, toPosition }
      );
    }

    const moved = moveQueuedTrackToPosition(queue, fromPosition, toPosition);
    if (!moved) {
      return createFailure("INVALID_POSITION", 400, "Track move failed.", { fromPosition, toPosition });
    }

    if (refreshNowPlayingUpNext) {
      await maybeRefreshNowPlayingUpNext(queue);
    }
    return createSuccess(QUEUE_ACTIONS.MOVE, {
      moved,
      fromPosition,
      toPosition,
    });
  }

  async function moveToFront(queue, position, options = {}) {
    const { refreshNowPlayingUpNext = false } = options;
    if (!isValidQueuePosition(queue, position)) {
      return createFailure(
        "INVALID_POSITION",
        400,
        `Invalid queue position. Choose ${formatPositionRange(queue)}.`,
        { position }
      );
    }

    const moved = moveQueuedTrackToFront(queue, position);
    if (!moved) {
      return createFailure("INVALID_POSITION", 400, "Track move failed.", { position });
    }

    if (refreshNowPlayingUpNext) {
      await maybeRefreshNowPlayingUpNext(queue);
    }
    return createSuccess(QUEUE_ACTIONS.MOVE_TO_FRONT, {
      moved,
      toPosition: 1,
      fromPosition: position,
    });
  }

  async function setLoopMode(queue, mode, options = {}) {
    const {
      refreshNowPlayingUpNext = false,
      refreshNowPlaying = false,
      ensureTrackId: ensureTrackIdOverride,
    } = options;
    const ensureTrackIdFn = ensureTrackIdOverride || ensureTrackId;

    const loopResult = setQueueLoopMode(queue, mode, ensureTrackIdFn);
    if (refreshNowPlayingUpNext) {
      await maybeRefreshNowPlayingUpNext(queue);
    }
    if (refreshNowPlaying) {
      await sendNowPlaying(queue, false);
    }
    return createSuccess(QUEUE_ACTIONS.LOOP, { loopResult });
  }

  async function applyControlAction(queue, action, options = {}) {
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!normalizedAction) {
      return createFailure("MISSING_ACTION", 400, "Missing action");
    }

    if (normalizedAction === CONTROL_ACTIONS.PAUSE) {
      return pause(queue, {
        refreshNowPlaying: Boolean(options.refreshNowPlayingOnPauseResume),
      });
    }
    if (normalizedAction === CONTROL_ACTIONS.RESUME) {
      return resume(queue, {
        refreshNowPlaying: Boolean(options.refreshNowPlayingOnPauseResume),
      });
    }
    if (normalizedAction === CONTROL_ACTIONS.SKIP) {
      return skip(queue);
    }
    if (normalizedAction === CONTROL_ACTIONS.STOP) {
      return stop(queue, {
        reason: options.stopReason,
      });
    }
    if (normalizedAction === CONTROL_ACTIONS.CLEAR) {
      return clear(queue, {
        refreshNowPlayingUpNext: Boolean(options.refreshNowPlayingUpNextOnClear),
      });
    }

    return createFailure(
      "UNSUPPORTED_ACTION",
      400,
      `Unsupported action: ${normalizedAction}`,
      { action: normalizedAction }
    );
  }

  async function applyQueueAction(queue, action, options = {}) {
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!normalizedAction) {
      return createFailure("MISSING_ACTION", 400, "Missing action");
    }

    if (normalizedAction === QUEUE_ACTIONS.CLEAR) {
      return clear(queue, {
        refreshNowPlayingUpNext: Boolean(options.refreshNowPlayingUpNextOnClear),
      });
    }
    if (normalizedAction === QUEUE_ACTIONS.SHUFFLE) {
      return shuffle(queue, {
        refreshNowPlayingUpNext: Boolean(options.refreshNowPlayingUpNextOnShuffle),
      });
    }
    if (normalizedAction === QUEUE_ACTIONS.MOVE) {
      return move(queue, options.fromPosition, options.toPosition, {
        refreshNowPlayingUpNext: Boolean(options.refreshNowPlayingUpNextOnMove),
      });
    }
    if (normalizedAction === QUEUE_ACTIONS.MOVE_TO_FRONT) {
      return moveToFront(queue, options.position, {
        refreshNowPlayingUpNext: Boolean(options.refreshNowPlayingUpNextOnMove),
      });
    }
    if (normalizedAction === QUEUE_ACTIONS.REMOVE) {
      return removeAt(queue, options.position, {
        refreshNowPlayingUpNext: Boolean(options.refreshNowPlayingUpNextOnRemove),
      });
    }
    if (normalizedAction === QUEUE_ACTIONS.LOOP) {
      return setLoopMode(queue, options.mode, {
        ensureTrackId: options.ensureTrackId,
        refreshNowPlayingUpNext: Boolean(options.refreshNowPlayingUpNextOnLoop),
        refreshNowPlaying: Boolean(options.refreshNowPlayingOnLoop),
      });
    }

    return createFailure(
      "UNSUPPORTED_ACTION",
      400,
      `Unsupported action: ${normalizedAction}`,
      { action: normalizedAction }
    );
  }

  return {
    CONTROL_ACTIONS,
    QUEUE_ACTIONS,
    pause,
    resume,
    skip,
    stop,
    clear,
    shuffle,
    removeAt,
    move,
    moveToFront,
    setLoopMode,
    applyControlAction,
    applyQueueAction,
  };
}

module.exports = {
  CONTROL_ACTIONS,
  QUEUE_ACTIONS,
  createQueueService,
};
