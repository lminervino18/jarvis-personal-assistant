# @jarvis/web

Conversational PWA for J.A.R.V.I.S.: React 19 + Vite. The interface is only the conversation (text and voice), an animated core and small cards inside the thread.

## Development

```
pnpm --filter @jarvis/server dev   # backend on :8080
pnpm --filter @jarvis/web dev      # Vite on :5173, proxies /api and /ws to :8080
```

Open `http://localhost:5173/?demo` for demo mode: a scripted server with fictitious data, no backend and no login. It is used for the screenshots in `assets/screenshots/`.

`@fastify/static` registers the files that exist when the server starts, so restart the server after rebuilding `dist` when serving it with `WEB_DIST_DIR`.

## Structure

- `src/protocol`: WebSocket client (hello/ready, `seq` check, backoff reconnection that resumes the conversation, ping liveness) and the audio turn gate that drops stale speech frames.
- `src/conversation`: thread reducer (merge by message id), derived assistant state and `Session`, the controller that joins protocol, thread, microphone and playback.
- `src/audio`: PCM conversion, energy VAD, voice loop (pre-roll, listening window, barge-in), gapless playback scheduler, Web Audio engine and the capture worklet.
- `src/core`: the animated core (Canvas 2D).
- `src/cards`, `src/ui`: cards, thread, composer, login.
- `public/sw.js`: app shell cache and push handler. Push payload is `{ title, body, tag, url }`.
- Gmail connection: the connector redirects back with `?integration=gmail&status=connected|error&label=...&reason=...`; `main.tsx` reads it, cleans the URL and the session shows an integration card once the conversation has loaded.
- Pairing cards: a raw `qr` payload is encoded on the device with `qrcode-generator` (MIT, no dependencies) into an inline SVG; it is never sent anywhere. A `data:image/` QR is shown as is.

## Voice

- Capture: `getUserMedia` with echo cancellation, noise suppression and auto gain, an AudioWorklet that downsamples to 16 kHz mono s16le and posts 20 ms frames.
- Voice activity: `EnergyVad` with an adaptive noise floor, hysteresis (start +14 dB, stop +8 dB over the floor), 160 ms minimum speech, 900 ms end silence and a 300 ms warm-up that measures the room. While the assistant speaks, a stricter instance (+24 dB, 300 ms) decides about barge-in so its own echo does not cut it off.
- Playback: PCM chunks are scheduled back to back at the negotiated rate; an analyser node feeds the core. Cutting stops every scheduled source immediately and the turn is blacklisted in the gate.
- Silero VAD (`@ricky0123/vad-web`) was evaluated on paper and not adopted yet: it needs ONNX Runtime Web (WASM, several MB), the server CSP has no `wasm-unsafe-eval`, and there is no real speech corpus to compare against (no personal audio in the repository). The energy VAD is covered with synthetic levels only. Revisit after testing on real hardware; `VoiceLoop` already isolates the detector behind `push(frame)`.

## Measurements (Chrome desktop, dpr 1, 307 px canvas, idle core)

- 60.0 fps, frame interval p50 16.7 ms, p95 16.8 ms over 240 frames.
- AudioWorklet in Chrome under the server CSP: 48 kHz input produced 320-sample frames at about 49 frames/s; a 0.5 amplitude sine measured 0.35 RMS after conversion.
- Safari and iPhone are not measured yet.
