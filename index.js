const { Client, GatewayIntentBits, Partials } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
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

const {
  queues,
  queueViews,
  pendingSearches,
  pendingMoves,
  pendingQueuedActions,
} = createRuntimeState();
const logger = createDevLogger({
  client,
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

const { sendDevAlert } = logger;
const activityInviteService = createActivityInviteService();

function getActivityApplicationId() {
  return String(client.application?.id || env.oauthClientId || "").trim();
}

async function resolveVoiceChannelById(guildId, channelId) {
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

let playNext = async () => {
  throw new Error("playNext not initialized");
};
let ensureNextTrackPreload = async () => null;
let hydrateOneDeferredTrackMetadata = async () => false;
let resolveOneDeferredTrack = async () => false;

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
  getNowPlayingActivityLinks,
  showNowPlayingProgress: env.nowPlayingShowProgress,
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

const queueService = createQueueService({
  stopAndLeaveQueue,
  maybeRefreshNowPlayingUpNext,
  sendNowPlaying,
  ensureTrackId,
});

const apiServer = env.authServerEnabled
  ? createApiServer({
    queues,
    logInfo,
    logError,
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
    getAdminEvents: ({ minLevel, limit }) => adminEventFeed.list({ minLevel, limit }),
    getProviderStatus,
    verifyProviderAuthStatus,
    reinitializeProviders,
    queueService,
    stopAndLeaveQueue,
    maybeRefreshNowPlayingUpNext,
    sendNowPlaying,
    config: {
      oauthClientId: env.oauthClientId,
      oauthClientSecret: env.oauthClientSecret,
      oauthWebRedirectUri: env.oauthWebRedirectUri,
      oauthActivityRedirectUri: env.oauthActivityRedirectUri,
      oauthScopes: env.oauthScopes,
      host: env.authServerHost,
      port: env.authServerPort,
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

client.on("error", (error) => {
  logError("Discord client error", error);
});

client.on("shardError", (error) => {
  logError("Discord shard error", error);
});

registerInteractionHandler(client, {
  AudioPlayerStatus,
  INTERACTION_TIMEOUT_MS,
  QUEUE_VIEW_PAGE_SIZE,
  QUEUE_VIEW_TIMEOUT_MS,
  QUEUE_MOVE_MENU_PAGE_SIZE,
  joinVoiceChannel,
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

client.login(env.token).catch((error) => {
  logError("Failed to login to Discord", error);
  process.exit(1);
});
