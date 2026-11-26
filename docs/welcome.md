# Welcome

When the app opens, or when the owner comes back after a while (the same moment it shows «Hola, …» again), JARVIS's voice greets them over a piece of music, like the Iron Man suit booting.

- **Settings** (Configuración › Saludo al abrir):
  - on or off;
  - the phrase (by default «Bienvenido, {OWNER_DISPLAY_NAME}.»);
  - a song from Transferencias, and the second it starts at, to land on the riff;
  - «Probar».
- **The song** is copied into `/data/welcome/`, so it outlives the 24 hours of Transferencias. The owner brings their own file: nothing copyrighted is in the repository or downloaded by Jarvis.
- **The audio** (`apps/server/src/welcome/welcome.ts`) is made once and cached until the phrase, the song or its start change:
  - the phrase is said by the same ElevenLabs voice and robotic effect as calls, through the narrator;
  - ffmpeg mixes 12 seconds of the song, with the voice coming in at 1.5 s and the song fading out over the last 3.
- **Playback:** iOS and most browsers refuse sound before the first touch, so the welcome plays right away when allowed, and otherwise on the first touch anywhere. Opening the app from a notification does not play it.

Routes, owner only: `GET`/`PUT /api/welcome`, `PUT`/`DELETE /api/welcome/music` (with a Transferencias `transferId`), and `GET /api/welcome/audio`.
