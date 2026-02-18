const dotenv = require("dotenv");
const { REST, Routes } = require("discord.js");
const { commands } = require("./src/commands");

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.APPLICATION_ID;
const guildId = process.env.GUILD_ID;
const args = new Set(process.argv.slice(2));
const forceGlobal = args.has("--global");
const forceGuild = args.has("--guild");
const envDeployTarget = String(process.env.DEPLOY_COMMANDS_TARGET || "").trim().toLowerCase();

if (!token) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

if (!applicationId) {
  console.error("Missing APPLICATION_ID in environment.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

const ENTRY_POINT_COMMAND_TYPE = 4;

function sanitizeForBulkOverwrite(command) {
  const allowedKeys = [
    "id",
    "type",
    "name",
    "name_localizations",
    "description",
    "description_localizations",
    "options",
    "default_member_permissions",
    "dm_permission",
    "default_permission",
    "nsfw",
    "integration_types",
    "contexts",
    "handler",
  ];
  const sanitized = {};
  allowedKeys.forEach((key) => {
    if (command[key] !== undefined) {
      sanitized[key] = command[key];
    }
  });
  return sanitized;
}

function withPreservedEntryPoint(localCommands, existingCommands) {
  const localHasEntryPoint = localCommands.some((command) => Number(command?.type) === ENTRY_POINT_COMMAND_TYPE);
  if (localHasEntryPoint) {
    return localCommands;
  }

  const existingEntryPoints = (Array.isArray(existingCommands) ? existingCommands : [])
    .filter((command) => Number(command?.type) === ENTRY_POINT_COMMAND_TYPE)
    .map((command) => sanitizeForBulkOverwrite(command));

  if (!existingEntryPoints.length) {
    return localCommands;
  }

  return [...localCommands, ...existingEntryPoints];
}

async function deploy() {
  try {
    if (forceGlobal && forceGuild) {
      console.error("Choose either --global or --guild, not both.");
      process.exit(1);
    }

    if (envDeployTarget && envDeployTarget !== "global" && envDeployTarget !== "guild") {
      console.error('Invalid DEPLOY_COMMANDS_TARGET. Use "global" or "guild".');
      process.exit(1);
    }

    let deployTarget = "global";
    if (forceGlobal) {
      deployTarget = "global";
    } else if (forceGuild) {
      deployTarget = "guild";
    } else if (envDeployTarget) {
      deployTarget = envDeployTarget;
    }

    if (deployTarget === "guild" && !guildId) {
      console.error("Missing GUILD_ID in environment for --guild deployment.");
      process.exit(1);
    }

    if (deployTarget === "guild") {
      const existingGuildCommands = await rest.get(Routes.applicationGuildCommands(applicationId, guildId));
      const payload = withPreservedEntryPoint(commands, existingGuildCommands);
      const preserved = payload.length - commands.length;
      console.log(
        `Deploying ${payload.length} command(s): ${payload.map((command) => `/${command.name}`).join(", ")}`
      );
      if (preserved > 0) {
        console.log(`Preserving ${preserved} existing Entry Point command(s) from guild scope.`);
      }
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: payload });
      console.log(`Registered commands for guild ${guildId}.`);
    } else {
      const existingGlobalCommands = await rest.get(Routes.applicationCommands(applicationId));
      const payload = withPreservedEntryPoint(commands, existingGlobalCommands);
      const preserved = payload.length - commands.length;
      console.log(
        `Deploying ${payload.length} command(s): ${payload.map((command) => `/${command.name}`).join(", ")}`
      );
      if (preserved > 0) {
        console.log(`Preserving ${preserved} existing Entry Point command(s) from global scope.`);
      }
      await rest.put(Routes.applicationCommands(applicationId), { body: payload });
      console.log("Registered global commands (may take up to an hour to appear).");
    }
  } catch (error) {
    console.error("Failed to register commands:", error);
    process.exit(1);
  }
}

deploy();
