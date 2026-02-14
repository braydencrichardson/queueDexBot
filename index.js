const { Client, Intents } = require("discord.js");
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
const { buildQueueViewComponents, formatQueueViewContent, buildMoveMenu } = require("./src/ui/queueView");
const { buildQueuedActionComponents, buildNowPlayingControls, buildPlaylistQueuedComponents } = require("./src/ui/controls");
const { formatMovePrompt } = require("./src/ui/messages");
const { createSearchChooser } = require("./src/ui/search-chooser");
const { normalizeQueryInput } = require("./src/utils/query");
const { registerInteractionHandler } = require("./src/handlers/interaction");
const { registerReadyHandler } = require("./src/handlers/ready");
const { registerVoiceStateHandler } = require("./src/handlers/voice-state");

dotenv.config();
const env = loadEnvVars(process.env);

if (!env.token) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Intents.FLAGS.GUILD_VOICE_STATES,
  ],
  partials: ["MESSAGE", "CHANNEL", "REACTION"],
});

const {
  queues,
  queueViews,
  pendingSearches,
  pendingMoves,
  pendingQueuedActions,
} = createRuntimeState();
const { logInfo, logError, sendDevAlert } = createDevLogger({
  client,
  devAlertChannelId: env.devAlertChannelId,
  devLogChannelId: env.devLogChannelId,
});

const {
  getSoundcloudClientId,
  getYoutubeCookiesNetscapePath,
  hasSpotifyCredentials,
  tryCheckYoutubeCookiesOnFailure,
  ensureSoundcloudReady,
  ensureSpotifyReady,
  ensureYoutubeReady,
  warmupProviders,
} = createProviderBootstrap({
  playdl,
  logInfo,
  logError,
  sendDevAlert,
  env: {
    youtubeCookies: env.youtubeCookies,
    youtubeCookiesPath: env.youtubeCookiesPath,
    youtubeUserAgent: env.youtubeUserAgent,
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
  logInfo,
  logError,
}));

let deferredResolveCursor = 0;
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
});

client.login(env.token).catch((error) => {
  logError("Failed to login to Discord", error);
  process.exit(1);
});
