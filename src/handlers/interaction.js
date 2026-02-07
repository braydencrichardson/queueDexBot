function registerInteractionHandler(client, deps) {
  const {
    AudioPlayerStatus,
    INTERACTION_TIMEOUT_MS,
    joinVoiceChannel,
    getGuildQueue,
    isSameVoiceChannel,
    announceNowPlayingAction,
    buildNowPlayingControls,
    formatQueueViewContent,
    buildQueueViewComponents,
    buildMoveMenu,
    buildQueuedActionComponents,
    getTrackIndexById,
    ensureTrackId,
    getQueuedTrackIndex,
    enqueueTracks,
    pendingSearches,
    pendingMoves,
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
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Buttons can only be used in a server.", ephemeral: true });
      return;
    }

    const queue = getGuildQueue(interaction.guildId);
    const member = interaction.guild?.members?.resolve(interaction.user.id);
    const customId = interaction.customId || "";

    if (customId === "search_close") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can close this search.", ephemeral: true });
        return;
      }
      pendingSearches.delete(interaction.message.id);
      clearTimeout(pending.timeout);
      await interaction.update({ content: "Search closed.", components: [] });
      return;
    }

    if (customId.startsWith("np_")) {
      if (!queue.nowPlayingMessageId || interaction.message.id !== queue.nowPlayingMessageId) {
        await interaction.reply({ content: "That now playing message is no longer active.", ephemeral: true });
        return;
      }
      if (!isSameVoiceChannel(member, queue)) {
        await interaction.reply({ content: "Join my voice channel to control playback.", ephemeral: true });
        return;
      }

      if (customId === "np_toggle") {
        if (queue.player.state.status === AudioPlayerStatus.Playing) {
          queue.player.pause();
          await announceNowPlayingAction(queue, "paused playback", interaction.user, member, interaction.message.channel);
        } else {
          queue.player.unpause();
          await announceNowPlayingAction(queue, "resumed playback", interaction.user, member, interaction.message.channel);
        }
      } else if (customId === "np_queue") {
        if (!queue.current && !queue.tracks.length) {
          await interaction.reply({ content: "Queue is empty.", ephemeral: true });
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
        const message = await interaction.channel.send({
          content: pageData.content,
          components: buildQueueViewComponents(view, queue),
        });
        queueViews.set(message.id, {
          ...view,
          page: pageData.page,
        });
      } else if (customId === "np_skip") {
        await announceNowPlayingAction(queue, "skipped the track", interaction.user, member, interaction.message.channel);
        queue.player.stop(true);
      } else if (customId === "np_stop") {
        await announceNowPlayingAction(queue, "stopped playback and cleared the queue", interaction.user, member, interaction.message.channel);
        queue.tracks = [];
        queue.current = null;
        queue.playing = false;
        if (queue.player) {
          queue.player.stop(true);
        }
        if (queue.connection) {
          queue.connection.destroy();
          queue.connection = null;
        }
      }

      try {
        const controls = buildNowPlayingControls();
        await interaction.message.edit({ components: [controls] });
      } catch (error) {
        logError("Failed to refresh now playing controls", error);
      }

      await interaction.deferUpdate();
      return;
    }

    if (customId.startsWith("queued_")) {
      const pending = pendingQueuedActions.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That queued action has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can use these controls.", ephemeral: true });
        return;
      }
      const trackIndex = getTrackIndexById(queue, pending.trackId);
      if (trackIndex < 0) {
        await interaction.reply({ content: "That track is no longer in the queue.", ephemeral: true });
        return;
      }

      if (customId === "queued_view") {
        const pageSize = 10;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const selectedTrack = queue.tracks[trackIndex];
        ensureTrackId(selectedTrack);
        const view = {
          guildId: interaction.guildId,
          page,
          pageSize,
          ownerId: interaction.user.id,
          selectedTrackId: selectedTrack.id,
          stale: false,
        };
        const pageData = formatQueueViewContent(queue, view.page, view.pageSize, view.selectedTrackId, { stale: view.stale });
        const message = await interaction.channel.send({
          content: pageData.content,
          components: buildQueueViewComponents(view, queue),
        });
        queueViews.set(message.id, {
          ...view,
          page: pageData.page,
        });
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_move") {
        const selectedIndex = trackIndex + 1;
        const pageSize = 10;
        const page = Math.floor(trackIndex / pageSize) + 1;
        const moveMenu = buildMoveMenu(queue, selectedIndex, page, pageSize);
        const moveMessage = await interaction.channel.send({
          content: `Move **${pending.trackTitle || "selected track"}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
          components: moveMenu.components,
        });
        const timeout = setTimeout(async () => {
          const entry = pendingMoves.get(moveMessage.id);
          if (!entry) {
            return;
          }
          pendingMoves.delete(moveMessage.id);
          try {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          } catch (error) {
            logError("Failed to expire move request", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingMoves.set(moveMessage.id, {
          guildId: interaction.guildId,
          ownerId: interaction.user.id,
          sourceIndex: selectedIndex,
          trackId: pending.trackId,
          queueViewMessageId: null,
          page: moveMenu.page,
          pageSize,
          timeout,
        });
        await interaction.deferUpdate();
        return;
      }

      if (customId === "queued_first") {
        const [moved] = queue.tracks.splice(trackIndex, 1);
        queue.tracks.unshift(moved);
        logInfo("Moved track to front via queued controls", { title: moved?.title, user: interaction.user.tag });
        await interaction.update({
          content: `Moved **${moved.title}** to position 1.`,
          components: [],
        });
        pendingQueuedActions.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        return;
      }

      if (customId === "queued_remove") {
        const [removed] = queue.tracks.splice(trackIndex, 1);
        logInfo("Removed track via queued controls", { title: removed?.title, user: interaction.user.tag });
        await interaction.update({
          content: `Removed **${removed.title}** from the queue.`,
          components: [],
        });
        pendingQueuedActions.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        return;
      }
    }

    if (customId.startsWith("move_")) {
      const pending = pendingMoves.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That move request has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can control this move request.", ephemeral: true });
        return;
      }
      if (customId === "move_close") {
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: "Move closed.", components: [] });
        return;
      }
      if (customId === "move_prev") {
        pending.page = Math.max(1, pending.page - 1);
      } else if (customId === "move_next") {
        pending.page += 1;
      } else if (customId === "move_first") {
        const queue = getGuildQueue(interaction.guildId);
        const currentIndex = pending.trackId ? getTrackIndexById(queue, pending.trackId) + 1 : pending.sourceIndex;
        if (!currentIndex || !queue.tracks[currentIndex - 1]) {
          await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
          return;
        }
        const [moved] = queue.tracks.splice(currentIndex - 1, 1);
        queue.tracks.unshift(moved);
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: `Moved **${moved.title}** to position 1.`, components: [] });

        const queueView = queueViews.get(pending.queueViewMessageId);
        if (queueView) {
          ensureTrackId(moved);
          queueView.selectedTrackId = moved.id;
          queueView.page = 1;
          queueView.stale = false;
          const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
          queueViews.set(pending.queueViewMessageId, queueView);
          try {
            const viewMessage = await interaction.channel.messages.fetch(pending.queueViewMessageId);
            await viewMessage.edit({
              content: pageData.content,
              components: buildQueueViewComponents(queueView, queue),
            });
          } catch (error) {
            logError("Failed to update queue view after move to first", error);
          }
        }
        return;
      }
      const queue = getGuildQueue(interaction.guildId);
      const currentIndex = pending.trackId ? getTrackIndexById(queue, pending.trackId) + 1 : pending.sourceIndex;
      if (!currentIndex || !queue.tracks[currentIndex - 1]) {
        pendingMoves.delete(interaction.message.id);
        clearTimeout(pending.timeout);
        await interaction.update({ content: "Selected track no longer exists.", components: [] });
        return;
      }
      pending.sourceIndex = currentIndex;
      const moveMenu = buildMoveMenu(queue, currentIndex, pending.page, pending.pageSize);
      pending.page = moveMenu.page;
      pendingMoves.set(interaction.message.id, pending);
      const track = queue.tracks[pending.sourceIndex - 1];
      const title = track?.title || "selected track";
      await interaction.update({
        content: `Move **${title}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
        components: moveMenu.components,
      });
      return;
    }

    if (customId.startsWith("queue_")) {
      const queueView = queueViews.get(interaction.message.id);
      if (!queueView) {
        await interaction.reply({ content: "That queue view has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== queueView.ownerId) {
        await interaction.reply({ content: "Only the requester can control this queue view.", ephemeral: true });
        return;
      }

      if (customId === "queue_close") {
        queueViews.delete(interaction.message.id);
        await interaction.update({ content: "Queue view closed.", components: [] });
        return;
      }

      if (customId === "queue_prev") {
        queueView.page = Math.max(1, queueView.page - 1);
      } else if (customId === "queue_next") {
        queueView.page += 1;
      } else if (customId === "queue_refresh") {
        // no-op; just re-render below
      } else if (customId === "queue_nowplaying") {
        queue.textChannel = interaction.channel;
        await sendNowPlaying(queue, true);
      } else if (customId === "queue_shuffle") {
        if (queue.tracks.length > 1) {
          for (let i = queue.tracks.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
          }
        }
        queueView.selectedTrackId = null;
      } else if (customId === "queue_clear") {
        if (!queue.tracks.length) {
          await interaction.reply({ content: "Queue is already empty.", ephemeral: true });
          return;
        }
        queue.tracks = [];
        queueView.selectedTrackId = null;
        logInfo("Cleared queue via queue view", { user: interaction.user.tag });
      } else if (customId === "queue_move") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const selectedTrack = queue.tracks[selectedIndex - 1];
        ensureTrackId(selectedTrack);
        const moveMenu = buildMoveMenu(queue, selectedIndex, queueView.page, queueView.pageSize);
        const moveMessage = await interaction.channel.send({
          content: `Move **${queue.tracks[selectedIndex - 1].title}** to (page ${moveMenu.page}/${moveMenu.totalPages}):`,
          components: moveMenu.components,
        });
        const timeout = setTimeout(async () => {
          const entry = pendingMoves.get(moveMessage.id);
          if (!entry) {
            return;
          }
          pendingMoves.delete(moveMessage.id);
          try {
            await moveMessage.edit({ content: "Move request expired.", components: [] });
          } catch (error) {
            logError("Failed to expire move request", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingMoves.set(moveMessage.id, {
          guildId: interaction.guildId,
          ownerId: queueView.ownerId,
          sourceIndex: selectedIndex,
          trackId: selectedTrack.id,
          queueViewMessageId: interaction.message.id,
          page: moveMenu.page,
          pageSize: queueView.pageSize,
          timeout,
        });
      } else if (customId === "queue_remove") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to remove.", ephemeral: true });
          return;
        }
        const [removed] = queue.tracks.splice(selectedIndex - 1, 1);
        logInfo("Removed track via queue view", { title: removed?.title, user: interaction.user.tag });
        queueView.selectedTrackId = null;
      } else if (customId === "queue_front") {
        const selectedIndex = queueView.selectedTrackId
          ? getTrackIndexById(queue, queueView.selectedTrackId) + 1
          : 0;
        if (!selectedIndex || !queue.tracks[selectedIndex - 1]) {
          await interaction.reply({ content: "Select a track to move.", ephemeral: true });
          return;
        }
        const [moved] = queue.tracks.splice(selectedIndex - 1, 1);
        queue.tracks.unshift(moved);
        logInfo("Moved track to front via queue view", { title: moved?.title, user: interaction.user.tag });
        queueView.selectedTrackId = moved.id || queueView.selectedTrackId;
        queueView.page = 1;
      }

      queueView.stale = false;
      const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
      queueView.page = pageData.page;
      queueViews.set(interaction.message.id, queueView);
      await interaction.update({
        content: pageData.content,
        components: buildQueueViewComponents(queueView, queue),
      });
      return;
    }
  }

  if (interaction.isSelectMenu()) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Menus can only be used in a server.", ephemeral: true });
      return;
    }
    if (interaction.customId === "search_select") {
      const pending = pendingSearches.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That search has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.requesterId) {
        await interaction.reply({ content: "Only the requester can choose a result.", ephemeral: true });
        return;
      }
      const member = interaction.guild?.members?.resolve(interaction.user.id);
      const queue = getGuildQueue(interaction.guildId);
      if (!isSameVoiceChannel(member, queue)) {
        await interaction.reply({ content: "Join my voice channel to choose a result.", ephemeral: true });
        return;
      }
      const index = parseInt(interaction.values?.[0], 10);
      if (!Number.isFinite(index) || index < 0 || index >= pending.options.length) {
        await interaction.reply({ content: "Invalid selection.", ephemeral: true });
        return;
      }
      const selected = pending.options[index];
      pendingSearches.delete(interaction.message.id);
      clearTimeout(pending.timeout);

      queue.textChannel = interaction.channel;
      ensureTrackId(selected);
      queue.tracks.push(selected);
      logInfo("Queued from search chooser", {
        title: selected.title,
        guildId: interaction.guildId,
        requesterId: pending.requesterId,
      });

      const queuedIndex = getQueuedTrackIndex(queue, selected);
      const positionText = queuedIndex >= 0 ? ` (position ${queuedIndex + 1})` : "";
      const showQueuedControls = queuedIndex >= 1;
      await interaction.update({
        content: `Queued: **${selected.title}**${positionText} (requested by **${selected.requester || "unknown"}**).`,
        components: showQueuedControls ? buildQueuedActionComponents() : [],
      });
      if (showQueuedControls) {
        const timeout = setTimeout(async () => {
          const entry = pendingQueuedActions.get(interaction.message.id);
          if (!entry) {
            return;
          }
          pendingQueuedActions.delete(interaction.message.id);
          try {
            await interaction.message.edit({ components: [] });
          } catch (error) {
            logError("Failed to expire queued action controls", error);
          }
        }, INTERACTION_TIMEOUT_MS);
        pendingQueuedActions.set(interaction.message.id, {
          guildId: interaction.guildId,
          ownerId: interaction.user.id,
          trackId: selected.id,
          trackTitle: selected.title,
          timeout,
        });
      }

      if (!queue.playing) {
        playNext(interaction.guildId).catch((error) => {
          logError("Error starting playback", error);
        });
      }
      return;
    }

    if (interaction.customId === "queue_move_select") {
      const pending = pendingMoves.get(interaction.message.id);
      if (!pending) {
        await interaction.reply({ content: "That move request has expired.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== pending.ownerId) {
        await interaction.reply({ content: "Only the requester can move tracks.", ephemeral: true });
        return;
      }
      const queue = getGuildQueue(interaction.guildId);
      const sourceIndex = pending.trackId ? getTrackIndexById(queue, pending.trackId) + 1 : pending.sourceIndex;
      const destIndex = parseInt(interaction.values?.[0], 10);
      if (!sourceIndex || !queue.tracks[sourceIndex - 1]) {
        await interaction.reply({ content: "Selected track no longer exists.", ephemeral: true });
        return;
      }
      if (!Number.isFinite(destIndex) || destIndex < 1 || destIndex > queue.tracks.length) {
        await interaction.reply({ content: "Invalid destination.", ephemeral: true });
        return;
      }

      const [moved] = queue.tracks.splice(sourceIndex - 1, 1);
      const adjustedIndex = destIndex > sourceIndex ? destIndex - 1 : destIndex;
      queue.tracks.splice(adjustedIndex - 1, 0, moved);

      pendingMoves.delete(interaction.message.id);
      clearTimeout(pending.timeout);
      await interaction.update({ content: `Moved **${moved.title}** to position ${destIndex}.`, components: [] });

      const queueView = queueViews.get(pending.queueViewMessageId);
      if (queueView) {
        ensureTrackId(moved);
        queueView.selectedTrackId = moved.id;
        queueView.page = Math.floor((adjustedIndex - 1) / queueView.pageSize) + 1;
        queueView.stale = false;
        const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
        queueViews.set(pending.queueViewMessageId, queueView);
        try {
          const viewMessage = await interaction.channel.messages.fetch(pending.queueViewMessageId);
          await viewMessage.edit({
            content: pageData.content,
            components: buildQueueViewComponents(queueView, queue),
          });
        } catch (error) {
          logError("Failed to update queue view after move", error);
        }
      }
      return;
    }

    const queueView = queueViews.get(interaction.message.id);
    if (!queueView) {
      await interaction.reply({ content: "That queue view has expired.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== queueView.ownerId) {
      await interaction.reply({ content: "Only the requester can control this queue view.", ephemeral: true });
      return;
    }
    if (interaction.customId === "queue_select") {
      const selectedId = interaction.values?.[0];
      if (selectedId) {
        queueView.selectedTrackId = selectedId;
      }
      queueView.stale = false;
      const queue = getGuildQueue(interaction.guildId);
      const pageData = formatQueueViewContent(queue, queueView.page, queueView.pageSize, queueView.selectedTrackId, { stale: queueView.stale });
      queueViews.set(interaction.message.id, queueView);
      await interaction.update({
        content: pageData.content,
        components: buildQueueViewComponents(queueView, queue),
      });
      return;
    }
  }

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
          const entry = pendingQueuedActions.get(message.id);
          if (!entry) {
            return;
          }
          pendingQueuedActions.delete(message.id);
          try {
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
      return;
    }
  }
});
}

module.exports = {
  registerInteractionHandler,
};
