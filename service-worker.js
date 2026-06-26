// PULSE — Service Worker
// תפקיד מינימלי: לאפשר התקנה כ-PWA. לא עושה caching אגרסיבי כי האפליקציה
// תלויה בנתונים חיים מהשרת (חדשות, גרפים, התראות) שצריכים להיות תמיד טריים.

const CACHE_NAME = "pulse-shell-v1";
const SHELL_FILES = [
  "./pulse-app.html",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for everything — fall back to cached shell only if fully offline.
// API calls (to the Render backend) are never cached; they always hit the network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Don't intercept API calls to the backend — always go to network
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
