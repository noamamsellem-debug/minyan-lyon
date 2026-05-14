// Minyan Lyon — Service Worker
// Stratégie: network-first pour la page (pour récupérer les mises à jour de planning),
// cache-first pour les assets statiques (manifest, icon).

const CACHE = 'ml-v1';
const STATIC = ['./manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Pas de cache pour Firebase / Supabase / OAuth — toujours réseau
  if (url.host.includes('firebase') || url.host.includes('supabase') || url.host.includes('google')) return;

  // Page HTML — network-first
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./')))
    );
    return;
  }

  // Assets statiques — cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((r) => {
        if (r.ok && (url.origin === self.location.origin)) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return r;
      });
    })
  );
});
