// Echtes Depot: aus Buchungen (Kauf/Verkauf mit Datum) den Bestand je Wert und Depot berechnen.
// Reine Rechenlogik ohne Abhängigkeiten – läuft in der Edge Function (Deno) und in den Tests (Node).
//
// - Gleicher Wert im selben Depot wird zusammengefasst (Schlüssel: Kennung + Depot).
// - Einstand = Durchschnittskosten: Ein Verkauf nimmt anteilig Einstand heraus, der Rest ist realisierter Gewinn/Verlust.
// - Buchungen ohne Datum gelten als „Anfangsbestand“ – vorhanden, so weit der Kursverlauf zurückreicht.
// - Depotverlauf: Wert an jedem Tag = Anteile, die an dem Tag im Depot lagen × Kurs des Tages.

export type Buchung = {
  id?: string;
  kennung: string;            // ISIN oder Yahoo-Ticker
  name: string;
  depot: string;
  symbol?: string | null;     // aufgelöstes Yahoo-Symbol (Zwischenspeicher)
  art: "kauf" | "verkauf";
  datum: string | null;       // JJJJ-MM-TT, null = Anfangsbestand ohne Datum
  anteile: number;
  betrag: number | null;      // € gesamt inkl. Gebühren (Kauf: bezahlt, Verkauf: erhalten); null = unbekannt
};

export type Bestand = {
  schluessel: string;
  kennung: string;
  name: string;
  depot: string;
  symbol: string | null;
  anteile: number;            // heute im Depot (0 = vollständig verkauft)
  einstand: number | null;    // Einstand der heutigen Anteile in € (null = unbekannt)
  realisiert: number | null;  // Summe Gewinn/Verlust aus Verkäufen (null = nicht berechenbar)
  letzte_buchung: string | null;
  warnung: string | null;     // z. B. Verkauf von mehr Anteilen als vorhanden
  buchungen: Buchung[];       // in zeitlicher Reihenfolge
};

const KLEIN = 1e-9;
export const schluesselVon = (b: { kennung: string; depot: string }) =>
  `${b.kennung.trim().toUpperCase()}|${(b.depot ?? "").trim().toLowerCase()}`;

/** Zeitliche Reihenfolge: Anfangsbestand (ohne Datum) zuerst, am selben Tag Käufe vor Verkäufen */
export function sortieren(liste: Buchung[]): Buchung[] {
  return [...liste].sort((a, b) => (a.datum ?? "").localeCompare(b.datum ?? "")
    || (a.art === b.art ? 0 : a.art === "kauf" ? -1 : 1));
}

/** Alle Buchungen zu Beständen je Wert und Depot zusammenfassen (auch vollständig verkaufte) */
export function bestaende(buchungen: Buchung[]): Bestand[] {
  const gruppen = new Map<string, Buchung[]>();
  for (const b of buchungen) {
    const k = schluesselVon(b);
    gruppen.set(k, [...(gruppen.get(k) ?? []), b]);
  }
  const out: Bestand[] = [];
  for (const [schluessel, liste] of gruppen) {
    const sortiert = sortieren(liste);
    let anteile = 0, einstand: number | null = 0, realisiert: number | null = 0, warnung: string | null = null;
    for (const b of sortiert) {
      const a = Number(b.anteile) || 0;
      if (b.art === "kauf") {
        anteile += a;
        einstand = einstand != null && b.betrag != null ? einstand + Number(b.betrag) : null;
      } else {
        const verkauft = Math.min(a, anteile);
        if (a > anteile + KLEIN) warnung = `Verkauf von ${a} Anteilen${b.datum ? ` am ${b.datum}` : ""}, vorhanden waren nur ${+anteile.toFixed(6)}`;
        const kosten = einstand != null && anteile > KLEIN ? einstand * verkauft / anteile : null;
        realisiert = realisiert != null && kosten != null && b.betrag != null ? realisiert + Number(b.betrag) * (verkauft / (a || 1)) - kosten : null;
        if (einstand != null && kosten != null) einstand -= kosten;
        anteile = Math.round((anteile - verkauft) * 1e10) / 1e10;     // keine Rechen-Krümel wie 0,060000000000000005
        if (anteile < KLEIN) { anteile = 0; if (einstand != null) einstand = 0; }
      }
    }
    // Anzeige-Angaben aus der jüngsten Buchung, die sie enthält
    const juengste = (f: "name" | "symbol") => [...sortiert].reverse().find((b) => b[f])?.[f] ?? null;
    out.push({ schluessel, kennung: sortiert[0].kennung.trim(), name: juengste("name") ?? "", depot: sortiert[0].depot ?? "",
      symbol: juengste("symbol"), anteile, einstand: einstand == null ? null : Math.round(einstand * 100) / 100,
      realisiert: realisiert == null ? null : Math.round(realisiert * 100) / 100,
      letzte_buchung: sortiert.reduce<string | null>((m, b) => (b.datum && (!m || b.datum > m) ? b.datum : m), null),
      warnung, buchungen: sortiert });
  }
  return out;
}

/** Anteile, die am Ende von `tag` im Depot lagen (Buchungen ohne Datum zählen immer) */
export function anteileAm(b: Bestand, tag: string): number {
  let anteile = 0;
  for (const x of b.buchungen) {
    if (x.datum && x.datum > tag) break;                        // sortiert: alles Weitere ist später
    anteile = x.art === "kauf" ? anteile + Number(x.anteile) : Math.max(0, anteile - Number(x.anteile));
  }
  return anteile;
}

/**
 * Depotverlauf über alle Tage, an denen es Kurse gibt. `kurse` je Bestand: Tag → Kurs in €.
 * Lücken (Wochenende, Feiertag) werden mit dem letzten Kurs gefüllt, vor dem ersten Kurs mit dem ersten.
 */
export function depotverlauf(posten: { bestand: Bestand; kurse: Map<string, number> }[]): [string, number][] {
  const tage = [...new Set(posten.flatMap((p) => [...p.kurse.keys()]))].sort();
  const letzter = posten.map((p) => { const t = [...p.kurse.keys()].sort()[0]; return t ? p.kurse.get(t)! : 0; });
  return tage.map((tag) => {
    let wert = 0;
    posten.forEach((p, i) => {
      if (p.kurse.has(tag)) letzter[i] = p.kurse.get(tag)!;
      wert += anteileAm(p.bestand, tag) * letzter[i];
    });
    return [tag, wert] as [string, number];
  });
}
