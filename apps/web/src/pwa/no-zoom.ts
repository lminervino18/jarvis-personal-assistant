const GESTURES = ["gesturestart", "gesturechange", "gestureend"] as const;

/**
 * Keeps the app at its own scale like a native app: iOS ignores `user-scalable=no`, so pinch
 * gestures (WebKit's gesture events, or two fingers moving) are stopped here; double-tap zoom is
 * already off through `touch-action: manipulation`.
 */
export function preventZoom(target: EventTarget): void {
  const block = (event: Event) => event.preventDefault();
  for (const type of GESTURES) target.addEventListener(type, block, { passive: false });
  target.addEventListener(
    "touchmove",
    (event) => {
      if ((event as TouchEvent).touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );
}
