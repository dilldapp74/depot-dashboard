# Depot-Dashboard

Lokales Dashboard für alle Depots (ING, Trade Republic) mit Live-Kursen, Gewinn/Verlust,
Aufteilung, Wertverlauf und Kurs-Alerts als Mac-Mitteilung.

Die Positionen werden von Hand gepflegt – kein Broker-Zugang, keine Exporte nötig.
**Alle Depotdaten bleiben auf dem eigenen Rechner** und sind per `.gitignore` vom Repo ausgeschlossen.

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

Dann http://127.0.0.1:8765 öffnen.

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

1. PWA: auf Mac und Android als App installierbar, Handy-Layout
2. Server dauerhaft betreiben (Raspberry Pi / Cloud) + Zugriff per Tailscale, Web-Push statt Mac-Mitteilung
3. Paper-Trading mit Spielgeld

Siehe [CLAUDE.md](CLAUDE.md) für Aufbau und Konventionen.
