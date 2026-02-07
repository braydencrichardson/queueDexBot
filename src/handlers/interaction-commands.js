function createCommandInteractionHandler(deps) {
  const {
    INTERACTION_TIMEOUT_MS,
    joinVoiceChannel,
    getGuildQueue,
    isSameVoiceChannel,
    formatQueueViewContent,
    buildQueueViewComponents,
    buildQueuedActionComponents,
    ensureTrackId,
    getQueuedTrackIndex,
    enqueueTracks,
    pendingQueuedActions,
    queueViews,
    logInfo,
    logError,
    sendNowPlaying,
    playNext,
    normalizeQueryInput,
    ensureSodiumReady,
    ensurePlayerListeners,
    maybeSendSearchChooser,
    resolveTracks,
    isSpotifyUrl,
    hasSpotifyCredentials,
    stopAndLeaveQueue,
  } = deps;

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

      try {
        const handled = await maybeSendSearchChooser(interaction, query, requester, requesterId);
        if (handled) {
          return;
        }
      } catch (error) {
        logError("Failed to send search chooser", error);
      }

      let tracks;
      try {
        tracks = await resolveTracks(query, requester);
      } catch (error) {
        logError("Failed to resolve tracks", error);
        const message = error?.message?.includes("SoundCloud discover links")
          || error?.message?.includes("Spotify")
          ? error.message
          : "Could not load that track or playlist.";
        await interaction.editReply(message);
        return;
      }

      if (!tracks.length) {
        await interaction.editReply("No results found.");
        return;
      }

      enqueueTracks(queue, tracks);
      logInfo("Queued tracks", {
        count: tracks.length,
        first: tracks[0]?.title,
      });

      if (tracks.length === 1) {
        const queuedIndex = getQueuedTrackIndex(queue, tracks[0]);
        const positionText = queuedIndex >= 0 ? ` (position ${queuedIndex + 1})` : "";
        const showQueuedControls = queuedIndex >= 1;
        const message = await interaction.editReply({
          content: `Queued: **${tracks[0].title}**${positionText}`,
          components: showQueuedControls ? buildQueuedActionComponents() : [],
          fetchReply: true,
        });
        if (showQueuedControls) {
          const timeout = setTimeout(async () => {
            try {
              const entry = pendingQueuedActions.get(message.id);
              if (!entry) {
                return;
              }
              pendingQueuedActions.delete(message.id);
              await message.edit({ components: [] });
            } catch (error) {
              logError("Failed to expire queued action controls", error);
            }
          }, INTERACTION_TIMEOUT_MS);
          ensureTrackId(tracks[0]);
          pendingQueuedActions.set(message.id, {
            guildId: interaction.guildId,
            ownerId: interaction.user.id,
            trackId: tracks[0].id,
            trackTitle: tracks[0].title,
            timeout,
          });
        }
      } else {
        await interaction.editReply(`Queued ${tracks.length} tracks from playlist.`);
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
      if (!isSameVoiceChannel(interaction.member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
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
      if (!isSameVoiceChannel(interaction.member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
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
      if (!isSameVoiceChannel(interaction.member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
        return;
      }
      logInfo("Skipping track");
      queue.player.stop(true);
      await interaction.reply("Skipped.");
      return;
    }

    if (interaction.commandName === "stop") {
      if (!isSameVoiceChannel(interaction.member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
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
          await interaction.reply("Queue is empty.");
          return;
        }
        const pageSize = 10;
        const view = {
          guildId: interaction.guildId,
          page: 1,
          pageSize,
          ownerId: interaction.user.id,
          selectedTrackId: null,
          stale: false,
        };
        const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, { stale: view.stale });
        const message = await interaction.reply({
          content: pageData.content,
          components: buildQueueViewComponents(view, queue),
          fetchReply: true,
        });
        queueViews.set(message.id, {
          ...view,
          page: pageData.page,
        });
        return;
      }

      if (sub === "clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
          return;
        }
        queue.tracks = [];
        await interaction.reply("Cleared the queue.");
        return;
      }

      if (sub === "shuffle") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two tracks to shuffle.", ephemeral: true });
          return;
        }
        for (let i = queue.tracks.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
        }
        await interaction.reply("Shuffled the queue.");
        return;
      }

      if (sub === "remove") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const index = interaction.options.getInteger("index", true);
        if (index < 1 || index > queue.tracks.length) {
          await interaction.reply({ content: "Invalid queue position.", ephemeral: true });
          return;
        }
        const removed = queue.tracks.splice(index - 1, 1)[0];
        await interaction.reply(`Removed **${removed.title}**.`);
        return;
      }

      if (sub === "move") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two tracks in the queue.", ephemeral: true });
          return;
        }
        const from = interaction.options.getInteger("from", true);
        const to = interaction.options.getInteger("to", true);
        if (from < 1 || from > queue.tracks.length || to < 1 || to > queue.tracks.length) {
          await interaction.reply({ content: "Invalid queue positions.", ephemeral: true });
          return;
        }
        const [moved] = queue.tracks.splice(from - 1, 1);
        queue.tracks.splice(to - 1, 0, moved);
        await interaction.reply(`Moved **${moved.title}** from ${from} to ${to}.`);
      }
    }
  };
}

module.exports = {
  createCommandInteractionHandler,
};
