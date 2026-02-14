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
} = require("../config/constants");
const { createResolverHttpClient } = require("./resolver-http");
const { createSpotifyResolver } = require("./spotify-resolver");
const { createSoundcloudResolver } = require("./soundcloud-resolver");
const { createYoutubeResolver } = require("./youtube-resolver");
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

  async function getSearchOptionsForQuery(query, requester) {
    await ensureSoundcloudReady();
    await ensureYoutubeReady();
    const queryToResolve = normalizeResolverQuery(query, { normalizeIncomingUrl, logInfo });

    if (spotifyResolver.isSpotifyUrl(queryToResolve) && !hasSpotifyCredentials()) {
      const spotifyType = playdl.sp_validate(queryToResolve);
      if (spotifyType === "track") {
        return spotifyResolver.getSpotifySearchOptions(queryToResolve, requester);
      }
      return [];
    }

    return searchYouTubeOptions(queryToResolve, requester, null, searchChooserMaxResults);
  }

  async function resolveTracks(query, requester, { allowSearchFallback = true } = {}) {
    await ensureSoundcloudReady();
    await ensureYoutubeReady();
    const queryToResolve = normalizeResolverQuery(query, { normalizeIncomingUrl, logInfo });

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
      const spotifyType = playdl.sp_validate(queryToResolve);
      if (spotifyType) {
        if (!hasSpotifyCredentials() && spotifyType === "track" && !allowSearchFallback) {
          return [];
        }
        const spotifyTracks = await spotifyResolver.resolveSpotifyTracks(queryToResolve, spotifyType, requester);
        if (spotifyTracks.length) {
          return spotifyTracks;
        }
      }
    }

    return youtubeResolver.resolveYoutubeTracks(queryToResolve, requester, { allowSearchFallback });
  }

  return {
    getSearchOptionsForQuery,
    getSpotifySearchOptions: spotifyResolver.getSpotifySearchOptions,
    isProbablyUrl,
    isSpotifyUrl: spotifyResolver.isSpotifyUrl,
    resolveTracks,
  };
}

module.exports = {
  createTrackResolver,
};
