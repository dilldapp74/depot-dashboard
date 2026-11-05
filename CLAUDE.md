# Depot-Dashboard

## Ziel
Persönliches Dashboard für die Depots bei ING und Trade Republic (Aktien, ETFs, Krypto) mit Live-Kursen
und Alerts. Später: als App auf Mac und Android (PWA), Server im Dauerbetrieb, Paper-Trading.

## Stack
- **Backend:** `server.py` – Python, **nur Standardbibliothek** (`http.server`, `urllib`), kein Build-Schritt
- **Frontend:** `index.html` – reines HTML/CSS/JavaScript, Chart.js 4.4.1 per CDN (cdnjs, feste Version)
- **Daten:** `holdings.json` (Positionen), `alerts.json` (Regeln, Zustand, Protokoll) – beide **nicht im Git**
- **Kurse:** Yahoo Finance `query1…/v8/finance/chart` und `query2…/v1/finance/search` (ISIN-Suche)

## Regeln
- **Depotdaten niemals committen.** `holdings.json`/`alerts.json` stehen in `.gitignore`;
  `holdings.example.json` enthält nur Beispieldaten. Vor jedem Push `scripts/check_secrets.sh`.
- Server bindet nur an `127.0.0.1`. Die API hat **keinen Login** – bevor der Server aus dem Netz
  erreichbar wird (Handy, Cloud), muss ein Zugangsschutz her (z. B. Tailscale oder Token).
- Keine Trades, keine Broker-Zugangsdaten im Code. Spätere API-Schlüssel nur in `.env`.
- python.org-Python auf macOS hat oft keine CA-Zertifikate → `SSL_CTX` nutzt `/etc/ssl/cert.pem`.
- Code einfach und gut lesbar halten, Kommentare auf Deutsch.
- Der Nutzer ist Hobby-Entwickler: wichtige Schritte kurz erklären.

## Zwei Betriebsarten (api.js)
- `config.js` ohne `SUPABASE_URL` → **lokal**: `api.js` spricht mit `server.py` (`api/…`, relative Pfade).
- Mit `SUPABASE_URL` → **online**: Anmeldung (E-Mail/Passwort, Registrierung im Supabase-Dashboard aus),
  Tabellen per supabase-js, Kurse/Alerts/Push über die Edge Function `depot`.
- Beide liefern dieselben Formate (Position `{uid?, name, id, depot, anteile, einstand, symbol}`,
  Regel `{id?, type, target, value, enabled}`), damit `index.html` nur eine Fassung braucht.
- CSS-Klassen `nur-lokal` / `nur-supabase`; `body.supabase`, `body.abgemeldet` steuern die Anzeige.
- Letzter Stand liegt zusätzlich in `localStorage` (`dd.letzterStand`) für den Offline-Start; Abmelden löscht ihn.

## Supabase
- `supabase/schema.sql` (wiederholbar): Tabellen `positionen`, `alert_regeln`, `alert_zustand`,
  `alert_protokoll`, `push_abos`; RLS „nur eigene Zeilen“, `anon` ohne Rechte, `alert_zustand` nur für die Function.
  Trigger legt für neue Konten die zwei Standard-Alerts an. Cron-Block am Ende (auskommentiert).
- `supabase/functions/depot/index.ts`: Aktionen `portfolio`, `pruefen`, `test` (Anmelde-Token) und
  `cron` (Kopfzeile `x-cron-secret`). „Verify JWT“ aus – die Funktion prüft selbst. Logik = `server.py`.
- Geheimnisse nur als Function-Secrets (`VAPID_PRIVATE_KEY`, `CRON_SECRET`, …); lokal in
  `.secrets/supabase-geheimnisse.txt` (gitignored). `config.js` enthält nur öffentliche Werte.
- Deployt wird von Hand im Supabase-Dashboard (kein CLI installiert), siehe `ANLEITUNG.md`.
- Testen ohne Deno: Funktion mit Node und nachgebauter Datenbank ausführen (Imports durch Stubs ersetzen).
- Yahoo-Suche findet nicht jede ISIN (z. B. DE0007030033) – dann Ticker eintragen (`RHM.DE`).

## PWA
- `manifest.webmanifest`, `icons/` (aus `scripts/make_icons.py`), `sw.js`
- **`"id": "/depot-dashboard/"` nicht ändern.** Chrome löst `id` relativ zur Domain auf, nicht zum Manifest:
  `"./"` wäre `https://dilldapp74.github.io/` – dieselbe Kennung wie das Family Kanban (gleiche Pages-Domain),
  Android meldet dann „bereits installiert“. Eine geänderte id macht installierte Apps zu Waisen.
- `sw.js`: „Netz zuerst, sonst Cache“ für Seite, Symbole, Chart.js und `/api/portfolio` + `/api/alerts`
  (Offline-Fallback mit Kopfzeile `X-Offline: 1` → Hinweisbalken). Andere API-Aufrufe nie aus dem Cache.
  Bei größeren Änderungen `CACHE` in `sw.js` hochzählen.
- `server.py` liefert nur Dateien aus der festen Liste `STATIC` aus – nie beliebige Pfade
  (sonst wären `holdings.json`/`alerts.json` abrufbar).
- Handy-Layout (≤ 640 px): Positionen als Karten (`data-label` an jeder Zelle), Sortierung per Auswahlliste,
  Bearbeiten-Dialog als Vollbild. Eingabefelder 16 px, damit Android/iOS nicht hineinzoomen.
- Die eingebaute Browser-Vorschau der Claude-App registriert keine Service Worker – zum Prüfen
  echtes Chrome nehmen (`data-sw="aktiv"` am `<html>`).

## Aufbau server.py
- `http_json()` – HTTP-Abruf mit Zwischenspeicher (TTL je Aufruf)
- `resolve_symbol()` – ISIN → Yahoo-Symbol; nur Börsenplätze mit ≥ 20 Tageskursen, EUR bevorzugt
- `eur_factor()` – Umrechnung Fremdwährung → EUR (`EURUSD=X` usw., `GBp` = Pence)
- `quote_position()` – Kurs, Vortag (`chartPreviousClose` aus `range=1d`), 1-Jahres-Verlauf, G/V
- `portfolio()` – alle Positionen parallel; aufgelöste Symbole werden in `holdings.json` gemerkt
- Alerts: `evaluate_alerts()` läuft in `alert_loop()` alle 60 s
  - `day_move`, `portfolio_day_move`: höchstens 1× pro Tag (Zustand `d:<datum>:<regel>:<id>`)
  - `price_above`, `price_below`, `pl_below`: feuern beim Überschreiten, wieder scharf nach Rückkehr
  - Mitteilung per `osascript` (macOS), Protokoll in `alerts.json` (max. 200)

## REST
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/portfolio` | Positionen mit Kursen, Verlauf, G/V |
| GET/PUT | `/api/holdings` | Positionen lesen/speichern |
| GET | `/api/alerts` | Regeln + letzte 50 Auslösungen |
| PUT | `/api/alerts/rules` | Regeln speichern |
| POST | `/api/alerts/check` | sofort prüfen |
| POST | `/api/alerts/test` | Test-Mitteilung |

## Wiederverwendbar aus anderen Projekten
- `~/Claude/project1/kanban`: PWA (Manifest, `sw.js` „Netz zuerst, sonst Cache“, Push-Empfang),
  Web-Push mit VAPID, Benachrichtigungs-Einstellungen, Supabase + Row Level Security, GitHub Pages
- `~/Claude/maestrale/proxy`: Muster „Geheimnisse nur auf dem Server“, App-Token, Ratenbegrenzung
- `~/Claude/lebendiges-dorf`: `check_secrets.sh`, Budget-/Kostenkontrolle für KI-Aufrufe, pytest-Aufbau
