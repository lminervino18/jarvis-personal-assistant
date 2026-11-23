# Call mode: turns, interruptions and latency

How a voice call decides when the owner finished, when an interruption is real, and how fast the reply starts. Read with `docs/voice.md` (providers, chunking, the voice itself).

Status:
- *implemented*, *tested with fixtures*: endpointing, backchannels, barge-in candidates, Silero plumbing, prepared Claude process;
- *validated with real service*: prepared Claude process (server, 2026-11-23) and Silero inference in Chrome and Node;
- *pending owner validation*: the acoustic behaviour on the iPhone (echo, noise, pauses).

## Two circuits

- Conversation: microphone → Silero VAD (phone) → PCM over the WebSocket → Groq Whisper at pauses and at the end → orchestrator → Claude (streaming) → sentence chunker → ElevenLabs → phone player.
- Work: pages, delegated tasks and agents run in the background (`apps/server/src/tasks`, the host agent runner, the publisher). They notify the conversation when they finish; the call never waits for them. The agent runner and publisher run with `Nice=10`, `CPUWeight=20`, `IOWeight=20`, so they cannot starve the voice server.

## End of turn

The phone detects speech; the server alone confirms the end of a turn.

| Step | Where | Value |
| --- | --- | --- |
| Speech probability per 32 ms window | phone, Silero v6 on onnxruntime-web (WASM, one thread) | start ≥ 0.5, keep ≥ 0.35 |
| Speech confirmed | phone | 200 ms voiced (250 ms and ≥ 0.6 while the reply plays) |
| Pre-roll | phone | 300 ms |
| Pause reported (`audio.pause`) | phone | 450 ms of silence |
| Resume reported (`audio.resume`) | phone | 100 ms voiced after a pause |
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

## Claude start-up

Each turn used to start a Claude Code process after the transcript was ready.
- Measured on the server on 2026-11-22, 6 runs: 0.7 to 1.3 s from process start to init when cold, and about 0.6 s of model time to the first token.
- Haiku 5.5 was not faster to the first token than Sonnet 5.5.

Now the process starts when the owner starts speaking (`prepareTurn`, `runtime.prepare`), and the transcript is handed to it when the turn closes.
- It is discarded if another turn finished meanwhile (its session could be stale), if the speech was noise or a backchannel, or after 150 s.
- Measured on 2026-11-23 on the server with the real runtime, 4 turns each: first text 911 ms median without preparing, 700 ms with it (warm disk cache). The cold-start saving is larger.

## Measuring

- Per turn: `docker compose logs server | grep -E "turn timing|turn endpoint|backchannel|client audio|event loop"`.
- Latency report from the database: `docker compose exec -T -e SINCE=<iso date> server node - < infra/scripts/voice-report.cjs`.
- `first_text_ms` and `first_audio_ms` count from the moment the turn closed (server) or the pause was reported (phone). The silence the owner waited before that is the endpointing time in the table above.

## Rollback

- `infra/scripts/deploy.sh rollback` returns to the previous image tag. No database migration is involved.
- The agent priority lives in `/usr/local/sbin/jarvis-agent-runner-install`. An admin must copy it again from `infra/agents/install-host-runner.sh` after changing that script, since deploys only run the installed copy.

## Not done yet

- Speculative generation (starting Claude on a stable checkpoint before the turn is confirmed).
- ElevenLabs WebSocket input streaming; replies still synthesize one sentence per request over a pooled connection.
- Keeping one Claude process for a whole call; the per-turn process is only started earlier.
- Recording in history which part of an interrupted reply was actually heard.
