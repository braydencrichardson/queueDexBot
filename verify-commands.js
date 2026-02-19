const dotenv = require("dotenv");
const { REST, Routes } = require("discord.js");
const { commands: localCommands } = require("./src/commands");

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.APPLICATION_ID;
const guildId = process.env.GUILD_ID;
const args = new Set(process.argv.slice(2));
const rawArgs = process.argv.slice(2);

const hasPositionalGlobal = args.has("global");
const hasPositionalGuild = args.has("guild");
const hasPositionalAll = args.has("all");

const forceGlobal = args.has("--global") || hasPositionalGlobal;
const forceGuild = args.has("--guild") || hasPositionalGuild;
const forceAll = args.has("--all") || hasPositionalAll;
const guildIdFlagIndex = rawArgs.indexOf("--guild-id");
const guildIdOverride = guildIdFlagIndex >= 0 ? String(rawArgs[guildIdFlagIndex + 1] || "").trim() : "";

if (!token) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

if (!applicationId) {
  console.error("Missing APPLICATION_ID in environment.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

function formatNames(items) {
  if (!items.length) {
    return "(none)";
  }
  return items.map((name) => `/${name}`).join(", ");
}

function diffNames(localNames, remoteNames) {
  const localSet = new Set(localNames);
  const remoteSet = new Set(remoteNames);
  const missing = localNames.filter((name) => !remoteSet.has(name));
  const extra = remoteNames.filter((name) => !localSet.has(name));
  return { missing, extra };
}

async function fetchGlobalCommands() {
  const commands = await rest.get(Routes.applicationCommands(applicationId));
  return Array.isArray(commands) ? commands : [];
}

async function fetchGuildCommands(targetGuildId) {
  const commands = await rest.get(Routes.applicationGuildCommands(applicationId, targetGuildId));
  return Array.isArray(commands) ? commands : [];
}

async function verify() {
  try {
    if ([forceGlobal, forceGuild, forceAll].filter(Boolean).length > 1) {
      console.error("Choose only one target: --global, --guild, or --all.");
      process.exit(1);
    }

    let target = "all";
    if (forceGlobal) {
      target = "global";
    } else if (forceGuild) {
      target = "guild";
    } else if (forceAll) {
      target = "all";
    }

    if (guildIdFlagIndex >= 0 && !guildIdOverride) {
      console.error("Missing value for --guild-id.");
      process.exit(1);
    }

    const targetGuildId = guildIdOverride || guildId;

    if ((target === "guild" || target === "all") && !targetGuildId) {
      console.error("Missing GUILD_ID in environment for guild verification (or pass --guild-id).");
      process.exit(1);
    }

    const localNames = localCommands.map((command) => command.name).sort();
    console.log(`Local commands (${localNames.length}): ${formatNames(localNames)}`);

    if (target === "global" || target === "all") {
      const globalCommands = await fetchGlobalCommands();
      const globalNames = globalCommands.map((command) => command.name).sort();
      const globalDiff = diffNames(localNames, globalNames);
      console.log(`Global commands (${globalNames.length}): ${formatNames(globalNames)}`);
      console.log(
        `Global missing from remote (${globalDiff.missing.length}): ${formatNames(globalDiff.missing)}`
      );
      console.log(`Global extra on remote (${globalDiff.extra.length}): ${formatNames(globalDiff.extra)}`);
    }

    if (target === "guild" || target === "all") {
      const guildCommands = await fetchGuildCommands(targetGuildId);
      const guildNames = guildCommands.map((command) => command.name).sort();
      const guildDiff = diffNames(localNames, guildNames);
      console.log(`Guild ${targetGuildId} commands (${guildNames.length}): ${formatNames(guildNames)}`);
      console.log(
        `Guild missing from remote (${guildDiff.missing.length}): ${formatNames(guildDiff.missing)}`
      );
      console.log(`Guild extra on remote (${guildDiff.extra.length}): ${formatNames(guildDiff.extra)}`);
    }
  } catch (error) {
    console.error("Failed to verify commands:", error);
    process.exit(1);
  }
}

verify();
