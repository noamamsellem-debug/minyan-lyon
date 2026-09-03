// Minyan Lyon — Service Worker
// Stratégie: network-first pour la page (pour récupérer les mises à jour de planning),
// cache-first pour les assets statiques (manifest, icon).

// ⚠️ INCRÉMENTER À CHAQUE MISE EN LIGNE.
// Le nom du cache est la seule chose qui purge les anciens contenus :
// `activate` supprime tout cache dont la clé diffère de celle-ci.
const CACHE = 'ml-v16-2026-09-impromptu';
// Les images sont désormais des fichiers séparés (elles pesaient 167 Ko de
// base64 dans index.html). Le logo de connexion est pré-caché ; les deux logos
// de navigation sont pris au vol, ils ne servent qu'à l'ouverture de la feuille.
const STATIC = ['./manifest.webmanifest', './icon.svg', './logo-minyan-lyon.png'];

// TODO(push) — §3.7 / §3.8 : alertes « minyan temporaire à proximité ».
// L'interface et la préférence (interrupteur + rayon 1/2/5/10/30 km) sont déjà
// en place côté client, stockées dans localStorage.mlNotifPrefs. Il reste à :
//   1. enregistrer un abonnement Web Push (self.registration.pushManager.subscribe)
//      avec la clé publique VAPID, et l'envoyer à Supabase ;
//   2. déclencher l'envoi depuis une Edge Function à la création d'un minyan
//      temporaire, filtrée sur la distance entre le minyan et les abonnés ;
//   3. traiter ici les évènements 'push' et 'notificationclick'.
// Tant que ce n'est pas fait, la notification n'est émise que si l'app est
// ouverte (voir notifyNearbyUsers dans index.html).
//
// self.addEventListener('push', (e) => { ... });
// self.addEventListener('notificationclick', (e) => { ... });

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

  // Page HTML — network-first, en contournant AUSSI le cache HTTP du navigateur.
  // Sans `cache: 'no-store'`, GitHub Pages renvoie l'index.html avec un
  // max-age : le SW recevait alors une copie périmée jusqu'à expiration et
  // l'utilisateur restait sur l'ancienne interface sans comprendre pourquoi.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./')))
    );
    return;
  }

  // Leaflet (CDN) : cache-first une fois téléchargé, pour que la carte
  // fonctionne aussi hors ligne et ne recharge pas 42 Ko à chaque ouverture.
  if (url.host === 'unpkg.com') {
    event.respondWith(
      caches.match(req).then((c) => c || fetch(req).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((k) => k.put(req, copy)).catch(() => {}); }
        return r;
      }))
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
