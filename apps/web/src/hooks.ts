import { useEffect, useRef, useState, type RefObject } from "react";
import type { ThreadMessage } from "./conversation/thread.js";
import type { Session, SessionSnapshot } from "./conversation/session.js";
import { useSyncExternalStore } from "react";

export function useSnapshot(session: Session): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

/** Tracks the visible viewport so the layout stays above the on-screen keyboard. */
export function useViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setHeight(Math.round(viewport.height));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return height;
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
