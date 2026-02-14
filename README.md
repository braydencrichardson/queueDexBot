# queueDexBot

A Discord music bot with YouTube/SoundCloud playback, queue controls, and search/selection UI.
Can queue from Spotify share links (will search title/artist on YouTube)

## Requirements

- Node.js 16+ (Discord.js v13)
- npm
- `yt-dlp` (required)
- Python 3 + venv (recommended for reliable `yt-dlp`)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file:

```bash
cp .env.example .env
```

3. Fill in required values in `.env`:

- `DISCORD_TOKEN`
- `APPLICATION_ID`
- `GUILD_ID` (optional; required only for guild-scoped deploys)

4. Install `yt-dlp` in a venv (recommended):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install yt-dlp
```

Set `YTDLP_PATH` to the venv binary, e.g.:

```
YTDLP_PATH=/path/to/project/.venv/bin/yt-dlp
```

## Environment Variables

Core Discord/deploy:

- `DISCORD_TOKEN`: Required bot token.
- `APPLICATION_ID`: Required for `deploy-commands.js`.
- `GUILD_ID`: Optional; required for guild-scoped command deploys.
- `DEPLOY_COMMANDS_TARGET`: Optional default deploy target. Valid values: `global`, `guild`.

yt-dlp / YouTube:

- `YTDLP_PATH`: Path to `yt-dlp` binary (default: `yt-dlp`).
- `YTDLP_PLAYER_CLIENT`: Primary yt-dlp YouTube player client (default: `web`).
- `YTDLP_FALLBACK_PLAYER_CLIENT`: Secondary fallback client (default: `android`).
- `YTDLP_STREAM`: Use yt-dlp stream mode (`1`) or download mode (`0`, default).
- `YTDLP_CONCURRENT_FRAGMENTS`: Optional integer for yt-dlp fragment concurrency.
- `YTDLP_COOKIES_FROM_BROWSER`: Optional browser profile source for yt-dlp cookies.
- `YTDLP_JS_RUNTIME`: yt-dlp JS runtime option (default: `node`).
- `YTDLP_REMOTE_COMPONENTS`: yt-dlp remote components source (default: `ejs:github`).
- `YOUTUBE_COOKIES`: Optional cookie header or JSON cookie array.
- `YOUTUBE_COOKIES_PATH`: Optional path to YouTube cookies file.
- `YOUTUBE_USER_AGENT`: Optional user agent for YouTube and metadata HTTP requests.

SoundCloud:

- `SOUNDCLOUD_COOKIES`: Optional SoundCloud cookie header or JSON cookie array.
- `SOUNDCLOUD_COOKIES_PATH`: Optional path to SoundCloud cookies JSON file.
- `SOUNDCLOUD_USER_AGENT`: Optional user agent for SoundCloud requests.

Spotify:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`
Required together for Spotify playlist/album resolution.



Code constants (not `.env`):

- Presence (`status`, `activityName`, `activityType`), queue/search tuning, resolver timeouts, stream timeout, and Spotify market are in `src/config/constants.js`.

Dev logging:

- `DEV_ALERT_CHANNEL_ID`: Optional Discord channel for alert messages.
- `DEV_LOG_CHANNEL_ID`: Optional Discord channel for verbose log forwarding.

## Register Commands

```bash
node deploy-commands.js
```

By default, commands deploy globally. To override:

```bash
# force global
node deploy-commands.js --global

# force guild (requires GUILD_ID)
node deploy-commands.js --guild
```

Optional: set a default target in `.env`:

```
DEPLOY_COMMANDS_TARGET=global
# or
DEPLOY_COMMANDS_TARGET=guild
```

Global commands can take up to an hour to propagate.

## Verify Registered Commands

```bash
# verify both global and guild commands
node verify-commands.js

# verify global only
node verify-commands.js --global

# verify guild only
node verify-commands.js --guild
```

You can also run via npm:

```bash
npm run verify-commands
npm run verify-commands -- --global
npm run verify-commands -- --guild
```

## Run the Bot

```bash
npm start
```

## Commands

- `/play query:<url or search>`: Resolve and queue one or more tracks.
- `/join`: Join your current voice channel.
- `/playing`: Post now-playing controls in channel.
- `/pause`, `/resume`, `/skip`, `/stop`: Playback controls.
- `/queue view|clear|shuffle|remove|move`: Queue management.

## Expected Behavior

### Resolution

- `/play` tries direct resolution first.
- If direct resolution fails, it can post an interactive search chooser (owner-only, time-limited) and queue your selection.
- Spotify `track` links work with or without Spotify credentials.
- Spotify `playlist`/`album` resolution requires Spotify credentials.
- Spotify playlist/album failures do not fall back to generic URL search to avoid unrelated tracks.
- SoundCloud discover links (`/discover/sets/...`) use API first, then a session-cookie fallback parser when configured.
- SoundCloud discover failures are shown to users as a generic message

### Playback And Queue

- Queue entries missing URLs or failing to load are skipped, and playback continues to next playable item.
- The bot preloads the next track when possible to reduce transition gaps.
- Now-playing includes progress and up-next, with message refresh while playing.
- Queue/selection controls are requester-scoped (other users cannot operate owner-only controls).

### Voice And Inactivity

- If a voice channel becomes empty, playback is paused and an inactivity timer starts.
- If nobody rejoins before timeout, queue is cleared and the bot disconnects.
- If someone rejoins before timeout, playback resumes (when it was paused for inactivity).

### Provider Lifecycle And Alerts

- Providers warm up on startup (SoundCloud, YouTube, and Spotify when credentials exist).
- A full provider re-initialization runs every 12 hours.
- Re-init updates provider auth/session state and does not intentionally stop currently playing audio.
- `DEV_LOG_CHANNEL_ID` receives verbose operational logs.
- `DEV_ALERT_CHANNEL_ID` receives alerts for resolver/provider failures, including likely expired YouTube/SoundCloud cookies and degraded provider re-init status.


## Provider Auth

### YouTube Cookies

If YouTube requires cookies, export them with `yt-dlp` in **JSON format** and point the bot at the file.

Example: (haven't tested)

```bash
yt-dlp --cookies-from-browser chrome --dump-cookies youtube-cookies.json
```

Set in `.env`:

```
YOUTUBE_COOKIES_PATH=/path/to/youtube-cookies.json
```

### SoundCloud Cookies

If SoundCloud discover links stop resolving, refresh your SoundCloud cookies.

1. Open your browser and sign in to the SoundCloud account you want the bot to use.
2. Use the **Export cookie JSON file for Puppeteer** extension to export cookies as JSON.
3. Save the file on the bot host (file-based cookies are easier to maintain than inline env values).
4. Point `.env` to that file:

```env
SOUNDCLOUD_COOKIES_PATH=/path/to/.soundcloudcookies.json
```

5. Restart the bot.

Notes:
- Keep `soundcloud.com` cookies in the exported file, including `oauth_token`.
- Session cookies expire/rotate, so periodic re-export is expected.

### Getting a New Spotify Refresh Token

Use this when `SPOTIFY_REFRESH_TOKEN` expires/revokes or you want to rotate credentials.

1. In the Spotify Developer Dashboard app settings, add a redirect URI (example: `https://127.0.0.1:8888/callback`).
2. Open this URL in your browser (replace placeholders first):

```text
https://accounts.spotify.com/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2F127.0.0.1%3A8888%2Fcallback&scope=playlist-read-private%20playlist-read-collaborative
```

3. Approve access. Copy the `code` value from the callback URL.
4. Exchange that `code` for tokens:

```bash
curl -X POST https://accounts.spotify.com/api/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
  -d "grant_type=authorization_code" \
  -d "code=PASTE_CODE_HERE" \
  -d "redirect_uri=https://127.0.0.1:8888/callback"
```

5. Copy `refresh_token` from the JSON response into `.env`:

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...
```

Notes:
- `redirect_uri` must exactly match the value in your Spotify app settings and in the token request.
- Keep `SPOTIFY_CLIENT_SECRET` and `SPOTIFY_REFRESH_TOKEN` private.
- If Spotify returns `invalid_client`, re-check client ID/secret and ensure you are using the same app that generated the `code`.

## Notes

- For Spotify links without API credentials, only track titles are used for YouTube matching.
- Search/queue UI is restricted to the user who initiated the action.
