const dotenv = require("dotenv");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v10");
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

const rest = new REST({ version: "9" }).setToken(token);

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

    console.log(
      `Deploying ${commands.length} command(s): ${commands.map((command) => `/${command.name}`).join(", ")}`
    );

    if (deployTarget === "guild") {
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands });
      console.log(`Registered commands for guild ${guildId}.`);
    } else {
      await rest.put(Routes.applicationCommands(applicationId), { body: commands });
      console.log("Registered global commands (may take up to an hour to appear).");
    }
  } catch (error) {
    console.error("Failed to register commands:", error);
    process.exit(1);
  }
}

deploy();
