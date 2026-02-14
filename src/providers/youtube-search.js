const yts = require("yt-search");
const {
  YOUTUBE_MATCH_DEFAULT_MIN_ARTIST_RATIO,
  YOUTUBE_MATCH_DEFAULT_MIN_TITLE_RATIO,
  YOUTUBE_SEARCH_DEFAULT_LIMIT,
  YOUTUBE_SEARCH_QUERY_VARIANTS,
  YOUTUBE_SEARCH_MIN_SECONDS,
  YOUTUBE_SCORE_TITLE_MATCH_WEIGHT,
  YOUTUBE_SCORE_ARTIST_MATCH_WEIGHT,
  YOUTUBE_TITLE_BLOCK_TERMS,
  YOUTUBE_TITLE_WEIGHT_RULES,
  YOUTUBE_CHANNEL_WEIGHT_RULES,
} = require("../config/constants");

function getYoutubeId(value) {
  if (!value) {
    return null;
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      return url.pathname.replace("/", "");
    }
    if (url.hostname.endsWith("youtube.com")) {
      const id = url.searchParams.get("v");
      if (id) {
        return id;
      }
      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/")[2];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function toShortYoutubeUrl(value) {
  const id = getYoutubeId(value);
  if (!id) {
    return value;
  }
  return `https://youtu.be/${id}`;
}

function tokenizeQuery(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\(\)\[\]{}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseQueryParts(query) {
  const raw = String(query || "");
  const parts = raw.split(" - ").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { artist: parts[0], title: parts.slice(1).join(" - ") };
  }
  return { title: raw.trim() };
}

function isBlockedTitle(title) {
  const lowered = String(title || "").toLowerCase();
  if (!lowered) {
    return false;
  }
  return Array.isArray(YOUTUBE_TITLE_BLOCK_TERMS)
    && YOUTUBE_TITLE_BLOCK_TERMS.some((term) => typeof term === "string" && term && lowered.includes(term.toLowerCase()));
}

function applyTitleWeightRules(title) {
  if (!title || !Array.isArray(YOUTUBE_TITLE_WEIGHT_RULES)) {
    return 0;
  }
  let score = 0;
  YOUTUBE_TITLE_WEIGHT_RULES.forEach((rule) => {
    const term = String(rule?.term || "").toLowerCase().trim();
    const weight = Number(rule?.score);
    if (!term || !Number.isFinite(weight)) {
      return;
    }
    if (title.includes(term)) {
      score += weight;
    }
  });
  return score;
}

function applyChannelWeightRules(channelName) {
  if (!channelName || !Array.isArray(YOUTUBE_CHANNEL_WEIGHT_RULES)) {
    return 0;
  }
  let score = 0;
  YOUTUBE_CHANNEL_WEIGHT_RULES.forEach((rule) => {
    const term = String(rule?.term || "").toLowerCase().trim();
    const weight = Number(rule?.score);
    if (!term || !Number.isFinite(weight)) {
      return;
    }
    if (channelName.includes(term)) {
      score += weight;
    }
  });
  return score;
}

function buildSearchQueryVariants(query) {
  const baseQuery = String(query || "").trim();
  const templates = Array.isArray(YOUTUBE_SEARCH_QUERY_VARIANTS) && YOUTUBE_SEARCH_QUERY_VARIANTS.length
    ? YOUTUBE_SEARCH_QUERY_VARIANTS
    : [
        "{query} official audio",
        "{query} official music video",
        "{query} audio",
        "{query} lyrics",
        "{query}",
      ];
  return templates
    .map((template) => String(template || "").replaceAll("{query}", baseQuery).trim())
    .filter(Boolean);
}

function scoreYouTubeVideo(video, requiredTokens, artistTokens, matchOptions) {
  const title = String(video.title || "").toLowerCase();
  const channelName = String(video.author?.name || video.channel?.name || "").toLowerCase();
  const titleTokens = new Set(tokenizeQuery(title));
  const requiredMatches = requiredTokens.filter((token) => titleTokens.has(token)).length;
  const artistMatches = artistTokens.filter((token) => titleTokens.has(token)).length;
  const minTitleRatio = matchOptions?.minTitleMatchRatio ?? YOUTUBE_MATCH_DEFAULT_MIN_TITLE_RATIO;
  const minArtistRatio = matchOptions?.minArtistMatchRatio ?? YOUTUBE_MATCH_DEFAULT_MIN_ARTIST_RATIO;
  if (requiredTokens.length && requiredMatches / requiredTokens.length < minTitleRatio) {
    return -Infinity;
  }
  if (artistTokens.length && artistMatches / artistTokens.length < minArtistRatio) {
    return -Infinity;
  }
  let score = requiredMatches * YOUTUBE_SCORE_TITLE_MATCH_WEIGHT + artistMatches * YOUTUBE_SCORE_ARTIST_MATCH_WEIGHT;
  score += applyTitleWeightRules(title);
  score += applyChannelWeightRules(channelName);
  return score;
}

function pickYouTubeVideo(videos, query, matchOptions) {
  if (!Array.isArray(videos) || !videos.length) {
    return null;
  }
  const candidateVideos = videos.filter((video) => !isBlockedTitle(video?.title));
  if (!candidateVideos.length) {
    return null;
  }
  const parsed = parseQueryParts(query);
  const requiredTokens = tokenizeQuery(parsed.title || query);
  const artistTokens = tokenizeQuery(parsed.artist || "");
  const scored = candidateVideos
    .filter((video) => typeof video.seconds === "number" && video.seconds > YOUTUBE_SEARCH_MIN_SECONDS)
    .map((video) => ({
      video,
      score: scoreYouTubeVideo(video, requiredTokens, artistTokens, matchOptions),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);

  if (scored.length) {
    return scored[0].video;
  }

  return candidateVideos[0];
}

function rankYouTubeVideos(videos, query, matchOptions) {
  if (!Array.isArray(videos) || !videos.length) {
    return [];
  }
  const candidateVideos = videos.filter((video) => !isBlockedTitle(video?.title));
  if (!candidateVideos.length) {
    return [];
  }
  const parsed = parseQueryParts(query);
  const requiredTokens = tokenizeQuery(parsed.title || query);
  const artistTokens = tokenizeQuery(parsed.artist || "");
  const scored = candidateVideos
    .filter((video) => typeof video.seconds === "number" && video.seconds > YOUTUBE_SEARCH_MIN_SECONDS)
    .map((video) => ({
      video,
      score: scoreYouTubeVideo(video, requiredTokens, artistTokens, matchOptions),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.video);

  return scored.length ? scored : candidateVideos;
}

async function searchYouTubeOptions(query, requester, matchOptions, limit = YOUTUBE_SEARCH_DEFAULT_LIMIT) {
  const variants = buildSearchQueryVariants(query);
  const baseQuery = String(query || "");
  for (const searchQuery of variants) {
    const results = await yts(searchQuery);
    const ranked = rankYouTubeVideos(results.videos, baseQuery, matchOptions);
    if (ranked.length) {
      return ranked.slice(0, limit).map((video) => ({
        title: video.title,
        url: toShortYoutubeUrl(video.videoId || video.url),
        channel: video.author?.name || video.channel?.name || null,
        artist: video.author?.name || video.channel?.name || null,
        source: "youtube",
        duration: typeof video.seconds === "number" ? video.seconds : null,
        requester,
      }));
    }
  }
  return [];
}

async function searchYouTubePreferred(query, requester, matchOptions) {
  const variants = buildSearchQueryVariants(query);
  const baseQuery = String(query || "");
  for (const searchQuery of variants) {
    const results = await yts(searchQuery);
    const top = pickYouTubeVideo(results.videos, baseQuery, matchOptions);
    if (top) {
      const id = top.videoId || getYoutubeId(top.url);
      return {
        title: top.title,
        url: toShortYoutubeUrl(id || top.url),
        channel: top.author?.name || top.channel?.name || null,
        artist: top.author?.name || top.channel?.name || null,
        source: "youtube",
        duration: typeof top.seconds === "number" ? top.seconds : null,
        requester,
      };
    }
  }
  return null;
}

module.exports = {
  getYoutubeId,
  toShortYoutubeUrl,
  searchYouTubeOptions,
  searchYouTubePreferred,
};
