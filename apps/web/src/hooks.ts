import type { ViewportReport } from "@jarvis/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { ThreadMessage } from "./conversation/thread.js";
import type { Session, SessionSnapshot } from "./conversation/session.js";
import { useSyncExternalStore } from "react";

export function useSnapshot(session: Session): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

/** Tracks the visible viewport so the layout stays above the on-screen keyboard. */
export interface VisibleViewport {
  height: number;
  offsetTop: number;
  keyboardOpen: boolean;
}

const KEYBOARD_MIN_PX = 140;
const SHRUNK_PX = 4;
const SETTLE_MS = 150;

/**
 * The part of the page the user can actually see. On iOS the on-screen keyboard shrinks the
 * visual viewport and scrolls it without resizing the layout, so the app follows it.
 */
export function useVisibleViewport(): VisibleViewport | null {
  const [box, setBox] = useState<VisibleViewport | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const height = Math.round(viewport.height);
      const keyboardOpen = document.documentElement.clientHeight - height > KEYBOARD_MIN_PX;
      setBox({ height, offsetTop: Math.round(viewport.offsetTop), keyboardOpen });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return box;
}

/**
 * After the keyboard closes, iOS web apps can keep a viewport shorter than the screen, which
 * leaves a band at the bottom. Scrolling back and forcing one layout of the app restores it;
 * the thread keeps its scroll position. `onSettled` runs once the layout is back.
 */
export function useViewportRecovery(app: RefObject<HTMLElement | null>, keyboardOpen: boolean, onSettled?: () => void): void {
  const tallest = useRef({ width: 0, height: 0 });
  useEffect(() => {
    const track = () => {
      const width = window.innerWidth;
      if (width !== tallest.current.width) tallest.current = { width, height: 0 };
      tallest.current.height = Math.max(tallest.current.height, window.innerHeight);
    };
    track();
    window.addEventListener("resize", track);
    return () => window.removeEventListener("resize", track);
  }, []);
  useEffect(() => {
    if (keyboardOpen) return;
    const timer = setTimeout(() => {
      window.scrollTo(0, 0);
      const element = app.current;
      if (element && tallest.current.height - window.innerHeight > SHRUNK_PX) {
        const thread = element.querySelector<HTMLElement>(".thread");
        const top = thread?.scrollTop ?? 0;
        element.style.display = "none";
        void element.offsetHeight;
        element.style.display = "";
        if (thread) thread.scrollTop = top;
      }
      onSettled?.();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [app, keyboardOpen, onSettled]);
}

/** What the device reports about the screen and the app's box, to diagnose layout gaps. */
export function measureViewport(app: HTMLElement): ViewportReport {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (value: number) => Math.max(0, Math.round(value) || 0);
  const report = {
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true,
    inner: px(window.innerHeight),
    client: px(document.documentElement.clientHeight),
    visual: px(window.visualViewport?.height ?? window.innerHeight),
    screen: px(Math.max(screen.width, screen.height)),
    app: px(app.getBoundingClientRect().height),
    safeTop: px(parseFloat(style.paddingTop)),
    safeBottom: px(parseFloat(style.paddingBottom)),
  };
  probe.remove();
  return report;
}

const NEAR_BOTTOM_PX = 80;

/**
 * Whether the reader still follows the end after a scroll: being near it pins, and only moving up
 * unpins, so content that grows or a smooth scroll on its way down never lets go.
 */
export function pinnedAfterScroll(pinned: boolean, top: number, lastTop: number, distanceToEnd: number): boolean {
  if (distanceToEnd < NEAR_BOTTOM_PX) return true;
  return top < lastTop - 1 ? false : pinned;
}

export interface StickToBottom {
  /** The reader scrolled up, away from the latest content. */
  away: boolean;
  /** Pins the container to its end again and scrolls there. */
  toEnd(smooth?: boolean): void;
  /** Keeps what the reader sees in place while content is added above it (older messages). */
  keepPosition(): void;
}

/**
 * Keeps a scroll container pinned to its end while the reader is there, also while its content
 * grows (streamed text, cards, images). Only scrolling up unpins it, so updates never fight the reader.
 */
export function useStickToBottom(container: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>): StickToBottom {
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const fromEnd = useRef(0);
  const [away, setAway] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const follow = () => {
      if (pinned.current) element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    };
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinned.current = pinnedAfterScroll(pinned.current, element.scrollTop, lastTop.current, distance);
      lastTop.current = element.scrollTop;
      fromEnd.current = distance;
      setAway(!pinned.current);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    element.addEventListener("scroll", onScroll, { passive: true });
    follow();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [container, content]);

  const toEnd = (smooth = false) => {
    const element = container.current;
    pinned.current = true;
    setAway(false);
    element?.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  };
  const keepPosition = () => {
    const element = container.current;
    if (element && !pinned.current) element.scrollTo({ top: element.scrollHeight - element.clientHeight - fromEnd.current, behavior: "instant" });
  };
  return { away, toEnd, keepPosition };
}

/** Text of the assistant reply that just finished streaming, for the polite live region. */
export function useAssistantAnnouncement(messages: ThreadMessage[]): string {
  const streaming = useRef(new Set<string>());
  const [text, setText] = useState("");
  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant" || !message.turnId) continue;
      if (message.streaming) streaming.current.add(message.turnId);
      else if (streaming.current.delete(message.turnId)) setText(message.text);
    }
  }, [messages]);
  return text;
}

/** Height of an element, kept up to date while it resizes (e.g. a growing composer). */
export function useElementHeight(element: RefObject<HTMLElement | null>, fallback: number): number {
  const [height, setHeight] = useState(fallback);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(() => setHeight(Math.round(target.getBoundingClientRect().height)));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return height;
}

/** Whether a CSS media query matches, updated when it changes (for example the window is resized). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** Minutes and seconds since the component mounted, as "m:ss". */
export function useElapsed(): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
