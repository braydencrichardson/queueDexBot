const { escapeDiscordMarkdown, sanitizeInlineDiscordText } = require("../utils/discord-content");
const {
  formatMovedMessage,
  formatQueueClearedNotice,
  formatQueueRemovedNotice,
} = require("../ui/messages");

function isMissingDiscordTokenError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("expected token to be set for this request, but none was present");
}

function getSessionActorName(sessionUser) {
  const raw = sanitizeInlineDiscordText(
    sessionUser?.globalName
    || sessionUser?.global_name
    || sessionUser?.username
    || sessionUser?.id
    || "Someone"
  );
  return raw || "Someone";
}

function resolveActorName(context = {}, { includeFallback = true } = {}) {
  const raw = sanitizeInlineDiscordText(
    context?.actorName
    || context?.member?.displayName
    || context?.member?.nickname
    || context?.user?.globalName
    || context?.user?.global_name
    || context?.user?.username
    || context?.user?.tag
    || context?.sessionUser?.globalName
    || context?.sessionUser?.global_name
    || context?.sessionUser?.username
    || context?.sessionUser?.id
    || ""
  );
  if (raw) {
    return raw;
  }
  return includeFallback ? "Someone" : "";
}

function formatTrackTitle(track) {
  return escapeDiscordMarkdown(track?.title || "unknown track");
}

function formatNowPlayingActionNotice(actorName, actionText) {
  const actor = escapeDiscordMarkdown(actorName || "Someone");
  return `**${actor}** ${actionText}.`;
}

function buildControlActionFeedback(action, context = {}, options = {}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const style = String(options?.style || "announcement").trim().toLowerCase();
  const actorName = resolveActorName(context, { includeFallback: true });
  const removedCount = Number.isFinite(context?.result?.removedCount) ? context.result.removedCount : 0;

  if (style === "reply") {
    if (normalizedAction === "pause") {
      return "Paused.";
    }
    if (normalizedAction === "resume") {
      return "Resumed.";
    }
    if (normalizedAction === "skip") {
      return "Skipped.";
    }
    if (normalizedAction === "stop") {
      return "Stopped and cleared the queue.";
    }
    if (normalizedAction === "clear") {
      return formatQueueClearedNotice(removedCount);
    }
    return "";
  }

  if (normalizedAction === "pause") {
    return formatNowPlayingActionNotice(actorName, "paused playback");
  }
  if (normalizedAction === "resume") {
    return formatNowPlayingActionNotice(actorName, "resumed playback");
  }
  if (normalizedAction === "skip") {
    return formatNowPlayingActionNotice(actorName, "skipped the track");
  }
  if (normalizedAction === "stop") {
    return formatNowPlayingActionNotice(actorName, "stopped playback and cleared the queue");
  }
  if (normalizedAction === "clear") {
    return formatQueueClearedNotice(removedCount, actorName);
  }
  return "";
}

function buildQueueActionFeedback(action, context = {}, options = {}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const style = String(options?.style || "announcement").trim().toLowerCase();
  const includeActor = options?.includeActor !== false && style !== "reply";
  const actorName = resolveActorName(context, { includeFallback: includeActor });
  const result = context?.result || {};

  if (style === "reply") {
    if (normalizedAction === "clear") {
      const removedCount = Number.isFinite(result.removedCount) ? result.removedCount : 0;
      return formatQueueClearedNotice(removedCount);
    }
    if (normalizedAction === "remove" && result.removed) {
      return formatQueueRemovedNotice(result.removed);
    }
    if (normalizedAction === "move" && result.moved) {
      const target = Number.isFinite(result.toPosition) ? result.toPosition : "?";
      return formatMovedMessage(result.moved, target);
    }
    if (normalizedAction === "move_to_front" && result.moved) {
      return formatMovedMessage(result.moved, 1);
    }
    if (normalizedAction === "shuffle") {
      return "Shuffled the queue.";
    }
    if (normalizedAction === "loop" && result.loopResult) {
      const mode = escapeDiscordMarkdown(result.loopResult.mode || "off");
      return `Loop mode set to **${mode}**.`;
    }
    return "";
  }

  if (normalizedAction === "clear") {
    const removedCount = Number.isFinite(result.removedCount) ? result.removedCount : 0;
    return formatQueueClearedNotice(removedCount, actorName);
  }
  if (normalizedAction === "remove" && result.removed) {
    return formatQueueRemovedNotice(result.removed, actorName);
  }
  if (normalizedAction === "move" && result.moved) {
    const target = Number.isFinite(result.toPosition) ? result.toPosition : "?";
    if (actorName) {
      return `${escapeDiscordMarkdown(actorName)} moved ${formatTrackTitle(result.moved)} to position ${target}.`;
    }
    return `Moved ${formatTrackTitle(result.moved)} to position ${target}.`;
  }
  if (normalizedAction === "move_to_front" && result.moved) {
    if (actorName) {
      return `${escapeDiscordMarkdown(actorName)} moved ${formatTrackTitle(result.moved)} to position 1.`;
    }
    return `Moved ${formatTrackTitle(result.moved)} to position 1.`;
  }
  if (normalizedAction === "shuffle") {
    if (actorName) {
      return `${escapeDiscordMarkdown(actorName)} shuffled the queue.`;
    }
    return "Shuffled the queue.";
  }
  if (normalizedAction === "loop" && result.loopResult) {
    const mode = escapeDiscordMarkdown(result.loopResult.mode || "off");
    if (actorName) {
      return formatNowPlayingActionNotice(actorName, `set loop mode to **${mode}**`);
    }
    return `Loop mode set to **${mode}**.`;
  }
  return "";
}

async function sendQueueFeedback({
  queue,
  channel,
  content,
  logInfo = () => {},
  logError = () => {},
  context = "queue_feedback",
}) {
  const trimmed = sanitizeInlineDiscordText(content);
  if (!trimmed) {
    return false;
  }
  const targetChannel = channel || queue?.textChannel;
  if (!targetChannel?.send) {
    return false;
  }
  try {
    await targetChannel.send(trimmed);
    return true;
  } catch (error) {
    if (isMissingDiscordTokenError(error)) {
      logInfo("Skipping queue feedback send while Discord messaging is unavailable", { context });
      return false;
    }
    logError("Failed to send queue feedback", { context, error });
    return false;
  }
}

module.exports = {
  buildControlActionFeedback,
  buildQueueActionFeedback,
  getSessionActorName,
  resolveActorName,
  isMissingDiscordTokenError,
  sendQueueFeedback,
};
