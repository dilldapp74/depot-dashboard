// Tests für das echte Depot: Buchungen → Bestände, Durchschnittskosten, realisierter G/V, Depotverlauf.
// Ausführen: node --test "tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { anteileAm, type Buchung, bestaende, depotverlauf, ereignisse, spaeterVerkauftAm } from "../supabase/functions/depot/bestand.ts";

const kauf = (datum: string | null, anteile: number, betrag: number | null, extra: Partial<Buchung> = {}): Buchung =>
  ({ kennung: "IE00BK5BQT80", name: "Vanguard All-World", depot: "ING", art: "kauf", datum, anteile, betrag, ...extra });
const verkauf = (datum: string, anteile: number, betrag: number | null, extra: Partial<Buchung> = {}): Buchung =>
  ({ ...kauf(datum, anteile, betrag, extra), art: "verkauf" });

test("Zukauf desselben Werts im selben Depot wird zu einer Position summiert", () => {
  const b = bestaende([kauf(null, 10, 1000), kauf("2026-11-20", 5, 600)]);
  assert.equal(b.length, 1);
  assert.equal(b[0].anteile, 15);
  assert.equal(b[0].einstand, 1600);
});

test("Gleiche Kennung in anderem Depot bleibt eine eigene Position; Groß-/Kleinschreibung egal", () => {
  const b = bestaende([kauf(null, 10, 1000), kauf(null, 2, 200, { depot: "Trade Republic" }), kauf(null, 1, 100, { kennung: "ie00bk5bqt80 " })]);
  assert.equal(b.length, 2);
  assert.equal(b.find((x) => x.depot === "ING")!.anteile, 11);
});

test("Verkauf: Einstand nach Durchschnittskosten, Rest als realisierter Gewinn", () => {
  const [b] = bestaende([kauf("2026-01-02", 10, 1000), kauf("2026-03-02", 10, 1400), verkauf("2026-06-01", 5, 800)]);
  assert.equal(b.anteile, 15);
  assert.equal(b.einstand, 1800);                // 2.400 € − 5 × 120 €
  assert.equal(b.realisiert, 200);               // 800 € − 600 €
});

test("Vollständig verkauft: Bestand 0, Gewinn bleibt erhalten, Position verschwindet nicht", () => {
  const [b] = bestaende([kauf("2026-01-02", 10, 1000), verkauf("2026-06-01", 10, 900)]);
  assert.equal(b.anteile, 0);
  assert.equal(b.einstand, 0);
  assert.equal(b.realisiert, -100);
  assert.equal(b.letzte_buchung, "2026-06-01");
});

test("Unbekannter Einstand: kein Einstand und kein realisierter G/V, Anteile stimmen trotzdem", () => {
  const [b] = bestaende([kauf(null, 10, null), verkauf("2026-06-01", 4, 500)]);
  assert.equal(b.anteile, 6);
  assert.equal(b.einstand, null);
  assert.equal(b.realisiert, null);
});

test("Mehr verkauft als vorhanden: auf den Bestand begrenzt und mit Warnung", () => {
  const [b] = bestaende([kauf("2026-01-02", 3, 300), verkauf("2026-02-02", 5, 600)]);
  assert.equal(b.anteile, 0);
  assert.match(b.warnung!, /nur 3/);
});

test("Reihenfolge: Buchungen werden nach Datum verrechnet, nicht nach Eingabe", () => {
  const [b] = bestaende([verkauf("2026-06-01", 5, 800), kauf("2026-01-02", 10, 1000)]);
  assert.equal(b.anteile, 5);
  assert.equal(b.warnung, null);
  assert.equal(b.realisiert, 300);
});

test("Anteile an einem Tag: vor dem Kauf 0, nach Zukauf mehr, nach Verkauf weniger", () => {
  const [b] = bestaende([kauf(null, 10, 1000), kauf("2026-11-20", 5, 600), verkauf("2026-11-22", 15, 2000)]);
  assert.equal(anteileAm(b, "2025-01-01"), 10);  // Anfangsbestand gilt immer
  assert.equal(anteileAm(b, "2026-11-19"), 10);
  assert.equal(anteileAm(b, "2026-11-20"), 15);
  assert.equal(anteileAm(b, "2026-11-22"), 0);
});

test("Depotverlauf: verkaufte Position zählt bis zum Verkauf, gekaufte erst ab Kauf", () => {
  const [alt] = bestaende([kauf(null, 10, 1000, { kennung: "ALT" }), verkauf("2026-11-03", 10, 1100, { kennung: "ALT" })]);
  const [neu] = bestaende([kauf("2026-11-03", 2, 1000, { kennung: "NEU" })]);
  const kurse = (w: number) => new Map([["2026-11-02", w], ["2026-11-03", w], ["2026-11-04", w]]);
  const v = depotverlauf([{ bestand: alt, kurse: kurse(110) }, { bestand: neu, kurse: kurse(500) }]);
  // [Tag, Wert, davon später verkauft, Käufe − Verkäufe zum Tageskurs]
  assert.deepEqual(v, [["2026-11-02", 1100, 1100, 0], ["2026-11-03", 1000, 0, -100], ["2026-11-04", 1000, 0, 0]]);
});

test("Teilverkauf: nur der später verkaufte Teil zählt als „verkauft“", () => {
  const [b] = bestaende([kauf(null, 10, 1000), verkauf("2026-06-01", 4, 500)]);
  assert.equal(spaeterVerkauftAm(b, "2026-05-31"), 4);
  assert.equal(spaeterVerkauftAm(b, "2026-06-01"), 0);
});

test("Verkauf am Wochenende wird dem nächsten Kurstag zugeordnet", () => {
  const [b] = bestaende([kauf(null, 10, 1000), verkauf("2026-11-07", 10, 1000)]);   // Samstag
  const v = depotverlauf([{ bestand: b, kurse: new Map([["2026-11-06", 100], ["2026-11-09", 100]]) }]);
  assert.deepEqual(v, [["2026-11-06", 1000, 1000, 0], ["2026-11-09", 0, 0, -1000]]);
});

test("Ereignisse: Käufe und Verkäufe je Tag zusammengefasst, ohne Anfangsbestand", () => {
  const e = ereignisse(bestaende([kauf(null, 1, 1, { kennung: "A", name: "Alpha" }), verkauf("2026-11-20", 1, 1, { kennung: "A", name: "Alpha" }),
    kauf(null, 1, 1, { kennung: "B", name: "Beta" }), verkauf("2026-11-20", 1, 1, { kennung: "B", name: "Beta" }),
    kauf("2026-11-20", 2, 2, { kennung: "C", name: "Gamma" })]));
  assert.deepEqual(e, [{ tag: "2026-11-20", art: "kauf", namen: ["Gamma"] }, { tag: "2026-11-20", art: "verkauf", namen: ["Alpha", "Beta"] }]);
});
