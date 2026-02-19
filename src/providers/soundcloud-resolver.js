function createSoundcloudResolver(deps) {
  const {
    playdl,
    getSoundcloudClientId,
    getSoundcloudCookieHeader,
    httpGetJson,
    httpGetText,
    soundcloudUserAgent,
    resolveRedirect,
    sendDevAlert,
    logInfo,
    logError,
  } = deps;
  let soundcloudSessionExpiryAlertedAt = 0;
  const SOUNDCLOUD_SESSION_EXPIRY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

  async function maybeAlertLikelyExpiredSoundcloudSession(details = {}) {
    if (typeof sendDevAlert !== "function") {
      return;
    }
    const now = Date.now();
    if (now - soundcloudSessionExpiryAlertedAt < SOUNDCLOUD_SESSION_EXPIRY_ALERT_COOLDOWN_MS) {
      return;
    }
    soundcloudSessionExpiryAlertedAt = now;
    const detailText = details.slug ? ` (slug: ${details.slug})` : "";
    await sendDevAlert(
      `SoundCloud session cookies may be expired/invalid${detailText}. Discover fallback could not resolve playable tracks.`
    );
  }

  function buildSessionHeaders() {
    const sessionCookie = getSoundcloudCookieHeader ? getSoundcloudCookieHeader() : null;
    if (!sessionCookie) {
      return null;
    }
    return {
      "User-Agent": soundcloudUserAgent || "Mozilla/5.0",
      Cookie: sessionCookie,
      "Accept-Language": "en-US,en;q=0.9",
    };
  }

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

  function pickSoundcloudThumbnail(track) {
    if (!track || typeof track !== "object") {
      return null;
    }
    const candidates = [
      track.artwork_url,
      track.artworkUrl,
      track.artwork,
      track.thumbnail_url,
      track.thumbnailUrl,
      track.thumbnail,
      track.user?.avatar_url,
      track.user?.avatarUrl,
      track.user?.avatarURL,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeImageUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  function parseHydrationPayload(pageHtml) {
    const scriptMarker = "window.__sc_hydration";
    const markerIndex = pageHtml.indexOf(scriptMarker);
    if (markerIndex < 0) {
      return [];
    }
    const assignIndex = pageHtml.indexOf("=", markerIndex);
    if (assignIndex < 0) {
      return [];
    }
    const scriptCloseIndex = pageHtml.indexOf("</script>", assignIndex);
    if (scriptCloseIndex < 0) {
      return [];
    }
    const payload = pageHtml
      .slice(assignIndex + 1, scriptCloseIndex)
      .replace(/;\s*$/, "")
      .trim();
    if (!payload) {
      return [];
    }
    try {
      const parsed = JSON.parse(payload);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

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

  function toAbsoluteSoundcloudUrl(value) {
    if (!value || typeof value !== "string") {
      return value;
    }
    if (value.startsWith("//")) {
      return `https:${value}`;
    }
    if (value.startsWith("/")) {
      return `https://soundcloud.com${value}`;
    }
    return value;
  }

  function isPlayableSoundcloudUrl(value) {
    if (!value) {
      return false;
    }
    try {
      const parsed = new URL(value);
      const host = String(parsed.hostname || "").toLowerCase();
      if (!host.endsWith("soundcloud.com")) {
        return false;
      }
      const path = decodeURIComponent(parsed.pathname || "");
      if (!path || path === "/") {
        return false;
      }
      if (path.startsWith("/discover/") || path.startsWith("/you/") || path.startsWith("/search/")) {
        return false;
      }
      if (path.startsWith("/tracks/")) {
        return true;
      }
      const parts = path.split("/").filter(Boolean);
      return parts.length >= 2;
    } catch {
      return false;
    }
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
        thumbnailUrl: pickSoundcloudThumbnail(track),
        requester,
      };
    }

    const soundcloudClientId = getSoundcloudClientId();
    if (!soundcloudClientId) {
      return [];
    }
    const sessionHeaders = buildSessionHeaders();
    if (!slug) {
      const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${soundcloudClientId}`;
      const data = await httpGetJson(resolveUrl, sessionHeaders || {});
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
          const playlist = await httpGetJson(playlistUrl, sessionHeaders || {});
          if (Array.isArray(playlist?.tracks)) {
            return playlist.tracks.map(toSoundcloudApiTrack).filter(Boolean);
          }
        }
      }
    }
    if (slug) {
      const discoverUrl = `https://api-v2.soundcloud.com/discover/sets/${encodeURIComponent(slug)}?client_id=${soundcloudClientId}`;
      const discover = await httpGetJson(discoverUrl, sessionHeaders || {});
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

  async function resolveSoundcloudDiscoverViaSessionPage(slug, requester) {
    const sessionHeaders = buildSessionHeaders();
    const soundcloudClientId = getSoundcloudClientId();
    if (!sessionHeaders) {
      return { tracks: [], discoveredTrackIdsCount: 0, hasHydration: false };
    }
    const discoverPageUrl = `https://soundcloud.com/discover/sets/${encodeURIComponent(slug)}`;
    const pageHtml = await httpGetText(discoverPageUrl, sessionHeaders);
    const hydration = parseHydrationPayload(pageHtml);
    logInfo("SoundCloud discover session hydration parse", {
      slug,
      hasHydration: hydration.length > 0,
      hydrationEntries: hydration.length,
    });
    if (!hydration.length) {
      return { tracks: [], discoveredTrackIdsCount: 0, hasHydration: false };
    }
    const mapped = [];
    const seen = new Set();
    const visited = new Set();
    const discoveredTrackIds = new Set();
    const looksLikeTrack = (track) => {
      if (!track || typeof track !== "object") {
        return false;
      }
      const permalink = track.permalink_url || track.permalinkUrl || track.url || track.uri || "";
      const title = track.title || track.name || "";
      const urn = String(track.urn || "");
      if (!title) {
        return false;
      }
      if (urn.includes("soundcloud:tracks:")) {
        return true;
      }
      if (typeof permalink === "string" && /soundcloud\.com|^\/[^/]/i.test(permalink)) {
        return true;
      }
      return false;
    };
    const pushTrack = (track) => {
      if (!looksLikeTrack(track)) {
        return;
      }
      const fallbackPermalink = track?.permalink
        && track?.user?.permalink
        ? `/${track.user.permalink}/${track.permalink}`
        : null;
      const permalink = toSoundcloudPermalink(toAbsoluteSoundcloudUrl(
        track.permalink_url
          || track.permalinkUrl
          || track.url
          || track.uri
          || fallbackPermalink
      ));
      if (!permalink || seen.has(permalink)) {
        return;
      }
      if (!isPlayableSoundcloudUrl(permalink)) {
        return;
      }
      const title = track.title || track.name;
      if (!title) {
        return;
      }
      seen.add(permalink);
      mapped.push({
        title,
        url: permalink,
        displayUrl: permalink,
        artist: track?.user?.username || track?.user?.name || track?.publisher_metadata?.artist || null,
        channel: track?.user?.username || track?.user?.name || null,
        source: "soundcloud",
        duration: Math.round((track.duration || 0) / 1000),
        thumbnailUrl: pickSoundcloudThumbnail(track),
        requester,
      });
    };
    const collectTracks = (value, depth = 0) => {
      if (!value || depth > 8) {
        return;
      }
      if (typeof value !== "object") {
        return;
      }
      if (visited.has(value)) {
        return;
      }
      visited.add(value);
      if (Array.isArray(value)) {
        value.forEach((item) => collectTracks(item, depth + 1));
        return;
      }
      const urnMatch = String(value.urn || "").match(/soundcloud:tracks:(\d+)/);
      if (urnMatch?.[1]) {
        discoveredTrackIds.add(urnMatch[1]);
      }
      if (value.kind === "track" && Number.isFinite(value.id)) {
        discoveredTrackIds.add(String(value.id));
      }
      if (Array.isArray(value.track_urns)) {
        value.track_urns.forEach((urnValue) => {
          const match = String(urnValue || "").match(/soundcloud:tracks:(\d+)/);
          if (match?.[1]) {
            discoveredTrackIds.add(match[1]);
          }
        });
      }
      pushTrack(value);
      Object.values(value).forEach((next) => collectTracks(next, depth + 1));
    };
    hydration.forEach((entry) => {
      collectTracks(entry);
    });
    if (soundcloudClientId && discoveredTrackIds.size) {
      const idsToHydrate = Array.from(discoveredTrackIds).slice(0, 100);
      for (const trackId of idsToHydrate) {
        try {
          const trackInfo = await httpGetJson(
            `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${soundcloudClientId}`,
            sessionHeaders
          );
          pushTrack(trackInfo);
        } catch {
          // Skip tracks that are not available to this session.
        }
      }
    }
    logInfo("SoundCloud discover session mapped tracks", {
      slug,
      trackCount: mapped.length,
      discoveredTrackIds: discoveredTrackIds.size,
    });
    return {
      tracks: mapped,
      discoveredTrackIdsCount: discoveredTrackIds.size,
      hasHydration: true,
    };
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
          thumbnailUrl: pickSoundcloudThumbnail(track),
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
          thumbnailUrl: pickSoundcloudThumbnail(track),
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
          thumbnailUrl: pickSoundcloudThumbnail(info),
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
          thumbnailUrl: pickSoundcloudThumbnail(track),
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
      let apiTracks = [];
      try {
        apiTracks = await resolveSoundcloudDiscover(queryToResolve, soundcloudDiscoverSlug, requester);
        if (apiTracks.length) {
          return { isSoundcloudUrl, tracks: apiTracks, discoverFailed };
        }
      } catch (error) {
        logError("SoundCloud discover API resolve failed", error);
      }
      try {
        const sessionResult = await resolveSoundcloudDiscoverViaSessionPage(soundcloudDiscoverSlug, requester);
        if (sessionResult.tracks.length) {
          logInfo("SoundCloud discover resolved via session page", {
            slug: soundcloudDiscoverSlug,
            trackCount: sessionResult.tracks.length,
          });
          return { isSoundcloudUrl, tracks: sessionResult.tracks, discoverFailed };
        }
        const hasSessionCookie = Boolean(buildSessionHeaders());
        if (hasSessionCookie && sessionResult.hasHydration && sessionResult.discoveredTrackIdsCount === 0) {
          await maybeAlertLikelyExpiredSoundcloudSession({ slug: soundcloudDiscoverSlug });
        }
      } catch (error) {
        if (Boolean(buildSessionHeaders()) && /HTTP 401|HTTP 403/i.test(String(error?.message || ""))) {
          await maybeAlertLikelyExpiredSoundcloudSession({ slug: soundcloudDiscoverSlug });
        }
        logError("SoundCloud discover session resolve failed", error);
      }
      discoverFailed = true;
      logInfo("SoundCloud discover resolve exhausted", {
        slug: soundcloudDiscoverSlug,
        apiTrackCount: apiTracks.length,
      });
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
