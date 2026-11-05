# Depot-Dashboard online – Einrichtung mit Supabase

Danach läuft das Dashboard auf Mac und Android als App, die Alerts werden rund um die Uhr
alle 5 Minuten geprüft und kommen als Push-Mitteilung – ohne dass der Mac an sein muss.
Dauer: etwa 30 Minuten. Alles im kostenlosen Tarif.

Die geheimen Werte für Schritt 4 stehen in `.secrets/supabase-geheimnisse.txt`
(nur auf deinem Mac, nicht im Repo).

## 1. Neues Supabase-Projekt
1. Auf https://supabase.com/dashboard anmelden → **New project**.
   Name `depot`, Region **Frankfurt (eu-central-1)**, Datenbank-Passwort sicher notieren.
2. Warten, bis das Projekt bereit ist (1–2 Minuten).

## 2. Datenbank einrichten
1. **SQL Editor** → **New query** → den kompletten Inhalt von `supabase/schema.sql` einfügen → **Run**.
   Der Cron-Block ganz unten ist auskommentiert und kommt erst in Schritt 6.
2. **Authentication → Users → Add user → Create new user**: E-Mail und Passwort für dich,
   **Auto Confirm User** anhaken. (Die zwei Standard-Alerts werden dabei automatisch angelegt.)
3. **Authentication → Sign In / Providers**: **Allow new users to sign up** ausschalten.
   So kann sich niemand sonst ein Konto anlegen.

## 3. Edge Function `depot`
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Name: `depot`. Den Inhalt von `supabase/functions/depot/index.ts` einfügen → **Deploy function**.
3. In den Einstellungen der Funktion (**Details**) **Verify JWT with legacy secret** bzw. **Enforce JWT** ausschalten
   – die Funktion prüft Anmeldung und Cron-Geheimnis selbst.

## 4. Geheimnisse hinterlegen
**Edge Functions → Secrets** → je Zeile aus `.secrets/supabase-geheimnisse.txt` ein Eintrag
(Name links vom `=`, Wert rechts davon):
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `APP_URL`.

## 5. Öffentliche Zugangsdaten an Claude geben
**Connect** (oben) bzw. **Project Settings → API Keys**:
- **Project URL** (z. B. `https://abcdefgh.supabase.co`)
- **Publishable key** (`sb_publishable_…`) bzw. **anon public**

Beide sind öffentlich und kommen in `config.js`. ⚠️ Niemals den **secret**/**service_role**-Schlüssel weitergeben.

## 6. Cron für die Alerts
Im **SQL Editor** den Cron-Block am Ende von `supabase/schema.sql` einfügen, die Kommentarzeichen `-- `
entfernen, `PROJEKT-ID` (der Teil vor `.supabase.co`) und `<CRON_SECRET>` ersetzen → **Run**.
Kontrolle: **Integrations → Cron → Jobs** zeigt `depot-alerts`, unter **History** alle 5 Minuten ein Lauf.

## 7. Online stellen (macht Claude)
Repo öffentlich schalten und GitHub Pages aktivieren. Danach in Supabase unter
**Authentication → URL Configuration → Site URL** eintragen: `https://dilldapp74.github.io/depot-dashboard/`

## 8. Positionen übernehmen
Einmalig: In der Online-App anmelden → **Positionen bearbeiten** und die Positionen eintragen.
(Oder Claude überträgt sie aus der lokalen `holdings.json` per SQL, das du im SQL Editor ausführst.)

## 9. Auf den Geräten
- **Android (Chrome):** `https://dilldapp74.github.io/depot-dashboard/` öffnen → ⋮ → **App installieren**,
  anmelden, unter Alerts **Push aktivieren**.
- **Mac:** dieselbe Adresse in Chrome → Installieren-Symbol in der Adressleiste (oder Safari → Ablage →
  **Zum Dock hinzufügen**), anmelden, **Push aktivieren**.

## Gut zu wissen
- Kostenlose Supabase-Projekte werden nach etwa einer Woche ohne Nutzung pausiert. Im Dashboard
  lassen sie sich mit einem Klick wieder starten.
- **Abmelden** in der App schaltet Push auf diesem Gerät ab und löscht den gespeicherten Stand dort.
- Die lokale Fassung (`python3 server.py`) läuft weiter, solange `SUPABASE_URL` in `config.js` leer ist –
  zum Ausprobieren lokal die Zeile vorübergehend leeren.
