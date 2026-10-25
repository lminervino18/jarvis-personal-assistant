# Voice sidecars

Two CPU-only containers the server talks to over HTTP. Neither is exposed publicly; keep them on the private Docker network.

## Piper (text to speech)

```bash
docker build -t jarvis-piper infra/voice/piper
docker run -d --name piper -p 127.0.0.1:5000:5000 jarvis-piper
```

Server settings: `TTS_PROVIDER=piper`, `PIPER_URL=http://piper:5000`, `PIPER_SAMPLE_RATE=22050`.

The default voice is `es_MX-ald-medium` (Mexican Spanish, male, 22.05 kHz). Pick another with `--build-arg PIPER_VOICE=...` and set `PIPER_SAMPLE_RATE` to the voice's rate. The HTTP server is Piper's built-in one (Flask development server); it is fine for a single owner on a private network.

## faster-whisper (speech to text)

```bash
docker build -t jarvis-faster-whisper infra/voice/faster-whisper
docker run -d --name whisper -p 127.0.0.1:8000:8000 jarvis-faster-whisper
```

Server settings: `STT_PROVIDER=faster-whisper`, `FASTER_WHISPER_URL=http://whisper:8000/v1`.

`POST /v1/audio/transcriptions` follows the OpenAI multipart format (`file`, `language`, `prompt`), runs int8 on CPU and keeps the model loaded. Build with `--build-arg WHISPER_MODEL=small|medium|large-v3-turbo`; the model is baked into the image so the container needs no network. Runtime knobs: `WHISPER_THREADS` (default 4), `WHISPER_BEAM_SIZE` (default 1). The `av` version is pinned because faster-whisper 1.2.1 breaks with newer releases.

## Licenses (checked 2026-10-24)

| Component | License | Notes |
| --- | --- | --- |
| Piper engine (`piper-tts` 1.8.0, OHF-Voice/piper1-gpl) | GPL-3.0-or-later | Runs only as this separate process; the Node server talks to it over HTTP and links nothing from it. Do not copy its code into the server. |
| Voice `es_MX-ald-medium` | Dataset: Unlicense (public domain). Fine-tuned from `es_ES-davefx-medium` (dataset CC0). | Model card: `rhasspy/piper-voices/es/es_MX/ald/medium/MODEL_CARD`. The repository metadata says MIT. |
| Other Spanish Piper voices | `es_MX-claude-high`: dataset Apache-2.0. `es_AR-daniela-high`: dataset CC BY-SA 4.0 (attribution and share-alike apply to derivatives of the data). | Always re-read the `MODEL_CARD` before switching voice. |
| faster-whisper 1.2.1 | MIT | CTranslate2 and PyAV are MIT/BSD-style as well. |
| Whisper weights (`Systran/faster-whisper-small`, `-base`, `-large-v3`, `deepdml/faster-whisper-large-v3-turbo-ct2`) | MIT | Converted from OpenAI Whisper, which is MIT. |
