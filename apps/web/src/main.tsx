import "./zod-config.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { fetchAuthState } from "./auth/api.js";
import { WebAudioEngine } from "./audio/engine.js";
import { parseIntegrationResult } from "./conversation/integration-result.js";
import { Session } from "./conversation/session.js";
import { demoTransport } from "./demo/demo-server.js";
import { Conversation } from "./ui/Conversation.js";
import { PublicDownload, PublicUpload, publicRoute } from "./ui/PublicPages.js";
import { registerServiceWorker } from "./pwa/register.js";
import { preventZoom } from "./pwa/no-zoom.js";
import { subscribeToPush } from "./pwa/push.js";
import "./styles.css";

preventZoom(document);
if ("userAgentData" in navigator) document.documentElement.classList.add("refract");
const root = createRoot(document.getElementById("root") as HTMLElement);

const params = new URLSearchParams(window.location.search);
const demo = params.has("demo");

function createSession(): Session {
  const session = new Session({
    createEngine: (options) => new WebAudioEngine(options),
    loadDetectors: () => import("./audio/silero.js").then((module) => module.loadSileroDetectors()),
    isSessionValid: async () => (await fetchAuthState())?.authenticated !== false,
    subscribePush: subscribeToPush,
  });
  const result = parseIntegrationResult(window.location.search);
  if (result) {
    session.showIntegrationResult(result);
    window.history.replaceState(null, "", window.location.pathname);
  }
  return session;
}

function createDemoSession(): Session {
  const session = new Session({
    transport: demoTransport({ stepMs: 700, voice: params.has("voz") }),
    createEngine: (options) => new WebAudioEngine(options),
  });
  session.start();
  return session;
}

const shared = publicRoute(window.location.pathname);

if (shared) {
  root.render(<StrictMode>{shared.page === "upload" ? <PublicUpload token={shared.token} /> : <PublicDownload token={shared.token} />}</StrictMode>);
} else {
  root.render(<StrictMode>{demo ? <Conversation session={createDemoSession()} demo /> : <App session={createSession()} />}</StrictMode>);
  if (!demo) registerServiceWorker();
}
