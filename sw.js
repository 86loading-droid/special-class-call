const CACHE = "special-class-call-v0.1.0";
const FILES = ["./", "index.html", "css/style.css", "js/config.js", "js/app.js", "manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || "비상 호출";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "확인 버튼을 눌러 주세요.",
    tag: "emergency-call",
    renotify: true,
    requireInteraction: true,
    vibrate: [400, 200, 400, 200, 400]
  }));
});
