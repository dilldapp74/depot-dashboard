-- Depot-Dashboard – Datenbank-Schema für Supabase
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und "Run" klicken.
-- Das Skript ist wiederholbar: Es legt nur an, was noch fehlt, und erneuert Regeln und Rechte.
--
-- Zugriffsschutz: Jede Zeile gehört einem Konto (user_id). Angemeldete Nutzer sehen und ändern
-- ausschließlich ihre eigenen Zeilen. Ohne Anmeldung (Rolle "anon") gibt es keinerlei Zugriff.
-- Die Edge Function "depot" arbeitet mit dem Service-Schlüssel und prüft selbst, wer anfragt.

-- ---------- Tabellen ----------

-- Positionen (entspricht holdings.json der lokalen Fassung)
create table if not exists public.positionen (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null default '',
  kennung    text not null,                 -- ISIN oder Yahoo-Ticker
  depot      text not null default '',
  anteile    numeric not null default 0,
  einstand   numeric,                       -- gesamter Kaufpreis in €, optional
  symbol     text,                          -- aufgelöstes Yahoo-Symbol (setzt die Edge Function)
  geaendert  timestamptz not null default now(),
  constraint positionen_laengen check (
    char_length(name) <= 120 and char_length(kennung) between 1 and 40
    and char_length(depot) <= 60 and char_length(coalesce(symbol, '')) <= 40),
  constraint positionen_werte check (anteile >= 0 and (einstand is null or einstand >= 0))
);
create index if not exists positionen_user on public.positionen (user_id);

-- Alert-Regeln
create table if not exists public.alert_regeln (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  typ       text not null,
  ziel      text not null default '*',      -- Kennung einer Position oder '*' = alle
  wert      numeric not null,
  aktiv     boolean not null default true,
  erstellt  timestamptz not null default now(),
  constraint alert_regeln_typ check (typ in
    ('day_move', 'portfolio_day_move', 'price_above', 'price_below', 'pl_below')),
  constraint alert_regeln_wert check (wert > 0 and wert < 10000000),
  constraint alert_regeln_ziel check (char_length(ziel) between 1 and 40)
);
create index if not exists alert_regeln_user on public.alert_regeln (user_id);

-- Zustand der Alerts (verhindert doppelte Meldungen) – nur für die Edge Function
create table if not exists public.alert_zustand (
  user_id    uuid not null references auth.users (id) on delete cascade,
  schluessel text not null,
  gesetzt    timestamptz not null default now(),
  primary key (user_id, schluessel)
);

-- Protokoll ausgelöster Alerts
create table if not exists public.alert_protokoll (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users (id) on delete cascade,
  zeit     timestamptz not null default now(),
  titel    text not null,
  text     text not null default ''
);
create index if not exists alert_protokoll_user_zeit on public.alert_protokoll (user_id, zeit desc);

-- Ein Eintrag je Gerät mit eingeschalteten Push-Mitteilungen
create table if not exists public.push_abos (
  endpoint  text primary key,
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh    text not null,
  auth      text not null,
  geraet    text not null default '',
  erstellt  timestamptz not null default now(),
  constraint push_abos_laengen check (
    endpoint like 'https://%' and char_length(endpoint) <= 1000
    and char_length(p256dh) <= 200 and char_length(auth) <= 100 and char_length(geraet) <= 200)
);

-- ---------- Zugriffsschutz (Row Level Security) ----------

alter table public.positionen      enable row level security;
alter table public.alert_regeln    enable row level security;
alter table public.alert_zustand   enable row level security;  -- ohne Regeln: kein direkter Zugriff
alter table public.alert_protokoll enable row level security;
alter table public.push_abos       enable row level security;

drop policy if exists "eigene Positionen" on public.positionen;
create policy "eigene Positionen" on public.positionen for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "eigene Regeln" on public.alert_regeln;
create policy "eigene Regeln" on public.alert_regeln for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "eigenes Protokoll lesen" on public.alert_protokoll;
create policy "eigenes Protokoll lesen" on public.alert_protokoll for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "eigenes Protokoll leeren" on public.alert_protokoll;
create policy "eigenes Protokoll leeren" on public.alert_protokoll for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "eigene Push-Abos" on public.push_abos;
create policy "eigene Push-Abos" on public.push_abos for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- Rechte: so wenig wie nötig ----------

revoke all on public.positionen, public.alert_regeln, public.alert_zustand,
  public.alert_protokoll, public.push_abos from anon, authenticated;

grant select, insert, update, delete on public.positionen   to authenticated;
grant select, insert, update, delete on public.alert_regeln to authenticated;
grant select, delete                 on public.alert_protokoll to authenticated;
grant select, insert, update, delete on public.push_abos    to authenticated;
-- Fremde user_id setzen geht nicht: Die Regeln oben prüfen "with check (user_id = auth.uid())".

-- ---------- Standard-Alerts für neue Konten ----------
-- Legt beim ersten Anmelden (genauer: beim Anlegen des Kontos) die zwei Grundregeln an.

create or replace function public.standard_alerts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.alert_regeln (user_id, typ, ziel, wert) values
    (new.id, 'day_move', '*', 5),
    (new.id, 'portfolio_day_move', '*', 3);
  return new;
end $$;
revoke execute on function public.standard_alerts() from public, anon, authenticated;

drop trigger if exists standard_alerts on auth.users;
create trigger standard_alerts after insert on auth.users
  for each row execute function public.standard_alerts();

-- ---------- Cron-Geheimnis (Vault) ----------
-- Die Datenbank erzeugt das Geheimnis selbst und bewahrt es verschlüsselt im Vault auf.
-- Der Cron-Job schickt es mit, die Edge Function prüft es über cron_geheimnis_ok() – niemand muss es abtippen.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'depot_cron_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'depot_cron_secret', 'Cron-Aufruf der Edge Function depot');
  end if;
end $$;

create or replace function public.cron_geheimnis_ok(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'depot_cron_secret' and decrypted_secret = p);
$$;
revoke execute on function public.cron_geheimnis_ok(text) from public, anon, authenticated;
grant execute on function public.cron_geheimnis_ok(text) to service_role;

-- ---------- Alerts regelmäßig prüfen (Cron) ----------
-- Erst ausführen, wenn die Edge Function "depot" deployt ist.
-- PROJEKT-ID ersetzen (der Teil vor .supabase.co), dann diesen Block einzeln im SQL Editor ausführen.
-- Prüft alle 5 Minuten (Krypto rund um die Uhr; Aktien ändern sich außerhalb der Handelszeit nicht).
--
-- create extension if not exists pg_cron with schema pg_catalog;
-- create extension if not exists pg_net with schema extensions;
-- select cron.unschedule('depot-alerts') where exists (select 1 from cron.job where jobname = 'depot-alerts');
-- select cron.schedule('depot-alerts', '*/5 * * * *', $job$
--   select net.http_post(
--     url := 'https://PROJEKT-ID.supabase.co/functions/v1/depot',
--     body := '{"aktion": "cron"}'::jsonb,
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
--       (select decrypted_secret from vault.decrypted_secrets where name = 'depot_cron_secret')),
--     timeout_milliseconds := 30000
--   )
-- $job$);
