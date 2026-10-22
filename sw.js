// Mnemo — service worker : fonctionne hors ligne.
// Fichiers de l'app : réseau d'abord (mises à jour immédiates), cache en secours.
// Bibliothèques et polices des CDN : cache d'abord (URL versionnées, donc immuables).
const VERSION = 'mnemo-v1.2.0';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'ui.js', 'util.js', 'i18n.js', 'i18n-en.js', 'state.js', 'db.js', 'sched.js',
  'template.js', 'cardview.js', 'search.js', 'stats.js', 'importers.js', 'exporters.js', 'sync.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png'];
const CDN = ['https://cdn.jsdelivr.net/', 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (CDN.some(p => url.startsWith(p))) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (new URL(url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});
