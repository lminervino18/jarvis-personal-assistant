# Video downloads into Transferencias

The owner can paste a YouTube, X or Instagram link, in Transferencias or to Jarvis (`transfer_from_link`). The server downloads the video and leaves it in Transferencias for 24 hours, with a push and a chat line when it is done or fails.

Status: *validated with real service* for X and Instagram from the server's own address without an account, and for YouTube through Cloudflare WARP (4K AV1 from the server on 2026-11-26).

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

### WARP in production

The `warp` compose service (profile `warp`) runs [wireproxy](https://github.com/windtf/wireproxy):
- a userspace WireGuard tunnel to Cloudflare WARP, exposing SOCKS5 on `warp:40000` inside the compose network only;
- the image is built `FROM scratch` with the checksum-pinned binary, read-only and without capabilities.

The server uses it with `YTDLP_YOUTUBE_PROXY=socks5h://warp:40000`.

The identity is anonymous and was registered with [wgcf](https://github.com/ViRb3/wgcf), which accepts Cloudflare's WARP terms (the owner approved it on 2026-11-26). Its keys live in `/etc/jarvis/warp/`, owned by uid 10001 with mode 600:
- `wgcf-account.toml`;
- `wgcf-profile.conf`;
- `wireproxy.conf`, which points `WGConfig` at `/etc/wireproxy/wgcf-profile.conf` and binds SOCKS5 to `0.0.0.0:40000`.

**Renewal:**
- The `jarvis-warp-check` systemd timer runs `infra/warp/check.sh` every 6 hours.
- It asks yt-dlp, through the tunnel, for a short public video.
- If YouTube answers with its bot check, it registers a new WARP identity and restarts `warp`.

Setting it up on a new server, as root:
1. Install the verified `wgcf` binary in `/usr/local/bin`.
2. Run `wgcf register --accept-tos && wgcf generate` and move both files into `/etc/jarvis/warp/` next to `wireproxy.conf`.
3. Add `warp` to `COMPOSE_PROFILES` in `/opt/jarvis/.env`, and the proxy variable to `jarvis.env`.
4. Copy `infra/warp/check.sh` to `/usr/local/sbin/jarvis-warp-check`, plus the unit and timer from `infra/warp/`. Then `systemctl enable --now jarvis-warp-check.timer`.

## Limits and safety

- **Only those three sites:**
  - links must be https on their hosts, with no port, user or password;
  - yt-dlp runs only the matching extractor (`--use-extractors`) and never its generic one, so no link can make the server fetch internal addresses.
- **Size and order:** 8 GB per video, a 2-hour timeout, one download at a time. A download needs 10 GB of free disk.
- **Restarts:** after a restart, interrupted downloads go back in line.
- **Untrusted titles:** the video title (third-party text) goes into the push and the file name, never into the chat message the model reads.

Code: `apps/server/src/downloads/`, the routes in `transfers/transfer-routes.ts`, and the tool in `tools/transfer-tools.ts`.
