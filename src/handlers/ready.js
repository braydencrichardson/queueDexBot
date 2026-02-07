function registerReadyHandler(client, deps) {
  const { logInfo, logError, onReady, presence } = deps;

  function normalizeActivityType(value) {
    const allowed = new Set(["PLAYING", "STREAMING", "LISTENING", "WATCHING", "COMPETING"]);
    const normalized = String(value || "").toUpperCase();
    if (allowed.has(normalized)) {
      return normalized;
    }
    return "LISTENING";
  }

  client.on("ready", () => {
    logInfo(`Logged in as ${client.user.tag}`);
    if (client.user?.setPresence && presence) {
      try {
        const status = "online";
        const activityName = String(presence.activityName || "").trim();
        const payload = {
          status,
        };
        if (activityName) {
          payload.activities = [
            {
              name: activityName,
              type: normalizeActivityType(presence.activityType),
            },
          ];
        }
        client.user.setPresence(payload);
        logInfo("Presence initialized", {
          status: payload.status,
          activity: payload.activities?.[0] || null,
        });
      } catch (error) {
        if (typeof logError === "function") {
          logError("Failed to set bot presence", error);
        } else {
          console.error("Failed to set bot presence", error);
        }
      }
    }
    if (typeof onReady === "function") {
      Promise.resolve(onReady()).catch((error) => {
        if (typeof logError === "function") {
          logError("Ready hook failed", error);
          return;
        }
        console.error("Ready hook failed", error);
      });
    }
  });
}

module.exports = {
  registerReadyHandler,
};
