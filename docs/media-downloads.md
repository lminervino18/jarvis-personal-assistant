# Downloads and conversions into Transferencias

The owner can ask for a video or a song in two ways:
- **In Transferencias:** paste a YouTube, X or Instagram link, or type words to search on YouTube.
- **To Jarvis:** `transfer_from_link` with `url`, or with `search` for the first YouTube result.

The server downloads it and leaves it in Transferencias for 24 hours. A push and a chat line arrive when it is done or fails.

When the request is not clear, `transfer_suggest` searches YouTube through the Data API, with no embeddable filter and with durations from `videos.list`. It shows the three likeliest videos on a `media_choice` card. The owner's tap (`POST /api/transfers/choices/:id`) starts the download with the format and recipient fixed when the proposal was made. A second tap never starts a second download, and a proposal lasts a day.

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

## Beelup matches

Beelup records amateur matches with the court's cameras. A player link (`https://beelup.com/player.php?id=…`) is read without yt-dlp (`downloads/beelup.ts`):
- **Name:** the player page gives the match's name (court and time).
- **Playlist:** `obtener.video.playlist.php?id=…&camara=central|izq|der&tipo=todo&formato=m3u8` gives each camera's HLS playlist. The camera with the most video wins.
- **Safety:** every segment must be on `*.revivitupartido.com`, Beelup's video servers; otherwise nothing is downloaded.
- **Download:** ffmpeg joins the playlist into one MP4 without re-encoding (`MediaConverter.remuxHls`). It is 1080p50 H.264, about 13 MB a minute.
- **Raw:** the match comes whole, exactly as the camera recorded it, warm-up included. Nothing is trimmed.

Beelup's own marks (`obtener.marcas.video.v6.php`) have the owner's manual ones and «aplausos» found by sound. Those are not used: on the 2026-11-19 match, only 5 of 11 goals had an «aplauso» within 40 s.

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

## Cuts

`transfer_edit` keeps only some parts of a video and leaves the cut in Transferencias. The video comes from a link, a YouTube search or Transferencias. The job (`MediaQueue`) goes through three stages the owner sees:
1. **Bajando:** the video, in the `iphone` format, which is enough to analyze and to deliver.
2. **Buscando el momento**, when the owner described what to keep (`find`). `MomentFinder` (`apps/server/src/downloads/moment-finder.ts`) works it out:
   - It transcribes the audio with timestamps (`OpenAiCompatibleStt.transcribeSegments`, Groq `verbose_json`). The model then marks the parts in the transcript: in a match, the commentary names the play.
   - It sends the model about 90 frames of 480 px from 20 seconds around each part, so it sets the exact start and end by looking. When the video has no usable voice, 80 frames over the whole video come first.
   - Models only answer JSON with seconds, checked to be inside the video and at most 15 minutes per part. What the video says or shows never reaches the chat.
3. **Recortando:** `MediaConverter.cut` reads each part with its own fast seek and joins them with ffmpeg's `concat`. The result is H.264 up to 1080p, optionally cropped to 9:16 (`vertical`), or only the audio as MP3.

Afterwards:
- By default only the cut stays. A downloaded video is never kept unless `keepSource`; a file already in Transferencias is kept unless the owner asked to delete it.
- The chat notice lists only the times kept and the size.
- The locating calls use `CLAUDE_MODEL` through `runtime.complete`, on the subscription. A cut costs about two calls, the second with images.

## Saving on the iPhone

An installed web app on iOS cannot download files: the link goes nowhere. On phones the tiles and the viewer instead bring the original into the page and open the share sheet with the file (`navigator.share({ files })`). The share sheet offers «Guardar video», «Guardar en Archivos», WhatsApp and AirDrop. When the download took longer than iOS allows between the tap and the sheet, the button turns into «Guardar» and the next tap opens the sheet at once. Computers keep the plain download link.

## Sending

`TransferSender` (`apps/server/src/transfers/transfer-delivery.ts`) sends the file itself, as the owner wants (2026-11-26):
- **Limits:** WhatsApp carries videos up to 16 MB and other files up to 64 MB; mail carries up to 20 MB.
- **A heavier video is compressed to fit** (`MediaConverter.compress`, 95% of the limit). It becomes H.264 at the bitrate that fits, with the short side at 1080, 720, 540 or 360 depending on that bitrate. It retries at lower bitrates if the first pass comes out too big.
- **A link** to download it in original quality goes only when the owner asks for one (`asLink`), or when the file does not fit even compressed: under 100 kbps of video, or a non-video file over the limit.

## YouTube from a server

YouTube answers «Sign in to confirm you’re not a bot» to data center addresses. This was tested on 2026-11-25 from the Vultr server with all nine player clients. The fix is giving YouTube another way out; only YouTube downloads use it:

- `YTDLP_YOUTUBE_PROXY`: a proxy just for YouTube, for example a Cloudflare WARP tunnel (`socks5h://...`). It is free and the usual fix.
- `YTDLP_COOKIES_FILE`: a Netscape cookies file from a throwaway Google account, exported by the owner. yt-dlp rewrites cookies, so each run works on a copy.

Both go in `/etc/jarvis/jarvis.env`; the cookies file lives on the server, never in the repo.

### WARP in production

The `warp` compose service (profile `warp`) runs [wireproxy](https://github.com/windtf/wireproxy):
- a userspace WireGuard tunnel to Cloudflare WARP, exposing SOCKS5 on `warp:40000` inside the compose network only;
- a supervisor (`apps/server/src/warp/warp-supervisor.ts`, entry `warp-main.ts`) runs wireproxy and keeps it alive, with the checksum-pinned `wireproxy` and `wgcf` binaries next to it. The container is read-only and has no capabilities.
- It needs a small writable `/var/run` (a tmpfs) for WireGuard's control socket: without it the handshake silently never completes.

The server uses it with `YTDLP_YOUTUBE_PROXY=socks5h://warp:40000`.

The identity is anonymous and was registered with [wgcf](https://github.com/ViRb3/wgcf), which accepts Cloudflare's WARP terms (the owner approved it on 2026-11-26). Its keys live in `/etc/jarvis/warp/`, owned by uid 65532 with mode 600. That uid belongs to no host user: not the agents' 10001, so agents can never read them. The files are:
- `wgcf-account.toml`;
- `wgcf-profile.conf`;
- `wireproxy.conf`, which points `WGConfig` at `/etc/wireproxy/wgcf-profile.conf` and binds SOCKS5 to `0.0.0.0:40000`.

**Self-healing (since 2026-11-28):**
- The supervisor asks 1.1.1.1 for a page through the tunnel every 30 seconds; any HTTP answer means the tunnel works (1.1.1.1 answers plain HTTP with a redirect, never with its trace). After three failed checks it restarts wireproxy; if the tunnel is still down 45 seconds later, it registers a new WARP identity with `wgcf` (at most every five minutes) and restarts again. On 2026-11-27 the handshake stayed down for 9 hours and nothing noticed: the old check only looked for YouTube's bot answer.
- The server asks for the same when a download needs it, on `warp:40001` (`YTDLP_WARP_CONTROL`): `POST /restart` when the tunnel does not answer, `POST /renew` when YouTube answers with its bot check. The call returns once the tunnel carries traffic again, so the download retries right away.
- `/etc/jarvis/warp/` is mounted writable for this, still owned by uid 65532, the container's user.
- wireproxy runs with a copy of the profile in `/var/run/warp/` aimed at an IPv4 endpoint (`162.159.192.1:500` first). The profile's `engage.cloudflareclient.com` also resolves to IPv6, which the server cannot reach: when wireproxy picked it, the handshake never completed. Port 2408 also dropped handshakes for minutes at a time on 2026-11-28, while 500 answered at once. Every restart moves to the next address or port (500, 4500, 1701, 2408).
- The image carries the CA bundle, which `wgcf` needs to register a new identity over TLS.
- The `jarvis-warp-check` systemd timer (`infra/warp/check.sh`) still renews the identity every 15 minutes when YouTube blocks it; it is a second line now.

**Fallback routes** (`MediaDownloader.run`):
- YouTube goes through the tunnel and, if that fails after healing, directly. X and Instagram go directly and, when that fails or asks to sign in, through the tunnel.
- yt-dlp gives up on a dead connection after 15 seconds (`--socket-timeout 15 --extractor-retries 1`), instead of three minutes.
- When yt-dlp no longer understands a site («unable to extract», «nsig», «please report this issue»), the server downloads the latest nightly build once (`YtDlpUpdater`, at most every six hours), checks it against the release's `SHA2-256SUMS`, keeps it in `/data/yt-dlp-builds/` and retries with it.
- A download still blocked or offline goes back in line and is retried 3, 10 and 30 minutes later before it counts as failed.

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
