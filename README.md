<p align="center">
  <img src="assets/brand/banner.svg" alt="J.A.R.V.IS — a private, voice-first personal assistant powered by Claude" width="100%">
</p>

# J.A.R.V.IS

A private, voice-first personal assistant powered by Claude, with conversational memory, messaging integrations, reminders, and a cinematic web interface.

The interface is a single conversation, by text or voice. There are no dashboards: you ask "¿Qué tengo mañana?", "¿Qué dijo Fran del partido?" or "Recordame pagar esto el viernes" and the assistant uses its tools to answer. It is built for exactly one owner, runs entirely in the cloud, and is designed to later drive a small Wi-Fi speaker (M5Stack ATOM Echo).

> Personal project. Not affiliated with Marvel, Disney or Anthropic. The code is public; any deployment requires authentication and holds the owner's data privately.

## Status

Status vocabulary: *implemented*, *tested with fixtures*, *validated with real service*, *pending owner connection*, *pending hardware*.

| Area | Status |
| - | - |
| Claude runtime via the official Agent SDK on the owner's subscription | validated with real service (local login), see [docs/claude-runtime.md](docs/claude-runtime.md) |
| Sessions resumed by explicit id, cancellation, quota and auth errors | validated with real service; quota paths tested with fixtures |
| Memory with provenance, audit trail and forgetting | tested with fixtures |
| Backend tool policy (allowlist, confirmations after untrusted content, idempotent writes) | tested with fixtures |
| WebSocket protocol, owner login, origin checks | tested with fixtures |
| Agenda, agreements, reminders worker, Web Push | in progress |
| Gmail (personal and work), WhatsApp (read-only), YouTube | in progress |
| Voice pipeline (STT, streaming TTS, interruption) | in progress |
| Conversational PWA with animated core | in progress |
| Docker, TLS, backups, CI, costs | in progress |
| Device gateway, simulator and ATOM Echo firmware | planned, pending hardware |

## Architecture

```
 Browser PWA ─┐                         ┌─ Claude Code (Agent SDK subprocess, owner's subscription)
              │ WSS /ws  (cookie)        │      └─ in-process MCP server "jarvis" (per turn)
 ESP32 device ┤ WSS /ws/device (token)   │
              ▼                          │
          Caddy (TLS) ──► server (Fastify) ──► SQLite (WAL, FTS5)  ◄── worker (reminders, outbox, Web Push)
                               │                                   ◄── whatsapp-bridge (optional)
                               ├─► STT provider (swappable)
                               └─► TTS provider (swappable)
```

- **Monorepo** (pnpm, Node 24, TypeScript): `packages/contracts` (shared zod schemas), `apps/server` (Fastify, SQLite, Agent SDK), `apps/web` (React + Vite PWA).
- **One SQLite database** (WAL, FTS5) is the source of truth for conversations, memories, agenda, agreements, reminders and messages. Claude session files are only a resumable cache.
- **Claude** runs as the unmodified Claude Code binary through the Agent SDK, authenticated with the owner's subscription. Each turn gets a strict allowlist of tools served by an in-process MCP server; no shell, no filesystem, no web fetch.
- **Reminders** are delivered by an independent worker with an outbox, so they keep working when Claude is unavailable or out of quota.

Details: [docs/architecture.md](docs/architecture.md).

## Setup

A step-by-step installation guide in Spanish is in [docs/setup.es.md](docs/setup.es.md) (in progress). Development quick start:

```bash
nvm use 24
pnpm install
cd apps/server && pnpm -s hash-password   # prints an scrypt hash for OWNER_PASSWORD_HASH
RUNTIME=scripted OWNER_PASSWORD_HASH='<hash>' DATA_DIR=../../data pnpm dev
pnpm check                                 # lint, typecheck, tests, build
```

`RUNTIME=scripted` uses a deterministic fixture instead of Claude. With `RUNTIME=claude` (default) the server uses your local Claude Code login, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on a server.

## Privacy

- Single owner. Password login with server-side sessions; anonymous access is rejected.
- Emails, chats and web pages are treated as untrusted data. After a turn reads them, any change to memory, agenda or reminders needs the owner's explicit confirmation in the UI, enforced in the backend.
- OAuth tokens stay inside adapters, encrypted at rest with a separate key, and never reach the model's context.
- Message bodies, audio and tokens are not logged. Raw audio is not stored after transcription.
- The repository never contains the real profile (`loren.md`), databases, sessions, recordings, voice datasets or weights. Only `assistant/loren.example.md` with fictitious data is public.

## Roadmap

1. Chat with Claude, memory and persistent sessions.
2. Two-way voice, personality, follow-up listening and interruption.
3. Gmail, WhatsApp, agenda, agreements and reminders.
4. Animated PWA, notifications and YouTube.
5. Deployment, backups, recovery, costs and real-service tests.
6. Physical device.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: see `SECURITY.md`.

## License and attributions

MIT, see [LICENSE](LICENSE). Brand assets are original work, see [assets/brand/README.md](assets/brand/README.md). "Claude" is a trademark of Anthropic; this project only states that it uses Claude. JARVIS is a character owned by Marvel; this project is an unaffiliated personal homage.
