// Tests für Strategie, Ausführung und Backtest (handel.ts) mit künstlichen Kursreihen.
// Ausführen: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anteileVon, backtest, type Bar, freiesGeld, handelstag, jahreswechsel, kaufen, kryptoBremse, marktfilter,
  neuesDepot, OFFENSIV, rangliste, type Reihen, rotationPlanen, stand, stopFaellig, verkaufen, type Wert,
} from "../supabase/functions/depot/handel.ts";

/** Kalendertägliche Reihe ab 2025-01-01 mit täglichem Wachstum `g` (Krypto-artig: jeden Tag ein Kurs) */
function reihe(tage: number, start: number, g: (i: number) => number, wochentage = false): Bar[] {
  const out: Bar[] = []; let k = start;
  for (let i = 0; i < tage; i++) {
    const t = new Date(Date.UTC(2025, 0, 1) + i * 864e5);
    k *= 1 + g(i);
    if (wochentage && (t.getUTCDay() === 0 || t.getUTCDay() === 6)) continue;
    out.push({ tag: t.toISOString().slice(0, 10), kurs: k });
  }
  return out;
}
const tagNr = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10);
const wackel = (basis: number) => (i: number) => basis + (i % 2 ? 0.004 : -0.004);   // etwas Schwankung für die Volatilität

const werte: Wert[] = [
  { kennung: "STARK", name: "Stark", klasse: "aktie" }, { kennung: "MITTEL", name: "Mittel", klasse: "aktie" },
  { kennung: "FALLEND", name: "Fallend", klasse: "aktie" }, { kennung: "EUNL.DE", name: "Welt", klasse: "etf" },
  { kennung: "BTC-EUR", name: "Bitcoin", klasse: "krypto" },
];
function testReihen(): Reihen {
  return new Map([
    ["STARK", reihe(500, 100, wackel(0.004), true)], ["MITTEL", reihe(500, 100, wackel(0.001), true)],
    ["FALLEND", reihe(500, 100, wackel(-0.002), true)], ["EUNL.DE", reihe(500, 100, wackel(0.0005), true)],
    ["BTC-EUR", reihe(500, 100, wackel(0.002))],
  ]);
}

test("stand(): letzter Kurs bis zum Tag, auch am Wochenende", () => {
  const b = reihe(30, 100, () => 0, true);
  const sa = "2025-01-04";                               // Samstag
  assert.equal(b[stand(b, sa)].tag, "2025-01-03");
  assert.equal(stand(b, "2024-12-31"), -1);
});

test("Rangliste: stärkster Wert zuerst, fallender Wert ohne Trend", () => {
  const r = rangliste(werte, testReihen(), tagNr(400));
  assert.equal(r[0].kennung, "STARK");
  const f = r.find((x) => x.kennung === "FALLEND")!;
  assert.equal(f.trendOk, false);
  assert.ok(r.every((x, i) => i === 0 || r[i - 1].score >= x.score));
});

test("Marktfilter: fallender Weltindex sperrt Aktienkäufe, Krypto bleibt erlaubt", () => {
  const reihen = testReihen();
  reihen.set("EUNL.DE", reihe(500, 100, wackel(-0.002), true));
  const f = marktfilter(reihen, tagNr(400));
  assert.equal(f.aktie, false); assert.equal(f.etf, false); assert.equal(f.krypto, true);
});

test("Umschichtung: kauft die besten erlaubten Werte, nichts Fallendes", () => {
  const plan = rotationPlanen(werte, testReihen(), tagNr(400), [], 25000, new Map());
  const kaeufe = plan.orders.filter((o) => o.seite === "kauf").map((o) => o.kennung);
  assert.ok(kaeufe.includes("STARK"));
  assert.ok(!kaeufe.includes("FALLEND"));
  for (const o of plan.orders) assert.ok(o.betrag! <= 25000 * 0.35 + 1, "höchstens 35 % je Wert");
});

test("Umschichtung: gehaltener Wert mit gebrochenem Trend wird verkauft – mit Begründung", () => {
  const bestand = [{ kennung: "FALLEND", klasse: "aktie" as const, lose: [{ datum: tagNr(10), anteile: 10, kosten: 1000 }] }];
  const plan = rotationPlanen(werte, testReihen(), tagNr(400), bestand, 20000, new Map());
  const v = plan.orders.find((o) => o.kennung === "FALLEND")!;
  assert.equal(v.seite, "verkauf"); assert.match(v.grund, /Trend gebrochen/);
  assert.equal(plan.orders[0].seite, "verkauf", "erst verkaufen, dann kaufen");
});

test("Gesperrte Werte (nach Stop) werden nicht gekauft", () => {
  const plan = rotationPlanen(werte, testReihen(), tagNr(400), [], 25000, new Map([["STARK", tagNr(405)]]));
  assert.ok(!plan.orders.some((o) => o.kennung === "STARK"));
});

test("Stop-Loss: Grundeinstellung 25 %, einstellbar (hier 15 %)", () => {
  const b: Bar[] = [{ tag: "2025-01-01", kurs: 100 }, { tag: "2025-01-02", kurs: 120 }, { tag: "2025-01-03", kurs: 108 }, { tag: "2025-01-06", kurs: 101 }];
  const reihen: Reihen = new Map([["X", b]]);
  const p = { kennung: "X", klasse: "aktie" as const, lose: [{ datum: "2025-01-01", anteile: 1, kosten: 100 }] };
  const st15 = { ...OFFENSIV, stop: { aktie: 15, etf: 15, krypto: 20 } };
  assert.equal(stopFaellig(p, reihen, "2025-01-03", st15).faellig, false);   // −10 %
  const s = stopFaellig(p, reihen, "2025-01-06", st15);                      // −15,8 %
  assert.equal(s.faellig, true); assert.equal(s.hoch, 120);
  assert.equal(stopFaellig(p, reihen, "2025-01-06").faellig, false, "−15,8 % reicht bei 25 % nicht");
  const tief: Reihen = new Map([["X", [...b, { tag: "2025-01-07", kurs: 89 }]]]);
  assert.equal(stopFaellig(p, tief, "2025-01-07").faellig, true, "−25,8 % löst aus");
});

test("Krypto-Bremse: Gewinn kurz vor Ablauf der Haltefrist wird gehalten", () => {
  const p = { kennung: "BTC-EUR", klasse: "krypto" as const, lose: [{ datum: "2025-01-01", anteile: 1, kosten: 50000 }] };
  assert.equal(kryptoBremse(p, 60000, "2025-12-10"), true);            // 343 Tage, im Gewinn
  assert.equal(kryptoBremse(p, 40000, "2025-12-10"), false);           // im Verlust
  assert.equal(kryptoBremse(p, 60000, "2025-10-01"), false);           // noch zu früh
  assert.equal(kryptoBremse(p, 60000, "2026-01-05"), false);           // Haltefrist schon vorbei
});

test("Kauf und Verkauf: Gebühr, Spread und Steuer werden vom Bargeld abgezogen", () => {
  const d = neuesDepot(10000, 2026);
  const k = kaufen(d, { kennung: "A", klasse: "aktie" }, 100, 5001, "2026-01-02", "Test")!;
  assert.ok(Math.abs(d.bargeld - 4999) < 1e-6, "5.001 € inkl. 1 € Gebühr");
  assert.ok(k.spread > 0);
  const v = verkaufen(d, "A", 120, anteileVon(d.bestand.get("A")!), "2026-02-02", "Test")!;
  assert.ok(v.realisiert! > 900 && v.realisiert! < 1000, `Gewinn ${v.realisiert}`);
  assert.ok(Math.abs(v.steuer! - v.realisiert! * 0.26375) < 0.01);
  assert.equal(d.bestand.size, 0);
  assert.equal(d.summen.orders, 2);
});

test("Krypto-Rücklage verringert das freie Geld und wird zum Jahreswechsel abgebucht", () => {
  const d = neuesDepot(10000, 2026);
  kaufen(d, { kennung: "BTC-EUR", klasse: "krypto" }, 50000, 5001, "2026-01-02", "Test");
  verkaufen(d, "BTC-EUR", 70000, anteileVon(d.bestand.get("BTC-EUR")!), "2026-06-01", "Test");
  const ruecklage = d.bargeld - freiesGeld(d);
  assert.ok(ruecklage > 600, `Rücklage ${ruecklage}`);                 // ~1.950 € Gewinn × 35 %
  const vorher = d.bargeld;
  assert.ok(Math.abs(jahreswechsel(d, 2027) - ruecklage) < 0.01);
  assert.ok(Math.abs(d.bargeld - (vorher - ruecklage)) < 0.01);
  assert.equal(d.sj.jahr, 2027); assert.equal(d.sj.krypto_netto, 0);
});

test("Handelstag: Aktien nur bei offener Börse, Prüfung kann Käufe ablehnen", () => {
  const d = neuesDepot(25000, 2025), reihen = testReihen();
  const abgelehnt: string[] = [];
  handelstag(d, werte, reihen, tagNr(400), true, (k) => k === "BTC-EUR", OFFENSIV, undefined,
    (o) => { abgelehnt.push(o.kennung); return false; });
  assert.equal(d.bestand.size, 0, "alles abgelehnt bzw. Börse zu");
  assert.ok(abgelehnt.every((k) => k === "BTC-EUR"), "nur handelbare Werte werden geprüft");
});

test("Backtest läuft durch und verbucht Gebühren und Steuern", () => {
  const r = backtest(werte, testReihen(), tagNr(250), tagNr(480), 25000);
  assert.ok(r.depot.summen.orders > 0);
  assert.ok(r.depot.summen.gebuehren === r.depot.summen.orders * 1);
  assert.ok(r.verlauf.length > 200);
  assert.ok(r.kennzahlen.endwert > 0);
});
