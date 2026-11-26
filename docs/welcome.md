# Welcome

When the app opens, or when the owner comes back after a while (the same moment it shows «Hola, …» again), a short sting plays, like the Iron Man suit booting. It is the riff of the owner's song, with JARVIS's voice coming in right away. It is not configurable from the app.

- **The audio** (`apps/server/src/welcome/welcome.ts`) is made once and cached until the phrase, the song or its start change:
  - the phrase is said by the ElevenLabs voice with the robotic effect at 0.6, stronger than in calls;
  - ffmpeg mixes it over the song from its riff: the voice enters at 0.35 s and the music fades a second after the voice ends, about three seconds in all.
- **Setup:**
  - It lives in `/data/welcome/` on the server, outside the repository.
  - It is set once through owner-only routes: `PUT /api/welcome` (`phrase`, `musicStart`, `enabled`), and `PUT /api/welcome/music` with a Transferencias `transferId`, whose file is copied so it outlives the 24 hours.
  - `GET /api/welcome/audio` serves the mix.
- **Playback:** iOS and most browsers refuse sound before the first touch. The welcome plays right away when allowed, and otherwise on the first touch anywhere. Opening the app from a notification does not play it.
