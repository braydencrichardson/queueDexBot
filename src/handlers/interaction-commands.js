const { ApplicationFlagsBitField, MessageFlags } = require("discord.js");
const { QUEUE_VIEW_PAGE_SIZE: CONFIG_QUEUE_VIEW_PAGE_SIZE } = require("../config/constants");
const { createQueueViewService } = require("./queue-view-service");
const { getVoiceChannelCheck, setExpiringMapEntry } = require("./interaction-helpers");
const { createActivityInviteService } = require("../activity/invite-service");
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
const { setQueueLoopMode } = require("../queue/loop");

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
    queueService = null,
    activityInviteService = null,
    getActivityApplicationId = () => "",
  } = deps;
  const inviteService = activityInviteService || createActivityInviteService();

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
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isDiscoverError = errorMessageText.includes("SoundCloud discover links");
    if (isDiscoverError) {
      await interaction.editReply("Could not load that track or playlist.");
      await interaction.followUp({
        content: "That SoundCloud discover link could not be loaded. Try a direct track or playlist link instead.",
        flags: MessageFlags.Ephemeral,
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
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isSpotifyCredentialsMissing = error?.code === "SPOTIFY_CREDENTIALS_MISSING";
    if (isSpotifyCredentialsMissing) {
      await interaction.editReply("Could not load that track or playlist.");
      await interaction.followUp({
        content: "Spotify playlist/album support is not configured. Add `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN` in `.env`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.editReply("Could not load that track or playlist.");
  }

  function buildEphemeralPayload(content) {
    return {
      content,
      flags: MessageFlags.Ephemeral,
    };
  }

  async function safeReplyOrFollowUp(interaction, payload, context = "interaction response") {
    const tryReply = async () => {
      if (typeof interaction.reply !== "function") {
        return false;
      }
      await interaction.reply(payload);
      return true;
    };
    const tryFollowUp = async () => {
      if (typeof interaction.followUp !== "function") {
        return false;
      }
      await interaction.followUp(payload);
      return true;
    };

    const preferFollowUp = Boolean(interaction.deferred || interaction.replied);
    const primary = preferFollowUp ? tryFollowUp : tryReply;
    const fallback = preferFollowUp ? tryReply : tryFollowUp;

    try {
      if (await primary()) {
        return true;
      }
      return await fallback();
    } catch (error) {
      if (error?.code === 40060) {
        try {
          return await fallback();
        } catch (fallbackError) {
          if (fallbackError?.code === 10062) {
            logInfo(`${context} skipped (unknown interaction)`, {
              guild: interaction.guildId,
              command: interaction.commandName,
            });
            return false;
          }
          throw fallbackError;
        }
      }
      if (error?.code === 10062) {
        logInfo(`${context} skipped (unknown interaction)`, {
          guild: interaction.guildId,
          command: interaction.commandName,
        });
        return false;
      }
      throw error;
    }
  }

  async function hasEmbeddedActivityFlag(interaction) {
    const cachedFlags = interaction?.client?.application?.flags;
    if (cachedFlags?.has?.(ApplicationFlagsBitField.Flags.Embedded)) {
      return true;
    }

    const fetchApplication = interaction?.client?.application?.fetch;
    if (typeof fetchApplication !== "function") {
      return false;
    }

    try {
      const application = await interaction.client.application.fetch();
      return Boolean(application?.flags?.has?.(ApplicationFlagsBitField.Flags.Embedded));
    } catch (error) {
      logError("Failed to fetch application flags while checking activity support", error);
      return false;
    }
  }

  function resolveActivityApplicationId(interaction) {
    const fromInteraction = String(
      interaction?.applicationId
      || interaction?.client?.application?.id
      || ""
    ).trim();
    if (fromInteraction) {
      return fromInteraction;
    }
    const fromDeps = String(getActivityApplicationId?.() || "").trim();
    return fromDeps || "";
  }

  return async function handleCommandInteraction(interaction) {
    const isChatInputCommand = typeof interaction.isChatInputCommand === "function"
      ? interaction.isChatInputCommand()
      : (typeof interaction.isCommand === "function" && interaction.isCommand());
    if (!isChatInputCommand) {
      return;
    }

    if (!interaction.guildId) {
      await interaction.reply({ content: "Commands can only be used in a server.", flags: MessageFlags.Ephemeral });
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
        await interaction.reply({ content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
        return;
      }

      const queueVoiceChannelId = queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || null;
      if (queueVoiceChannelId && queueVoiceChannelId !== voiceChannel.id) {
        await interaction.reply({ content: "I am already playing in another voice channel.", flags: MessageFlags.Ephemeral });
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

      async function ensurePlaybackVoiceConnection() {
        const activeChannelId = queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || null;
        if (activeChannelId && activeChannelId !== voiceChannel.id) {
          throw new Error("Queue already connected to another voice channel");
        }
        queue.voiceChannel = voiceChannel;
        if (queue.connection) {
          return;
        }
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
          let searchChooserSent = false;
          if (searchOptions.length) {
            try {
              await ensurePlaybackVoiceConnection();
              searchChooserSent = await trySendSearchChooser(interaction, query, requesterId, searchOptions);
            } catch (error) {
              logError("Failed to join voice before posting search chooser", error);
            }
          }
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

      try {
        await ensurePlaybackVoiceConnection();
      } catch (error) {
        logError("Failed to join voice channel for playback", error);
        await interaction.editReply("I couldn't join your voice channel.");
        return;
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
            flags: MessageFlags.Ephemeral,
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
        await interaction.reply({ content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
        return;
      }

      const queueVoiceChannelId = queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || null;
      if (queueVoiceChannelId === voiceChannel.id) {
        await interaction.reply({ content: "I am already in your voice channel.", flags: MessageFlags.Ephemeral });
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

    if (interaction.commandName === "launch") {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        await safeReplyOrFollowUp(interaction, buildEphemeralPayload("Join a voice channel first."), "launch validation");
        return;
      }
      if (typeof voiceChannel.createInvite !== "function") {
        await safeReplyOrFollowUp(
          interaction,
          buildEphemeralPayload("I couldn't create an Activity invite for your voice channel in this runtime."),
          "launch runtime validation"
        );
        return;
      }
      const embeddedEnabled = await hasEmbeddedActivityFlag(interaction);
      if (!embeddedEnabled) {
        await safeReplyOrFollowUp(
          interaction,
          buildEphemeralPayload(
            "This app is not Activities-enabled yet (missing EMBEDDED flag). Enable Activities for this application in the Discord Developer Portal, then try again."
          ),
          "launch app flag validation"
        );
        return;
      }
      const applicationId = resolveActivityApplicationId(interaction);
      if (!applicationId) {
        await safeReplyOrFollowUp(
          interaction,
          buildEphemeralPayload("Couldn't determine this app's ID to create an Activity invite."),
          "launch app id validation"
        );
        return;
      }

      try {
        const inviteResult = await inviteService.getOrCreateInvite({
          voiceChannel,
          applicationId,
          reason: `Activity launch requested by ${interaction.user?.tag || interaction.user?.id || "unknown user"}`,
        });
        const launchVerb = inviteResult.reused ? "Reused" : "Created";
        await safeReplyOrFollowUp(
          interaction,
          buildEphemeralPayload(
            `${launchVerb} an Activity invite for **${voiceChannel.name}**.\n${inviteResult.url}`
          ),
          "launch success response"
        );
      } catch (error) {
        logError("Failed to launch activity", {
          guild: interaction.guildId,
          channel: voiceChannel.id,
          user: interaction.user?.tag,
          error,
        });
        const message = error?.code === 50234
          ? "This app is not Activities-enabled yet (missing EMBEDDED flag). Enable Activities for this application in the Discord Developer Portal, then try again."
          : (error?.code === 50013 || error?.code === 50001)
            ? "I couldn't create an Activity invite in your voice channel. Check that I can create invites there."
          : "Couldn't launch this activity. Ensure Activities is enabled for this app and try again.";
        try {
          await safeReplyOrFollowUp(interaction, buildEphemeralPayload(message), "launch error response");
        } catch (replyError) {
          logError("Failed to send launch failure response", replyError);
        }
      }
      return;
    }

    if (interaction.commandName === "playing") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const nowPlayingMessage = await sendNowPlaying(queue, true);
      if (!nowPlayingMessage) {
        await interaction.editReply({
          content: "I couldn't post now playing controls in this channel. Check my message permissions.",
        });
        return;
      }
      await interaction.editReply({ content: "Posted now playing controls." });
      return;
    }

    if (interaction.commandName === "pause") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
        return;
      }
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
        return;
      }
      if (queueService?.pause) {
        const result = await queueService.pause(queue, { refreshNowPlaying: false });
        if (!result.ok) {
          await interaction.reply({ content: result.error || "Failed to pause playback.", flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        queue.player.pause();
      }
      logInfo("Pausing playback");
      await interaction.reply("Paused.");
      return;
    }

    if (interaction.commandName === "resume") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
        return;
      }
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
        return;
      }
      if (queueService?.resume) {
        const result = await queueService.resume(queue, { refreshNowPlaying: false });
        if (!result.ok) {
          await interaction.reply({ content: result.error || "Failed to resume playback.", flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        queue.player.unpause();
      }
      logInfo("Resuming playback");
      await interaction.reply("Resumed.");
      return;
    }

    if (interaction.commandName === "skip") {
      if (!queue.current) {
        await interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
        return;
      }
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
        return;
      }
      if (queueService?.skip) {
        const result = await queueService.skip(queue);
        if (!result.ok) {
          await interaction.reply({ content: result.error || "Failed to skip track.", flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        queue.player.stop(true);
      }
      logInfo("Skipping track");
      await interaction.reply("Skipped.");
      return;
    }

    if (interaction.commandName === "stop") {
      if (!queue.current && !queue.tracks.length) {
        await interaction.reply({ content: "Nothing is playing and the queue is empty.", flags: MessageFlags.Ephemeral });
        return;
      }
      const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "control playback");
      if (voiceChannelCheck) {
        await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
        return;
      }
      if (queueService?.stop) {
        const result = await queueService.stop(queue, { reason: "Stopping playback and clearing queue" });
        if (!result.ok) {
          await interaction.reply({ content: result.error || "Failed to stop playback.", flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        stopAndLeaveQueue(queue, "Stopping playback and clearing queue");
      }
      await interaction.reply("Stopped and cleared the queue.");
      return;
    }

    if (interaction.commandName === "queue") {
      const queueSubcommand = interaction.options.getSubcommand();

      if (queueSubcommand === "view") {
        if (!queue.current && !queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", flags: MessageFlags.Ephemeral });
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
          await interaction.reply({ content: "Queue is already empty.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        let removedCount = queue.tracks.length;
        if (queueService?.clear) {
          const result = await queueService.clear(queue, { refreshNowPlayingUpNext: true });
          if (!result.ok) {
            await interaction.reply({ content: result.error || "Failed to clear queue.", flags: MessageFlags.Ephemeral });
            return;
          }
          removedCount = Number.isFinite(result.removedCount) ? result.removedCount : removedCount;
        } else {
          queue.tracks = [];
          await maybeRefreshNowPlayingUpNext(queue);
        }
        await interaction.reply(formatQueueClearedNotice(removedCount));
        return;
      }

      if (queueSubcommand === "shuffle") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two queued tracks to shuffle.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        if (queueService?.shuffle) {
          const result = await queueService.shuffle(queue, { refreshNowPlayingUpNext: true });
          if (!result.ok) {
            await interaction.reply({ content: result.error || "Failed to shuffle queue.", flags: MessageFlags.Ephemeral });
            return;
          }
        } else {
          shuffleQueuedTracks(queue);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        await interaction.reply("Shuffled the queue.");
        return;
      }

      if (queueSubcommand === "loop") {
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedMode = interaction.options.getString("mode", true);
        let loopResult = null;
        if (queueService?.setLoopMode) {
          const result = await queueService.setLoopMode(queue, selectedMode, {
            refreshNowPlayingUpNext: true,
            refreshNowPlaying: true,
          });
          if (!result.ok) {
            await interaction.reply({ content: result.error || "Failed to set loop mode.", flags: MessageFlags.Ephemeral });
            return;
          }
          loopResult = result.loopResult;
        } else {
          loopResult = setQueueLoopMode(queue, selectedMode, ensureTrackId);
          await maybeRefreshNowPlayingUpNext(queue);
          await sendNowPlaying(queue, false);
        }
        logInfo("Loop mode updated via queue command", {
          guildId: interaction.guildId,
          user: interaction.user?.tag,
          previousMode: loopResult.previousMode,
          mode: loopResult.mode,
          inserted: loopResult.inserted,
          removed: loopResult.removed,
        });
        if (loopResult.inserted || loopResult.removed) {
          await queueViewService.refreshGuildViews(interaction.guildId, queue, interaction.client);
        }
        await interaction.reply(`Loop mode set to **${loopResult.mode}**.`);
        return;
      }

      if (queueSubcommand === "remove") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const index = interaction.options.getInteger("index", true);
        if (!isValidQueuePosition(queue, index)) {
          await interaction.reply({ content: `Invalid queue position. Choose 1-${queue.tracks.length}.`, flags: MessageFlags.Ephemeral });
          return;
        }
        let removed = null;
        if (queueService?.removeAt) {
          const result = await queueService.removeAt(queue, index, { refreshNowPlayingUpNext: true });
          if (!result.ok) {
            await interaction.reply({ content: result.error || "Failed to remove track.", flags: MessageFlags.Ephemeral });
            return;
          }
          removed = result.removed;
        } else {
          removed = removeQueuedTrackAt(queue, index);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        await interaction.reply(formatQueueRemovedNotice(removed));
        return;
      }

      if (queueSubcommand === "move") {
        if (queue.tracks.length < 2) {
          await interaction.reply({ content: "Need at least two queued tracks to move.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const from = interaction.options.getInteger("from", true);
        const to = interaction.options.getInteger("to", true);
        if (!isValidQueuePosition(queue, from) || !isValidQueuePosition(queue, to)) {
          await interaction.reply({
            content: `Invalid queue positions. Choose values between 1 and ${queue.tracks.length}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        let moved = null;
        if (queueService?.move) {
          const result = await queueService.move(queue, from, to, { refreshNowPlayingUpNext: true });
          if (!result.ok) {
            await interaction.reply({ content: result.error || "Failed to move track.", flags: MessageFlags.Ephemeral });
            return;
          }
          moved = result.moved;
        } else {
          moved = moveQueuedTrackToPosition(queue, from, to);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        await interaction.reply(formatMovedMessage(moved, to));
      }
    }
  };
}

module.exports = {
  createCommandInteractionHandler,
};
