-- Depot-Dashboard – echtes Depot als Buchungen (Kauf/Verkauf mit Datum) statt fester Positionen.
-- Wiederholbar. Den Bestand je Wert und Depot rechnet die Edge Function daraus (bestand.ts).
-- Die alte Tabelle "positionen" bleibt als Sicherung stehen, wird von der App aber nicht mehr benutzt.

create table if not exists public.buchungen (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kennung   text not null,                 -- ISIN oder Yahoo-Ticker
  name      text not null default '',
  depot     text not null default '',
  symbol    text,                          -- aufgelöstes Yahoo-Symbol (setzt die Edge Function)
  art       text not null,                 -- kauf | verkauf
  datum     date,                          -- null = Anfangsbestand ohne Datum
  anteile   numeric not null,
  betrag    numeric,                       -- € gesamt inkl. Gebühren; null = unbekannt
  erstellt  timestamptz not null default now(),
  constraint buchungen_art check (art in ('kauf', 'verkauf')),
  constraint buchungen_werte check (anteile > 0 and (betrag is null or betrag >= 0)),
  constraint buchungen_laengen check (
    char_length(name) <= 120 and char_length(kennung) between 1 and 40
    and char_length(depot) <= 60 and char_length(coalesce(symbol, '')) <= 40)
);
create index if not exists buchungen_user on public.buchungen (user_id);

alter table public.buchungen enable row level security;
drop policy if exists "eigene Buchungen" on public.buchungen;
create policy "eigene Buchungen" on public.buchungen for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.buchungen from anon, authenticated;
grant select, insert, update, delete on public.buchungen to authenticated;

-- Einmalige Übernahme: jede bisherige Position wird ein Anfangsbestand (Kauf ohne Datum, Betrag = Einstand).
-- Nur für Konten, die noch keine Buchungen haben – so kann das Skript gefahrlos wiederholt werden.
insert into public.buchungen (user_id, kennung, name, depot, symbol, art, datum, anteile, betrag)
select p.user_id, p.kennung, p.name, p.depot, p.symbol, 'kauf', null, p.anteile, p.einstand
from public.positionen p
where p.anteile > 0
  and not exists (select 1 from public.buchungen b where b.user_id = p.user_id);
