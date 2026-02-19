function normalizeMs(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < min || rounded > max) {
    return fallback;
  }
  return rounded;
}

function normalizeShardId(shardId) {
  if (Number.isInteger(shardId) && shardId >= 0) {
    return String(shardId);
  }
  const normalized = String(shardId || "").trim();
  return normalized || "unknown";
}

function resolveShardKeys(client, shardId) {
  if (Number.isInteger(shardId) && shardId >= 0) {
    return [String(shardId)];
  }

  const shardCollection = client?.ws?.shards;
  if (shardCollection && typeof shardCollection.keys === "function" && shardCollection.size > 0) {
    return Array.from(shardCollection.keys())
      .filter((entry) => Number.isInteger(entry) && entry >= 0)
      .map((entry) => String(entry));
  }

  return ["unknown"];
}

function toErrorPayload(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || null,
    code: error.code || null,
  };
}

function createDiscordReconnectWatchdog(options) {
  const {
    client,
    logInfo = () => {},
    logError = () => {},
    relogin = async () => {},
    enabled = true,
    checkIntervalMs = 5000,
    disconnectThresholdMs = 20000,
    backoffBaseMs = 8000,
    backoffMaxMs = 120000,
    now = () => Date.now(),
  } = options || {};

  const safeEnabled = Boolean(enabled);
  const safeCheckIntervalMs = normalizeMs(checkIntervalMs, 5000, { min: 1000, max: 600000 });
  const safeDisconnectThresholdMs = normalizeMs(disconnectThresholdMs, 20000, { min: 1000, max: 900000 });
  const safeBackoffBaseMs = normalizeMs(backoffBaseMs, 8000, { min: 1000, max: 900000 });
  const safeBackoffMaxMs = normalizeMs(backoffMaxMs, 120000, { min: safeBackoffBaseMs, max: 3600000 });

  const disconnectedShards = new Map();
  const listeners = [];

  let timer = null;
  let started = false;
  let invalidated = false;
  let reloginInFlight = false;
  let reloginAttempts = 0;
  let nextReloginAt = 0;

  function computeBackoffDelayMs(attempt) {
    const safeAttempt = Math.max(1, Number.isFinite(attempt) ? Math.floor(attempt) : 1);
    const rawDelay = safeBackoffBaseMs * (2 ** Math.max(0, safeAttempt - 1));
    return Math.min(safeBackoffMaxMs, rawDelay);
  }

  function isClientReady() {
    if (typeof client?.isReady === "function") {
      return client.isReady();
    }
    return Boolean(client?.user);
  }

  function markShardDisconnected(shardId, context = {}) {
    const shardKeys = resolveShardKeys(client, shardId);
    const disconnectedAt = now();
    for (const key of shardKeys) {
      if (disconnectedShards.has(key)) {
        continue;
      }
      disconnectedShards.set(key, disconnectedAt);
      logInfo("Discord shard marked disconnected", {
        shardId: key,
        context,
      });
    }
  }

  function markShardHealthy(shardId) {
    const key = normalizeShardId(shardId);
    disconnectedShards.delete(key);
    if (key !== "unknown" && disconnectedShards.has("unknown")) {
      disconnectedShards.delete("unknown");
    }
  }

  function clearAllDisconnectedShards() {
    disconnectedShards.clear();
  }

  function resetReloginState() {
    reloginAttempts = 0;
    nextReloginAt = 0;
  }

  async function triggerRelogin(reason, shardIds) {
    if (reloginInFlight || invalidated || !safeEnabled) {
      return false;
    }
    const currentTime = now();
    if (currentTime < nextReloginAt) {
      return false;
    }

    reloginInFlight = true;
    reloginAttempts += 1;
    const retryDelayMs = computeBackoffDelayMs(reloginAttempts);
    nextReloginAt = currentTime + retryDelayMs;

    logError("Discord gateway watchdog forcing relogin", {
      reason,
      shardIds,
      ready: isClientReady(),
      attempt: reloginAttempts,
      retryDelayMs,
    });

    try {
      await relogin({
        reason,
        shardIds,
        attempt: reloginAttempts,
      });
      clearAllDisconnectedShards();
      resetReloginState();
      logInfo("Discord gateway watchdog relogin completed", {
        reason,
        shardIds,
      });
      return true;
    } catch (error) {
      logError("Discord gateway watchdog relogin failed", {
        reason,
        shardIds,
        attempt: reloginAttempts,
        retryDelayMs,
        error: toErrorPayload(error),
      });
      return false;
    } finally {
      reloginInFlight = false;
    }
  }

  function findStaleShardIds(currentTime) {
    const staleShardIds = [];
    for (const [shardId, disconnectedAt] of disconnectedShards.entries()) {
      if (currentTime - disconnectedAt >= safeDisconnectThresholdMs) {
        staleShardIds.push(shardId);
      }
    }
    return staleShardIds;
  }

  async function runCheck() {
    if (!safeEnabled || invalidated || reloginInFlight) {
      return false;
    }
    if (!disconnectedShards.size) {
      return false;
    }

    const currentTime = now();
    if (currentTime < nextReloginAt) {
      return false;
    }

    const staleShardIds = findStaleShardIds(currentTime);
    if (!staleShardIds.length) {
      return false;
    }

    return triggerRelogin("stale shard disconnect", staleShardIds);
  }

  function registerListener(eventName, handler) {
    client.on(eventName, handler);
    listeners.push({ eventName, handler });
  }

  function start() {
    if (started) {
      return;
    }
    started = true;

    if (!safeEnabled) {
      logInfo("Discord gateway reconnect watchdog disabled");
      return;
    }

    registerListener("clientReady", () => {
      clearAllDisconnectedShards();
      resetReloginState();
      invalidated = false;
    });

    registerListener("shardReady", (shardId) => {
      markShardHealthy(shardId);
      if (!disconnectedShards.size) {
        resetReloginState();
      }
    });

    registerListener("shardResume", (shardId) => {
      markShardHealthy(shardId);
      if (!disconnectedShards.size) {
        resetReloginState();
      }
    });

    registerListener("shardReconnecting", (shardId) => {
      markShardDisconnected(shardId, { event: "shardReconnecting" });
    });

    registerListener("shardDisconnect", (event, shardId) => {
      markShardDisconnected(shardId, {
        event: "shardDisconnect",
        code: event?.code ?? null,
        reason: event?.reason ?? null,
        wasClean: typeof event?.wasClean === "boolean" ? event.wasClean : null,
      });
    });

    registerListener("shardError", (error, shardId) => {
      markShardDisconnected(shardId, {
        event: "shardError",
        message: error?.message || null,
        code: error?.code || null,
      });
    });

    registerListener("invalidated", () => {
      invalidated = true;
      clearAllDisconnectedShards();
      logError("Discord session invalidated; reconnect watchdog halted until process restart.");
    });

    timer = setInterval(() => {
      runCheck().catch((error) => {
        logError("Discord gateway watchdog check failed", {
          error: toErrorPayload(error),
        });
      });
    }, safeCheckIntervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    logInfo("Discord gateway reconnect watchdog started", {
      checkIntervalMs: safeCheckIntervalMs,
      disconnectThresholdMs: safeDisconnectThresholdMs,
      backoffBaseMs: safeBackoffBaseMs,
      backoffMaxMs: safeBackoffMaxMs,
    });
  }

  function stop() {
    if (!started) {
      return;
    }
    started = false;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const listener of listeners) {
      client.off(listener.eventName, listener.handler);
    }
    listeners.length = 0;
    clearAllDisconnectedShards();
    reloginInFlight = false;
    resetReloginState();
    invalidated = false;
  }

  function getState() {
    return {
      enabled: safeEnabled,
      started,
      invalidated,
      reloginInFlight,
      reloginAttempts,
      nextReloginAt,
      disconnectedShardIds: Array.from(disconnectedShards.keys()),
      disconnectedShardCount: disconnectedShards.size,
    };
  }

  return {
    start,
    stop,
    runCheck,
    getState,
  };
}

module.exports = {
  createDiscordReconnectWatchdog,
};
