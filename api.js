// Datenzugriff für das Dashboard – zwei Betriebsarten mit derselben Schnittstelle:
//   lokal:    spricht mit server.py auf diesem Rechner (config.js ohne SUPABASE_URL)
//   supabase: Daten in der Supabase-Datenbank, Kurse und Alerts über die Edge Function "depot"
//
// Einheitliche Formate (wie server.py):
//   Position: { uid?, name, id (= ISIN/Ticker), depot, anteile, einstand, symbol }
//   Regel:    { id?, type, target, value, enabled }
//   Protokoll:{ time (Sekunden), title, message }

const LOKAL = {
  modus: 'lokal',
  async portfolio() { return holeJson('api/portfolio'); },
  async holdings() { return holeJson('api/holdings'); },
  async saveHoldings(items) { return sende('PUT', 'api/holdings', items); },
  async alerts() { return holeJson('api/alerts'); },
  async saveRules(rules) { return sende('PUT', 'api/alerts/rules', rules); },
  async check() { return sende('POST', 'api/alerts/check'); },
  async test() { return sende('POST', 'api/alerts/test'); },
};

async function holeJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Server antwortet nicht (' + r.status + ')');
  const daten = await r.json();
  if (r.headers.get('X-Offline') === '1') daten._offline = true;   // vom Service Worker: alter Stand
  return daten;
}
async function sende(methode, url, daten) {
  const r = await fetch(url, { method: methode, headers: { 'Content-Type': 'application/json' },
    body: daten === undefined ? undefined : JSON.stringify(daten) });
  const antwort = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(antwort.error || ('Fehler ' + r.status));
  return antwort;
}

// ---------------------------------------------------------------- Supabase

let sb = null;
function supabaseModus() {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const pruefe = ({ error }) => { if (error) throw new Error(error.message); };

  async function funktion(aktion, daten = {}) {
    const { data, error } = await sb.functions.invoke('depot', { body: { ...daten, aktion } });
    if (error) {
      let text = error.message;
      try { text = (await error.context.json()).error || text; } catch (e) { /* keine Details */ }
      throw new Error(text);
    }
    return data;
  }

  // Liste ersetzen: Neue Einträge anlegen, vorhandene ändern, fehlende löschen
  async function ersetzen(tabelle, alt, neu, zeile) {
    const bleibt = new Set(neu.filter(n => n.id).map(n => n.id));
    const loeschen = alt.filter(a => !bleibt.has(a.id)).map(a => a.id);
    if (loeschen.length) pruefe(await sb.from(tabelle).delete().in('id', loeschen));
    for (const n of neu) {
      if (n.id) pruefe(await sb.from(tabelle).update(zeile(n)).eq('id', n.id));
      else pruefe(await sb.from(tabelle).insert(zeile(n)));
    }
  }

  return {
    modus: 'supabase',
    async portfolio() { return funktion('portfolio'); },
    async holdings() {
      const { data, error } = await sb.from('positionen')
        .select('id, name, kennung, depot, anteile, einstand, symbol').order('geaendert');
      if (error) throw new Error(error.message);
      return data.map(r => ({ uid: r.id, name: r.name, id: r.kennung, depot: r.depot,
        anteile: Number(r.anteile), einstand: r.einstand == null ? null : Number(r.einstand), symbol: r.symbol }));
    },
    async saveHoldings(items) {
      const { data: alt, error } = await sb.from('positionen').select('id');
      if (error) throw new Error(error.message);
      const zahl = v => { const s = String(v ?? '').trim().replace(',', '.'); return s === '' ? null : Number(s); };
      await ersetzen('positionen', alt, items.map(i => ({ ...i, kennung: i.id, id: i.uid })), n => ({
        name: n.name || '', kennung: n.kennung, depot: n.depot || '', anteile: zahl(n.anteile) ?? 0,
        einstand: zahl(n.einstand), symbol: n.symbol || null, geaendert: new Date().toISOString(),
      }));
    },
    async alerts() {
      const [r, l] = await Promise.all([
        sb.from('alert_regeln').select('id, typ, ziel, wert, aktiv').order('erstellt'),
        sb.from('alert_protokoll').select('zeit, titel, text').order('zeit', { ascending: false }).limit(50),
      ]);
      if (r.error) throw new Error(r.error.message);
      if (l.error) throw new Error(l.error.message);
      return {
        rules: r.data.map(x => ({ id: x.id, type: x.typ, target: x.ziel, value: Number(x.wert), enabled: x.aktiv })),
        log: l.data.map(x => ({ time: new Date(x.zeit).getTime() / 1000, title: x.titel, message: x.text })),
      };
    },
    async saveRules(rules) {
      const { data: alt, error } = await sb.from('alert_regeln').select('id');
      if (error) throw new Error(error.message);
      await ersetzen('alert_regeln', alt, rules, n => ({ typ: n.type, ziel: n.target || '*', wert: n.value, aktiv: n.enabled !== false }));
    },
    async check() { return funktion('pruefen'); },
    async test() { return funktion('test'); },
    // Spieldepot: Orders, Status und Backtest laufen über die Edge Function, Verwaltung direkt über die Tabellen
    async simStatus(depotId) { return funktion('sim_status', { depot_id: depotId }); },
    async simOrder(order) { return funktion('sim_order', order); },
    async simBacktest(typ, parameter, startkapital, gebuehr) { return funktion('sim_backtest', { typ, parameter, startkapital, gebuehr }); },
    async simAnlegen(name, startkapital, gebuehr) {
      const { data, error } = await sb.from('spieldepots').insert({ name, startkapital, gebuehr }).select('id').single();
      if (error) throw new Error(error.message);
      return data.id;
    },
    async simLoeschen(depotId) { pruefe(await sb.from('spieldepots').delete().eq('id', depotId)); },
    async simRegelNeu(depotId, typ, parameter) { pruefe(await sb.from('sim_regeln').insert({ depot_id: depotId, typ, parameter })); },
    async simRegelAktiv(id, aktiv) { pruefe(await sb.from('sim_regeln').update({ aktiv }).eq('id', id)); },
    async simRegelLoeschen(id) { pruefe(await sb.from('sim_regeln').delete().eq('id', id)); },
  };
}

const API = (typeof SUPABASE_URL === 'string' && SUPABASE_URL) ? supabaseModus() : LOKAL;

// ---------------------------------------------------------------- Push-Mitteilungen (nur Supabase)

const pushMoeglich = () => API.modus === 'supabase' && typeof VAPID_PUBLIC_KEY === 'string' && VAPID_PUBLIC_KEY
  && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function schluesselAusBase64(text) {
  const b = (text + '='.repeat((4 - text.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b), c => c.charCodeAt(0));
}

async function pushStatus() {
  if (!pushMoeglich()) return 'nicht verfügbar';
  if (Notification.permission === 'denied') return 'blockiert';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'aktiv' : 'aus';
}

async function pushAktivieren() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt.');
  const reg = await navigator.serviceWorker.ready;
  const abo = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: schluesselAusBase64(VAPID_PUBLIC_KEY) });
  const j = abo.toJSON();
  const { error } = await sb.from('push_abos').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
    geraet: navigator.userAgent.slice(0, 200) });
  if (error) { await abo.unsubscribe(); throw new Error(error.message); }
}

async function pushAbmelden() {
  const reg = await navigator.serviceWorker.ready;
  const abo = await reg.pushManager.getSubscription();
  if (!abo) return;
  if (sb) await sb.from('push_abos').delete().eq('endpoint', abo.endpoint);
  await abo.unsubscribe();
}
