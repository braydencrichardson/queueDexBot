const fs = require("fs");
const path = require("path");
const https = require("https");

function createProviderBootstrap(deps) {
  const {
    playdl,
    logInfo,
    logError,
    sendDevAlert,
    env,
  } = deps;

  const {
    youtubeCookies,
    youtubeCookiesPath,
    youtubeUserAgent,
    soundcloudCookies,
    soundcloudCookiesPath,
    soundcloudUserAgent,
    spotifyClientId,
    spotifyClientSecret,
    spotifyRefreshToken,
    spotifyMarket,
  } = env;

  let soundcloudReady = false;
  let soundcloudClientId = null;
  let soundcloudCookieHeader = null;
  let youtubeReady = false;
  let youtubeCookieWarned = false;
  let youtubeCookieHeader = null;
  let youtubeCookiesNetscapePath = null;
  let youtubeCookieCheckOnFailure = false;
  let youtubeCookieAlerted = false;
  let spotifyReady = false;

  function hasNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function hasSpotifyCredentials() {
    return hasNonEmptyString(spotifyClientId)
      && hasNonEmptyString(spotifyClientSecret)
      && hasNonEmptyString(spotifyRefreshToken);
  }

  function getSpotifyCredentialState() {
    return {
      clientId: hasNonEmptyString(spotifyClientId),
      clientSecret: hasNonEmptyString(spotifyClientSecret),
      refreshToken: hasNonEmptyString(spotifyRefreshToken),
    };
  }

  function parseCookiesInput(rawInput) {
    if (!rawInput) {
      return null;
    }
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return null;
      }
    }

    return trimmed
      .split(";")
      .map((entry) => {
        const [rawKey, ...rest] = entry.split("=");
        const key = rawKey?.trim();
        if (!key) {
          return null;
        }
        return { name: key, value: rest.join("=").trim() };
      })
      .filter(Boolean);
  }

  function cookiesToHeader(cookiesInput) {
    if (!Array.isArray(cookiesInput)) {
      return null;
    }
    const parts = cookiesInput
      .map((cookie) => {
        if (!cookie?.name || cookie?.value === undefined) {
          return null;
        }
        return `${cookie.name}=${cookie.value}`;
      })
      .filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  }

  function filterYoutubeCookies(cookiesInput) {
    if (!Array.isArray(cookiesInput)) {
      return [];
    }
    return cookiesInput.filter((cookie) => {
      const domain = cookie?.domain || "";
      return domain.includes("youtube.com");
    });
  }

  function toNetscapeCookieLine(cookie) {
    const domain = cookie.domain || "";
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const pathValue = cookie.path || "/";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expiry = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
    const name = String(cookie.name || "").replace(/\t|\n/g, " ");
    const value = String(cookie.value ?? "").replace(/\t|\n/g, " ");
    return `${domain}\t${includeSubdomains}\t${pathValue}\t${secure}\t${expiry}\t${name}\t${value}`;
  }

  function writeNetscapeCookies(cookiesInput) {
    const lines = ["# Netscape HTTP Cookie File"];
    cookiesInput.forEach((cookie) => {
      if (!cookie?.name || cookie?.value === undefined || !cookie?.domain) {
        return;
      }
      lines.push(toNetscapeCookieLine(cookie));
    });
    const filePath = path.join("/tmp", "yt-dlp-cookies.txt");
    fs.writeFileSync(filePath, lines.join("\n"));
    return filePath;
  }

  function loadYoutubeCookies() {
    if (youtubeCookiesPath) {
      try {
        const fileContents = fs.readFileSync(youtubeCookiesPath, "utf8");
        return parseCookiesInput(fileContents);
      } catch (error) {
        logError("Failed to read YOUTUBE_COOKIES_PATH", error);
        return null;
      }
    }

    const defaultPath = path.join(process.cwd(), ".cookies.json");
    if (fs.existsSync(defaultPath)) {
      try {
        const fileContents = fs.readFileSync(defaultPath, "utf8");
        return parseCookiesInput(fileContents);
      } catch (error) {
        logError("Failed to read default .cookies.json", error);
      }
    }

    return parseCookiesInput(youtubeCookies);
  }

  function loadSoundcloudCookies() {
    if (soundcloudCookiesPath) {
      try {
        const fileContents = fs.readFileSync(soundcloudCookiesPath, "utf8");
        return parseCookiesInput(fileContents);
      } catch (error) {
        logError("Failed to read SOUNDCLOUD_COOKIES_PATH", error);
        return null;
      }
    }
    return parseCookiesInput(soundcloudCookies);
  }

  async function ensureSoundcloudReady() {
    if (soundcloudReady) {
      return;
    }
    try {
      const clientId = await playdl.getFreeClientID();
      await playdl.setToken({
        soundcloud: {
          client_id: clientId,
        },
      });
      soundcloudClientId = clientId;
      const soundcloudCookiesInput = loadSoundcloudCookies();
      soundcloudCookieHeader = cookiesToHeader(soundcloudCookiesInput);
      soundcloudReady = true;
      logInfo("SoundCloud client ID initialized", {
        hasSessionCookie: Boolean(soundcloudCookieHeader),
        cookieSource: soundcloudCookiesPath
          ? "SOUNDCLOUD_COOKIES_PATH"
          : soundcloudCookies
            ? "SOUNDCLOUD_COOKIES"
            : null,
      });
    } catch (error) {
      logError("SoundCloud initialization failed", error);
    }
  }

  async function ensureYoutubeReady() {
    if (youtubeReady) {
      return;
    }
    const cookiesInput = loadYoutubeCookies();
    if (!cookiesInput || !cookiesInput.length) {
      if (!youtubeCookieWarned) {
        logInfo("YouTube cookies missing or invalid. Use a JSON array on one line or set YOUTUBE_COOKIES_PATH.");
        youtubeCookieWarned = true;
      }
      return;
    }
    try {
      const filteredCookies = filterYoutubeCookies(cookiesInput);
      youtubeCookieHeader = cookiesToHeader(filteredCookies) || null;
      youtubeCookiesNetscapePath = writeNetscapeCookies(filteredCookies);
      if (youtubeCookieHeader || youtubeUserAgent) {
        await playdl.setToken({
          youtube: youtubeCookieHeader
            ? {
                cookie: youtubeCookieHeader,
              }
            : undefined,
          useragent: youtubeUserAgent ? [youtubeUserAgent] : undefined,
        });
      }
      youtubeReady = true;
      logInfo("YouTube cookies initialized", {
        count: cookiesInput.length,
        source: youtubeCookiesPath
          ? "YOUTUBE_COOKIES_PATH"
          : fs.existsSync(path.join(process.cwd(), ".cookies.json"))
            ? ".cookies.json"
            : "YOUTUBE_COOKIES",
      });
      const cookieCheck = await checkYoutubeCookiesLoggedIn(youtubeCookieHeader);
      if (!cookieCheck.ok) {
        logInfo("YouTube cookies may be invalid or expired.", cookieCheck);
        if (!youtubeCookieAlerted) {
          youtubeCookieAlerted = true;
          await sendDevAlert("YouTube cookies may be invalid or expired. Check logs for details.");
        }
      }
    } catch (error) {
      logError("YouTube cookie initialization failed", error);
    }
  }

  async function ensureSpotifyReady() {
    if (spotifyReady) {
      return;
    }
    if (!hasSpotifyCredentials()) {
      throw new Error("Spotify credentials missing. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN.");
    }
    await playdl.setToken({
      spotify: {
        client_id: spotifyClientId.trim(),
        client_secret: spotifyClientSecret.trim(),
        refresh_token: spotifyRefreshToken.trim(),
        market: spotifyMarket,
      },
    });
    spotifyReady = true;
    logInfo("Spotify API initialized");
  }

  function resetProviderState() {
    soundcloudReady = false;
    soundcloudClientId = null;
    soundcloudCookieHeader = null;
    youtubeReady = false;
    youtubeCookieHeader = null;
    youtubeCookiesNetscapePath = null;
    youtubeCookieCheckOnFailure = false;
    spotifyReady = false;
  }

  function checkYoutubeCookiesLoggedIn(cookieHeader) {
    if (!cookieHeader) {
      return Promise.resolve({ ok: false, reason: "missing_cookie_header" });
    }
    const headers = {
      "User-Agent": youtubeUserAgent || "Mozilla/5.0",
      Cookie: cookieHeader,
      "Accept-Language": "en-US,en;q=0.9",
    };
    const checkUrl = (url) =>
      new Promise((resolve) => {
        https
          .get(url, { headers }, (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              const location = String(res.headers.location || "");
              if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
                const needsLogin = /ServiceLogin|accounts\.google\.com/i.test(location);
                resolve({ ok: !needsLogin, reason: needsLogin ? "redirect_to_login" : "redirect" });
                return;
              }
              const body = data.slice(0, 20000);
              if (/signin|sign in/i.test(body)) {
                resolve({ ok: false, reason: "signin_marker" });
                return;
              }
              resolve({ ok: true, reason: "ok" });
            });
          })
          .on("error", () => resolve({ ok: false, reason: "request_failed" }));
      });

    return (async () => {
      const primary = await checkUrl("https://www.youtube.com/feed/subscriptions");
      if (primary.ok) {
        return { ...primary, url: "subscriptions" };
      }
      const secondary = await checkUrl("https://www.youtube.com/account");
      return { ...secondary, url: "account", fallbackFrom: primary.reason };
    })();
  }

  function resolveYoutubeCookieSourceLabel() {
    if (youtubeCookiesPath) {
      return "YOUTUBE_COOKIES_PATH";
    }
    if (fs.existsSync(path.join(process.cwd(), ".cookies.json"))) {
      return ".cookies.json";
    }
    if (youtubeCookies) {
      return "YOUTUBE_COOKIES";
    }
    return null;
  }

  function resolveSoundcloudCookieSourceLabel() {
    if (soundcloudCookiesPath) {
      return "SOUNDCLOUD_COOKIES_PATH";
    }
    if (soundcloudCookies) {
      return "SOUNDCLOUD_COOKIES";
    }
    return null;
  }

  function getProviderStatus() {
    return {
      soundcloud: {
        ready: Boolean(soundcloudReady),
        hasClientId: Boolean(soundcloudClientId),
        hasCookieHeader: Boolean(soundcloudCookieHeader),
        cookieSource: resolveSoundcloudCookieSourceLabel(),
      },
      youtube: {
        ready: Boolean(youtubeReady),
        hasCookieHeader: Boolean(youtubeCookieHeader),
        hasNetscapeCookieFile: Boolean(youtubeCookiesNetscapePath),
        cookieSource: resolveYoutubeCookieSourceLabel(),
        userAgentConfigured: Boolean(youtubeUserAgent),
      },
      spotify: {
        ready: Boolean(spotifyReady),
        hasCredentials: hasSpotifyCredentials(),
        credentials: getSpotifyCredentialState(),
      },
      updatedAt: Date.now(),
    };
  }

  async function verifyProviderAuthStatus() {
    const startedAt = Date.now();

    await ensureSoundcloudReady();
    await ensureYoutubeReady();
    if (hasSpotifyCredentials()) {
      try {
        await ensureSpotifyReady();
      } catch {
        // Errors are already logged in ensureSpotifyReady callers; status response captures readiness.
      }
    }

    const youtubeCookieCheck = youtubeCookieHeader
      ? await checkYoutubeCookiesLoggedIn(youtubeCookieHeader)
      : { ok: false, reason: "missing_cookie_header" };

    const status = getProviderStatus();
    const soundcloudOk = Boolean(status.soundcloud.ready && status.soundcloud.hasClientId);
    const youtubeOk = Boolean(status.youtube.ready && youtubeCookieCheck.ok);
    const spotifyRequired = Boolean(status.spotify.hasCredentials);
    const spotifyOk = spotifyRequired ? Boolean(status.spotify.ready) : true;

    return {
      soundcloud: {
        ok: soundcloudOk,
        ...status.soundcloud,
      },
      youtube: {
        ok: youtubeOk,
        ...status.youtube,
        cookieCheck: youtubeCookieCheck,
      },
      spotify: {
        ok: spotifyOk,
        ...status.spotify,
      },
      overallOk: Boolean(soundcloudOk && youtubeOk && spotifyOk),
      checkedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }

  async function tryCheckYoutubeCookiesOnFailure() {
    if (youtubeCookieCheckOnFailure || !youtubeCookieHeader) {
      return;
    }
    youtubeCookieCheckOnFailure = true;
    const cookieCheck = await checkYoutubeCookiesLoggedIn(youtubeCookieHeader);
    if (!cookieCheck.ok) {
      logInfo("YouTube cookies may be invalid or expired.", cookieCheck);
      if (!youtubeCookieAlerted) {
        youtubeCookieAlerted = true;
        await sendDevAlert("YouTube cookies may be invalid or expired. Check logs for details.");
      }
    }
  }

  async function warmupProviders() {
    await Promise.all([ensureSoundcloudReady(), ensureYoutubeReady()]);
    const spotifyCredentialState = getSpotifyCredentialState();
    if (!hasSpotifyCredentials()) {
      logInfo("Spotify credentials not fully configured; Spotify track/playlist API features disabled.", spotifyCredentialState);
      return {
        soundcloudReady,
        youtubeReady,
        spotifyReady,
        hasSpotifyCredentials: false,
      };
    }
    logInfo("Spotify credentials detected; validating Spotify API token.");
    try {
      await ensureSpotifyReady();
    } catch (error) {
      logError("Spotify initialization failed", error);
      await sendDevAlert("Spotify credentials detected but initialization failed. Check logs for details.");
    }
    return {
      soundcloudReady,
      youtubeReady,
      spotifyReady,
      hasSpotifyCredentials: true,
    };
  }

  async function reinitializeProviders() {
    resetProviderState();
    return warmupProviders();
  }

  return {
    getSoundcloudClientId: () => soundcloudClientId,
    getSoundcloudCookieHeader: () => soundcloudCookieHeader,
    getYoutubeCookiesNetscapePath: () => youtubeCookiesNetscapePath,
    getProviderStatus,
    verifyProviderAuthStatus,
    hasSpotifyCredentials,
    tryCheckYoutubeCookiesOnFailure,
    ensureSoundcloudReady,
    ensureSpotifyReady,
    ensureYoutubeReady,
    warmupProviders,
    reinitializeProviders,
  };
}

module.exports = {
  createProviderBootstrap,
};
