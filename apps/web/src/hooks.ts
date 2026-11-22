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

const NEAR_BOTTOM_PX = 120;

/** Keeps a scroll container pinned to its end while the reader is already near it. */
export function useStickToBottom(container: RefObject<HTMLElement | null>, dependency: unknown): void {
  const pinned = useRef(true);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [container]);
  useEffect(() => {
    const element = container.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [container, dependency]);
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
