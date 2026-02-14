function createSoundcloudResolver(deps) {
  const {
    playdl,
    getSoundcloudClientId,
    httpGetJson,
    resolveRedirect,
    logInfo,
    logError,
  } = deps;

  function toSoundcloudPermalink(value) {
    if (!value) {
      return value;
    }
    const extractTrackId = (text) => {
      const decoded = decodeURIComponent(String(text || ""));
      const tokenMatch = decoded.match(/soundcloud:tracks:(\d+)/);
      if (tokenMatch) {
        return tokenMatch[1];
      }
      const apiMatch = decoded.match(/soundcloud\.com\/tracks\/(\d+)/);
      if (apiMatch) {
        return apiMatch[1];
      }
      const plainMatch = decoded.match(/(?:^|\/)tracks\/(\d+)(?:$|[/?#])/);
      if (plainMatch) {
        return plainMatch[1];
      }
      return null;
    };
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
        const id = extractTrackId(parts[1]) || parts[1];
        return `https://soundcloud.com/tracks/${id}`;
      }
    } catch {
      const id = extractTrackId(value);
      return id ? `https://soundcloud.com/tracks/${id}` : value;
    }
    const id = extractTrackId(value);
    return id ? `https://soundcloud.com/tracks/${id}` : value;
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

  async function resolveSoundcloudDiscover(url, slug, requester) {
    function toSoundcloudApiTrack(track) {
      const title = track?.title || track?.name || null;
      const permalink = toSoundcloudPermalink(track?.permalink_url || track?.url || track?.uri);
      if (!title || !permalink) {
        return null;
      }
      return {
        title,
        url: permalink,
        displayUrl: permalink,
        artist: track?.user?.username || track?.user?.name || track?.publisher_metadata?.artist || null,
        channel: track?.user?.username || track?.user?.name || null,
        source: "soundcloud",
        duration: Math.round((track.duration || 0) / 1000),
        requester,
      };
    }

    const soundcloudClientId = getSoundcloudClientId();
    if (!soundcloudClientId) {
      return [];
    }
    const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${soundcloudClientId}`;
    const data = await httpGetJson(resolveUrl);
    if (data?.kind === "track") {
      const mapped = toSoundcloudApiTrack(data);
      return mapped ? [mapped] : [];
    }
    if (data?.kind === "playlist") {
      if (Array.isArray(data.tracks) && data.tracks.length) {
        const mappedTracks = data.tracks.map(toSoundcloudApiTrack).filter(Boolean);
        if (mappedTracks.length === data.tracks.length) {
          return mappedTracks;
        }
      }
      if (data.id) {
        const playlistUrl = `https://api-v2.soundcloud.com/playlists/${data.id}?client_id=${soundcloudClientId}`;
        const playlist = await httpGetJson(playlistUrl);
        if (Array.isArray(playlist?.tracks)) {
          return playlist.tracks.map(toSoundcloudApiTrack).filter(Boolean);
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
          .map(toSoundcloudApiTrack)
          .filter(Boolean);
      }
    }
    return [];
  }

  async function resolveSoundcloudCandidate(candidate, requester) {
    const type = await playdl.so_validate(candidate);
    if (type === "track") {
      const track = await playdl.soundcloud(candidate);
      const displayUrl = await resolveSoundcloudDisplayUrl(track.url, track.permalink_url);
      return [
        {
          title: track.name,
          url: track.url,
          displayUrl,
          artist: track.user?.name || track.publisher?.artist || track.publisher_metadata?.artist || null,
          channel: track.user?.name || null,
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
          artist: track.user?.name || track.publisher?.artist || track.publisher_metadata?.artist || null,
          channel: track.user?.name || null,
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
          artist: info.user?.name || info.publisher?.artist || info.publisher_metadata?.artist || null,
          channel: info.user?.name || null,
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
          artist: track.user?.name || track.publisher?.artist || track.publisher_metadata?.artist || null,
          channel: track.user?.name || null,
          source: "soundcloud",
          duration: track.durationInSec ?? Math.round((track.durationInMs || 0) / 1000),
          requester,
        }))
      );
    }

    return [];
  }

  async function resolveSoundcloudContext(queryToResolve, requester) {
    let normalizedSoundcloud = queryToResolve;
    let isSoundcloudUrl = false;
    let soundcloudDiscoverSlug = null;
    let discoverFailed = false;
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
      soundcloudCandidates.push(queryToResolve);
      if (normalizedSoundcloud !== queryToResolve) {
        soundcloudCandidates.push(normalizedSoundcloud);
      }
    }
    const uniqueSoundcloudCandidates = Array.from(new Set(soundcloudCandidates.filter(Boolean)));

    if (soundcloudDiscoverSlug) {
      if (!getSoundcloudClientId()) {
        throw new Error(
          "SoundCloud discover links require API access and cannot be resolved without a SoundCloud client id."
        );
      }
      try {
        const apiTracks = await resolveSoundcloudDiscover(queryToResolve, soundcloudDiscoverSlug, requester);
        if (apiTracks.length) {
          return { isSoundcloudUrl, tracks: apiTracks, discoverFailed };
        }
        throw new Error(
          "SoundCloud discover links are personalized and cannot be resolved by the public API. Use a direct playlist link instead."
        );
      } catch (error) {
        discoverFailed = true;
        logError("SoundCloud discover resolve failed", error);
      }
    }

    if (isSoundcloudUrl && uniqueSoundcloudCandidates.length) {
      for (const candidate of uniqueSoundcloudCandidates) {
        try {
          const apiTracks = await resolveSoundcloudDiscover(candidate, null, requester);
          if (apiTracks.length) {
            return { isSoundcloudUrl, tracks: apiTracks, discoverFailed };
          }
        } catch {
          // continue
        }
      }
    }

    if (uniqueSoundcloudCandidates.length) {
      const candidateErrors = [];
      for (const candidate of uniqueSoundcloudCandidates) {
        try {
          const tracks = await resolveSoundcloudCandidate(candidate, requester);
          if (tracks.length) {
            return { isSoundcloudUrl, tracks, discoverFailed };
          }
        } catch (error) {
          candidateErrors.push({ candidate, error });
        }
      }
      if (candidateErrors.length) {
        logInfo("SoundCloud candidate(s) failed", {
          failures: candidateErrors.map((entry) => ({
            candidate: entry.candidate,
            error: entry.error?.message || String(entry.error),
          })),
          totalCandidates: uniqueSoundcloudCandidates.length,
        });
      }
    }

    return {
      isSoundcloudUrl,
      tracks: [],
      discoverFailed,
    };
  }

  return {
    resolveSoundcloudContext,
  };
}

module.exports = {
  createSoundcloudResolver,
};
