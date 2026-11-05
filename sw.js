// Service Worker: macht das Dashboard installierbar und offline startbar.
// Strategie (wie im Kanban-Board): immer zuerst aus dem Netz laden, damit Updates und
// aktuelle Kurse sofort ankommen; ohne Verbindung die zuletzt gespeicherte Fassung zeigen.

const CACHE = 'depot-v1';

const DATEIEN = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// Diese Daten werden als „letzter Stand“ für offline gemerkt (bleiben nur auf diesem Gerät)
const DATEN = ['/api/portfolio', '/api/alerts'];

self.addEventListener('install', ereignis => {
  ereignis.waitUntil(caches.open(CACHE).then(c => c.addAll(DATEIEN)));
  self.skipWaiting();
});

self.addEventListener('activate', ereignis => {
  // Alte Cache-Versionen aufräumen
  ereignis.waitUntil(
    caches.keys().then(namen => Promise.all(namen.filter(n => n !== CACHE).map(n => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', ereignis => {
  const anfrage = ereignis.request;
  const url = new URL(anfrage.url);
  if (anfrage.method !== 'GET') return;

  const eigene = url.origin === self.location.origin;
  const cdn = url.hostname === 'cdnjs.cloudflare.com';
  const istDaten = eigene && DATEN.includes(url.pathname);
  // Andere API-Aufrufe (z. B. Bearbeiten-Dialog) nie aus dem Cache bedienen
  if (!(cdn || (eigene && (!url.pathname.startsWith('/api/') || istDaten)))) return;

  ereignis.respondWith(
    fetch(anfrage)
      .then(antwort => {
        if (antwort.ok) {
          const kopie = antwort.clone();
          caches.open(CACHE).then(c => c.put(anfrage, kopie));
        }
        return antwort;
      })
      .catch(async () => {
        const gespeichert = await caches.match(anfrage, { ignoreSearch: true });
        if (!gespeichert) return Response.error();
        if (!istDaten) return gespeichert;
        // Markieren, dass das ein alter Stand ist – das Dashboard zeigt dann einen Hinweis
        const kopf = new Headers(gespeichert.headers);
        kopf.set('X-Offline', '1');
        return new Response(await gespeichert.blob(), { status: 200, headers: kopf });
      })
  );
});
