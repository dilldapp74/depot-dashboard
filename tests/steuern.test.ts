// Tests für Gebühren, Kauflisten und Steuern (handel.ts).
// Ausführen: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ausfuehrungskurs, fifoEntnahme, kauflisten, klasseAus, kryptoRuecklage, neuesSteuerjahr,
  STANDARD_EINSTELLUNGEN as E, verkaufAuswerten,
} from "../supabase/functions/depot/handel.ts";

const nah = (ist: number, soll: number, text = "") => assert.ok(Math.abs(ist - soll) < 0.005, `${text}: ${ist} ≠ ${soll}`);

test("Anlageklasse aus Yahoo-Typ und Symbol", () => {
  assert.equal(klasseAus("CRYPTOCURRENCY", "BTC-EUR"), "krypto");
  assert.equal(klasseAus(undefined, "ETH-EUR"), "krypto");
  assert.equal(klasseAus("ETF", "EUNL.DE"), "etf");
  assert.equal(klasseAus("EQUITY", "SAP.DE"), "aktie");
});

test("Spread: Kauf über, Verkauf unter dem Mittelkurs", () => {
  nah(ausfuehrungskurs(100, "kauf", "aktie"), 100.05, "Aktie Kauf");
  nah(ausfuehrungskurs(100, "verkauf", "aktie"), 99.95, "Aktie Verkauf");
  nah(ausfuehrungskurs(100, "kauf", "krypto"), 100.25, "Krypto Kauf");
});

test("FIFO: ältestes Los zuerst, Kosten anteilig", () => {
  const lose = [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }, { datum: "2026-02-01", anteile: 10, kosten: 1500 }];
  const { teile, rest } = fifoEntnahme(lose, 15);
  assert.equal(teile.length, 2);
  nah(teile[0].kosten, 1000); nah(teile[1].kosten, 750);
  assert.equal(rest.length, 1); nah(rest[0].anteile, 5); nah(rest[0].kosten, 750);
  assert.throws(() => fifoEntnahme(lose, 21), /Nicht genug Anteile/);
});

test("Kauflisten aus Orders inkl. Gebühren", () => {
  const m = kauflisten([
    { zeit: "2026-01-01T10:00", kennung: "SAP.DE", seite: "kauf", anteile: 10, kurs: 100, gebuehr: 1 },
    { zeit: "2026-02-01T10:00", kennung: "SAP.DE", seite: "kauf", anteile: 10, kurs: 120, gebuehr: 1 },
    { zeit: "2026-03-01T10:00", kennung: "SAP.DE", seite: "verkauf", anteile: 12, kurs: 130, gebuehr: 1 },
  ]);
  const l = m.get("SAP.DE")!;
  assert.equal(l.length, 1); nah(l[0].anteile, 8); nah(l[0].kosten, 1201 * 0.8);
});

test("Aktie: Gewinn mit 26,375 % Abgeltungsteuer", () => {
  const sj = neuesSteuerjahr(2026, null);
  const v = verkaufAuswerten("aktie", [{ datum: "2026-01-01", anteile: 10, kosten: 1001 }], 10, 150, 1, "2026-06-01", sj);
  nah(v.realisiert, 498);                 // 1500 − 1 − 1001
  nah(v.steuer, 498 * 0.26375);
  nah(v.sj.aktien_versteuert, 498);
});

test("Aktienverlust erstattet Steuer auf frühere Aktiengewinne im selben Jahr", () => {
  let sj = neuesSteuerjahr(2026, null);
  sj = verkaufAuswerten("aktie", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 150, 0, "2026-03-01", sj).sj;
  const v = verkaufAuswerten("aktie", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 80, 0, "2026-04-01", sj);
  nah(v.realisiert, -200);
  nah(v.steuer, -200 * 0.26375, "Erstattung");
  nah(v.sj.aktien_topf, 0);
});

test("Aktienverlust ohne Vorgewinne geht in den Aktientopf und wird nicht mit ETF-Gewinnen verrechnet", () => {
  let sj = neuesSteuerjahr(2026, null);
  sj = verkaufAuswerten("aktie", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 70, 0, "2026-02-01", sj).sj;
  nah(sj.aktien_topf, 300);
  const etf = verkaufAuswerten("etf", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 120, 0, "2026-03-01", sj);
  nah(etf.steuer, 200 * 0.7 * 0.26375, "ETF-Gewinn voll steuerpflichtig (Teilfreistellung 30 %)");
  nah(etf.sj.aktien_topf, 300, "Aktientopf bleibt");
  const aktie = verkaufAuswerten("aktie", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 120, 0, "2026-04-01", etf.sj);
  nah(aktie.steuer, 0, "Aktiengewinn mit Aktientopf verrechnet");
  nah(aktie.sj.aktien_topf, 100);
});

test("Sonstiger Verlust (ETF) darf auch mit Aktiengewinnen verrechnet werden", () => {
  let sj = neuesSteuerjahr(2026, null);
  sj = verkaufAuswerten("etf", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 90, 0, "2026-02-01", sj).sj;
  nah(sj.allg_topf, 70);                  // 100 Verlust × 70 %
  const v = verkaufAuswerten("aktie", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 110, 0, "2026-03-01", sj);
  nah(v.steuer, 30 * 0.26375);
  nah(v.sj.allg_topf, 0);
});

test("Verlusttöpfe gehen ins nächste Jahr über, versteuerte Gewinne nicht", () => {
  const alt = { ...neuesSteuerjahr(2026, null), aktien_topf: 50, allg_topf: 20, aktien_versteuert: 999 };
  const neu = neuesSteuerjahr(2027, alt);
  assert.equal(neu.aktien_topf, 50); assert.equal(neu.allg_topf, 20); assert.equal(neu.aktien_versteuert, 0);
});

test("Krypto: steuerfrei nach mehr als einem Jahr, sonst in die Jahressumme", () => {
  const lose = [{ datum: "2025-01-01", anteile: 1, kosten: 30000 }, { datum: "2026-03-01", anteile: 1, kosten: 50000 }];
  const v = verkaufAuswerten("krypto", lose, 2, 60000, 0, "2026-06-01", neuesSteuerjahr(2026, null));
  nah(v.steuerfrei, 30000, "altes Los steuerfrei");
  nah(v.sj.krypto_netto, 10000, "junges Los steuerpflichtig");
  assert.equal(v.steuer, 0, "Krypto-Steuer läuft über die Rücklage");
});

test("Krypto-Freigrenze: unter 1.000 € frei, darüber alles steuerpflichtig", () => {
  assert.equal(kryptoRuecklage({ ...neuesSteuerjahr(2026, null), krypto_netto: 999 }), 0);
  nah(kryptoRuecklage({ ...neuesSteuerjahr(2026, null), krypto_netto: 1000 }), 350);
  nah(kryptoRuecklage({ ...neuesSteuerjahr(2026, null), krypto_netto: 4000 }), 1400);
  assert.equal(kryptoRuecklage({ ...neuesSteuerjahr(2026, null), krypto_netto: -500 }), 0);
});

test("Einstellungen: Pauschbetrag wird vor der Steuer genutzt", () => {
  const e = { ...E, pauschbetrag: 1000 };
  const v = verkaufAuswerten("aktie", [{ datum: "2026-01-01", anteile: 10, kosten: 1000 }], 10, 250, 0, "2026-02-01", neuesSteuerjahr(2026, null, e), e);
  nah(v.steuer, 500 * 0.26375);
  nah(v.sj.pausch_rest, 0);
});
