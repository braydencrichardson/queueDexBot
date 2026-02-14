function createSpotifyResolver(deps) {
  const {
    playdl,
    searchYouTubeOptions,
    searchYouTubePreferred,
    ensureSpotifyReady,
    hasSpotifyCredentials,
    searchChooserMaxResults,
    youtubeUserAgent,
    httpGetJson,
    httpGetText,
    spotifyYoutubeMinTitleRatio,
    spotifyYoutubeMinArtistRatio,
    spotifyYoutubeDurationStrictMaxDeltaSeconds,
    spotifyYoutubeDurationMaxDeltaSeconds,
    spotifyYoutubeCandidateLimit,
    logInfo,
    logError,
  } = deps;

  function isSpotifyUrl(value) {
    try {
      const url = new URL(value);
      return url.hostname.endsWith("spotify.com");
    } catch {
      return false;
    }
  }

  function decodeHtml(value) {
    if (!value) {
      return value;
    }
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function extractSpotifyMetaFromHtml(html) {
    if (!html) {
      return { title: null, artist: null, album: null };
    }
    const ogTitle = html.match(/<meta[^>]+property=['"]og:title['"][^>]+content=['"]([^'"]+)['"]/i);
    const ogDesc = html.match(/<meta[^>]+property=['"]og:description['"][^>]+content=['"]([^'"]+)['"]/i);
    const titleTag = html.match(/<title>([^<]+)<\/title>/i);
    let title = ogTitle ? decodeHtml(ogTitle[1]) : null;
    let artist = null;
    let album = null;

    if (!title && titleTag) {
      const rawTitle = decodeHtml(titleTag[1]);
      const cleaned = rawTitle.replace(/^Spotify\s*-\s*/i, "").trim();
      if (cleaned) {
        title = cleaned;
      }
    }

    if (title && title.toLowerCase() === "spotify") {
      title = null;
    }

    if (ogDesc) {
      const parts = decodeHtml(ogDesc[1])
        .split(" · ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        artist = parts[1];
      }
      if (parts.length >= 3 && parts[0].toLowerCase().includes("album")) {
        album = parts[1];
      }
    }

    if (!title || !artist) {
      const trackBlock = html.match(/"track"\s*:\s*{[\s\S]*?}\s*,/);
      const block = trackBlock ? trackBlock[0] : html;
      if (!title) {
        const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) {
          title = decodeHtml(nameMatch[1]);
        }
      }
      if (!artist) {
        const artistMatch = block.match(/"artists"\s*:\s*\[\s*{[^}]*"name"\s*:\s*"([^"]+)"/);
        if (artistMatch) {
          artist = decodeHtml(artistMatch[1]);
        }
      }
      if (!album) {
        const albumMatch = block.match(/"album"\s*:\s*{[^}]*"name"\s*:\s*"([^"]+)"/);
        if (albumMatch) {
          album = decodeHtml(albumMatch[1]);
        }
      }
      if (!artist) {
        const subtitleMatch = block.match(/"subtitle"\s*:\s*"([^"]+)"/);
        if (subtitleMatch) {
          artist = decodeHtml(subtitleMatch[1]);
        }
      }
    }

    return { title, artist, album };
  }

  function getSpotifyId(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith("spotify.com")) {
        return null;
      }
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[0] === "track") {
        return parts[1];
      }
    } catch {
      return null;
    }
    return null;
  }

  async function fetchSpotifyOembed(url) {
    try {
      const embedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      const data = await httpGetJson(embedUrl);
      if (data?.author_name || data?.title) {
        return data;
      }
      const id = getSpotifyId(url);
      if (id) {
        const altUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(`spotify:track:${id}`)}`;
        const altData = await httpGetJson(altUrl);
        return altData || data;
      }
      return data;
    } catch (error) {
      logError("Spotify oEmbed failed", error);
      return null;
    }
  }

  async function fetchSpotifyMeta(url) {
    try {
      const headers = {
        "User-Agent": youtubeUserAgent || "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
      };
      const html = await httpGetText(url, headers);
      let { title, artist, album } = extractSpotifyMetaFromHtml(html);

      if (!title) {
        const id = getSpotifyId(url);
        if (id) {
          const embedUrl = `https://open.spotify.com/embed/track/${id}`;
          const embedHtml = await httpGetText(embedUrl, headers);
          const embedMeta = extractSpotifyMetaFromHtml(embedHtml);
          title = title || embedMeta.title;
          artist = artist || embedMeta.artist;
          album = album || embedMeta.album;
        }
      }
      if (!title && !artist) {
        logInfo("Spotify meta tags missing", {
          length: html.length,
          hasOgTitle: html.includes("og:title"),
          hasOgDesc: html.includes("og:description"),
        });
      }
      return { title, artist, album };
    } catch (error) {
      logError("Spotify page meta failed", error);
      return null;
    }
  }

  function buildSpotifyQueries({ name, artists, album }) {
    const parts = [];
    const artistText = Array.isArray(artists) ? artists.filter(Boolean).join(" ") : artists;
    if (name && artistText) {
      parts.push(`${artistText} - ${name}`);
    }
    if (name && artistText && album) {
      parts.push(`${name} ${artistText} ${album}`);
    }
    if (name && artistText) {
      parts.push(`${name} ${artistText}`);
    }
    if (name && album) {
      parts.push(`${name} ${album}`);
    }
    if (name) {
      parts.push(name);
    }
    return Array.from(new Set(parts));
  }

  function getSpotifyDurationSeconds(track) {
    if (!track) {
      return null;
    }
    if (Number.isFinite(track.durationInSec) && track.durationInSec > 0) {
      return Math.round(track.durationInSec);
    }
    if (Number.isFinite(track.durationInMs) && track.durationInMs > 0) {
      return Math.round(track.durationInMs / 1000);
    }
    if (Number.isFinite(track.duration_ms) && track.duration_ms > 0) {
      return Math.round(track.duration_ms / 1000);
    }
    if (Number.isFinite(track.duration) && track.duration > 0) {
      return Math.round(track.duration);
    }
    return null;
  }

  function pickBestDurationCandidate(candidates, targetDurationSec) {
    if (!Array.isArray(candidates) || !candidates.length || !Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
      return null;
    }
    const withDuration = candidates.filter((candidate) => Number.isFinite(candidate?.duration) && candidate.duration > 0);
    if (!withDuration.length) {
      return null;
    }
    const strictLimit = Number.isFinite(spotifyYoutubeDurationStrictMaxDeltaSeconds)
      ? spotifyYoutubeDurationStrictMaxDeltaSeconds
      : 8;
    const looseLimit = Number.isFinite(spotifyYoutubeDurationMaxDeltaSeconds)
      ? spotifyYoutubeDurationMaxDeltaSeconds
      : 25;
    const scored = withDuration
      .map((candidate) => ({
        candidate,
        delta: Math.abs(candidate.duration - targetDurationSec),
      }))
      .sort((a, b) => a.delta - b.delta);

    const strict = scored.find((entry) => entry.delta <= strictLimit);
    if (strict) {
      return strict.candidate;
    }
    const loose = scored.find((entry) => entry.delta <= looseLimit);
    if (loose) {
      return loose.candidate;
    }
    return null;
  }

  async function findBestYouTubeMatch(queries, requester, spotifyDurationSec) {
    let fallbackCandidate = null;
    for (const query of queries) {
      const options = await searchYouTubeOptions(
        query,
        requester,
        {
          minTitleMatchRatio: spotifyYoutubeMinTitleRatio,
          minArtistMatchRatio: spotifyYoutubeMinArtistRatio,
        },
        spotifyYoutubeCandidateLimit
      );
      if (!options.length) {
        continue;
      }
      if (!fallbackCandidate) {
        fallbackCandidate = options[0];
      }
      const durationMatched = pickBestDurationCandidate(options, spotifyDurationSec);
      if (durationMatched) {
        logInfo("Selected Spotify-derived YouTube match by duration", {
          query,
          spotifyDurationSec,
          youtubeDurationSec: durationMatched.duration,
          deltaSec: Math.abs(durationMatched.duration - spotifyDurationSec),
        });
        return durationMatched;
      }
    }
    return fallbackCandidate;
  }

  async function getSpotifySearchOptions(url, requester) {
    const embed = await fetchSpotifyOembed(url);
    const meta = await fetchSpotifyMeta(url);
    const title = embed?.title || meta?.title;
    const author = embed?.author_name || meta?.artist;
    logInfo("Spotify oEmbed data", {
      title: embed?.title,
      author: embed?.author_name,
      url: embed?.url,
    });
    if (meta) {
      logInfo("Spotify meta data", meta);
    }
    if (!title) {
      return [];
    }
    const queries = buildSpotifyQueries({
      name: title,
      artists: author ? [author] : [],
      album: meta?.album,
    });
    for (const query of queries) {
      const options = await searchYouTubeOptions(
        query,
        requester,
        {
          minTitleMatchRatio: spotifyYoutubeMinTitleRatio,
          minArtistMatchRatio: spotifyYoutubeMinArtistRatio,
        },
        searchChooserMaxResults
      );
      if (options.length) {
        return options;
      }
    }
    return [];
  }

  async function resolveSpotifyTracks(url, type, requester) {
    const hasCredentials = hasSpotifyCredentials();
    if (type === "track" && !hasCredentials) {
      const options = await getSpotifySearchOptions(url, requester);
      return options.length ? [options[0]] : [];
    }

    if (!hasCredentials) {
      throw new Error(
        "Spotify playlists and albums require API credentials (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN)."
      );
    }

    await ensureSpotifyReady();
    const info = await playdl.spotify(url);
    if (info.type === "track") {
      logInfo("Spotify track data", {
        name: info.name,
        artists: Array.isArray(info.artists) ? info.artists.map((artist) => artist.name) : [],
        album: info.album?.name,
      });
      const queries = buildSpotifyQueries({
        name: info.name,
        artists: Array.isArray(info.artists) ? info.artists.map((artist) => artist.name) : [],
        album: info.album?.name,
      });
      const spotifyDurationSec = getSpotifyDurationSeconds(info);
      const candidate = await findBestYouTubeMatch(queries, requester, spotifyDurationSec);
      if (candidate) {
        return [candidate];
      }
      for (const query of queries) {
        const track = await searchYouTubePreferred(query, requester, {
          minArtistMatchRatio: spotifyYoutubeMinArtistRatio,
          minTitleMatchRatio: spotifyYoutubeMinTitleRatio,
        });
        if (track) {
          return [track];
        }
      }
      return [];
    }

    if (info.type === "playlist" || info.type === "album") {
      logInfo("Spotify list data", {
        type: info.type,
        name: info.name,
        totalTracks: info.total_tracks,
      });
      const tracks = await info.all_tracks();
      const results = [];
      for (const track of tracks) {
        const queries = buildSpotifyQueries({
          name: track.name,
          artists: Array.isArray(track.artists) ? track.artists.map((artist) => artist.name) : [],
          album: track.album?.name,
        });
        const spotifyDurationSec = getSpotifyDurationSeconds(track);
        const durationAwareMatch = await findBestYouTubeMatch(queries, requester, spotifyDurationSec);
        if (durationAwareMatch) {
          results.push(durationAwareMatch);
          continue;
        }
        for (const query of queries) {
          const match = await searchYouTubePreferred(query, requester, {
            minArtistMatchRatio: spotifyYoutubeMinArtistRatio,
            minTitleMatchRatio: spotifyYoutubeMinTitleRatio,
          });
          if (match) {
            results.push(match);
            break;
          }
        }
      }
      return results;
    }

    return [];
  }

  return {
    getSpotifySearchOptions,
    isSpotifyUrl,
    resolveSpotifyTracks,
  };
}

module.exports = {
  createSpotifyResolver,
};
