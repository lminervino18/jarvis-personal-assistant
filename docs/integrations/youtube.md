# YouTube

Video search through the YouTube Data API v3 and playback control of the owner's own player (web PWA or device).

## Tools

- `youtube_search`: `search.list` with `type=video`, `videoEmbeddable=true`, `relevanceLanguage=es`. Returns `videoId`, title, channel, publish date, a short description, watch URL and thumbnail URL. Titles and descriptions are third-party content: the tool is in `untrustedContentTools`.
- Without `YOUTUBE_API_KEY` the tool does not fail: it emits a `link` card to `https://www.youtube.com/results?search_query=...` and returns a note saying there are no direct results. If the API call fails (quota or key), the tool returns the structured error and still emits the link card.
- `youtube_open`, `youtube_play`, `youtube_pause`: emit a `player.command` (`open`, `play`, `pause`) and a `youtube` card. The result always says the command was requested and never that the video is playing. `autoplay` defaults to true for `youtube_open`; browsers may block it (the player then reports `blocked`).
- `youtube_play` without `videoId` and `youtube_pause` target the video the player last reported. If none is known the command is sent without a card and the result says so.
- Card titles come from the last searches (an in-memory cache of 50 videos); otherwise the card says "Video de YouTube".

## Player state tracker

The client reports `player.state` (`ready`, `playing`, `paused`, `ended`, `blocked`, `error`) over the WebSocket. `main.ts` passes `onPlayerState` to the app and the latest report is kept in memory only (it is lost on restart). `integrations_status` shows it ("Reproductor: reproduciendo (último reporte hace 30 s)") and play/pause results include `lastReportedPlayerState` so the assistant can reason about the real state instead of assuming.

## Setup

1. In the Google Cloud console enable YouTube Data API v3 and create an API key.
2. Restrict the key to YouTube Data API v3 (and to the server's IP if it is fixed).
3. Set `YOUTUBE_API_KEY` and restart.

| Variable | Required | Notes |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | no | Without it search falls back to a link card; open, play and pause still work with a `videoId`. |

## Quota

The default quota is 10,000 units per day and each `search.list` costs 100 units, so about 100 searches per day. `quotaExceeded` maps to the `rate_limited` tool error. The key travels in the query string as the API documents; errors and logs never include the URL.

## Validation status

Implemented and tested with fixtures. Not validated against the real API or a real player: pending owner API key and a connected client.
