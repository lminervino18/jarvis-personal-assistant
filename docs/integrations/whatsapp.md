# WhatsApp

The assistant can search and read the owner's WhatsApp history. It can send a text only through `whatsapp_send`, and only after the owner taps Confirm on a card that shows the recipient and the exact text. It never replies on its own, reacts, marks as read or changes presence.

Two sources feed the same tables (`wa_chats`, `wa_messages` with FTS, `wa_sync_state`, `wa_auth_state`):

| Source | What it is | State |
| --- | --- | --- |
| `import` | "Export chat" text files imported with a CLI. No account access. | Works offline, safe, recommended baseline. |
| `baileys` | Experimental linked-device bridge (separate process). | Disabled unless `WHATSAPP_ENABLED=true`. Owner pairs later by QR. |

## Tools

- `whatsapp_search`: full-text search (accent-insensitive, prefix terms, ranked by relevance) with optional `chatId` (a chat id or an exact chat name), `contactId`, `since`, `until`, `limit` (default 10, max 30) and an opaque `cursor`. System lines, media placeholders, deleted messages and empty texts are never returned as matches.
- `whatsapp_get_messages`: chronological window of one chat. No dates: the latest `limit` (default 30, max 50). With `before`: the latest messages up to that time. With `after` and no `before`: the first messages from that time. Limits are inclusive, so the boundary message can repeat (same `messageId`). System lines are included here.
- `contactId` matches a contact's WhatsApp JIDs (`contact_identities`), the chat linked to it, and sender or 1:1 chat names equal to the contact's display name or aliases.
- Every result includes coverage: earliest and latest message per source (and per chat when a chat is given) plus a note that a missing message does not prove it does not exist. With nothing imported or synced the tool returns no items and says so.
- Text is cut at 1500 characters per message (`textTruncated`). Results are third-party content (`untrustedContentTools`).

## Importing chat exports

In WhatsApp: open the chat, More, Export chat, Without media. Copy the `.txt` to the server and run it (paths are relative to `apps/server`, where the script runs; absolute paths work too):

```
pnpm --filter @jarvis/server wa:import <file.txt> --chat "Nombre del chat" --me "Mi nombre en el chat" [--group] [--date-order dmy|mdy]
```

The command uses `DATA_DIR` (default `./data`) and `TIMEZONE`, prints counts and coverage, and never prints message text. `--me` is the name the exporting phone shows for the owner's own messages (it marks `from_me`). `--group` forces group; otherwise a chat with more than two senders is a group.

- Formats: Android (`24/10/2026 09:03 - Ana: texto`, also 12-hour `2:05 p. m.` and `PM`) and iOS (`[24/10/26, 14:05:33] Ana: texto`), Spanish and English, with the invisible direction marks iOS adds. Multi-line messages are joined. Lines that are not part of any message, or with an impossible date, are skipped and counted.
- Date order: day-first unless the file proves month-first (a field above 12) or uses English `AM/PM` while ambiguous. Override with `--date-order`.
- Time zone: exports carry local phone time; it is read in `TIMEZONE` (America/Argentina/Buenos_Aires) and stored as UTC.
- Placeholders: `<Multimedia omitido>`, `imagen omitida`, `<Media omitted>`, `<adjunto: ...>`, `IMG-... (archivo adjunto)` become `media` with an empty text (or the caption). "Se eliminó este mensaje" and "You deleted this message" become deleted. `<Se editó este mensaje>` marks edited. Group and system lines are stored as `system`.
- Ids are a SHA-256 of chat, UTC time, sender, text, kind and the ordinal of identical lines, so re-importing the same or a longer overlapping export adds only the new messages. A message edited or deleted after the first export appears as a new row in a later export.
- Imported chats get a synthetic JID `import:<chat-name-slug>`; they are not merged with the same chat synced by the bridge (different JID).

## Baileys bridge

### Package

`baileys@7.0.0-rc14` (pinned exactly), the project's current npm name (`@whiskeysockets/baileys` publishes the same build). MIT license, last published 2026-07-29, Node 20+. Not affiliated with WhatsApp. It is the `latest` tag but a release candidate; the stable-tagged `6.7.24` depends on a Git-hosted `libsignal`, which is worse for supply-chain pinning, so 7.x was chosen. Direct dependencies: `@cacheable/node-cache`, `@hapi/boom`, `async-mutex`, `libsignal`, `lru-cache`, `music-metadata`, `p-queue`, `pino` 9, `protobufjs`, `whatsapp-rust-bridge` (pinned 0.5.4) and `ws`: about 42 packages added in total. The peer `sharp` is not optional in its metadata, so pnpm installs it with its prebuilt binaries; it is only used to make thumbnails when sending media, which this project never does. Lifecycle scripts of `baileys` (a Node version check) and `protobufjs` stay blocked by pnpm.

### Running it

The bridge is its own process (`dist/whatsapp-bridge.js`, built by `pnpm build`; `tsx src/whatsapp-bridge.ts` in development) so a WhatsApp problem cannot take the assistant down.

| Variable | Notes |
| --- | --- |
| `WHATSAPP_ENABLED` | Must be exactly `true`. Otherwise the process records status `disabled` and idles. |
| `TOKEN_ENCRYPTION_KEY` | Required: the session is stored encrypted. Without it the bridge idles. |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Optional, for rotation; session rows are rewrapped on start. |
| `DATA_DIR` | Same database and data directory as the server. The lock file `whatsapp-bridge.lock` lives here. |
| `LOG_LEVEL` | Default `info`. Baileys itself is capped at `warn`. |

Pairing (done by the owner later, nothing is connected yet): start the bridge, and while status is `pairing` the encrypted QR is available through `WhatsAppStatusSource.pairingCard()` (a `pairing` card). Scan it from WhatsApp, Linked devices. Pairing by phone-number code is not implemented. One QR session is offered per start; if it expires the bridge stops instead of generating more.

Session, events and history:
- Credentials and Signal keys are stored in `wa_auth_state`, each value AES-256-GCM encrypted. A restart does not need a new pairing.
- `messages.upsert`, `messages.update` (edits, revokes), `messages.delete` (per message), `messaging-history.set`, chat, contact and group name events are handled. Messages are deduplicated by `(chat_jid, id)`, so history replays and reconnections never duplicate. When WhatsApp gives both the LID and the phone-number form of a chat, the phone-number form is used. Statuses, broadcast lists and newsletters are ignored. Clearing a whole chat on the phone does not delete the archive; deleting a message for everyone does.
- Media is never downloaded; media messages are stored as `media` with their caption.
- Status: `integrations_status` shows `baileys` (disabled, pairing, connected with a live heartbeat, disconnected, needs action after logout, error) and `import` with coverage. A bridge that stops updating its heartbeat for 3 minutes is shown as disconnected.

## Anti-ban measures and residual risk

The owner accepts the risk of using an unofficial client on the main number and asked to minimize the chance of a restriction. Each choice below is enforced in code and covered by tests with fixtures.

1. Sends only on the owner's request. Since 2026-11-23, at the owner's request, `whatsapp_send` goes out directly when the owner asks clearly. After the turn read third-party content (a chat, a mail), it stops at a confirmation card like every state-changing tool; that rule lives in the runner. The text goes to `wa_outbox` and the bridge sends it as a plain text, one message at a time, polling every 3 s while connected. Delivery is at most once: a message is claimed before the socket call, and one interrupted by a crash becomes `unknown` and is never retried. The recipient is resolved before the card is shown (id, phone number, or name ignoring case, accents and extra spaces; among chats sharing a name the only one with messages wins), so the card holds the exact chat id that will be used; an unknown or ambiguous name returns the closest chats with their ids for the owner to pick. Imported chats are refused, and no card is offered while the bridge is disconnected. A test fails if the bridge has more than one `sendMessage` call or any receipt, presence, read-marking or history-request API name. Sending raises the restriction risk compared with read-only use, so it should stay occasional and conversational.
2. No read receipts. `readMessages` and receipt APIs are never called, so contacts never see blue ticks caused by the assistant. Baileys still sends the low-level delivery acknowledgements and decryption retry requests every linked device must send to receive messages; those cannot be switched off.
3. No presence. `markOnlineOnConnect: false`; no `available`, `composing` or subscription calls. Baileys itself announces `unavailable` once per connection (the quiet state, so the phone keeps receiving notifications); that is the only presence traffic.
4. Single instance. An exclusive lock file refuses a second bridge process (stale locks from dead processes are taken over). Two sessions fighting over one account is the classic trigger of reconnect loops.
5. Conservative reconnection. Exponential backoff from 5 s doubling to a 5 minute ceiling, with jitter in the upper half of each window, at most 8 consecutive attempts. The counter resets only after the connection has stayed open for 2 minutes, so open-then-drop flapping still hits the cap. After the cap the bridge stops and waits for the owner.
6. Stop, do not retry, when WhatsApp says so. `loggedOut` (401) and `badSession` (500) stop the bridge and wipe the stored session so the next start begins a clean pairing; `connectionReplaced` (440), `forbidden` (403) and `multideviceMismatch` (411) stop it and keep the data for inspection. A QR that expires unscanned stops the bridge: no endless pairing attempts. Only `restartRequired` (515, expected right after pairing) reconnects fast (1 to 2 s).
7. Terminal states idle instead of exiting, so a process supervisor with a restart policy cannot turn a stop into a reconnect storm. After a normal start the bridge also waits 15 to 25 s before its first connection, which bounds the rate of a crash loop.
8. No repeated history requests. `syncFullHistory: false`, `shouldSyncHistoryMessage` rejects `FULL` and `ON_DEMAND`, and `fetchMessageHistory` is never called. The only history is what the phone sends once when pairing; a later restart does not ask again.
9. Stable identity. Fixed `browser` (`Ubuntu`, `Chrome`, `22.04.4`), fixed `countryCode: AR`, the WhatsApp Web version pinned by the library (no per-start version lookup), persisted credentials. The linked device looks like the same single browser every time.
10. Minimal activity. Statuses, broadcasts and newsletters are ignored (`shouldIgnoreJid`), no media downloads, no link previews, no group metadata sweeps, no own-action events, logs capped at warn and never containing message text, names or QR data.

Residual risk, honestly stated:
- WhatsApp's terms do not allow unofficial clients. Baileys speaks a reverse-engineered protocol; WhatsApp can restrict or ban a number whatever the client does, and nothing here can guarantee otherwise. A ban affects the main number, not only the assistant.
- It is a release candidate library tracking an undocumented protocol: expect breakage and library updates. Upgrade deliberately, not automatically.
- Linked devices are logged out by WhatsApp if the phone stays offline for about 14 days; the bridge then reports `logged_out` and the owner has to pair again.
- Pairing and re-pairing are the most scrutinized actions. Pair once, keep the phone online and the bridge running, and avoid repeated unlink and link cycles.
- The chat-export importer carries none of this risk and remains the fallback if the bridge is stopped. If the number is ever restricted, stop the bridge (`WHATSAPP_ENABLED` unset), keep using imports, and follow WhatsApp's appeal flow.

## Validation status

Importer, search tools, event handlers, reconnection policy, auth state and status are implemented and tested with synthetic fixtures (`fixtures/synthetic/whatsapp`). The bridge has never connected to WhatsApp: pending owner pairing. Re-run the manual checks (pairing card, first history sync, reconnection after a network drop) when the owner pairs.

## Reading whole chats

Paging 50 messages at a time cannot cover a group: BBG alone has about 15,000 messages. `whatsapp_study` reads up to 8 chats in the background instead (`integrations/whatsapp/chat-study.ts`, table `wa_studies`, migration 9).

1. The text messages of each chat, oldest first, become lines `[date time] Name: text`, each clipped to 600 characters.
2. The lines are cut into blocks of 40,000 characters, never splitting a message.
3. Each block goes to the summary model (`CLAUDE_SUMMARY_MODEL`, Haiku) through `runtime.complete`, with no tools and no session. It returns notes on people, humor, topics, dated moments, and the owner's role.
4. One more call merges the notes into a profile of at most 40 lines per chat.
5. When the batch ends, the chat gets a notice and a push without content.

Details:
- Reading runs in the server process, one chat at a time with a short pause between calls. Notes are saved after every block, so a restart resumes where it stopped (`resume()` at boot).
- `whatsapp_study_result` returns the profiles as untrusted content. Saving anything to memory afterwards needs the owner's confirmation card, and the assistant asks what to keep first.
- Cost: about 11k input tokens per block plus one merge per chat. All synced text, about 2.7 million characters, is roughly 70 blocks.
- Delegated agents never get chats; this stays on the personal side.

## Voice notes

`whatsapp_voice_note` sends a voice note in JARVIS's voice that arrives like a fresh recording (microphone, waveform, duration), not like an audio file.
- The model writes what JARVIS says. The server refuses a note that does not open by naming JARVIS and the owner («Hola Carme, soy Jarvis, el asistente de Loren…»), so whoever listens knows it is the assistant's voice.
- It goes out directly when the owner asks clearly, or after the confirmation card when the turn read third-party content. The audio is only made at that point.
- `voice/voice-note.ts` narrates with the call voice and effect through the same `Narrator` as the videos (ElevenLabs `/with-timestamps`, cached under `DATA_DIR/voice-notes/cache`). ffmpeg then encodes it as mono Opus at 48 kHz in Ogg, saved as an attachment of type `audio/ogg; codecs=opus`.
- The outbox entry has no text, so the bridge sends only the audio with `ptt: true`. Baileys computes the duration with `music-metadata`.

## «Abajo» alerts and @jarvis

`WhatsAppWatcher` (`apps/server/src/integrations/whatsapp/watcher.ts`) runs in the server every 4 seconds. It reads the messages the bridge stored since its last look; its cursor lives in `wa_watch_state`, and the first look ever starts from now. Messages older than 10 minutes, such as history syncs, are skipped. It only watches private chats and the groups where the owner wrote in the last 30 days.

- **«Abajo»:**
  - Detection uses rules, with no model and no tokens. The text is lowercased, without accents and with repeated letters collapsed; then a word within one letter of «abajo» counts («ABAJOOO», «abajao», «abjo», «abaj»).
  - It only alerts on a message of up to six words, or one with an arrival phrase («estoy abajo», «te espero abajo»), so «mirá el link de abajo» stays quiet.
  - The push says who («Marti está abajo», plus the group when it comes from one), at most once per person every 10 minutes.
- **@jarvis:**
  - Anyone in a watched chat, the owner included, can call Jarvis with «@jarvis».
  - The model (`CLAUDE_MODEL`, low effort, no tools) reads the last 25 messages of that chat and answers in it, short and sarcastic. The answer starts with 🤖, and Jarvis never answers a message that starts with it.
  - It knows nothing else of the owner's and treats the chat as data: it cannot leak anything or act.
  - Limits, so a chat cannot burn the owner's quota: one answer every 15 seconds, 3 an hour per chat (`WHATSAPP_REPLIES_PER_HOUR`), 60 a day in all. A call beyond the limit goes unanswered.
  - `WHATSAPP_AUTO_REPLY=off` in `jarvis.env` turns the answers off; the alerts stay.
