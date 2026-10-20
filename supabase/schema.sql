-- ============================================================
--  KickOff Division — Supabase schema
--  Run this once in Supabase → SQL Editor → New query → Run.
--  Safe to re-run: tables use IF NOT EXISTS, policies are dropped
--  and recreated, and the seed rows use ON CONFLICT DO NOTHING.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ROLES + PROFILES
-- ------------------------------------------------------------
do $$
begin
  create type public.app_role as enum ('admin', 'viewer');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role public.app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- Every new Supabase Auth user gets a read-only profile automatically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for accounts created before this schema existed.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Helper used by the write policies below. SECURITY DEFINER avoids
-- recursive RLS checks on public.profiles.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- ------------------------------------------------------------
-- 2. LEAGUE TABLES
-- ------------------------------------------------------------
create table if not exists public.teams (
  id text primary key,
  name text not null,
  code text not null default 'TBD',
  color text not null default '#16a34a',
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id text primary key,
  team_id text not null references public.teams (id) on delete cascade,
  name text not null,
  pos text not null default 'MID' check (pos in ('GK', 'DEF', 'MID', 'FWD')),
  num int not null default 10,
  goals int not null default 0,
  yellow int not null default 0,
  red int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.matches (
  id text primary key,
  round int not null default 1,
  home_id text not null references public.teams (id) on delete cascade,
  away_id text not null references public.teams (id) on delete cascade,
  home_score int not null default 0,
  away_score int not null default 0,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'LIVE', 'FINISHED')),
  datetime text,
  venue text,
  scorers_text text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. GRANTS (RLS still decides what each role may do)
-- ------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.teams, public.players, public.matches to anon, authenticated;
grant insert, update, delete on public.teams, public.players, public.matches to authenticated;
grant select on public.profiles to authenticated;

-- ------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.matches enable row level security;

-- Profiles: users see their own role; admins see everyone.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (auth.uid() = id);

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin());

-- Teams: public read, admin write.
drop policy if exists teams_select_all on public.teams;
create policy teams_select_all on public.teams
  for select to anon, authenticated using (true);

drop policy if exists teams_insert_admin on public.teams;
create policy teams_insert_admin on public.teams
  for insert to authenticated with check (public.is_admin());

drop policy if exists teams_update_admin on public.teams;
create policy teams_update_admin on public.teams
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists teams_delete_admin on public.teams;
create policy teams_delete_admin on public.teams
  for delete to authenticated using (public.is_admin());

-- Players: public read, admin write.
drop policy if exists players_select_all on public.players;
create policy players_select_all on public.players
  for select to anon, authenticated using (true);

drop policy if exists players_insert_admin on public.players;
create policy players_insert_admin on public.players
  for insert to authenticated with check (public.is_admin());

drop policy if exists players_update_admin on public.players;
create policy players_update_admin on public.players
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists players_delete_admin on public.players;
create policy players_delete_admin on public.players
  for delete to authenticated using (public.is_admin());

-- Matches: public read, admin write.
drop policy if exists matches_select_all on public.matches;
create policy matches_select_all on public.matches
  for select to anon, authenticated using (true);

drop policy if exists matches_insert_admin on public.matches;
create policy matches_insert_admin on public.matches
  for insert to authenticated with check (public.is_admin());

drop policy if exists matches_update_admin on public.matches;
create policy matches_update_admin on public.matches
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists matches_delete_admin on public.matches;
create policy matches_delete_admin on public.matches
  for delete to authenticated using (public.is_admin());

-- ------------------------------------------------------------
-- 5. SEED DATA (optional — delete this block to start empty)
-- ------------------------------------------------------------
insert into public.teams (id, name, code, color) values
  ('t1', 'Spartan FC',        'SFC', '#3b82f6'),
  ('t2', 'Titan United',      'TTN', '#10b981'),
  ('t3', 'Phoenix Rovers',    'PHX', '#f59e0b'),
  ('t4', 'Vanguard Athletic', 'VNG', '#ef4444'),
  ('t5', 'Atlas Warriors',    'ATL', '#8b5cf6'),
  ('t6', 'Coastal Sharks',    'CSH', '#06b6d4')
on conflict (id) do nothing;

insert into public.players (id, team_id, name, pos, num, goals, yellow, red) values
  ('p1', 't1', 'David Silva',  'MID', 10, 5, 1, 0),
  ('p2', 't1', 'Carlos Ramos', 'FWD',  9, 7, 0, 0),
  ('p3', 't2', 'Ethan Hunt',   'FWD', 11, 4, 2, 0),
  ('p4', 't3', 'Leo Mendes',   'MID',  8, 6, 0, 0),
  ('p5', 't4', 'John Terry',   'DEF',  4, 1, 3, 1),
  ('p6', 't5', 'Omar Belaid',  'FWD',  7, 8, 1, 0),
  ('p7', 't5', 'Karim Ziani',  'MID',  6, 2, 2, 0),
  ('p8', 't6', 'Lucas Ferrao', 'FWD',  9, 3, 0, 0),
  ('p9', 't6', 'Sam Okafor',   'GK',   1, 0, 0, 0)
on conflict (id) do nothing;

insert into public.matches (id, round, home_id, away_id, home_score, away_score, status, datetime, venue, scorers_text) values
  ('m1', 1, 't1', 't2', 3, 1, 'FINISHED',  '2026-10-03T15:00', 'Main Field - Pitch 1',     'Carlos Ramos (2), David Silva (1) - Ethan Hunt (1)'),
  ('m2', 1, 't3', 't4', 2, 2, 'FINISHED',  '2026-10-03T17:30', 'Main Field - Pitch 2',     'Leo Mendes (2) - John Terry (1), K. Diaz (1)'),
  ('m3', 1, 't5', 't6', 1, 0, 'FINISHED',  '2026-10-04T16:00', 'Community Sports Complex', 'Omar Belaid (1)'),
  ('m4', 2, 't2', 't3', 0, 1, 'FINISHED',  '2026-10-10T15:30', 'United Arena',             'Leo Mendes (1)'),
  ('m5', 2, 't4', 't5', 2, 2, 'FINISHED',  '2026-10-11T18:00', 'Vanguard Ground',          'John Terry (1), R. Cole (1) - Omar Belaid (2)'),
  ('m6', 2, 't6', 't1', 1, 1, 'LIVE',      '2026-10-20T19:00', 'Shark Park',               'Lucas Ferrao (1) - Carlos Ramos (1)'),
  ('m7', 3, 't1', 't3', 0, 0, 'SCHEDULED', '2026-10-24T15:00', 'Main Field - Pitch 1',     ''),
  ('m8', 3, 't2', 't5', 0, 0, 'SCHEDULED', '2026-10-25T17:00', 'United Arena',             ''),
  ('m9', 3, 't4', 't6', 0, 0, 'SCHEDULED', '2026-10-25T19:30', 'Vanguard Ground',          '')
on conflict (id) do nothing;

-- ============================================================
-- 6. MAKE YOURSELF ADMIN
--    ️Sign up once in the app (Admin Login → Create account),
--    confirm your email if required, then run:
--
--    update public.profiles
--       set role = 'admin'
--     where email = 'you@example.com';
--
--    Log out and back in — write controls will appear.
-- ============================================================
