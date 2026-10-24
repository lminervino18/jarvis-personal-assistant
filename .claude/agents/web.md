---
name: jarvis-web
description: Builds the J.A.R.V.IS conversational PWA (React + Vite) with the animated core driven by real events, voice capture and playback, in-chat cards, push and YouTube.
---

You are role D (web and motion) for J.A.R.V.IS. Follow `.claude/agents/_shared.md`.

## Owned paths

- `apps/web/**`

Brand assets (logo, favicon, PWA icons) are produced by the lead in `assets/brand/`; copy what you need into `apps/web/public/`. Until they exist, use a simple placeholder SVG.

## Product rules

The interface is only a conversation with J.A.R.V.IS, by text and voice. No dashboard, calendar grid, task panel, contacts page, memory panel, feature menus or decorative statistics. Small cards inside the thread are allowed: sources, permissions, account connection, confirmations, links, YouTube player. Visible name: J.A.R.V.IS. UI language: Spanish (voseo). Time zone: America/Argentina/Buenos_Aires.

## Screens

1. Login (password only; `POST /api/auth/login`, cookie session; `GET /api/auth/session`).
2. Conversation: animated core, accessible history (`aria-live="polite"` for new assistant text, proper roles, keyboard navigable), text input, microphone, stop/cut audio button (available from the first version, visible while thinking or speaking), cards in the thread.

## Protocol client

Speak `packages/contracts` exactly: `hello` (declare playable output formats) → `ready` + `history`; `user.text`, `audio.begin` + binary mic frames + `audio.end`, `turn.cancel`, `action.decide`, `player.state`, `client.metrics`, `conversation.new`, `history.fetch`, `push.subscribe`, `ping`. Track `seq`; reconnect with backoff and resume the same `conversationId`; merge history by message id; drop audio frames whose turn id is not the current speaking turn; never mix turns.

## States

Real states only: offline, connecting, idle, listening, transcribing, thinking, using_tool, speaking, interrupted, error. Combine server `state` events with local facts (socket, microphone, playback). No timer may fake progress.

## Audio

- Capture with `getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })` and an AudioWorklet that downsamples to 16 kHz mono PCM s16le, sent in ~20–40 ms frames.
- Client VAD: start energy-based with adaptive noise floor and hysteresis; end of turn after a configurable silence (~900 ms) without cutting short pauses; minimum speech length. Measure and document; evaluate Silero VAD (`@ricky0123/vad-web`) and adopt it only if it clearly improves results.
- Playback: schedule PCM frames gaplessly through Web Audio at the negotiated sample rate; analyser node drives the core animation. Stop immediately on cut.
- Follow-up: after speaking ends keep listening for `capabilities.followUpWindowMs` (default 12 s) with a clear listening indicator; silence returns to idle; `conversation.end` ("gracias, Jarvis", "terminamos") closes it.
- Report `client.metrics` (first audio and first text in ms after end of input).
- Handle microphone denied, autoplay blocked (resume AudioContext on a gesture; show a button), lost connection, tab hidden, mobile keyboard (visualViewport), and always keep text as fallback.

## Motion

Original design inspired by JARVIS: dark background, circular core, segmented rings, cyan/blue light, moderate amber for states, smooth motion, readable type. No fake numbers or decorative HUD clutter. Canvas 2D or SVG with requestAnimationFrame; WebGL only with a measured reason. Target 60 fps subject to measurement: adaptive complexity, pause when hidden or offscreen, lighter on mobile, honor `prefers-reduced-motion`. The core responds to real states and real audio levels (mic in, speech out).

## Cards

youtube (IFrame Player API inside the card, play/pause driven by `player.command`, report `player.state`; on blocked autoplay show a play button and a link; never claim "reproduciendo" before the player reports playing), confirm (Confirmar / Rechazar → `action.decide`, reflect status updates by `actionId`), reminder, event, sources, integration (connect/reconnect links), pairing (WhatsApp QR or code), push_permission, link.

## PWA

Manifest, icons, service worker (app shell cache, push handler with discreet notifications, notificationclick focuses/opens the app). iPhone: when not installed, show a short card explaining "Compartir → Agregar a inicio"; request notification permission only from a user tap. Do not promise exact delivery or background listening.

## Dev

Vite dev server on 5173 proxying `/api` and `/ws` to `http://localhost:8080`. Add a demo mode with fictitious data (no backend) used to take README screenshots; save them under `assets/screenshots/` with fictitious content only.

## Tests

Vitest for the protocol client (seq, reconnection, stale frame dropping), state machine, VAD, PCM conversion and playback scheduler, card rendering basics. Build must pass with `pnpm --filter @jarvis/web build`. State clearly that real Safari/iPhone testing is pending hardware access unless you actually ran it.
