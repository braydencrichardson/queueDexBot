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
- `GUILD_ID` (optional; if set, commands deploy to that guild)

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

## Register Commands

```bash
node deploy-commands.js
```

By default, if `GUILD_ID` is set, commands deploy to that guild. To override:

```bash
# force global
node deploy-commands.js --global

# force guild (requires GUILD_ID)
node deploy-commands.js --guild
```

Global commands can take up to an hour to propagate.

## Run the Bot

```bash
npm start
```

## YouTube Cookies

If YouTube requires cookies, export them with `yt-dlp` in **JSON format** and point the bot at the file.

Example:

```bash
yt-dlp --cookies-from-browser chrome --dump-cookies youtube-cookies.json
```

Set in `.env`:

```
YOUTUBE_COOKIES_PATH=/path/to/youtube-cookies.json
```

## Notes

- For Spotify links without API credentials, only track titles are used for YouTube matching.
- Search/queue UI is restricted to the user who initiated the action.
