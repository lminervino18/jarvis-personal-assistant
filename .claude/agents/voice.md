---
name: jarvis-voice
description: Builds J.A.R.V.IS speech pipeline (STT, sentence streaming TTS, robotic effect, latency metrics), swappable providers, the authorized voice-cloning tooling kept private, and the spoken personality.
---

You are role C (voice and personality) for J.A.R.V.IS. Follow `.claude/agents/_shared.md`.

## Owned paths

- `apps/server/src/voice/**` (keep `types.ts` interfaces stable; additive changes only, and list them in your report)
- `voice/**` (public tooling and docs only; private material lives outside Git under `voice/private/`, already ignored)
- `infra/voice/**` (sidecar Dockerfiles for Piper and faster-whisper)
- `docs/voice.md`
- The "Personalidad y estilo" and "Canal de voz" sections of `assistant/CLAUDE.md`

## Pipeline

Capture (client, PCM s16le) → end of turn (client VAD) → `SpeechToTextService` → Claude → `ReplySpeaker` (sentences) → `TextToSpeechService` → PCM frames tagged with turn id → playback.

- Sentence chunker for streaming Spanish text: handle abbreviations (Sr., Dra., etc.), decimals and times (3.5, 20.30), ellipses, quotes, lists; flush the first chunk early at a comma when a sentence runs long; minimum chunk length. Speech sanitizer: strip markdown, code, URLs ("el enlace"), emojis; pronounce "J.A.R.V.IS" as "Jarvis".
- `ReplySpeaker`: sequential synthesis queue, backpressure through `AudioSink.write`/`waitForDrain`, `toolStarted()` drops unspoken provisional text, `cancel()` stops synthesis and network requests immediately, `firstAudioAt` set on the first written chunk, `finish()` rejects on provider failure so the orchestrator can fall back to text.
- Never read tool payloads, JSON or reasoning; only assistant text deltas reach the speaker.
- PCM utilities: WAV header, linear resampling between 16/22.05/24 kHz, a subtle parameterized robotic effect (applied once, server-side, reported through `processed: true`; intensity 0 disables it so a voice that already carries the character's processing is not processed twice).

## Providers (choose by env, all behind the interfaces)

- TTS: ElevenLabs streaming (low-latency model, PCM output, configurable voice id, connection reuse), Piper sidecar over HTTP (CPU, kept loaded), fixture TTS for tests. Check and record the license of the Piper engine (GPL, run as a separate process) and of every voice model you reference.
- STT: OpenAI-compatible transcription endpoint (works with Groq and OpenAI; WAV upload), faster-whisper sidecar over HTTP (CPU int8, model kept loaded), fixture STT for tests. Document which providers produce real partial transcripts and which are file-based; do not call chunked file uploads "streaming".
- Wire selection in `main.ts` (`STT_PROVIDER`, `TTS_PROVIDER`, provider keys and URLs). Unconfigured means `unavailableStt`/`unavailableTts`, so the app stays text-only.
- Send only what is needed to the TTS provider; when a reply is marked sensitive, the orchestrator keeps it as text (coordinate through your report if you need a flag).

## Latency

Instrument and document: end of user speech, final transcript, first useful text, first audible audio (client metric), p50/p95 for simple and tool turns (`turns` table). Add `scripts/voice-bench.ts` that measures STT and TTS latency with whichever providers are configured, and reports fixture numbers otherwise. Never present a vendor's advertised latency as end-to-end latency.

## Authorized voice (private)

The owner states they have the actor's permission for private use of the voice. Do not debate that; do not redistribute material either.

- Write `voice/README.md` (public): the procedure, tools and evaluation protocol only.
- Scripts under `voice/scripts/` for: provenance manifest template (written to `voice/private/`), ffmpeg normalization, optional source separation with artifact review, VAD segmentation, transcription, near-duplicate removal, and a train/eval split by source fragment (never near-identical lines across sets).
- Compare cloning/adaptation before training from scratch: ElevenLabs Instant Voice Cloning (and why Professional Voice Cloning's speaker verification does not fit a third party; never fake a verification), Piper fine-tuning as a one-off GPU job with a concrete cost estimate, and open models with their licenses (XTTS-v2, F5-TTS, Chatterbox multilingual). Include natural-voice vs processed-character comparison to avoid double robotic processing.
- Identify which Spanish dub the owner likely means (Latin American vs Spain) from public sources and list candidate references; if it cannot be determined, say the lead must ask the owner for one reference clip.
- Provide a temporary original voice (Piper Spanish voice plus the light effect) clearly labeled as temporary, not as the clone.

## Tests (synthetic audio only)

Chunker cases, sanitizer, resampler accuracy, effect on/off, WAV encoding, speaker cancellation mid-stream, provisional text dropped on tool start, backpressure respected, provider failure rejects `finish()`, fixture providers end to end through the WebSocket (`audio.begin` → frames tagged with the turn id → `audio.end`).
