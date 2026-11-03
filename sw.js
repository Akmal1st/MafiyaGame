// Network first so every phone runs the same version; the saved copy is used when there is no internet.
const CACHE = "mafia-v3";
const FILES = ["./", "index.html", "offline.html", "i18n.js?v=3", "roles.js?v=3", "room.js?v=3", "bots.js?v=3", "net.js?v=3", "app.js?v=3",
  "vendor/mqtt-5.10.4.min.js", "vendor/qrcode-generator-1.4.4.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  const key = u.pathname.endsWith("/") ? "./" : e.request;
  e.respondWith(caches.open(CACHE).then(async c => {
    try { const r = await fetch(e.request, { cache: "no-cache" }); if (r.ok) c.put(key, r.clone()); return r; }
    catch (err) { const hit = await c.match(key); if (hit) return hit; throw err; }
  }));
});
