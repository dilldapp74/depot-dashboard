// Backtest des Handelsautomaten auf dem eigenen Rechner (Node ≥ 22.18, ohne Installation).
//   node scripts/backtest.ts [Jahre=3] [Startkapital=25000]
// Lädt 5 Jahre Tageskurse von Yahoo (zwischengespeichert in .cache/, gilt 12 Stunden), rechnet in Euro um
// (Wechselkurs des jeweiligen Tages) und spielt die Strategie mit Gebühren, Spread und Steuern durch.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { backtest, type Bar, kaufenUndHalten, OFFENSIV, type Reihen, stand } from "../supabase/functions/depot/handel.ts";
import { UNIVERSUM } from "../supabase/functions/depot/universum.ts";

const jahre = Number(process.argv[2] ?? 3), start = Number(process.argv[3] ?? 25000);
const CACHE = new URL("../.cache/", import.meta.url);
mkdirSync(CACHE, { recursive: true });

async function verlaufLaden(symbol: string): Promise<{ bars: Bar[]; waehrung: string } | null> {
  const datei = new URL(`${symbol.replace(/[^A-Za-z0-9.=-]/g, "_")}.json`, CACHE);
  try { if (Date.now() - statSync(datei).mtimeMs < 12 * 3600e3) return JSON.parse(readFileSync(datei, "utf8")); } catch { /* neu laden */ }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (depot-dashboard backtest)" } });
  if (!r.ok) return null;
  const res = (await r.json())?.chart?.result?.[0];
  if (!res?.timestamp) return null;
  const closes: (number | null)[] = res.indicators.quote[0].close;
  const tageMap = new Map<string, number>();
  res.timestamp.forEach((t: number, i: number) => { const c = closes[i]; if (c != null) tageMap.set(new Date(t * 1000).toISOString().slice(0, 10), c); });
  const out = { bars: [...tageMap].map(([tag, kurs]) => ({ tag, kurs })), waehrung: res.meta.currency };
  writeFileSync(datei, JSON.stringify(out));
  return out;
}

const fx = await verlaufLaden("EURUSD=X");
const reihen: Reihen = new Map(), fehlt: string[] = [];
for (const w of UNIVERSUM) {
  const v = await verlaufLaden(w.kennung);
  if (!v || v.bars.length < 300) { fehlt.push(w.kennung); continue; }
  if (v.waehrung === "EUR") reihen.set(w.kennung, v.bars);
  else if (v.waehrung === "USD" && fx) {
    reihen.set(w.kennung, v.bars.map((b) => { const i = stand(fx.bars, b.tag); return { tag: b.tag, kurs: b.kurs / fx.bars[Math.max(i, 0)].kurs }; }));
  } else fehlt.push(`${w.kennung} (${v.waehrung})`);
}

const bis = [...reihen.get("BTC-EUR")!].at(-1)!.tag;
const von = new Date(Date.parse(bis) - jahre * 365 * 864e5).toISOString().slice(0, 10);
const werte = UNIVERSUM.filter((w) => reihen.has(w.kennung));
const bt = backtest(werte, reihen, von, bis, start, OFFENSIV);
const welt = kaufenUndHalten(werte.find((w) => w.kennung === "EUNL.DE")!, reihen, von, bis, start);
const btc = kaufenUndHalten(werte.find((w) => w.kennung === "BTC-EUR")!, reihen, von, bis, start);

const eur = (x: number) => x.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " €";
const pct = (x: number) => (x >= 0 ? "+" : "") + x.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " %";
const s = bt.depot.summen;
console.log(`Backtest ${von} bis ${bis} · Start ${eur(start)} · ${werte.length} Werte${fehlt.length ? ` (ohne ${fehlt.join(", ")})` : ""}`);
console.log(`\nAutomat (offensiv)`);
console.log(`  Endwert vor Steuern auf offene Gewinne: ${eur(bt.kennzahlen.endwert)}  ${pct(bt.kennzahlen.rendite)} · ${pct(bt.kennzahlen.jahresrendite)} p. a. · größter Rückgang ${pct(bt.kennzahlen.max_rueckgang)}`);
console.log(`  Endwert nach allen Steuern (als ob heute alles verkauft würde): ${eur(bt.nach_steuern.endwert)}  ${pct(bt.nach_steuern.rendite)}`);
console.log(`  Orders ${s.orders} · Gebühren ${eur(s.gebuehren)} · Spread ${eur(s.spread)} · Abgeltungsteuer ${eur(s.abgeltung)} · Krypto-Steuer ${eur(s.krypto_steuer)}`);
console.log(`\nVergleich: am Start kaufen und halten`);
console.log(`  MSCI World: ${eur(welt.kennzahlen.endwert)} ${pct(welt.kennzahlen.rendite)} · größter Rückgang ${pct(welt.kennzahlen.max_rueckgang)} · nach Steuern ${eur(welt.endwert_nach_steuern)}`);
console.log(`  Bitcoin:    ${eur(btc.kennzahlen.endwert)} ${pct(btc.kennzahlen.rendite)} · größter Rückgang ${pct(btc.kennzahlen.max_rueckgang)} · nach Steuern ${eur(btc.endwert_nach_steuern)}`);
console.log(`\nJahre (Wert am Jahresende, vor Steuern auf offene Gewinne):`);
for (const [tag, wert] of bt.verlauf.filter(([t], i, a) => i === a.length - 1 || a[i + 1][0].slice(0, 4) !== t.slice(0, 4))) console.log(`  ${tag}: ${eur(wert)}`);
console.log(`\nBestand am Ende: ${bt.bestand.map((b) => `${b.kennung} ${eur(b.wert)}`).join(", ") || "nur Bargeld"} · Bargeld ${eur(bt.depot.bargeld)}`);
console.log(`\nLetzte 12 Orders:`);
for (const o of bt.protokoll.slice(-12)) console.log(`  ${o.tag} ${o.seite === "kauf" ? "Kauf   " : "Verkauf"} ${o.kennung.padEnd(8)} ${eur(o.anteile * o.kurs).padStart(9)}${o.steuer ? ` Steuer ${eur(o.steuer)}` : ""} – ${o.grund}`);
const haeufig = new Map<string, number>(); for (const o of bt.protokoll) if (o.seite === "kauf") haeufig.set(o.kennung, (haeufig.get(o.kennung) ?? 0) + 1);
console.log(`\nAm häufigsten gekauft: ${[...haeufig].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}×`).join(", ")}`);
const stops = bt.protokoll.filter((o) => o.grund.startsWith("Stop")).length;
console.log(`Stop-Loss ausgelöst: ${stops}×`);
writeFileSync(new URL("backtest-ergebnis.json", CACHE), JSON.stringify({ von, bis, kennzahlen: bt.kennzahlen, nach_steuern: bt.nach_steuern,
  summen: s, verlauf: bt.verlauf, welt: welt.verlauf, btc: btc.verlauf, protokoll: bt.protokoll }));
