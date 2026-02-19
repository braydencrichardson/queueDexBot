# queueDexBot

A Discord music bot with YouTube/SoundCloud playback, queue controls, and search/selection UI.
Can queue from Spotify share links (will search title/artist on YouTube)

## Requirements

- Node.js 20+ (Discord.js v14)
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

Discord OAuth / API server (for Activity + future web view):

- `DISCORD_OAUTH_CLIENT_ID`: Optional OAuth client id override (defaults to `APPLICATION_ID`).
- `DISCORD_OAUTH_CLIENT_SECRET`: Required for OAuth code exchange endpoints.
- `DISCORD_OAUTH_REDIRECT_URI_WEB`: Web OAuth callback URI (for `/auth/discord/web/callback`).
- `DISCORD_OAUTH_REDIRECT_URI_ACTIVITY`: Optional explicit redirect URI used for embedded activity code exchange.
- `DISCORD_OAUTH_SCOPES`: Space-separated scopes (default: `identify guilds`).
- `ACTIVITY_WEB_URL`: Optional public web URL to include alongside generated Activity invite links.
- `ACTIVITY_INVITE_PREWARM_ON_PLAYBACK_START`: `1` to pre-create/reuse an Activity invite when playback starts, `0` (default) to disable.
- `NOW_PLAYING_SHOW_PROGRESS`: `1` to show/update progress in Discord now-playing messages, `0` (default) to hide it.
- `AUTH_SERVER_ENABLED`: `1` (default) to start API/Auth server, `0` to disable.
- `AUTH_SERVER_HOST`: Bind host (default: `127.0.0.1`).
- `AUTH_SERVER_PORT`: Bind port (default: `8787`).
- `AUTH_SESSION_TTL_MS`: Optional session TTL in ms (default: 8 hours).
- `AUTH_SESSION_COOKIE_NAME`: Session cookie name (default: `qdex_session`).
- `AUTH_SESSION_COOKIE_SECURE`: `1` (default) or `0`.
- `AUTH_SESSION_STORE_ENABLED`: `1` (default) to persist auth sessions across process restarts, `0` for in-memory only.
- `AUTH_SESSION_STORE_PATH`: Session store file path (default: `data/auth-sessions.json`).
- `AUTH_ADMIN_USER_IDS`: Optional comma/space-separated Discord user IDs for Activity admin overrides.

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
- `DEV_ALERT_LEVEL`: Minimum level sent to `DEV_ALERT_CHANNEL_ID` (default: `error`).
- `DEV_LOG_LEVEL`: Minimum level sent to `DEV_LOG_CHANNEL_ID` (default: `info`).

Structured file logging:

- `LOG_LEVEL`: Minimum app log level (`trace|debug|info|warn|error|fatal`, default: `info`).
- `LOG_DIR`: Base log directory (default: `logs`).
- `LOG_SERVICE_NAME`: Service folder under `LOG_DIR` (default: `controller`).
- `LOG_PRETTY`: `1` (default) for readable console output, `0` for JSON lines.
- `LOG_MAX_SIZE_BYTES`: Rotate when log file reaches this size (bytes or `kb|mb|gb`, default: `10mb`).
- `LOG_MAX_FILES`: Number of rotated files to keep per log stream (default: `10`).

Log files are written to `<LOG_DIR>/<LOG_SERVICE_NAME>/app.log` and `<LOG_DIR>/<LOG_SERVICE_NAME>/error.log` (plus rotated suffixes).

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

## Run Activity App (Scaffold)

The repo now includes a starter Discord Activity web app at `apps/activity`.

1. Install Activity app dependencies:

```bash
npm --prefix apps/activity install
```

2. Configure its env file:

```bash
cp apps/activity/.env.example apps/activity/.env
```

Set:

```env
VITE_DISCORD_CLIENT_ID=YOUR_DISCORD_APPLICATION_ID
VITE_DISCORD_SDK_READY_TIMEOUT_MS=1000
VITE_DISCORD_AUTHORIZE_MODE=auto
VITE_DISCORD_OAUTH_SCOPES=identify
# set this to a redirect URI registered in Discord Developer Portal (avoid *.discordsays.com)
VITE_DISCORD_OAUTH_REDIRECT_URI=
VITE_WEB_OAUTH_SCOPES=identify guilds
# optional if backend is not on same origin:
VITE_ACTIVITY_API_BASE=
# local dev proxy target:
VITE_ACTIVITY_API_PROXY_TARGET=http://127.0.0.1:8787
```

3. Start the Activity app:

```bash
npm run activity:dev
```

4. Ensure the bot process is running (`npm start`) so Activity API/Auth routes are available on `AUTH_SERVER_PORT`.

5. Expose it via HTTPS (for web/desktop Activity testing) and set Discord Activity URL Mapping to the tunnel target.

Auth mode notes:
- `VITE_DISCORD_AUTHORIZE_MODE=auto` (default): try RPC-style authorize first, then retry with `redirect_uri` only when Discord reports missing redirect.
- `VITE_DISCORD_AUTHORIZE_MODE=rpc`: force authorize without `redirect_uri`.
- `VITE_DISCORD_AUTHORIZE_MODE=web`: force authorize with `redirect_uri`.
- Embedded auth note: avoid `guilds` and `rpc` scopes in this Activity authorize flow; use `identify`. Use web OAuth endpoints for broader scopes like `guilds`.
- Embedded fallback note: the Activity now first attempts `authenticate()` and bootstraps backend session directly from that token, then falls back to OAuth code exchange only if needed.

Web mode notes:
- Opening the Activity URL directly in a browser now shows a web login screen (via `/auth/discord/web/start`).
- After login, you can select a guild and use basic controls (`pause`, `resume`, `skip`, `stop`, `clear queue`) from the web UI.
- Use `Refresh Guild Memberships` in the `Debug` tab to re-sync your Discord guild membership list into the current session after adding/removing bot access.
- Activity/web controls require the user to be in the same voice channel as the bot when the bot is connected.
- Admin users listed in `AUTH_ADMIN_USER_IDS` can enable a session-level bypass for this voice check in the Activity Admin tab.
- The Activity Admin tab also includes provider status/verification, queue repair actions, and an admin event feed.
- Admin users can optionally toggle all-guild access in the Activity Admin tab to select/control any guild where the bot is present.
- Embedded mode now shows the guild as read-only text (not a selectable dropdown).
- Guild selector is filtered to guilds where both the user and bot are present.
- Session/Discord diagnostics are available under the `Debug` tab in the UI.

Activity API notes:
- `GET /api/activity/state?guild_id=...`: compact queue/playback summary.
- `GET /api/activity/queue?guild_id=...&offset=0&limit=100`: paged queue listing for richer UIs (e.g. drag-drop).
- `POST /api/activity/control`: playback actions (`pause|resume|skip|stop|clear`).
- `POST /api/activity/queue/action`: queue actions (`clear|shuffle|move|move_to_front|remove|loop`).
- `POST /auth/refresh-guilds`: refresh guild list for current session (requires `guilds` scope).
- `POST /api/activity/admin/settings`: admin-only settings endpoint (`bypass_voice_check`, `bypass_guild_access`).
- `GET /api/activity/admin/guilds`: admin-only list of all guilds where the bot is currently present.
- `GET /api/activity/admin/events?level=info&limit=120`: admin-only in-memory event feed.
- `GET /api/activity/admin/providers/status`: admin-only provider readiness status snapshot.
- `POST /api/activity/admin/providers/verify`: admin-only cookie/auth verification run.
- `POST /api/activity/admin/providers/reinitialize`: admin-only provider reinit action.
- `POST /api/activity/admin/queue/force-cleanup`: admin-only force stop/leave/clear for a guild queue.
- `POST /api/activity/admin/queue/refresh-now-playing`: admin-only repair for now-playing/up-next message state.
- Mutation endpoints enforce guild access and same-voice-channel checks when the bot is connected.

Notes:
- URL Mapping target should be host/path only (no protocol).
- Use a directory path target, not a file path.

### Activity Dev Workflow

Use two terminals:

```bash
# terminal 1: bot + api/auth server
npm start

# terminal 2: activity vite dev server
npm run activity:dev
```

Keep both processes running in background (and re-attach later) with `tmux`:

```bash
# start a tmux session
tmux new -s qdexbot

# pane 1
npm start

# split pane (Ctrl+b then % or ")
# pane 2
npm run activity:dev
```

Detach while keeping both running:

```bash
# inside tmux
Ctrl+b then d
```

Re-enter later:

```bash
tmux attach -t qdexbot
```

Useful tmux commands:

```bash
tmux ls
tmux kill-session -t qdexbot
```

Useful checks:

```bash
# build activity app
npm run activity:build

# preview built app
npm run activity:preview
```

For local env:
- Root `.env` drives bot API/Auth server (`AUTH_SERVER_*`, `DISCORD_OAUTH_*`).
- `apps/activity/.env` drives Vite client behavior (`VITE_*`).
- `VITE_ACTIVITY_API_PROXY_TARGET` should point at your API/Auth server in dev (default: `http://127.0.0.1:8787`).

### Cloudflare Tunnel (Dev)

Quick temporary tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

That is usually enough for Activity dev because Vite proxies `/auth` and `/api` to the backend.

For a stable hostname tunnel, map your dev hostname to `http://127.0.0.1:5173` and set:
- `VITE_ALLOWED_HOSTS` to include that hostname.
- Discord Activity URL Mapping target to that hostname/path (no protocol).

Web OAuth requirements:
- In Discord Developer Portal OAuth2 redirects, add:
  `https://YOUR_HOSTNAME/auth/discord/web/callback`
- Set root `.env`:
  `DISCORD_OAUTH_REDIRECT_URI_WEB=https://YOUR_HOSTNAME/auth/discord/web/callback`

If you hit stale UI while testing tunnels:
- Disable CDN caching for the activity hostname (or bypass cache for this route).
- Restart Vite when changing env values.
- Hard reload Discord/web client after deploy changes.

## Commands

- `/play query:<url or search>`: Resolve and queue one or more tracks.
- `/join`: Join your current voice channel.
- `/launch`: Launch this app's Discord Activity in your current voice channel.
- `/playing`: Post now-playing controls in channel.
- `/pause`, `/resume`, `/skip`, `/stop`: Playback controls.
- `/queue view|clear|shuffle|remove|move`: Queue management.

## Activity Troubleshooting

If you see `*.discordsays.com refused to connect`:

1. Confirm the app has Activities enabled (`EMBEDDED` flag) in the Discord Developer Portal.
2. Confirm URL Mapping target is valid and reachable from Discord.
3. For desktop/web clients, confirm the target resolves to HTTPS.
4. Confirm your Activity host is embeddable (not blocked by `X-Frame-Options` or restrictive `frame-ancestors` CSP).

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
