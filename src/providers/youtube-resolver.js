function createYoutubeResolver(deps) {
  const {
    playdl,
    getYoutubeId,
    toShortYoutubeUrl,
    searchYouTubePreferred,
    isProbablyUrl,
    isValidYouTubeVideoId,
  } = deps;

  function normalizeImageUrl(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) {
      return null;
    }
    const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
    if (/^https?:\/\//i.test(normalized)) {
      return normalized;
    }
    return null;
  }

  function pickYoutubeThumbnail(thumbnails, fallbackVideoId = null) {
    if (Array.isArray(thumbnails) && thumbnails.length) {
      for (let index = thumbnails.length - 1; index >= 0; index -= 1) {
        const entry = thumbnails[index];
        const candidate = normalizeImageUrl(typeof entry === "string" ? entry : entry?.url);
        if (candidate) {
          return candidate;
        }
      }
    }
    if (thumbnails && typeof thumbnails === "object" && !Array.isArray(thumbnails)) {
      const candidate = normalizeImageUrl(thumbnails.url);
      if (candidate) {
        return candidate;
      }
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(String(fallbackVideoId || ""))) {
      return `https://i.ytimg.com/vi/${fallbackVideoId}/hqdefault.jpg`;
    }
    return null;
  }

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
        const thumbnailUrl = pickYoutubeThumbnail(
          info.video_details.thumbnails || info.video_details.thumbnail,
          videoId || getYoutubeId(videoUrl)
        );
        return [
          {
            title: info.video_details.title,
            url: videoUrl,
            artist: info.video_details.channel?.name || info.video_details.channel?.title || null,
            channel: info.video_details.channel?.name || info.video_details.channel?.title || null,
            source: "youtube",
            duration: info.video_details.durationInSec ?? null,
            thumbnailUrl,
            requester,
          },
        ];
      }
    }

    if (ytType === "playlist") {
      const playlist = await playdl.playlist_info(queryToResolve, { incomplete: true });
      await playlist.fetch();
      return playlist.videos
        .map((item) => {
          const videoUrl = toShortYoutubeUrl(item.id || item.url);
          const videoId = getYoutubeId(videoUrl) || getYoutubeId(item.id) || getYoutubeId(item.url);
          return {
            title: item.title,
            url: videoUrl,
            artist: item.channel?.name || item.author?.name || null,
            channel: item.channel?.name || item.author?.name || null,
            source: "youtube",
            duration: item.durationInSec ?? null,
            thumbnailUrl: pickYoutubeThumbnail(item.thumbnails || item.thumbnail, videoId),
            requester,
          };
        })
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
