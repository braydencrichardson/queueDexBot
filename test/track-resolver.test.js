const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { createTrackResolver } = require("../src/providers/track-resolver");
const { getYoutubeId, toShortYoutubeUrl } = require("../src/providers/youtube-search");

function buildResolver(overrides = {}) {
  const deps = {
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used in this test");
      },
      search: async () => [],
      sp_validate: () => null,
      yt_validate: () => null,
      video_basic_info: async () => ({
        video_details: {
          id: "IrdYueB9pY4",
          title: "Test Video",
          durationInSec: 123,
          url: "https://www.youtube.com/watch?v=IrdYueB9pY4",
        },
      }),
      playlist_info: async () => ({
        async fetch() {},
        videos: [],
      }),
      spotify: async () => ({ type: "track", name: "n", artists: [], album: { name: "a" } }),
      setToken: async () => {},
    },
    searchYouTubeOptions: async () => [],
    searchYouTubePreferred: async () => null,
    getYoutubeId,
    toShortYoutubeUrl,
    ensureSoundcloudReady: async () => {},
    ensureYoutubeReady: async () => {},
    ensureSpotifyReady: async () => {},
    hasSpotifyCredentials: () => false,
    getSoundcloudClientId: () => null,
    searchChooserMaxResults: 5,
    soundcloudUserAgent: "",
    youtubeUserAgent: "",
    logInfo: () => {},
    logError: () => {},
    ...overrides,
  };

  return createTrackResolver(deps);
}

test("isSpotifyUrl and isProbablyUrl basic cases", () => {
  const resolver = buildResolver();

  assert.equal(resolver.isSpotifyUrl("https://open.spotify.com/track/abc"), true);
  assert.equal(resolver.isSpotifyUrl("https://example.com/track/abc"), false);

  assert.equal(resolver.isProbablyUrl("https://example.com/path"), true);
  assert.equal(resolver.isProbablyUrl("not-a-url"), false);
});

test("resolveTracks returns youtube video result when yt_validate=video", async () => {
  const resolver = buildResolver({
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used");
      },
      search: async () => [],
      sp_validate: () => null,
      yt_validate: () => "video",
      video_basic_info: async () => ({
        video_details: {
          id: "IrdYueB9pY4",
          title: "Video Title",
          durationInSec: 222,
          url: "https://www.youtube.com/watch?v=IrdYueB9pY4",
        },
      }),
      playlist_info: async () => ({ async fetch() {}, videos: [] }),
      spotify: async () => ({ type: "track", name: "n", artists: [], album: { name: "a" } }),
      setToken: async () => {},
    },
  });

  const tracks = await resolver.resolveTracks("https://www.youtube.com/watch?v=IrdYueB9pY4", "Requester");

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].source, "youtube");
  assert.equal(tracks[0].title, "Video Title");
  assert.equal(tracks[0].url, "https://youtu.be/IrdYueB9pY4");
  assert.equal(tracks[0].requester, "Requester");
});

test("resolveTracks normalizes http youtube URL to https before validation", async () => {
  let seenValidateQuery = null;
  let seenInfoQuery = null;

  const resolver = buildResolver({
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used");
      },
      search: async () => [],
      sp_validate: () => null,
      yt_validate: (query) => {
        seenValidateQuery = query;
        return query.startsWith("https://") ? "video" : "search";
      },
      video_basic_info: async (query) => {
        seenInfoQuery = query;
        return {
          video_details: {
            id: "SqD_8FGk89o",
            title: "Normalized Video",
            durationInSec: 111,
            url: "https://www.youtube.com/watch?v=SqD_8FGk89o",
          },
        };
      },
      playlist_info: async () => ({ async fetch() {}, videos: [] }),
      spotify: async () => ({ type: "track", name: "n", artists: [], album: { name: "a" } }),
      setToken: async () => {},
    },
    searchYouTubePreferred: async () => null,
  });

  const tracks = await resolver.resolveTracks("http://youtube.com/watch?v=SqD_8FGk89o", "Requester");

  assert.equal(seenValidateQuery, "https://www.youtube.com/watch?v=SqD_8FGk89o");
  assert.equal(seenInfoQuery, "https://www.youtube.com/watch?v=SqD_8FGk89o");
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].url, "https://youtu.be/SqD_8FGk89o");
});

test("resolveTracks treats malformed YouTube short URL as non-direct when search fallback is disabled", async () => {
  let basicInfoCalls = 0;
  let searchCalls = 0;
  const resolver = buildResolver({
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used");
      },
      search: async () => [],
      sp_validate: () => null,
      yt_validate: () => "video",
      video_basic_info: async () => {
        basicInfoCalls += 1;
        return {
          video_details: {
            id: "IrdYueB9pY4",
            title: "Unexpected Direct",
            durationInSec: 222,
            url: "https://www.youtube.com/watch?v=IrdYueB9pY4",
          },
        };
      },
      playlist_info: async () => ({ async fetch() {}, videos: [] }),
      spotify: async () => ({ type: "track", name: "n", artists: [], album: { name: "a" } }),
      setToken: async () => {},
    },
    searchYouTubePreferred: async () => {
      searchCalls += 1;
      return {
        title: "Search Result",
        url: "https://youtu.be/SqD_8FGk89o",
        source: "youtube",
        duration: 111,
      };
    },
  });

  const directOnly = await resolver.resolveTracks("https://youtu.be/ok", "Requester", { allowSearchFallback: false });
  assert.deepEqual(directOnly, []);
  assert.equal(basicInfoCalls, 0);
  assert.equal(searchCalls, 0);

  const withFallback = await resolver.resolveTracks("https://youtu.be/ok", "Requester");
  assert.equal(withFallback.length, 1);
  assert.equal(withFallback[0].title, "Search Result");
  assert.equal(searchCalls, 1);
});

test("resolveTracks treats Spotify track without credentials as non-direct when search fallback is disabled", async () => {
  let searchOptionsCalls = 0;
  const httpsModule = {
    get(url, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};

      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.resume = () => {};
        callback(res);
        if (String(url).includes("/oembed?")) {
          res.emit("data", JSON.stringify({ title: "Song", author_name: "Artist" }));
        } else {
          res.emit("data", '<meta property="og:title" content="Song"><meta property="og:description" content="Track · Artist">');
        }
        res.emit("end");
      });

      return req;
    },
  };
  const resolver = buildResolver({
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used");
      },
      search: async () => [],
      sp_validate: () => "track",
      yt_validate: () => null,
      video_basic_info: async () => ({ video_details: {} }),
      playlist_info: async () => ({ async fetch() {}, videos: [] }),
      spotify: async () => ({ type: "track", name: "ignored", artists: [], album: { name: "ignored" } }),
      setToken: async () => {},
    },
    searchYouTubeOptions: async () => {
      searchOptionsCalls += 1;
      return [
        {
          title: "Matched Spotify Track",
          url: "https://youtu.be/SqD_8FGk89o",
          source: "youtube",
          duration: 123,
          requester: "Requester",
        },
      ];
    },
    hasSpotifyCredentials: () => false,
    httpsModule,
  });

  const directOnly = await resolver.resolveTracks("https://open.spotify.com/track/abc123", "Requester", { allowSearchFallback: false });
  assert.deepEqual(directOnly, []);

  const searchOptions = await resolver.getSearchOptionsForQuery("https://open.spotify.com/track/abc123", "Requester");
  assert.equal(searchOptions.length, 1);
  assert.equal(searchOptions[0].title, "Matched Spotify Track");
  assert.equal(searchOptionsCalls >= 1, true);
});

test("resolveTracks falls back to searchYouTubePreferred for plain queries", async () => {
  const expected = {
    title: "Best Match",
    url: "https://youtu.be/eLvXS6J_ETQ",
    source: "youtube",
    duration: 210,
    requester: "Requester",
  };

  const resolver = buildResolver({
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used");
      },
      search: async () => [],
      sp_validate: () => null,
      yt_validate: () => null,
      video_basic_info: async () => ({ video_details: {} }),
      playlist_info: async () => ({ async fetch() {}, videos: [] }),
      spotify: async () => ({ type: "track", name: "n", artists: [], album: { name: "a" } }),
      setToken: async () => {},
    },
    searchYouTubePreferred: async (query, requester) => ({ ...expected, requester, querySeen: query }),
  });

  const tracks = await resolver.resolveTracks("some search terms", "Requester");

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, expected.title);
  assert.equal(tracks[0].url, expected.url);
  assert.equal(tracks[0].requester, "Requester");
});

test("resolveTracks applies configured HTTP timeout to external metadata requests", async () => {
  const timeoutValues = [];
  const httpsModule = {
    get(url, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const req = new EventEmitter();
      req.setTimeout = (ms) => {
        timeoutValues.push(ms);
      };
      req.destroy = () => {};

      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.resume = () => {};
        callback(res);
        if (String(url).includes("/oembed?")) {
          res.emit("data", JSON.stringify({ title: "Song", author_name: "Artist" }));
        } else {
          res.emit("data", '<meta property="og:title" content="Song"><meta property="og:description" content="Track · Artist">');
        }
        res.emit("end");
      });

      return req;
    },
  };

  const resolver = buildResolver({
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used");
      },
      search: async () => [],
      sp_validate: () => "track",
      yt_validate: () => null,
      video_basic_info: async () => ({ video_details: {} }),
      playlist_info: async () => ({ async fetch() {}, videos: [] }),
      spotify: async () => ({ type: "track", name: "n", artists: [], album: { name: "a" } }),
      setToken: async () => {},
    },
    httpsModule,
    httpTimeoutMs: 4321,
    searchYouTubeOptions: async () => [],
  });

  const tracks = await resolver.resolveTracks("https://open.spotify.com/track/abc123", "Requester");

  assert.deepEqual(tracks, []);
  assert.equal(timeoutValues.length >= 2, true);
  assert.equal(timeoutValues.every((value) => value === 4321), true);
});

test("resolveTracks hydrates SoundCloud playlist when resolve payload has partial tracks", async () => {
  let resolveCalls = 0;
  let playlistCalls = 0;
  const httpsModule = {
    get(url, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};

      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.resume = () => {};
        callback(res);
        const urlText = String(url);
        if (urlText.includes("/resolve?")) {
          resolveCalls += 1;
          res.emit("data", JSON.stringify({
            kind: "playlist",
            id: 123,
            tracks: [
              { title: "Track 1", permalink_url: "https://soundcloud.com/u/track-1", duration: 1000 },
              { id: 2 },
            ],
          }));
        } else if (urlText.includes("/playlists/123?")) {
          playlistCalls += 1;
          res.emit("data", JSON.stringify({
            tracks: [
              { title: "Track 1", permalink_url: "https://soundcloud.com/u/track-1", duration: 1000 },
              { title: "Track 2", permalink_url: "https://soundcloud.com/u/track-2", duration: 2000 },
            ],
          }));
        } else {
          res.emit("data", JSON.stringify({}));
        }
        res.emit("end");
      });

      return req;
    },
  };

  const resolver = buildResolver({
    playdl: {
      so_validate: async () => null,
      soundcloud: async () => {
        throw new Error("not used");
      },
      search: async () => [],
      sp_validate: () => null,
      yt_validate: () => null,
      video_basic_info: async () => ({ video_details: {} }),
      playlist_info: async () => ({ async fetch() {}, videos: [] }),
      spotify: async () => ({ type: "track", name: "n", artists: [], album: { name: "a" } }),
      setToken: async () => {},
    },
    getSoundcloudClientId: () => "test-client-id",
    httpsModule,
    searchYouTubePreferred: async () => null,
  });

  const tracks = await resolver.resolveTracks("https://soundcloud.com/user/sets/sample", "Requester");

  assert.equal(resolveCalls >= 1, true);
  assert.equal(playlistCalls, 1);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].title, "Track 1");
  assert.equal(tracks[0].url, "https://soundcloud.com/u/track-1");
  assert.equal(tracks[1].title, "Track 2");
  assert.equal(tracks[1].url, "https://soundcloud.com/u/track-2");
  assert.equal(tracks[0].requester, "Requester");
  assert.equal(tracks[1].requester, "Requester");
});
