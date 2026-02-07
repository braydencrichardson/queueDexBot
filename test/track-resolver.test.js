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
