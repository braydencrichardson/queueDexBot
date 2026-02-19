const CONTROL_ACTIONS = Object.freeze({
  PAUSE: "pause",
  RESUME: "resume",
  SKIP: "skip",
  STOP: "stop",
  CLEAR: "clear",
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

function createQueueService(deps = {}) {
  const {
    stopAndLeaveQueue = () => {},
    maybeRefreshNowPlayingUpNext = async () => {},
    sendNowPlaying = async () => {},
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
    return createSuccess(CONTROL_ACTIONS.CLEAR, { removedCount });
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

  return {
    CONTROL_ACTIONS,
    pause,
    resume,
    skip,
    stop,
    clear,
    applyControlAction,
  };
}

module.exports = {
  CONTROL_ACTIONS,
  createQueueService,
};
