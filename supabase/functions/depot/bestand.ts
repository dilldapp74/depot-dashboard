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

/** Anteile, die am Ende von `tag` im Depot lagen, aber später noch verkauft wurden */
export function spaeterVerkauftAm(b: Bestand, tag: string): number {
  const danach = b.buchungen.filter((x) => x.art === "verkauf" && x.datum && x.datum > tag)
    .reduce((s, x) => s + Number(x.anteile), 0);
  return Math.min(anteileAm(b, tag), danach);
}

/** Käufe minus Verkäufe (in Anteilen) genau an diesem Tag */
function bewegungAm(b: Bestand, tag: string): number {
  return b.buchungen.filter((x) => x.datum === tag)
    .reduce((s, x) => s + (x.art === "kauf" ? 1 : -1) * Number(x.anteile), 0);
}

/** Ein Tag im Depotverlauf: [Tag, Wert gesamt, davon später verkauft, Käufe − Verkäufe des Tages zum Tageskurs] */
export type VerlaufTag = [string, number, number, number];

/**
 * Depotverlauf über alle Tage, an denen es Kurse gibt. `kurse` je Bestand: Tag → Kurs in €.
 * Lücken (Wochenende, Feiertag) werden mit dem letzten Kurs gefüllt, vor dem ersten Kurs mit dem ersten.
 * Je Tag zusätzlich: welcher Teil des Werts später verkauft wurde, und wie viel Wert an dem Tag durch Käufe
 * und Verkäufe hinzukam bzw. wegging (zum Tageskurs) – so lässt sich die Kursentwicklung davon trennen.
 */
export function depotverlauf(posten: { bestand: Bestand; kurse: Map<string, number> }[]): VerlaufTag[] {
  const tage = [...new Set(posten.flatMap((p) => [...p.kurse.keys()]))].sort();
  const letzter = posten.map((p) => { const t = [...p.kurse.keys()].sort()[0]; return t ? p.kurse.get(t)! : 0; });
  // Buchungstage ohne eigenen Kurs (z. B. Verkauf am Wochenende) dem nächsten Kurstag zuordnen
  const naechsterKurstag = (d: string) => tage.find((t) => t >= d);
  const buchungstage = new Set(posten.flatMap((p) => p.bestand.buchungen.map((b) => b.datum).filter(Boolean) as string[]));
  const verschoben = new Map<string, string[]>();
  for (const d of buchungstage) { const t = naechsterKurstag(d); if (t) verschoben.set(t, [...(verschoben.get(t) ?? []), d]); }
  return tage.map((tag) => {
    let wert = 0, verkauft = 0, fluss = 0;
    posten.forEach((p, i) => {
      if (p.kurse.has(tag)) letzter[i] = p.kurse.get(tag)!;
      wert += anteileAm(p.bestand, tag) * letzter[i];
      verkauft += spaeterVerkauftAm(p.bestand, tag) * letzter[i];
      for (const d of verschoben.get(tag) ?? []) fluss += bewegungAm(p.bestand, d) * letzter[i];
    });
    return [tag, wert, verkauft, fluss] as VerlaufTag;
  });
}

/** Käufe und Verkäufe mit Datum, je Tag und Art zusammengefasst (für Markierungen im Diagramm) */
export function ereignisse(alle: Bestand[]): { tag: string; art: "kauf" | "verkauf"; namen: string[] }[] {
  const m = new Map<string, { tag: string; art: "kauf" | "verkauf"; namen: string[] }>();
  for (const b of alle) for (const x of b.buchungen) {
    if (!x.datum) continue;
    const k = `${x.datum}|${x.art}`, e = m.get(k) ?? { tag: x.datum, art: x.art, namen: [] };
    const name = b.name || b.kennung;
    if (!e.namen.includes(name)) e.namen.push(name);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.tag.localeCompare(b.tag) || a.art.localeCompare(b.art));
}
