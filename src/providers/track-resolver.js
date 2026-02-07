const https = require("https");
const { normalizeIncomingUrl } = require("../utils/url-normalization");

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
    logInfo,
    logError,
  } = deps;

  function toSoundcloudPermalink(value) {
    if (!value) {
      return value;
    }
    try {
      const url = new URL(value);
      const decodedPath = decodeURIComponent(url.pathname);
      const parts = decodedPath.split("/").filter(Boolean);
      const last = parts[parts.length - 1] || "";
      if (last.startsWith("soundcloud:tracks:")) {
        const id = last.split(":").pop();
        return id ? `https://soundcloud.com/tracks/${id}` : value;
      }
      if (url.hostname === "api.soundcloud.com" && parts[0] === "tracks" && parts[1]) {
        return `https://soundcloud.com/tracks/${parts[1]}`;
      }
    } catch {
      return value;
    }
    return value;
  }

  function getSoundcloudTrackId(value) {
    if (!value) {
      return null;
    }
    try {
      const url = new URL(value);
      if (url.hostname === "api.soundcloud.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] === "tracks" && parts[1]) {
          return parts[1];
        }
      }
    } catch {
      // ignore
    }
    const decoded = decodeURIComponent(String(value));
    const tokenMatch = decoded.match(/soundcloud:tracks:(\d+)/);
    if (tokenMatch) {
      return tokenMatch[1];
    }
    const idMatch = decoded.match(/soundcloud\.com\/tracks\/(\d+)/);
    if (idMatch) {
      return idMatch[1];
    }
    return null;
  }

  async function resolveSoundcloudDisplayUrl(trackUrl, permalinkUrl) {
    const direct = toSoundcloudPermalink(permalinkUrl || trackUrl);
    if (direct && !direct.includes("soundcloud.com/tracks/")) {
      return direct;
    }
    const soundcloudClientId = getSoundcloudClientId();
    if (!soundcloudClientId) {
      return direct;
    }
    const trackId = getSoundcloudTrackId(trackUrl);
    if (!trackId) {
      return direct;
    }
    try {
      const trackInfo = await httpGetJson(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${soundcloudClientId}`);
      return trackInfo?.permalink_url || direct;
    } catch (error) {
      logError("SoundCloud permalink lookup failed", error);
      return direct;
    }
  }

  function isSpotifyUrl(value) {
    try {
      const url = new URL(value);
      return url.hostname.endsWith("spotify.com");
    } catch {
      return false;
    }
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

  function isProbablyUrl(value) {
    if (!value) {
      return false;
    }
    try {
      const url = new URL(value);
      return Boolean(url?.protocol && url?.hostname);
    } catch {
      return false;
    }
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
          minArtistMatchRatio: 1,
          minTitleMatchRatio: 0.6,
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
      for (const query of queries) {
        const track = await searchYouTubePreferred(query, requester, {
          minArtistMatchRatio: 1,
          minTitleMatchRatio: 0.6,
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
        for (const query of queries) {
          const match = await searchYouTubePreferred(query, requester, {
            minArtistMatchRatio: 1,
            minTitleMatchRatio: 0.6,
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

  function httpGetJson(url) {
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(error);
            }
          });
        })
        .on("error", reject);
    });
  }

  function httpGetText(url, headers = {}) {
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            resolve(data);
          });
        })
        .on("error", reject);
    });
  }

  function resolveRedirect(url, maxHops = 5) {
    if (maxHops <= 0) {
      return Promise.resolve(url);
    }
    const headers = {
      "User-Agent": soundcloudUserAgent || youtubeUserAgent || "Mozilla/5.0",
    };
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = new URL(res.headers.location, url).toString();
            resolve(resolveRedirect(nextUrl, maxHops - 1));
            return;
          }
          resolve(url);
        })
        .on("error", reject);
    });
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

  async function resolveSoundcloudDiscover(url, slug, requester) {
    const soundcloudClientId = getSoundcloudClientId();
    if (!soundcloudClientId) {
      return [];
    }
    const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${soundcloudClientId}`;
    const data = await httpGetJson(resolveUrl);
    if (data?.kind === "track") {
      return [
        {
          title: data.title,
          url: data.permalink_url,
          source: "soundcloud",
          duration: Math.round((data.duration || 0) / 1000),
        },
      ];
    }
    if (data?.kind === "playlist") {
      if (Array.isArray(data.tracks) && data.tracks.length) {
        return data.tracks.map((track) => ({
          title: track.title,
          url: track.permalink_url,
          source: "soundcloud",
          duration: Math.round((track.duration || 0) / 1000),
        }));
      }
      if (data.id) {
        const playlistUrl = `https://api-v2.soundcloud.com/playlists/${data.id}?client_id=${soundcloudClientId}`;
        const playlist = await httpGetJson(playlistUrl);
        if (Array.isArray(playlist?.tracks)) {
          return playlist.tracks.map((track) => ({
            title: track.title,
            url: track.permalink_url,
            source: "soundcloud",
            duration: Math.round((track.duration || 0) / 1000),
            requester,
          }));
        }
      }
    }
    if (slug) {
      const discoverUrl = `https://api-v2.soundcloud.com/discover/sets/${encodeURIComponent(slug)}?client_id=${soundcloudClientId}`;
      const discover = await httpGetJson(discoverUrl);
      const tracks = discover?.collection || [];
      if (Array.isArray(tracks) && tracks.length) {
        return tracks
          .filter((track) => track?.kind === "track")
          .map((track) => ({
            title: track.title,
            url: track.permalink_url,
            source: "soundcloud",
            duration: Math.round((track.duration || 0) / 1000),
            requester,
          }));
      }
    }
    return [];
  }

  async function resolveTracks(query, requester) {
    await ensureSoundcloudReady();
    await ensureYoutubeReady();
    const queryToResolve = normalizeIncomingUrl(query);
    if (queryToResolve !== query) {
      logInfo("Normalized incoming URL before resolve", { from: query, to: queryToResolve });
    }
    let normalizedSoundcloud = queryToResolve;
    let isSoundcloudUrl = false;
    let soundcloudDiscoverSlug = null;
    let soundcloudDiscoverFailed = false;
    let url = null;
    try {
      url = new URL(queryToResolve);
    } catch {
      url = null;
    }
    if (url && url.hostname === "on.soundcloud.com") {
      try {
        const resolved = await resolveRedirect(url.toString());
        if (resolved && resolved !== url.toString()) {
          normalizedSoundcloud = resolved;
          url = new URL(resolved);
        }
      } catch (error) {
        logError("SoundCloud short link resolve failed", error);
      }
    }
    if (url && url.hostname.endsWith("soundcloud.com")) {
      isSoundcloudUrl = true;
      if (url.pathname.startsWith("/discover/sets/")) {
        soundcloudDiscoverSlug = url.pathname.replace("/discover/sets/", "").split("/")[0];
      }
      const pathParts = url.pathname.split("/").filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];
      url.search = "";
      url.hash = "";
      if (lastPart && lastPart.startsWith("s-")) {
        pathParts.pop();
        url.pathname = `/${pathParts.join("/")}`;
        url.searchParams.set("secret_token", lastPart);
      }
      normalizedSoundcloud = url.toString();
    }

    const soundcloudCandidates = [];
    if (isSoundcloudUrl) {
      soundcloudCandidates.push(normalizedSoundcloud);
      if (queryToResolve !== normalizedSoundcloud) {
        soundcloudCandidates.push(queryToResolve);
      }
    }

    async function resolveSoundcloudCandidate(candidate) {
      const type = await playdl.so_validate(candidate);
      if (type === "track") {
        const track = await playdl.soundcloud(candidate);
        const displayUrl = await resolveSoundcloudDisplayUrl(track.url, track.permalink_url);
        return [
          {
            title: track.name,
            url: track.url,
            displayUrl,
            source: "soundcloud",
            duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
            requester,
          },
        ];
      }

      if (type === "playlist") {
        const playlist = await playdl.soundcloud(candidate);
        const tracks = await playlist.all_tracks();
        return Promise.all(
          tracks.map(async (track) => ({
            title: track.name,
            url: track.url,
            displayUrl: await resolveSoundcloudDisplayUrl(track.url, track.permalink_url),
            source: "soundcloud",
            duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
            requester,
          }))
        );
      }

      const info = await playdl.soundcloud(candidate);
      if (info.type === "track") {
        const displayUrl = await resolveSoundcloudDisplayUrl(info.url, info.permalink_url);
        return [
          {
            title: info.name,
            url: info.url,
            displayUrl,
            source: "soundcloud",
            duration: info.durationInSec ?? Math.round((info.durationInMs || 0) / 1000),
            requester,
          },
        ];
      }
      if (info.type === "playlist") {
        const tracks = await info.all_tracks();
        return Promise.all(
          tracks.map(async (track) => ({
            title: track.name,
            url: track.url,
            displayUrl: await resolveSoundcloudDisplayUrl(track.url, track.permalink_url),
            source: "soundcloud",
            duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
            requester,
          }))
        );
      }

      return [];
    }

    if (soundcloudDiscoverSlug) {
      try {
        const apiTracks = await resolveSoundcloudDiscover(queryToResolve, soundcloudDiscoverSlug, requester);
        if (apiTracks.length) {
          return apiTracks;
        }
      } catch (error) {
        soundcloudDiscoverFailed = true;
        logError("SoundCloud discover resolve failed", error);
      }
    }

    if (soundcloudCandidates.length) {
      for (const candidate of soundcloudCandidates) {
        try {
          const tracks = await resolveSoundcloudCandidate(candidate);
          if (tracks.length) {
            return tracks;
          }
        } catch (error) {
          logInfo("SoundCloud candidate failed", { candidate, error });
        }
      }
    }

    if (soundcloudDiscoverSlug) {
      try {
        const results = await playdl.search(soundcloudDiscoverSlug, {
          limit: 1,
          source: { soundcloud: "playlists" },
        });
        if (results.length) {
          const playlist = await playdl.soundcloud(results[0].url);
          const tracks = await playlist.all_tracks();
          return tracks.map((track) => ({
            title: track.name,
            url: track.url,
            source: "soundcloud",
            duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
            requester,
          }));
        }
      } catch (error) {
        logError("SoundCloud discover search failed", error);
      }
    }

    if (soundcloudDiscoverFailed) {
      throw new Error(
        "SoundCloud discover links are personalized and cannot be resolved by the public API. Use a direct playlist link instead."
      );
    }

    if (isSpotifyUrl(queryToResolve)) {
      const spotifyType = playdl.sp_validate(queryToResolve);
      if (spotifyType) {
        const spotifyTracks = await resolveSpotifyTracks(queryToResolve, spotifyType, requester);
        if (spotifyTracks.length) {
          return spotifyTracks;
        }
      }
    }

    const ytType = playdl.yt_validate(queryToResolve);
    if (ytType === "video") {
      const info = await playdl.video_basic_info(queryToResolve);
      const videoId = info.video_details.id || getYoutubeId(queryToResolve);
      const videoUrl = toShortYoutubeUrl(videoId || info.video_details.url || queryToResolve);
      return [
        {
          title: info.video_details.title,
          url: videoUrl,
          source: "youtube",
          duration: info.video_details.durationInSec ?? null,
          requester,
        },
      ];
    }

    if (ytType === "playlist") {
      const playlist = await playdl.playlist_info(queryToResolve, { incomplete: true });
      await playlist.fetch();
      return playlist.videos
        .map((item) => ({
          title: item.title,
          url: toShortYoutubeUrl(item.id || item.url),
          source: "youtube",
          duration: item.durationInSec ?? null,
          requester,
        }))
        .filter((track) => track.url);
    }

    const searchResult = await searchYouTubePreferred(queryToResolve, requester);
    if (!searchResult) {
      return [];
    }

    return [searchResult];
  }

  return {
    getSpotifySearchOptions,
    isProbablyUrl,
    isSpotifyUrl,
    resolveTracks,
  };
}

module.exports = {
  createTrackResolver,
};
