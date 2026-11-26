interface WelcomeState {
  enabled: boolean;
  /** Whether the server has JARVIS's voice to say it. */
  available: boolean;
  /** Changes whenever the welcome sounds different. */
  version: string;
}

async function fetchWelcome(): Promise<WelcomeState | null> {
  const response = await fetch("/api/welcome", { credentials: "same-origin" }).catch(() => null);
  return response?.ok ? ((await response.json()) as WelcomeState) : null;
}

/** The welcome's audio, when it is on and the server has JARVIS's voice. */
async function fetchWelcomeAudio(): Promise<ArrayBuffer | null> {
  const state = await fetchWelcome();
  if (!state?.available || !state.enabled) return null;
  const response = await fetch(`/api/welcome/audio?v=${state.version}`, { credentials: "same-origin" }).catch(() => null);
  return response?.ok ? response.arrayBuffer() : null;
}

let waiting: (() => void) | null = null;

/**
 * Plays JARVIS's welcome on the chat, through the session so the core speaks with it. Browsers,
 * and iOS always, hold sound until the owner touches the page: then it plays on the first touch.
 */
export async function playWelcome(session: { playWelcome(data: ArrayBuffer): Promise<boolean> }): Promise<void> {
  const audio = await fetchWelcomeAudio();
  if (!audio) return;
  waiting?.();
  if (await session.playWelcome(audio)) return;
  const onTouch = () => {
    waiting = null;
    void session.playWelcome(audio);
  };
  document.addEventListener("pointerdown", onTouch, { once: true, capture: true });
  waiting = () => document.removeEventListener("pointerdown", onTouch, { capture: true });
}
