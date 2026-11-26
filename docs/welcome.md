# Welcome

When the app opens, or when the owner comes back after a while (the same moment it shows «Hola, …» again), a short sting plays, like the Iron Man suit booting. It is the riff of the owner's song, with JARVIS's voice coming in right away. It is not configurable from the app.

- **The audio** (`apps/server/src/welcome/welcome.ts`) is made once and cached until the phrase, the song or its start change:
  - the phrase is said by the ElevenLabs voice with the robotic effect at 0.6, stronger than in calls;
  - ffmpeg mixes it over the song from its riff: the riff fades in over 0.9 s at half volume, ducks hard under the voice (which enters at 0.35 s), and fades a second after the voice ends, about three seconds in all.
- **Setup:**
  - It lives in `/data/welcome/` on the server, outside the repository.
  - It is set once through owner-only routes: `PUT /api/welcome` (`phrase`, `musicStart`, `enabled`), and `PUT /api/welcome/music` with a Transferencias `transferId`, whose file is copied so it outlives the 24 hours.
  - `GET /api/welcome/audio` serves the mix.
- **Phone:** the app opens straight into a call (`opensInCall`, a touch screen under 900 px).
  - The welcome is the call's first words. It plays through the call's own audio output (`AudioEngine.playClip`), so the core moves as JARVIS speaks, and only then does the microphone open.
  - iOS holds sound until the first touch, so the call shows «Tocá la pantalla para empezar» and that tap starts everything.
- **Computer:** the welcome plays on the chat, right away when the browser allows it and otherwise on the first touch.
- Opening the app from a notification does not play it.
