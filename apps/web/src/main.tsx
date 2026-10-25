import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { fetchAuthState } from "./auth/api.js";
import { WebAudioEngine } from "./audio/engine.js";
import { Session } from "./conversation/session.js";
import { demoTransport } from "./demo/demo-server.js";
import { Conversation } from "./ui/Conversation.js";
import { registerServiceWorker } from "./pwa/register.js";
import { subscribeToPush } from "./pwa/push.js";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);

const demo = new URLSearchParams(window.location.search).has("demo");

function createSession(): Session {
  return new Session({
    createEngine: (options) => new WebAudioEngine(options),
    isSessionValid: async () => (await fetchAuthState()).authenticated,
    subscribePush: subscribeToPush,
  });
}

function createDemoSession(): Session {
  const session = new Session({
    transport: demoTransport(),
    createEngine: (options) => new WebAudioEngine(options),
  });
  session.start();
  return session;
}

root.render(
  <StrictMode>{demo ? <Conversation session={createDemoSession()} demo /> : <App session={createSession()} />}</StrictMode>,
);
if (!demo) registerServiceWorker();
