const { DEFAULT_QUEUE_VIEW_PAGE_SIZE } = require("../config/constants");
const { createQueueViewService } = require("./queue-view-service");
const { setExpiringMapEntry } = require("./interaction-helpers");
const {
  formatQueueClearedNotice,
  formatQueueRemovedNotice,
  formatMovedMessage,
  formatQueuedMessage,
  formatQueuedPlaylistMessage,
} = require("../ui/messages");
const { formatDuration } = require("../queue/utils");

function createCommandInteractionHandler(deps) {
  const {
    INTERACTION_TIMEOUT_MS,
    QUEUE_VIEW_PAGE_SIZE,
    QUEUE_VIEW_TIMEOUT_MS,
    joinVoiceChannel,
    getGuildQueue,
    formatQueueViewContent,
    buildQueueViewComponents,
    buildQueuedActionComponents,
    buildPlaylistQueuedComponents,
    ensureTrackId,
    getQueuedTrackIndex,
    enqueueTracks,
    pendingQueuedActions,
    queueViews,
    logInfo,
    logError,
    sendNowPlaying,
    maybeRefreshNowPlayingUpNext = async () => {},
    playNext,
    normalizeQueryInput,
    ensureSodiumReady,
    ensurePlayerListeners,
    trySendSearchChooser,
    getSearchOptionsForQuery,
    resolveTracks,
    isSpotifyUrl,
    hasSpotifyCredentials,
    stopAndLeaveQueue,
  } = deps;
  const queueViewPageSize = Number.isFinite(QUEUE_VIEW_PAGE_SIZE) ? QUEUE_VIEW_PAGE_SIZE : DEFAULT_QUEUE_VIEW_PAGE_SIZE;
  const queueViewService = createQueueViewService({
    queueViews,
    formatQueueViewContent,
    buildQueueViewComponents,
    queueViewTimeoutMs: QUEUE_VIEW_TIMEOUT_MS,
    logError,
  });
  function getQueueVoiceChannelId(queue) {
    return queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || null;
  }

  function getVoiceControlMessage(member, queue, action = "control playback") {
    if (!member?.voice?.channel) {
      return "Join a voice channel first.";
    }
    const queueVoiceChannelId = getQueueVoiceChannelId(queue);
    if (!queueVoiceChannelId || member.voice.channel.id !== queueVoiceChannelId) {
      return `Join my voice channel to ${action}.`;
    }
    return null;
  }

  async function handleResolveErrorReply(interaction, error) {
    const message = String(error?.message || "");
    const isDiscoverError = message.includes("SoundCloud discover links");
    if (isDiscoverError) {
      await interaction.editReply("Could not load that track or playlist.");
      await interaction.followUp({
        content: message,
        ephemeral: true,
      });
      return;
    }
    const isDetailedPublicError = message.includes("Spotify");
    await interaction.editReply(isDetailedPublicError ? message : "Could not load that track or playlist.");
  }

  return async function handleCommandInteraction(interaction) {
    if (!interaction.isCommand()) {
      return;
    }

    if (!interaction.guildId) {
      await interaction.reply({ content: "Commands can only be used in a server.", ephemeral: true });
      return;
    }

    const queue = getGuildQueue(interaction.guildId);
    queue.textChannel = interaction.channel;

    logInfo("Slash command received", {
      guild: interaction.guildId,
      channel: interaction.channelId,
      user: interaction.user.tag,
      command: interaction.commandName,
    });

    if (interaction.commandName === "play") {
      const query = normalizeQueryInput(interaction.options.getString("query", true));
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
        return;
      }

      if (queue.voiceChannel && queue.voiceChannel.id !== voiceChannel.id) {
        await interaction.reply({ content: "I am already playing in another voice channel.", ephemeral: true });
        return;
      }

      await interaction.deferReply();
      logInfo("Resolving track(s)", { query });
      const requester = interaction.member?.displayName || interaction.user.tag;
      const requesterId = interaction.user.id;
      const hadAnythingQueuedBeforePlay = Boolean(queue.current) || queue.tracks.length > 0;

      queue.voiceChannel = voiceChannel;

      if (!queue.connection) {
        await ensureSodiumReady();
        queue.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });
        queue.connection.on("error", (error) => {
          logError("Voice connection error", error);
        });
        ensurePlayerListeners(queue, interaction.guildId);
      }

      let tracks;
      try {
        tracks = await resolveTracks(query, requester, { allowSearchFallback: false });
      } catch (error) {
        logError("Failed to resolve tracks", error);
        await handleResolveErrorReply(interaction, error);
        return;
      }

      if (!tracks.length) {
        try {
          const searchOptions = await getSearchOptionsForQuery(query, requester);
          const handled = await trySendSearchChooser(interaction, query, requesterId, searchOptions);
          if (handled) {
            return;
          }
        } catch (error) {
          logError("Failed to send search chooser", error);
        }

        try {
          tracks = await resolveTracks(query, requester);
        } catch (error) {
          logError("Failed to resolve tracks", error);
          await handleResolveErrorReply(interaction, error);
          return;
        }

        if (!tracks.length) {
          await interaction.editReply("No results found.");
          return;
        }
      }

      enqueueTracks(queue, tracks);
      await maybeRefreshNowPlayingUpNext(queue);
      logInfo("Queued tracks", {
        count: tracks.length,
        first: tracks[0]?.title,
      });

      if (tracks.length === 1) {
        const queuedIndex = getQueuedTrackIndex(queue, tracks[0]);
        const position = (hadAnythingQueuedBeforePlay && queuedIndex >= 0) ? queuedIndex + 1 : null;
        const showQueuedControls = queuedIndex >= 0;
        const message = await interaction.editReply({
          content: formatQueuedMessage(tracks[0], position, formatDuration),
          components: showQueuedControls ? buildQueuedActionComponents({ includeMoveControls: queuedIndex >= 1 }) : [],
          fetchReply: true,
        });
        if (showQueuedControls) {
          ensureTrackId(tracks[0]);
          setExpiringMapEntry({
            store: pendingQueuedActions,
            key: message.id,
            timeoutMs: INTERACTION_TIMEOUT_MS,
            logError,
            errorMessage: "Failed to expire queued action controls",
            onExpire: async () => {
              await message.edit({ components: [] });
            },
            entry: {
              guildId: interaction.guildId,
              ownerId: interaction.user.id,
              trackId: tracks[0].id,
              trackTitle: tracks[0].title,
            },
          });
        }
      } else {
        await interaction.editReply({
          content: formatQueuedPlaylistMessage(tracks.length, requester),
          components: buildPlaylistQueuedComponents(interaction.user.id),
        });
      }

      if (isSpotifyUrl(query) && !hasSpotifyCredentials()) {
        try {
          await interaction.followUp({
            content: "Spotify links without credentials only include the track title. For best results, use `/play Artist - Title`.",
            ephemeral: true,
          });
          logInfo("Sent Spotify hint message", { user: interaction.user.tag });
        } catch (error) {
          logError("Failed to send Spotify hint message", error);
        }
      }

      if (!queue.playing) {
        playNext(interaction.guildId).catch((error) => {
          logError("Error starting playback", error);
        });
      }
      return;
    }

    if (interaction.commandName === "join") {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
        return;
      }

      const queueVoiceChannelId = getQueueVoiceChannelId(queue);
      if (queueVoiceChannelId === voiceChannel.id) {
        await interaction.reply({ content: "I am already in your voice channel.", ephemeral: true });
        return;
      }

      await ensureSodiumReady();
      if (queue.connection) {
        try {
          queue.connection.destroy();
        } catch (error) {
          logError("Failed to destroy existing voice connection while joining", error);
        }
      }

      queue.voiceChannel = voiceChannel;
      queue.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });
      queue.connection.on("error", (error) => {
        logError("Voice connection error", error);
      });
      ensurePlayerListeners(queue, interaction.guildId);
      queue.connection.subscribe(queue.player);

      logInfo("Joined voice channel via command", {
        guild: interaction.guildId,
        channel: voiceChannel.id,
        user: interaction.user.tag,
      });
      await interaction.reply(`Joined **${voiceChannel.name}**.`);
      return;
    }

    if (interaction.commandName === "playing") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      await sendNowPlaying(queue, true);
      await interaction.editReply({ content: "Posted now playing controls." });
      return;
    }

    if (interaction.commandName === "pause") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
        return;
      }
      const voiceMessage = getVoiceControlMessage(interaction.member, queue, "control playback");
      if (voiceMessage) {
        await interaction.reply({ content: voiceMessage, ephemeral: true });
        return;
      }
      queue.player.pause();
      logInfo("Pausing playback");
      await interaction.reply("Paused.");
      return;
    }

    if (interaction.commandName === "resume") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
        return;
      }
      const voiceMessage = getVoiceControlMessage(interaction.member, queue, "control playback");
      if (voiceMessage) {
        await interaction.reply({ content: voiceMessage, ephemeral: true });
        return;
      }
      queue.player.unpause();
      logInfo("Resuming playback");
      await interaction.reply("Resumed.");
      return;
    }

    if (interaction.commandName === "skip") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", ephemeral: true });
        return;
      }
      const voiceMessage = getVoiceControlMessage(interaction.member, queue, "control playback");
      if (voiceMessage) {
        await interaction.reply({ content: voiceMessage, ephemeral: true });
        return;
      }
      logInfo("Skipping track");
      queue.player.stop(true);
      await interaction.reply("Skipped.");
      return;
    }

    if (interaction.commandName === "stop") {
      if (!queue.current && !queue.tracks.length) {
        await interaction.reply({ content: "Nothing is playing and the queue is empty.", ephemeral: true });
        return;
      }
      const voiceMessage = getVoiceControlMessage(interaction.member, queue, "control playback");
      if (voiceMessage) {
        await interaction.reply({ content: voiceMessage, ephemeral: true });
        return;
      }
      stopAndLeaveQueue(queue, "Stopping playback and clearing queue");
      await interaction.reply("Stopped and cleared the queue.");
      return;
    }

    if (interaction.commandName === "queue") {
      const sub = interaction.options.getSubcommand();

      if (sub === "view") {
        if (!queue.current && !queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const pageSize = queueViewPageSize;
        const view = queueViewService.createFromInteraction(interaction, {
          page: 1,
          pageSize,
          selectedTrackId: null,
          stale: false,
        });
        await queueViewService.reply(interaction, queue, view);
        return;
      }

      if (sub === "clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
          return;
        }
        const voiceMessage = getVoiceControlMessage(interaction.member, queue, "manage the queue");
        if (voiceMessage) {
          await interaction.reply({ content: voiceMessage, ephemeral: true });
          return;
        }
        const removedCount = queue.tracks.length;
        queue.tracks = [];
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply(formatQueueClearedNotice(removedCount));
        return;
      }

      if (sub === "shuffle") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two queued tracks to shuffle.", ephemeral: true });
          return;
        }
        const voiceMessage = getVoiceControlMessage(interaction.member, queue, "manage the queue");
        if (voiceMessage) {
          await interaction.reply({ content: voiceMessage, ephemeral: true });
          return;
        }
        for (let i = queue.tracks.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
        }
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply("Shuffled the queue.");
        return;
      }

      if (sub === "remove") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const voiceMessage = getVoiceControlMessage(interaction.member, queue, "manage the queue");
        if (voiceMessage) {
          await interaction.reply({ content: voiceMessage, ephemeral: true });
          return;
        }
        const index = interaction.options.getInteger("index", true);
        if (index < 1 || index > queue.tracks.length) {
          await interaction.reply({ content: `Invalid queue position. Choose 1-${queue.tracks.length}.`, ephemeral: true });
          return;
        }
        const removed = queue.tracks.splice(index - 1, 1)[0];
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply(formatQueueRemovedNotice(removed));
        return;
      }

      if (sub === "move") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two queued tracks to move.", ephemeral: true });
          return;
        }
        const voiceMessage = getVoiceControlMessage(interaction.member, queue, "manage the queue");
        if (voiceMessage) {
          await interaction.reply({ content: voiceMessage, ephemeral: true });
          return;
        }
        const from = interaction.options.getInteger("from", true);
        const to = interaction.options.getInteger("to", true);
        if (from < 1 || from > queue.tracks.length || to < 1 || to > queue.tracks.length) {
          await interaction.reply({
            content: `Invalid queue positions. Choose values between 1 and ${queue.tracks.length}.`,
            ephemeral: true,
          });
          return;
        }
        const [moved] = queue.tracks.splice(from - 1, 1);
        queue.tracks.splice(to - 1, 0, moved);
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply(formatMovedMessage(moved, to));
      }
    }
  };
}

module.exports = {
  createCommandInteractionHandler,
};
