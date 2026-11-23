# Narrated videos

JARVIS makes short narrated videos from the chat (about 10 seconds by default: the spoken intro plus one or two one-sentence scenes; longer only on request): explanations, announcements, questions that need an answer, and task results. Every video speaks with JARVIS's ElevenLabs voice, animates in the "Pulso" style of the pages, carries burned-in captions, and can be watched in the app, downloaded, or sent by WhatsApp or mail.

Status: *implemented*, *tested with fixtures* (timeline, store, narrator with a fake ElevenLabs, pipeline with a fake render, tools). A real render of the sample composition is checked in CI inside the video image. The first video with the real voice is pending in production.

## Flow

```
chat → video_create(brief)                      the model writes the script; the server validates it (contracts/videos.ts)
     → videos + video_versions (status queued)  a video card appears in the chat
video worker (own container, 1 CPU, low priority)
     → voice   ElevenLabs /with-timestamps per scene, same voice_id, model and robotic effect as calls; cached
     → timeline scenes laid over the real audio; captions from the real word times (packages/video/timeline.ts)
     → render  Remotion renderMedia, one browser tab, H.264 + AAC, yuv420p, CRF 20, licenseKey "free-license"
     → verify  faststart, 720p light copy, thumbnail, SRT + VTT, checks on the final file
     → ready   files saved as attachments; chat message + push "Listo el video …"
```

The app shows progress live. While the video renders, "Ver vista previa" plays the same composition in `@remotion/player` with the real narration. Once the video is ready, the card plays the final MP4 and offers share, download, light copy and subtitles.

## Pieces

| Piece | Where |
| --- | --- |
| Brief and card schemas | `packages/contracts/src/videos.ts`, `VideoCard` in `cards.ts` |
| Tokens, compositions, timeline | `packages/video` (Remotion 4.0.541; `pnpm --filter @jarvis/video studio` opens the sample) |
| Store and migration | `apps/server/src/videos/video-store.ts`, `db/migrations/008-videos.ts` |
| Voice | `videos/narrator.ts` (`/v1/text-to-speech/{voice}/with-timestamps`, `pcm_24000`, `seed` fixed) |
| Pipeline and checks | `videos/video-pipeline.ts`, `video-render.ts`, `video-qa.ts` |
| Worker | `src/video-worker.ts`, compose service `video`, Dockerfile target `video` |
| Tools | `tools/video-tools.ts`: `video_create`, `video_status`, `video_revise`, `video_send`, `video_page` |
| Owner API | `GET /api/videos/:id`, `/v/:version/timeline`, `/v/:version/files/:name`, `/v/:version/watch` |

## Look

The reference is the "Estilos de páginas JARVIS" artifact, style B "Pulso", which the pages already use (`pages/design-guide.ts`). The video tokens live in `packages/video/src/tokens.ts`:
- white background, ink `#0b0a12`, ultraviolet `#5b2bff` / `#3a12d6`, mist `#f1ecff`;
- Space Grotesk 500/700 and Inter 400/500/600 (fontsource, bundled, no network at render);
- glass cards with a 28 px radius (×1.6 at 1080 px) and a soft ultraviolet shadow;
- pills, the segmented choices and the gradient button;
- the docs' "rise" entrance (cubic-bezier 0.2, 0.7, 0.2, 1).

The breathing ultraviolet sphere of the pages is redrawn as an SVG wireframe computed from the frame time. It glides to a new spot when the scene changes.

Scenes: intro (always), title, media (owner photos or clips with a slow Ken Burns), compare, stat (number counting up, ring for percentages), steps (nodes and a connector that draws itself), result, question (options plus "Respondé a este mensaje…"), and closing.
- Items appear when the narration names them.
- Every animation depends only on the frame, so the preview and the render match.
- Emojis render with Noto Color Emoji in the image and with the system font on phones.

Formats: vertical 1080×1920 at 30 fps by default, landscape 1920×1080 with its own layout, and a 720p light copy made with ffmpeg.

## Voice and intro

- Every video starts with «Hola, soy Jarvis, el asistente personal de {OWNER_DISPLAY_NAME}. Este mensaje es para {purpose}.», as one TTS segment and in the captions.
- Audio is cached under `DATA_DIR/videos/cache/tts` by text, voice, model, language, effect and seed. A revision that only changes pictures or one scene re-pays only the changed text.
- Usage per version (`usage_json`): TTS characters (new and cached), render seconds, bytes.
- Captions come from ElevenLabs' character alignment grouped into words, never from evenly split text.

## Checks before "ready"

- Run on the final file:
  - H.264/AAC/yuv420p at the right size;
  - duration within 0.4 s of the timeline;
  - no black frames (`blackdetect`);
  - no silence over 2 s (`silencedetect`);
  - no clipping (`volumedetect`);
  - captions in order;
  - the mandatory intro.
- With Groq STT configured, every narration is transcribed back, and at least 75% of the script words (60% of the intro) must be heard.
- A failed check fails the version with the reason, and it is not retried.
- Crashes and timeouts are retried once (`MAX_RENDER_ATTEMPTS = 2`). A render stops after 20 minutes, or as soon as a newer version replaces it.

## Sending

- `video_send` always waits for the owner's confirmation card. It picks the file the channel can carry:
  - WhatsApp: up to 16 MB, full copy, then the light copy, otherwise a 7-day link;
  - Gmail: up to 20 MB.
- Mail always includes a 7-day link to watch or download the video. When only a link fits, the thumbnail is attached.
- When the video has an interactive page, its link is added.
- Deliveries are recorded with version, channel, recipient, file and provider id. The same send is never repeated.
- "Armá un video para mandar" only prepares it.

## Interactive version

`video_page` publishes a deterministic page with no model involved at `p.lminervino18.com/<slug>`. It has the MP4 (with ranges), the question's options as real buttons, a free answer, the source links and the confirmed facts.
- Answers carry `video_version` and reach the owner as page answers.
- A public page can never approve anything.

## Resources and cost

- The `video` container is limited to 1 CPU (of 2) and 1.5 GB, with `cpu_shares: 256`. Under contention, the server and an ongoing call get four times its CPU.
- One render at a time.
- Temporary renders are deleted. The narration WAVs and the timeline stay per version for the preview.
- Remotion is free for individuals; a company with more than 3 employees would need a Company License.
- ElevenLabs Flash v2.5 is billed per character, about 600 characters for a 45 s video. No other paid service is used: there are no stock photos, and visuals are diagrams, emojis and the owner's own files.

## Pending

- The first real video in production, plus a measurement of call latency while a render runs.
- Email with an HTML thumbnail that opens the video: today the mail carries the MP4 or the thumbnail as an attachment, plus links.
- Optional licensed music with ducking.
