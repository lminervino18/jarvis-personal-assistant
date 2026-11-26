export interface WelcomeState {
  enabled: boolean;
  phrase: string;
  musicName?: string;
  musicStart: number;
  /** Whether the server has JARVIS's voice to say it. */
  available: boolean;
  /** Changes whenever the welcome sounds different. */
  version: string;
}

async function call(url: string, init: RequestInit = {}): Promise<WelcomeState | null> {
  const response = await fetch(url, { credentials: "same-origin", ...init }).catch(() => null);
  return response?.ok ? ((await response.json()) as WelcomeState) : null;
}

const json = (method: string, body: object): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchWelcome = () => call("/api/welcome");
export const updateWelcome = (patch: Partial<Pick<WelcomeState, "enabled" | "phrase" | "musicStart">>) => call("/api/welcome", json("PUT", patch));
export const chooseWelcomeMusic = (transferId: string) => call("/api/welcome/music", json("PUT", { transferId }));
export const removeWelcomeMusic = () => call("/api/welcome/music", { method: "DELETE" });

let waiting: (() => void) | null = null;

/**
 * Plays JARVIS's welcome. Browsers, and iOS always, refuse sound before the owner touches the page:
 * then it plays on the first touch, so opening the app and tapping anywhere starts it.
 */
export async function playWelcome(options: { force?: boolean } = {}): Promise<boolean> {
  const state = await fetchWelcome();
  if (!state?.available || (!state.enabled && !options.force)) return false;
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
