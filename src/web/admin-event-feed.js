const LEVEL_VALUES = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

const REDACTED_VALUE = "[REDACTED]";
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_LIST_LIMIT = 100;

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|cookie|session|refresh|access)/i;

function normalizeLevel(rawLevel, fallback = "info") {
  const normalized = String(rawLevel || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVEL_VALUES, normalized)) {
    return normalized;
  }
  return fallback;
}

function redactString(value) {
  const text = String(value || "");
  if (!text) {
    return text;
  }
  if (/bearer\s+[a-z0-9._~-]+/i.test(text)) {
    return text.replace(/bearer\s+[a-z0-9._~-]+/gi, "Bearer [REDACTED]");
  }
  return text;
}

function redactPayload(value, key = "", depth = 0) {
  if (depth > 6) {
    return "[TRUNCATED]";
  }

  if (SENSITIVE_KEY_PATTERN.test(String(key || ""))) {
    return REDACTED_VALUE;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ""),
      stack: redactString(value.stack || ""),
      ...(value.code ? { code: value.code } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactPayload(entry, "", depth + 1));
  }

  if (typeof value === "object") {
    const redacted = {};
    Object.entries(value).forEach(([entryKey, entryValue]) => {
      redacted[entryKey] = redactPayload(entryValue, entryKey, depth + 1);
    });
    return redacted;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  return value;
}

function createAdminEventFeed(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const entries = [];
  let nextId = 1;

  function push(entry = {}) {
    const normalizedLevel = normalizeLevel(entry.level, "info");
    const normalized = {
      id: nextId++,
      time: entry.time || new Date().toISOString(),
      level: normalizedLevel,
      service: String(entry.service || "controller").trim() || "controller",
      message: String(entry.message || "").trim() || "(empty message)",
      data: entry.data === undefined ? undefined : redactPayload(entry.data),
    };

    entries.push(normalized);
    if (entries.length > maxEntries) {
      entries.splice(0, entries.length - maxEntries);
    }
    return normalized;
  }

  function list(options = {}) {
    const minimumLevel = normalizeLevel(options.minLevel, "info");
    const minimumLevelValue = LEVEL_VALUES[minimumLevel];
    const limitRaw = Number(options.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(500, limitRaw)
      : DEFAULT_LIST_LIMIT;

    const filtered = entries.filter((entry) => {
      const levelValue = LEVEL_VALUES[entry.level] || LEVEL_VALUES.info;
      return levelValue >= minimumLevelValue;
    });
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  function clear() {
    entries.length = 0;
  }

  return {
    push,
    list,
    clear,
    size: () => entries.length,
  };
}

module.exports = {
  createAdminEventFeed,
};
