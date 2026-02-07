function registerVoiceStateHandler(client, deps) {
  const {
    queues,
    stopAndLeaveQueue,
    logInfo,
    logError,
    AudioPlayerStatus,
    inactivityTimeoutMs,
  } = deps;

  function getListenerCount(channel) {
    if (!channel?.members) {
      return 0;
    }
    return channel.members.filter((member) => !member.user.bot).size;
  }

  function getQueueVoiceChannel(queue) {
    return queue?.voiceChannel?.guild?.channels?.cache?.get(queue.voiceChannel.id) || queue?.voiceChannel;
  }

  function formatTimeoutLabel(timeoutMs) {
    const safeMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300000;
    const totalSeconds = Math.max(1, Math.round(safeMs / 1000));
    if (totalSeconds % 60 === 0) {
      const minutes = totalSeconds / 60;
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  async function upsertInactivityNotice(queue, content) {
    const channel = queue?.textChannel;
    if (!channel?.send) {
      return null;
    }

    let message = null;
    if (queue.inactivityNoticeMessageId && queue.inactivityNoticeChannelId === channel.id && channel.messages?.fetch) {
      try {
        message = await channel.messages.fetch(queue.inactivityNoticeMessageId);
        await message.edit({ content });
      } catch {
        message = null;
      }
    }

    if (!message) {
      try {
        message = await channel.send(content);
      } catch (error) {
        if (typeof logError === "function") {
          logError("Failed to send inactivity notice", error);
        } else {
          console.error("Failed to send inactivity notice", error);
        }
        return null;
      }
    }

    queue.inactivityNoticeMessageId = message.id;
    queue.inactivityNoticeChannelId = message.channel.id;
    return message;
  }

  async function clearInactivityNotice(queue) {
    const noticeMessageId = queue?.inactivityNoticeMessageId;
    const noticeChannelId = queue?.inactivityNoticeChannelId;
    const channel = queue?.textChannel;
    queue.inactivityNoticeMessageId = null;
    queue.inactivityNoticeChannelId = null;

    if (!noticeMessageId || !channel || noticeChannelId !== channel.id || !channel.messages?.fetch) {
      return;
    }

    try {
      const message = await channel.messages.fetch(noticeMessageId);
      await message.delete();
    } catch (error) {
      if (typeof logError === "function") {
        logError("Failed to clear inactivity notice", error);
      } else {
        console.error("Failed to clear inactivity notice", error);
      }
    }
  }

  client.on("voiceStateUpdate", async (oldState, newState) => {
    try {
      const guildId = newState.guild?.id || oldState.guild?.id;
      if (!guildId) {
        return;
      }

      const queue = queues.get(guildId);
      if (!queue?.voiceChannel) {
        return;
      }

      const channel = getQueueVoiceChannel(queue);
      if (!channel?.members) {
        return;
      }

      const timeoutMs = Number.isFinite(inactivityTimeoutMs) && inactivityTimeoutMs > 0
        ? inactivityTimeoutMs
        : 300000;
      const listenerCount = getListenerCount(channel);

      if (listenerCount === 0) {
        if (!queue.inactivityTimeout) {
          if (queue.player?.state?.status === AudioPlayerStatus.Playing) {
            queue.player.pause();
            queue.pausedForInactivity = true;
          } else {
            queue.pausedForInactivity = false;
          }

          await upsertInactivityNotice(
            queue,
            `No listeners detected. Paused playback. I will clear the queue and leave in ${formatTimeoutLabel(timeoutMs)} if nobody rejoins.`
          );

          queue.inactivityTimeout = setTimeout(async () => {
            try {
              queue.inactivityTimeout = null;

              const activeChannel = getQueueVoiceChannel(queue);
              const activeListenerCount = getListenerCount(activeChannel);
              if (activeListenerCount > 0) {
                if (queue.pausedForInactivity && queue.player?.state?.status === AudioPlayerStatus.Paused) {
                  queue.player.unpause();
                }
                queue.pausedForInactivity = false;
                await clearInactivityNotice(queue);
                return;
              }

              const noticeMessageId = queue.inactivityNoticeMessageId;
              const noticeChannelId = queue.inactivityNoticeChannelId;
              const noticeChannel = queue.textChannel;

              stopAndLeaveQueue(queue, "Voice channel inactive timeout reached. Clearing queue and leaving.");

              if (noticeChannel?.send) {
                const leaveMessage = `No listeners returned after ${formatTimeoutLabel(timeoutMs)}. Cleared the queue and left the voice channel.`;
                if (noticeMessageId && noticeChannelId === noticeChannel.id && noticeChannel.messages?.fetch) {
                  try {
                    const message = await noticeChannel.messages.fetch(noticeMessageId);
                    await message.edit({ content: leaveMessage });
                    return;
                  } catch {
                    // fall through to send a new message
                  }
                }
                await noticeChannel.send(leaveMessage);
              }
            } catch (error) {
              if (typeof logError === "function") {
                logError("Failed to handle voice inactivity timeout", error);
                return;
              }
              console.error("Failed to handle voice inactivity timeout", error);
            }
          }, timeoutMs);

          if (typeof logInfo === "function") {
            logInfo("Voice channel empty; started inactivity timeout", { guildId, timeoutMs });
          }
        }
        return;
      }

      if (queue.inactivityTimeout) {
        clearTimeout(queue.inactivityTimeout);
        queue.inactivityTimeout = null;
        if (typeof logInfo === "function") {
          logInfo("Listener rejoined; canceled inactivity timeout", { guildId });
        }
      }

      if (queue.pausedForInactivity && queue.player?.state?.status === AudioPlayerStatus.Paused) {
        queue.player.unpause();
      }
      queue.pausedForInactivity = false;
      await clearInactivityNotice(queue);
    } catch (error) {
      if (typeof logError === "function") {
        logError("Voice state handler failed", error);
        return;
      }
      console.error("Voice state handler failed", error);
    }
  });
}

module.exports = {
  registerVoiceStateHandler,
};
