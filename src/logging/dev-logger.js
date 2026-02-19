const fs = require("node:fs");
const path = require("node:path");
const util = require("util");
const {
  DEV_LOG_INSPECT_BREAK_LENGTH,
  DEV_LOG_INSPECT_DEPTH,
  DISCORD_MESSAGE_SAFE_MAX_LENGTH,
} = require("../config/constants");

const LOG_LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_DISCORD_LOG_LEVEL = "info";
const DEFAULT_DISCORD_ALERT_LEVEL = "error";
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;

function normalizeLevel(rawLevel, fallback = DEFAULT_LOG_LEVEL) {
  const normalized = String(rawLevel || "")
    .trim()
    .toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizePayload(payload) {
  if (payload instanceof Error) {
    return {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      ...(payload.code ? { code: payload.code } : {}),
    };
  }
  return payload;
}

function stringifyData(data) {
  if (data === undefined) {
    return "";
  }
  if (typeof data === "string") {
    return data;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return util.inspect(data, {
      depth: DEV_LOG_INSPECT_DEPTH,
      breakLength: DEV_LOG_INSPECT_BREAK_LENGTH,
    });
  }
}

function createRollingFileWriter({ filePath, maxSizeBytes, maxFiles, onError }) {
  const safeMaxSizeBytes = Number.isFinite(maxSizeBytes) && maxSizeBytes > 0
    ? Math.floor(maxSizeBytes)
    : DEFAULT_MAX_FILE_SIZE_BYTES;
  const safeMaxFiles = Number.isInteger(maxFiles) && maxFiles >= 0
    ? maxFiles
    : DEFAULT_MAX_FILES;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function rotateIfNeeded(incomingBytes) {
    let currentSize = 0;
    try {
      currentSize = fs.statSync(filePath).size;
    } catch {
      currentSize = 0;
    }

    if (currentSize + incomingBytes <= safeMaxSizeBytes) {
      return;
    }

    try {
      for (let index = safeMaxFiles; index >= 1; index -= 1) {
        const source = `${filePath}.${index}`;
        const destination = `${filePath}.${index + 1}`;
        if (fs.existsSync(source)) {
          if (index === safeMaxFiles) {
            fs.rmSync(source, { force: true });
          } else {
            fs.renameSync(source, destination);
          }
        }
      }

      if (fs.existsSync(filePath)) {
        if (safeMaxFiles >= 1) {
          fs.renameSync(filePath, `${filePath}.1`);
        } else {
          fs.rmSync(filePath, { force: true });
        }
      }
    } catch (error) {
      if (typeof onError === "function") {
        onError("Failed rotating log file", { filePath, error });
      }
    }
  }

  return {
    write(line) {
      const output = `${line}\n`;
      const incomingBytes = Buffer.byteLength(output, "utf8");

      rotateIfNeeded(incomingBytes);
      try {
        fs.appendFileSync(filePath, output, "utf8");
      } catch (error) {
        if (typeof onError === "function") {
          onError("Failed writing log file", { filePath, error });
        }
      }
    },
  };
}

function formatConsoleLine(entry) {
  const head = `[${entry.time}] [${entry.service}] [${entry.level}] ${entry.message}`;
  const data = stringifyData(entry.data);
  return data ? `${head} ${data}` : head;
}

function formatDiscordLine(entry) {
  const head = `[${entry.time}] [${entry.service}] [${entry.level}] ${entry.message}`;
  const data = stringifyData(entry.data);
  const line = data ? `${head} ${data}` : head;
  return String(line).slice(0, DISCORD_MESSAGE_SAFE_MAX_LENGTH);
}

function hasDiscordRestToken(client) {
  const restToken = client?.rest?.token;
  if (typeof restToken === "string") {
    return restToken.trim().length > 0;
  }
  return Boolean(restToken);
}

function isMissingDiscordTokenError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("expected token to be set for this request, but none was present");
}

function createDevLogger(deps) {
  const {
    client,
    canSendDiscordMessages = null,
    devAlertChannelId,
    devLogChannelId,
    level = DEFAULT_LOG_LEVEL,
    service = "controller",
    pretty = true,
    logDir = "logs",
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    discordLogLevel = DEFAULT_DISCORD_LOG_LEVEL,
    discordAlertLevel = DEFAULT_DISCORD_ALERT_LEVEL,
  } = deps || {};

  const normalizedService = String(service || "controller").trim() || "controller";
  const minimumLevelName = normalizeLevel(level, DEFAULT_LOG_LEVEL);
  const minimumLevelValue = LOG_LEVELS[minimumLevelName];
  const discordLogLevelValue = LOG_LEVELS[normalizeLevel(discordLogLevel, DEFAULT_DISCORD_LOG_LEVEL)];
  const discordAlertLevelValue = LOG_LEVELS[normalizeLevel(discordAlertLevel, DEFAULT_DISCORD_ALERT_LEVEL)];
  const safeLogDir = path.join(path.resolve(String(logDir || "logs")), normalizedService);

  const appWriter = createRollingFileWriter({
    filePath: path.join(safeLogDir, "app.log"),
    maxSizeBytes: maxFileSizeBytes,
    maxFiles,
    onError: (message, data) => {
      console.error(message, data);
    },
  });

  const errorWriter = createRollingFileWriter({
    filePath: path.join(safeLogDir, "error.log"),
    maxSizeBytes: maxFileSizeBytes,
    maxFiles,
    onError: (message, data) => {
      console.error(message, data);
    },
  });

  const channelCache = new Map();

  function canSendDiscordMessagesNow() {
    if (typeof canSendDiscordMessages === "function") {
      return Boolean(canSendDiscordMessages());
    }
    if (!client || !hasDiscordRestToken(client)) {
      return false;
    }
    if (typeof client.isReady === "function" && !client.isReady()) {
      return false;
    }
    return Boolean(client.user?.id);
  }

  async function resolveChannel(channelId) {
    const normalizedId = String(channelId || "").trim();
    if (!normalizedId || !canSendDiscordMessagesNow() || !client?.channels?.fetch) {
      return null;
    }

    const cached = channelCache.get(normalizedId);
    if (cached?.send) {
      return cached;
    }

    try {
      const channel = await client.channels.fetch(normalizedId);
      if (channel?.send) {
        channelCache.set(normalizedId, channel);
        return channel;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function sendDiscordLine(channelId, line) {
    const trimmed = String(line || "").slice(0, DISCORD_MESSAGE_SAFE_MAX_LENGTH);
    if (!trimmed) {
      return;
    }
    if (!canSendDiscordMessagesNow()) {
      return;
    }

    const channel = await resolveChannel(channelId);
    if (!channel) {
      return;
    }

    try {
      await channel.send(trimmed);
    } catch (error) {
      if (isMissingDiscordTokenError(error)) {
        return;
      }
      console.error("Failed to send Discord log line", { channelId, error });
    }
  }

  async function sendEntryToDiscord(entry) {
    const levelValue = LOG_LEVELS[entry.level] || LOG_LEVELS.info;
    const line = formatDiscordLine(entry);
    if (levelValue >= discordLogLevelValue) {
      await sendDiscordLine(devLogChannelId, line);
    }
    if (levelValue >= discordAlertLevelValue) {
      await sendDiscordLine(devAlertChannelId, line);
    }
  }

  function writeEntry(levelName, message, data) {
    const normalizedLevel = normalizeLevel(levelName, DEFAULT_LOG_LEVEL);
    const levelValue = LOG_LEVELS[normalizedLevel];
    if (levelValue < minimumLevelValue) {
      return;
    }

    const entry = {
      time: new Date().toISOString(),
      level: normalizedLevel,
      service: normalizedService,
      pid: process.pid,
      message: String(message || "").trim() || "(empty message)",
      data: data === undefined ? undefined : normalizePayload(data),
    };

    const jsonLine = JSON.stringify(entry);
    appWriter.write(jsonLine);
    if (levelValue >= LOG_LEVELS.error) {
      errorWriter.write(jsonLine);
    }

    if (pretty) {
      const line = formatConsoleLine(entry);
      if (levelValue >= LOG_LEVELS.error) {
        console.error(line);
      } else {
        console.log(line);
      }
    } else if (levelValue >= LOG_LEVELS.error) {
      console.error(jsonLine);
    } else {
      console.log(jsonLine);
    }

    void sendEntryToDiscord(entry);
  }

  function logTrace(message, data) {
    writeEntry("trace", message, data);
  }

  function logDebug(message, data) {
    writeEntry("debug", message, data);
  }

  function logInfo(message, data) {
    writeEntry("info", message, data);
  }

  function logWarn(message, data) {
    writeEntry("warn", message, data);
  }

  function logError(message, error) {
    writeEntry("error", message, error);
  }

  async function sendDevAlert(message) {
    await sendDiscordLine(devAlertChannelId, message);
  }

  async function sendDevLog(message) {
    await sendDiscordLine(devLogChannelId, message);
  }

  return {
    logTrace,
    logDebug,
    logInfo,
    logWarn,
    logError,
    sendDevAlert,
    sendDevLog,
  };
}

module.exports = {
  createDevLogger,
};
