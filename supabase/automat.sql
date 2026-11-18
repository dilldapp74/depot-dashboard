-- Depot-Dashboard – Handelsautomat (Bot-Spieldepot), Ergänzung zu spieldepot.sql
-- Wiederholbar. Der Automat läuft in der Edge Function "depot" (Cron); er rechnet mit handel.ts und
-- speichert jede Order samt Steuerstand über bot_buchen() – in einem Schritt, mit gesperrter Depot-Zeile.

-- ---------- Spalten ----------

alter table public.spieldepots add column if not exists art text not null default 'manuell';
alter table public.spieldepots add column if not exists einstellungen jsonb not null default '{}';
alter table public.spieldepots add column if not exists pausiert boolean not null default false;
alter table public.spieldepots add column if not exists steuer jsonb not null default '{}';          -- Steuerjahr (handel.ts)
alter table public.spieldepots add column if not exists gesperrt jsonb not null default '{}';        -- Kennung → Sperre bis
alter table public.spieldepots add column if not exists letzter_lauf text not null default '';      -- JJJJ-MM-TT
alter table public.spieldepots add column if not exists letzte_rotation text not null default '';   -- Montag der Woche
do $$ begin
  alter table public.spieldepots add constraint spieldepots_art check (art in ('manuell', 'bot'));
exception when duplicate_object then null; end $$;

alter table public.sim_orders add column if not exists klasse text not null default '';
alter table public.sim_orders add column if not exists spread numeric not null default 0;
alter table public.sim_orders add column if not exists realisiert numeric;
alter table public.sim_orders add column if not exists steuer numeric not null default 0;
alter table public.sim_orders add column if not exists grund text not null default '';

-- Nutzer dürfen den Automaten pausieren, aber keine Rechenstände ändern
grant update (pausiert) on public.spieldepots to authenticated;

-- ---------- Protokoll jeder Entscheidung ----------

create table if not exists public.bot_protokoll (
  id        bigint generated always as identity primary key,
  depot_id  uuid not null references public.spieldepots (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  zeit      timestamptz not null default now(),
  art       text not null,           -- lauf | kauf | verkauf | stop | pruefung | steuer | fehler
  text      text not null default '',
  daten     jsonb not null default '{}'
);
create index if not exists bot_protokoll_depot_zeit on public.bot_protokoll (depot_id, zeit desc);
alter table public.bot_protokoll enable row level security;
drop policy if exists "eigenes Bot-Protokoll lesen" on public.bot_protokoll;
create policy "eigenes Bot-Protokoll lesen" on public.bot_protokoll for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.bot_protokoll from anon, authenticated;
grant select on public.bot_protokoll to authenticated;

-- ---------- Buchung einer Automat-Order (nur für die Edge Function) ----------
-- Kauf:    Bargeld − (Anteile × Kurs + Gebühr), nur wenn das Geld ohne Steuerrücklage reicht
-- Verkauf: Bargeld + Anteile × Kurs − Gebühr − Steuer (Steuer negativ = Erstattung), nur mit genug Bestand
-- Der Steuerstand nach der Order (von handel.ts berechnet) wird mitgespeichert.

create or replace function public.bot_buchen(
  p_depot uuid, p_kennung text, p_symbol text, p_name text, p_klasse text, p_seite text,
  p_anteile numeric, p_kurs numeric, p_gebuehr numeric, p_spread numeric, p_realisiert numeric,
  p_steuer numeric, p_steuerjahr jsonb, p_ruecklage numeric, p_grund text
) returns public.sim_orders
language plpgsql security definer set search_path = '' as $$
declare
  d public.spieldepots;
  bestand numeric;
  o public.sim_orders;
begin
  select * into d from public.spieldepots where id = p_depot and art = 'bot' for update;
  if not found then raise exception 'Bot-Depot nicht gefunden'; end if;
  if p_anteile is null or p_anteile <= 0 or p_kurs is null or p_kurs <= 0 then raise exception 'Ungültige Order'; end if;

  if p_seite = 'kauf' then
    if p_anteile * p_kurs + p_gebuehr > d.bargeld - coalesce(p_ruecklage, 0) + 0.01 then
      raise exception 'Nicht genug freies Spielgeld: benötigt % €, frei % €',
        public.de_zahl(p_anteile * p_kurs + p_gebuehr, 2), public.de_zahl(d.bargeld - coalesce(p_ruecklage, 0), 2);
    end if;
    update public.spieldepots set bargeld = bargeld - (p_anteile * p_kurs + p_gebuehr), steuer = p_steuerjahr where id = p_depot;
  elsif p_seite = 'verkauf' then
    select coalesce(sum(case when seite = 'kauf' then anteile else -anteile end), 0) into bestand
      from public.sim_orders where depot_id = p_depot and kennung = p_kennung;
    if p_anteile > bestand + 0.0000005 then raise exception 'Nicht genug Anteile: % vorhanden', public.de_zahl(bestand, 6); end if;
    update public.spieldepots set bargeld = bargeld + p_anteile * p_kurs - p_gebuehr - coalesce(p_steuer, 0), steuer = p_steuerjahr
      where id = p_depot;
  else
    raise exception 'Unbekannte Seite %', p_seite;
  end if;

  insert into public.sim_orders (depot_id, user_id, kennung, symbol, name, seite, anteile, kurs, gebuehr, quelle,
      klasse, spread, realisiert, steuer, grund)
    values (p_depot, d.user_id, p_kennung, p_symbol, coalesce(p_name, ''), p_seite, p_anteile, p_kurs, p_gebuehr, 'automat',
      p_klasse, coalesce(p_spread, 0), p_realisiert, coalesce(p_steuer, 0), coalesce(p_grund, ''))
    returning * into o;
  return o;
end $$;

-- Jahreswechsel: Krypto-Steuer des Vorjahres abbuchen und neues Steuerjahr setzen
create or replace function public.bot_steuer_abrechnen(p_depot uuid, p_betrag numeric, p_steuerjahr jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.spieldepots set bargeld = bargeld - coalesce(p_betrag, 0), steuer = p_steuerjahr where id = p_depot and art = 'bot';
  if not found then raise exception 'Bot-Depot nicht gefunden'; end if;
end $$;

revoke execute on function public.bot_buchen(uuid, text, text, text, text, text, numeric, numeric, numeric, numeric, numeric,
  numeric, jsonb, numeric, text) from public, anon, authenticated;
grant execute on function public.bot_buchen(uuid, text, text, text, text, text, numeric, numeric, numeric, numeric, numeric,
  numeric, jsonb, numeric, text) to service_role;
revoke execute on function public.bot_steuer_abrechnen(uuid, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.bot_steuer_abrechnen(uuid, numeric, jsonb) to service_role;

-- ---------- Phase 4: Claude prüft jeden neuen Kauf ----------
-- Die Umschichtung legt für jeden neuen Wert eine Prüfung an (einmal je Woche und Wert). Der Cron arbeitet
-- je Lauf höchstens eine ab und setzt danach "nachlauf", damit der Automat am selben Tag noch einmal läuft
-- und freigegebene Käufe ausführt. Abgelehnte Werte bleiben für den Rest der Woche gesperrt.
-- Status: offen | frei | abgelehnt | demo (ohne API-Schlüssel) | ohne (Grenze erreicht) | fehler | verfallen

alter table public.spieldepots add column if not exists nachlauf boolean not null default false;

create table if not exists public.bot_pruefungen (
  id          bigint generated always as identity primary key,
  depot_id    uuid not null references public.spieldepots (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  woche       text not null,            -- Montag der Woche
  kennung     text not null,
  name        text not null default '',
  klasse      text not null default '',
  grund       text not null default '',  -- Kaufgrund der Strategie
  status      text not null default 'offen',
  urteil      jsonb not null default '{}',
  modell      text not null default '',
  kosten_usd  numeric not null default 0,
  zeit        timestamptz not null default now(),
  erledigt    timestamptz,
  unique (depot_id, woche, kennung)
);
create index if not exists bot_pruefungen_offen on public.bot_pruefungen (status, zeit);
alter table public.bot_pruefungen enable row level security;
drop policy if exists "eigene Prüfungen lesen" on public.bot_pruefungen;
create policy "eigene Prüfungen lesen" on public.bot_pruefungen for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.bot_pruefungen from anon, authenticated;
grant select on public.bot_pruefungen to authenticated;
