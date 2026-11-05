# Depot-Dashboard online – Einrichtung mit Supabase

Danach läuft das Dashboard auf Mac und Android als App, die Alerts werden rund um die Uhr
alle 5 Minuten geprüft und kommen als Push-Mitteilung – ohne dass der Mac an sein muss.
Alles im kostenlosen Tarif.

**Projekt:** `depot` (ID `ulxfxsirinucxxprlwjd`, Region Frankfurt) im Konto von dilldapp74.

## Erledigt (per Supabase-Connector bzw. Browser)
- [x] Projekt `depot` in Frankfurt angelegt
- [x] Datenbank: `supabase/schema.sql` (Tabellen, Zugriffsregeln, Standard-Alerts, Cron-Geheimnis im Vault)
- [x] Edge Function `depot` deployt, „Verify JWT“ aus (prüft selbst)
- [x] Cron `depot-alerts` alle 5 Minuten (liest das Geheimnis aus dem Vault)
- [x] Registrierung neuer Konten abgeschaltet
- [x] Site URL: `https://dilldapp74.github.io/depot-dashboard/`
- [x] `config.js` mit Project URL und Publishable Key

## Nur du (Passwörter und geheime Schlüssel gibt Claude nicht ein)
1. **Konto anlegen:** Authentication → Users → **Add user → Create new user**: deine E-Mail,
   ein Passwort, **Auto Confirm User** anhaken. Die zwei Standard-Alerts entstehen dabei automatisch.
2. **Push-Schlüssel hinterlegen:** Edge Functions → **Secrets** → Add new secret:
   Name `VAPID_PRIVATE_KEY`, Wert aus `.secrets/supabase-geheimnisse.txt` (nur auf deinem Mac).

## Optional: echte Recherchen statt Demo-Modus
1. Auf https://platform.claude.com einen API-Schlüssel anlegen und etwas Guthaben aufladen
   (getrennt vom Claude-Abo; geschätzt 0,15–0,25 € je Recherche, gedeckelt auf 5 € im Monat).
2. Supabase → Edge Functions → **Secrets** → Name `ANTHROPIC_API_KEY`, Wert = der Schlüssel.
   Ab dem nächsten Tagesbewegungs-Alert recherchiert Claude automatisch.

## Danach (macht Claude)
- Positionen aus der lokalen `holdings.json` in die Datenbank übertragen
- Repo öffentlich schalten und GitHub Pages aktivieren

## Auf den Geräten
- **Android (Chrome):** `https://dilldapp74.github.io/depot-dashboard/` öffnen → ⋮ → **App installieren**,
  anmelden, unter Alerts **Push aktivieren**.
- **Mac:** dieselbe Adresse in Chrome → Installieren-Symbol in der Adressleiste (oder Safari → Ablage →
  **Zum Dock hinzufügen**), anmelden, **Push aktivieren**.

## Prüfen und Fehlersuche
- **Cron-Läufe:** Integrations → Cron → Jobs → `depot-alerts` → History
- **Diagnose:** im SQL Editor
  ```sql
  select net.http_post(url := 'https://ulxfxsirinucxxprlwjd.supabase.co/functions/v1/depot',
    body := '{"aktion": "status"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'depot_cron_secret')));
  -- ein paar Sekunden später:
  select status_code, content from net._http_response order by id desc limit 1;
  ```
  Antwort `yahoo: "erreichbar"` = Kurse kommen an, `push: true` = Push-Schlüssel ist gesetzt.

## Neu aufsetzen (anderes Projekt)
1. Neues Projekt, dann `supabase/schema.sql` im SQL Editor ausführen.
2. `supabase/functions/depot/index.ts` als Edge Function `depot` deployen, „Verify JWT“ aus.
3. Cron-Block am Ende von `schema.sql` mit der neuen Projekt-ID ausführen.
4. Registrierung abschalten, Site URL setzen, `config.js` anpassen, Schritte „Nur du“.

## Gut zu wissen
- Kostenlose Supabase-Projekte werden nach etwa einer Woche ohne Nutzung pausiert. Im Dashboard
  lassen sie sich mit einem Klick wieder starten.
- **Abmelden** in der App schaltet Push auf diesem Gerät ab und löscht den gespeicherten Stand dort.
- Lokale Fassung (`python3 server.py`, nur dieser Mac): in `config.js` `SUPABASE_URL` leeren.
