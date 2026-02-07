const util = require("util");

function createDevLogger(deps) {
  const { client, devAlertChannelId, devLogChannelId } = deps;

  function formatLogMessage(stamp, message, data) {
    let line = `[${stamp}] ${message}`;
    if (data !== undefined) {
      let dataText = "";
      if (typeof data === "string") {
        dataText = data;
      } else {
        try {
          dataText = JSON.stringify(data);
        } catch {
          dataText = util.inspect(data, { depth: 2, breakLength: 80 });
        }
      }
      if (dataText) {
        line += ` ${dataText}`;
      }
    }
    return line;
  }

  async function sendDevAlert(message) {
    if (!devAlertChannelId || !client?.user) {
      return;
    }
    try {
      const channel = await client.channels.fetch(devAlertChannelId);
      if (!channel?.send) {
        return;
      }
      await channel.send(message);
    } catch (error) {
      console.log("Failed to send dev alert", error);
    }
  }

  async function sendDevLog(message) {
    if (!devLogChannelId || !client?.user) {
      return;
    }
    try {
      const channel = await client.channels.fetch(devLogChannelId);
      if (!channel?.send) {
        return;
      }
      const trimmed = String(message || "").slice(0, 1900);
      if (!trimmed) {
        return;
      }
      await channel.send(trimmed);
    } catch (error) {
      console.log("Failed to send dev log", error);
    }
  }

  function logInfo(message, data) {
    const stamp = new Date().toISOString();
    const line = formatLogMessage(stamp, message, data);
    if (data !== undefined) {
      console.log(`[${stamp}] ${message}`, data);
      void sendDevLog(line);
      return;
    }
    console.log(`[${stamp}] ${message}`);
    void sendDevLog(line);
  }

  function logError(message, error) {
    const stamp = new Date().toISOString();
    const line = formatLogMessage(stamp, message, error);
    if (error !== undefined) {
      console.error(`[${stamp}] ${message}`, error);
    } else {
      console.error(`[${stamp}] ${message}`);
    }
    void sendDevLog(line);
    void sendDevAlert(line);
  }

  return {
    logInfo,
    logError,
    sendDevAlert,
    sendDevLog,
  };
}

module.exports = {
  createDevLogger,
};
