const { createButtonInteractionHandler } = require("./interaction-buttons");
const { createSelectMenuInteractionHandler } = require("./interaction-select-menus");
const { createCommandInteractionHandler } = require("./interaction-commands");
const { sanitizeDiscordText } = require("../utils/discord-content");

async function replyWithInteractionError(interaction) {
  const payload = {
    content: sanitizeDiscordText("Something went wrong while processing that interaction."),
    ephemeral: true,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.followUp === "function") {
        await interaction.followUp(payload);
      }
      return;
    }
    if (typeof interaction.reply === "function") {
      await interaction.reply(payload);
    }
  } catch {
    // Avoid throwing from the error path.
  }
}

function registerInteractionHandler(client, deps) {
  const { logError } = deps;
  const handleButtonInteraction = createButtonInteractionHandler(deps);
  const handleSelectMenuInteraction = createSelectMenuInteractionHandler(deps);
  const handleCommandInteraction = createCommandInteractionHandler(deps);

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
        return;
      }

      if (interaction.isSelectMenu()) {
        await handleSelectMenuInteraction(interaction);
        return;
      }

      await handleCommandInteraction(interaction);
    } catch (error) {
      if (typeof logError === "function") {
        logError("Unhandled interaction handler error", error);
      } else {
        console.error("Unhandled interaction handler error", error);
      }
      await replyWithInteractionError(interaction);
    }
  });
}

module.exports = {
  registerInteractionHandler,
};
