const { sanitizeInlineDiscordText } = require("../utils/discord-content");

const DEFAULT_QUEUE_EVENT_FEED_LIMIT = 20;
const MAX_QUEUE_EVENT_FEED_LIMIT = 60;
const MAX_QUEUE_EVENT_FEED_SIZE = 80;

let queueEventSequence = 0;

function toFiniteInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.trunc(numeric);
}

function normalizeQueueEventLimit(limit, fallback = DEFAULT_QUEUE_EVENT_FEED_LIMIT) {
  const parsed = toFiniteInteger(limit);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_QUEUE_EVENT_FEED_LIMIT, parsed));
}

function nextQueueEventId(now) {
  queueEventSequence = (queueEventSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${now}-${queueEventSequence}`;
}

function appendQueueEvent(queue, message, options = {}) {
  const trimmed = sanitizeInlineDiscordText(message);
  if (!queue || !trimmed) {
    return null;
  }

  if (!Array.isArray(queue.activityFeed)) {
    queue.activityFeed = [];
  }

  const now = Date.now();
  const level = String(options.level || "info").trim().toLowerCase() || "info";
  const source = String(options.source || "").trim() || null;
  const event = {
    id: nextQueueEventId(now),
    time: new Date(now).toISOString(),
    level,
    message: trimmed,
    source,
  };
  queue.activityFeed.push(event);

  if (queue.activityFeed.length > MAX_QUEUE_EVENT_FEED_SIZE) {
    const overflow = queue.activityFeed.length - MAX_QUEUE_EVENT_FEED_SIZE;
    queue.activityFeed.splice(0, overflow);
  }

  return event;
}

function listQueueEvents(queue, options = {}) {
  const feed = Array.isArray(queue?.activityFeed) ? queue.activityFeed : [];
  if (!feed.length) {
    return [];
  }
  const limit = normalizeQueueEventLimit(options.limit, DEFAULT_QUEUE_EVENT_FEED_LIMIT);
  return feed.slice(-limit);
}

module.exports = {
  DEFAULT_QUEUE_EVENT_FEED_LIMIT,
  MAX_QUEUE_EVENT_FEED_LIMIT,
  appendQueueEvent,
  listQueueEvents,
};
