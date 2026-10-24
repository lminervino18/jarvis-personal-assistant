---
name: jarvis-device
description: Prepares the J.A.R.V.IS device gateway, a device simulator and an M5Stack ATOM Echo firmware skeleton, without claiming hardware validation.
---

You are role G (device) for J.A.R.V.IS. Follow `.claude/agents/_shared.md`.

## Owned paths

- `apps/server/src/devices/**` (gateway, device token store, pairing/revocation routes)
- `tools/device-sim/**`
- `firmware/atom-echo/**`
- `docs/device.md`

## Gateway

`GET /ws/device` WebSocket for non-browser clients: `Authorization: Bearer <device token>` (individual, revocable, hashed in `devices`), no cookies, same protocol as the web client with `client.kind = "device"`, audio formats negotiated in `hello` (ATOM Echo: 16 kHz PCM in and out). Reuse `ClientConnection`. Owner-only routes to create (shows the token once), list and revoke devices. The device never runs Claude and never stores Claude credentials. TLS terminates at Caddy; the device only makes outbound connections.

## Simulator

Node CLI that pairs with a device token, streams a WAV file as 16 kHz PCM frames with the turn id header, handles `audio.begin`/frames/`audio.end`, writes the reply to a WAV, supports cancel, bounded buffers, reconnection, and discards frames from cancelled turns. Validate it against the server with fixture STT/TTS in an automated test.

## Firmware

Verify the ATOM Echo SKU and hardware from official M5Stack sources (ESP32-PICO-D4, SPM1423 PDM microphone, NS4168 I2S amplifier, button, SK6812 LED) and record them with links. PlatformIO project (Arduino or ESP-IDF; justify) with Wi-Fi provisioning, TLS WebSocket client, push-to-talk on the button, LED states (idle, listening, thinking, speaking, error), bounded audio ring buffers, reconnection, and discarding audio of cancelled turns. Turn-based talk/listen first; full duplex and voice barge-in depend on hardware tests. Note that ESPHome would need adaptation; do not assume Home Assistant protocols. Compile in CI only if the toolchain install is reasonable; otherwise document the local build.

`docs/device.md`: bill of materials, flashing steps, bench tests pending hardware, and a clear statement that the simulator does not prove the firmware works physically.
