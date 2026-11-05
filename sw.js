// Service Worker: macht das Dashboard installierbar, offline startbar und empfängt Push-Mitteilungen.
// Strategie (wie im Kanban-Board): immer zuerst aus dem Netz laden, damit Updates und
// aktuelle Kurse sofort ankommen; ohne Verbindung die zuletzt gespeicherte Fassung zeigen.

const CACHE = 'depot-v8';

const DATEIEN = [
  './',
  './config.js',
  './api.js',
  './spiel.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/dist/umd/supabase.js'
];
const CDNS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

// Lokale Fassung (server.py): diese Daten als „letzter Stand“ merken (bleiben nur auf diesem Gerät).
// Supabase-Anfragen gehen an *.supabase.co und werden nie zwischengespeichert.
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
  const cdn = CDNS.includes(url.hostname);
  const istDaten = eigene && DATEN.some(d => url.pathname.endsWith(d));
  // Andere API-Aufrufe (z. B. Bearbeiten-Dialog) nie aus dem Cache bedienen
  if (!(cdn || (eigene && (!url.pathname.includes('/api/') || istDaten)))) return;

  // Eigene Dateien immer beim Server nachfragen (cache: 'no-cache'): GitHub Pages erlaubt dem Browser sonst,
  // bis zu 10 Minuten eine alte Fassung zu verwenden. Unverändertes kommt per ETag als kurze 304-Antwort zurück.
  ereignis.respondWith(
    fetch(anfrage, eigene ? { cache: 'no-cache' } : undefined)
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

// ---------- Push-Mitteilungen (kommen von der Edge Function "depot") ----------

self.addEventListener('push', ereignis => {
  let nachricht = {};
  try {
    nachricht = ereignis.data ? ereignis.data.json() : {};
  } catch (e) { /* kein gültiges JSON – Standardtext zeigen */ }
  ereignis.waitUntil(self.registration.showNotification(nachricht.titel || 'Depot-Alert', {
    body: nachricht.text || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-32.png',
    tag: nachricht.tag,           // gleicher Alert: alte Nachricht wird ersetzt statt gestapelt
    data: { url: './' }
  }));
});

// Antippen öffnet die App (oder holt das offene Fenster nach vorn)
self.addEventListener('notificationclick', ereignis => {
  ereignis.notification.close();
  ereignis.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(fenster => {
      for (const f of fenster) if ('focus' in f) return f.focus();
      return self.clients.openWindow(ereignis.notification.data.url);
    })
  );
});
