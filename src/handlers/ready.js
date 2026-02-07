function registerReadyHandler(client, deps) {
  const { logInfo } = deps;

  client.on("ready", () => {
    logInfo(`Logged in as ${client.user.tag}`);
  });
}

module.exports = {
  registerReadyHandler,
};
