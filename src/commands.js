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
    name: "playing",
    description: "Show the now playing message with controls",
  },
  {
    name: "join",
    description: "Join your current voice channel",
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
      {
        type: 1,
        name: "loop",
        description: "Set queue loop mode",
        options: [
          {
            name: "mode",
            description: "Loop behavior",
            type: 3,
            required: true,
            choices: [
              { name: "Off", value: "off" },
              { name: "Single Track", value: "single" },
              { name: "Entire Queue", value: "queue" },
            ],
          },
        ],
      },
    ],
  },
];

module.exports = { commands };
