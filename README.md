# Depot-Dashboard

Lokales Dashboard für alle Depots mit Live-Kursen, Gewinn/Verlust,
Aufteilung, Wertverlauf und Kurs-Alerts als Mac-Mitteilung.

Die Positionen werden von Hand gepflegt – kein Broker-Zugang, keine Exporte nötig.
**Depotdaten sind nie im Repo.**

Zwei Betriebsarten (Auswahl über `config.js`):

| | lokal | online (Supabase) |
|---|---|---|
| Start | `python3 server.py` | https://dilldapp74.github.io/depot-dashboard/ |
| Daten | `holdings.json`, `alerts.json` auf dem Mac | Supabase-Datenbank, nur fürs eigene Konto lesbar |
| Kurse | `server.py` | Edge Function `depot` |
| Alerts | jede Minute, Mac-Mitteilung, solange der Server läuft | alle 5 Minuten per Cron, Push auf Mac und Android |
| Geräte | nur dieser Mac | Mac und Android, mit Anmeldung |

Einrichtung der Online-Fassung: [ANLEITUNG.md](ANLEITUNG.md).

### Nur online

- **Spieldepot (Paper-Trading):** Spielgeld-Depot (Start z. B. 25.000 €, Gebühr je Order), manuelle Orders
  zum aktuellen Kurs, Regeln (Sparplan, Nachkaufen bei Rückgang, Trendfolge, Rebalancing), die werktags ab
  17:40 automatisch handeln, und ein Backtest über das letzte Jahr im Vergleich zu „am Start kaufen“.
- **Recherche:** Löst ein Tagesbewegungs-Alert aus, fasst Claude (Websuche) die Nachrichtenlage zusammen –
  als Push und im Kursverlauf-Dialog. Höchstens 5 je Tag, Budget 5 € je Monat. Ohne `ANTHROPIC_API_KEY`
  läuft ein Demo-Modus ohne Kosten. Kostenlos jederzeit: Knopf **„In Claude nachfragen“** (öffnet claude.ai
  mit fertiger Frage, nutzt das eigene Claude-Abo).

## Funktionen

- Gesamtwert, Tagesänderung, Gewinn/Verlust seit Kauf, Wert je Depot
- Aufteilung als Ring-Diagramm, Wertentwicklung 1 M / 3 M / 6 M / 1 J (mit heutigen Anteilen zurückgerechnet)
- Positionen-Tabelle, nach jeder Spalte sortierbar
- Positionen im Dashboard bearbeiten (Name, ISIN oder Ticker, Depot, Anteile, Einstand)
- Aktien, ETFs und Kryptowährungen; Fremdwährungen werden in EUR umgerechnet
- **Alerts** (jede Minute geprüft, solange der Server läuft):
  Tagesbewegung ±, Kurs unter/über, Verlust seit Kauf, Portfolio-Tagesbewegung ±

## Starten

Voraussetzung: Python 3.10+ (nur Standardbibliothek, keine Installation nötig).

```bash
cp holdings.example.json holdings.json   # nur beim ersten Mal
python3 server.py
```

Dann http://localhost:8765 öffnen.

## Als App installieren

Das Dashboard ist eine **PWA** (Progressive Web App): eigenes Symbol, eigenes Fenster, startet auch
ohne Verbindung mit dem zuletzt geladenen Stand.

- **Mac (Chrome/Edge):** http://localhost:8765 öffnen → Installieren-Symbol rechts in der Adressleiste
  (oder ⋮ → „Streamen, speichern und teilen“ → „Seite als App installieren“)
- **Mac (Safari):** Ablage → „Zum Dock hinzufügen“
- **Android (Chrome):** ⋮ → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“

**Android braucht HTTPS.** Solange der Server nur auf dem Mac unter `localhost` läuft, kann das Handy
ihn nicht erreichen. Das kommt mit dem nächsten Schritt (Server im Dauerbetrieb + Tailscale mit HTTPS).

Die Symbole werden mit `python3 scripts/make_icons.py` erzeugt (braucht Pillow).

## Positionen

`holdings.json` (oder im Dashboard über „Positionen bearbeiten“):

| Feld | Bedeutung |
|---|---|
| `name` | Anzeigename |
| `id` | ISIN (`IE00B4L5Y983`) oder Yahoo-Ticker (`SAP.DE`, `BTC-EUR`) |
| `depot` | z. B. `ING`, `Trade Republic` |
| `anteile` | Stückzahl, Nachkommastellen erlaubt |
| `einstand` | **gesamter** Kaufpreis in € (optional) – nicht der Kurs pro Stück |
| `symbol` | wird automatisch ergänzt, wenn eine ISIN aufgelöst wurde |

Bei einer ISIN sucht der Server selbst einen Börsenplatz (deutsche Plätze in EUR bevorzugt).
Für einen bestimmten Platz direkt den Ticker eintragen, z. B. `EUNL.DE` (Xetra).

## Kurse

Yahoo Finance (inoffizielle Schnittstelle), teils verzögert, ohne Gewähr.
Kurse werden 60 s, Kursverläufe 1 h zwischengespeichert.

## Vor jedem Push

```bash
scripts/check_secrets.sh
```

Bricht ab, wenn `holdings.json`, `alerts.json`, `.env`-Dateien oder API-Schlüssel im Repo wären.

## Nächste Schritte

1. ~~PWA: auf Mac und Android als App installierbar, Handy-Layout~~ ✓
2. ~~Online mit Supabase: Anmeldung, Cron-Alerts, Web-Push, GitHub Pages~~ ✓ (Einrichtung siehe ANLEITUNG.md)
3. ~~Paper-Trading: Spieldepot mit Regeln und Backtest~~ ✓ (nur online)
4. ~~Recherche bei starken Bewegungen (Claude mit Websuche)~~ ✓ – Demo-Modus, bis ein API-Schlüssel hinterlegt ist

Siehe [CLAUDE.md](CLAUDE.md) für Aufbau und Konventionen.
