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
    spotifyDeferResolveMinTracks = 0,
    spotifyDeferResolveEagerCount = 1,
    spotifyDeferMetadataPrefetchCount = 0,
    spotifyApiClient = null,
    logInfo,
    logError,
  } = deps;
  let spotifyIdentityLogged = false;

  function emitProgress(onProgress, payload) {
    if (typeof onProgress !== "function") {
      return;
    }
    Promise.resolve(onProgress(payload)).catch((error) => {
      logError("Spotify progress callback failed", error);
    });
  }

  async function logSpotifyIdentityOn403() {
    if (spotifyIdentityLogged || !spotifyApiClient?.hasCredentials?.() || !spotifyApiClient?.getCurrentUserProfile) {
      return;
    }
    try {
      const profile = await spotifyApiClient.getCurrentUserProfile();
      logInfo("Spotify OAuth identity", {
        id: profile?.id || null,
        displayName: profile?.display_name || null,
        product: profile?.product || null,
        country: profile?.country || null,
      });
      spotifyIdentityLogged = true;
    } catch (profileError) {
      logError("Spotify OAuth identity check failed", profileError);
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

  function normalizeSpotifyUrl(value) {
    try {
      const parsed = new URL(value);
      if (!parsed.hostname.endsWith("spotify.com")) {
        return value;
      }
      const rawParts = parsed.pathname.split("/").filter(Boolean);
      const parts = rawParts[0]?.startsWith("intl-") ? rawParts.slice(1) : rawParts;
      if (!parts.length) {
        return "https://open.spotify.com/";
      }
      const safePath = `/${parts.join("/")}`;
      const normalized = new URL(`https://open.spotify.com${safePath}`);
      // Keep Spotify private-share token; without it private shared playlists cannot be page-resolved.
      const privateShareToken = parsed.searchParams.get("pt");
      if (privateShareToken) {
        normalized.searchParams.set("pt", privateShareToken);
      }
      return normalized.toString();
    } catch {
      return value;
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

  function getSpotifyEntityFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith("spotify.com")) {
        return null;
      }
      const rawParts = parsed.pathname.split("/").filter(Boolean);
      const parts = rawParts[0]?.startsWith("intl-") ? rawParts.slice(1) : rawParts;
      if (parts.length < 2) {
        return null;
      }
      const type = parts[0];
      const id = parts[1];
      if (!id) {
        return null;
      }
      if (type !== "track" && type !== "playlist" && type !== "album") {
        return null;
      }
      return { type, id };
    } catch {
      return null;
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

  function toDeferredSpotifyTrack(track, requester) {
    const artists = Array.isArray(track?.artists) ? track.artists.map((artist) => artist?.name).filter(Boolean) : [];
    const name = track?.name || "Unknown Spotify track";
    const album = track?.album?.name || null;
    const duration = getSpotifyDurationSeconds(track) || null;
    const trackId = track?.id || null;
    const spotifyUrl = trackId ? `https://open.spotify.com/track/${trackId}` : null;
    return {
      title: artists.length ? `${artists.join(", ")} - ${name}` : name,
      artist: artists[0] || null,
      channel: "Spotify",
      source: "spotify-pending",
      duration,
      requester,
      pendingResolve: true,
      displayUrl: spotifyUrl,
      spotifyMeta: {
        trackId,
        spotifyUrl,
        name,
        artists,
        album,
        durationSec: duration,
      },
    };
  }

  function toDeferredSpotifyTrackFromId(trackId, requester, index = null) {
    const safeIndex = Number.isFinite(index) ? index + 1 : null;
    const spotifyUrl = trackId ? `https://open.spotify.com/track/${trackId}` : null;
    return {
      title: safeIndex ? `Spotify Track #${safeIndex}` : "Spotify Track",
      artist: null,
      channel: "Spotify",
      source: "spotify-pending",
      duration: null,
      requester,
      pendingResolve: true,
      displayUrl: spotifyUrl,
      spotifyMeta: {
        trackId: trackId || null,
        spotifyUrl,
      },
    };
  }

  async function resolveSpotifyTrackToYouTube(track, requester) {
    const artists = Array.isArray(track?.artists) ? track.artists.map((artist) => artist?.name).filter(Boolean) : [];
    const queries = buildSpotifyQueries({
      name: track?.name,
      artists,
      album: track?.album?.name,
    });
    const spotifyDurationSec = getSpotifyDurationSeconds(track);
    const durationAwareMatch = await findBestYouTubeMatch(queries, requester, spotifyDurationSec);
    if (durationAwareMatch) {
      return durationAwareMatch;
    }
    for (const query of queries) {
      const match = await searchYouTubePreferred(query, requester, {
        minArtistMatchRatio: spotifyYoutubeMinArtistRatio,
        minTitleMatchRatio: spotifyYoutubeMinTitleRatio,
      });
      if (match) {
        return match;
      }
    }
    return null;
  }

  async function resolveDeferredSpotifyTrack(track, requesterOverride = null) {
    const meta = track?.spotifyMeta;
    if (!meta?.name && meta?.trackId && spotifyApiClient?.getTrackById) {
      try {
        const hydrated = await spotifyApiClient.getTrackById(meta.trackId);
        if (hydrated?.name) {
          meta.name = hydrated.name;
          meta.artists = Array.isArray(hydrated.artists) ? hydrated.artists.map((artist) => artist?.name).filter(Boolean) : [];
          meta.album = hydrated.album?.name || null;
          meta.durationSec = getSpotifyDurationSeconds(hydrated);
        }
      } catch {
        return null;
      }
    }
    if (!meta?.name) {
      return null;
    }
    const queryTrack = {
      name: meta.name,
      artists: Array.isArray(meta.artists) ? meta.artists.map((name) => ({ name })) : [],
      album: meta.album ? { name: meta.album } : null,
      durationInSec: meta.durationSec,
    };
    const resolved = await resolveSpotifyTrackToYouTube(queryTrack, requesterOverride || track?.requester || "Requester");
    if (!resolved) {
      return null;
    }
    return {
      ...resolved,
      requester: requesterOverride || track?.requester || resolved.requester,
      id: track?.id || resolved.id,
      pendingResolve: false,
      displayUrl: resolved.displayUrl || resolved.url || track?.displayUrl || null,
      spotifyMeta: track?.spotifyMeta,
    };
  }

  async function hydrateDeferredSpotifyTrackMetadata(track) {
    if (!track?.pendingResolve || track?.source !== "spotify-pending") {
      return null;
    }
    const meta = track?.spotifyMeta;
    if (!meta?.trackId || meta?.name || !spotifyApiClient?.getTrackById) {
      return track;
    }
    let hydrated;
    try {
      hydrated = await spotifyApiClient.getTrackById(meta.trackId);
    } catch {
      return null;
    }
    if (!hydrated?.name) {
      return null;
    }
    meta.name = hydrated.name;
    meta.artists = Array.isArray(hydrated.artists) ? hydrated.artists.map((artist) => artist?.name).filter(Boolean) : [];
    meta.album = hydrated.album?.name || null;
    meta.durationSec = getSpotifyDurationSeconds(hydrated);
    meta.spotifyUrl = meta.spotifyUrl || (hydrated.id ? `https://open.spotify.com/track/${hydrated.id}` : null);
    track.title = meta.artists?.length ? `${meta.artists.join(", ")} - ${meta.name}` : meta.name;
    track.artist = meta.artists?.[0] || null;
    if (Number.isFinite(meta.durationSec) && meta.durationSec > 0) {
      track.duration = meta.durationSec;
    }
    if (meta.spotifyUrl) {
      track.displayUrl = meta.spotifyUrl;
    }
    return track;
  }

  function pickBestDurationCandidate(candidates, targetDurationSec) {
    if (!Array.isArray(candidates) || !candidates.length || !Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
      return null;
    }
    const withDuration = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter((entry) => Number.isFinite(entry?.candidate?.duration) && entry.candidate.duration > 0);
    if (!withDuration.length) {
      return null;
    }
    const strictLimit = Number.isFinite(spotifyYoutubeDurationStrictMaxDeltaSeconds)
      ? spotifyYoutubeDurationStrictMaxDeltaSeconds
      : 8;
    const looseLimit = Number.isFinite(spotifyYoutubeDurationMaxDeltaSeconds)
      ? spotifyYoutubeDurationMaxDeltaSeconds
      : 25;
    const strict = withDuration.find((entry) => Math.abs(entry.candidate.duration - targetDurationSec) <= strictLimit);
    if (strict) {
      return strict.candidate;
    }
    const loose = withDuration.find((entry) => Math.abs(entry.candidate.duration - targetDurationSec) <= looseLimit);
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

  function extractSpotifyTrackIdsFromPageHtml(html) {
    if (!html) {
      return [];
    }
    const ids = new Set();
    const patterns = [
      /spotify:track:([A-Za-z0-9]{22})/g,
      /\/track\/([A-Za-z0-9]{22})/g,
      /\\\/track\\\/([A-Za-z0-9]{22})/g,
      /spotify%3Atrack%3A([A-Za-z0-9]{22})/gi,
      /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/g,
    ];
    patterns.forEach((pattern) => {
      let match;
      // eslint-disable-next-line no-cond-assign
      while ((match = pattern.exec(html)) !== null) {
        if (match[1]) {
          ids.add(match[1]);
        }
      }
    });
    return Array.from(ids);
  }

  async function resolveSpotifyPlaylistViaPageTrackIds(url, requester, onProgress = null) {
    if (!spotifyApiClient?.getTrackById) {
      return [];
    }
    const headers = {
      "User-Agent": youtubeUserAgent || "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
    };
    const pageUrls = [];
    try {
      const parsed = new URL(url);
      const base = `${parsed.origin}${parsed.pathname}`;
      const privateShareToken = parsed.searchParams.get("pt");
      const privateShareSuffix = privateShareToken ? `pt=${encodeURIComponent(privateShareToken)}` : "";
      pageUrls.push(privateShareSuffix ? `${base}?${privateShareSuffix}` : base);
      pageUrls.push(privateShareSuffix ? `${base}?nd=1&${privateShareSuffix}` : `${base}?nd=1`);
      const entity = getSpotifyEntityFromUrl(base);
      if (entity?.type === "playlist") {
        const embedBase = `${parsed.origin}/embed/playlist/${entity.id}`;
        pageUrls.push(privateShareSuffix ? `${embedBase}?${privateShareSuffix}` : embedBase);
      }
    } catch {
      pageUrls.push(url);
    }

    const uniquePageUrls = Array.from(new Set(pageUrls));
    const combinedTrackIds = new Set();
    const pageDiagnostics = [];
    for (const pageUrl of uniquePageUrls) {
      let html;
      try {
        html = await httpGetText(pageUrl, headers);
      } catch (error) {
        logError("Spotify playlist page fallback fetch failed", {
          url: pageUrl,
          error,
        });
        continue;
      }
      const pageTrackIds = extractSpotifyTrackIdsFromPageHtml(html);
      pageTrackIds.forEach((id) => combinedTrackIds.add(id));
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      pageDiagnostics.push({
        url: pageUrl,
        htmlLength: html.length,
        title: titleMatch ? decodeHtml(titleMatch[1]).trim() : null,
        hasNextData: html.includes("__NEXT_DATA__"),
        hasSpotifyTrackUri: html.includes("spotify:track:"),
        hasEncodedSpotifyTrackUri: html.includes("spotify%3Atrack%3A"),
        hasRecaptcha: /recaptcha|captcha/i.test(html),
        hasLogin: /log in|login|sign up|signup/i.test(html),
        trackIdCount: pageTrackIds.length,
      });
    }

    const trackIds = Array.from(combinedTrackIds);
    if (!trackIds.length) {
      pageDiagnostics.forEach((diag) => {
        logInfo("Spotify playlist fallback page had no track IDs", diag);
      });
      logInfo("Spotify playlist page fallback found no track IDs.");
      return [];
    }
    logInfo("Spotify playlist page fallback extracted track IDs", {
      count: trackIds.length,
      sourcesTried: uniquePageUrls.length,
      sourcesWithTrackIds: pageDiagnostics.filter((diag) => diag.trackIdCount > 0).length,
      recaptchaSources: pageDiagnostics.filter((diag) => diag.hasRecaptcha).length,
    });

    const results = [];
    let processed = 0;
    const deferEnabled = trackIds.length >= Math.max(1, Number(spotifyDeferResolveMinTracks) || 0);
    const eagerCount = Math.max(1, Number(spotifyDeferResolveEagerCount) || 1);
    let hydratedTracksById = new Map();
    if (deferEnabled && spotifyApiClient?.getTracksByIds) {
      try {
        const hydratedTracks = await spotifyApiClient.getTracksByIds(trackIds);
        hydratedTracksById = new Map(
          hydratedTracks
            .filter((track) => track?.id)
            .map((track) => [track.id, track])
        );
      } catch (error) {
        logInfo("Spotify fallback metadata hydration failed; using ID-only placeholders", { error });
      }
    }
    if (deferEnabled && spotifyApiClient?.getTrackById) {
      const prefetchCount = Math.max(0, Number(spotifyDeferMetadataPrefetchCount) || 0);
      if (prefetchCount > 0 && hydratedTracksById.size < trackIds.length) {
        const unresolvedIds = trackIds.filter((id) => !hydratedTracksById.has(id)).slice(0, prefetchCount);
        for (const unresolvedId of unresolvedIds) {
          try {
            const hydrated = await spotifyApiClient.getTrackById(unresolvedId);
            if (hydrated?.id) {
              hydratedTracksById.set(hydrated.id, hydrated);
            }
          } catch {
            // Keep unresolved entries as ID-only placeholders.
          }
        }
      }
    }
    await emitProgress(onProgress, {
      source: "spotify",
      type: "playlist",
      stage: "fallback-matching",
      processed,
      matched: results.length,
      total: trackIds.length,
    });
    for (let index = 0; index < trackIds.length; index += 1) {
      const trackId = trackIds[index];
      if (deferEnabled && index >= eagerCount) {
        const hydrated = hydratedTracksById.get(trackId);
        results.push(hydrated ? toDeferredSpotifyTrack(hydrated, requester) : toDeferredSpotifyTrackFromId(trackId, requester, index));
        processed += 1;
        await emitProgress(onProgress, {
          source: "spotify",
          type: "playlist",
          stage: "fallback-matching",
          processed,
          matched: results.filter((entry) => !entry?.pendingResolve).length,
          total: trackIds.length,
        });
        // eslint-disable-next-line no-continue
        continue;
      }
      let track;
      try {
        track = await spotifyApiClient.getTrackById(trackId);
      } catch {
        processed += 1;
        await emitProgress(onProgress, {
          source: "spotify",
          type: "playlist",
          stage: "fallback-matching",
          processed,
          matched: results.length,
          total: trackIds.length,
        });
        // Ignore non-track IDs or inaccessible tracks and continue.
        // eslint-disable-next-line no-continue
        continue;
      }
      const queries = buildSpotifyQueries({
        name: track?.name,
        artists: Array.isArray(track?.artists) ? track.artists.map((artist) => artist.name) : [],
        album: track?.album?.name,
      });
      const spotifyDurationSec = getSpotifyDurationSeconds(track);
      const durationAwareMatch = await findBestYouTubeMatch(queries, requester, spotifyDurationSec);
      if (durationAwareMatch) {
        results.push(durationAwareMatch);
        processed += 1;
        await emitProgress(onProgress, {
          source: "spotify",
          type: "playlist",
          stage: "fallback-matching",
          processed,
          matched: results.length,
          total: trackIds.length,
        });
        // eslint-disable-next-line no-continue
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
      processed += 1;
      await emitProgress(onProgress, {
        source: "spotify",
        type: "playlist",
        stage: "fallback-matching",
        processed,
        matched: results.length,
        total: trackIds.length,
      });
    }
      await emitProgress(onProgress, {
        source: "spotify",
        type: "playlist",
        stage: "done",
        processed,
        matched: results.filter((entry) => !entry?.pendingResolve).length,
        total: trackIds.length,
        done: true,
      });
    return results;
  }

  async function getSpotifySearchOptions(url, requester) {
    const entity = getSpotifyEntityFromUrl(url);
    if (entity?.type === "track" && hasSpotifyCredentials() && spotifyApiClient?.hasCredentials?.()) {
      try {
        const apiTrack = await spotifyApiClient.getTrackById(entity.id);
        const apiQueries = buildSpotifyQueries({
          name: apiTrack?.name,
          artists: Array.isArray(apiTrack?.artists) ? apiTrack.artists.map((artist) => artist.name) : [],
          album: apiTrack?.album?.name,
        });
        const spotifyDurationSec = getSpotifyDurationSeconds(apiTrack);
        const durationAware = await findBestYouTubeMatch(apiQueries, requester, spotifyDurationSec);
        if (durationAware) {
          return [durationAware];
        }
        for (const query of apiQueries) {
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
      } catch (error) {
        logError("Spotify API search options failed", error);
      }
    }

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

  async function resolveSpotifyTracks(url, type, requester, onProgress = null) {
    const normalizedSpotifyUrl = normalizeSpotifyUrl(url);
    const entity = getSpotifyEntityFromUrl(normalizedSpotifyUrl);
    const hasCredentials = hasSpotifyCredentials();
    if (type === "track" && !hasCredentials) {
      const options = await getSpotifySearchOptions(normalizedSpotifyUrl, requester);
      return options.length ? [options[0]] : [];
    }

    if (!hasCredentials) {
      const credentialsError = new Error(
        "Spotify playlists and albums require API credentials (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN)."
      );
      credentialsError.code = "SPOTIFY_CREDENTIALS_MISSING";
      credentialsError.spotifyAccess = { type };
      throw credentialsError;
    }

    await ensureSpotifyReady();
    if (spotifyApiClient?.hasCredentials?.() && entity?.id) {
      try {
        if (type === "track" && entity.type === "track") {
          const apiTrack = await spotifyApiClient.getTrackById(entity.id);
          logInfo("Spotify track data", {
            name: apiTrack?.name,
            artists: Array.isArray(apiTrack?.artists) ? apiTrack.artists.map((artist) => artist.name) : [],
            album: apiTrack?.album?.name,
          });
          const queries = buildSpotifyQueries({
            name: apiTrack?.name,
            artists: Array.isArray(apiTrack?.artists) ? apiTrack.artists.map((artist) => artist.name) : [],
            album: apiTrack?.album?.name,
          });
          const spotifyDurationSec = getSpotifyDurationSeconds(apiTrack);
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

        if ((type === "playlist" && entity.type === "playlist") || (type === "album" && entity.type === "album")) {
          const listTracks = type === "playlist"
            ? await spotifyApiClient.getPlaylistTracksById(entity.id)
            : await spotifyApiClient.getAlbumTracksById(entity.id);
          let processed = 0;
          await emitProgress(onProgress, {
            source: "spotify",
            type,
            stage: "matching",
            processed,
            matched: 0,
            total: listTracks.length,
          });
          logInfo("Spotify list data", {
            type,
            totalTracks: listTracks.length,
          });
          const results = [];
          const deferEnabled = listTracks.length >= Math.max(1, Number(spotifyDeferResolveMinTracks) || 0);
          const eagerCount = Math.max(1, Number(spotifyDeferResolveEagerCount) || 1);
          if (deferEnabled) {
            for (let i = 0; i < listTracks.length; i += 1) {
              const track = listTracks[i];
              if (i < eagerCount) {
                const eagerResolved = await resolveSpotifyTrackToYouTube(track, requester);
                if (eagerResolved) {
                  results.push(eagerResolved);
                } else {
                  results.push(toDeferredSpotifyTrack(track, requester));
                }
              } else {
                results.push(toDeferredSpotifyTrack(track, requester));
              }
              processed += 1;
              await emitProgress(onProgress, {
                source: "spotify",
                type,
                stage: "matching",
                processed,
                matched: results.filter((entry) => !entry?.pendingResolve).length,
                total: listTracks.length,
              });
            }
            await emitProgress(onProgress, {
              source: "spotify",
              type,
              stage: "done",
              processed,
              matched: results.filter((entry) => !entry?.pendingResolve).length,
              total: listTracks.length,
              done: true,
            });
            return results;
          }
          for (const track of listTracks) {
            const queries = buildSpotifyQueries({
              name: track?.name,
              artists: Array.isArray(track?.artists) ? track.artists.map((artist) => artist.name) : [],
              album: track?.album?.name,
            });
            const spotifyDurationSec = getSpotifyDurationSeconds(track);
            const durationAwareMatch = await findBestYouTubeMatch(queries, requester, spotifyDurationSec);
            if (durationAwareMatch) {
              results.push(durationAwareMatch);
              processed += 1;
              await emitProgress(onProgress, {
                source: "spotify",
                type,
                stage: "matching",
                processed,
                matched: results.length,
                total: listTracks.length,
              });
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
            processed += 1;
            await emitProgress(onProgress, {
              source: "spotify",
              type,
              stage: "matching",
              processed,
              matched: results.length,
              total: listTracks.length,
            });
          }
          await emitProgress(onProgress, {
            source: "spotify",
            type,
            stage: "done",
            processed,
            matched: results.length,
            total: listTracks.length,
            done: true,
          });
          return results;
        }
      } catch (error) {
        if (error?.statusCode === 403) {
          logInfo("Spotify API access denied; attempting fallback resolution.", {
            type,
            url: normalizedSpotifyUrl,
            path: error?.path || null,
          });
        } else {
          logError("Spotify API resolve failed", {
            type,
            url: normalizedSpotifyUrl,
            error,
          });
        }
        if (error?.statusCode === 403) {
          await logSpotifyIdentityOn403();
        }
        if ((type === "playlist" || type === "album") && error?.statusCode === 403) {
          if (type === "playlist") {
            await emitProgress(onProgress, {
              source: "spotify",
              type: "playlist",
              stage: "fallback",
            });
            const pageFallbackResults = await resolveSpotifyPlaylistViaPageTrackIds(normalizedSpotifyUrl, requester, onProgress);
            if (pageFallbackResults.length) {
              logInfo("Spotify playlist resolved via page fallback", { totalTracks: pageFallbackResults.length });
              return pageFallbackResults;
            }
          }
          const accessDeniedError = new Error(
            "Spotify API denied access to that playlist/album (HTTP 403). If it is private or collaborative, re-authorize with `playlist-read-private playlist-read-collaborative` scopes (and ensure the authorizing account can access it)."
          );
          accessDeniedError.code = "SPOTIFY_PLAYLIST_ACCESS_DENIED";
          accessDeniedError.spotifyAccess = {
            type,
            hasPrivateShareToken: normalizedSpotifyUrl.includes("pt="),
          };
          throw accessDeniedError;
        }
      }
    }

    let info;
    try {
      info = await playdl.spotify(normalizedSpotifyUrl);
    } catch (error) {
      logError("Spotify API resolve failed", {
        type,
        url: normalizedSpotifyUrl,
        error,
      });
      if (type === "track") {
        const options = await getSpotifySearchOptions(normalizedSpotifyUrl, requester);
        return options.length ? [options[0]] : [];
      }
      return [];
    }
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
      let processed = 0;
      await emitProgress(onProgress, {
        source: "spotify",
        type: info.type,
        stage: "matching",
        processed,
        matched: 0,
        total: tracks.length,
      });
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
          processed += 1;
          await emitProgress(onProgress, {
            source: "spotify",
            type: info.type,
            stage: "matching",
            processed,
            matched: results.length,
            total: tracks.length,
          });
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
        processed += 1;
        await emitProgress(onProgress, {
          source: "spotify",
          type: info.type,
          stage: "matching",
          processed,
          matched: results.length,
          total: tracks.length,
        });
      }
      await emitProgress(onProgress, {
        source: "spotify",
        type: info.type,
        stage: "done",
        processed,
        matched: results.length,
        total: tracks.length,
        done: true,
      });
      return results;
    }

    return [];
  }

  return {
    getSpotifySearchOptions,
    isSpotifyUrl,
    getSpotifyEntityFromUrl,
    normalizeSpotifyUrl,
    hydrateDeferredSpotifyTrackMetadata,
    resolveSpotifyTracks,
    resolveDeferredSpotifyTrack,
  };
}

module.exports = {
  createSpotifyResolver,
};
