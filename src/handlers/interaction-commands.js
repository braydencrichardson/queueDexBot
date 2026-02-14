const { QUEUE_VIEW_PAGE_SIZE: CONFIG_QUEUE_VIEW_PAGE_SIZE } = require("../config/constants");
const { createQueueViewService } = require("./queue-view-service");
const { getVoiceChannelCheck, setExpiringMapEntry } = require("./interaction-helpers");
const {
  formatQueueClearedNotice,
  formatQueueRemovedNotice,
  formatMovedMessage,
  formatQueuedMessage,
  formatQueuedPlaylistMessage,
} = require("../ui/messages");
const { formatDuration } = require("../queue/utils");
const {
  isValidQueuePosition,
  moveQueuedTrackToPosition,
  removeQueuedTrackAt,
  shuffleQueuedTracks,
} = require("../queue/operations");

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
  const queueViewPageSize = Number.isFinite(QUEUE_VIEW_PAGE_SIZE) ? QUEUE_VIEW_PAGE_SIZE : CONFIG_QUEUE_VIEW_PAGE_SIZE;
  const queueViewService = createQueueViewService({
    queueViews,
    formatQueueViewContent,
    buildQueueViewComponents,
    queueViewTimeoutMs: QUEUE_VIEW_TIMEOUT_MS,
    logError,
  });
  async function handleResolveErrorReply(interaction, error) {
    const errorMessageText = String(error?.message || "");
    const isHttp302Error = errorMessageText.toLowerCase().includes("http status: 302");
    if (isHttp302Error) {
      await interaction.editReply("Could not load that track or playlist.");
      await interaction.followUp({
        content: "That link redirected in a way the resolver could not follow. Try the final/canonical URL directly.",
        ephemeral: true,
      });
      return;
    }
    const isDiscoverError = errorMessageText.includes("SoundCloud discover links");
    if (isDiscoverError) {
      await interaction.editReply("Could not load that track or playlist.");
      await interaction.followUp({
        content: "That SoundCloud discover link could not be loaded. Try a direct track or playlist link instead.",
        ephemeral: true,
      });
      return;
    }
    const isSpotifyAccessDenied = error?.code === "SPOTIFY_PLAYLIST_ACCESS_DENIED";
    if (isSpotifyAccessDenied) {
      await interaction.editReply("Could not load that track or playlist.");
      const hasPrivateShareToken = Boolean(error?.spotifyAccess?.hasPrivateShareToken);
      const guidance = hasPrivateShareToken
        ? "That Spotify playlist link uses a private/collaborative share token and cannot be resolved reliably by bot-side API/web fallback. Try a public playlist link or queue individual tracks."
        : "That Spotify playlist appears private/collaborative or otherwise restricted for bot-side resolution. Try a public playlist link or queue individual tracks.";
      await interaction.followUp({
        content: guidance,
        ephemeral: true,
      });
      return;
    }
    const isSpotifyCredentialsMissing = error?.code === "SPOTIFY_CREDENTIALS_MISSING";
    if (isSpotifyCredentialsMissing) {
      await interaction.editReply("Could not load that track or playlist.");
      await interaction.followUp({
        content: "Spotify playlist/album support is not configured. Add `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN` in `.env`.",
        ephemeral: true,
      });
      return;
    }
    await interaction.editReply("Could not load that track or playlist.");
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
      let lastProgressUpdateAt = 0;
      let lastProgressProcessed = -1;

      async function updateResolveProgress(progress) {
        if (!progress || progress.source !== "spotify") {
          return;
        }
        const processed = Number.isFinite(progress.processed) ? progress.processed : 0;
        const matched = Number.isFinite(progress.matched) ? progress.matched : 0;
        const total = Number.isFinite(progress.total) ? progress.total : null;
        const now = Date.now();
        const shouldUpdate = Boolean(progress.done)
          || progress.stage === "fallback"
          || processed <= 1
          || processed - lastProgressProcessed >= 10
          || now - lastProgressUpdateAt >= 1750;
        if (!shouldUpdate) {
          return;
        }
        lastProgressProcessed = processed;
        lastProgressUpdateAt = now;

        let content = "Resolving Spotify tracks...";
        if (progress.stage === "fallback") {
          content = "Spotify API blocked this playlist; using web fallback...";
        } else if (total && total > 0) {
          content = `Resolving Spotify ${progress.type || "playlist"}: matched ${matched}/${total} (${processed} checked)...`;
        } else if (processed > 0) {
          content = `Resolving Spotify ${progress.type || "playlist"}: matched ${matched} (${processed} checked)...`;
        }
        if (progress.done) {
          content = total
            ? `Resolved Spotify ${progress.type || "playlist"}: matched ${matched}/${total}.`
            : `Resolved Spotify ${progress.type || "playlist"}: matched ${matched}.`;
        }
        try {
          await interaction.editReply(content);
        } catch (error) {
          logError("Failed to send Spotify resolve progress update", error);
        }
      }

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
        tracks = await resolveTracks(query, requester, {
          allowSearchFallback: false,
          onProgress: updateResolveProgress,
        });
      } catch (error) {
        logError("Failed to resolve tracks", error);
        await handleResolveErrorReply(interaction, error);
        return;
      }

      if (!tracks.length) {
        try {
          const searchOptions = await getSearchOptionsForQuery(query, requester);
          const searchChooserSent = await trySendSearchChooser(interaction, query, requesterId, searchOptions);
          if (searchChooserSent) {
            return;
          }
        } catch (error) {
          logError("Failed to send search chooser", error);
        }

        try {
          tracks = await resolveTracks(query, requester, {
            onProgress: updateResolveProgress,
          });
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

      const queueVoiceChannelId = queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || null;
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
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
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
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
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
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
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
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
        return;
      }
      stopAndLeaveQueue(queue, "Stopping playback and clearing queue");
      await interaction.reply("Stopped and cleared the queue.");
      return;
    }

    if (interaction.commandName === "queue") {
      const queueSubcommand = interaction.options.getSubcommand();

      if (queueSubcommand === "view") {
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

      if (queueSubcommand === "clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const removedCount = queue.tracks.length;
        queue.tracks = [];
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply(formatQueueClearedNotice(removedCount));
        return;
      }

      if (queueSubcommand === "shuffle") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two queued tracks to shuffle.", ephemeral: true });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        shuffleQueuedTracks(queue);
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply("Shuffled the queue.");
        return;
      }

      if (queueSubcommand === "remove") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const index = interaction.options.getInteger("index", true);
        if (!isValidQueuePosition(queue, index)) {
          await interaction.reply({ content: `Invalid queue position. Choose 1-${queue.tracks.length}.`, ephemeral: true });
          return;
        }
        const removed = removeQueuedTrackAt(queue, index);
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply(formatQueueRemovedNotice(removed));
        return;
      }

      if (queueSubcommand === "move") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two queued tracks to move.", ephemeral: true });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, ephemeral: true });
          return;
        }
        const from = interaction.options.getInteger("from", true);
        const to = interaction.options.getInteger("to", true);
        if (!isValidQueuePosition(queue, from) || !isValidQueuePosition(queue, to)) {
          await interaction.reply({
            content: `Invalid queue positions. Choose values between 1 and ${queue.tracks.length}.`,
            ephemeral: true,
          });
          return;
        }
        const moved = moveQueuedTrackToPosition(queue, from, to);
        await maybeRefreshNowPlayingUpNext(queue);
        await interaction.reply(formatMovedMessage(moved, to));
      }
    }
  };
}

module.exports = {
  createCommandInteractionHandler,
};
