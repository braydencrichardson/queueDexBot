const { Client, GatewayIntentBits, Partials } = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  version: discordVoiceVersion,
} = require("@discordjs/voice");
const playdl = require("play-dl");
const sodium = require("libsodium-wrappers");
const dotenv = require("dotenv");
const { loadEnvVars } = require("./src/config/env");
const {
  BOT_ACTIVITY_NAME,
  BOT_ACTIVITY_TYPE,
  BOT_STATUS,
  INTERACTION_TIMEOUT_MS,
  PLAYBACK_LOADING_MESSAGE_DELAY_MS,
  QUEUE_INACTIVITY_TIMEOUT_MS,
  QUEUE_MOVE_MENU_PAGE_SIZE,
  QUEUE_VIEW_PAGE_SIZE,
  QUEUE_VIEW_TIMEOUT_MS,
  SEARCH_CHOOSER_MAX_RESULTS,
  SOUND_CLOUD_REDIRECT_MAX_HOPS,
  PROVIDER_REINIT_INTERVAL_MS,
  SPOTIFY_MARKET,
  SPOTIFY_DEFER_RESOLVE_BACKGROUND_INTERVAL_MS,
  TRACK_RESOLVER_HTTP_TIMEOUT_MS,
  YTDLP_STREAM_TIMEOUT_MS,
} = require("./src/config/constants");
const { createDiscordReconnectWatchdog } = require("./src/bot/discord-reconnect-watchdog");
const { createRuntimeState } = require("./src/bot/runtime-state");
const { createDevLogger } = require("./src/logging/dev-logger");
const { searchYouTubeOptions, searchYouTubePreferred, getYoutubeId, toShortYoutubeUrl } = require("./src/providers/youtube-search");
const { createProviderBootstrap } = require("./src/providers/provider-bootstrap");
const { createYoutubeResourceFactory } = require("./src/providers/youtube-resource");
const { createSoundcloudResourceFactory } = require("./src/providers/soundcloud-resource");
const { createTrackResolver } = require("./src/providers/track-resolver");
const { enqueueTracks, ensureTrackId, getTrackIndexById, getQueuedTrackIndex, formatDuration } = require("./src/queue/utils");
const { createQueuePlayback } = require("./src/queue/playback");
const { createQueueSession } = require("./src/queue/session");
const { createQueueService } = require("./src/queue/service");
const { createActivityInviteService } = require("./src/activity/invite-service");
const { buildQueueViewComponents, formatQueueViewContent, buildMoveMenu } = require("./src/ui/queueView");
const { buildQueuedActionComponents, buildNowPlayingControls, buildPlaylistQueuedComponents } = require("./src/ui/controls");
const { formatMovePrompt } = require("./src/ui/messages");
const { createSearchChooser } = require("./src/ui/search-chooser");
const { normalizeQueryInput } = require("./src/utils/query");
const { registerInteractionHandler } = require("./src/handlers/interaction");
const { registerReadyHandler } = require("./src/handlers/ready");
const { registerVoiceStateHandler } = require("./src/handlers/voice-state");
const { createAdminEventFeed } = require("./src/web/admin-event-feed");
const { createApiServer } = require("./src/web/api-server");

dotenv.config();
const env = loadEnvVars(process.env);

if (!env.token) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let discordLoginPromise = null;

const {
  queues,
  queueViews,
  pendingSearches,
  pendingMoves,
  pendingQueuedActions,
} = createRuntimeState();
const logger = createDevLogger({
  client,
  canSendDiscordMessages,
  devAlertChannelId: env.devAlertChannelId,
  devLogChannelId: env.devLogChannelId,
  level: env.logLevel,
  service: env.logServiceName,
  pretty: env.logPretty,
  logDir: env.logDir,
  maxFileSizeBytes: env.logMaxSizeBytes,
  maxFiles: env.logMaxFiles,
  discordLogLevel: env.devLogLevel,
  discordAlertLevel: env.devAlertLevel,
});
const adminEventFeed = createAdminEventFeed({
  maxEntries: 500,
});

function logInfo(message, data) {
  logger.logInfo(message, data);
  adminEventFeed.push({
    level: "info",
    service: env.logServiceName || "controller",
    message,
    data,
  });
}

function logError(message, data) {
  logger.logError(message, data);
  adminEventFeed.push({
    level: "error",
    service: env.logServiceName || "controller",
    message,
    data,
  });
}

function parseSemverTriplet(versionString) {
  const match = String(versionString || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function isVoiceVersionAtLeast019(versionString) {
  const parsed = parseSemverTriplet(versionString);
  if (!parsed) {
    return false;
  }
  if (parsed.major > 0) {
    return true;
  }
  return parsed.minor >= 19;
}

function toErrorSummary(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name || "Error",
    message: error.message || String(error),
  };
}

function probeDaveyRuntime() {
  const result = {
    dependencyResolvable: false,
    dependencyLoadable: false,
    protocolVersion: null,
    error: null,
  };
  try {
    require.resolve("@snazzah/davey");
    result.dependencyResolvable = true;
  } catch (error) {
    result.error = toErrorSummary(error);
    return result;
  }
  try {
    const davey = require("@snazzah/davey");
    result.dependencyLoadable = true;
    const protocolVersion = Number(davey?.DAVE_PROTOCOL_VERSION);
    result.protocolVersion = Number.isFinite(protocolVersion) ? protocolVersion : null;
  } catch (error) {
    result.error = toErrorSummary(error);
  }
  return result;
}

if (!isVoiceVersionAtLeast019(discordVoiceVersion)) {
  logError("Installed @discordjs/voice version may be incompatible with Discord voice encryption requirements", {
    installedVoiceVersion: discordVoiceVersion || "unknown",
    recommendedMinimumVoiceVersion: "0.19.0",
    nodeVersion: process.version,
    note: "Voice close code 4017 indicates DAVE/E2EE requirements from Discord voice.",
  });
}

const daveyRuntime = probeDaveyRuntime();
if (!daveyRuntime.dependencyResolvable) {
  logError("DAVE dependency missing; Discord voice connections may be rejected with close code 4017", {
    installedVoiceVersion: discordVoiceVersion || "unknown",
    nodeVersion: process.version,
    installCommand: "npm install @snazzah/davey",
    daveyRuntime,
  });
} else if (!daveyRuntime.dependencyLoadable || !daveyRuntime.protocolVersion || daveyRuntime.protocolVersion <= 0) {
  logError("DAVE dependency is installed but not loadable; Discord voice connections may be rejected with close code 4017", {
    installedVoiceVersion: discordVoiceVersion || "unknown",
    nodeVersion: process.version,
    installCommand: "npm install @snazzah/davey @snazzah/davey-linux-x64-gnu",
    daveyRuntime,
  });
}

logInfo("Voice runtime capabilities detected", {
  installedVoiceVersion: discordVoiceVersion || "unknown",
  nodeVersion: process.version,
  daveyRuntime,
});

const { sendDevAlert } = logger;
const activityInviteService = createActivityInviteService();

function canSendDiscordMessages() {
  if (!client) {
    return false;
  }
  if (discordLoginPromise) {
    return false;
  }
  if (typeof client.isReady === "function") {
    if (!client.isReady()) {
      return false;
    }
  }
  if (!client.user?.id) {
    return false;
  }
  const restClient = client.rest;
  const restExposesToken = Boolean(
    restClient
    && (Object.prototype.hasOwnProperty.call(restClient, "token") || "token" in restClient)
  );
  if (restExposesToken) {
    const restToken = restClient.token;
    const hasRestToken = typeof restToken === "string"
      ? restToken.trim().length > 0
      : Boolean(restToken);
    if (!hasRestToken) {
      return false;
    }
  }
  return true;
}

function getActivityApplicationId() {
  return String(client.application?.id || env.oauthClientId || "").trim();
}

async function resolveGuildChannelById(guildId, channelId) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim();
  if (!normalizedGuildId || !normalizedChannelId) {
    return null;
  }

  const guild = client.guilds?.cache?.get(normalizedGuildId);
  if (!guild) {
    return null;
  }

  const cached = guild.channels?.cache?.get(normalizedChannelId)
    || client.channels?.cache?.get(normalizedChannelId);
  if (cached) {
    return cached;
  }

  if (typeof guild.channels?.fetch === "function") {
    try {
      return await guild.channels.fetch(normalizedChannelId);
    } catch {
      return null;
    }
  }

  if (typeof client.channels?.fetch === "function") {
    try {
      return await client.channels.fetch(normalizedChannelId);
    } catch {
      return null;
    }
  }

  return null;
}

async function resolveVoiceChannelById(guildId, channelId) {
  return resolveGuildChannelById(guildId, channelId);
}

async function resolveTextChannelById(guildId, channelId) {
  const resolvedChannel = await resolveGuildChannelById(guildId, channelId);
  if (!resolvedChannel?.send) {
    return null;
  }
  return resolvedChannel;
}

async function prewarmActivityInviteOnPlaybackStart({ guildId, queue, track }) {
  if (!env.activityInvitePrewarmOnPlaybackStart) {
    return;
  }

  const applicationId = getActivityApplicationId();
  if (!applicationId) {
    return;
  }

  const queueVoiceChannelId = String(queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || "").trim();
  if (!queueVoiceChannelId) {
    return;
  }

  let voiceChannel = queue?.voiceChannel;
  if (!voiceChannel || typeof voiceChannel.createInvite !== "function") {
    voiceChannel = await resolveVoiceChannelById(guildId, queueVoiceChannelId);
  }
  if (!voiceChannel || typeof voiceChannel.createInvite !== "function") {
    logInfo("Skipping activity invite prewarm; queue voice channel is unavailable", {
      guildId,
      channelId: queueVoiceChannelId,
    });
    return;
  }

  const reasonTrackTitle = String(track?.title || "unknown track").trim().slice(0, 96) || "unknown track";
  try {
    const result = await activityInviteService.getOrCreateInvite({
      voiceChannel,
      applicationId,
      reason: `Activity invite prewarm on playback start (${reasonTrackTitle})`,
    });
    logInfo("Activity invite prewarm completed", {
      guildId,
      channel: voiceChannel.id,
      reused: Boolean(result?.reused),
    });
  } catch (error) {
    logError("Activity invite prewarm failed", {
      guildId,
      channelId: queueVoiceChannelId,
      error,
    });
  }
}

async function getNowPlayingActivityLinks(queue) {
  const webUrl = String(env.activityWebUrl || "").trim() || null;
  const applicationId = getActivityApplicationId();
  if (!applicationId) {
    return webUrl ? { webUrl } : null;
  }

  const queueVoiceChannelId = String(queue?.voiceChannel?.id || queue?.connection?.joinConfig?.channelId || "").trim();
  if (!queueVoiceChannelId) {
    return webUrl ? { webUrl } : null;
  }

  let voiceChannel = queue?.voiceChannel;
  if (!voiceChannel || typeof voiceChannel.createInvite !== "function") {
    voiceChannel = await resolveVoiceChannelById(queue?.guildId, queueVoiceChannelId);
  }
  if (!voiceChannel || typeof voiceChannel.createInvite !== "function") {
    return webUrl ? { webUrl } : null;
  }

  try {
    const inviteResult = await activityInviteService.getOrCreateInvite({
      voiceChannel,
      applicationId,
      reason: "Now playing activity link refresh",
    });
    return {
      inviteUrl: inviteResult.url,
      webUrl,
    };
  } catch (error) {
    logError("Failed to resolve activity invite for now playing content", {
      guildId: queue?.guildId || null,
      channelId: queueVoiceChannelId,
      error,
    });
    return webUrl ? { webUrl } : null;
  }
}

const {
  getSoundcloudClientId,
  getSoundcloudCookieHeader,
  getYoutubeCookiesNetscapePath,
  getProviderStatus,
  verifyProviderAuthStatus,
  hasSpotifyCredentials,
  tryCheckYoutubeCookiesOnFailure,
  ensureSoundcloudReady,
  ensureSpotifyReady,
  ensureYoutubeReady,
  warmupProviders,
  reinitializeProviders,
} = createProviderBootstrap({
  playdl,
  logInfo,
  logError,
  sendDevAlert,
  env: {
    youtubeCookies: env.youtubeCookies,
    youtubeCookiesPath: env.youtubeCookiesPath,
    youtubeUserAgent: env.youtubeUserAgent,
    soundcloudCookies: env.soundcloudCookies,
    soundcloudCookiesPath: env.soundcloudCookiesPath,
    soundcloudUserAgent: env.soundcloudUserAgent,
    spotifyClientId: env.spotifyClientId,
    spotifyClientSecret: env.spotifyClientSecret,
    spotifyRefreshToken: env.spotifyRefreshToken,
    spotifyMarket: SPOTIFY_MARKET,
  },
});

const {
  getSearchOptionsForQuery,
  getSpotifySearchOptions,
  isProbablyUrl,
  isSpotifyUrl,
  deferredResolveLookahead,
  hydrateDeferredTrackMetadata,
  resolveDeferredTrack,
  resolveTracks,
} = createTrackResolver({
  playdl,
  searchYouTubeOptions,
  searchYouTubePreferred,
  getYoutubeId,
  toShortYoutubeUrl,
  ensureSoundcloudReady,
  ensureYoutubeReady,
  ensureSpotifyReady,
  hasSpotifyCredentials,
  getSoundcloudClientId,
  getSoundcloudCookieHeader,
  sendDevAlert,
  searchChooserMaxResults: SEARCH_CHOOSER_MAX_RESULTS,
  soundcloudUserAgent: env.soundcloudUserAgent,
  youtubeUserAgent: env.youtubeUserAgent,
  spotifyClientId: env.spotifyClientId,
  spotifyClientSecret: env.spotifyClientSecret,
  spotifyRefreshToken: env.spotifyRefreshToken,
  spotifyMarket: SPOTIFY_MARKET,
  httpTimeoutMs: TRACK_RESOLVER_HTTP_TIMEOUT_MS,
  soundcloudRedirectMaxHops: SOUND_CLOUD_REDIRECT_MAX_HOPS,
  logInfo,
  logError,
});

async function ensureSodiumReady() {
  try {
    await sodium.ready;
  } catch (error) {
    logError("libsodium failed to initialize", error);
  }
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

async function waitForVoiceConnectionReady(connection, { timeoutMs = 12000, context = "voice-connection" } = {}) {
  if (!connection) {
    return false;
  }
  const startedAt = Date.now();
  const currentStatus = String(connection?.state?.status || "").toLowerCase();
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
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
    logInfo("Voice connection reached ready state", {
      context,
      elapsedMs: Date.now() - startedAt,
    });
    return true;
  } catch (error) {
    logInfo("Timed out waiting for voice connection ready state", {
      context,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      status: connection?.state?.status || null,
      error: error?.message || String(error),
    });
    return false;
  }
}

async function loginDiscordClient({ reason = "manual", destroyFirst = false } = {}) {
  if (discordLoginPromise) {
    logInfo("Discord login already in progress; skipping duplicate request", { reason });
    return discordLoginPromise;
  }

  discordLoginPromise = (async () => {
    if (destroyFirst) {
      try {
        client.destroy();
      } catch (error) {
        logError("Failed to destroy Discord client before relogin", error);
      }
    }

    logInfo("Attempting Discord login", {
      reason,
      destroyFirst: Boolean(destroyFirst),
    });
    return client.login(env.token);
  })();

  try {
    return await discordLoginPromise;
  } finally {
    discordLoginPromise = null;
  }
}

let playNext = async () => {
  throw new Error("playNext not initialized");
};
let ensureNextTrackPreload = async () => null;
let hydrateOneDeferredTrackMetadata = async () => false;
let resolveOneDeferredTrack = async () => false;
let ensureVoiceConnectionForSession = async () => null;

const {
  announceNowPlayingAction,
  ensurePlayerListeners,
  getGuildQueue,
  isSameVoiceChannel,
  maybeRefreshNowPlayingUpNext,
  sendNowPlaying,
  stopAndLeaveQueue,
} = createQueueSession({
  queues,
  createAudioPlayer,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  formatDuration,
  buildNowPlayingControls,
  logInfo,
  logError,
  getPlayNext: () => playNext,
  ensureNextTrackPreload: (queue) => ensureNextTrackPreload(queue),
  ensureVoiceConnection: (queue, options = {}) => ensureVoiceConnectionForSession(queue, options),
  getNowPlayingActivityLinks,
  showNowPlayingProgress: env.nowPlayingShowProgress,
  canSendDiscordMessages,
  resolveNowPlayingChannelById: async (channelId) => {
    if (!channelId) {
      return null;
    }
    const cached = client.channels?.cache?.get(channelId);
    if (cached) {
      return cached;
    }
    if (!client.channels?.fetch) {
      return null;
    }
    try {
      return await client.channels.fetch(channelId);
    } catch {
      return null;
    }
  },
});

async function ensureQueueVoiceConnection(queue, options = {}) {
  const forceReconnect = Boolean(options.forceReconnect);
  const normalizedGuildId = String(
    options.guildId
    || queue?.guildId
    || options.preferredVoiceChannel?.guild?.id
    || queue?.voiceChannel?.guild?.id
    || queue?.connection?.joinConfig?.guildId
    || ""
  ).trim();
  const preferredVoiceChannelId = String(options.preferredVoiceChannelId || "").trim();
  const queueVoiceChannelId = String(
    queue?.voiceChannel?.id
    || queue?.connection?.joinConfig?.channelId
    || ""
  ).trim();

  let targetVoiceChannel = options.preferredVoiceChannel || null;
  if (
    !targetVoiceChannel
    || !targetVoiceChannel?.id
    || !targetVoiceChannel?.guild?.voiceAdapterCreator
  ) {
    targetVoiceChannel = null;
  }

  if (!targetVoiceChannel && queue?.voiceChannel?.id && queue?.voiceChannel?.guild?.voiceAdapterCreator) {
    targetVoiceChannel = queue.voiceChannel;
  }

  if (!targetVoiceChannel) {
    const resolveChannelId = preferredVoiceChannelId || queueVoiceChannelId;
    if (resolveChannelId && normalizedGuildId) {
      targetVoiceChannel = await resolveVoiceChannelById(normalizedGuildId, resolveChannelId);
    }
  }

  if (!targetVoiceChannel?.id || !targetVoiceChannel?.guild?.voiceAdapterCreator) {
    return {
      ok: false,
      statusCode: 409,
      error: "No voice channel is available to resume playback.",
    };
  }

  const targetGuildId = String(targetVoiceChannel.guild?.id || normalizedGuildId || "").trim();
  const targetChannelId = String(targetVoiceChannel.id || "").trim();
  if (!targetGuildId || !targetChannelId) {
    return {
      ok: false,
      statusCode: 409,
      error: "No voice channel is available to resume playback.",
    };
  }

  queue.voiceChannel = targetVoiceChannel;

  const readLiveBotVoiceChannelId = () => String(
    targetVoiceChannel.guild?.members?.me?.voice?.channelId
    || targetVoiceChannel.guild?.members?.me?.voice?.channel?.id
    || ""
  ).trim() || null;
  const getLastVoiceCloseCode = (connection) => {
    const code = connection?.__queueDexLastNetworkingCloseCode;
    return Number.isFinite(code) ? code : null;
  };
  const liveBotVoiceChannelId = readLiveBotVoiceChannelId();
  const connectionChannelId = String(queue?.connection?.joinConfig?.channelId || "").trim() || null;

  if (forceReconnect && queue.connection && connectionChannelId === targetChannelId) {
    attachVoiceConnectionDiagnostics(queue.connection, {
      context: "ensureQueueVoiceConnection:force-reconnect-reuse",
      guildId: targetGuildId,
      channelId: targetChannelId,
    });

    const previousJoinConfig = queue.connection.joinConfig || {};
    if (typeof queue.connection.rejoin === "function") {
      try {
        const rejoinResult = queue.connection.rejoin({
          channelId: targetChannelId,
          guildId: targetGuildId,
          selfDeaf: typeof previousJoinConfig.selfDeaf === "boolean" ? previousJoinConfig.selfDeaf : true,
          selfMute: typeof previousJoinConfig.selfMute === "boolean" ? previousJoinConfig.selfMute : false,
        });
        logInfo("Attempted force reconnect via voice connection rejoin", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          rejoinResult: Boolean(rejoinResult),
          status: String(queue.connection?.state?.status || "").toLowerCase() || null,
        });
      } catch (error) {
        logError("Failed to issue voice connection rejoin during force reconnect", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          error,
        });
      }
    }

    const readyAfterRejoin = await waitForVoiceConnectionReady(queue.connection, {
      context: "ensureQueueVoiceConnection:force-reconnect-reuse",
    });
    if (readyAfterRejoin) {
      try {
        queue.connection.subscribe(queue.player);
      } catch (error) {
        logError("Failed to subscribe player after force reconnect rejoin", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          error,
        });
      }
      return {
        ok: true,
        reused: true,
        rejoined: true,
        guildId: targetGuildId,
        channelId: targetChannelId,
      };
    }

    if (getLastVoiceCloseCode(queue.connection) === 4017) {
      try {
        queue.connection.destroy();
      } catch (error) {
        logError("Failed to destroy voice connection after close code 4017 during force reconnect", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          error,
        });
      }
      queue.connection = null;
      return {
        ok: false,
        statusCode: 500,
        closeCode: 4017,
        error: "Discord voice rejected this connection (close code 4017). Update to a DAVE-compatible voice stack.",
      };
    }

    const liveBotVoiceChannelIdAfterSoftReconnect = readLiveBotVoiceChannelId();
    if (liveBotVoiceChannelIdAfterSoftReconnect === targetChannelId) {
      logInfo("Force reconnect remained signaling; preserving attached voice connection", {
        guildId: targetGuildId,
        channelId: targetChannelId,
        status: String(queue.connection?.state?.status || "").toLowerCase() || null,
      });
      try {
        queue.connection.subscribe(queue.player);
      } catch (error) {
        logError("Failed to subscribe signaling voice connection after force reconnect rejoin", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          error,
        });
      }
      return {
        ok: true,
        reused: true,
        signaling: true,
        preservedConnection: true,
        guildId: targetGuildId,
        channelId: targetChannelId,
      };
    }

    try {
      queue.connection.destroy();
    } catch (error) {
      logError("Failed to destroy non-ready force-reconnect connection before full rejoin", {
        guildId: targetGuildId,
        channelId: targetChannelId,
        error,
      });
    }
    queue.connection = null;
  }

  if (!forceReconnect && liveBotVoiceChannelId === targetChannelId && queue.connection && connectionChannelId === targetChannelId) {
    attachVoiceConnectionDiagnostics(queue.connection, {
      context: "ensureQueueVoiceConnection:reuse",
      guildId: targetGuildId,
      channelId: targetChannelId,
    });
    const ready = await waitForVoiceConnectionReady(queue.connection, {
      context: "ensureQueueVoiceConnection:reuse",
    });
    if (!ready) {
      const liveBotVoiceChannelIdAfterWait = readLiveBotVoiceChannelId();
      if (liveBotVoiceChannelIdAfterWait === targetChannelId) {
        logInfo("Existing voice connection still signaling during reuse; preserving connection", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          status: String(queue.connection?.state?.status || "").toLowerCase() || null,
        });
        try {
          queue.connection.subscribe(queue.player);
        } catch (error) {
          logError("Failed to subscribe signaling voice connection during reuse", {
            guildId: targetGuildId,
            channelId: targetChannelId,
            error,
          });
        }
        return {
          ok: true,
          reused: true,
          signaling: true,
          guildId: targetGuildId,
          channelId: targetChannelId,
        };
      }
      try {
        queue.connection.destroy();
      } catch (error) {
        logError("Failed to destroy non-ready voice connection before reconnect", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          error,
        });
      }
      queue.connection = null;
    } else {
      try {
        queue.connection.subscribe(queue.player);
      } catch (error) {
        logError("Failed to re-subscribe player to existing voice connection", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          error,
        });
      }
      return {
        ok: true,
        reused: true,
        guildId: targetGuildId,
        channelId: targetChannelId,
      };
    }
  }

  if (queue.connection) {
    try {
      queue.connection.destroy();
    } catch (error) {
      logError("Failed to destroy stale voice connection before resume reconnect", {
        guildId: targetGuildId,
        channelId: connectionChannelId,
        error,
      });
    }
    queue.connection = null;
  }

  await ensureSodiumReady();

  try {
    queue.connection = joinVoiceChannel({
      channelId: targetChannelId,
      guildId: targetGuildId,
      adapterCreator: targetVoiceChannel.guild.voiceAdapterCreator,
    });
    attachVoiceConnectionDiagnostics(queue.connection, {
      context: forceReconnect ? "ensureQueueVoiceConnection:force-reconnect" : "ensureQueueVoiceConnection:join",
      guildId: targetGuildId,
      channelId: targetChannelId,
    });
    queue.connection.on("error", (error) => {
      logError("Voice connection error", error);
    });
    ensurePlayerListeners(queue, targetGuildId);
    const ready = await waitForVoiceConnectionReady(queue.connection, {
      context: "ensureQueueVoiceConnection:join",
    });
    if (!ready) {
      const lastCloseCode = getLastVoiceCloseCode(queue.connection);
      if (lastCloseCode === 4017) {
        try {
          queue.connection.destroy();
        } catch (destroyError) {
          logError("Failed to destroy voice connection after close code 4017 during join", {
            guildId: targetGuildId,
            channelId: targetChannelId,
            error: destroyError,
          });
        }
        queue.connection = null;
        return {
          ok: false,
          statusCode: 500,
          closeCode: 4017,
          error: "Discord voice rejected this connection (close code 4017). Update to a DAVE-compatible voice stack.",
        };
      }
      const liveBotVoiceChannelIdAfterWait = readLiveBotVoiceChannelId();
      if (liveBotVoiceChannelIdAfterWait === targetChannelId) {
        logInfo(
          forceReconnect
            ? "Force reconnect join remained signaling; preserving connection"
            : "Voice connection still signaling after join wait; proceeding",
          {
          guildId: targetGuildId,
          channelId: targetChannelId,
          status: String(queue.connection?.state?.status || "").toLowerCase() || null,
          }
        );
        try {
          queue.connection.subscribe(queue.player);
        } catch (error) {
          logError(
            forceReconnect
              ? "Failed to subscribe signaling voice connection after force reconnect join wait"
              : "Failed to subscribe signaling voice connection after join wait",
            {
            guildId: targetGuildId,
            channelId: targetChannelId,
            error,
            }
          );
        }
        return {
          ok: true,
          joined: true,
          signaling: true,
          preservedConnection: Boolean(forceReconnect),
          guildId: targetGuildId,
          channelId: targetChannelId,
        };
      }
      try {
        queue.connection.destroy();
      } catch (destroyError) {
        logError("Failed to destroy non-ready voice connection after join attempt", {
          guildId: targetGuildId,
          channelId: targetChannelId,
          error: destroyError,
        });
      }
      queue.connection = null;
      return {
        ok: false,
        statusCode: 500,
        error: forceReconnect
          ? "Voice reconnect did not reach ready state."
          : "I couldn't complete voice setup for that channel.",
      };
    }
    queue.connection.subscribe(queue.player);
    return {
      ok: true,
      joined: true,
      guildId: targetGuildId,
      channelId: targetChannelId,
    };
  } catch (error) {
    queue.connection = null;
    logError("Failed to establish voice connection for resume", {
      guildId: targetGuildId,
      channelId: targetChannelId,
      error,
    });
    return {
      ok: false,
      statusCode: 500,
      error: "I couldn't rejoin the voice channel.",
    };
  }
}
ensureVoiceConnectionForSession = ensureQueueVoiceConnection;

const queueService = createQueueService({
  stopAndLeaveQueue,
  maybeRefreshNowPlayingUpNext,
  sendNowPlaying,
  ensureTrackId,
  ensureVoiceConnection: ensureQueueVoiceConnection,
});

let gatewayReconnectWatchdog = null;

const apiServer = env.authServerEnabled
  ? createApiServer({
    queues,
    logInfo,
    logError,
    getQueueForGuild: (guildId) => getGuildQueue(guildId),
    isBotInGuild: (guildId) => {
      const normalizedGuildId = String(guildId || "").trim();
      if (!normalizedGuildId) {
        return false;
      }
      if (typeof client.isReady === "function" && !client.isReady()) {
        return true;
      }
      return Boolean(client.guilds?.cache?.has(normalizedGuildId));
    },
    isUserInGuild: async (guildId, userId) => {
      const normalizedGuildId = String(guildId || "").trim();
      const normalizedUserId = String(userId || "").trim();
      if (!normalizedGuildId || !normalizedUserId) {
        return false;
      }
      const guild = client.guilds?.cache?.get(normalizedGuildId);
      if (!guild) {
        return false;
      }

      if (guild.members?.cache?.has(normalizedUserId)) {
        return true;
      }

      if (typeof guild.members?.fetch !== "function") {
        return false;
      }

      try {
        const member = await guild.members.fetch(normalizedUserId);
        return Boolean(member?.id === normalizedUserId);
      } catch {
        return false;
      }
    },
    getBotGuilds: () => Array.from(client.guilds?.cache?.values?.() || [])
      .map((guild) => ({
        id: guild?.id || null,
        name: guild?.name || null,
      }))
      .filter((guild) => guild.id),
    getUserVoiceChannelId: async (guildId, userId) => {
      const normalizedGuildId = String(guildId || "").trim();
      const normalizedUserId = String(userId || "").trim();
      if (!normalizedGuildId || !normalizedUserId) {
        return null;
      }
      const guild = client.guilds?.cache?.get(normalizedGuildId);
      if (!guild) {
        return null;
      }

      const voiceState = guild.voiceStates?.cache?.get(normalizedUserId);
      if (voiceState?.channelId) {
        return voiceState.channelId;
      }

      let member = guild.members?.cache?.get(normalizedUserId) || null;
      if (!member && typeof guild.members?.fetch === "function") {
        try {
          member = await guild.members.fetch(normalizedUserId);
        } catch {
          return null;
        }
      }
      return member?.voice?.channelId || member?.voice?.channel?.id || null;
    },
    resolveTextChannelById,
    getAdminEvents: ({ minLevel, limit }) => adminEventFeed.list({ minLevel, limit }),
    getProviderStatus,
    verifyProviderAuthStatus,
    reinitializeProviders,
    getDiscordGatewayStatus: async () => gatewayReconnectWatchdog?.getState?.() || null,
    forceDiscordRelogin: async ({ reason } = {}) => {
      loginDiscordClient({
        reason: reason || "api-admin-force-relogin",
        destroyFirst: true,
      }).catch((error) => {
        logError("Admin-triggered Discord relogin failed", {
          reason: reason || "api-admin-force-relogin",
          error,
        });
      });
      return {
        accepted: true,
        inFlight: true,
      };
    },
    queueService,
    stopAndLeaveQueue,
    maybeRefreshNowPlayingUpNext,
    sendNowPlaying,
    normalizeQueryInput,
    resolveTracks,
    getSearchOptionsForQuery,
    ensureQueueVoiceConnection,
    ensureTrackId,
    getPlayNext: () => playNext,
    config: {
      oauthClientId: env.oauthClientId,
      oauthClientSecret: env.oauthClientSecret,
      oauthWebRedirectUri: env.oauthWebRedirectUri,
      oauthActivityRedirectUri: env.oauthActivityRedirectUri,
      oauthScopes: env.oauthScopes,
      host: env.authServerHost,
      port: env.authServerPort,
      activityQueueSearchConcurrency: env.activityQueueSearchConcurrency,
      sessionTtlMs: env.authSessionTtlMs,
      cookieName: env.authSessionCookieName,
      cookieSecure: env.authSessionCookieSecure,
      sessionStoreEnabled: env.authSessionStoreEnabled,
      sessionStorePath: env.authSessionStorePath,
      adminUserIds: env.authAdminUserIds,
    },
  })
  : null;

if (apiServer) {
  apiServer.start();
} else {
  logInfo("API/Auth server disabled by AUTH_SERVER_ENABLED=0");
}

const { trySendSearchChooser } = createSearchChooser({
  formatDuration,
  interactionTimeoutMs: INTERACTION_TIMEOUT_MS,
  pendingSearches,
  logInfo,
  logError,
});

const { createYoutubeResource } = createYoutubeResourceFactory({
  createAudioResource,
  StreamType,
  logInfo,
  tryCheckYoutubeCookiesOnFailure,
  getYoutubeCookiesNetscapePath,
  config: {
    ytdlpPath: env.ytdlpPath,
    ytdlpPlayerClient: env.ytdlpPlayerClient,
    ytdlpFallbackPlayerClient: env.ytdlpFallbackPlayerClient,
    ytdlpCookiesFromBrowser: env.ytdlpCookiesFromBrowser,
    ytdlpJsRuntime: env.ytdlpJsRuntime,
    ytdlpRemoteComponents: env.ytdlpRemoteComponents,
    ytdlpStream: env.ytdlpStream,
    ytdlpConcurrentFragments: env.ytdlpConcurrentFragments,
    ytdlpStreamTimeoutMs: YTDLP_STREAM_TIMEOUT_MS,
    youtubeUserAgent: env.youtubeUserAgent,
  },
});

const { createSoundcloudResource } = createSoundcloudResourceFactory({
  playdl,
  createAudioResource,
  StreamType,
});

({ playNext, ensureNextTrackPreload, hydrateOneDeferredTrackMetadata, resolveOneDeferredTrack } = createQueuePlayback({
  client,
  playdl,
  createAudioResource,
  StreamType,
  createYoutubeResource,
  createSoundcloudResource,
  getGuildQueue,
  queueViews,
  pendingMoves,
  formatQueueViewContent,
  buildQueueViewComponents,
  buildMoveMenu,
  formatMovePrompt,
  sendNowPlaying,
  loadingMessageDelayMs: PLAYBACK_LOADING_MESSAGE_DELAY_MS,
  deferredResolveLookahead,
  hydrateDeferredTrackMetadata,
  resolveDeferredTrack,
  onPlaybackStarted: prewarmActivityInviteOnPlaybackStart,
  logInfo,
  logError,
}));

let deferredResolveCursor = 0;
let providerReinitInterval = null;
const deferredResolveInterval = setInterval(() => {
  const entries = Array.from(queues.entries())
    .filter(([, queue]) => Array.isArray(queue?.tracks) && queue.tracks.some((track) => track?.pendingResolve));
  if (!entries.length) {
    return;
  }
  deferredResolveCursor %= entries.length;
  const [guildId, queue] = entries[deferredResolveCursor];
  deferredResolveCursor = (deferredResolveCursor + 1) % entries.length;
  hydrateOneDeferredTrackMetadata(queue, { context: "background-meta" })
    .then((hydrated) => {
      if (hydrated) {
        return null;
      }
      return resolveOneDeferredTrack(queue, { context: "background" });
    })
    .catch((error) => {
    logError("Background deferred track resolve failed", { guildId, error });
  });
}, SPOTIFY_DEFER_RESOLVE_BACKGROUND_INTERVAL_MS);
if (typeof deferredResolveInterval.unref === "function") {
  deferredResolveInterval.unref();
}

registerReadyHandler(client, {
  logInfo,
  logError,
  presence: {
    status: BOT_STATUS,
    activityName: BOT_ACTIVITY_NAME,
    activityType: BOT_ACTIVITY_TYPE,
  },
  onReady: async () => {
    await warmupProviders();
    if (providerReinitInterval) {
      clearInterval(providerReinitInterval);
    }
    providerReinitInterval = setInterval(() => {
      reinitializeProviders()
        .then((status) => {
          logInfo("Periodic provider re-initialization completed", status);
          if (!status?.soundcloudReady || !status?.youtubeReady || (status?.hasSpotifyCredentials && !status?.spotifyReady)) {
            void sendDevAlert(`Periodic provider re-initialization reported degraded status: ${JSON.stringify(status)}`);
          }
        })
        .catch((error) => {
          logError("Periodic provider re-initialization failed", error);
        });
    }, PROVIDER_REINIT_INTERVAL_MS);
    if (typeof providerReinitInterval.unref === "function") {
      providerReinitInterval.unref();
    }
  },
});
registerVoiceStateHandler(client, {
  queues,
  stopAndLeaveQueue,
  logInfo,
  logError,
  AudioPlayerStatus,
  inactivityTimeoutMs: QUEUE_INACTIVITY_TIMEOUT_MS,
});

gatewayReconnectWatchdog = createDiscordReconnectWatchdog({
  client,
  logInfo,
  logError,
  relogin: async ({ reason, attempt, shardIds } = {}) => {
    await loginDiscordClient({
      reason: `watchdog:${reason || "unknown"}:attempt:${attempt || 1}:shards:${Array.isArray(shardIds) ? shardIds.join(",") : "unknown"}`,
      destroyFirst: true,
    });
  },
  enabled: env.discordGatewayWatchdogEnabled,
  checkIntervalMs: env.discordGatewayWatchdogCheckIntervalMs,
  disconnectThresholdMs: env.discordGatewayWatchdogDisconnectThresholdMs,
  backoffBaseMs: env.discordGatewayWatchdogBackoffBaseMs,
  backoffMaxMs: env.discordGatewayWatchdogBackoffMaxMs,
});
gatewayReconnectWatchdog.start();

client.on("error", (error) => {
  logError("Discord client error", error);
});

client.on("shardError", (error, shardId) => {
  logError("Discord shard error", {
    shardId: Number.isInteger(shardId) ? shardId : null,
    name: error?.name || "Error",
    message: error?.message || String(error || ""),
    stack: error?.stack || null,
    code: error?.code || null,
  });
});

client.on("shardDisconnect", (event, shardId) => {
  logError("Discord shard disconnected", {
    shardId: Number.isInteger(shardId) ? shardId : null,
    code: event?.code ?? null,
    reason: event?.reason ?? null,
    wasClean: typeof event?.wasClean === "boolean" ? event.wasClean : null,
  });
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", reason);
});

registerInteractionHandler(client, {
  AudioPlayerStatus,
  INTERACTION_TIMEOUT_MS,
  QUEUE_VIEW_PAGE_SIZE,
  QUEUE_VIEW_TIMEOUT_MS,
  QUEUE_MOVE_MENU_PAGE_SIZE,
  joinVoiceChannel,
  getVoiceConnection,
  getGuildQueue,
  isSameVoiceChannel,
  announceNowPlayingAction,
  buildNowPlayingControls,
  formatQueueViewContent,
  buildQueueViewComponents,
  buildMoveMenu,
  buildQueuedActionComponents,
  buildPlaylistQueuedComponents,
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
  maybeRefreshNowPlayingUpNext,
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
  queueService,
  activityInviteService,
  getActivityApplicationId,
  resolveVoiceChannelById,
  activityWebUrl: env.activityWebUrl,
});

loginDiscordClient({ reason: "startup", destroyFirst: false }).catch((error) => {
  logError("Failed to login to Discord", error);
  process.exit(1);
});
