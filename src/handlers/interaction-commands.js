const { MessageFlags } = require("discord.js");
const { QUEUE_VIEW_PAGE_SIZE: CONFIG_QUEUE_VIEW_PAGE_SIZE } = require("../config/constants");
const { createQueueViewService } = require("./queue-view-service");
const { getQueueVoiceChannelId, getVoiceChannelCheck, setExpiringMapEntry } = require("./interaction-helpers");
const { createActivityInviteService } = require("../activity/invite-service");
const {
  appendActivityWebLine,
  formatActivityInviteResponse,
} = require("../activity/invite-message");
const {
  formatQueuedMessage,
  formatQueuedPlaylistMessage,
} = require("../ui/messages");
const {
  buildControlActionFeedback,
  buildQueueActionFeedback,
} = require("../queue/action-feedback");
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
    getVoiceConnection = () => null,
    queueService = null,
    activityInviteService = null,
    getActivityApplicationId = () => "",
    activityWebUrl = "",
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
  const joinDefaultActivityLine = formatActivityInviteResponse({
    inviteUrl: "https://discord.gg/2KxydpY",
    activityWebUrl: "https://qdexbot.app/",
  });
  const joinUsageLine = "Use `/play <song name or URL>` here to start music, or open the Activity/Web UI to queue tracks.";
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

  function getBotVoiceChannelId(interaction) {
    const voiceChannelId = String(
      interaction?.guild?.members?.me?.voice?.channelId
      || interaction?.guild?.members?.me?.voice?.channel?.id
      || interaction?.member?.guild?.members?.me?.voice?.channelId
      || interaction?.member?.guild?.members?.me?.voice?.channel?.id
      || ""
    ).trim();
    return voiceChannelId || null;
  }

  function clearStaleQueueVoiceState(queue, interaction, reason) {
    if (!queue) {
      return false;
    }
    const queueVoiceChannelId = String(
      queue?.voiceChannel?.id
      || queue?.connection?.joinConfig?.channelId
      || getQueueVoiceChannelId(queue)
      || ""
    ).trim() || null;
    if (!queueVoiceChannelId && !queue.connection && !queue.voiceChannel) {
      return false;
    }

    if (queue.connection) {
      try {
        queue.connection.destroy();
      } catch (error) {
        logError("Failed to destroy stale voice connection", error);
      }
      queue.connection = null;
    }
    queue.voiceChannel = null;

    logInfo("Cleared stale queue voice state", {
      guild: interaction?.guildId || null,
      reason,
      previousQueueVoiceChannelId: queueVoiceChannelId,
    });
    return true;
  }

  function reconcileQueueVoiceState(interaction, queue) {
    if (!queue) {
      return null;
    }
    const botVoiceChannelId = getBotVoiceChannelId(interaction);
    if (!botVoiceChannelId) {
      clearStaleQueueVoiceState(queue, interaction, "bot not connected");
      return null;
    }

    const queueVoiceChannelId = getQueueVoiceChannelId(queue);
    if (queueVoiceChannelId && queueVoiceChannelId !== botVoiceChannelId) {
      logInfo("Detected queue voice channel mismatch; keeping live bot voice channel", {
        guild: interaction?.guildId || null,
        queueVoiceChannelId,
        botVoiceChannelId,
      });
    }

    if (!queue.voiceChannel || queue.voiceChannel.id !== botVoiceChannelId) {
      const liveVoiceChannel = interaction?.guild?.channels?.cache?.get(botVoiceChannelId)
        || interaction?.guild?.members?.me?.voice?.channel
        || null;
      if (liveVoiceChannel) {
        queue.voiceChannel = liveVoiceChannel;
      }
    }

    return botVoiceChannelId;
  }

  function summarizeVoiceNetworkingState(state) {
    const codeMap = {
      0: "opening-ws",
      1: "identifying",
      2: "udp-handshaking",
      3: "selecting-protocol",
      4: "ready",
      5: "resuming",
      6: "closed",
    };
    if (!state || typeof state !== "object") {
      return null;
    }
    const rawCode = Number.isFinite(state?.code) ? state.code : null;
    const wsReadyState = Number.isFinite(state?.ws?.readyState) ? state.ws.readyState : null;
    const wsCloseCode = Number.isFinite(state?.closeCode)
      ? state.closeCode
      : Number.isFinite(state?.ws?.closeCode)
        ? state.ws.closeCode
        : null;
    const udpInfo = state?.udp || null;
    return {
      code: rawCode,
      codeName: rawCode !== null && Object.prototype.hasOwnProperty.call(codeMap, rawCode) ? codeMap[rawCode] : null,
      wsReadyState,
      wsCloseCode,
      udpIp: typeof udpInfo?.ip === "string" ? udpInfo.ip : null,
      udpPort: Number.isFinite(udpInfo?.port) ? udpInfo.port : null,
    };
  }

  function attachVoiceConnectionDiagnostics(connection, { context, guildId, channelId }) {
    if (!connection || connection.__queueDexVoiceDiagnosticsAttached) {
      return;
    }
    connection.__queueDexVoiceDiagnosticsAttached = true;

    const onNetworkingStateChange = (oldNetworkState, newNetworkState) => {
      logInfo("Voice networking state change", {
        context,
        guildId: guildId || null,
        channelId: channelId || null,
        from: summarizeVoiceNetworkingState(oldNetworkState),
        to: summarizeVoiceNetworkingState(newNetworkState),
      });
    };
    const onNetworkingClose = (closeCode) => {
      connection.__queueDexLastNetworkingCloseCode = Number.isFinite(closeCode) ? closeCode : null;
      logInfo("Voice networking closed", {
        context,
        guildId: guildId || null,
        channelId: channelId || null,
        closeCode: Number.isFinite(closeCode) ? closeCode : null,
        connectionStatus: String(connection?.state?.status || "").toLowerCase() || null,
        rejoinAttempts: Number.isFinite(connection?.rejoinAttempts) ? connection.rejoinAttempts : null,
      });
    };

    connection.on("stateChange", (oldState, newState) => {
      const fromStatus = String(oldState?.status || "").toLowerCase() || null;
      const toStatus = String(newState?.status || "").toLowerCase() || null;
      logInfo("Voice connection state change", {
        context,
        guildId: guildId || null,
        channelId: channelId || null,
        from: fromStatus,
        to: toStatus,
        rejoinAttempts: Number.isFinite(connection?.rejoinAttempts) ? connection.rejoinAttempts : null,
      });
      if (oldState?.networking && oldState.networking !== newState?.networking) {
        oldState.networking.off?.("stateChange", onNetworkingStateChange);
        oldState.networking.off?.("close", onNetworkingClose);
      }
      if (newState?.networking && oldState?.networking !== newState.networking) {
        newState.networking.on?.("stateChange", onNetworkingStateChange);
        newState.networking.on?.("close", onNetworkingClose);
      }
    });

    if (connection.state?.networking) {
      connection.state.networking.on?.("stateChange", onNetworkingStateChange);
      connection.state.networking.on?.("close", onNetworkingClose);
    }
    logInfo("Voice connection diagnostics attached", {
      context,
      guildId: guildId || null,
      channelId: channelId || null,
      status: String(connection?.state?.status || "").toLowerCase() || null,
    });
  }

  async function waitForVoiceConnectionReady(connection, { timeoutMs = 12000, context = "interaction" } = {}) {
    if (!connection) {
      return false;
    }

    const startedAt = Date.now();
    const getStatus = () => String(connection?.state?.status || "").toLowerCase();
    const currentStatus = getStatus();
    if (currentStatus === "ready") {
      logInfo("Voice connection already ready", {
        context,
        status: currentStatus,
      });
      return true;
    }
    if (currentStatus === "destroyed") {
      return false;
    }
    if (typeof connection.on !== "function" || typeof connection.off !== "function") {
      return true;
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle = null;

      function cleanup() {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        connection.off?.("stateChange", onStateChange);
      }

      function finish(value) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(Boolean(value));
      }

      function onStateChange(_oldState, newState) {
        const nextStatus = String(newState?.status || getStatus() || "").toLowerCase();
        if (nextStatus === "ready") {
          logInfo("Voice connection reached ready state", {
            context,
            elapsedMs: Date.now() - startedAt,
          });
          finish(true);
          return;
        }
        if (nextStatus === "destroyed") {
          finish(false);
        }
      }

      timeoutHandle = setTimeout(() => {
        logInfo("Timed out waiting for voice connection ready state", {
          context,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          status: getStatus() || null,
        });
        finish(false);
      }, timeoutMs);

      connection.on?.("stateChange", onStateChange);
      if (getStatus() === "ready") {
        finish(true);
      }
    });
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
    const previousQueueTextChannel = queue?.textChannel || null;
    const previousQueueTextChannelId = String(previousQueueTextChannel?.id || queue?.textChannelId || "").trim() || null;
    const previousQueueVoiceChannelId = getQueueVoiceChannelId(queue);
    const interactionTextChannelId = String(interaction.channelId || interaction.channel?.id || "").trim() || null;
    if (interaction.commandName !== "leave") {
      queue.textChannel = interaction.channel;
      queue.textChannelId = interactionTextChannelId;
    }

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

      const botVoiceChannelId = reconcileQueueVoiceState(interaction, queue);
      const queueVoiceChannelId = botVoiceChannelId || getQueueVoiceChannelId(queue);
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
        if (!queue.connection && typeof getVoiceConnection === "function") {
          const existingConnection = getVoiceConnection(interaction.guildId);
          if (existingConnection) {
            queue.connection = existingConnection;
            attachVoiceConnectionDiagnostics(queue.connection, {
              context: "play-adopt-existing-connection",
              guildId: interaction.guildId,
              channelId: voiceChannel.id,
            });
            logInfo("Adopted existing voice connection from voice adapter cache", {
              guild: interaction.guildId,
              channel: voiceChannel.id,
              status: String(queue.connection?.state?.status || "").toLowerCase() || null,
            });
          }
        }

        async function attemptRejoinReadyWait(connection, context) {
          if (!connection || typeof connection.rejoin !== "function") {
            return false;
          }
          const previousJoinConfig = connection.joinConfig || {};
          try {
            const rejoinResult = connection.rejoin({
              channelId: voiceChannel.id,
              guildId: voiceChannel.guild.id,
              selfDeaf: typeof previousJoinConfig.selfDeaf === "boolean" ? previousJoinConfig.selfDeaf : true,
              selfMute: typeof previousJoinConfig.selfMute === "boolean" ? previousJoinConfig.selfMute : false,
            });
            logInfo("Attempted voice connection rejoin while waiting for ready", {
              guild: interaction.guildId,
              channel: voiceChannel.id,
              context,
              rejoinResult: Boolean(rejoinResult),
              status: String(connection?.state?.status || "").toLowerCase() || null,
            });
          } catch (error) {
            logError("Voice connection rejoin attempt failed", {
              guild: interaction.guildId,
              channel: voiceChannel.id,
              context,
              error,
            });
            return false;
          }
          return waitForVoiceConnectionReady(connection, {
            timeoutMs: 8000,
            context: `${context}:rejoin`,
          });
        }

        function getLastVoiceCloseCode(connection) {
          const code = connection?.__queueDexLastNetworkingCloseCode;
          return Number.isFinite(code) ? code : null;
        }

        function buildVoiceNotReadyError(connection) {
          const closeCode = getLastVoiceCloseCode(connection);
          if (closeCode === 4017) {
            return new Error("Voice connection rejected with close code 4017");
          }
          if (closeCode !== null) {
            return new Error(`Voice connection failed to become ready (signaling; close code ${closeCode})`);
          }
          return new Error("Voice connection failed to become ready (signaling)");
        }

        const liveBotVoiceChannelId = reconcileQueueVoiceState(interaction, queue);
        const activeChannelId = liveBotVoiceChannelId || getQueueVoiceChannelId(queue);
        if (activeChannelId && activeChannelId !== voiceChannel.id) {
          throw new Error("Queue already connected to another voice channel");
        }
        queue.voiceChannel = voiceChannel;
        if (queue.connection) {
          attachVoiceConnectionDiagnostics(queue.connection, {
            context: "play-existing-connection",
            guildId: interaction.guildId,
            channelId: voiceChannel.id,
          });
          const ready = await waitForVoiceConnectionReady(queue.connection, {
            context: "play-existing-connection",
          });
          if (ready) {
            return;
          }
          const liveBotVoiceChannelIdAfterWait = getBotVoiceChannelId(interaction);
          if (liveBotVoiceChannelIdAfterWait === voiceChannel.id) {
            const recovered = await attemptRejoinReadyWait(queue.connection, "play-existing-connection");
            if (recovered) {
              return;
            }
            if (getLastVoiceCloseCode(queue.connection) === 4017) {
              const notReadyError = buildVoiceNotReadyError(queue.connection);
              try {
                queue.connection.destroy();
              } catch (destroyError) {
                logError("Failed to destroy non-ready voice connection after voice close code 4017", destroyError);
              }
              queue.connection = null;
              queue.voiceChannel = null;
              throw notReadyError;
            }
            logInfo("Voice connection remained signaling after rejoin attempt; rebuilding connection", {
              guild: interaction.guildId,
              channel: voiceChannel.id,
              status: String(queue.connection?.state?.status || "").toLowerCase() || null,
            });
          }
          try {
            queue.connection.destroy();
          } catch (destroyError) {
            logError("Failed to destroy non-ready voice connection before reconnect", destroyError);
          }
          queue.connection = null;
        }
        await ensureSodiumReady();
        queue.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });
        attachVoiceConnectionDiagnostics(queue.connection, {
          context: "play-new-connection",
          guildId: interaction.guildId,
          channelId: voiceChannel.id,
        });
        queue.connection.on("error", (error) => {
          logError("Voice connection error", error);
        });
        ensurePlayerListeners(queue, interaction.guildId);
        const ready = await waitForVoiceConnectionReady(queue.connection, {
          context: "play-new-connection",
        });
        if (!ready) {
          const notReadyError = buildVoiceNotReadyError(queue.connection);
          const liveBotVoiceChannelIdAfterWait = getBotVoiceChannelId(interaction);
          if (liveBotVoiceChannelIdAfterWait === voiceChannel.id) {
            const recovered = await attemptRejoinReadyWait(queue.connection, "play-new-connection");
            if (recovered) {
              return;
            }
          }
          try {
            queue.connection.destroy();
          } catch (destroyError) {
            logError("Failed to destroy non-ready voice connection after join timeout", destroyError);
          }
          queue.connection = null;
          queue.voiceChannel = null;
          throw notReadyError;
        }
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
        const message = String(error?.message || "").toLowerCase();
        if (message.includes("close code 4017")) {
          await interaction.editReply(
            "Discord voice rejected this connection (code 4017). Update to a DAVE-compatible voice stack (@discordjs/voice + Node.js runtime)."
          );
        } else if (message.includes("signaling")) {
          await interaction.editReply("I joined your channel, but Discord voice did not become ready (stuck signaling).");
        } else {
          await interaction.editReply("I couldn't join your voice channel.");
        }
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

      const currentTextChannelId = String(interaction.channelId || interaction.channel?.id || "").trim() || null;
      const botVoiceChannelId = reconcileQueueVoiceState(interaction, queue);
      const alreadyInCallerVoice = botVoiceChannelId === voiceChannel.id;
      let joinedVoice = false;

      if (!alreadyInCallerVoice) {
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
        attachVoiceConnectionDiagnostics(queue.connection, {
          context: "join-command",
          guildId: interaction.guildId,
          channelId: voiceChannel.id,
        });
        queue.connection.on("error", (error) => {
          logError("Voice connection error", error);
        });
        ensurePlayerListeners(queue, interaction.guildId);
        const ready = await waitForVoiceConnectionReady(queue.connection, {
          context: "join-command",
        });
        if (!ready) {
          const liveBotVoiceChannelIdAfterWait = getBotVoiceChannelId(interaction);
          if (liveBotVoiceChannelIdAfterWait !== voiceChannel.id) {
            try {
              queue.connection.destroy();
            } catch (destroyError) {
              logError("Failed to destroy non-ready voice connection during /join", destroyError);
            }
            queue.connection = null;
            queue.voiceChannel = null;
            await interaction.reply({ content: "I couldn't complete voice setup for that channel.", flags: MessageFlags.Ephemeral });
            return;
          }
          logInfo("Voice connection still signaling after /join timeout; keeping connection", {
            guild: interaction.guildId,
            channel: voiceChannel.id,
            status: String(queue.connection?.state?.status || "").toLowerCase() || null,
          });
        }
        queue.connection.subscribe(queue.player);
        joinedVoice = true;

        logInfo("Joined voice channel via command", {
          guild: interaction.guildId,
          channel: voiceChannel.id,
          user: interaction.user.tag,
        });
      }

      queue.textChannel = interaction.channel;
      queue.textChannelId = currentTextChannelId;

      const textChannelChanged = currentTextChannelId && previousQueueTextChannelId !== currentTextChannelId;
      const firstTextChannelBind = Boolean(currentTextChannelId && !previousQueueTextChannelId);
      const isQueuePlaying = String(queue?.player?.state?.status || "").toLowerCase() === "playing";
      if (firstTextChannelBind && isQueuePlaying && queue?.current) {
        try {
          await sendNowPlaying(queue, true);
        } catch (error) {
          logError("Failed to post now playing after /join text-channel bind", {
            guild: interaction.guildId,
            channel: interaction.channelId,
            user: interaction.user?.tag,
            error,
          });
        }
      }
      const shouldShowJoinOnboarding = !previousQueueVoiceChannelId || !previousQueueTextChannelId;
      const responseLines = [];
      if (joinedVoice) {
        const voiceName = String(voiceChannel?.name || "voice").trim() || "voice";
        if (currentTextChannelId) {
          responseLines.push(`Joined **${voiceName}** and bound updates to <#${currentTextChannelId}>.`);
        } else {
          responseLines.push(`Joined **${voiceName}**.`);
        }
      } else if (textChannelChanged && currentTextChannelId) {
        responseLines.push(`Already in your voice channel. Bound updates to <#${currentTextChannelId}>.`);
      } else {
        responseLines.push("I am already in your voice channel and this text channel is already attached.");
      }

      if (shouldShowJoinOnboarding) {
        if (typeof voiceChannel?.createInvite === "function") {
          const applicationId = resolveActivityApplicationId(interaction);
          if (applicationId) {
            try {
              const inviteResult = await inviteService.getOrCreateInvite({
                voiceChannel,
                applicationId,
                reason: `Activity link shared after /join by ${interaction.user?.tag || interaction.user?.id || "unknown user"}`,
              });
              responseLines.push(formatActivityInviteResponse({
                inviteUrl: inviteResult.url,
                reused: inviteResult.reused,
                voiceChannelName: voiceChannel?.name || "voice",
                activityWebUrl,
              }));
            } catch (error) {
              logError("Failed to create activity invite during join onboarding", {
                guild: interaction.guildId,
                channel: voiceChannel.id,
                user: interaction.user?.tag,
                error,
              });
            }
          }
        }
      }
      if (!responseLines.some((line) => String(line || "").includes("**Activity:**"))) {
        responseLines.push(joinDefaultActivityLine);
      }
      responseLines.push(joinUsageLine);

      await interaction.reply({
        content: responseLines.join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "leave") {
      const leaveSubcommand = typeof interaction.options?.getSubcommand === "function"
        ? interaction.options.getSubcommand()
        : "";
      if (leaveSubcommand === "text") {
        if (!previousQueueTextChannelId) {
          await interaction.reply({ content: "No text channel is currently bound.", flags: MessageFlags.Ephemeral });
          return;
        }
        queue.textChannel = null;
        queue.textChannelId = null;
        await interaction.reply({
          content: `Unbound queue updates from <#${previousQueueTextChannelId}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (leaveSubcommand === "voice") {
        const queueVoiceChannelId = getQueueVoiceChannelId(queue);
        if (!queueVoiceChannelId && !queue?.connection) {
          await interaction.reply({ content: "I am not connected to a voice channel.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(interaction.member, queue, "make me leave voice");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        stopAndLeaveQueue(queue, "Leaving voice channel via /leave voice");
        queue.textChannel = previousQueueTextChannel;
        queue.textChannelId = previousQueueTextChannelId;
        await interaction.reply({ content: "Left the voice channel and cleared the queue.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({ content: "Use `/leave voice` or `/leave text`.", flags: MessageFlags.Ephemeral });
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
          content: "I couldn't post now playing controls right now. I may be reconnecting to Discord, or I might not have send permissions in this channel.",
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
      await interaction.reply(buildControlActionFeedback("pause", null, { style: "reply" }));
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
        const result = await queueService.resume(queue, {
          refreshNowPlaying: false,
          ensureVoiceConnection: true,
          ensureVoiceConnectionOptions: {
            guildId: interaction.guildId,
            preferredVoiceChannel: interaction.member?.voice?.channel || null,
          },
        });
        if (!result.ok) {
          await interaction.reply({ content: result.error || "Failed to resume playback.", flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        queue.player.unpause();
      }
      logInfo("Resuming playback");
      await interaction.reply(buildControlActionFeedback("resume", null, { style: "reply" }));
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
      await interaction.reply(buildControlActionFeedback("skip", null, { style: "reply" }));
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
      await interaction.reply(buildControlActionFeedback("stop", null, { style: "reply" }));
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
        await interaction.reply(buildQueueActionFeedback(
          "clear",
          { result: { removedCount } },
          { style: "reply" }
        ));
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
        await interaction.reply(buildQueueActionFeedback("shuffle", null, { style: "reply" }));
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
        await interaction.reply(buildQueueActionFeedback(
          "loop",
          { result: { loopResult } },
          { style: "reply" }
        ));
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
        await interaction.reply(buildQueueActionFeedback(
          "remove",
          { result: { removed } },
          { style: "reply" }
        ));
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
        await interaction.reply(buildQueueActionFeedback(
          "move",
          { result: { moved, toPosition: to } },
          { style: "reply" }
        ));
      }
    }
  };
}

module.exports = {
  createCommandInteractionHandler,
};
