import { describe, expect, it } from "vitest";
import source from "../../public/sw.js?raw";

type Listener = (event: unknown) => void;

function loadServiceWorker() {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  let windows: { url: string; focus(): Promise<void> }[] = [];
  const self = {
    location: { origin: "https://jarvis.example" },
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
    skipWaiting: async () => {},
  };
  new Function("self", "caches", "fetch", "URL", source)(self, {}, async () => new Response(), URL);
  const waited: Promise<unknown>[] = [];
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    listeners.get(type)?.({ ...event, waitUntil: (promise: Promise<unknown>) => void waited.push(promise) });
    await Promise.all(waited);
  };
  return {
    shown,
    opened,
    focused,
    dispatch,
    setWindows: (urls: string[]) => void (windows = urls.map((url) => ({ url, focus: async () => void focused.push(url) }))),
  };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });

describe("service worker", () => {
  it("shows the discreet notification the server sends and replaces by tag", async () => {
    const sw = loadServiceWorker();
    await sw.dispatch("push", pushEvent({ title: "J.A.R.V.IS", body: "Llamar al médico", tag: "reminder:1", url: "/" }));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe("J.A.R.V.IS");
    expect(sw.shown[0]?.options).toMatchObject({ body: "Llamar al médico", tag: "reminder:1", renotify: true, data: { url: "/" } });
  });

  it("falls back to a generic title and ignores unusable payloads and external urls", async () => {
    const sw = loadServiceWorker();
    await sw.dispatch("push", { data: { json: () => { throw new Error("bad"); } } });
    await sw.dispatch("push", pushEvent({ body: "x", url: "https://evil.example" }));
    expect(sw.shown[0]).toMatchObject({ title: "J.A.R.V.IS", options: { body: "" } });
    expect(sw.shown[1]?.options).toMatchObject({ data: { url: "/" } });
    expect(sw.shown[1]?.options).not.toHaveProperty("tag");
  });

  it("focuses the open window on click and opens the app when none is open", async () => {
    const sw = loadServiceWorker();
    const closed: boolean[] = [];
    const click = { notification: { close: () => closed.push(true), data: { url: "/" } } };
    sw.setWindows(["https://jarvis.example/"]);
    await sw.dispatch("notificationclick", click);
    expect(sw.focused).toEqual(["https://jarvis.example/"]);
    sw.setWindows([]);
    await sw.dispatch("notificationclick", click);
    expect(sw.opened).toEqual(["/"]);
    expect(closed).toHaveLength(2);
  });
});
