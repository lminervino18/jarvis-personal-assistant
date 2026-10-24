---
name: jarvis-integrations-core
description: Builds J.A.R.V.IS agenda, agreements, contacts, reminders, the durable reminder worker with outbox, and Web Push notifications.
---

You are role B1 (agenda, reminders, notifications) for J.A.R.V.IS. Follow `.claude/agents/_shared.md`.

## Owned paths

- `apps/server/src/agenda/**` (stores for contacts, calendar events, agreements, reminders)
- `apps/server/src/tools/{contacts,calendar,agreements,reminders}-tools.ts`
- `apps/server/src/worker.ts` and `apps/server/src/worker/**`
- `apps/server/src/push/**`
- `apps/server/scripts/generate-vapid-keys.ts`

The schema already exists in migration 001 (`contacts`, `contact_aliases`, `contact_identities`, `agreements`, `agreement_parties`, `agreement_events`, `calendar_events`, `reminders`, `outbox`, `push_subscriptions`). Request schema changes instead of editing migrations.

## Tools to implement (inputs are fixed in `toolInputs`)

- `contacts_resolve`: normalized alias lookup (accents, case, nicknames). Return all candidates with display name, aliases and identities. Two or more plausible people → `ok` with several items and a `note` telling the model to ask before any action; never merge people.
- `calendar_list`, `calendar_create`, `calendar_update`: the internal agenda is the source of truth (no external provider yet). Store UTC plus IANA zone; expand RRULE occurrences inside the requested range in the event's zone. Emit `event` cards on create/update. `describe()` for confirmation cards.
- `agreements_list`, `agreements_propose`, `agreements_confirm`, `agreements_cancel`: states proposed → confirmed | cancelled, audit in `agreement_events`, parties via `agreement_parties`. Confirming requires an existing proposed agreement. A proposal never becomes confirmed implicitly.
- `reminders_create`, `reminders_list`, `reminders_update`, `reminders_cancel`: dedupe near-identical active reminders (same normalized text and due within 60 s returns the existing one), emit `reminder` cards, `sensitive` flag.

Register them in `apps/server/src/tools/index.ts`.

## Worker (`src/worker.ts`, separate process)

- Never imports the Claude runtime. Reminders must fire with Claude down or out of quota.
- Loop: claim due reminders in a transaction (`BEGIN IMMEDIATE`), write outbox rows with a unique `dedupe_key` (`reminder:<id>:<due_utc>`), then advance recurring reminders to their next occurrence or mark one-off reminders `fired`.
- Downtime policy: on start, overdue reminders within a grace window (`REMINDER_GRACE_MINUTES`, default 360) fire once marked late; older ones become `missed` and produce a single digest notification. Document it.
- Outbox dispatcher: leases (`locked_until_utc`) so two worker instances or a restart never double-send, bounded retries with exponential backoff (max 6), `dead` after that, prune subscriptions on 404/410.
- Chat delivery: insert a `system` message into the most recently active conversation for each fired reminder. Add a small server-side feed (`src/push/live-feed.ts`) that polls new `system` messages without a turn id every ~2 s and emits them through `ConversationHub` as `history` items.

## Web Push

- `web-push` with VAPID keys from env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`), plus a script that prints a new key pair.
- Wire `onPushSubscribe` and `pushPublicKey` in `main.ts`. Validate endpoint URLs (https, known push services are fine; reject private hosts).
- Notifications are discreet: title "J.A.R.V.IS", body is the reminder text unless `sensitive`, in which case "Tenés un recordatorio."; never include work email content. Tag by reminder id.
- Add an `IntegrationStatusSource` for push and reminders.

## Tests (fixtures only)

Create, modify and cancel reminders; dedupe; recurrence across DST-free and zone math; two concurrent workers fire once; restart recovery; overdue grace vs missed digest; dispatcher retry/backoff/dead with a fake sender; 410 prunes the subscription; reminders fire while the runtime is unavailable (worker test does not construct any runtime); agreements never auto-confirm; ambiguous nickname returns multiple candidates.
