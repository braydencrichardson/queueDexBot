function clearMapEntryWithTimeout(store, key) {
  const entry = store.get(key);
  if (!entry) {
    return null;
  }
  store.delete(key);
  if (entry.timeout) {
    clearTimeout(entry.timeout);
  }
  return entry;
}

function setExpiringMapEntry(options) {
  const {
    store,
    key,
    entry,
    timeoutMs,
    onExpire,
    logError,
    errorMessage = "Failed to expire pending interaction",
  } = options;

  const existing = store.get(key);
  if (existing?.timeout) {
    clearTimeout(existing.timeout);
  }

  const timeout = setTimeout(async () => {
    try {
      const current = store.get(key);
      if (!current) {
        return;
      }
      store.delete(key);
      if (typeof onExpire === "function") {
        await onExpire(current);
      }
    } catch (error) {
      if (typeof logError === "function") {
        logError(errorMessage, error);
      }
    }
  }, timeoutMs);

  const nextEntry = { ...entry, timeout };
  store.set(key, nextEntry);
  return nextEntry;
}

module.exports = {
  clearMapEntryWithTimeout,
  setExpiringMapEntry,
};
