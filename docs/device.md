# Device: gateway, simulator and ATOM Echo firmware

Status in one line: the server gateway and the simulator are implemented and tested with fixture voice providers. The firmware is a skeleton that was written and compiled without the hardware. **Nothing about the physical device has been validated; the hardware has not been purchased.**

## What is validated and what is not

| Piece | Status |
| --- | --- |
| Device token store, pairing routes, `GET /ws/device` | tested with fixtures (real Fastify server, automated) |
| `tools/device-sim` against the real server (full voice turn, cancel, reconnection, revocation) | tested with fixtures (automated, fixture STT/TTS, scripted runtime) |
| Firmware compiles with PlatformIO | see "Build" below for the exact result |
| Firmware logic that has no hardware dependency (frame header, turn gate, message builders) | tested on the host with `g++` |
| Wi-Fi, TLS, PDM microphone, NS4168 speaker, LED, button, memory use, latency | **pending hardware** |
| Real STT/TTS/Claude through the device | pending owner connection |

The simulator speaks the same protocol as the firmware but runs on Node. It proves that the server side of the protocol works for a non-browser client with a bearer token and 16 kHz PCM. It does **not** prove that the firmware works: it exercises no I2S driver, no PDM decoding, no Wi-Fi or mbedTLS stack, no flash storage, no RAM limits and no timing of a real ESP32. Every row marked pending hardware stays pending until the bench tests below are run on a real board.

## Hardware

Sources, retrieved 2026-10-25:

- M5Stack documentation page: <https://docs.m5stack.com/en/atom/atomecho>
- Official repository and examples: <https://github.com/m5stack/ATOM-ECHO> (MIT, last push 2022-07-19), in particular `examples/Factory_Test/Factory_Test.ino`
- Shop page <https://shop.m5stack.com/products/atom-echo-smart-speaker-dev-kit>: not verified, the request returned HTTP 429.

Naming and SKU. The GitHub repository and the pre-existing name are "ATOM ECHO". The current docs page at the `atomecho` URL is titled **"Atom Voice"** and lists **SKU C008-C**; it does not say the product was renamed or discontinued. Before buying, confirm that the shop listing matches the docs page (SKU C008-C, ESP32-PICO-D4, SPM1423, NS4168). I could not confirm whether an older "C008" revision has the same pins.

| Item | Value | Source |
| --- | --- | --- |
| SoC | ESP32-PICO-D4, dual core 240 MHz, Wi-Fi 802.11 b/g/n, BLE 4.0 | docs page |
| Flash | 4 MB | docs page |
| Microphone | SPM1423, PDM | docs page |
| Speaker amplifier | NS4168, I2S, speaker 0.8 W | docs page |
| RGB LED | SK6812, data on G27 | docs page, HMI table |
| Button | programmable, input on G39 | docs page, HMI table |
| I2S speaker data (NS4168 DATA) | G22 | docs page, `Factory_Test.ino` (`CONFIG_I2S_DATA_PIN 22`) |
| I2S speaker bit clock (NS4168 BCLK) | G19 | docs page, `Factory_Test.ino` (`CONFIG_I2S_BCK_PIN 19`) |
| I2S word clock (NS4168 LRCK) and PDM microphone clock (SPM1423 CLK) | G33 (same line) | docs page, `Factory_Test.ino` (`CONFIG_I2S_LRCK_PIN 33`) |
| PDM microphone data (SPM1423 DATA) | G23 | docs page, `Factory_Test.ino` (`CONFIG_I2S_DATA_IN_PIN 23`) |
| Grove port (HY2.0-4P) | GND, 5 V, G26, G32 | docs page |
| Reserved pins | G19, G22, G23, G33 are used by the internal audio I2S | docs page |
| Size / weight | 24.0 x 24.0 x 16.8 mm, 9 g | docs page |

The docs page flattens its pin tables, so the pairing of signal to GPIO above comes from combining the page with the official `Factory_Test.ino`, which configures `driver/i2s.h` with exactly these numbers.

Not found in the official sources and therefore **not verified**: supply voltage and current limits, the USB-serial bridge chip, and whether the board enters download mode automatically when flashing (see bench test 1).

Constraint that shapes the firmware: the official example reinstalls the I2S driver to switch between PDM microphone (RX) and speaker (TX) on the same port, and both use pin G33 as clock. The firmware is therefore **half duplex**: listen, then think, then speak. Full duplex and voice barge-in depend on bench tests and are out of scope for this skeleton. Barge-in is a button press that cancels the turn.

### Bill of materials

| Qty | Item | Note |
| --- | --- | --- |
| 1 | M5Stack ATOM Echo / Atom Voice (SKU C008-C per the current docs page) | confirm the listing before ordering |
| 1 | USB cable with data lines for the ATOM's USB connector | charge-only cables cannot flash |
| 1 | 5 V USB power supply | rating not published by M5Stack; use a 5 V / 1 A or better supply and watch for brownouts (bench test 11) |
| 1 | Wi-Fi 2.4 GHz network reachable from the board | the ESP32 has no 5 GHz |

Prices are not listed on purpose: they were not verified.

## Server side

Device tokens are random 256-bit values, shown once on creation. Only the SHA-256 is stored in the `devices` table. The owner creates, lists and revokes devices with the same session cookie used by the web client (the routes check the `Origin` header like every other mutating `/api/` route).

```sh
read -rs PASSWORD
ORIGIN=https://jarvis.example.com
curl -c jar.txt -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "$ORIGIN/api/auth/login"
curl -b jar.txt -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  -d '{"name":"ATOM Echo salon"}' "$ORIGIN/api/devices"
curl -b jar.txt "$ORIGIN/api/devices"
curl -b jar.txt -H "Origin: $ORIGIN" -X POST "$ORIGIN/api/devices/<id>/revoke"
```

`POST /api/devices` returns `{id, name, createdAt, token}`; copy the token immediately, it is never returned again. Revoking closes the open socket at once (close code 4001) and the token stops authenticating.

`GET /ws/device` upgrades only with `Authorization: Bearer <token>`. It never reads cookies and does not require `Origin`, since browsers cannot set that header on WebSockets. It reuses `ClientConnection`, so the protocol is identical to the web client: `hello` with 16 kHz PCM in and out, `audio.begin`, binary frames `[kind:1][turnId:16 raw bytes][PCM]`, `audio.end`, `turn.cancel`, and the server's `audio.begin`, binary frames, `audio.end`, `turn.end`. The upgrade endpoint is rate limited to 30 attempts per minute per address. `last_seen_at` is updated on each successful connection. TLS terminates at Caddy; the device only makes outbound connections and never holds Claude credentials.

## Simulator

`tools/device-sim` (`@jarvis/device-sim`) behaves like the firmware at the protocol level: bearer WebSocket, 16 kHz mono PCM both ways, one active turn, frames from any other turn dropped, a bounded reply buffer, bounded outbound buffering, application heartbeat and reconnection with exponential backoff. A rejected token (HTTP 401) or a revoked device (close code 4001) stops retrying. The token is only sent over `wss://` (or `ws://` to localhost; `--insecure` overrides).

```sh
JARVIS_DEVICE_TOKEN=<token> pnpm --filter @jarvis/device-sim start -- \
  --url wss://jarvis.example.com/ws/device --tone 2 --out reply.wav
JARVIS_DEVICE_TOKEN=<token> pnpm --filter @jarvis/device-sim start -- \
  --url wss://jarvis.example.com/ws/device --wav question.wav --cancel-after-ms 800
```

The input WAV must be mono 16-bit PCM at 16 kHz; `--tone <seconds>` synthesizes a sine instead, so no real voice material is needed. The reply is written as a 16 kHz WAV. The token is read from the environment, not from arguments, so it does not appear in the process list.

Automated tests: `pnpm --filter @jarvis/device-sim test` (WAV handling, protocol behavior against a scripted fake server) and `pnpm --filter @jarvis/server test` (`src/devices/device-sim.test.ts` runs the simulator against the real server with fixture STT/TTS and the scripted runtime).

## Firmware

Skeleton in `firmware/atom-echo/`. See "Build" and "Flashing" below.

### Arduino or ESP-IDF

The skeleton uses PlatformIO with the **Arduino** framework (arduino-esp32 core 2.0.x, which wraps ESP-IDF 4.4). Reasons: every official ATOM Echo example (`Factory_Test`, `EchoSTT`) is Arduino with the legacy `driver/i2s.h`, so the pin and PDM setup can be compared line by line; `WiFi`, `Preferences` (NVS) and `neopixelWrite` are available with no extra libraries; and the ESP-IDF `esp_websocket_client` (Apache-2.0, TLS, custom headers, binary frames) is already linked into that core, so no WebSocket library with a copyleft license is needed. The cost: the core pins an older IDF (no `crt_bundle_attach` in the WebSocket config, legacy I2S driver) and hides sdkconfig. If the bench tests show that memory or timing needs finer control, moving to native ESP-IDF 5.x (new `i2s_std`/`i2s_pdm` drivers, certificate bundle) is a contained change because networking, audio and the state machine are separate modules. ESPHome would need a custom component and speaks the Home Assistant native API, not this protocol, so it is not used.

### Behavior

- Provisioning over USB serial, once: `wifi <ssid> <password>`, `server <host> <port> <path>`, `token <token>`, `show` (masked), `clear`. Values go to NVS. There is no access point or open provisioning window. Limitation: NVS is not encrypted unless flash encryption is enabled, so someone with physical access can read the Wi-Fi password and the device token; the token is individual and revocable.
- TLS: the server certificate chain is verified against the root CA embedded from `certs/root_ca.pem` (ISRG Root X1, the root used by Let's Encrypt, SHA-256 fingerprint `96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6`). Replace the file if Caddy serves a chain from another root. The clock is set with SNTP before connecting because certificate dates are checked.
- Push to talk on the button (G39): hold to speak, release to send. Pressing while the assistant is thinking or speaking cancels the turn.
- LED states: connecting (orange blink), idle (dim blue), listening (green), thinking (amber), speaking (cyan), error (red).
- Audio: 16 kHz mono s16le in and out. Capture and playback each go through a bounded FreeRTOS stream buffer. The audio task owns the I2S driver and reinstalls it when switching between PDM capture and speaker playback. When the playback buffer is above its high-water mark the network task stops draining frames, so TCP backpressure slows the server instead of dropping audio.
- Turn gate: the 16-byte turn id of every binary frame is compared with the active reply turn; frames for any other turn, for a cancelled turn, or arriving after `audio.end` are discarded.
- Reconnection with exponential backoff and jitter (1 s up to 60 s). The same conversation is resumed through `hello.conversationId`.
- Limits: the device ignores server messages longer than 1 KB, which includes the `history` message the server sends after `hello` (that message is wasted bandwidth for the device; see requested changes in the development report).

### Build

Prerequisites: PlatformIO Core with the `espressif32` platform, which downloads the Xtensa toolchain and the Arduino core (more than 1 GB). The lead machine already has them in `~/.platformio`. CI does not build the firmware because of that size.

```sh
cd firmware/atom-echo
pio run -e atom-echo
```

Host tests of the hardware-independent logic:

```sh
cd firmware/atom-echo
g++ -std=c++17 -Wall -Wextra -Ilib/protocol test/host/protocol_test.cpp lib/protocol/protocol.cpp -o /tmp/protocol_test && /tmp/protocol_test
```

### Flashing

1. Build with `pio run -e atom-echo`.
2. Connect the board by USB and find the port (`ls /dev/ttyUSB* /dev/ttyACM*`). On Linux the user needs access to the port (`dialout` group).
3. `pio run -e atom-echo -t upload`. If the upload cannot connect, hold the button while plugging the board in; whether that is needed is bench test 1.
4. `pio device monitor` (115200 baud), then provision:
   ```
   wifi MyNetwork MyPassword
   server jarvis.example.com 443 /ws/device
   token <token from POST /api/devices>
   show
   ```
5. Reboot. The LED blinks orange until the Wi-Fi, the clock and the WebSocket are up, then turns dim blue.

## Bench tests pending hardware

None of these has been run. Record results here when the board exists.

1. USB enumeration, serial port, flashing, whether the button must be held for download mode.
2. LED: color order (SK6812 is expected GRB), brightness at idle, all five states visible.
3. Button: idle level of G39 (input only, no internal pull), bounce, hold detection.
4. Microphone: record 5 s of room noise and speech through the serial port or a debug build; check PDM gain, DC offset and noise floor; tune `MIC_GAIN_SHIFT`.
5. Speaker: play a 1 kHz tone and a 16 kHz speech clip; check clipping, hiss and the volume limit; measure the pop or gap when the I2S driver is reinstalled between capture and playback.
6. Wi-Fi: RSSI at the intended location; reconnection after the access point restarts.
7. SNTP and TLS: handshake against the real Caddy host, free heap and largest free block after the handshake.
8. Streaming: sustained 32 KB/s upstream and downstream; capture overruns and playback underruns (the firmware keeps counters and prints them on the serial console).
9. Latency: button release to first audible reply, compared with the web client numbers in `turns.client_first_audio_ms`.
10. Cancel: press during speech; time until the speaker is silent; confirm no frame of the cancelled turn is played.
11. Reconnection and revocation: restart the server mid-turn; revoke the device and check it stops retrying quickly; power from a weak USB supply and look for brownouts.
12. Soak: eight hours idle plus repeated turns; look for heap growth and unexpected resets.
13. Follow-up window and `conversation.end`: not implemented in the skeleton; decide after the above.
