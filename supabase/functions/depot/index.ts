// Supabase Edge Function "depot" – Kurse, Alerts und Push-Mitteilungen.
//
// Aufrufe (immer POST, JSON):
//   { aktion: "portfolio" }  aus der App (mit Anmelde-Token) → Positionen mit Kursen, Verlauf, G/V
//   { aktion: "pruefen" }    aus der App → Alerts sofort prüfen, gibt ausgelöste zurück
//   { aktion: "test" }       aus der App → Test-Mitteilung an alle eigenen Geräte
//   { aktion: "cron" }       per Cron (Kopfzeile x-cron-secret) → Alerts aller Konten prüfen
//   { aktion: "status" }     Diagnose (Kopfzeile x-cron-secret) → Yahoo erreichbar? Push-Schlüssel gesetzt?
//
// Einstellungen im Dashboard: "Verify JWT" AUS (die Funktion prüft Token bzw. Cron-Geheimnis selbst).
// Geheimnis (Edge Functions → Secrets): nur VAPID_PRIVATE_KEY. Das Cron-Geheimnis liegt im Vault der
// Datenbank (siehe schema.sql). SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY stellt Supabase bereit.
//
// Die Kurs- und Alert-Logik entspricht server.py (lokale Fassung).

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.110.0";

// Öffentlicher Schlüssel – derselbe wie VAPID_PUBLIC_KEY in config.js
const VAPID_PUBLIC_KEY = "BIorsFql5jstcpgUYT3yr1LN1ZSRReqSbxVmLfw3D_j7dHdziYNhwwLuUSRVVlJNo1ul3IElxPcoDbCpXqAFHpI";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const APP_URL = "https://dilldapp74.github.io/depot-dashboard/";
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) webpush.setVapidDetails(APP_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Mit dem Service-Schlüssel: liest alle Daten, deshalb prüft die Funktion jede Anfrage selbst
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (daten: unknown, status = 200) =>
  new Response(JSON.stringify(daten), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------------------------------------------------------------- Kurse (Yahoo Finance)

const UA = { "User-Agent": "Mozilla/5.0 (depot-dashboard)" };
const BEVORZUGT = [".DE", ".F", ".MU", ".SG", ".DU", ".BE", ".HM", ".HA", ".AS", ".PA", ".MI"];
const cache = new Map<string, { zeit: number; daten: unknown }>(); // lebt nur so lange wie die Instanz

// deno-lint-ignore no-explicit-any
async function holeJson(url: string, ttlSek: number): Promise<any> {
  const treffer = cache.get(url);
  if (treffer && Date.now() - treffer.zeit < ttlSek * 1000) return treffer.daten;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Kursabruf fehlgeschlagen (${r.status})`);
  const daten = await r.json();
  cache.set(url, { zeit: Date.now(), daten });
  return daten;
}

// deno-lint-ignore no-explicit-any
async function chart(symbol: string, range: string, interval: string, ttl: number): Promise<any> {
  const d = await holeJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, ttl);
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error(d?.chart?.error?.description ?? `Keine Daten für ${symbol}`);
  return res;
}

// deno-lint-ignore no-explicit-any
const schlusskurse = (h: any): (number | null)[] => h?.indicators?.quote?.[0]?.close ?? [];

const istIsin = (s: string) => /^[A-Za-z]{2}[A-Za-z0-9]{10}$/.test(s);
const rang = (s: string) => { const i = BEVORZUGT.findIndex((suf) => s.endsWith(suf)); return i < 0 ? BEVORZUGT.length : i; };

/** ISIN → Yahoo-Symbol. Nur Börsenplätze mit brauchbarer Kurshistorie; EUR-Notierung bevorzugt. */
async function symbolFinden(kennung: string): Promise<string> {
  kennung = kennung.trim();
  if (!istIsin(kennung)) return kennung;
  const d = await holeJson(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(kennung)}&quotesCount=10&newsCount=0`, 86400);
  const symbole: string[] = (d?.quotes ?? []).map((q: { symbol?: string }) => q.symbol).filter(Boolean);
  if (!symbole.length) throw new Error(`Kein Kurs-Symbol für ${kennung} gefunden`);
  symbole.sort((a, b) => rang(a) - rang(b));
  const gueltig: [number, number, string][] = [];
  for (const s of symbole.slice(0, 6)) {
    try {
      const h = await chart(s, "1y", "1d", 3600);
      if (schlusskurse(h).filter((c) => c).length >= 20) gueltig.push([h.meta.currency !== "EUR" ? 1 : 0, rang(s), s]);
    } catch { /* nächsten Börsenplatz probieren */ }
  }
  if (!gueltig.length) throw new Error(`Für ${kennung} keine Kurshistorie gefunden – bitte Ticker angeben (z. B. VWCE.DE)`);
  gueltig.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return gueltig[0][2];
}

/** Faktor, um einen Preis in `waehrung` in EUR umzurechnen. */
async function eurFaktor(waehrung?: string): Promise<number> {
  if (!waehrung || waehrung === "EUR") return 1;
  let teiler = 1;
  if (waehrung === "GBp" || waehrung === "GBX") { waehrung = "GBP"; teiler = 100; }
  const meta = (await chart(`EUR${waehrung}=X`, "1d", "1d", 600)).meta;
  return 1 / (meta.regularMarketPrice * teiler);
}

type Position = {
  uid: string; name: string; id: string; depot: string; anteile: number; einstand: number | null; symbol: string | null;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
};

async function bewerten(p: Position, mitVerlauf: boolean): Promise<Position> {
  const out: Position = { ...p };
  try {
    const sym = p.symbol || await symbolFinden(p.id);
    out.symbol = sym;
    const meta = (await chart(sym, "1d", "5m", 60)).meta;
    const fx = await eurFaktor(meta.currency);
    const preis = meta.regularMarketPrice * fx;
    const vortag = (meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice) * fx;
    let verlauf: [number, number][] = [];
    if (mitVerlauf) {
      const h = await chart(sym, "1y", "1d", 3600);
      const ts: number[] = h.timestamp ?? [];
      verlauf = ts.map((t, i) => [t, schlusskurse(h)[i]] as [number, number | null])
        .filter(([, c]) => c != null).map(([t, c]) => [t, (c as number) * fx]);
    }
    const menge = Number(p.anteile) || 0;
    Object.assign(out, {
      price: preis, prev: vortag, value: preis * menge, day_abs: (preis - vortag) * menge,
      day_pct: vortag ? (preis / vortag - 1) * 100 : 0, currency_src: meta.currency, exchange: meta.exchangeName,
      market_time: meta.regularMarketTime, history: verlauf, error: null,
    });
    if (p.einstand != null) {
      const e = Number(p.einstand);
      out.pl_abs = out.value - e;
      out.pl_pct = e ? (out.value / e - 1) * 100 : null;
    }
  } catch (e) {
    Object.assign(out, { error: String((e as Error).message ?? e), value: 0, day_abs: 0, history: [] });
  }
  return out;
}

async function portfolio(userId: string, mitVerlauf: boolean) {
  const { data, error } = await admin.from("positionen")
    .select("id, name, kennung, depot, anteile, einstand, symbol").eq("user_id", userId).order("geaendert");
  if (error) throw error;
  const positionen: Position[] = (data ?? []).map((r) => ({
    uid: r.id, name: r.name, id: r.kennung, depot: r.depot, anteile: Number(r.anteile),
    einstand: r.einstand == null ? null : Number(r.einstand), symbol: r.symbol,
  }));
  const bewertet = await Promise.all(positionen.map((p) => bewerten(p, mitVerlauf)));
  // aufgelöste Symbole merken, damit die ISIN-Suche nur einmal läuft
  await Promise.all(bewertet.filter((b, i) => b.symbol && !positionen[i].symbol && !b.error)
    .map((b) => admin.from("positionen").update({ symbol: b.symbol }).eq("id", b.uid)));
  return { positions: bewertet, generated: Date.now() / 1000 };
}

// ---------------------------------------------------------------- Push

async function sendeAn(userId: string, titel: string, text: string, tag: string) {
  if (!VAPID_PRIVATE_KEY) return;
  const { data: abos } = await admin.from("push_abos").select("endpoint, p256dh, auth").eq("user_id", userId);
  for (const abo of abos ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: abo.endpoint, keys: { p256dh: abo.p256dh, auth: abo.auth } },
        JSON.stringify({ titel, text, tag }), { TTL: 60 * 60 * 6 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_abos").delete().eq("endpoint", abo.endpoint);
      else console.error("Push fehlgeschlagen:", code, e);
    }
  }
}

// ---------------------------------------------------------------- Alerts

const de = (v: number, d = 2) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const kursText = (v: number) => de(v, v >= 1 ? 2 : 4);
const vz = (v: number) => (v >= 0 ? "+" : "");

async function alertsPruefen(userId: string) {
  const heute = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date()); // JJJJ-MM-TT
  const { data: regeln } = await admin.from("alert_regeln").select("*").eq("user_id", userId).eq("aktiv", true);
  if (!regeln?.length) return [];
  const pf = await portfolio(userId, false);
  const pos = pf.positions.filter((p) => !p.error);

  const { data: zustandZeilen } = await admin.from("alert_zustand").select("schluessel").eq("user_id", userId);
  const zustand = new Set((zustandZeilen ?? []).map((z) => z.schluessel));
  const neu = new Set<string>(), weg = new Set<string>();
  const ausgeloest: { titel: string; text: string; tag: string }[] = [];

  const einmalProTag = (schl: string, titel: string, text: string) => {
    const k = `d:${heute}:${schl}`;
    if (!zustand.has(k) && !neu.has(k)) { neu.add(k); ausgeloest.push({ titel, text, tag: schl }); }
  };
  // feuert beim Überschreiten, wird wieder scharf, sobald die Bedingung nicht mehr gilt
  const flanke = (schl: string, bedingung: boolean, titel: string, text: string) => {
    if (bedingung && !zustand.has(schl)) { neu.add(schl); ausgeloest.push({ titel, text, tag: schl }); }
    if (!bedingung && zustand.has(schl)) weg.add(schl);
  };

  for (const r of regeln) {
    const v = Number(r.wert);
    const auswahl = pos.filter((p) => r.ziel === "*" || p.id === r.ziel);
    const name = (p: Position) => p.name || p.id;
    if (r.typ === "day_move") {
      for (const p of auswahl) if (Math.abs(p.day_pct) >= v) {
        einmalProTag(`${r.id}:${p.id}`, `${name(p)} ${vz(p.day_pct)}${de(p.day_pct)} % heute`,
          `Kurs ${kursText(p.price)} € · Positionswert ${de(p.value)} € (${p.depot})`);
      }
    } else if (r.typ === "portfolio_day_move") {
      const gesamt = pos.reduce((s, p) => s + p.value, 0), tag = pos.reduce((s, p) => s + p.day_abs, 0);
      const pct = gesamt - tag ? (tag / (gesamt - tag)) * 100 : 0;
      if (Math.abs(pct) >= v) einmalProTag(r.id, `Portfolio ${vz(pct)}${de(pct)} % heute`,
        `${vz(tag)}${de(tag)} € · Gesamtwert ${de(gesamt)} €`);
    } else if (r.typ === "price_above" || r.typ === "price_below") {
      for (const p of auswahl) {
        const ueber = r.typ === "price_above";
        flanke(`${r.id}:${p.id}`, ueber ? p.price >= v : p.price <= v,
          `${name(p)} ${ueber ? "über" : "unter"} ${kursText(v)} €`, `Aktueller Kurs ${kursText(p.price)} €`);
      }
    } else if (r.typ === "pl_below") {
      for (const p of auswahl) if (p.pl_pct != null) {
        flanke(`${r.id}:${p.id}`, p.pl_pct <= -Math.abs(v), `${name(p)} ${de(p.pl_pct)} % seit Kauf`,
          `G/V ${de(p.pl_abs)} € · Grenze −${de(Math.abs(v), 0)} %`);
      }
    }
  }

  // alte Tages-Marker aufräumen
  for (const k of zustand) if (k.startsWith("d:") && !k.startsWith(`d:${heute}:`)) weg.add(k);
  if (neu.size) await admin.from("alert_zustand").upsert([...neu].map((schluessel) => ({ user_id: userId, schluessel })));
  if (weg.size) await admin.from("alert_zustand").delete().eq("user_id", userId).in("schluessel", [...weg]);

  for (const a of ausgeloest) {
    await admin.from("alert_protokoll").insert({ user_id: userId, titel: a.titel, text: a.text });
    await sendeAn(userId, a.titel, a.text, a.tag);
  }
  return ausgeloest;
}

// ---------------------------------------------------------------- Einstieg

async function angemeldet(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: { user } } = await admin.auth.getUser(token);
  return user?.id ?? null;
}

// Cron-Geheimnis gegen den Vault der Datenbank prüfen
async function cronErlaubt(req: Request): Promise<boolean> {
  const p = req.headers.get("x-cron-secret") ?? "";
  if (p.length < 32) return false;
  const { data, error } = await admin.rpc("cron_geheimnis_ok", { p });
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "nur POST" }, 405);
  let body: { aktion?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "ungültige Anfrage" }, 400); }

  try {
    // Diagnose: Erreicht die Funktion Yahoo? (nur mit Cron-Geheimnis)
    if (body.aktion === "status") {
      if (!(await cronErlaubt(req))) return json({ error: "nicht erlaubt" }, 401);
      const probe = await bewerten({ uid: "", name: "", id: "SAP.DE", depot: "", anteile: 1, einstand: null, symbol: null }, true);
      return json({ ok: !probe.error, yahoo: probe.error ?? "erreichbar", kurs: probe.price, verlauf: probe.history.length,
        push: Boolean(VAPID_PRIVATE_KEY) });
    }
    if (body.aktion === "cron") {
      if (!(await cronErlaubt(req))) return json({ error: "nicht erlaubt" }, 401);
      const { data } = await admin.from("alert_regeln").select("user_id").eq("aktiv", true);
      const konten = [...new Set((data ?? []).map((r) => r.user_id))];
      let anzahl = 0;
      for (const k of konten) anzahl += (await alertsPruefen(k)).length;
      return json({ ok: true, konten: konten.length, ausgeloest: anzahl });
    }

    const userId = await angemeldet(req);
    if (!userId) return json({ error: "nicht angemeldet" }, 401);
    if (body.aktion === "portfolio") return json(await portfolio(userId, true));
    if (body.aktion === "pruefen") return json({ fired: await alertsPruefen(userId) });
    if (body.aktion === "test") {
      await sendeAn(userId, "Depot-Alert: Test", "Push-Mitteilungen funktionieren.", "test");
      return json({ ok: true, push: Boolean(VAPID_PRIVATE_KEY) });
    }
    return json({ error: "unbekannte Aktion" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
