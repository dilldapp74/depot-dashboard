-- Depot-Dashboard – Recherche-Assistent (Claude mit Websuche), Ergänzung zu schema.sql
-- Wiederholbar. Aufträge entstehen, wenn ein Tagesbewegungs-Alert auslöst; die Edge Function "depot"
-- arbeitet sie im Hintergrund ab (höchstens einen je Cron-Lauf, mit Tages- und Monatsgrenze).

create table if not exists public.recherchen (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  zeit       timestamptz not null default now(),
  tag        date not null default (now() at time zone 'Europe/Berlin')::date,
  kennung    text not null,
  symbol     text not null default '',
  name       text not null default '',
  anlass     text not null default '',
  status     text not null default 'offen',    -- offen | fertig | demo | fehler | uebersprungen
  modell     text not null default '',
  inhalt     jsonb not null default '{}',       -- { kurzfassung, gruende[], quellen[{titel,url}], sicherheit } bzw. { fehler }
  kosten_usd numeric not null default 0,
  constraint recherchen_status check (status in ('offen', 'fertig', 'demo', 'fehler', 'uebersprungen'))
);
create unique index if not exists recherchen_einmal_pro_tag on public.recherchen (user_id, kennung, tag);
create index if not exists recherchen_offen on public.recherchen (status, zeit) where status = 'offen';
create index if not exists recherchen_user_zeit on public.recherchen (user_id, zeit desc);

alter table public.recherchen enable row level security;
drop policy if exists "eigene Recherchen lesen" on public.recherchen;
create policy "eigene Recherchen lesen" on public.recherchen for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.recherchen from anon, authenticated;
grant select on public.recherchen to authenticated;
