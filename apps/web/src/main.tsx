import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { fetchAuthState } from "./auth/api.js";
import { WebAudioEngine } from "./audio/engine.js";
import { Session } from "./conversation/session.js";
import { registerServiceWorker } from "./pwa/register.js";
import { subscribeToPush } from "./pwa/push.js";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);

const session = new Session({
  createEngine: (options) => new WebAudioEngine(options),
  isSessionValid: async () => (await fetchAuthState()).authenticated,
  subscribePush: subscribeToPush,
});

root.render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
registerServiceWorker();
