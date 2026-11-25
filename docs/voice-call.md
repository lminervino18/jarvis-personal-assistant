# Call mode: turns, interruptions and latency

How a voice call decides when the owner finished, when an interruption is real, and how fast the reply starts. Read with `docs/voice.md` (providers, chunking, the voice itself).

Status:
- *implemented*, *tested with fixtures*: endpointing, backchannels, barge-in candidates, Silero plumbing, prepared Claude process;
- *validated with real service*: prepared Claude process (server, 2026-11-23) and Silero inference in Chrome and Node;
- *pending owner validation*: the acoustic behaviour on the iPhone (echo, noise, pauses).

## Two circuits

- Conversation: microphone → Silero VAD (phone) → PCM over the WebSocket → Groq Whisper at pauses and at the end → orchestrator → Claude (streaming) → sentence chunker → one ElevenLabs socket per reply → phone player.
- Work: pages, delegated tasks and agents run in the background (`apps/server/src/tasks`, the host agent runner, the publisher). They notify the conversation when they finish; the call never waits for them. The agent runner and publisher run with `Nice=10`, `CPUWeight=20`, `IOWeight=20`, so they cannot starve the voice server.

## End of turn

The phone detects speech; the server alone confirms the end of a turn.

| Step | Where | Value |
| --- | --- | --- |
| Speech probability per 32 ms window | phone, Silero v6 on onnxruntime-web (WASM, one thread) | start ≥ 0.5, keep ≥ 0.35 |
| Speech confirmed | phone | 200 ms voiced (250 ms and ≥ 0.6 while the reply plays) |
| Pre-roll | phone | 300 ms |
| Tentative pause (`audio.pause` with `tentative`) | phone | 250 ms of silence: the server starts transcribing in advance |
| Pause reported (`audio.pause`) | phone | 450 ms of silence; reuses the tentative transcription if the owner did not speak in between |
| Resume reported (`audio.resume`) | phone | speech after a tentative pause, or 100 ms voiced after a pause |
| Checkpoint | server | Whisper transcribes the audio so far at each pause |
| Close now | server | the checkpoint sounds finished (`turnLooksComplete`): question, short answer, sentence without a trailing connector |
| Close after waiting | server | 1.8 s more without speech (2.25 s of silence in total) |
| Safety net | phone | `audio.end` after 3.5 s of silence; 115 s per utterance |

`turnLooksComplete` keeps the turn open after a trailing connector or article ("quiero que…", "el de…"), an ellipsis or comma, a modal verb ("necesito"), or a self-correction marker ("perdón", "o sea"). When the turn closes on a complete checkpoint, that transcript is reused, so there is no second Whisper call.

If Silero cannot load, the phone falls back to the volume detector, which ends turns after 700 ms of silence (the previous behaviour). The `client audio` log line says which detector runs and what the browser applied (echo cancellation, noise suppression, gain control).

## Interruptions

Speech that starts while the reply plays is a candidate, not an interruption:

1. The reply is lowered to 20 % (not stopped) and the speech is sent with `duringPlayback`.
2. 600 ms of voiced speech confirms it on the phone: the reply stops, its turn is cancelled and its late audio is dropped by the audio gate.
3. A shorter candidate is transcribed at its first pause. A backchannel ("ajá", "sí, claro", "dale", up to three words) or noise is dropped and the reply returns to full volume from where it was. Anything else ("pará", "esperá, no") confirms the interruption.

Lowering the reply also lowers its echo, so residual echo rarely survives as a candidate, while the owner's voice does. The stop button still cuts everything at once.

## The owner's voice

Status: *implemented* and *tested with fixtures*; *pending owner* enrollment and threshold tuning with real calls.

- **Enrollment.** Configuración › Reconocer mi voz, or `<PUBLIC_ORIGIN>/voz`:
  - the owner reads 8 phrases (`voice/enrollment-routes.ts`);
  - each one is uploaded as 16 kHz PCM to `DATA_DIR/voice/enrollment` and never goes to Git;
  - with the last phrase, the server averages their embeddings into `DATA_DIR/voice/voiceprint.json`.
- **Model.** 3D-Speaker CAM++ (VoxCeleb, 16 kHz, 512 dimensions) through `sherpa-onnx-node` 2.0.3, Apache-2.0:
  - baked into the image at `/app/models/speaker.onnx` with its sha256 checked by `ADD --checksum`;
  - loaded on first use;
  - measured on the development machine with one thread: 29 ms for 1.5 s of audio, 53 ms for 3 s, plus 0.45 s to load once;
  - with a voiceprint, the server warms the model in the background 10 s after it starts.
- **In a call:**
  - the server keeps the first 3 s of each utterance and scores it against the voiceprint while Whisper transcribes;
  - below `SPEAKER_THRESHOLD` (default 0.35, cosine), the utterance is dropped like noise: no turn, and the reply keeps playing;
  - utterances shorter than 1 s cannot be judged and are accepted;
  - every score is logged as `speaker score`, so the threshold can be tuned with real calls.
- **Interruptions.** With a voiceprint, `ready.capabilities.speakerCheck` is true and the phone no longer stops the reply on its own after 600 ms of speech. It only lowers the volume, and the server's verdict at the first pause decides whether the reply is interrupted.
- **Dictation** is never checked: the owner pressed the microphone.

## Claude start-up

Each turn used to start a Claude Code process after the transcript was ready.
- Measured on the server on 2026-11-22, 6 runs: 0.7 to 1.3 s from process start to init when cold, and about 0.6 s of model time to the first token.
- Haiku 5.5 was not faster to the first token than Sonnet 5.5.

Now the process starts when the owner starts speaking (`prepareTurn`, `runtime.prepare`), and the transcript is handed to it when the turn closes.
- It is discarded if another turn finished meanwhile (its session could be stale), if the speech was noise or a backchannel, or after 150 s.
- Measured on 2026-11-23 on the server with the real runtime, 4 turns each: first text 911 ms median without preparing, 700 ms with it (warm disk cache). The cold-start saving is larger.

## Speech synthesis

ElevenLabs runs over its stream-input WebSocket: one socket per reply, opened when the turn starts (before Claude writes), one flushed message per sentence, `{"text": ""}` at the end. If the socket fails before any audio, the reply falls back to one HTTP request per sentence.

Measured on 2026-11-23 from the server, 3 runs each, text arriving 700 ms after the speaker opened:
- first audio after the text: 248 ms median over HTTP, 269 ms over the socket (no difference, since HTTP reused its connection);
- whole reply generated: 679 ms over HTTP, 517 ms over the socket.

The gain is continuity (prosody across sentences, fewer chances of gaps), not the first sound. It costs the same, since characters are billed the same.

## Measuring

- Per turn: `docker compose logs server | grep -E "turn timing|turn endpoint|backchannel|client audio|event loop"`.
- Latency report from the database: `docker compose exec -T -e SINCE=<iso date> server node --input-type=module - < infra/scripts/voice-report.mjs`.
- `first_text_ms` and `first_audio_ms` count from the moment the turn closed (server) or the pause was reported (phone). The silence the owner waited before that is the endpointing time in the table above.

## Rollback

- `infra/scripts/deploy.sh rollback` returns to the previous image tag. No database migration is involved.
- The agent priority lives in `/usr/local/sbin/jarvis-agent-runner-install`. An admin must copy it again from `infra/agents/install-host-runner.sh` after changing that script, since deploys only run the installed copy.

## Not done yet

- Speculative Claude generation. Transcription is what waits: Whisper takes about 300 ms and now starts at 250 ms of silence, so its result arrives after the 450 ms confirmation. Starting Claude earlier would spend plan quota for no gain until transcription gets faster than the pause.
- One Claude process for the whole call. The per-turn process is already started while the owner speaks (or while the previous reply plays): about 45 ms to init against 700 ms of model time. A permanent process would not cut a measurable amount and would need per-turn tools and policy rebuilt.
- Recording in history which part of an interrupted reply was actually heard.
