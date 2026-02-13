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
const { createRuntimeState } = require("./src/bot/runtime-state");
const { createDevLogger } = require("./src/logging/dev-logger");
const { searchYouTubeOptions, searchYouTubePreferred, getYoutubeId, toShortYoutubeUrl } = require("./src/providers/youtube-search");
const { createProviderBootstrap } = require("./src/providers/provider-bootstrap");
const { createYoutubeResourceFactory } = require("./src/providers/youtube-resource");
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
    spotifyMarket: env.spotifyMarket,
  },
});

const {
  getSearchOptionsForQuery,
  getSpotifySearchOptions,
  isProbablyUrl,
  isSpotifyUrl,
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
  searchChooserMaxResults: env.searchChooserMaxResults,
  soundcloudUserAgent: env.soundcloudUserAgent,
  youtubeUserAgent: env.youtubeUserAgent,
  httpTimeoutMs: env.trackResolverHttpTimeoutMs,
  soundcloudRedirectMaxHops: env.soundcloudRedirectMaxHops,
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
  interactionTimeoutMs: env.interactionTimeoutMs,
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
    ytdlpStreamTimeoutMs: env.ytdlpStreamTimeoutMs,
    youtubeUserAgent: env.youtubeUserAgent,
  },
});

({ playNext } = createQueuePlayback({
  client,
  playdl,
  createAudioResource,
  StreamType,
  createYoutubeResource,
  getGuildQueue,
  queueViews,
  pendingMoves,
  formatQueueViewContent,
  buildQueueViewComponents,
  buildMoveMenu,
  formatMovePrompt,
  sendNowPlaying,
  maybeRefreshNowPlayingUpNext,
  loadingMessageDelayMs: env.playbackLoadingMessageDelayMs,
  logInfo,
  logError,
}));

registerReadyHandler(client, {
  logInfo,
  logError,
  presence: {
    status: env.botStatus,
    activityName: env.botActivityName,
    activityType: env.botActivityType,
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
  inactivityTimeoutMs: env.queueInactivityTimeoutMs,
});

client.on("error", (error) => {
  logError("Discord client error", error);
});

client.on("shardError", (error) => {
  logError("Discord shard error", error);
});

registerInteractionHandler(client, {
  AudioPlayerStatus,
  INTERACTION_TIMEOUT_MS: env.interactionTimeoutMs,
  QUEUE_VIEW_PAGE_SIZE: env.queueViewPageSize,
  QUEUE_VIEW_TIMEOUT_MS: env.queueViewTimeoutMs,
  QUEUE_MOVE_MENU_PAGE_SIZE: env.queueMoveMenuPageSize,
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
