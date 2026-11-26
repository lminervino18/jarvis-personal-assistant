# Video downloads into Transferencias

The owner can paste a YouTube, X or Instagram link, in Transferencias or to Jarvis (`transfer_from_link`). The server downloads the video and leaves it in Transferencias for 24 hours, with a push and a chat line when it is done or fails.

Status:
- X and Instagram: *validated with real service* from the server's own address, without an account.
- YouTube: *pending owner connection*, because it blocks data center addresses (see below).

## Engine

[yt-dlp](https://github.com/yt-dlp/yt-dlp), the official Linux build in its one-folder form. The Dockerfile's `media-tools` stage downloads it, checks its SHA-256 and unpacks it into `/opt/yt-dlp`, so nothing is extracted to the small `/tmp` on every run.

YouTube's player challenges run in a JavaScript runtime: yt-dlp uses the container's Node (`--js-runtimes node`) with the challenge scripts the build bundles. ffmpeg merges video and audio.

**Updating it:** sites change often, so a broken download usually means yt-dlp needs updating.
1. Pick a release from https://github.com/yt-dlp/yt-dlp/releases.
2. Copy the `yt-dlp_linux.zip` line from its `SHA2-256SUMS`.
3. Update the URL and `--checksum` in the Dockerfile.
4. Deploy.

## Quality

- **Máxima** (default): the best video and audio the site has. On YouTube that is often AV1 or VP9 with Opus, up to 4K or 8K.
- **Compatible con cualquier celu**: prefers H.264 with AAC. Every phone plays it; on YouTube it goes up to 1080p.

Both always come out as MP4. Older iPhones may not play AV1 in Fotos; downloading it as a file still works.

## YouTube from a server

YouTube answers «Sign in to confirm you’re not a bot» to data center addresses. This was tested on 2026-11-25 from the Vultr server with all nine player clients. The fix is giving YouTube another way out; only YouTube downloads use it:

- `YTDLP_YOUTUBE_PROXY`: a proxy just for YouTube, for example a Cloudflare WARP tunnel (`socks5h://...`). It is free and the usual fix.
- `YTDLP_COOKIES_FILE`: a Netscape cookies file from a throwaway Google account, exported by the owner. yt-dlp rewrites cookies, so each run works on a copy.

Both go in `/etc/jarvis/jarvis.env`; the cookies file lives on the server, never in the repo.

## Limits and safety

- **Only those three sites:**
  - links must be https on their hosts, with no port, user or password;
  - yt-dlp runs only the matching extractor (`--use-extractors`) and never its generic one, so no link can make the server fetch internal addresses.
- **Size and order:** 8 GB per video, a 2-hour timeout, one download at a time. A download needs 10 GB of free disk.
- **Restarts:** after a restart, interrupted downloads go back in line.
- **Untrusted titles:** the video title (third-party text) goes into the push and the file name, never into the chat message the model reads.

Code: `apps/server/src/downloads/`, the routes in `transfers/transfer-routes.ts`, and the tool in `tools/transfer-tools.ts`.
