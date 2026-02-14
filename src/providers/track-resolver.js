const https = require("https");
const { normalizeIncomingUrl } = require("../utils/url-normalization");
const {
  SOUND_CLOUD_REDIRECT_MAX_HOPS: CONFIG_SOUND_CLOUD_REDIRECT_MAX_HOPS,
  TRACK_RESOLVER_HTTP_TIMEOUT_MS: CONFIG_TRACK_RESOLVER_HTTP_TIMEOUT_MS,
  SPOTIFY_YOUTUBE_MIN_ARTIST_RATIO,
  SPOTIFY_YOUTUBE_MIN_TITLE_RATIO,
  SPOTIFY_YOUTUBE_DURATION_STRICT_MAX_DELTA_SECONDS,
  SPOTIFY_YOUTUBE_DURATION_MAX_DELTA_SECONDS,
  SPOTIFY_YOUTUBE_CANDIDATE_LIMIT,
  SPOTIFY_DEFER_RESOLVE_MIN_TRACKS,
  SPOTIFY_DEFER_RESOLVE_EAGER_COUNT,
  SPOTIFY_DEFER_METADATA_PREFETCH_COUNT,
  SPOTIFY_DEFER_RESOLVE_LOOKAHEAD,
} = require("../config/constants");
const { createResolverHttpClient } = require("./resolver-http");
const { createSpotifyResolver } = require("./spotify-resolver");
const { createSoundcloudResolver } = require("./soundcloud-resolver");
const { createYoutubeResolver } = require("./youtube-resolver");
const { createSpotifyApiClient } = require("./spotify-api-client");
const {
  isProbablyUrl,
  isValidYouTubeVideoId,
  normalizeResolverQuery,
} = require("./query-parser");

function createTrackResolver(deps) {
  const {
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
    searchChooserMaxResults,
    soundcloudUserAgent,
    youtubeUserAgent,
    spotifyClientId,
    spotifyClientSecret,
    spotifyRefreshToken,
    spotifyMarket,
    httpTimeoutMs,
    soundcloudRedirectMaxHops,
    httpsModule = https,
    logInfo,
    logError,
  } = deps;

  const requestTimeoutMs = Number.isFinite(httpTimeoutMs) && httpTimeoutMs > 0
    ? httpTimeoutMs
    : CONFIG_TRACK_RESOLVER_HTTP_TIMEOUT_MS;
  const redirectMaxHops = Number.isFinite(soundcloudRedirectMaxHops) && soundcloudRedirectMaxHops > 0
    ? soundcloudRedirectMaxHops
    : CONFIG_SOUND_CLOUD_REDIRECT_MAX_HOPS;

  const { httpGetJson, httpGetText, resolveRedirect } = createResolverHttpClient({
    httpsModule,
    requestTimeoutMs,
    redirectMaxHops,
    soundcloudUserAgent,
    youtubeUserAgent,
  });

  const spotifyApiClient = createSpotifyApiClient({
    clientId: spotifyClientId,
    clientSecret: spotifyClientSecret,
    refreshToken: spotifyRefreshToken,
    market: spotifyMarket,
    httpsModule,
    requestTimeoutMs,
    logInfo,
  });

  const spotifyResolver = createSpotifyResolver({
    playdl,
    searchYouTubeOptions,
    searchYouTubePreferred,
    ensureSpotifyReady,
    hasSpotifyCredentials,
    searchChooserMaxResults,
    youtubeUserAgent,
    httpGetJson,
    httpGetText,
    spotifyYoutubeMinTitleRatio: SPOTIFY_YOUTUBE_MIN_TITLE_RATIO,
    spotifyYoutubeMinArtistRatio: SPOTIFY_YOUTUBE_MIN_ARTIST_RATIO,
    spotifyYoutubeDurationStrictMaxDeltaSeconds: SPOTIFY_YOUTUBE_DURATION_STRICT_MAX_DELTA_SECONDS,
    spotifyYoutubeDurationMaxDeltaSeconds: SPOTIFY_YOUTUBE_DURATION_MAX_DELTA_SECONDS,
    spotifyYoutubeCandidateLimit: SPOTIFY_YOUTUBE_CANDIDATE_LIMIT,
    spotifyDeferResolveMinTracks: SPOTIFY_DEFER_RESOLVE_MIN_TRACKS,
    spotifyDeferResolveEagerCount: SPOTIFY_DEFER_RESOLVE_EAGER_COUNT,
    spotifyDeferMetadataPrefetchCount: SPOTIFY_DEFER_METADATA_PREFETCH_COUNT,
    spotifyApiClient,
    logInfo,
    logError,
  });

  const soundcloudResolver = createSoundcloudResolver({
    playdl,
    getSoundcloudClientId,
    httpGetJson,
    resolveRedirect,
    logInfo,
    logError,
  });

  const youtubeResolver = createYoutubeResolver({
    playdl,
    getYoutubeId,
    toShortYoutubeUrl,
    searchYouTubePreferred,
    isProbablyUrl,
    isValidYouTubeVideoId,
  });

  function shouldPreResolveRedirect(query) {
    if (!isProbablyUrl(query)) {
      return false;
    }
    try {
      const parsed = new URL(query);
      const host = String(parsed.hostname || "").toLowerCase();
      return host === "spotify.link"
        || host === "spoti.fi"
        || host === "on.soundcloud.com"
        || host.endsWith(".spotify.com");
    } catch {
      return false;
    }
  }

  async function normalizeResolverQueryWithRedirects(query) {
    const normalized = normalizeResolverQuery(query, { normalizeIncomingUrl, logInfo });
    if (!shouldPreResolveRedirect(normalized)) {
      return normalized;
    }
    try {
      const redirected = await resolveRedirect(normalized);
      if (redirected && redirected !== normalized) {
        logInfo("Resolved redirect before track resolve", { from: normalized, to: redirected });
        return redirected;
      }
    } catch (error) {
      logError("Redirect pre-resolve failed", error);
    }
    return normalized;
  }

  async function getSearchOptionsForQuery(query, requester) {
    await ensureSoundcloudReady();
    await ensureYoutubeReady();
    const queryToResolve = await normalizeResolverQueryWithRedirects(query);

    if (spotifyResolver.isSpotifyUrl(queryToResolve)) {
      const normalizedSpotifyUrl = spotifyResolver.normalizeSpotifyUrl(queryToResolve);
      const spotifyType = playdl.sp_validate(normalizedSpotifyUrl);
      if (spotifyType === "track") {
        return spotifyResolver.getSpotifySearchOptions(normalizedSpotifyUrl, requester);
      }
      return [];
    }

    return searchYouTubeOptions(queryToResolve, requester, null, searchChooserMaxResults);
  }

  async function resolveTracks(query, requester, { allowSearchFallback = true, onProgress = null } = {}) {
    await ensureSoundcloudReady();
    await ensureYoutubeReady();
    const queryToResolve = await normalizeResolverQueryWithRedirects(query);

    const soundcloudResult = await soundcloudResolver.resolveSoundcloudContext(queryToResolve, requester);
    if (soundcloudResult.tracks.length) {
      return soundcloudResult.tracks;
    }
    if (soundcloudResult.discoverFailed) {
      throw new Error(
        "SoundCloud discover links are personalized and cannot be resolved by the public API. Use a direct playlist link instead."
      );
    }

    if (spotifyResolver.isSpotifyUrl(queryToResolve)) {
      const normalizedSpotifyUrl = spotifyResolver.normalizeSpotifyUrl(queryToResolve);
      const spotifyType = playdl.sp_validate(normalizedSpotifyUrl);
      if (spotifyType) {
        if (!hasSpotifyCredentials() && spotifyType === "track" && !allowSearchFallback) {
          return [];
        }
        const spotifyTracks = await spotifyResolver.resolveSpotifyTracks(
          normalizedSpotifyUrl,
          spotifyType,
          requester,
          onProgress
        );
        if (spotifyTracks.length) {
          return spotifyTracks;
        }
        // Do not fall back to generic YouTube URL search for Spotify lists.
        // If Spotify list resolve fails, returning [] avoids random unrelated tracks.
        if (spotifyType === "playlist" || spotifyType === "album") {
          return [];
        }
      }
    }

    return youtubeResolver.resolveYoutubeTracks(queryToResolve, requester, { allowSearchFallback });
  }

  async function resolveDeferredTrack(track, requesterOverride = null) {
    if (!track?.pendingResolve) {
      return track;
    }
    if (track.source === "spotify-pending") {
      return spotifyResolver.resolveDeferredSpotifyTrack(track, requesterOverride);
    }
    return null;
  }

  async function hydrateDeferredTrackMetadata(track) {
    if (!track?.pendingResolve) {
      return track;
    }
    if (track.source === "spotify-pending") {
      return spotifyResolver.hydrateDeferredSpotifyTrackMetadata(track);
    }
    return track;
  }

  return {
    getSearchOptionsForQuery,
    getSpotifySearchOptions: spotifyResolver.getSpotifySearchOptions,
    isProbablyUrl,
    isSpotifyUrl: spotifyResolver.isSpotifyUrl,
    deferredResolveLookahead: SPOTIFY_DEFER_RESOLVE_LOOKAHEAD,
    hydrateDeferredTrackMetadata,
    resolveDeferredTrack,
    resolveTracks,
  };
}

module.exports = {
  createTrackResolver,
};
