# Voice

Owner decisions: Latin American Spanish, target voice is the Latin American dub of J.A.R.V.I.S., cloning is for the owner's private use. Prices and API facts below were retrieved on 2026-10-24 from the vendor pages linked in each row; re-check them before spending money.

## Pipeline

```
mic PCM (client VAD) -> SpeechToTextService -> Claude -> ReplySpeaker -> TextToSpeechService -> PCM frames tagged with the turn id -> playback
```

Code lives in `apps/server/src/voice/`:

| Module | Role |
| --- | --- |
| `chunker.ts` | Spanish sentence chunker: abbreviations (Sr., Dra., etc.), decimals and times, ellipses, closing quotes, list items, fenced code, minimum chunk of 10 characters, early flush of the first chunk at a comma once the sentence passes 60 characters |
| `sanitizer.ts` | Strips markdown, code, emojis; URLs become "el enlace"; J.A.R.V.I.S. is read "Jarvis" |
| `reply-speaker.ts` | `QueuedReplySpeaker`: one sentence synthesized at a time, backpressure through `AudioSink.write`/`waitForDrain`, `toolStarted()` drops unspoken text, `cancel()` aborts the HTTP request and ends the sink immediately, `firstAudioAt`, `finish()` rejects on provider failure |
| `engine-tts.ts` | Adapts a per-sentence `SpeechEngine` to `TextToSpeechService` and negotiates the output rate |
| `pcm.ts` | WAV encode/decode, exact streaming linear resampler, sample aligner |
| `robotic-effect.ts` | The character effect, applied once on the server |
| `openai-stt.ts`, `elevenlabs-tts.ts`, `piper-tts.ts`, `fixture-providers.ts` | Providers |
| `providers.ts` | Environment-driven selection; anything unconfigured stays `unavailableStt` / `unavailableTts` and the app is text-only |

Only assistant text deltas reach the speaker. Tool payloads, JSON and reasoning never do. When the orchestrator marks a reply sensitive it keeps it as text; that flag is not in the speaker contract yet (see "Requested changes" in the role report).

## Configuration

| Variable | Meaning |
| --- | --- |
| `STT_PROVIDER` | `none` (default), `groq`, `openai`, `faster-whisper`, `fixture` (refused in production) |
| `STT_MODEL`, `STT_BASE_URL`, `VOICE_LANGUAGE` | Model override (defaults: Groq `whisper-large-v3-turbo`, OpenAI `gpt-4o-mini-transcribe`), endpoint override, language (`es`) |
| `GROQ_API_KEY`, `OPENAI_API_KEY`, `FASTER_WHISPER_URL` | Credentials and sidecar URL for the chosen STT provider |
| `TTS_PROVIDER` | `none` (default), `elevenlabs`, `piper`, `fixture` (refused in production) |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`, `ELEVENLABS_SAMPLE_RATE` | ElevenLabs (defaults: `eleven_flash_v2_5`, 24000 Hz PCM) |
| `PIPER_URL`, `PIPER_SAMPLE_RATE` | Piper sidecar (default rate 22050) |
| `VOICE_ROBOTIC_INTENSITY` | 0 to 1, default 0.15 |

A provider that is selected but misses a setting does not stop the server: it logs a warning and the channel stays unavailable.

## Robotic effect

`RoboticEffect` mixes a 2.2 ms feed-forward comb with a faint 80 Hz ring modulation and normalizes the level (tested on noise: level stays within 15%). It is applied once, in the speaker, after resampling; when intensity is above zero the server announces `processed: true` in `audio.begin` so clients never add their own processing. Intensity 0 returns the samples untouched and reports `processed: false`.

Defaults: 0.15 for natural voices (Piper, ElevenLabs stock voices). Set `VOICE_ROBOTIC_INTENSITY=0` for a cloned voice built from the film audio, which is already processed in the mix; stacking a second effect makes it metallic and hurts intelligibility.

## Providers

### Speech to text

| Provider | Transcript type | Price | Source |
| --- | --- | --- | --- |
| Groq `whisper-large-v3-turbo` | File upload, no partials | $0.04 per hour of audio, 10 s minimum per request | [console.groq.com/docs/speech-to-text](https://console.groq.com/docs/speech-to-text) |
| Groq `whisper-large-v3` | File upload, no partials | $0.111 per hour | same |
| OpenAI `gpt-4o-mini-transcribe` / `gpt-transcribe` / `gpt-4o-transcribe` | File upload; `stream=true` streams the result of an already uploaded file, it is not live audio | $0.003 / $0.0045 / $0.006 per minute | [pricing](https://developers.openai.com/api/docs/pricing), [guide](https://developers.openai.com/api/docs/guides/speech-to-text) |
| OpenAI `gpt-live-transcribe` (Realtime) | Real partial transcripts over a live connection | $0.017 per minute | same |
| Deepgram Nova-3 streaming | Real partial transcripts over WebSocket | $0.0058 per minute multilingual | [deepgram.com/pricing](https://deepgram.com/pricing); Spanish coverage not stated on that page |
| ElevenLabs Scribe v2 | Batch endpoint only in the API reference I read | $0.22 per hour | [pricing](https://elevenlabs.io/pricing/api), [reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) |
| faster-whisper sidecar (this repo) | File upload, no partials | VPS time only | `infra/voice/faster-whisper` |

Implemented now: `OpenAiCompatibleStt` (Groq, OpenAI, the sidecar). It uploads the turn as one 16 kHz WAV after the client's end of turn. Nothing in the app calls this streaming, and `onPartial` is never invoked for it. A live-partials provider (Deepgram, OpenAI Realtime) would be a new `SpeechToTextService`; the interface already carries `onPartial`. Partials only matter for showing text while the owner is still speaking; they do not shorten the wait after the end of speech.

### Text to speech

| Provider | Streaming | Price | Source |
| --- | --- | --- | --- |
| ElevenLabs Flash v2.5 | HTTP chunked PCM (`pcm_16000/22050/24000/44100`; `pcm_44100` needs Pro) | $0.04 per 1,000 characters (API) | [pricing](https://elevenlabs.io/pricing/api), [stream endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/stream) |
| ElevenLabs Multilingual v2 | same | $0.08 per 1,000 characters | same |
| OpenAI `gpt-4o-mini-tts` | Streams audio | $12 per 1M audio output tokens; no per-minute figure on the page, so the cost table uses a $0.015 per minute figure I recall from the model launch; it was not retrieved today and is only an estimate | [pricing](https://developers.openai.com/api/docs/pricing) |
| OpenAI `tts-1` | Streams audio | $15 per 1M characters | same |
| Deepgram Aura-2 | Streams audio | $0.03 per 1,000 characters | [deepgram.com/pricing](https://deepgram.com/pricing) |
| Piper sidecar (this repo) | Whole WAV per sentence, then sliced | VPS time only | `infra/voice/piper` |

ElevenLabs is called once per sentence over a pooled keep-alive connection (Node's fetch) with `previous_text` for continuity; `language_code=es` is sent (Flash accepts it, Multilingual v2 would not). The WebSocket `stream-input` API would give better prosody across sentences but needs a direct `ws` dependency and a more complex cancel path; not worth it for 1 to 3 sentence replies.

## Latency

Measured on this development machine (Intel i7-1165G7, 8 threads, Docker CPU, no GPU), with the sidecars from `infra/voice` and `apps/server/scripts/voice-bench.ts`. Nothing here includes network, Claude or the browser.

| Measurement | Result | Kind |
| --- | --- | --- |
| Piper `es_MX-ald-medium`: text of a full reply to first audio written | p50 214 to 232 ms, p95 292 to 310 ms (n=9 and n=6, three sample replies of 73, 131 and 106 characters) | measured, local |
| Piper real-time factor (synthesis time / audio time) | 0.04 | measured, local |
| faster-whisper `small` int8, 4.9 s of clean synthetic speech, beam 1 | p50 1.71 s, p95 1.80 s (n=6) | measured, local |
| faster-whisper `small` int8, beam 5 | 1.68 to 1.97 s | measured, local |
| faster-whisper `large-v3-turbo` int8 | 6.3 to 6.8 s | measured, local |
| Groq, OpenAI, ElevenLabs, Deepgram | not measured: no API keys exist in this environment | pending owner connection |
| Fixture providers | below 1 ms; they only prove the plumbing, not any real latency | fixture only |

Advertised, not verified: ElevenLabs lists "~75ms" for Flash on its pricing page. That is model latency before network and before the first sentence exists; it is not time to first audible sound in the app. Groq's models page does not list a speed factor.

Quality finding from the same run: `small` int8 misheard a clean Piper sentence ("Lesto, Lauren ... citotradas 3 de la tarde"), `large-v3-turbo` got it right but took 6.3 to 6.8 s for 4.9 s of audio, slower than real time and about 4 times slower than `small`. A CPU-only STT sidecar is therefore either inaccurate or slow; a hosted STT is the practical choice.

### What the app records

`turns` stores `stt_ms` (end of capture to final transcript), `first_text_ms` and `first_audio_ms` (both measured from the end of user input, server side) and `client_first_audio_ms` / `client_first_text_ms` (reported by the client). `apps/server/scripts/voice-bench.ts` measures STT and TTS with whichever providers are configured (fixtures otherwise, labeled as such) and, with `--db data/jarvis.db`, prints p50, p95 and max of those columns for simple turns and tool turns:

```bash
pnpm --filter @jarvis/server bench:voice --runs 9
TTS_PROVIDER=piper PIPER_URL=http://127.0.0.1:5000 pnpm --filter @jarvis/server bench:voice --db data/jarvis.db
```

## Monthly cost

Assumptions: 30 days, 8 s of owner speech and 12 s of reply per turn. Spanish speech from Piper ran at 15.0 characters per second (73 characters in 4.86 s), so 12 s is 180 characters. The sample replies in `voice-bench.ts` average 103 characters (about 7 s); `assistant/CLAUDE.md` asks for one to three short sentences, so 180 is conservative. Claude itself is covered by the owner's subscription and is not included.

| Turns per day | Turns per month | Speech seconds in | Reply characters |
| --- | --- | --- | --- |
| 10 | 300 | 2,400 | 54,000 |
| 30 | 900 | 7,200 | 162,000 |
| 60 | 1,800 | 14,400 | 324,000 |

| Option (USD per month) | 10/day | 30/day | 60/day |
| --- | --- | --- | --- |
| STT Groq turbo (8 s billed as 10 s) | 0.03 | 0.10 | 0.20 |
| STT Groq large-v3 | 0.09 | 0.28 | 0.56 |
| STT OpenAI gpt-4o-mini-transcribe | 0.12 | 0.36 | 0.72 |
| STT OpenAI gpt-transcribe | 0.18 | 0.54 | 1.08 |
| STT Deepgram Nova-3 streaming | 0.23 | 0.70 | 1.39 |
| STT ElevenLabs Scribe v2 | 0.15 | 0.44 | 0.88 |
| TTS ElevenLabs Flash ($0.04 per 1K) | 2.16 | 6.48 | 12.96 |
| TTS ElevenLabs Multilingual v2 ($0.08 per 1K) | 4.32 | 12.96 | 25.92 |
| TTS Deepgram Aura-2 | 1.62 | 4.86 | 9.72 |
| TTS OpenAI tts-1 | 0.81 | 2.43 | 4.86 |
| TTS OpenAI gpt-4o-mini-tts (estimate) | 0.90 | 2.70 | 5.40 |
| TTS Piper sidecar | 0 | 0 | 0 |

ElevenLabs also sells monthly plans (Starter $6, Creator $22, Pro $99) with included usage; the pricing page does not map allowances to plans clearly enough to model, and instant cloning needs a paid plan. Treat the per-character API rate as an upper bound for light use and re-check the plan allowance when subscribing.

## Recommendation

- STT: Groq `whisper-large-v3-turbo`. About $0.03 to $0.20 per month, Whisper-class Spanish accuracy, simple file upload that matches the end-of-turn VAD design. Keep the faster-whisper sidecar only as an offline fallback; on a CPU VPS it is either wrong (`small`) or slower than real time (`large-v3-turbo`). Real latency pending the owner's key.
- TTS now: Piper with the temporary voice below, zero marginal cost and 0.2 s to first audio measured locally.
- TTS for quality or a clone: ElevenLabs Flash v2.5 with an Instant Voice Clone, about $2 to $13 per month at the character rates above plus a paid plan.

## Authorized voice (private use)

The owner states they have the actor's permission for private use. The tooling is documented in `voice/README.md`; no audio, transcripts, datasets or weights are committed.

### Which dub

The owner chose the Latin American Spanish dub. The film's Latin American dub is credited to SDI Media de México directed by Pepe Toño Macías, and the community wiki Doblaje Wiki attributes J.A.R.V.I.S. to Milton Wolch ([J.A.R.V.I.S. page](https://doblaje.fandom.com/es/wiki/J.A.R.V.I.S.), [film page](https://doblaje.fandom.com/es/wiki/Iron_Man:_El_hombre_de_hierro)). I could only read this through search-result summaries: the wiki pages themselves are behind a Cloudflare challenge, they are user-edited, and a second search found no independent cast sheet. Treat "Milton Wolch" as an unconfirmed candidate; the owner should confirm it against an official credit before it is written anywhere else. The identity of the actor does not change the tooling, which selects the voice by acoustic similarity to a reference clip.

### Cloning options

| Option | What it takes | Fit |
| --- | --- | --- |
| ElevenLabs Instant Voice Cloning | 1 to 2 minutes of good audio (each file at least 5 s, at least 10 s in total), no training, served by the same streaming endpoint and voice id | Fastest path. Quality depends on how clean the reference is; film audio with music and effects needs the source-separated and speaker-filtered segments from the dataset tooling. A paid plan is required; the docs I read do not name the tier. Voice id goes in `ELEVENLABS_VOICE_ID`. |
| ElevenLabs Professional Voice Cloning | 30 to 180 minutes, Creator plan or above | Does not fit. The docs say a professional clone can only be made of your own voice and requires a verification step by the voice owner ([voice cloning docs](https://elevenlabs.io/docs/creative-platform/voices/voice-cloning)). The owner is not the actor, so that verification cannot be passed honestly and must never be faked or worked around. Only the actor could create and verify one and share it. |
| Piper fine-tune (one-off GPU job) | CSV of `wav|text` pairs, a medium-quality checkpoint such as `es_MX-ald-medium`, `python -m piper.train fit --ckpt_path ...`, then `export_onnx` ([TRAINING.md](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/TRAINING.md)) | Cheap and fully private, runs on the existing CPU sidecar afterwards. The training guide gives neither a dataset size nor a duration. Estimate (mine, not the vendor's): 12 to 24 hours on one RTX 4090, which is $4 to $8 on RunPod community cloud ($0.34 per hour) or $11 to $21 on secure cloud ($0.89 per hour) ([runpod.io/pricing](https://www.runpod.io/pricing)); budget $25 including a failed first attempt. The result is a single-speaker voice with Piper's quality ceiling (flat prosody) and it only reproduces the clean segments it saw. |
| XTTS-v2 | Zero-shot cloning from a few seconds of audio | Weights under the Coqui Public Model License, which restricts commercial use ([license](https://coqui.ai/cpml)); private personal use is the only safe reading. The Python package `coqui-tts` is MPL-2.0. |
| F5-TTS | Zero-shot cloning; a Spanish fine-tune exists | Code is MIT (`f5-tts` 1.1.22), but the base weights and the `F5-Spanish` weights are CC-BY-NC-4.0, so private non-commercial use only. |
| Chatterbox multilingual | Zero-shot cloning, 23 languages including Spanish | MIT code and weights (`chatterbox-tts` 0.1.7); outputs carry Resemble's imperceptible watermark. Needs a GPU for comfortable latency. |

Open zero-shot models need a GPU service next to the server, which the current deployment does not have; they stay options for later.

### Natural voice versus processed character

Film dialogue for J.A.R.V.I.S. already carries filtering and reverb. A model cloned from it learns that coloration, so the server effect must stay at 0 for it. A clone built from the natural, unprocessed recording (not available here) would instead want the effect at 0.15 to 0.3. Never stack both: the `processed` flag in `audio.begin` exists so a client never adds a third layer.

### Dataset tooling

See `voice/README.md` for the procedure, the evaluation protocol and the results of the run on the owner's private clips (counts and durations only).

## Temporary original voice

**This is a temporary stand-in, not the clone.** It is an original synthetic voice that does not imitate any actor: Piper `es_MX-ald-medium` (Mexican Spanish, male, dataset under the Unlicense) with `VOICE_ROBOTIC_INTENSITY=0.15`. Use it until a cloned voice is approved.

```bash
docker build -t jarvis-piper infra/voice/piper && docker run -d -p 127.0.0.1:5000:5000 jarvis-piper
TTS_PROVIDER=piper PIPER_URL=http://127.0.0.1:5000 PIPER_SAMPLE_RATE=22050 VOICE_ROBOTIC_INTENSITY=0.15
```

Licenses of the engine and the voice are recorded in `infra/voice/README.md`.

## End-to-end voice turn with real services (2026-10-25)

Run by the lead on the development machine: the device simulator streamed a Piper-synthesized question as 16 kHz PCM to `/ws/device`; the server used faster-whisper `small` (local sidecar, CPU), Claude Sonnet 5.5 through the owner's subscription, and Piper `es_MX-ald-medium` (local sidecar). Latencies are from the `turns` table, measured from the end of the user's audio.

| Turn | Transcript | Reply (Claude) | STT | First text | First audio |
| - | - | - | - | - | - |
| "Jarvis, ¿qué día es hoy y qué hora es en Buenos Aires?" | "Carbis, que día es hoy? Que horas en Buenos Aires?" | Correct date and local time, spoken-style numbers, one dry remark | 1.85 s | 4.35 s | 4.73 s |
| "¿Y mañana qué día es?" (same conversation) | "y mañana querías." | "Mañana es lunes veintiséis de octubre", checked agenda and reminders, stated what it covers | 1.48 s | 7.70 s | 7.80 s |

Findings: both turns resumed the same Claude session; reply audio streamed with 0 dropped frames. CPU `small` transcription is the weakest link (wrong words, ~1.5–1.9 s); the 2–3 s first-audio target is not met with local STT. Next measurement: Groq `whisper-large-v3-turbo` once the owner provides a key.

