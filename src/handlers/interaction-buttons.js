const { MessageFlags } = require("discord.js");
const {
  QUEUE_MOVE_MENU_PAGE_SIZE: CONFIG_QUEUE_MOVE_MENU_PAGE_SIZE,
  QUEUE_VIEW_PAGE_SIZE: CONFIG_QUEUE_VIEW_PAGE_SIZE,
} = require("../config/constants");
const { createActivityInviteService } = require("../activity/invite-service");
const { formatActivityInviteResponse } = require("../activity/invite-message");
const { createQueueViewService } = require("./queue-view-service");
const {
  clearMapEntryWithTimeout,
  getVoiceChannelCheck,
  queueSearchSelection,
  setExpiringMapEntry,
} = require("./interaction-helpers");
const {
  formatMovePrompt,
  formatMovedMessage,
  formatQueuedMessage,
  formatRemovedMessage,
} = require("../ui/messages");
const {
  buildControlActionFeedback,
  buildQueueActionFeedback,
  sendQueueFeedback,
} = require("../queue/action-feedback");
const { formatDuration } = require("../queue/utils");
const {
  moveQueuedTrackToFront,
  moveQueuedTrackToPosition,
  removeQueuedTrackAt,
  shuffleQueuedTracks,
} = require("../queue/operations");
const { LOOP_MODES, getQueueLoopMode, setQueueLoopMode } = require("../queue/loop");

function createButtonInteractionHandler(deps) {
  const {
    AudioPlayerStatus,
    INTERACTION_TIMEOUT_MS,
    QUEUE_VIEW_PAGE_SIZE,
    QUEUE_VIEW_TIMEOUT_MS,
    QUEUE_MOVE_MENU_PAGE_SIZE,
    getGuildQueue,
    isSameVoiceChannel,
    buildQueuedActionComponents,
    formatQueueViewContent,
    buildQueueViewComponents,
    buildMoveMenu,
    getQueuedTrackIndex,
    getTrackIndexById,
    ensureTrackId,
    pendingSearches,
    pendingMoves,
    pendingQueuedActions,
    queueViews,
    logInfo,
    logError,
    playNext,
    sendNowPlaying,
    maybeRefreshNowPlayingUpNext = async () => {},
    stopAndLeaveQueue,
    queueService = null,
    activityInviteService = null,
    getActivityApplicationId = () => "",
    resolveVoiceChannelById = async () => null,
    activityWebUrl = "",
  } = deps;
  const inviteService = activityInviteService || createActivityInviteService();
  const queueViewPageSize = Number.isFinite(QUEUE_VIEW_PAGE_SIZE) ? QUEUE_VIEW_PAGE_SIZE : CONFIG_QUEUE_VIEW_PAGE_SIZE;
  const queueMoveMenuPageSize = Number.isFinite(QUEUE_MOVE_MENU_PAGE_SIZE)
    ? QUEUE_MOVE_MENU_PAGE_SIZE
    : CONFIG_QUEUE_MOVE_MENU_PAGE_SIZE;
  const queueViewService = createQueueViewService({
    queueViews,
    formatQueueViewContent,
    buildQueueViewComponents,
    queueViewTimeoutMs: QUEUE_VIEW_TIMEOUT_MS,
    logError,
  });

  function getFeedbackChannel(interaction, queue) {
    if (interaction?.message?.channel?.send) {
      return interaction.message.channel;
    }
    if (interaction?.channel?.send) {
      return interaction.channel;
    }
    if (queue?.textChannel?.send) {
      return queue.textChannel;
    }
    return null;
  }

  async function sendActionFeedback(interaction, queue, content, context) {
    return sendQueueFeedback({
      queue,
      channel: getFeedbackChannel(interaction, queue),
      content,
      logInfo,
      logError,
      context,
    });
  }

  function getNextLoopMode(currentMode) {
    if (currentMode === LOOP_MODES.SINGLE) {
      return LOOP_MODES.OFF;
    }
    if (currentMode === LOOP_MODES.QUEUE) {
      return LOOP_MODES.SINGLE;
    }
    return LOOP_MODES.QUEUE;
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

  async function resolveQueueVoiceChannel(queue, guildId) {
    if (queue?.voiceChannel && typeof queue.voiceChannel.createInvite === "function") {
      return queue.voiceChannel;
    }
    const queueVoiceChannelId = String(queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || "").trim();
    if (!queueVoiceChannelId) {
      return null;
    }
    try {
      const resolved = await resolveVoiceChannelById(guildId, queueVoiceChannelId);
      if (resolved && typeof resolved.createInvite === "function") {
        return resolved;
      }
    } catch (error) {
      logError("Failed to resolve queue voice channel for activity invite", {
        guildId,
        channelId: queueVoiceChannelId,
        error,
      });
    }
    return null;
  }

  function getActivityInviteFailureMessage(error) {
    if (error?.code === 50234) {
      return "This app is not Activities-enabled yet (missing EMBEDDED flag). Enable Activities for this application in the Discord Developer Portal, then try again.";
    }
    if (error?.code === 50013 || error?.code === 50001) {
      return "I couldn't create an Activity invite in this voice channel. Check that I can create invites there.";
    }
    return "Couldn't create an Activity invite right now. Try /launch to verify setup.";
  }

  async function replyWithActivityInvite(interaction, queue, member) {
    const voiceChannelCheck = getVoiceChannelCheck(member, queue, "open this activity");
    if (voiceChannelCheck) {
      await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
      return;
    }

    const voiceChannel = await resolveQueueVoiceChannel(queue, interaction.guildId);
    if (!voiceChannel) {
      await interaction.reply({
        content: "I couldn't resolve the active voice channel for this queue.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const applicationId = resolveActivityApplicationId(interaction);
    if (!applicationId) {
      await interaction.reply({
        content: "Couldn't determine this app's ID to create an Activity invite.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const inviteResult = await inviteService.getOrCreateInvite({
        voiceChannel,
        applicationId,
        reason: `Activity launch requested by ${interaction.user?.tag || interaction.user?.id || "unknown user"}`,
      });
      await interaction.reply({
        content: formatActivityInviteResponse({
          inviteUrl: inviteResult.url,
          reused: inviteResult.reused,
          voiceChannelName: voiceChannel.name || "voice",
          activityWebUrl,
        }),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logError("Failed to create activity invite from button", {
        guildId: interaction.guildId,
        channelId: voiceChannel?.id,
        user: interaction.user?.tag || interaction.user?.id,
        error,
      });
      await interaction.reply({
        content: getActivityInviteFailureMessage(error),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  return async function handleButtonInteraction(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Buttons can only be used in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const queue = getGuildQueue(interaction.guildId);
    const member = interaction.guild?.members?.resolve(interaction.user.id);
    const customId = interaction.customId || "";

    if (customId.startsWith("playlist_view_queue")) {
      const ownerId = customId.split(":")[1];
      if (ownerId && ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Only the requester can use this queue shortcut.", flags: MessageFlags.Ephemeral });
        return;
      }
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
      await interaction.deferUpdate();
      await queueViewService.sendToChannel(interaction.channel, queue, view);
      return;
    }

    if (customId === "search_close" || customId === "search_queue_first") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can use this search.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (customId === "search_queue_first") {
        const selected = pending.options?.[0];
        if (!selected) {
          clearMapEntryWithTimeout(pendingSearches, interaction.message.id);
          await interaction.update({ content: "Search had no selectable results.", components: [] });
          return;
        }
        if (!isSameVoiceChannel(member, queue)) {
          await interaction.reply({ content: "Join my voice channel to choose a result.", flags: MessageFlags.Ephemeral });
          return;
        }
        await queueSearchSelection({
          interaction,
          queue,
          pendingSearches,
          pendingQueuedActions,
          selected,
          requesterId: pending.requesterId,
          interactionTimeoutMs: INTERACTION_TIMEOUT_MS,
          ensureTrackId,
          getQueuedTrackIndex,
          buildQueuedActionComponents,
          maybeRefreshNowPlayingUpNext,
          playNext,
          logInfo,
          logError,
          queueLogMessage: "Queued first result from search chooser",
          queuedNoticeFormatter: (track, position) => formatQueuedMessage(track, position, formatDuration),
        });
        return;
      }
      clearMapEntryWithTimeout(pendingSearches, interaction.message.id);
      await interaction.update({ content: "Search closed.", components: [] });
      return;
    }

    if (customId.startsWith("np_")) {
      if (!queue.nowPlayingMessageId || interaction.message.id !== queue.nowPlayingMessageId) {
        await interaction.reply({
          content: "That now playing message is no longer active. Use /playing to post a new one.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (customId === "np_activity") {
        await replyWithActivityInvite(interaction, queue, member);
        return;
      }
      if (!isSameVoiceChannel(member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (customId === "np_queue" && !queue.current && !queue.tracks.length) {
        await interaction.reply({ content: "Queue is empty.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();

      if (customId === "np_toggle") {
        if (queue.player.state.status === AudioPlayerStatus.Playing) {
          let pauseResult = { ok: true };
          if (queueService?.pause) {
            pauseResult = await queueService.pause(queue, { refreshNowPlaying: false });
          } else {
            queue.player.pause();
          }
          if (!pauseResult?.ok) {
            if (typeof interaction.followUp === "function") {
              await interaction.followUp({
                content: pauseResult.error || "Failed to pause playback.",
                flags: MessageFlags.Ephemeral,
              });
            }
            return;
          }
          await sendActionFeedback(
            interaction,
            queue,
            buildControlActionFeedback("pause", {
              user: interaction.user,
              member,
              result: pauseResult,
            }),
            "button:np_toggle:pause"
          );
        } else {
          let resumeResult = { ok: true };
          if (queueService?.resume) {
            resumeResult = await queueService.resume(queue, {
              refreshNowPlaying: false,
              ensureVoiceConnection: true,
              ensureVoiceConnectionOptions: {
                guildId: interaction.guildId,
                preferredVoiceChannel: member?.voice?.channel || null,
              },
            });
          } else {
            queue.player.unpause();
          }
          if (!resumeResult?.ok) {
            if (typeof interaction.followUp === "function") {
              await interaction.followUp({
                content: resumeResult.error || "Failed to resume playback.",
                flags: MessageFlags.Ephemeral,
              });
            }
            return;
          }
          await sendActionFeedback(
            interaction,
            queue,
            buildControlActionFeedback("resume", {
              user: interaction.user,
              member,
              result: resumeResult,
            }),
            "button:np_toggle:resume"
          );
        }
        await sendNowPlaying(queue, false);
      } else if (customId === "np_queue") {
        const pageSize = queueViewPageSize;
        const view = queueViewService.createFromInteraction(interaction, {
          page: 1,
          pageSize,
          selectedTrackId: null,
          stale: false,
        });
        await queueViewService.sendToChannel(interaction.channel, queue, view);
      } else if (customId === "np_skip") {
        await sendActionFeedback(
          interaction,
          queue,
          buildControlActionFeedback("skip", {
            user: interaction.user,
            member,
          }),
          "button:np_skip"
        );
        if (queueService?.skip) {
          await queueService.skip(queue);
        } else {
          queue.player.stop(true);
        }
      } else if (customId === "np_loop") {
        const currentMode = getQueueLoopMode(queue);
        const nextMode = getNextLoopMode(currentMode);
        let loopResult = null;
        if (queueService?.setLoopMode) {
          const result = await queueService.setLoopMode(queue, nextMode, {
            refreshNowPlayingUpNext: true,
            refreshNowPlaying: false,
          });
          loopResult = result.loopResult;
        } else {
          loopResult = setQueueLoopMode(queue, nextMode, ensureTrackId);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        logInfo("Loop mode updated via now playing button", {
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
        await sendActionFeedback(
          interaction,
          queue,
          buildQueueActionFeedback("loop", {
            user: interaction.user,
            member,
            result: { loopResult },
          }),
          "button:np_loop"
        );
        await sendNowPlaying(queue, false);
      } else if (customId === "np_stop") {
        await sendActionFeedback(
          interaction,
          queue,
          buildControlActionFeedback("stop", {
            user: interaction.user,
            member,
          }),
          "button:np_stop"
        );
        if (queueService?.stop) {
          await queueService.stop(queue, { reason: "Stopping playback and clearing queue" });
        } else {
          stopAndLeaveQueue(queue, "Stopping playback and clearing queue");
        }
      }

      if (customId === "np_stop") {
        try {
          await interaction.message.edit({ components: [] });
        } catch (error) {
          logError("Failed to refresh now playing controls", error);
        }
      }
      return;
    }

    if (customId.startsWith("queued_")) {
      const pending = pendingQueuedActions.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That queued action has expired.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can use these controls.", flags: MessageFlags.Ephemeral });
        return;
      }
      const trackIndex = getTrackIndexById(queue, pending.trackId);
      if (trackIndex < 0) {
        await interaction.reply({ content: "That track is no longer in the queue.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (customId === "queued_view") {
        const pageSize = queueViewPageSize;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const selectedTrack = queue.tracks[trackIndex];
        ensureTrackId(selectedTrack);
        const view = queueViewService.createFromInteraction(interaction, {
          page,
          pageSize,
          selectedTrackId: selectedTrack.id,
          stale: false,
        });
        await interaction.deferUpdate();
        await queueViewService.sendToChannel(interaction.channel, queue, view);
        return;
      }

      if (customId === "queued_move") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedIndex = trackIndex + 1;
        const pageSize = queueMoveMenuPageSize;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const moveMenu = buildMoveMenu(queue, selectedIndex, page, pageSize);
        await interaction.deferUpdate();
        const moveMessage = await interaction.channel.send({
          content: formatMovePrompt({ title: pending.trackTitle || "selected track" }, moveMenu.page, moveMenu.totalPages),
          components: moveMenu.components,
        });
        setExpiringMapEntry({
          store: pendingMoves,
          key: moveMessage.id,
          timeoutMs: INTERACTION_TIMEOUT_MS,
          logError,
          errorMessage: "Failed to expire move request",
          onExpire: async () => {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          },
          entry: {
            guildId: interaction.guildId,
            ownerId: interaction.user.id,
            sourceIndex: selectedIndex,
            trackId: pending.trackId,
            queueViewMessageId: null,
            channelId: interaction.channel?.id,
            page: moveMenu.page,
            pageSize,
          },
        });
        return;
      }

      if (customId === "queued_first") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        let moved = null;
        if (queueService?.moveToFront) {
          const result = await queueService.moveToFront(queue, trackIndex + 1, {
            refreshNowPlayingUpNext: true,
          });
          moved = result.moved;
        } else {
          moved = moveQueuedTrackToFront(queue, trackIndex + 1);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        logInfo("Moved track to front via queued controls", { title: moved?.title, user: interaction.user.tag });
        await interaction.update({
          content: formatMovedMessage(moved, 1),
          components: [],
        });
        clearMapEntryWithTimeout(pendingQueuedActions, interaction.message.id);
        return;
      }

      if (customId === "queued_remove") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        let removed = null;
        if (queueService?.removeAt) {
          const result = await queueService.removeAt(queue, trackIndex + 1, {
            refreshNowPlayingUpNext: true,
          });
          removed = result.removed;
        } else {
          removed = removeQueuedTrackAt(queue, trackIndex + 1);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        logInfo("Removed track via queued controls", { title: removed?.title, user: interaction.user.tag });
        await sendActionFeedback(
          interaction,
          queue,
          buildQueueActionFeedback("remove", {
            user: interaction.user,
            member,
            result: { removed },
          }),
          "button:queued_remove"
        );
        await interaction.update({
          content: formatRemovedMessage(removed),
          components: [],
        });
        clearMapEntryWithTimeout(pendingQueuedActions, interaction.message.id);
        return;
      }
    }

    if (customId.startsWith("move_")) {
      const pending = pendingMoves.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That move request has expired.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can control this move request.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (customId === "move_close") {
        clearMapEntryWithTimeout(pendingMoves, interaction.message.id);
        await interaction.update({ content: "Move closed.", components: [] });
        return;
      }
      if (customId === "move_prev") {
        pending.page = Math.max(1, pending.page - 1);
      } else if (customId === "move_next") {
        pending.page += 1;
      } else if (customId === "move_first") {
        const guildQueue = getGuildQueue(interaction.guildId);
        const voiceChannelCheck = getVoiceChannelCheck(member, guildQueue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const currentIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
        if (!currentIndex || !guildQueue.tracks[currentIndex - 1]) {
          await interaction.reply({ content: "Selected track no longer exists.", flags: MessageFlags.Ephemeral });
          return;
        }
        let moved = null;
        if (queueService?.moveToFront) {
          const result = await queueService.moveToFront(guildQueue, currentIndex, {
            refreshNowPlayingUpNext: true,
          });
          moved = result.moved;
        } else {
          moved = moveQueuedTrackToFront(guildQueue, currentIndex);
          await maybeRefreshNowPlayingUpNext(guildQueue);
        }
        clearMapEntryWithTimeout(pendingMoves, interaction.message.id);
        await interaction.update({ content: formatMovedMessage(moved, 1), components: [] });

        const queueView = queueViews.get(pending.queueViewMessageId);
        if (queueView) {
          ensureTrackId(moved);
          queueView.selectedTrackId = moved.id;
          queueView.page = 1;
          queueView.stale = false;
          await queueViewService.editMessage(interaction.channel, pending.queueViewMessageId, guildQueue, queueView, {
            logError,
            errorMessage: "Failed to update queue view after move to first",
          });
        }
        return;
      }
      const guildQueue = getGuildQueue(interaction.guildId);
      const currentIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
      if (!currentIndex || !guildQueue.tracks[currentIndex - 1]) {
        clearMapEntryWithTimeout(pendingMoves, interaction.message.id);
        await interaction.update({ content: "Selected track no longer exists.", components: [] });
        return;
      }
      pending.sourceIndex = currentIndex;
      const updatedIndex = pending.trackId ? getTrackIndexById(guildQueue, pending.trackId) + 1 : pending.sourceIndex;
      pending.sourceIndex = updatedIndex || pending.sourceIndex;
      const moveMenu = buildMoveMenu(guildQueue, pending.sourceIndex, pending.page, pending.pageSize);
      pending.page = moveMenu.page;
      pendingMoves.set(interaction.message.id, pending);
      const track = guildQueue.tracks[pending.sourceIndex - 1];
      const title = track?.title || "selected track";
      await interaction.update({
        content: formatMovePrompt({ title }, moveMenu.page, moveMenu.totalPages),
        components: moveMenu.components,
      });
      return;
    }

    if (customId.startsWith("queue_")) {
      const queueView = queueViews.get(interaction.message.id);
      if (!queueView) {
        await interaction.reply({ content: "That queue view has expired.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== queueView.ownerId) {
        await interaction.reply({ content: "Only the requester can control this queue view.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (customId === "queue_activity") {
        await replyWithActivityInvite(interaction, queue, member);
        return;
      }
      let postUpdateAction = null;

      if (customId === "queue_close") {
        await interaction.deferUpdate();
        await queueViewService.closeByMessageId(interaction.message.id, interaction, "Queue view closed.");
        return;
      }

      if (customId === "queue_prev") {
        queueView.page = Math.max(1, queueView.page - 1);
      } else if (customId === "queue_next") {
        queueView.page += 1;
      } else if (customId === "queue_select_prev" || customId === "queue_select_next" || customId === "queue_select_last") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId)
          : -1;
        let nextIndex;
        if (customId === "queue_select_last") {
          nextIndex = queue.tracks.length - 1;
        } else if (selectedIndex < 0) {
          nextIndex = customId === "queue_select_prev" ? queue.tracks.length - 1 : 0;
        } else if (customId === "queue_select_prev") {
          nextIndex = (selectedIndex - 1 + queue.tracks.length) % queue.tracks.length;
        } else {
          nextIndex = (selectedIndex + 1) % queue.tracks.length;
        }
        const nextTrack = queue.tracks[nextIndex];
        ensureTrackId(nextTrack);
        queueView.selectedTrackId = nextTrack.id;
        queueView.page = Math.floor(nextIndex / queueView.pageSize) + 1;
      } else if (customId === "queue_refresh") {
        // no-op; just re-render below
      } else if (customId === "queue_nowplaying") {
        queue.textChannel = interaction.channel;
        await interaction.deferUpdate();
        const nowPlayingMessage = await sendNowPlaying(queue, true);
        if (!nowPlayingMessage) {
          if (typeof interaction.followUp === "function") {
            await interaction.followUp({
              content: "Couldn't open now playing controls right now. I may be reconnecting to Discord, or I might not have send permissions in this channel.",
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
        await queueViewService.closeByMessageId(
          interaction.message.id,
          interaction,
          "Queue view closed (now playing opened)."
        );
        return;
      } else if (customId === "queue_shuffle") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        if (queueService?.shuffle) {
          await queueService.shuffle(queue, { refreshNowPlayingUpNext: true });
        } else {
          shuffleQueuedTracks(queue);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        queueView.selectedTrackId = null;
      } else if (customId === "queue_clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        let removedCount = queue.tracks.length;
        if (queueService?.clear) {
          const result = await queueService.clear(queue, { refreshNowPlayingUpNext: true });
          removedCount = Number.isFinite(result.removedCount) ? result.removedCount : removedCount;
        } else {
          queue.tracks = [];
          await maybeRefreshNowPlayingUpNext(queue);
        }
        queueView.selectedTrackId = null;
        logInfo("Cleared queue via queue view", { user: interaction.user.tag });
        postUpdateAction = async () => {
          await sendActionFeedback(
            interaction,
            queue,
            buildQueueActionFeedback("clear", {
              user: interaction.user,
              member,
              result: { removedCount },
            }),
            "button:queue_clear"
          );
        };
      } else if (customId === "queue_move") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedTrack = queue.tracks[selectedIndex - 1];
        ensureTrackId(selectedTrack);
        const movePageSize = queueMoveMenuPageSize;
        const movePage = Math.floor((selectedIndex - 1) / movePageSize) + 1;
        const moveMenu = buildMoveMenu(queue, selectedIndex, movePage, movePageSize);
        postUpdateAction = async () => {
          const moveMessage = await interaction.channel.send({
            content: formatMovePrompt(queue.tracks[selectedIndex - 1], moveMenu.page, moveMenu.totalPages),
            components: moveMenu.components,
          });
          setExpiringMapEntry({
            store: pendingMoves,
            key: moveMessage.id,
            timeoutMs: INTERACTION_TIMEOUT_MS,
            logError,
            errorMessage: "Failed to expire move request",
            onExpire: async () => {
              await moveMessage.edit({ content: "Move request expired.", components: [] });
            },
            entry: {
              guildId: interaction.guildId,
              ownerId: queueView.ownerId,
              sourceIndex: selectedIndex,
              trackId: selectedTrack.id,
              queueViewMessageId: interaction.message.id,
              channelId: interaction.channel?.id,
              page: moveMenu.page,
              pageSize: movePageSize,
            },
          });
        };
      } else if (customId === "queue_backward" || customId === "queue_forward") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", flags: MessageFlags.Ephemeral });
          return;
        }
        const step = customId === "queue_backward" ? -1 : 1;
        const targetIndex = selectedIndex + step;
        if (targetIndex < 1 || targetIndex > queue.tracks.length) {
          await interaction.reply({ content: "Track is already at the edge.", flags: MessageFlags.Ephemeral });
          return;
        }
        let moved = null;
        if (queueService?.move) {
          const result = await queueService.move(queue, selectedIndex, targetIndex, {
            refreshNowPlayingUpNext: true,
          });
          moved = result.moved;
        } else {
          moved = moveQueuedTrackToPosition(queue, selectedIndex, targetIndex);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        ensureTrackId(moved);
        queueView.selectedTrackId = moved.id || queueView.selectedTrackId;
        queueView.page = Math.floor((targetIndex - 1) / queueView.pageSize) + 1;
      } else if (customId === "queue_remove") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to remove.", flags: MessageFlags.Ephemeral });
          return;
        }
        let removed = null;
        if (queueService?.removeAt) {
          const result = await queueService.removeAt(queue, selectedIndex, {
            refreshNowPlayingUpNext: true,
          });
          removed = result.removed;
        } else {
          removed = removeQueuedTrackAt(queue, selectedIndex);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        logInfo("Removed track via queue view", { title: removed?.title, user: interaction.user.tag });
        queueView.selectedTrackId = null;
        postUpdateAction = async () => {
          await sendActionFeedback(
            interaction,
            queue,
            buildQueueActionFeedback("remove", {
              user: interaction.user,
              member,
              result: { removed },
            }),
            "button:queue_remove"
          );
        };
      } else if (customId === "queue_front") {
        const voiceChannelCheck = getVoiceChannelCheck(member, queue, "manage the queue");
        if (voiceChannelCheck) {
          await interaction.reply({ content: voiceChannelCheck, flags: MessageFlags.Ephemeral });
          return;
        }
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", flags: MessageFlags.Ephemeral });
          return;
        }
        let moved = null;
        if (queueService?.moveToFront) {
          const result = await queueService.moveToFront(queue, selectedIndex, {
            refreshNowPlayingUpNext: true,
          });
          moved = result.moved;
        } else {
          moved = moveQueuedTrackToFront(queue, selectedIndex);
          await maybeRefreshNowPlayingUpNext(queue);
        }
        logInfo("Moved track to front via queue view", { title: moved?.title, user: interaction.user.tag });
        queueView.selectedTrackId = moved.id || queueView.selectedTrackId;
        queueView.page = 1;
      }

      queueView.stale = false;
      await queueViewService.updateInteraction(interaction, queue, queueView);
      if (typeof postUpdateAction === "function") {
        await postUpdateAction();
      }
    }
  };
}

module.exports = {
  createButtonInteractionHandler,
};
