// Supabase Edge Function "depot" – Kurse, Alerts und Push-Mitteilungen.
//
// Aufrufe (immer POST, JSON):
//   { aktion: "portfolio" }  aus der App (mit Anmelde-Token) → Positionen mit Kursen, Verlauf, G/V
//   { aktion: "pruefen" }    aus der App → Alerts sofort prüfen, gibt ausgelöste zurück
//   { aktion: "test" }       aus der App → Test-Mitteilung an alle eigenen Geräte
//   { aktion: "cron" }       per Cron (Kopfzeile x-cron-secret) → Alerts aller Konten prüfen
//   { aktion: "status" }     Diagnose (Kopfzeile x-cron-secret) → Yahoo erreichbar? Push-Schlüssel gesetzt?
//   { aktion: "sim_status", depot_id? }               Spieldepot: Bestand, Orders, Regeln, Tageswerte
//   { aktion: "sim_order", depot_id, kennung, seite, betrag | anteile | alles }   Spieldepot: Order buchen
//   { aktion: "sim_backtest", typ, parameter, startkapital?, gebuehr? }          Regel über das letzte Jahr testen
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

// ---------------------------------------------------------------- Spieldepot (Paper-Trading)
//
// Dieselbe Entscheidungslogik (regelEntscheiden) läuft im täglichen Cron und im Backtest.
// Orders bucht nur sim_buchen() in der Datenbank – mit dem Kurs, den diese Funktion selbst abruft.

const berlin = (d = new Date()) => {
  const teile = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(d).map((t) => [t.type, t.value]));
  return { tag: `${teile.year}-${teile.month}-${teile.day}`, minuten: Number(teile.hour) * 60 + Number(teile.minute),
    werktag: !["Sat", "Sun"].includes(teile.weekday) };
};
const tageZwischen = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/** Aktueller Kurs in EUR samt Symbol und Name */
async function simKurs(kennung: string) {
  const symbol = await symbolFinden(kennung);
  const meta = (await chart(symbol, "1d", "5m", 60)).meta;
  const fx = await eurFaktor(meta.currency);
  return { symbol, kurs: meta.regularMarketPrice * fx, name: meta.longName ?? meta.shortName ?? kennung };
}

/** Fehler durch Eingaben (z. B. zu wenig Spielgeld) – geht als Hinweis (400) an die App, nicht als Serverfehler */
class Hinweis extends Error {}

type SimOrder = { kennung: string; seite: "kauf" | "verkauf"; anteile: number; grund: string };
type SimKontext = {
  tag: string;
  kurs: (k: string) => number | null;          // Kurs in EUR am betrachteten Tag
  verlauf: (k: string) => number[];            // Schlusskurse bis einschließlich dieses Tages, älteste zuerst
  bestand: Map<string, number>;
  bargeld: number;
  gebuehr: number;
  gesamtwert: number;
};
// deno-lint-ignore no-explicit-any
type Params = Record<string, any>;

/** Kennungen, die eine Regel braucht */
function regelKennungen(typ: string, p: Params): string[] {
  if (typ === "rebalancing") return (p.ziele ?? []).map((z: { kennung: string }) => String(z.kennung).trim()).filter(Boolean);
  return p.kennung ? [String(p.kennung).trim()] : [];
}

/** Was würde die Regel an diesem Tag tun? Gibt Orders, neuen Zustand und eine Meldung zurück. */
function regelEntscheiden(typ: string, p: Params, ctx: SimKontext, zustand: Params) {
  const orders: SimOrder[] = [];
  const z = { ...zustand };
  let meldung = "";
  const kaufFuer = (k: string, betrag: number, grund: string) => {
    const kurs = ctx.kurs(k);
    if (!kurs) { meldung = `Kein Kurs für ${k}`; return; }
    if (betrag + ctx.gebuehr > ctx.bargeld + 0.005) { meldung = `Zu wenig Spielgeld für ${de(betrag)} € (${de(ctx.bargeld)} € frei)`; return; }
    if (betrag < 1) return;
    orders.push({ kennung: k, seite: "kauf", anteile: betrag / kurs, grund });
    ctx.bargeld -= betrag + ctx.gebuehr;
  };

  if (typ === "sparplan") {
    const k = String(p.kennung), monat = ctx.tag.slice(0, 7), tagImMonat = Number(ctx.tag.slice(8));
    if (z.monat !== monat && tagImMonat >= Number(p.tag ?? 1)) {
      kaufFuer(k, Number(p.betrag), `Sparplan ${monat}`);
      z.monat = monat;
    }
  } else if (typ === "nachkauf") {
    const k = String(p.kennung), kurs = ctx.kurs(k), v = ctx.verlauf(k).slice(-Number(p.tage ?? 20));
    if (kurs && v.length) {
      const hoch = Math.max(...v), grenze = hoch * (1 - Number(p.rueckgang) / 100);
      const sperre = z.letzter && tageZwischen(z.letzter, ctx.tag) < 7;
      if (kurs <= grenze && !sperre) {
        kaufFuer(k, Number(p.betrag), `${de((kurs / hoch - 1) * 100, 1)} % unter dem ${v.length}-Tage-Hoch`);
        if (orders.length) z.letzter = ctx.tag;
      }
    }
  } else if (typ === "trend") {
    const k = String(p.kennung), tage = Number(p.tage ?? 200), kurs = ctx.kurs(k), v = ctx.verlauf(k);
    if (!kurs) meldung = `Kein Kurs für ${k}`;
    else if (v.length < tage) meldung = `Erst ${v.length} von ${tage} Kurstagen vorhanden`;
    else {
      const schnitt = v.slice(-tage).reduce((s, x) => s + x, 0) / tage, bestand = ctx.bestand.get(k) ?? 0;
      if (kurs > schnitt && bestand <= 0) {
        kaufFuer(k, Math.min(Number(p.betrag ?? Infinity) || Infinity, ctx.bargeld - ctx.gebuehr), `Kurs über ${tage}-Tage-Schnitt (${de(schnitt)} €)`);
      } else if (kurs < schnitt && bestand > 0) {
        orders.push({ kennung: k, seite: "verkauf", anteile: bestand, grund: `Kurs unter ${tage}-Tage-Schnitt (${de(schnitt)} €)` });
      }
    }
  } else if (typ === "rebalancing") {
    const ziele: { kennung: string; gewicht: number }[] = (p.ziele ?? []).map((x: Params) => ({ kennung: String(x.kennung).trim(), gewicht: Number(x.gewicht) }));
    const schwelle = Number(p.schwelle ?? 5), gesamt = ctx.gesamtwert;
    const ist = (k: string) => ((ctx.bestand.get(k) ?? 0) * (ctx.kurs(k) ?? 0)) / gesamt * 100;
    const ausreisser = ziele.filter((x) => Math.abs(ist(x.kennung) - x.gewicht) > schwelle);
    if (gesamt > 0 && ausreisser.length) {
      const plan = ziele.map((x) => ({ ...x, diff: gesamt * x.gewicht / 100 - (ctx.bestand.get(x.kennung) ?? 0) * (ctx.kurs(x.kennung) ?? 0) }));
      for (const x of plan.filter((x) => x.diff < -10)) {               // erst verkaufen …
        const kurs = ctx.kurs(x.kennung);
        if (!kurs) continue;
        const anteile = Math.min(-x.diff / kurs, ctx.bestand.get(x.kennung) ?? 0);
        orders.push({ kennung: x.kennung, seite: "verkauf", anteile, grund: `Rebalancing auf ${x.gewicht} %` });
        ctx.bargeld += anteile * kurs - ctx.gebuehr;
      }
      for (const x of plan.filter((x) => x.diff > 10)) {                // … dann kaufen
        kaufFuer(x.kennung, Math.min(x.diff, ctx.bargeld - ctx.gebuehr), `Rebalancing auf ${x.gewicht} %`);
      }
    }
  }
  return { orders, zustand: z, meldung };
}

/** Bestand, Einstand (Durchschnittskosten) und Werte eines Spieldepots */
async function simBewerten(depotId: string) {
  const { data: depot } = await admin.from("spieldepots").select("*").eq("id", depotId).single();
  const { data: orders } = await admin.from("sim_orders").select("*").eq("depot_id", depotId).order("zeit");
  const pos = new Map<string, { kennung: string; symbol: string; name: string; anteile: number; kosten: number }>();
  for (const o of orders ?? []) {
    const p = pos.get(o.kennung) ?? { kennung: o.kennung, symbol: o.symbol, name: o.name, anteile: 0, kosten: 0 };
    const a = Number(o.anteile), betrag = a * Number(o.kurs);
    if (o.seite === "kauf") { p.anteile += a; p.kosten += betrag + Number(o.gebuehr); }
    else { p.kosten -= p.anteile ? p.kosten * (a / p.anteile) : 0; p.anteile -= a; }
    pos.set(o.kennung, p);
  }
  const offen = [...pos.values()].filter((p) => p.anteile > 1e-9);
  const positionen = await Promise.all(offen.map(async (p) => {
    try {
      const meta = (await chart(p.symbol, "1d", "5m", 60)).meta;
      const fx = await eurFaktor(meta.currency), kurs = meta.regularMarketPrice * fx;
      const vortag = (meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice) * fx;
      const wert = kurs * p.anteile;
      return { ...p, kurs, wert, tag_pct: vortag ? (kurs / vortag - 1) * 100 : 0, pl_abs: wert - p.kosten,
        pl_pct: p.kosten ? (wert / p.kosten - 1) * 100 : 0, fehler: null };
    } catch (e) {
      return { ...p, kurs: null, wert: 0, tag_pct: 0, pl_abs: 0, pl_pct: 0, fehler: String((e as Error).message ?? e) };
    }
  }));
  const gesamt = Number(depot.bargeld) + positionen.reduce((s, p) => s + p.wert, 0);
  return { depot, positionen, orders: orders ?? [], gesamt };
}

/** Regeln eines Depots für heute ausführen (live) */
async function simRegelnAusfuehren(depotId: string, userId: string, tag: string) {
  const { data: regeln } = await admin.from("sim_regeln").select("*").eq("depot_id", depotId).eq("aktiv", true);
  const ergebnisse: string[] = [];
  for (const r of regeln ?? []) {
    const stand = await simBewerten(depotId);
    const kennungen = regelKennungen(r.typ, r.parameter);
    const kurse = new Map<string, { symbol: string; kurs: number; name: string }>();
    const verlaeufe = new Map<string, number[]>();
    let meldung = "";
    for (const k of kennungen) {
      try {
        const q = await simKurs(k);
        kurse.set(k, q);
        if (r.typ === "nachkauf" || r.typ === "trend") {
          const h = await chart(q.symbol, "1y", "1d", 3600);
          const fx = q.kurs / ((await chart(q.symbol, "1d", "5m", 60)).meta.regularMarketPrice || q.kurs);
          // Tageskurse des letzten Jahres (enthalten den heutigen Tag bereits)
          verlaeufe.set(k, schlusskurse(h).filter((c): c is number => c != null).map((c) => c * fx));
        }
      } catch (e) { meldung = `${k}: ${(e as Error).message}`; }
    }
    if (meldung) { await admin.from("sim_regeln").update({ letzte_meldung: `${tag}: ${meldung}` }).eq("id", r.id); continue; }
    const ctx: SimKontext = {
      tag, kurs: (k) => kurse.get(k)?.kurs ?? stand.positionen.find((p) => p.kennung === k)?.kurs ?? null,
      verlauf: (k) => verlaeufe.get(k) ?? [], bestand: new Map(stand.positionen.map((p) => [p.kennung, p.anteile])),
      bargeld: Number(stand.depot.bargeld), gebuehr: Number(stand.depot.gebuehr), gesamtwert: stand.gesamt,
    };
    const e = regelEntscheiden(r.typ, r.parameter, ctx, r.zustand ?? {});
    const gebucht: string[] = [];
    for (const o of e.orders) {
      const q = kurse.get(o.kennung)!;
      const { error } = await admin.rpc("sim_buchen", { p_depot: depotId, p_user: userId, p_kennung: o.kennung,
        p_symbol: q.symbol, p_name: q.name, p_seite: o.seite, p_anteile: o.anteile, p_kurs: q.kurs, p_quelle: `regel:${r.typ}` });
      gebucht.push(error ? `${o.kennung}: ${error.message}` : `${o.seite === "kauf" ? "Kauf" : "Verkauf"} ${de(o.anteile, 4)} × ${o.kennung} – ${o.grund}`);
    }
    const text = gebucht.join("; ") || e.meldung || "keine Aktion";
    await admin.from("sim_regeln").update({ zustand: e.zustand, letzte_meldung: `${tag}: ${text}` }).eq("id", r.id);
    ergebnisse.push(text);
  }
  return ergebnisse;
}

/** Täglich nach Börsenschluss (ab 17:40 Berlin): Regeln ausführen (werktags) und Tageswert speichern */
async function spieldepotsTaeglich() {
  const jetzt = berlin();
  if (jetzt.minuten < 17 * 60 + 40) return 0;
  const { data: depots } = await admin.from("spieldepots").select("id, user_id");
  let anzahl = 0;
  for (const d of depots ?? []) {
    const { data: schon } = await admin.from("sim_tageswerte").select("tag").eq("depot_id", d.id).eq("tag", jetzt.tag).maybeSingle();
    if (schon) continue;
    if (jetzt.werktag) await simRegelnAusfuehren(d.id, d.user_id, jetzt.tag);
    const stand = await simBewerten(d.id);
    await admin.from("sim_tageswerte").upsert({ depot_id: d.id, user_id: d.user_id, tag: jetzt.tag,
      wert: Math.round(stand.gesamt * 100) / 100, bargeld: stand.depot.bargeld });
    anzahl++;
  }
  return anzahl;
}

/** Manuelle Order aus der App */
async function simOrder(userId: string, b: Params) {
  const { data: depot } = await admin.from("spieldepots").select("*").eq("id", b.depot_id).eq("user_id", userId).maybeSingle();
  if (!depot) throw new Hinweis("Spieldepot nicht gefunden");
  if (b.seite !== "kauf" && b.seite !== "verkauf") throw new Hinweis("Bitte Kaufen oder Verkaufen wählen");
  const kennung = String(b.kennung ?? "").trim();
  if (!kennung) throw new Hinweis("Bitte eine ISIN oder einen Ticker angeben");
  const q = await simKurs(kennung);
  let anteile = Number(b.anteile) || 0;
  if (b.seite === "verkauf" && b.alles) {
    const stand = await simBewerten(depot.id);
    anteile = stand.positionen.find((p) => p.kennung === kennung)?.anteile ?? 0;
  } else if (!anteile) anteile = (Number(b.betrag) || 0) / q.kurs;
  if (!(anteile > 0)) throw new Hinweis(b.alles ? `Keine Anteile von ${kennung} im Spieldepot` : "Bitte einen Betrag oder eine Stückzahl angeben");
  const { data, error } = await admin.rpc("sim_buchen", { p_depot: depot.id, p_user: userId, p_kennung: kennung,
    p_symbol: q.symbol, p_name: q.name, p_seite: b.seite, p_anteile: Math.round(anteile * 1e6) / 1e6, p_kurs: q.kurs, p_quelle: "manuell" });
  if (error) throw new Hinweis(error.message);
  return data;
}

/** Status eines Spieldepots für die App */
async function simStatus(userId: string, depotId?: string) {
  const { data: depots } = await admin.from("spieldepots").select("id, name").eq("user_id", userId).order("erstellt");
  if (!depots?.length) return { depots: [] };
  const id = depots.find((d) => d.id === depotId)?.id ?? depots[0].id;
  const stand = await simBewerten(id);
  const [{ data: regeln }, { data: tageswerte }] = await Promise.all([
    admin.from("sim_regeln").select("id, typ, parameter, aktiv, letzte_meldung").eq("depot_id", id).order("erstellt"),
    admin.from("sim_tageswerte").select("tag, wert").eq("depot_id", id).order("tag"),
  ]);
  return { depots, depot: stand.depot, positionen: stand.positionen, gesamt: stand.gesamt,
    orders: stand.orders.slice(-50).reverse(), regeln: regeln ?? [], tageswerte: tageswerte ?? [], generated: Date.now() / 1000 };
}

/** Backtest: Regel über das letzte Jahr mit Tagesschlusskursen, Vergleich mit „kaufen und halten“ */
async function simBacktest(typ: string, p: Params, startkapital = 25000, gebuehr = 1) {
  const kennungen = regelKennungen(typ, p);
  if (!["sparplan", "rebalancing", "nachkauf", "trend"].includes(typ)) throw new Hinweis("Unbekannter Regeltyp");
  if (!kennungen.length) throw new Hinweis("Die Regel braucht mindestens eine Position");
  const reihen = new Map<string, Map<string, number>>();
  for (const k of kennungen) {
    const q = await simKurs(k);
    const h = await chart(q.symbol, "2y", "1d", 3600);
    const fx = q.kurs / ((await chart(q.symbol, "1d", "5m", 60)).meta.regularMarketPrice || q.kurs); // heutiger Wechselkurs
    const m = new Map<string, number>();
    (h.timestamp ?? []).forEach((t: number, i: number) => { const c = schlusskurse(h)[i]; if (c != null) m.set(berlin(new Date(t * 1000)).tag, c * fx); });
    reihen.set(k, m);
  }
  const alleTage = [...new Set([...reihen.values()].flatMap((m) => [...m.keys()]))].sort();
  const ab = berlin(new Date(Date.now() - 365 * 864e5)).tag;
  const letzter = new Map<string, number>(), historie = new Map<string, number[]>(kennungen.map((k) => [k, []]));
  let bargeld = startkapital, zustand: Params = {}, trades = 0, gebuehren = 0;
  const bestand = new Map<string, number>();
  const regelWerte: [string, number][] = [], haltenWerte: [string, number][] = [];
  let haltenAnteile: Map<string, number> | null = null, haltenBargeld = startkapital;
  const gewichte = typ === "rebalancing" ? (p.ziele ?? []).map((z: Params) => Number(z.gewicht) / 100) : kennungen.map(() => 1 / kennungen.length);

  for (const tag of alleTage) {
    for (const k of kennungen) { const c = reihen.get(k)!.get(tag); if (c != null) { letzter.set(k, c); historie.get(k)!.push(c); } }
    if (tag < ab || kennungen.some((k) => !letzter.has(k))) continue;
    const wertBestand = () => kennungen.reduce((s, k) => s + (bestand.get(k) ?? 0) * letzter.get(k)!, 0);
    const ctx: SimKontext = { tag, kurs: (k) => letzter.get(k) ?? null, verlauf: (k) => historie.get(k) ?? [],
      bestand: new Map(bestand), bargeld, gebuehr, gesamtwert: bargeld + wertBestand() };
    const e = regelEntscheiden(typ, p, ctx, zustand);
    zustand = e.zustand;
    for (const o of e.orders) {
      const kurs = letzter.get(o.kennung)!, betrag = o.anteile * kurs;
      if (o.seite === "kauf" && betrag + gebuehr <= bargeld + 0.005) {
        bargeld -= betrag + gebuehr; bestand.set(o.kennung, (bestand.get(o.kennung) ?? 0) + o.anteile);
      } else if (o.seite === "verkauf" && o.anteile <= (bestand.get(o.kennung) ?? 0) + 1e-9) {
        bargeld += betrag - gebuehr; bestand.set(o.kennung, (bestand.get(o.kennung) ?? 0) - o.anteile);
      } else continue;
      trades++; gebuehren += gebuehr;
    }
    regelWerte.push([tag, bargeld + wertBestand()]);
    // Vergleich: am ersten Tag einmal kaufen (gleiche Gewichte bzw. Zielgewichte) und liegen lassen
    if (!haltenAnteile) {
      haltenAnteile = new Map();
      for (const [i, k] of kennungen.entries()) {
        const betrag = startkapital * (gewichte[i] ?? 0) - gebuehr;
        if (betrag > 0) { haltenAnteile.set(k, betrag / letzter.get(k)!); haltenBargeld -= betrag + gebuehr; }
      }
    }
    haltenWerte.push([tag, haltenBargeld + kennungen.reduce((s, k) => s + (haltenAnteile!.get(k) ?? 0) * letzter.get(k)!, 0)]);
  }
  const kennzahl = (w: [string, number][]) => {
    if (!w.length) return null;
    let hoch = -Infinity, maxRueck = 0;
    for (const [, v] of w) { hoch = Math.max(hoch, v); maxRueck = Math.min(maxRueck, (v / hoch - 1) * 100); }
    const ende = w.at(-1)![1];
    return { endwert: ende, rendite: (ende / startkapital - 1) * 100, max_rueckgang: maxRueck };
  };
  return { von: regelWerte[0]?.[0], bis: regelWerte.at(-1)?.[0], startkapital, trades, gebuehren,
    regel: { werte: regelWerte, ...kennzahl(regelWerte) }, halten: { werte: haltenWerte, ...kennzahl(haltenWerte) },
    hinweis: "Tagesschlusskurse; Fremdwährungen mit dem heutigen Wechselkurs umgerechnet; keine Steuern, keine Dividenden." };
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
  let body: Params = {};
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
      let spieldepots = 0;
      try { spieldepots = await spieldepotsTaeglich(); } catch (e) { console.error("Spieldepot:", e); }
      return json({ ok: true, konten: konten.length, ausgeloest: anzahl, spieldepots });
    }

    const userId = await angemeldet(req);
    if (!userId) return json({ error: "nicht angemeldet" }, 401);
    if (body.aktion === "portfolio") return json(await portfolio(userId, true));
    if (body.aktion === "pruefen") return json({ fired: await alertsPruefen(userId) });
    if (body.aktion === "sim_status") return json(await simStatus(userId, body.depot_id));
    if (body.aktion === "sim_order") return json(await simOrder(userId, body));
    if (body.aktion === "sim_backtest") {
      return json(await simBacktest(String(body.typ), body.parameter ?? {}, Number(body.startkapital) || 25000,
        body.gebuehr == null ? 1 : Number(body.gebuehr)));
    }
    if (body.aktion === "test") {
      await sendeAn(userId, "Depot-Alert: Test", "Push-Mitteilungen funktionieren.", "test");
      return json({ ok: true, push: Boolean(VAPID_PRIVATE_KEY) });
    }
    return json({ error: "unbekannte Aktion" }, 400);
  } catch (e) {
    if (e instanceof Hinweis) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
