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
