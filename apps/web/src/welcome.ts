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
export async function fetchWelcomeAudio(): Promise<ArrayBuffer | null> {
  const state = await fetchWelcome();
  if (!state?.available || !state.enabled) return null;
  const response = await fetch(`/api/welcome/audio?v=${state.version}`, { credentials: "same-origin" }).catch(() => null);
  return response?.ok ? response.arrayBuffer() : null;
}

/** On a phone the app opens straight into a call with JARVIS; on a computer it opens on the chat. */
export function opensInCall(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches === true && window.matchMedia("(max-width: 899px)").matches;
}

let waiting: (() => void) | null = null;

/**
 * Plays JARVIS's welcome. Browsers, and iOS always, refuse sound before the owner touches the page:
 * then it plays on the first touch, so opening the app and tapping anywhere starts it.
 */
export async function playWelcome(): Promise<boolean> {
  const state = await fetchWelcome();
  if (!state?.available || !state.enabled) return false;
  waiting?.();
  const audio = new Audio(`/api/welcome/audio?v=${state.version}`);
  audio.preload = "auto";
  try {
    await audio.play();
    return true;
  } catch {
    const onTouch = () => {
      waiting = null;
      void audio.play().catch(() => undefined);
    };
    document.addEventListener("pointerdown", onTouch, { once: true, capture: true });
    waiting = () => document.removeEventListener("pointerdown", onTouch, { capture: true });
    return false;
  }
}
