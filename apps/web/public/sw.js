const SHELL_CACHE = "jarvis-shell-v2";
const ASSET_CACHE = "jarvis-assets-v2";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png"];
const DEFAULT_TITLE = "J.A.R.V.IS";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirstPage(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("/", response.clone());
    return response;
  } catch {
    const cached = await cache.match("/");
    if (cached) return cached;
    throw new Error("offline");
  }
}

function isCacheable(response) {
  return response.ok && !(response.headers.get("content-type") || "").includes("text/html");
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (SHELL_URLS.includes(url.pathname) || url.pathname.endsWith(".png")) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

function readPayload(event) {
  if (!event.data) return {};
  try {
    const data = event.data.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function sitePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

self.addEventListener("push", (event) => {
  const data = readPayload(event);
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: sitePath(data.url) },
    ...(tag ? { tag, renotify: true } : {}),
  };
  const title = typeof data.title === "string" && data.title ? data.title : DEFAULT_TITLE;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = sitePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      return open ? open.focus() : self.clients.openWindow(target);
    }),
  );
});
