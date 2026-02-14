function createYoutubeResolver(deps) {
  const {
    playdl,
    getYoutubeId,
    toShortYoutubeUrl,
    searchYouTubePreferred,
    isProbablyUrl,
    isValidYouTubeVideoId,
  } = deps;

  async function resolveYoutubeTracks(queryToResolve, requester, { allowSearchFallback = true } = {}) {
    const ytType = playdl.yt_validate(queryToResolve);
    const youtubeId = getYoutubeId(queryToResolve);
    const youtubeVideoUrlDirectlyPlayable = !isProbablyUrl(queryToResolve) || isValidYouTubeVideoId(youtubeId);
    if (ytType === "video") {
      if (!youtubeVideoUrlDirectlyPlayable) {
        if (!allowSearchFallback) {
          return [];
        }
      } else {
        const info = await playdl.video_basic_info(queryToResolve);
        const videoId = info.video_details.id || youtubeId || getYoutubeId(queryToResolve);
        const videoUrl = toShortYoutubeUrl(videoId || info.video_details.url || queryToResolve);
        return [
          {
            title: info.video_details.title,
            url: videoUrl,
            artist: info.video_details.channel?.name || info.video_details.channel?.title || null,
            channel: info.video_details.channel?.name || info.video_details.channel?.title || null,
            source: "youtube",
            duration: info.video_details.durationInSec ?? null,
            requester,
          },
        ];
      }
    }

    if (ytType === "playlist") {
      const playlist = await playdl.playlist_info(queryToResolve, { incomplete: true });
      await playlist.fetch();
      return playlist.videos
        .map((item) => ({
          title: item.title,
          url: toShortYoutubeUrl(item.id || item.url),
          artist: item.channel?.name || item.author?.name || null,
          channel: item.channel?.name || item.author?.name || null,
          source: "youtube",
          duration: item.durationInSec ?? null,
          requester,
        }))
        .filter((track) => track.url);
    }

    if (!allowSearchFallback) {
      return [];
    }

    const searchResult = await searchYouTubePreferred(queryToResolve, requester);
    if (!searchResult) {
      return [];
    }

    return [searchResult];
  }

  return {
    resolveYoutubeTracks,
  };
}

module.exports = {
  createYoutubeResolver,
};
