-- Depot-Dashboard – Spieldepot (Paper-Trading), Ergänzung zu schema.sql
-- Wiederholbar. Im SQL Editor ausführen (oder als Migration einspielen).
--
-- Grundsatz: Orders bucht nur die Edge Function "depot" über sim_buchen() – mit dem Kurs, den sie selbst
-- abruft. Angemeldete Nutzer dürfen ihre Spieldepots und Regeln verwalten, Orders und Tageswerte nur lesen.

-- ---------- Tabellen ----------

create table if not exists public.spieldepots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null default 'Spieldepot',
  startkapital  numeric not null default 25000,
  bargeld       numeric not null default 25000,
  gebuehr       numeric not null default 1,          -- € pro Order
  erstellt      timestamptz not null default now(),
  constraint spieldepots_werte check (
    char_length(name) between 1 and 60 and startkapital > 0 and startkapital <= 10000000
    and bargeld >= 0 and gebuehr >= 0 and gebuehr <= 100)
);
create index if not exists spieldepots_user on public.spieldepots (user_id);

create table if not exists public.sim_orders (
  id        bigint generated always as identity primary key,
  depot_id  uuid not null references public.spieldepots (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  zeit      timestamptz not null default now(),
  kennung   text not null,
  symbol    text not null,
  name      text not null default '',
  seite     text not null,
  anteile   numeric not null,
  kurs      numeric not null,
  gebuehr   numeric not null default 0,
  quelle    text not null default 'manuell',          -- 'manuell' oder 'regel:<typ>'
  constraint sim_orders_werte check (seite in ('kauf', 'verkauf') and anteile > 0 and kurs > 0 and gebuehr >= 0)
);
create index if not exists sim_orders_depot_zeit on public.sim_orders (depot_id, zeit desc);

create table if not exists public.sim_regeln (
  id                 uuid primary key default gen_random_uuid(),
  depot_id           uuid not null references public.spieldepots (id) on delete cascade,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  typ                text not null,
  parameter          jsonb not null default '{}',
  aktiv              boolean not null default true,
  erstellt           timestamptz not null default now(),
  zustand            jsonb not null default '{}',      -- nur die Edge Function schreibt hier
  letzte_meldung     text not null default '',
  constraint sim_regeln_typ check (typ in ('sparplan', 'rebalancing', 'nachkauf', 'trend'))
);
create index if not exists sim_regeln_depot on public.sim_regeln (depot_id);

create table if not exists public.sim_tageswerte (
  depot_id  uuid not null references public.spieldepots (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  tag       date not null,
  wert      numeric not null,
  bargeld   numeric not null,
  primary key (depot_id, tag)
);

-- Neues Spieldepot: Bargeld = Startkapital (egal, was der Browser schickt)
create or replace function public.spieldepot_start() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.bargeld := new.startkapital;
  return new;
end $$;
drop trigger if exists spieldepot_start on public.spieldepots;
create trigger spieldepot_start before insert on public.spieldepots
  for each row execute function public.spieldepot_start();

-- Regeln dürfen nur im eigenen Depot entstehen
create or replace function public.sim_regel_depot_pruefen() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.spieldepots d where d.id = new.depot_id and d.user_id = new.user_id) then
    raise exception 'Spieldepot gehört nicht zu diesem Konto';
  end if;
  return new;
end $$;
revoke execute on function public.spieldepot_start(), public.sim_regel_depot_pruefen() from public, anon, authenticated;
drop trigger if exists sim_regel_depot_pruefen on public.sim_regeln;
create trigger sim_regel_depot_pruefen before insert or update of depot_id, user_id on public.sim_regeln
  for each row execute function public.sim_regel_depot_pruefen();

-- ---------- Zugriffsschutz ----------

alter table public.spieldepots    enable row level security;
alter table public.sim_orders     enable row level security;
alter table public.sim_regeln     enable row level security;
alter table public.sim_tageswerte enable row level security;

drop policy if exists "eigene Spieldepots" on public.spieldepots;
create policy "eigene Spieldepots" on public.spieldepots for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "eigene Sim-Orders lesen" on public.sim_orders;
create policy "eigene Sim-Orders lesen" on public.sim_orders for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "eigene Sim-Regeln" on public.sim_regeln;
create policy "eigene Sim-Regeln" on public.sim_regeln for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "eigene Tageswerte lesen" on public.sim_tageswerte;
create policy "eigene Tageswerte lesen" on public.sim_tageswerte for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.spieldepots, public.sim_orders, public.sim_regeln, public.sim_tageswerte from anon, authenticated;
grant select, insert, delete on public.spieldepots to authenticated;
grant update (name, gebuehr) on public.spieldepots to authenticated;      -- Bargeld ändert nur sim_buchen()
grant select on public.sim_orders, public.sim_tageswerte to authenticated;
grant select, insert, delete on public.sim_regeln to authenticated;
grant update (typ, parameter, aktiv) on public.sim_regeln to authenticated; -- zustand schreibt nur die Function

-- Zahl im deutschen Format für Fehlermeldungen (1.234,56)
create or replace function public.de_zahl(x numeric, stellen int) returns text
language sql immutable set search_path = '' as $$
  select translate(to_char(round(x, stellen), 'FM999G999G999G990D' || repeat('0', stellen)), ',.', '.,');
$$;
revoke execute on function public.de_zahl(numeric, int) from public, anon, authenticated;

-- ---------- Buchung (nur für die Edge Function) ----------
-- Prüft Bargeld bzw. Bestand, bucht Order und Bargeld in einem Schritt (Zeile gesperrt, keine halben Buchungen).

create or replace function public.sim_buchen(
  p_depot uuid, p_user uuid, p_kennung text, p_symbol text, p_name text,
  p_seite text, p_anteile numeric, p_kurs numeric, p_quelle text
) returns public.sim_orders
language plpgsql security definer set search_path = '' as $$
declare
  d public.spieldepots;
  bestand numeric;
  betrag numeric;
  o public.sim_orders;
begin
  select * into d from public.spieldepots where id = p_depot and user_id = p_user for update;
  if not found then raise exception 'Spieldepot nicht gefunden'; end if;
  if p_anteile is null or p_anteile <= 0 or p_kurs is null or p_kurs <= 0 then
    raise exception 'Ungültige Order';
  end if;
  betrag := round(p_anteile * p_kurs, 2);

  if p_seite = 'kauf' then
    if betrag + d.gebuehr > d.bargeld + 0.005 then
      raise exception 'Nicht genug Spielgeld: benötigt % €, verfügbar % €',
        public.de_zahl(betrag + d.gebuehr, 2), public.de_zahl(d.bargeld, 2);
    end if;
    update public.spieldepots set bargeld = round(bargeld - betrag - d.gebuehr, 2) where id = p_depot;
  elsif p_seite = 'verkauf' then
    select coalesce(sum(case when seite = 'kauf' then anteile else -anteile end), 0) into bestand
      from public.sim_orders where depot_id = p_depot and kennung = p_kennung;
    if p_anteile > bestand + 0.0000005 then
      raise exception 'Nicht genug Anteile: % vorhanden', public.de_zahl(bestand, 6);
    end if;
    update public.spieldepots set bargeld = round(bargeld + betrag - d.gebuehr, 2) where id = p_depot;
  else
    raise exception 'Unbekannte Seite %', p_seite;
  end if;

  insert into public.sim_orders (depot_id, user_id, kennung, symbol, name, seite, anteile, kurs, gebuehr, quelle)
    values (p_depot, p_user, p_kennung, p_symbol, coalesce(p_name, ''), p_seite, p_anteile, p_kurs, d.gebuehr, p_quelle)
    returning * into o;
  return o;
end $$;
revoke execute on function public.sim_buchen(uuid, uuid, text, text, text, text, numeric, numeric, text)
  from public, anon, authenticated;
grant execute on function public.sim_buchen(uuid, uuid, text, text, text, text, numeric, numeric, text) to service_role;
