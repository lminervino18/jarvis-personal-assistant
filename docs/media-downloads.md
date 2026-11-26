# Downloads and conversions into Transferencias

The owner can ask for a video or a song in two ways:
- **In Transferencias:** paste a YouTube, X or Instagram link, or type words to search on YouTube.
- **To Jarvis:** `transfer_from_link` with `url`, or with `search` for the first YouTube result.

The server downloads it and leaves it in Transferencias for 24 hours. A push and a chat line arrive when it is done or fails.

Files already in Transferencias can be converted (`transfer_convert`, or «Convertir a» in the viewer) and sent by WhatsApp or mail (`transfer_send`). Downloads and conversions take a `sendTo`, so one request covers the whole chain. For example, «bajá Crimen de Cerati en MP3 y mandáselo a Marti» is a single tool call: the owner confirms one card when the turn read third-party content, and the job sends the file once it is ready.

Status: *validated with real service* for X and Instagram from the server's own address without an account, and for YouTube through Cloudflare WARP (4K AV1 from the server on 2026-11-26).

## Engine

[yt-dlp](https://github.com/yt-dlp/yt-dlp), the official Linux build in its one-folder form. The Dockerfile's `media-tools` stage downloads it, checks its SHA-256 and unpacks it into `/opt/yt-dlp`, so nothing is extracted to the small `/tmp` on every run.

YouTube's player challenges run in a JavaScript runtime: yt-dlp uses the container's Node (`--js-runtimes node`) with the challenge scripts the build bundles. ffmpeg merges video and audio.

**Updating it:** sites change often, so a broken download usually means yt-dlp needs updating.
1. Pick a release from https://github.com/yt-dlp/yt-dlp/releases.
2. Copy the `yt-dlp_linux.zip` line from its `SHA2-256SUMS`.
3. Update the URL and `--checksum` in the Dockerfile.
4. Deploy.

## Formats

The owner's phone is an iPhone 15, whose A16 chip has no AV1 decoder, so Photos does not keep AV1 videos.

| Format | What comes out | When |
|---|---|---|
| `iphone` (default) | H.264 with AAC in MP4. YouTube serves H.264 up to 1080p; X and Instagram always serve it. | Anything the owner wants on the phone. |
| `max` | The best the site has. On YouTube that is often AV1 or VP9 with Opus, up to 4K or 8K, in MP4. | Only when asked, for a computer. |
| `mp3` | Only the audio, MP3 V0. | Songs and podcasts. |
| `m4a` | Only the audio, in AAC. | When asked for. |

**Conversions** (`apps/server/src/downloads/media-converter.ts`) copy every stream that already fits, so nothing is lost:
- MP3 or M4A: the audio track, copied when it already is that codec.
- iPhone:
  - H.264 or HEVC video is remuxed (HEVC gets the `hvc1` tag Apple needs);
  - anything else is re-encoded to H.264 with the short side capped at 1080p. 4K AV1 would take about half an hour on the server's two cores;
  - Opus audio becomes AAC.

ffmpeg runs at nice 10, so a long conversion never slows the chat.

## Saving on the iPhone

An installed web app on iOS cannot download files: the link goes nowhere. On phones the tiles and the viewer instead bring the original into the page and open the share sheet with the file (`navigator.share({ files })`). The share sheet offers «Guardar video», «Guardar en Archivos», WhatsApp and AirDrop. When the download took longer than iOS allows between the tap and the sheet, the button turns into «Guardar» and the next tap opens the sheet at once. Computers keep the plain download link.

## Sending

`TransferSender` (`apps/server/src/transfers/transfer-delivery.ts`) sends the file itself when the channel carries it:
- WhatsApp: videos up to 16 MB, other files up to 64 MB. WhatsApp may compress photos and videos.
- Mail: up to 20 MB.

A heavier file goes as a link to download it in original quality while it lasts.

## YouTube from a server

YouTube answers «Sign in to confirm you’re not a bot» to data center addresses. This was tested on 2026-11-25 from the Vultr server with all nine player clients. The fix is giving YouTube another way out; only YouTube downloads use it:

- `YTDLP_YOUTUBE_PROXY`: a proxy just for YouTube, for example a Cloudflare WARP tunnel (`socks5h://...`). It is free and the usual fix.
- `YTDLP_COOKIES_FILE`: a Netscape cookies file from a throwaway Google account, exported by the owner. yt-dlp rewrites cookies, so each run works on a copy.

Both go in `/etc/jarvis/jarvis.env`; the cookies file lives on the server, never in the repo.

### WARP in production

The `warp` compose service (profile `warp`) runs [wireproxy](https://github.com/windtf/wireproxy):
- a userspace WireGuard tunnel to Cloudflare WARP, exposing SOCKS5 on `warp:40000` inside the compose network only;
- the image is built `FROM scratch` with the checksum-pinned binary, read-only and without capabilities.
- It needs a small writable `/var/run` (a tmpfs) for WireGuard's control socket: without it the handshake silently never completes.

The server uses it with `YTDLP_YOUTUBE_PROXY=socks5h://warp:40000`.

The identity is anonymous and was registered with [wgcf](https://github.com/ViRb3/wgcf), which accepts Cloudflare's WARP terms (the owner approved it on 2026-11-26). Its keys live in `/etc/jarvis/warp/`, owned by uid 65532 with mode 600. That uid belongs to no host user: not the agents' 10001, so agents can never read them. The files are:
- `wgcf-account.toml`;
- `wgcf-profile.conf`;
- `wireproxy.conf`, which points `WGConfig` at `/etc/wireproxy/wgcf-profile.conf` and binds SOCKS5 to `0.0.0.0:40000`.

**Renewal:**
- The `jarvis-warp-check` systemd timer runs `infra/warp/check.sh` every 15 minutes. On 2026-11-26 YouTube flagged a WARP identity within a few hours.
- It asks yt-dlp, through the tunnel, for a short public video.
- If YouTube answers with its bot check, it registers a new WARP identity and restarts `warp`.
- Meanwhile, a YouTube download that hits the bot check is retried by the queue 15 and 30 minutes later before it counts as failed.

Setting it up on a new server, as root:
1. Install the verified `wgcf` binary in `/usr/local/bin`.
2. Run `wgcf register --accept-tos && wgcf generate` and move both files into `/etc/jarvis/warp/` next to `wireproxy.conf`.
3. Add `warp` to `COMPOSE_PROFILES` in `/opt/jarvis/.env`, and the proxy variable to `jarvis.env`.
4. Copy `infra/warp/check.sh` to `/usr/local/sbin/jarvis-warp-check`, plus the unit and timer from `infra/warp/`. Then `systemctl enable --now jarvis-warp-check.timer`.

## Limits and safety

- **Only those three sites:**
  - links must be https on their hosts, with no port, user or password;
  - yt-dlp runs only the matching extractor (`--use-extractors`) and never its generic one, so no link can make the server fetch internal addresses.
- **Size and order:** 8 GB per video, a 2-hour timeout, one job (download or conversion) at a time. A job needs 10 GB of free disk.
- **Restarts:** after a restart or a deploy, interrupted jobs go back in line.
- **Untrusted titles:** the video title (third-party text) goes into the push and the file name, never into the chat message the model reads.

- **Searches:** `search` becomes `ytsearch1:<words>` with the YouTube extractors only.
- **Sending:** WhatsApp chats are resolved when the tool is called, so a confirmed card sends to exactly that chat.

Code: `apps/server/src/downloads/` (`MediaQueue`, `MediaDownloader`, `MediaConverter`), `transfers/transfer-delivery.ts`, the routes in `transfers/transfer-routes.ts`, and the tools in `tools/transfer-tools.ts`.
