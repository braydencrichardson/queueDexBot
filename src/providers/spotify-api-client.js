const https = require("https");

function createSpotifyApiClient(deps) {
  const {
    clientId,
    clientSecret,
    refreshToken,
    market = "US",
    httpsModule = https,
    requestTimeoutMs = 12000,
    logInfo = () => {},
  } = deps;

  let accessToken = null;
  let accessTokenExpiresAtMs = 0;
  let tokenRefreshPromise = null;
  let appAccessToken = null;
  let appAccessTokenExpiresAtMs = 0;
  let appTokenRefreshPromise = null;

  function hasCredentials() {
    return typeof clientId === "string" && clientId.trim()
      && typeof clientSecret === "string" && clientSecret.trim()
      && typeof refreshToken === "string" && refreshToken.trim();
  }

  function requestRaw(options, body = null) {
    return new Promise((resolve, reject) => {
      const req = httpsModule.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: data,
          });
        });
      });
      req.setTimeout(requestTimeoutMs, () => {
        req.destroy(new Error(`HTTP request timeout after ${requestTimeoutMs}ms`));
      });
      req.on("error", reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  async function refreshAccessToken() {
    if (!hasCredentials()) {
      throw new Error("Spotify API client credentials missing.");
    }
    const b64 = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString("base64");
    const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken.trim())}`;
    const response = await requestRaw({
      method: "POST",
      hostname: "accounts.spotify.com",
      path: "/api/token",
      headers: {
        Authorization: `Basic ${b64}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, body);

    if (response.statusCode >= 400) {
      throw new Error(`Spotify token refresh failed (HTTP ${response.statusCode})`);
    }

    let parsed;
    try {
      parsed = JSON.parse(response.body || "{}");
    } catch {
      throw new Error("Spotify token refresh returned invalid JSON");
    }
    if (!parsed?.access_token) {
      throw new Error("Spotify token refresh did not return access_token");
    }
    const expiresInSec = Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
    accessToken = parsed.access_token;
    accessTokenExpiresAtMs = Date.now() + Math.max(60, expiresInSec - 30) * 1000;
    logInfo("Spotify API access token refreshed", { expiresInSec });
    return accessToken;
  }

  async function refreshAppAccessToken() {
    if (!hasCredentials()) {
      throw new Error("Spotify API client credentials missing.");
    }
    const b64 = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString("base64");
    const body = "grant_type=client_credentials";
    const response = await requestRaw({
      method: "POST",
      hostname: "accounts.spotify.com",
      path: "/api/token",
      headers: {
        Authorization: `Basic ${b64}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, body);

    if (response.statusCode >= 400) {
      throw new Error(`Spotify app token refresh failed (HTTP ${response.statusCode})`);
    }

    let parsed;
    try {
      parsed = JSON.parse(response.body || "{}");
    } catch {
      throw new Error("Spotify app token refresh returned invalid JSON");
    }
    if (!parsed?.access_token) {
      throw new Error("Spotify app token refresh did not return access_token");
    }
    const expiresInSec = Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
    appAccessToken = parsed.access_token;
    appAccessTokenExpiresAtMs = Date.now() + Math.max(60, expiresInSec - 30) * 1000;
    logInfo("Spotify API app access token refreshed", { expiresInSec });
    return appAccessToken;
  }

  async function getAccessToken() {
    if (!hasCredentials()) {
      throw new Error("Spotify API client credentials missing.");
    }
    if (accessToken && Date.now() < accessTokenExpiresAtMs) {
      return accessToken;
    }
    if (!tokenRefreshPromise) {
      tokenRefreshPromise = refreshAccessToken().finally(() => {
        tokenRefreshPromise = null;
      });
    }
    return tokenRefreshPromise;
  }

  async function getAppAccessToken() {
    if (!hasCredentials()) {
      throw new Error("Spotify API client credentials missing.");
    }
    if (appAccessToken && Date.now() < appAccessTokenExpiresAtMs) {
      return appAccessToken;
    }
    if (!appTokenRefreshPromise) {
      appTokenRefreshPromise = refreshAppAccessToken().finally(() => {
        appTokenRefreshPromise = null;
      });
    }
    return appTokenRefreshPromise;
  }

  async function requestSpotifyJsonWithToken(path, getToken, { retryOnAuthError = true } = {}) {
    const token = await getToken();
    const response = await requestRaw({
      method: "GET",
      hostname: "api.spotify.com",
      path,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (response.statusCode === 401 && retryOnAuthError) {
      if (getToken === getAccessToken) {
        accessToken = null;
        accessTokenExpiresAtMs = 0;
      } else {
        appAccessToken = null;
        appAccessTokenExpiresAtMs = 0;
      }
      await getToken();
      return requestSpotifyJsonWithToken(path, getToken, { retryOnAuthError: false });
    }
    if (response.statusCode >= 400) {
      let spotifyError = null;
      try {
        spotifyError = JSON.parse(response.body || "{}")?.error || null;
      } catch {
        spotifyError = null;
      }
      const reason = spotifyError?.reason || spotifyError?.message || null;
      const error = new Error(
        reason
          ? `Spotify API request failed (HTTP ${response.statusCode}): ${reason}`
          : `Spotify API request failed (HTTP ${response.statusCode})`
      );
      error.statusCode = response.statusCode;
      error.spotifyError = spotifyError;
      error.path = path;
      throw error;
    }
    try {
      return JSON.parse(response.body || "{}");
    } catch {
      throw new Error("Spotify API returned invalid JSON");
    }
  }

  async function requestSpotifyJson(path, { retryOnAuthError = true } = {}) {
    return requestSpotifyJsonWithToken(path, getAccessToken, { retryOnAuthError });
  }

  async function requestSpotifyJsonAsApp(path, { retryOnAuthError = true } = {}) {
    return requestSpotifyJsonWithToken(path, getAppAccessToken, { retryOnAuthError });
  }

  function parseNextPath(nextUrl) {
    if (!nextUrl) {
      return null;
    }
    try {
      const parsed = new URL(nextUrl);
      return `${parsed.pathname}${parsed.search || ""}`;
    } catch {
      return null;
    }
  }

  function withMarket(path) {
    if (!market) {
      return path;
    }
    const hasQuery = path.includes("?");
    const marketParam = `market=${encodeURIComponent(market)}`;
    return hasQuery ? `${path}&${marketParam}` : `${path}?${marketParam}`;
  }

  async function requestWithOptionalMarket(basePath) {
    const marketPath = withMarket(basePath);
    const triedMarketPath = marketPath !== basePath;
    try {
      return await requestSpotifyJson(marketPath);
    } catch (error) {
      // Some Spotify resources can return 403 for explicit market overrides.
      // Retry once without market to use token/account defaults.
      if (triedMarketPath && error?.statusCode === 403) {
        return requestSpotifyJson(basePath);
      }
      throw error;
    }
  }

  async function getTrackById(trackId) {
    const path = `/v1/tracks/${encodeURIComponent(trackId)}`;
    try {
      return await requestWithOptionalMarket(path);
    } catch (error) {
      if (error?.statusCode === 403) {
        return requestSpotifyJsonAsApp(path);
      }
      throw error;
    }
  }

  async function getTracksByIds(trackIds) {
    if (!Array.isArray(trackIds) || !trackIds.length) {
      return [];
    }
    const deduped = Array.from(new Set(trackIds.filter(Boolean).map((id) => String(id).trim()).filter(Boolean)));
    const chunks = [];
    for (let i = 0; i < deduped.length; i += 50) {
      chunks.push(deduped.slice(i, i + 50));
    }
    const byId = new Map();
    for (const chunk of chunks) {
      const idsParam = chunk.map((id) => encodeURIComponent(id)).join(",");
      const path = `/v1/tracks?ids=${idsParam}`;
      let payload;
      try {
        payload = await requestWithOptionalMarket(path);
      } catch (error) {
        if (error?.statusCode === 403) {
          try {
            payload = await requestSpotifyJsonAsApp(path);
          } catch {
            payload = null;
          }
        } else {
          throw error;
        }
      }
      if (!payload) {
        logInfo("Spotify track batch hydration failed; skipping bulk hydration for this chunk", {
          chunkSize: chunk.length,
        });
        // Defer item-level metadata hydration to higher-level prefetch/background flow.
        continue;
      }
      const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
      tracks.forEach((track) => {
        if (track?.id) {
          byId.set(track.id, track);
        }
      });
    }
    return trackIds.map((id) => byId.get(String(id).trim()) || null);
  }

  async function getCurrentUserProfile() {
    return requestSpotifyJson("/v1/me");
  }

  async function getPlaylistTracksById(playlistId) {
    const basePath = `/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&offset=0`;
    const marketPath = withMarket(basePath);
    const triedMarketPath = marketPath !== basePath;
    let path = marketPath;
    let useAppToken = false;
    const tracks = [];
    while (path) {
      let page;
      try {
        page = useAppToken ? await requestSpotifyJsonAsApp(path) : await requestSpotifyJson(path);
      } catch (error) {
        if (triedMarketPath && path === marketPath && error?.statusCode === 403 && !useAppToken) {
          path = basePath;
          // Retry first page once without market.
          // eslint-disable-next-line no-continue
          continue;
        }
        if (error?.statusCode === 403 && !useAppToken) {
          useAppToken = true;
          path = basePath;
          logInfo("Spotify playlist API denied user token; retrying with app token for public access.");
          // eslint-disable-next-line no-continue
          continue;
        }
        throw error;
      }
      const items = Array.isArray(page?.items) ? page.items : [];
      items.forEach((item) => {
        const track = item?.track;
        if (track && !track.is_local) {
          tracks.push(track);
        }
      });
      path = parseNextPath(page?.next);
    }
    return tracks;
  }

  async function getAlbumTracksById(albumId) {
    let album;
    try {
      album = await requestWithOptionalMarket(`/v1/albums/${encodeURIComponent(albumId)}`);
    } catch (error) {
      if (error?.statusCode === 403) {
        album = await requestSpotifyJsonAsApp(`/v1/albums/${encodeURIComponent(albumId)}`);
      } else {
        throw error;
      }
    }
    const albumName = album?.name || null;
    const tracks = [];
    let nextPath = parseNextPath(album?.tracks?.next);
    const firstPageItems = Array.isArray(album?.tracks?.items) ? album.tracks.items : [];
    firstPageItems.forEach((track) => {
      tracks.push({
        ...track,
        album: { name: albumName },
      });
    });
    while (nextPath) {
      let page;
      try {
        page = await requestSpotifyJson(nextPath);
      } catch (error) {
        if (error?.statusCode === 403) {
          page = await requestSpotifyJsonAsApp(nextPath);
        } else {
          throw error;
        }
      }
      const items = Array.isArray(page?.items) ? page.items : [];
      items.forEach((track) => {
        tracks.push({
          ...track,
          album: { name: albumName },
        });
      });
      nextPath = parseNextPath(page?.next);
    }
    return tracks;
  }

  return {
    hasCredentials,
    getCurrentUserProfile,
    getTrackById,
    getTracksByIds,
    getPlaylistTracksById,
    getAlbumTracksById,
  };
}

module.exports = {
  createSpotifyApiClient,
};
