const dotenv = require("dotenv");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.APPLICATION_ID;
const guildId = process.env.GUILD_ID;
const args = new Set(process.argv.slice(2));
const forceGlobal = args.has("--global");
const forceGuild = args.has("--guild");

if (!token) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

if (!applicationId) {
  console.error("Missing APPLICATION_ID in environment.");
  process.exit(1);
}

const commands = [
  {
    name: "play",
    description: "Play a track or playlist from a URL or search query",
    options: [
      {
        name: "query",
        description: "URL or search terms",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "playnext",
    description: "Add a track or playlist to play next",
    options: [
      {
        name: "query",
        description: "URL or search terms",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "playing",
    description: "Show the now playing message with controls",
  },
  {
    name: "pause",
    description: "Pause playback",
  },
  {
    name: "resume",
    description: "Resume playback",
  },
  {
    name: "skip",
    description: "Skip the current track",
  },
  {
    name: "stop",
    description: "Stop playback and clear the queue",
  },
  {
    name: "queue",
    description: "Queue controls",
    options: [
      {
        type: 1,
        name: "view",
        description: "View the current queue",
      },
      {
        type: 1,
        name: "clear",
        description: "Clear the queue",
      },
      {
        type: 1,
        name: "shuffle",
        description: "Shuffle the queue",
      },
      {
        type: 1,
        name: "remove",
        description: "Remove a track from the queue",
        options: [
          {
            name: "index",
            description: "Queue position to remove (1 = next track)",
            type: 4,
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "move",
        description: "Move a track within the queue",
        options: [
          {
            name: "from",
            description: "Queue position to move (1 = next track)",
            type: 4,
            required: true,
          },
          {
            name: "to",
            description: "Destination position (1 = next track)",
            type: 4,
            required: true,
          },
        ],
      },
    ],
  },
];

const rest = new REST({ version: "9" }).setToken(token);

async function deploy() {
  try {
    if (forceGlobal && forceGuild) {
      console.error("Choose either --global or --guild, not both.");
      process.exit(1);
    }
    if (forceGuild && !guildId) {
      console.error("Missing GUILD_ID in environment for --guild deployment.");
      process.exit(1);
    }
    if (!forceGlobal && (forceGuild || guildId)) {
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
