# Acceptance report

Independent QA of the 18 acceptance tests. Written on 2026-10-25 by the integration and QA role against branch `test/e2e-acceptance`, rebased on `main` at `5cec77a`. Every claim below was checked against the code, a test run, a command or a CI log. Where a claim comes from another role's documentation and was not reproduced, it says so.

Status vocabulary (from `CLAUDE.md`): implemented, tested with fixtures, validated with real service, pending owner connection, pending hardware.

## Summary

| # | Acceptance test | Status |
| - | - | - |
| 1 | Spoken query answered with audio | validated with real service (local STT/TTS sidecars; external providers pending owner keys) |
| 2 | "¿y mañana?" follow-up keeps context | validated with real service |
| 3 | Restart without losing memory or reminders | tested with fixtures (real built processes) |
| 4 | Real query to each Gmail without mixing accounts | tested with fixtures; pending owner connection |
| 5 | WhatsApp with an honest history limit | tested with fixtures; pending owner connection |
| 6 | Reconnection without duplicates | tested with fixtures (real built processes) |
| 7 | Create, modify and cancel reminders | tested with fixtures |
| 8 | Reminders and notices with Claude disconnected | tested with fixtures (real built processes) |
| 9 | Push on an installed iPhone | pending hardware; pending owner connection (VAPID keys) |
| 10 | Interruption without old audio or duplicate writes | tested with fixtures (real built processes) |
| 11 | Injection from messages has no effect | tested with fixtures |
| 12 | Anonymous access rejected | tested with fixtures (real built processes) |
| 13 | Quota exhausted and revoked tokens handled | tested with fixtures; Claude authentication failure exercised against the real SDK subprocess |
| 14 | Voice failure falls back to text | tested with fixtures (real built processes) |
| 15 | YouTube blocked with a visible alternative | tested with fixtures (partial, see gap); iOS autoplay pending hardware |
| 16 | Real backup restore | tested with fixtures in CI; real bucket pending owner connection |
| 17 | CI without secrets or personal accounts | validated with real service (GitHub Actions) |
| 18 | M5 simulator validated, physical tests pending | simulator tested with fixtures and validated with real service; firmware compiled; physical tests pending hardware |

"Real built processes" means the test starts `apps/server/dist/main.js` and `dist/worker.js` as child processes and only talks to them over HTTP and WebSocket plus the SQLite file (`tests/e2e`).

## How the end-to-end tests work

`tests/e2e` is a pnpm workspace package (`@jarvis/e2e`) wired into `pnpm test`. Its vitest global setup rebuilds the server with esbuild, so it works before `pnpm build` runs. Each test file starts its own stack in a temp directory: random port, `NODE_ENV=test`, `RUNTIME=scripted`, `STT_PROVIDER=fixture`, `TTS_PROVIDER=fixture`, a synthetic scrypt hash with the production parameters, a throwaway `HOME`, and a clean environment (no inherited tokens). Message validation uses the shared contract: every JSON message the server sends is parsed with `ServerMessage`.

Where the fixture TTS cannot do the job, the stack uses a real provider configuration pointing at a local stub: `TTS_PROVIDER=piper` with a stub that answers slowly (deterministic mid-speech interruption) or with 503 (provider failure), and `STT_PROVIDER=faster-whisper` with a stub that answers 500. The fixture providers themselves have no failure switch reachable from the environment.

Run: `pnpm --filter @jarvis/e2e test` (26 tests, about 12 s). Repeated full `pnpm test` runs and three concurrent runs of the e2e package passed without a flake.

## Evidence per test

### 1. Spoken query answered with audio

- `tests/e2e/conversation.test.ts`: "answers a spoken query with a transcript, text and audio tagged with the turn id". Sends `audio.begin`, 1 s of 16 kHz PCM frames and `audio.end`; checks the transcript, `assistant.done`, `audio.begin` with the negotiated 24 kHz format, binary frames tagged with the turn id (`ttsAudio`, even length, audible samples), `audio.end` complete, the event order, and the `turns` row (`input_mode` voice, `status` completed, `stt_ms` and `first_audio_ms` set).
- `apps/server/src/voice/voice-websocket.test.ts`: "transcribes a spoken turn, answers by voice and tags every frame with the turn id".
- Real service: `docs/voice.md`, section "End-to-end voice turn with real services" (run by the lead on 2026-10-25, not reproduced by QA): device simulator, faster-whisper small, Claude Sonnet 5.5 on the owner's subscription, Piper. First audio 4.73 s and 7.80 s; the 2 to 3 s target is not met and the local transcription was poor ("Carbis, que día es hoy?").
- `docs/claude-runtime.md`: live probe and latency bench by the lead.
- Gap: the real run went through the device simulator, not the PWA with a real browser microphone and speaker. Groq and ElevenLabs are pending owner keys.

### 2. Follow-up keeps context

- `tests/e2e/conversation.test.ts`: "resumes the same Claude session for the follow-up question in the same conversation". Sends a first question and "¿y mañana?", then checks that both `turns` rows and `conversations.claude_session_id` carry the same session id, `session_turns` counts up and there is one conversation.
- `apps/server/src/app.test.ts`: "streams a turn, resumes the same session for follow-ups and survives a restart".
- Real service: `docs/claude-runtime.md` live probe, "Follow-up with context (explicit resume)" passed; the voice section of `docs/voice.md` records two spoken turns in one real Claude session.
- The fixture STT returns a fixed transcript, so the e2e follow-up is typed.

### 3. Restart without losing memory or reminders

- `tests/e2e/restart.test.ts`:
  - "keeps conversations, memory and pending reminders after both processes are killed": SIGKILL of server and worker, a memory row and a reminder inserted before, a late reminder inserted while down; after the restart the memory row and its FTS match are intact and the conversation history is served again.
  - "fires each reminder exactly once after the restart, flagging the overdue one as late": two reminders fired, one outbox `chat_message` each, all `sent`, two system messages.
  - "recovers the conversation after a restart even though the scripted session is gone": the follow-up still completes through the seeded-session fallback; the server log shows "claude session could not be resumed; starting a seeded session".
  - "survives a graceful SIGTERM restart too".
- `apps/server/src/worker/worker.test.ts`: "recovers after a crash between firing and delivery without firing again", "fires reminders overdue within the grace window as late and turns older ones into a single digest".
- Limit: memory is written with SQL in the e2e (there is no Claude tool path without a real Claude). The memory tools are covered by unit tests (`apps/server/src/tools/tools.test.ts`, "removes the memory and scrubs its text from the audit trail").

### 4. Each Gmail account, no mixing

- `apps/server/src/integrations/gmail/gmail.test.ts`: "with account all keeps accounts separate and tolerates a missing work account", "queries both accounts, labels each item and pages them independently", "shows the work label as cleanly not connected while personal is connected".
- `apps/server/src/tools/gmail-tools.test.ts`: "returns thread messages labeled with their account and without secrets", "reports the work account as not connected with a connect card".
- No real Google account was contacted. Pending owner connection.

### 5. WhatsApp with an honest history limit

- `apps/server/src/tools/whatsapp-tools.test.ts`: "finds messages ignoring accents and reports coverage per source", "says plainly when nothing has been imported or synced".
- `docs/integrations/whatsapp.md`: every result carries earliest and latest message per source and a note that a missing message does not prove it does not exist; `apps/server/src/integrations/whatsapp/bridge.test.ts` asserts that no send, receipt, presence or history-request API name appears in the bridge.
- The bridge has never connected to WhatsApp. Pending owner connection.

### 6. Reconnection without duplicates

- `tests/e2e/conversation.test.ts`: "restores the conversation on reconnect without duplicating messages or turns" (reconnect with the conversation id, unique message ids, message count exact after the next turn), "does not duplicate writes when a client re-sends a turn id".
- `apps/web/src/protocol/client.test.ts`: "retries with growing delays and resumes the same conversation", "restarts seq counting and resets the backoff after a successful ready".
- `apps/web/src/conversation/thread.test.ts`: "merges a single-item history by id without replacing the thread", "prepends an older page without duplicating known messages".
- `apps/server/src/devices/device-sim.test.ts`: "reconnects after the connection drops and completes the next turn in the same conversation".
- D1 fixed: a re-sent turn id now replays the stored outcome (`orchestrator.test.ts` "replays a finished turn instead of running it twice").

### 7. Create, modify and cancel reminders

- `apps/server/src/tools/agenda-tools.test.ts`: "creates a reminder in the owner's zone and emits a reminder card", "returns the existing reminder for the same text due within a minute and creates distinct ones otherwise", "modifies text, date and recurrence, and reschedules a reminder that already fired", "cancels a reminder once, keeps it out of the scheduled list and refuses to edit it", "lists scheduled reminders by date range with pagination", "holds creation for confirmation after untrusted content and hides nothing in the summary".
- `apps/server/src/worker/worker.test.ts`: firing, recurrence across DST, dedupe, two workers on one database.
- Firing is also covered end to end by `tests/e2e/restart.test.ts` and `tests/e2e/reminders-claude-down.test.ts`.
- Limit: the tools were never driven by a real Claude turn that creates a reminder from speech; the live probe only covers one in-process MCP tool call.

### 8. Reminders and notices with Claude disconnected

- `tests/e2e/reminders-claude-down.test.ts` (server with `RUNTIME=claude`, `CLAUDE_CONFIG_DIR=/nonexistent/claude-config`, no token, throwaway `HOME`; the worker runs next to it):
  - "fires a due reminder into the chat before any Claude call": the live `history` event carries a system message and a `reminder` card with status `fired`.
  - "reports Claude as unavailable in Spanish without taking the server down": the real Claude Code subprocess starts without credentials and answers `claude_auth_failed` in about 0.3 s ("No pude autenticarme con Claude. Hay que renovar la conexión de la suscripción en el servidor."), the turn ends `failed` and `/healthz` stays ok.
  - "still fires reminders created after the Claude failure, exactly once".
- `apps/server/src/worker/worker.test.ts`: "fires reminders and delivers them to the chat with no model runtime available", "does not bundle the Claude runtime into the worker process".
- No real Claude call is made: the subprocess has no credentials and the test never reads the owner's login.

### 9. Push on an installed iPhone

- Not validated on a device. Fixture evidence: `apps/server/src/worker/worker.test.ts` ("delivers a push to every subscribed device and records the success", "retries with exponential backoff and buries the entry after the last attempt", "prunes subscriptions the push service reports as gone", "keeps private text out of the push payload but not out of the chat"), `apps/server/src/push/push.test.ts` (VAPID settings, endpoint validation, "shows the reminder text and tags the notification by reminder", "hides sensitive text and shortens long text"), `apps/web/src/pwa/sw.test.ts` ("shows the discreet notification the server sends and replaces by tag").
- Pending hardware (an iPhone with the installed PWA, which also needs the owner's domain over HTTPS) and pending owner connection (VAPID keys).

### 10. Interruption without old audio or duplicate writes

- `tests/e2e/interruption.test.ts` (TTS through a slow Piper-protocol stub so cancellation lands mid-speech):
  - "stops synthesis and audio after turn.cancel and writes the turn exactly once": `audio.end` reason `cancelled`, `turn.end` cancelled, no synthesis request after the cancel, no frame after `audio.end`, less than half the audio of an uninterrupted run, exactly one user and one assistant message, one turns row.
  - "drops the old audio when the owner speaks again over it": the superseded turn ends `cancelled`, its `audio.end` precedes the next turn's `audio.begin`, no old frame after it, both turns written once.
- `apps/server/src/voice/voice-websocket.test.ts`: "stops speaking right away when the owner interrupts". `apps/server/src/app.test.ts`: "cancels a running turn, keeps the partial text and lets a new turn supersede an old one". `apps/web/src/audio/voice-loop.test.ts`: "cancel drops the utterance without reporting an end". `tools/device-sim/src/simulator.test.ts`: "discards the reply and drops late frames of a cancelled turn".
- Writes made by tools before a cancellation are protected by idempotency keys (`tools.test.ts`, "is idempotent for repeated writes within the same turn").
- Observation O1 below.

### 11. Injection from messages has no effect

- `apps/server/src/tools/gmail-tools.test.ts`, "prompt injection through email": "marks the turn as tainted so a following state change needs confirmation", "wraps the result delivered to the model as untrusted third-party content" (synthetic fixture `fixtures/synthetic/gmail/thread-injection.json`).
- `apps/server/src/tools/whatsapp-tools.test.ts`, "prompt injection through WhatsApp": "taints the turn so a following state change needs confirmation".
- `apps/server/src/tools/tools.test.ts`: "holds state changes for owner confirmation after untrusted content", "executes a confirmed pending action exactly once". `agenda-tools.test.ts`: "holds creation for confirmation with a readable summary after untrusted content", "requires owner confirmation to confirm after reading untrusted content".
- The protection is enforced in `tools/runner.ts`, not in the prompt. No end-to-end injection test exists because the model must read the tool result; it was not run against a real Claude with an adversarial message.

### 12. Anonymous access rejected

- `tests/e2e/access.test.ts` (6 tests): anonymous session and context routes, WebSocket upgrade without a cookie or with a forged one (401), login from a foreign origin (403), wrong password (401, no cookie), cookie flags (`HttpOnly`, `SameSite=Strict`), valid cookie with a foreign or missing origin (403), cookie revoked by logout (401).
- `tests/e2e/device.test.ts`: "rejects anonymous pairing and sockets without a known device token".
- `apps/server/src/app.test.ts`: "rejects anonymous access, bad passwords and foreign origins".
- Not covered: TLS, Caddy and the public network (pending a real VPS).

### 13. Quota exhausted and revoked tokens

- Quota: `apps/server/src/app.test.ts` "reports quota exhaustion as a structured, persisted failure"; `apps/server/src/runtime/runtime.test.ts` "maps quota rejection and refuses silent paid overage". Quota exhaustion was never triggered on the real service.
- Claude authentication: `runtime.test.ts` "maps authentication failures reported on assistant messages"; the e2e in test 8 exercises the real SDK subprocess without credentials and gets `claude_auth_failed` with the Spanish message.
- Google tokens: `apps/server/src/integrations/gmail/gmail.test.ts` "refreshes once when Gmail answers 401 and gives up with auth_expired when it persists", "maps invalid_grant on refresh to an expired account in status"; `gmail-tools.test.ts` "surfaces an expired authorization as auth_expired with a reconnect card".
- Device tokens: `tests/e2e/device.test.ts` "refuses the device token once the owner revokes it"; `device-sim.test.ts` "stops reconnecting once the owner revokes the device".

### 14. Voice failure falls back to text

- `tests/e2e/voice-failure.test.ts`:
  - "keeps the written answer when text-to-speech breaks" (provider answers 503): `assistant.done` with the text, then `error` `tts_failed` ("la respuesta quedó por escrito"), no audio, messages written once.
  - "asks the owner to retry or type when speech-to-text breaks, then keeps working" (provider answers 500): `stt_failed`, no turn written, a typed message completes afterwards.
  - "answers by text with a notice when no text-to-speech provider is configured".
- `apps/server/src/voice/voice-websocket.test.ts`: "keeps the written answer and reports tts_failed when synthesis breaks". `apps/server/src/voice/reply-speaker.test.ts`: "rejects finish() when synthesis fails and tells the sink about the error".

### 15. YouTube blocked with a visible alternative

- Server: `apps/server/src/tools/youtube-tools.test.ts` "falls back to a link card and says so without an API key"; `apps/server/src/integrations/youtube/youtube.test.ts` "returns a search link and never calls the network without a key".
- Web: `apps/web/src/cards/Cards.test.tsx` "starts the YouTube card as loading and never as playing" asserts the "Abrir en YouTube" link; `YoutubeCard.tsx` renders that link in every state, including `blocked`, and reports `blocked` to the server (`apps/web/src/cards/youtube-api.test.ts` checks a status list that includes `blocked`).
- Gap G1: no test drives the `blocked` state (autoplay refused) and asserts that the alternative is visible. The README's "player validated in Chrome (demo mode)" was not reproduced. Autoplay behavior on iOS Safari is pending hardware.

### 16. Real backup restore

- CI job `docker`, step "Backup and restore round trip" (`infra/scripts/restore-test.sh`), run 40171585659: "restore-test: passed: 41 tables with identical row counts, integrity ok, server healthy on the restored database". It backs up with restic while the server keeps the database open, wipes the volume, restores and boots the server on the result.
- It uses synthetic rows and a local repository. A restore from the owner's real bucket has not been done: pending owner connection (VPS, bucket, backup password).

### 17. CI without secrets or personal accounts

- `grep -rn "secrets\.\|vars\." .github/` returns nothing; the workflow has `permissions: contents: read`, pins actions and images by digest, and runs gitleaks over the full history in the `secrets` job.
- `gh run view 40171585659 -R lminervino18/jarvis-personal-assistant`: conclusion success on `main`, commit `021a4af`, jobs `check`, `docker`, `secrets` and `workflows` all passed.
- The run is for `021a4af`, not for the current head of `main`, and the new `tests/e2e` package has not run in CI yet (nothing was pushed). The e2e tests need no secret: the Claude failure test runs the SDK subprocess without credentials.

### 18. M5 simulator validated, physical tests pending

- Simulator: `tools/device-sim` tests (15), `apps/server/src/devices/device-sim.test.ts` (full voice turn, cancel, reconnection, revocation, unknown token), and `tests/e2e/device.test.ts` "runs a full 16 kHz voice turn from the simulator CLI and stores the turn", which pairs a device over HTTP, runs the simulator CLI against the built server and checks the WAV and the `turns` row.
- Real service: the lead's turn in `docs/voice.md` ran through the simulator and `/ws/device` with real STT, Claude and TTS (not reproduced by QA).
- Firmware: `docs/device.md` records a PlatformIO build (RAM 15.4 %, flash 71.5 %), not reproduced by QA. QA compiled and ran the host protocol test: `g++ -std=c++17 -Wall -Wextra -Ilib/protocol test/host/protocol_test.cpp lib/protocol/protocol.cpp` in `firmware/atom-echo` prints "protocol tests passed".
- Pending hardware: Wi-Fi, TLS, PDM microphone, speaker, LED, button, memory and latency on a real ATOM Echo (the hardware has not been purchased).

## Clean install and `pnpm check`

On 2026-10-25, after removing every `node_modules` and `dist`: `pnpm install --frozen-lockfile` then `pnpm check`, exit 0 in 30 s on Node 24 and pnpm 10.34.5.

| Package | Test files | Tests |
| - | - | - |
| `packages/contracts` | 1 | 6 |
| `tools/device-sim` | 2 | 15 |
| `apps/web` | 18 | 131 |
| `apps/server` | 34 | 283 |
| `tests/e2e` | 7 | 26 |
| Total | 62 | 461 |

The Docker image also builds with the new workspace package (`docker build .` on the branch before the last rebase).

## Privacy audit

Scope: the working tree and every commit reachable from any local or remote ref (101 commits at the time of the audit).

- Gitleaks `v8.28.0` (`git --no-banner --redact`), run on a mirror clone because the worktree's `.git` points outside the container mount: 101 commits scanned, no leaks.
- No `.env` file in any commit; `.env.example` is the only match. The permission settings deny reading `.env*` files, so QA did not open it; it was checked by gitleaks (no findings) and by the email and phone searches (placeholders only) instead.
- No database, WAL, session, audio, dataset, weight, model, key or archive file has ever been tracked. The only matches for the sensitive-extension patterns are `.env.example` and `firmware/atom-echo/certs/root_ca.pem`, which is the public ISRG Root X1 certificate (no private key, `openssl x509` confirms the subject).
- Emails across all history are placeholders (`example.test`, `example.com`, `example.invalid`) and the author address is a GitHub `users.noreply` address. Phone numbers and WhatsApp ids are synthetic (`5490000000001`, `+5491100000001`, `120363000000000001@g.us`); one other digit string is a package hash in `voice/uv.lock`.
- Images: I opened `assets/screenshots/conversation-desktop.png` and `conversation-mobile.png` (banner "Modo demo: datos ficticios", fictitious event and reminder, no personal data) and the file removed from the tree but still in history, `assets/screenshots/conversation-demo.jpg` (same demo data, a mouse cursor, no personal data). The brand images carry only an Inkscape software tag. No EXIF or GPS data.
- The e2e tests leave nothing behind: temp directories are removed and no fixture contains real data. Server logs from the spoken and typed test turns do not contain any message body.
- Findings: D3 and D4 below.

## Defects and observations

D1. A re-sent turn id is dropped silently (low to medium). Reproduction: open `/ws`, send `user.text` with turn id T, wait for `turn.end`, send `user.text` with the same T. Result: no duplicate writes (good), but the server logs `turn crashed ... UNIQUE constraint failed: turns.id` and the client receives no `error`, no `turn.end` and no state change. A client that retries after a connection drop before it saw `turn.end` waits forever. Test: `conversation.test.ts` "does not duplicate writes when a client re-sends a turn id" covers the no-duplicate part only. Suggested fix: answer an unknown-or-duplicate turn id with a `bad_request` error or replay the stored outcome.

D2 (observation, O1). A reply cancelled while it is being spoken is stored with `interrupted = 0` and `assistant.done` reports `interrupted: false`, while the turn row is `cancelled`. Cause: the assistant message is written before `speaker.finish()` runs (`conversation/orchestrator.ts`). The text is complete, so this may be intended, but a reloaded history cannot show that the owner cut the reply off. Reproduction: speak a multi-sentence reply, send `turn.cancel` after `audio.begin`, read `messages.interrupted` and `turns.status`.

D3. `LICENSE` contains the owner's full legal name ("Copyright (c) 2026 Lorenzo Minervino"). The privacy rule allows only the first name in the tree. It is the copyright holder line and the GitHub username is public, so the owner should decide; severity low.

D4. `.gitignore` has no pattern for WhatsApp chat exports (`WhatsApp Chat*.txt`, `_chat.txt`), and a stray `session.json` is not ignored either (`git check-ignore` reports both as not ignored). Everything else I tried (`.env*`, databases, audio, weights, `private/`, `.credentials.json`) is ignored. Hardening only; the synthetic fixtures under `fixtures/` use other names.

D5 (test gap G1). No test asserts the visible alternative when YouTube playback is `blocked` (acceptance 15).

D6 (known performance gap, from the lead's real run). First audio was 4.73 s and 7.80 s with local CPU STT, against a 2 to 3 s target; transcription quality of faster-whisper small is poor. Not reproduced by QA.

D7 (process). The CI evidence predates the current `main` head and the e2e package has not run on GitHub Actions. The one environment-dependent e2e (`reminders-claude-down`, which starts the bundled Claude binary) accepts `claude_auth_failed` and `claude_unavailable`, so a runner without the binary still passes.

## Resolution by the lead (2026-10-25)

- D1 fixed in `7150e37`: a finished turn id replays its stored messages and `turn.end`; a turn id that is still running is ignored. Test: "replays a finished turn instead of running it twice".
- D2 fixed in `7150e37`: when speech is cut, the reply is marked `interrupted` and `assistant.done` is re-sent with `interrupted: true`. Test: "marks a reply as interrupted when its speech is cut".
- D3 left to the owner: standard copyright line; the name is already public on the GitHub profile.
- D4 fixed in `fbeaf52`: WhatsApp export names and `session*.json` are ignored; synthetic fixtures stay tracked.
- D5 covered: `Cards.test.tsx` "always offers a visible link to open the video on YouTube".
- D6 open: needs the owner's Groq key to measure external STT.
- D7: CI re-runs on the current head after this push.

## Requested changes outside the QA paths

Two minimal edits were needed to wire the package into `pnpm test` and are included in the first e2e commit: `pnpm-workspace.yaml` gains `  - tests/*`, and `pnpm-lock.yaml` gains the `tests/e2e` importer (no new package versions: `ws@8.22.0`, `better-sqlite3@13.0.3`, `@types/ws@8.18.2`, `@types/better-sqlite3@9.6.0` and the workspace contracts, all already in the lockfile).
