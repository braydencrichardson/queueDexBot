const { createButtonInteractionHandler } = require("./interaction-buttons");
const { createSelectMenuInteractionHandler } = require("./interaction-select-menus");
const { createCommandInteractionHandler } = require("./interaction-commands");

function registerInteractionHandler(client, deps) {
  const handleButtonInteraction = createButtonInteractionHandler(deps);
  const handleSelectMenuInteraction = createSelectMenuInteractionHandler(deps);
  const handleCommandInteraction = createCommandInteractionHandler(deps);

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    if (interaction.isSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
      return;
    }

    await handleCommandInteraction(interaction);
  });
}

module.exports = {
  registerInteractionHandler,
};
