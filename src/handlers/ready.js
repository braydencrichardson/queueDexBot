function registerReadyHandler(client, deps) {
  const { logInfo, logError, onReady } = deps;

  client.on("ready", () => {
    logInfo(`Logged in as ${client.user.tag}`);
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
