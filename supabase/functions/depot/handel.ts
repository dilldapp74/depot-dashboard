// Reine Rechenlogik für das Spieldepot: Gebühren, Kauflisten (FIFO), Steuern (Deutschland, vereinfacht),
// Strategie und Backtest. Ohne Abhängigkeiten – läuft in der Edge Function (Deno), in den Tests und im
// Backtest-Skript (Node). Live-Betrieb und Backtest rechnen dadurch garantiert gleich.
//
// Alles hier sind vereinfachte Annahmen für ein Spieldepot – keine Steuerberatung, keine Anlageempfehlung.

// ================================================================ Grundlagen

export type Klasse = "aktie" | "etf" | "krypto";
export type Seite = "kauf" | "verkauf";

export type Einstellungen = {
  gebuehr: number;                       // € je Order (Fremdkostenpauschale)
  spread: Record<Klasse, number>;        // ganzer Spread in % – je Seite wird die Hälfte fällig
  abgeltung: number;                     // % Abgeltungsteuer inkl. Soli (25 % × 1,055 = 26,375 %)
  krypto_satz: number;                   // % persönlicher Steuersatz für Krypto innerhalb der Haltefrist
  krypto_freigrenze: number;             // € je Jahr: darunter bleiben private Veräußerungsgewinne steuerfrei
  teilfreistellung_etf: number;          // % steuerfreier Anteil bei Aktien-ETFs
  pauschbetrag: number;                  // € Sparer-Pauschbetrag (0 = bei echten Depots schon genutzt)
};

export const STANDARD_EINSTELLUNGEN: Einstellungen = {
  gebuehr: 1,
  spread: { aktie: 0.1, etf: 0.1, krypto: 0.5 },
  abgeltung: 26.375,
  krypto_satz: 35,
  krypto_freigrenze: 1000,
  teilfreistellung_etf: 30,
  pauschbetrag: 0,
};

const rund2 = (x: number) => Math.round(x * 100) / 100;
export const tageZwischen = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/** Anlageklasse aus dem Instrumenttyp von Yahoo (bzw. dem Symbol als Rückfall) */
export function klasseAus(instrumentType?: string, symbol = ""): Klasse {
  const t = (instrumentType ?? "").toUpperCase();
  if (t === "CRYPTOCURRENCY" || /-(EUR|USD)$/.test(symbol)) return "krypto";
  if (t === "ETF" || t === "MUTUALFUND") return "etf";
  return "aktie";
}

/** Ausführungskurs: Kauf etwas über, Verkauf etwas unter dem Mittelkurs (halber Spread je Seite) */
export function ausfuehrungskurs(mittel: number, seite: Seite, klasse: Klasse, e = STANDARD_EINSTELLUNGEN): number {
  const halb = e.spread[klasse] / 200;
  return seite === "kauf" ? mittel * (1 + halb) : mittel * (1 - halb);
}

// ================================================================ Kauflisten (FIFO)

/** Ein Kauf-Los: wann gekauft, wie viele Anteile, was sie samt Nebenkosten gekostet haben */
export type Los = { datum: string; anteile: number; kosten: number };
export type OrderZeile = { zeit: string; kennung: string; seite: Seite; anteile: number; kurs: number; gebuehr: number };

/** Entnimmt `anteile` in Kaufreihenfolge (FIFO). Gibt die entnommenen Teile und die verbleibenden Lose zurück. */
export function fifoEntnahme(lose: Los[], anteile: number): { teile: Los[]; rest: Los[] } {
  const teile: Los[] = [], rest: Los[] = [];
  let offen = anteile;
  for (const l of lose) {
    if (offen <= 1e-12) { rest.push({ ...l }); continue; }
    const nimm = Math.min(l.anteile, offen);
    const anteilKosten = l.kosten * (nimm / l.anteile);
    teile.push({ datum: l.datum, anteile: nimm, kosten: anteilKosten });
    if (l.anteile - nimm > 1e-12) rest.push({ datum: l.datum, anteile: l.anteile - nimm, kosten: l.kosten - anteilKosten });
    offen -= nimm;
  }
  if (offen > 1e-9) throw new Error(`Nicht genug Anteile: es fehlen ${offen}`);
  return { teile, rest };
}

/** Kauflisten je Kennung aus der Orderliste (älteste zuerst) */
export function kauflisten(orders: OrderZeile[]): Map<string, Los[]> {
  const m = new Map<string, Los[]>();
  for (const o of [...orders].sort((a, b) => a.zeit.localeCompare(b.zeit))) {
    const lose = m.get(o.kennung) ?? [];
    if (o.seite === "kauf") {
      m.set(o.kennung, [...lose, { datum: o.zeit.slice(0, 10), anteile: o.anteile, kosten: o.anteile * o.kurs + o.gebuehr }]);
    } else {
      m.set(o.kennung, fifoEntnahme(lose, o.anteile).rest);
    }
  }
  return m;
}

// ================================================================ Steuern (vereinfacht, Privatperson in Deutschland)

/**
 * Steuerstand eines Kalenderjahres.
 * - Aktienverluste dürfen nur mit Aktiengewinnen verrechnet werden (Aktientopf), alle anderen Verluste mit allem.
 * - Wie bei einer Bank: Ein Verlust nach bereits versteuerten Gewinnen im selben Jahr erstattet Steuer zurück.
 * - Krypto (privates Veräußerungsgeschäft): nur Gewinne innerhalb eines Jahres Haltedauer zählen;
 *   liegt die Jahressumme unter der Freigrenze, bleibt alles steuerfrei, sonst ist alles steuerpflichtig.
 */
export type Steuerjahr = {
  jahr: number;
  aktien_topf: number;          // nicht verrechnete Aktienverluste (wird ins nächste Jahr übernommen)
  allg_topf: number;            // nicht verrechnete sonstige Verluste (wird übernommen)
  aktien_versteuert: number;    // in diesem Jahr bereits versteuerte Aktiengewinne (für Erstattungen)
  sonst_versteuert: number;     // in diesem Jahr bereits versteuerte sonstige Gewinne
  pausch_rest: number;          // noch freier Sparer-Pauschbetrag
  krypto_netto: number;         // Summe kurzfristiger Krypto-Gewinne/-Verluste im Jahr
  abgeltung_gezahlt: number;    // Summe gezahlter (abzüglich erstatteter) Abgeltungsteuer
};

export function neuesSteuerjahr(jahr: number, vorjahr: Steuerjahr | null, e = STANDARD_EINSTELLUNGEN): Steuerjahr {
  return { jahr, aktien_topf: vorjahr?.aktien_topf ?? 0, allg_topf: vorjahr?.allg_topf ?? 0, aktien_versteuert: 0,
    sonst_versteuert: 0, pausch_rest: e.pauschbetrag, krypto_netto: 0, abgeltung_gezahlt: 0 };
}

/** Steuer, die für das laufende Krypto-Jahr zurückzulegen ist (Freigrenze: unter dem Betrag bleibt alles frei) */
export function kryptoRuecklage(sj: Steuerjahr, e = STANDARD_EINSTELLUNGEN): number {
  return sj.krypto_netto >= e.krypto_freigrenze ? rund2(sj.krypto_netto * e.krypto_satz / 100) : 0;
}

export type VerkaufErgebnis = {
  realisiert: number;     // Gewinn/Verlust vor Steuern (Erlös nach Gebühr minus Anschaffungskosten)
  steuer: number;         // sofort fällige Abgeltungsteuer (negativ = Erstattung); Krypto: 0 (über die Rücklage)
  steuerfrei: number;     // Krypto: Gewinnanteil nach mehr als einem Jahr Haltedauer
  sj: Steuerjahr;         // neuer Steuerstand
  rest: Los[];            // verbleibende Lose
};

/** Verkauf auswerten: FIFO-Entnahme, Gewinn, Steuer und neuer Steuerstand */
export function verkaufAuswerten(klasse: Klasse, lose: Los[], anteile: number, kurs: number, gebuehr: number,
  datum: string, sjAlt: Steuerjahr, e = STANDARD_EINSTELLUNGEN): VerkaufErgebnis {
  const { teile, rest } = fifoEntnahme(lose, anteile);
  const erloes = anteile * kurs - gebuehr;
  const kosten = teile.reduce((s, t) => s + t.kosten, 0);
  const realisiert = erloes - kosten;
  const sj = { ...sjAlt };
  const satz = e.abgeltung / 100;
  let steuer = 0, steuerfrei = 0;

  if (klasse === "krypto") {
    for (const t of teile) {
      const g = erloes * (t.anteile / anteile) - t.kosten;
      if (tageZwischen(t.datum, datum) > 365) steuerfrei += g;
      else sj.krypto_netto += g;
    }
  } else {
    // Aktien-ETFs: nur 70 % des Ergebnisses sind steuerlich relevant (Teilfreistellung)
    const g = klasse === "etf" ? realisiert * (1 - e.teilfreistellung_etf / 100) : realisiert;
    if (g >= 0) {
      let rest = g;
      const nutze = (topf: "aktien_topf" | "allg_topf") => { const n = Math.min(rest, sj[topf]); sj[topf] -= n; rest -= n; };
      if (klasse === "aktie") nutze("aktien_topf");
      nutze("allg_topf");
      const p = Math.min(rest, sj.pausch_rest); sj.pausch_rest -= p; rest -= p;
      steuer = rest * satz;
      if (klasse === "aktie") sj.aktien_versteuert += rest; else sj.sonst_versteuert += rest;
    } else {
      let verlust = -g;
      const erstatte = (feld: "aktien_versteuert" | "sonst_versteuert") => {
        const n = Math.min(verlust, sj[feld]); sj[feld] -= n; verlust -= n; steuer -= n * satz;
      };
      if (klasse === "aktie") { erstatte("aktien_versteuert"); sj.aktien_topf += verlust; }
      else { erstatte("sonst_versteuert"); erstatte("aktien_versteuert"); sj.allg_topf += verlust; }
    }
    steuer = rund2(steuer);
    sj.abgeltung_gezahlt = rund2(sj.abgeltung_gezahlt + steuer);
  }
  return { realisiert: rund2(realisiert), steuer, steuerfrei: rund2(steuerfrei), sj, rest };
}

// ================================================================ Strategie: Momentum mit Trend- und Marktfilter
//
// Wöchentlich: alle Werte nach Momentum (3- und 6-Monats-Rendite, geteilt durch die Schwankung) ordnen.
// Gekauft werden nur Werte über ihrem gleitenden Durchschnitt, und nur wenn der jeweilige Gesamtmarkt
// (Weltaktien-ETF bzw. Bitcoin) über seinem 200-Tage-Schnitt liegt. Gehalten werden die besten `anzahl`.
// Täglich: nachgezogener Stop-Loss. Krypto kurz vor Ablauf der Haltefrist wird nicht umgeschichtet.

export type Wert = { kennung: string; name: string; klasse: Klasse };   // kennung = Yahoo-Symbol
export type Bar = { tag: string; kurs: number };                         // Tagesschluss in EUR
export type Reihen = Map<string, Bar[]>;                                 // je Kennung, älteste zuerst

export type Strategie = {
  anzahl: number;               // so viele Werte werden gehalten
  halten_bis_rang: number;      // ein gehaltener Wert bleibt, solange er unter den besten N ist
  max_anteil: number;           // % höchstens je Wert
  stop: Record<Klasse, number>; // % nachgezogener Stop-Loss unter dem Hoch seit Kauf
  trend_tage: number;           // gleitender Durchschnitt für den Trendfilter je Wert
  markt_tage: number;           // gleitender Durchschnitt für den Marktfilter
  min_order: number;            // € kleinste sinnvolle Order
  sperre_nach_stop: number;     // Tage ohne Wiederkauf nach einem Stop
  umschichten_ab: number;       // Prozentpunkte Abweichung, ab der eine gehaltene Position angepasst wird
  krypto_bremse_tage: number;   // ab dieser Haltedauer (bis 365) wird ein Krypto-Gewinn nicht umgeschichtet
};

export const OFFENSIV: Strategie = {
  // Stop-Loss 25/30 %: engere Stops (15/20 %) verkauften im Backtest oft kurz vor der Erholung
  anzahl: 4, halten_bis_rang: 8, max_anteil: 35, stop: { aktie: 25, etf: 25, krypto: 30 },
  trend_tage: 100, markt_tage: 200, min_order: 200, sperre_nach_stop: 5, umschichten_ab: 10, krypto_bremse_tage: 330,
};

/** Bezugswerte für den Marktfilter */
export const MARKT: Record<Klasse, string> = { aktie: "EUNL.DE", etf: "EUNL.DE", krypto: "BTC-EUR" };

/** Index des letzten Tagesschlusses bis einschließlich `tag` (−1 = keiner) */
export function stand(bars: Bar[], tag: string): number {
  let lo = 0, hi = bars.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].tag <= tag) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}
const sma = (b: Bar[], i: number, n: number) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += b[k].kurs; return s / n; };
const ret = (b: Bar[], i: number, n: number) => b[i].kurs / b[i - n].kurs - 1;
function vol(b: Bar[], i: number, n: number, jahr: number) {
  const r: number[] = [];
  for (let k = i - n + 1; k <= i; k++) r.push(Math.log(b[k].kurs / b[k - 1].kurs));
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1) * jahr);
}
/** Rückblick in Kursbalken: Aktien handeln ~252 Tage im Jahr, Krypto 365 */
const fenster = (k: Klasse) => k === "krypto" ? { m1: 91, m2: 182, vol: 91, jahr: 365 } : { m1: 63, m2: 126, vol: 63, jahr: 252 };

/** Abstand des Kurses zu seinem gleitenden Durchschnitt (0.05 = 5 % darüber); null = zu wenig Geschichte */
export function abstandZumSchnitt(b: Bar[] | undefined, tag: string, n: number): number | null {
  if (!b) return null;
  const i = stand(b, tag);
  return i < n ? null : b[i].kurs / sma(b, i, n) - 1;
}

// vol = Schwankung pro Jahr, trend = Abstand zum Trend-Schnitt – beides nur für die Begründung in der App
export type Rang = { kennung: string; klasse: Klasse; score: number; kurs: number; trendOk: boolean; r3: number; r6: number;
  vol: number; trend: number };

/** Alle Werte nach Momentum ordnen (bester zuerst) */
export function rangliste(werte: Wert[], reihen: Reihen, tag: string, st = OFFENSIV): Rang[] {
  const out: Rang[] = [];
  for (const w of werte) {
    const b = reihen.get(w.kennung);
    if (!b) continue;
    const i = stand(b, tag), f = fenster(w.klasse);
    if (i < Math.max(f.m2, st.trend_tage) + 1) continue;               // zu wenig Geschichte
    if (tageZwischen(b[i].tag, tag) > 6) continue;                       // kein aktueller Kurs (z. B. Delisting)
    const r3 = ret(b, i, f.m1), r6 = ret(b, i, f.m2), v = vol(b, i, f.vol, f.jahr);
    const score = (0.5 * r3 + 0.5 * r6) / Math.max(v, 0.05);
    const trend = b[i].kurs / sma(b, i, st.trend_tage) - 1;
    out.push({ kennung: w.kennung, klasse: w.klasse, score, kurs: b[i].kurs, trendOk: trend > 0, r3, r6, vol: v, trend });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Marktfilter: true = in dieser Klasse darf gekauft werden */
export function marktfilter(reihen: Reihen, tag: string, st = OFFENSIV): Record<Klasse, boolean> {
  const ok = (kennung: string) => {
    const a = abstandZumSchnitt(reihen.get(kennung), tag, st.markt_tage);
    return a === null || a > 0;
  };
  const aktien = ok(MARKT.aktie);
  return { aktie: aktien, etf: aktien, krypto: ok(MARKT.krypto) };
}

export type Position = { kennung: string; klasse: Klasse; lose: Los[] };
export const anteileVon = (p: Position) => p.lose.reduce((s, l) => s + l.anteile, 0);

/** Nachgezogener Stop-Loss: Kurs mehr als X % unter dem höchsten Schlusskurs seit dem ersten Kauf? */
export function stopFaellig(p: Position, reihen: Reihen, tag: string, st = OFFENSIV) {
  const b = reihen.get(p.kennung);
  if (!b || !p.lose.length) return { faellig: false, hoch: 0, kurs: 0 };
  const i = stand(b, tag), seit = p.lose[0].datum;
  let hoch = 0;
  for (let k = i; k >= 0 && b[k].tag >= seit; k--) hoch = Math.max(hoch, b[k].kurs);
  hoch = Math.max(hoch, p.lose[0].kosten / p.lose[0].anteile);           // mindestens der Kaufkurs
  const kurs = b[i].kurs;
  return { faellig: kurs < hoch * (1 - st.stop[p.klasse] / 100), hoch, kurs };
}

/** Krypto-Bremse: Gewinn-Los kurz vor Ablauf der einjährigen Haltefrist → nicht umschichten */
export function kryptoBremse(p: Position, kurs: number, tag: string, st = OFFENSIV): boolean {
  if (p.klasse !== "krypto") return false;
  return p.lose.some((l) => { const alter = tageZwischen(l.datum, tag);
    return alter >= st.krypto_bremse_tage && alter <= 365 && kurs * l.anteile > l.kosten; });
}

export type PlanOrder = { kennung: string; klasse: Klasse; seite: Seite; anteile?: number; betrag?: number; grund: string };

/** Wöchentliche Umschichtung planen. `frei` = verfügbares Bargeld (ohne Steuerrücklage). */
export function rotationPlanen(werte: Wert[], reihen: Reihen, tag: string, bestand: Position[], frei: number,
  gesperrt: Map<string, string>, st = OFFENSIV): { orders: PlanOrder[]; rangliste: Rang[]; filter: Record<Klasse, boolean> } {
  const liste = rangliste(werte, reihen, tag, st), filter = marktfilter(reihen, tag, st);
  const erlaubt = liste.filter((r) => r.trendOk && filter[r.klasse] && !((gesperrt.get(r.kennung) ?? "") > tag));
  const rang = new Map(erlaubt.map((r, i) => [r.kennung, i]));
  const kursVon = (k: string) => { const b = reihen.get(k); return b ? b[stand(b, tag)].kurs : 0; };
  const wertVon = (p: Position) => anteileVon(p) * kursVon(p.kennung);
  const gesamt = frei + bestand.reduce((s, p) => s + wertVon(p), 0);

  const ziele: string[] = [];
  for (const p of bestand) {
    const r = rang.get(p.kennung);
    if ((r !== undefined && r < st.halten_bis_rang) || kryptoBremse(p, kursVon(p.kennung), tag, st)) ziele.push(p.kennung);
  }
  for (const r of erlaubt) { if (ziele.length >= st.anzahl) break; if (!ziele.includes(r.kennung)) ziele.push(r.kennung); }

  const orders: PlanOrder[] = [];
  for (const p of bestand) if (!ziele.includes(p.kennung)) {
    const r = liste.find((x) => x.kennung === p.kennung);
    const grund = !r ? "keine aktuellen Kurse" : !filter[p.klasse] ? `Marktfilter: ${MARKT[p.klasse]} unter ${st.markt_tage}-Tage-Schnitt`
      : !r.trendOk ? `Trend gebrochen (unter ${st.trend_tage}-Tage-Schnitt)` : `nicht mehr unter den besten ${st.halten_bis_rang}`;
    orders.push({ kennung: p.kennung, klasse: p.klasse, seite: "verkauf", anteile: anteileVon(p), grund });
  }
  const zielBetrag = gesamt * Math.min(1 / st.anzahl, st.max_anteil / 100);
  for (const k of ziele) {
    const p = bestand.find((x) => x.kennung === k), r = liste.find((x) => x.kennung === k);
    const klasse = p?.klasse ?? r!.klasse, ist = p ? wertVon(p) : 0, diff = zielBetrag - ist;
    // Platz in der vollständigen Rangliste – dieselbe Zählung wie in der Begründung in der App
    const platz = r ? liste.indexOf(r) + 1 : 0, proz = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1).replace(".", ",") + " %";
    if (!p) {
      if (diff >= st.min_order) orders.push({ kennung: k, klasse, seite: "kauf", betrag: diff,
        grund: `Platz ${platz} der Rangliste · ${proz(r!.r3)} in 3 Monaten, ${proz(r!.r6)} in 6 Monaten` });
    } else if (Math.abs(diff) / gesamt * 100 > st.umschichten_ab && Math.abs(diff) >= st.min_order) {
      if (diff > 0) orders.push({ kennung: k, klasse, seite: "kauf", betrag: diff, grund: `aufstocken auf ${(zielBetrag / gesamt * 100).toFixed(0)} %` });
      else if (!kryptoBremse(p, kursVon(k), tag, st)) {
        orders.push({ kennung: k, klasse, seite: "verkauf", anteile: Math.min(-diff / kursVon(k), anteileVon(p)),
          grund: `reduzieren auf ${(zielBetrag / gesamt * 100).toFixed(0)} %` });
      }
    }
  }
  // erst verkaufen, dann kaufen
  orders.sort((a, b) => (a.seite === b.seite ? 0 : a.seite === "verkauf" ? -1 : 1));
  return { orders, rangliste: liste.slice(0, 12), filter };
}

// ================================================================ Ausführung und Backtest

/** Montag der Woche (JJJJ-MM-TT) – Umschichtung einmal je Woche */
export function wochenstart(tag: string): string {
  const t = new Date(tag + "T12:00:00Z"), tagNr = (t.getUTCDay() + 6) % 7;
  return new Date(t.getTime() - tagNr * 864e5).toISOString().slice(0, 10);
}

/** Zustand eines Depots für Ausführung und Backtest */
export type Depot = {
  bargeld: number;
  bestand: Map<string, Position>;
  sj: Steuerjahr;
  gesperrt: Map<string, string>;       // Kennung → bis zu diesem Tag kein Wiederkauf
  summen: { orders: number; gebuehren: number; spread: number; abgeltung: number; krypto_steuer: number };
};

export function neuesDepot(start: number, jahr: number, e = STANDARD_EINSTELLUNGEN): Depot {
  return { bargeld: start, bestand: new Map(), sj: neuesSteuerjahr(jahr, null, e), gesperrt: new Map(),
    summen: { orders: 0, gebuehren: 0, spread: 0, abgeltung: 0, krypto_steuer: 0 } };
}

/** Freies Bargeld: abzüglich der Rücklage für Krypto-Steuern des laufenden Jahres */
export const freiesGeld = (d: Depot, e = STANDARD_EINSTELLUNGEN) => d.bargeld - kryptoRuecklage(d.sj, e);

/** Jahreswechsel: Krypto-Steuer des Vorjahres abbuchen, neues Steuerjahr beginnen */
export function jahreswechsel(d: Depot, jahr: number, e = STANDARD_EINSTELLUNGEN): number {
  if (d.sj.jahr >= jahr) return 0;
  const steuer = kryptoRuecklage(d.sj, e);
  d.bargeld -= steuer; d.summen.krypto_steuer += steuer;
  d.sj = neuesSteuerjahr(jahr, d.sj, e);
  return steuer;
}

export type Ausfuehrung = { kennung: string; klasse: Klasse; seite: Seite; anteile: number; kurs: number; gebuehr: number;
  spread: number; realisiert?: number; steuer?: number; grund: string;
  sj: Steuerjahr;          // Steuerstand nach dieser Order (zum Speichern im Live-Betrieb)
  bargeld: number };       // Bargeld nach dieser Order (zur Kontrolle beim Speichern)

/** Kauf zum Mittelkurs `mittel` für höchstens `betrag` € (inkl. Gebühr). Gibt null zurück, wenn zu klein. */
export function kaufen(d: Depot, w: { kennung: string; klasse: Klasse }, mittel: number, betrag: number, tag: string,
  grund: string, e = STANDARD_EINSTELLUNGEN, minOrder = 0): Ausfuehrung | null {
  const b = Math.min(betrag, freiesGeld(d, e));
  if (b - e.gebuehr < Math.max(minOrder, 1)) return null;
  const kurs = ausfuehrungskurs(mittel, "kauf", w.klasse, e), anteile = (b - e.gebuehr) / kurs;
  const kosten = anteile * kurs + e.gebuehr;
  d.bargeld -= kosten;
  const p = d.bestand.get(w.kennung) ?? { kennung: w.kennung, klasse: w.klasse, lose: [] };
  p.lose.push({ datum: tag, anteile, kosten });
  d.bestand.set(w.kennung, p);
  const spread = anteile * (kurs - mittel);
  d.summen.orders++; d.summen.gebuehren += e.gebuehr; d.summen.spread += spread;
  return { kennung: w.kennung, klasse: w.klasse, seite: "kauf", anteile, kurs, gebuehr: e.gebuehr, spread, grund,
    sj: { ...d.sj }, bargeld: d.bargeld };
}

/** Verkauf von `anteile` zum Mittelkurs `mittel`, mit Steuer */
export function verkaufen(d: Depot, kennung: string, mittel: number, anteile: number, tag: string, grund: string,
  e = STANDARD_EINSTELLUNGEN): Ausfuehrung | null {
  const p = d.bestand.get(kennung);
  if (!p) return null;
  const a = Math.min(anteile, anteileVon(p));
  if (a <= 1e-12) return null;
  const kurs = ausfuehrungskurs(mittel, "verkauf", p.klasse, e);
  const v = verkaufAuswerten(p.klasse, p.lose, a, kurs, e.gebuehr, tag, d.sj, e);
  d.bargeld += a * kurs - e.gebuehr - v.steuer;
  d.sj = v.sj;
  if (v.rest.length && anteileVon({ ...p, lose: v.rest }) > 1e-9) p.lose = v.rest; else d.bestand.delete(kennung);
  const spread = a * (mittel - kurs);
  d.summen.orders++; d.summen.gebuehren += e.gebuehr; d.summen.spread += spread; d.summen.abgeltung += v.steuer;
  return { kennung, klasse: p.klasse, seite: "verkauf", anteile: a, kurs, gebuehr: e.gebuehr, spread, realisiert: v.realisiert,
    steuer: v.steuer, grund, sj: { ...d.sj }, bargeld: d.bargeld };
}

/** Steuer, die beim Verkauf aller Positionen heute anfiele (für den Vergleich „nach Steuern“) */
export function latenteSteuer(d: Depot, kurse: (k: string) => number, tag: string, e = STANDARD_EINSTELLUNGEN): number {
  let sj = { ...d.sj }, steuer = 0;
  for (const p of d.bestand.values()) {
    const kurs = kurse(p.kennung);
    if (!kurs) continue;
    const v = verkaufAuswerten(p.klasse, p.lose, anteileVon(p), ausfuehrungskurs(kurs, "verkauf", p.klasse, e), e.gebuehr, tag, sj, e);
    steuer += v.steuer; sj = v.sj;
  }
  return steuer + kryptoRuecklage(sj, e);
}

/** Ein Handelstag: Jahreswechsel, Stop-Loss, ggf. Umschichtung. `handelbar(k)` = Börse für k heute offen. */
export function handelstag(d: Depot, werte: Wert[], reihen: Reihen, tag: string, rotieren: boolean,
  handelbar: (k: string) => boolean, st = OFFENSIV, e = STANDARD_EINSTELLUNGEN,
  pruefeKauf: (o: PlanOrder) => boolean = () => true): Ausfuehrung[] {
  const aus: Ausfuehrung[] = [];
  jahreswechsel(d, Number(tag.slice(0, 4)), e);
  const kurs = (k: string) => { const b = reihen.get(k); if (!b) return 0; const i = stand(b, tag); return i < 0 ? 0 : b[i].kurs; };
  const plus = (t: string, n: number) => new Date(Date.parse(t) + n * 864e5).toISOString().slice(0, 10);

  for (const p of [...d.bestand.values()]) {
    if (!handelbar(p.kennung)) continue;
    const s = stopFaellig(p, reihen, tag, st);
    if (s.faellig) {
      const a = verkaufen(d, p.kennung, s.kurs, anteileVon(p), tag,
        `Stop-Loss: ${((s.kurs / s.hoch - 1) * 100).toFixed(1)} % unter dem Hoch seit Kauf`, e);
      if (a) aus.push(a);
      d.gesperrt.set(p.kennung, plus(tag, st.sperre_nach_stop));
    }
  }
  if (!rotieren) return aus;

  const plan = rotationPlanen(werte, reihen, tag, [...d.bestand.values()], freiesGeld(d, e), d.gesperrt, st);
  const klasseVon = new Map(werte.map((w) => [w.kennung, w.klasse]));
  for (const o of plan.orders) {
    if (!handelbar(o.kennung)) continue;
    if (o.seite === "verkauf") { const a = verkaufen(d, o.kennung, kurs(o.kennung), o.anteile!, tag, o.grund, e); if (a) aus.push(a); }
    else if (pruefeKauf(o)) {
      const a = kaufen(d, { kennung: o.kennung, klasse: klasseVon.get(o.kennung) ?? o.klasse }, kurs(o.kennung), o.betrag!, tag, o.grund, e, st.min_order);
      if (a) aus.push(a);
    }
  }
  return aus;
}

export type Kennzahlen = { endwert: number; rendite: number; jahresrendite: number; max_rueckgang: number };
export function kennzahlen(werte: [string, number][], start: number): Kennzahlen {
  let hoch = -Infinity, rueck = 0;
  for (const [, v] of werte) { hoch = Math.max(hoch, v); rueck = Math.min(rueck, v / hoch - 1); }
  const ende = werte.at(-1)?.[1] ?? start, jahre = werte.length ? tageZwischen(werte[0][0], werte.at(-1)![0]) / 365 : 1;
  return { endwert: ende, rendite: (ende / start - 1) * 100, jahresrendite: (Math.pow(ende / start, 1 / Math.max(jahre, 0.01)) - 1) * 100,
    max_rueckgang: rueck * 100 };
}

/**
 * Backtest über Kalendertage. Aktien/ETFs werden nur an Tagen mit Kurs gehandelt (Börse offen),
 * Krypto täglich. Umschichtung am ersten Börsentag jeder Woche. Bewertung zu Tagesschlusskursen.
 */
export function backtest(werte: Wert[], reihen: Reihen, von: string, bis: string, start: number,
  st = OFFENSIV, e = STANDARD_EINSTELLUNGEN) {
  const d = neuesDepot(start, Number(von.slice(0, 4)), e);
  const verlauf: [string, number][] = [], nachSteuer: [string, number][] = [], protokoll: (Ausfuehrung & { tag: string })[] = [];
  const aktien = werte.filter((w) => w.klasse !== "krypto").map((w) => w.kennung);
  const kurs = (k: string, tag: string) => { const b = reihen.get(k); if (!b) return 0; const i = stand(b, tag); return i < 0 ? 0 : b[i].kurs; };
  const hatKurs = (k: string, tag: string) => { const b = reihen.get(k); if (!b) return false; const i = stand(b, tag); return i >= 0 && b[i].tag === tag; };
  const wocheVon = wochenstart;
  let letzteWoche = "";

  for (let t = Date.parse(von + "T12:00:00Z"); t <= Date.parse(bis + "T12:00:00Z"); t += 864e5) {
    const tag = new Date(t).toISOString().slice(0, 10);
    const boerseOffen = aktien.filter((k) => hatKurs(k, tag)).length >= aktien.length / 2;
    const rotieren = boerseOffen && wocheVon(tag) !== letzteWoche;
    if (rotieren) letzteWoche = wocheVon(tag);
    for (const a of handelstag(d, werte, reihen, tag, rotieren, (k) => hatKurs(k, tag), st, e)) protokoll.push({ ...a, tag });
    const wert = d.bargeld + [...d.bestand.values()].reduce((s, p) => s + anteileVon(p) * kurs(p.kennung, tag), 0);
    verlauf.push([tag, wert - kryptoRuecklage(d.sj, e)]);
    if (tag.slice(8) === "01" || t + 864e5 > Date.parse(bis + "T12:00:00Z")) {
      nachSteuer.push([tag, wert - latenteSteuer(d, (k) => kurs(k, tag), tag, e)]);
    }
  }
  const ende = verlauf.at(-1)?.[0] ?? bis;
  return { depot: d, verlauf, nachSteuer, protokoll, kennzahlen: kennzahlen(verlauf, start),
    nach_steuern: kennzahlen(nachSteuer, start),
    bestand: [...d.bestand.values()].map((p) => ({ kennung: p.kennung, anteile: anteileVon(p), wert: anteileVon(p) * kurs(p.kennung, ende) })) };
}

/** Vergleich: am ersten Tag kaufen und halten (mit Gebühr, Spread und Steuer bei Verkauf am Ende) */
export function kaufenUndHalten(w: Wert, reihen: Reihen, von: string, bis: string, start: number, e = STANDARD_EINSTELLUNGEN) {
  const b = reihen.get(w.kennung)!;
  const i0 = stand(b, von) >= 0 && b[stand(b, von)].tag === von ? stand(b, von) : b.findIndex((x) => x.tag >= von);
  const d = neuesDepot(start, Number(von.slice(0, 4)), e);
  kaufen(d, w, b[i0].kurs, start, b[i0].tag, "Start", e);
  const verlauf: [string, number][] = [];
  for (let i = i0; i < b.length && b[i].tag <= bis; i++) verlauf.push([b[i].tag, d.bargeld + anteileVon(d.bestand.get(w.kennung)!) * b[i].kurs]);
  const ende = verlauf.at(-1)![0], endkurs = b[stand(b, ende)].kurs;
  const nach = verlauf.at(-1)![1] - latenteSteuer(d, () => endkurs, ende, e);
  return { verlauf, kennzahlen: kennzahlen(verlauf, start), endwert_nach_steuern: nach };
}
