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
  create type public.app_role as enum ('admin', 'viewer', 'scorer');
exception
  when duplicate_object then null;
end $$;

-- Projects created before roadmap B only have admin/viewer. Adding the value
-- separately keeps this file safe to re-run on both old and new databases.
alter type public.app_role add value if not exists 'scorer';

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
create table if not exists public.security_settings (
  id boolean primary key default true check (id),
  require_admin_mfa boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.security_settings (id, require_admin_mfa)
values (true, false)
on conflict (id) do nothing;

alter table public.security_settings enable row level security;
revoke all on public.security_settings from anon, authenticated;

create or replace function public.admin_mfa_required()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select require_admin_mfa from public.security_settings where id),
    false
  );
$$;

grant execute on function public.admin_mfa_required() to anon, authenticated;

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
  )
  and (
    not public.admin_mfa_required()
    or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- Match-day helpers. Scorers have their own narrow RPC path (section 6b-2) and
-- never inherit admin rights: is_admin() stays exactly as it was.
create or replace function public.is_scorer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    -- Compare as text so this helper can be created in the same transaction
    -- that adds the enum value on an older database.
    where id = auth.uid() and role::text = 'scorer'
  );
$$;

revoke execute on function public.is_scorer() from public, anon;
grant execute on function public.is_scorer() to authenticated;

-- Changing the MFA requirement needs a verified factor in this session.
create or replace function public.set_require_admin_mfa(p_required boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required boolean := coalesce(p_required, false);
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Only admins can change the MFA requirement' using errcode = '42501';
  end if;

  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
    raise exception 'Verify your authenticator app before changing MFA settings'
      using errcode = '42501';
  end if;

  update public.security_settings
     set require_admin_mfa = v_required,
         updated_at = now()
   where id;

  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log (actor_id, actor_email, action, entity, summary)
    values (
      auth.uid(),
      (select u.email from auth.users u where u.id = auth.uid()),
      'SECURITY',
      'security',
      case
        when v_required then 'Admin two-factor requirement enabled'
        else 'Admin two-factor requirement disabled'
      end
    );
  end if;
end;
$$;

revoke execute on function public.set_require_admin_mfa(boolean) from public, anon;
grant execute on function public.set_require_admin_mfa(boolean) to authenticated;

-- ------------------------------------------------------------
-- 2. SEASONS
-- ------------------------------------------------------------
create table if not exists public.seasons (
  id text primary key,
  name text not null,
  start_date date,
  end_date date,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kickoff_seasons_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_seasons_name_length check (length(btrim(name)) between 1 and 100),
  constraint kickoff_seasons_dates_order check (start_date is null or end_date is null or start_date <= end_date)
);

-- Keep the existing default season (or create it) without changing
-- which season is already active on a re-run.
insert into public.seasons (id, name, start_date, end_date, is_active)
values ('s1', '2026 Season', null, null, false)
on conflict (id) do nothing;

-- Repair multiple active seasons before enforcing the unique index.
update public.seasons s
set is_active = false
where s.is_active = true
  and s.id <> (
    select id from public.seasons
    where is_active = true
    order by created_at desc, id
    limit 1
  );

-- If every season is archived, reactivate the oldest one.
update public.seasons
set is_active = true
where id = (
  select id from public.seasons order by created_at asc, id asc limit 1
)
and not exists (select 1 from public.seasons where is_active = true);

create unique index if not exists seasons_one_active_idx
  on public.seasons (is_active)
  where is_active;

-- ------------------------------------------------------------
-- 2b. DIVISIONS (roadmap K)
-- ------------------------------------------------------------
-- Fixed competition tiers. The rows are seeded here and the UI translates
-- d1/d2 and shows a two-option switcher; adding a third tier later is a row
-- insert. There is no client write policy: only the maintainer changes tiers.
create table if not exists public.divisions (
  id text primary key,
  name text not null,
  sort_order int not null default 1,
  created_at timestamptz not null default now(),
  constraint kickoff_divisions_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_divisions_name_length check (length(btrim(name)) between 1 and 100)
);

insert into public.divisions (id, name, sort_order)
values ('d1', 'Division 1', 1),
       ('d2', 'Division 2', 2)
on conflict (id) do nothing;

-- Used by the write policies and RPCs to keep archived seasons read-only.
create or replace function public.is_active_season(p_season_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.seasons
    where id = p_season_id
      and is_active
  );
$$;

grant execute on function public.is_active_season(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. LEAGUE TABLES
-- ------------------------------------------------------------
create table if not exists public.teams (
  id text primary key,
  name text not null,
  name_ar text,
  -- Task I: a small crest, re-encoded by the browser and stored inline as a
  -- data URL so no external host is needed (the CSP stays img-src 'self' data:).
  icon text,
  code text not null default 'TBD',
  color text not null default '#16a34a',
  division_id text not null default 'd1' references public.divisions (id) on delete restrict,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kickoff_teams_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_teams_name_length check (length(btrim(name)) between 1 and 100),
  constraint kickoff_teams_name_ar_length check (name_ar is null or length(btrim(name_ar)) between 1 and 100),
  constraint kickoff_teams_icon_data check (
    icon is null or (
      length(icon) <= 100000
      and icon ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
    )
  ),
  constraint kickoff_teams_code_length check (length(btrim(code)) between 1 and 8),
  constraint kickoff_teams_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$')
);

-- Upgrade a teams table created before divisions existed. Existing clubs go to
-- Division 1 so the current league keeps its table unchanged.
alter table public.teams add column if not exists division_id text;

update public.teams t
set division_id = 'd1'
where t.division_id is null
   or not exists (select 1 from public.divisions d where d.id = t.division_id);

alter table public.teams alter column division_id set default 'd1';
alter table public.teams alter column division_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'teams_division_id_fkey'
      and conrelid = 'public.teams'::regclass
  ) then
    alter table public.teams
      add constraint teams_division_id_fkey
      foreign key (division_id) references public.divisions (id) on delete restrict;
  end if;
end $$;

create index if not exists teams_division_id_idx on public.teams (division_id);

create table if not exists public.players (
  id text primary key,
  team_id text not null references public.teams (id) on delete cascade,
  name text not null,
  name_ar text,
  pos text not null default 'MID' check (pos in ('GK', 'DEF', 'MID', 'FWD')),
  num int not null default 10,
  legacy_goals int not null default 0,
  legacy_yellow int not null default 0,
  legacy_red int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint kickoff_players_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_players_name_length check (length(btrim(name)) between 1 and 100),
  constraint kickoff_players_name_ar_length check (name_ar is null or length(btrim(name_ar)) between 1 and 100),
  constraint kickoff_players_num_range check (num between 0 and 999),
  constraint kickoff_players_legacy_totals_range check (legacy_goals >= 0 and legacy_yellow >= 0 and legacy_red >= 0)
);

-- Licence number and birth date are personal data, so they live in their own
-- admin-only table instead of on the publicly readable players table. A player
-- has at most one row; deleting the player removes it.
create table if not exists public.player_profiles (
  player_id text primary key references public.players (id) on delete cascade,
  license_id text,
  birth_date date,
  updated_at timestamptz not null default now(),
  constraint kickoff_player_profiles_license_length check (license_id is null or length(btrim(license_id)) between 1 and 50),
  constraint kickoff_player_profiles_birth_date_range check (birth_date is null or birth_date between date '1900-01-01' and date '2100-12-31')
);

-- Optional but unique: the partial index compares trimmed, upper-cased values
-- so " ab-12 " and "AB-12" collide.
create unique index if not exists kickoff_player_profiles_license_key
  on public.player_profiles (upper(btrim(license_id)))
  where license_id is not null;

alter table public.players
  add column if not exists is_active boolean not null default true;

-- Totals entered before structured events existed. The derived views add the
-- counted events on top, so v_player_stats is the only place a player total
-- lives; see supabase/drop-stored-totals-migration.sql.
alter table public.players
  add column if not exists legacy_goals int not null default 0;
alter table public.players
  add column if not exists legacy_yellow int not null default 0;
alter table public.players
  add column if not exists legacy_red int not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'kickoff_players_legacy_totals_range'
      and conrelid = 'public.players'::regclass
  ) then
    alter table public.players
      add constraint kickoff_players_legacy_totals_range
      check (legacy_goals >= 0 and legacy_yellow >= 0 and legacy_red >= 0);
  end if;
end $$;

-- Bilingual names (task L). The Arabic name is optional; the Latin name stays
-- required. Every column is optional, so an older database keeps working while
-- the app reads them.
alter table public.teams add column if not exists name_ar text;
alter table public.players add column if not exists name_ar text;

-- Team crest (task I). Optional, stored inline as a data URL: no bucket, no
-- external origin, and a JSON/CSV backup carries the image with the league.
alter table public.teams add column if not exists icon text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'kickoff_teams_name_ar_length'
      and conrelid = 'public.teams'::regclass
  ) then
    alter table public.teams
      add constraint kickoff_teams_name_ar_length
      check (name_ar is null or length(btrim(name_ar)) between 1 and 100);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'kickoff_players_name_ar_length'
      and conrelid = 'public.players'::regclass
  ) then
    alter table public.players
      add constraint kickoff_players_name_ar_length
      check (name_ar is null or length(btrim(name_ar)) between 1 and 100);
  end if;

  -- Task I: only the image types the browser produces, and only as a data URL,
  -- so a backup cannot hotlink an external host or smuggle a script URI.
  if not exists (
    select 1 from pg_constraint
    where conname = 'kickoff_teams_icon_data'
      and conrelid = 'public.teams'::regclass
  ) then
    alter table public.teams
      add constraint kickoff_teams_icon_data
      check (
        icon is null or (
          length(icon) <= 100000
          and icon ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
        )
      );
  end if;
end $$;

create table if not exists public.matches (
  id text primary key,
  season_id text not null references public.seasons (id) on delete restrict,
  division_id text not null default 'd1' references public.divisions (id) on delete restrict,
  round int not null default 1,
  home_id text not null references public.teams (id) on delete cascade,
  away_id text not null references public.teams (id) on delete cascade,
  home_score int not null default 0,
  away_score int not null default 0,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'LIVE', 'FINISHED')),
  datetime text,
  venue text,
  scorers_text text,
  events_counted boolean not null default true,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kickoff_matches_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_matches_round_range check ("round" between 1 and 1000),
  constraint kickoff_matches_scores_range check (home_score between 0 and 999 and away_score between 0 and 999),
  constraint kickoff_matches_distinct_teams check (home_id <> away_id)
);

-- Upgrade a matches table created before divisions existed. Existing fixtures
-- take the home team's division, so a club that later moves does not rewrite
-- the history of matches it already played.
alter table public.matches add column if not exists division_id text;

update public.matches m
set division_id = coalesce(t.division_id, 'd1')
from public.teams t
where t.id = m.home_id
  and (
    m.division_id is null
    or not exists (select 1 from public.divisions d where d.id = m.division_id)
  );

alter table public.matches alter column division_id set default 'd1';
alter table public.matches alter column division_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'matches_division_id_fkey'
      and conrelid = 'public.matches'::regclass
  ) then
    alter table public.matches
      add constraint matches_division_id_fkey
      foreign key (division_id) references public.divisions (id) on delete restrict;
  end if;
end $$;

create index if not exists matches_division_id_idx on public.matches (division_id);

-- Upgrade a matches table created before seasons existed.
alter table public.matches add column if not exists season_id text;

-- Put any legacy fixture into the active season (or the oldest one).
update public.matches
set season_id = coalesce(
  (select id from public.seasons where is_active order by created_at desc limit 1),
  (select id from public.seasons order by created_at asc limit 1)
)
where season_id is null
   or season_id not in (select id from public.seasons);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'matches_season_id_fkey'
      and conrelid = 'public.matches'::regclass
  ) then
    alter table public.matches
      add constraint matches_season_id_fkey
      foreign key (season_id) references public.seasons (id) on delete restrict;
  end if;
end $$;

alter table public.matches alter column season_id set not null;

-- Existing fixtures already contributed to the manually maintained player
-- totals. Keep their events out of the counters to avoid double-counting;
-- new fixtures default to events_counted = true.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'matches'
      and column_name = 'events_counted'
  ) then
    alter table public.matches add column events_counted boolean not null default true;
    update public.matches set events_counted = false;
  end if;
end $$;

-- Goals and cards with a minute. Player totals remain the aggregate
-- counters on public.players; the event functions below keep them in sync.
create table if not exists public.match_events (
  id text primary key,
  match_id text not null references public.matches (id) on delete cascade,
  team_id text not null references public.teams (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  event_type text not null check (event_type in ('goal', 'yellow', 'red')),
  minute int not null check (minute between 1 and 130),
  created_at timestamptz not null default now()
);

create index if not exists match_events_match_id_idx
  on public.match_events (match_id);

create index if not exists match_events_player_id_idx
  on public.match_events (player_id);

-- Roadmap B: which scorer may record events for which fixture. Rows are
-- written only by set_match_officials(); clients can read their own
-- assignments (admins read all) through the RLS policy in section 5.
create table if not exists public.match_officials (
  match_id text not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (match_id, user_id)
);

create index if not exists match_officials_user_id_idx
  on public.match_officials (user_id);

-- Trash columns for projects created before soft delete existed.
alter table public.seasons add column if not exists deleted_at timestamptz;
alter table public.teams add column if not exists deleted_at timestamptz;
alter table public.matches add column if not exists deleted_at timestamptz;

create index if not exists seasons_deleted_idx
  on public.seasons (deleted_at) where deleted_at is not null;

create index if not exists teams_deleted_idx
  on public.teams (deleted_at) where deleted_at is not null;

create index if not exists matches_deleted_idx
  on public.matches (deleted_at) where deleted_at is not null;

create index if not exists matches_home_id_idx on public.matches (home_id);
create index if not exists matches_away_id_idx on public.matches (away_id);

-- ------------------------------------------------------------
-- 3a. DIVISION GUARDS (roadmap K)
-- ------------------------------------------------------------
-- A club can change division between seasons, but not while it has a fixture in
-- the active season: the live table must keep matching the fixtures it shows.
create or replace function public.guard_team_division()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.division_id is distinct from old.division_id then
    if exists (
      select 1
      from public.matches m
      join public.seasons s on s.id = m.season_id
      where m.deleted_at is null
        and s.is_active
        and new.id in (m.home_id, m.away_id)
    ) then
      raise exception 'A team with fixtures in the active season cannot change division';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists teams_division_guard on public.teams;
create trigger teams_division_guard
  before update of division_id on public.teams
  for each row execute function public.guard_team_division();

-- A fixture is played inside one division, and it keeps that division for ever.
-- The match's own division is what history and the archived table read, so a
-- later team move cannot rewrite an old result.
create or replace function public.guard_match_division()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_home text;
  v_away text;
begin
  -- A full admin restore writes rows exactly as they were exported, including
  -- fixtures whose clubs have since moved. replace_all_data() validates every
  -- division first; normal REST writes still take the checks below.
  if coalesce(current_setting('kickoff.importing', true), '') = 'on' then
    return new;
  end if;

  -- Score/status edits on an existing fixture never re-interpret history.
  if tg_op = 'UPDATE'
     and new.home_id = old.home_id
     and new.away_id = old.away_id
     and new.division_id = old.division_id then
    return new;
  end if;

  select division_id into v_home from public.teams where id = new.home_id;
  select division_id into v_away from public.teams where id = new.away_id;
  if v_home is null or v_away is null then
    raise exception 'Both teams must exist before a fixture can be saved';
  end if;
  if v_home <> v_away then
    raise exception 'Home and away teams must be in the same division';
  end if;
  if tg_op = 'UPDATE' and new.division_id is distinct from old.division_id then
    raise exception 'A match cannot be moved to another division';
  end if;
  if tg_op = 'INSERT' and new.division_id is distinct from v_home then
    raise exception 'The fixture division must be the division of both teams';
  end if;
  new.division_id := v_home;
  return new;
end;
$$;

drop trigger if exists matches_division_guard on public.matches;
create trigger matches_division_guard
  before insert or update of home_id, away_id, division_id on public.matches
  for each row execute function public.guard_match_division();

-- ------------------------------------------------------------
-- 3b. DERIVED VIEWS (roadmap item A, stage 1)
-- ------------------------------------------------------------
-- These recompute player and team totals from rows that exist. Player totals
-- have no stored column: legacy_* holds the part entered by hand and the
-- counted events are added on top. matches.events_counted still marks the
-- fixtures whose events are already inside the legacy offset. security_invoker
-- keeps RLS in force for clients; every view also filters trashed rows and
-- trashed teams explicitly.

create or replace view public.v_player_event_totals
with (security_invoker = true) as
select ev.player_id,
       count(*) filter (where ev.event_type = 'goal')::int as goals,
       count(*) filter (where ev.event_type = 'yellow')::int as yellow,
       count(*) filter (where ev.event_type = 'red')::int as red
from public.match_events ev
join public.matches m
  on m.id = ev.match_id
 and m.events_counted
 and m.deleted_at is null
join public.teams home
  on home.id = m.home_id
 and home.deleted_at is null
join public.teams away
  on away.id = m.away_id
 and away.deleted_at is null
join public.seasons s
  on s.id = m.season_id
 and s.deleted_at is null
group by ev.player_id;

-- All-time totals, because the app treats player goals/cards as career totals
-- (the top-scorer list is not per season).
create or replace view public.v_player_stats
with (security_invoker = true) as
select p.id as player_id,
       p.team_id,
       p.name,
       p.name_ar,
       p.pos,
       p.num,
       p.is_active,
       p.legacy_goals,
       p.legacy_yellow,
       p.legacy_red,
       coalesce(e.goals, 0) as event_goals,
       coalesce(e.yellow, 0) as event_yellow,
       coalesce(e.red, 0) as event_red,
       p.legacy_goals + coalesce(e.goals, 0) as goals,
       p.legacy_yellow + coalesce(e.yellow, 0) as yellow,
       p.legacy_red + coalesce(e.red, 0) as red,
       t.division_id
from public.players p
join public.teams t
  on t.id = p.team_id
 and t.deleted_at is null
left join public.v_player_event_totals e on e.player_id = p.id;

create or replace view public.v_match_results
with (security_invoker = true) as
select m.id as match_id,
       m.season_id,
       m.round,
       m.home_id,
       m.away_id,
       m.home_score,
       m.away_score,
       m.datetime,
       case
         when m.home_score > m.away_score then 3
         when m.home_score = m.away_score then 1
         else 0
       end::int as home_points,
       case
         when m.away_score > m.home_score then 3
         when m.home_score = m.away_score then 1
         else 0
       end::int as away_points,
       case
         when m.home_score > m.away_score then 'W'
         when m.home_score = m.away_score then 'D'
         else 'L'
       end as home_result,
       case
         when m.away_score > m.home_score then 'W'
         when m.home_score = m.away_score then 'D'
         else 'L'
       end as away_result,
       m.division_id
from public.matches m
join public.seasons s
  on s.id = m.season_id
 and s.deleted_at is null
join public.teams home
  on home.id = m.home_id
 and home.deleted_at is null
join public.teams away
  on away.id = m.away_id
 and away.deleted_at is null
where m.status = 'FINISHED'
  and m.deleted_at is null;

-- Mirrors calculateStandings() in js/app.js, one table per division:
--   * the active season lists every visible club currently in that division,
--   * an archived season only lists clubs that played in that division,
--   * tie-breakers are points, goal difference, goals scored, wins, name.
create or replace view public.v_standings
with (security_invoker = true) as
with results as (
  select r.season_id,
         r.division_id,
         r.home_id as team_id,
         r.home_score as goals_for,
         r.away_score as goals_against,
         r.home_points as points,
         r.home_result as result,
         r.datetime,
         r.match_id
  from public.v_match_results r
  union all
  select r.season_id,
         r.division_id,
         r.away_id,
         r.away_score,
         r.home_score,
         r.away_points,
         r.away_result,
         r.datetime,
         r.match_id
  from public.v_match_results r
),
totals as (
  select season_id,
         division_id,
         team_id,
         count(*)::int as played,
         count(*) filter (where result = 'W')::int as won,
         count(*) filter (where result = 'D')::int as drawn,
         count(*) filter (where result = 'L')::int as lost,
         coalesce(sum(goals_for), 0)::int as goals_for,
         coalesce(sum(goals_against), 0)::int as goals_against,
         coalesce(sum(points), 0)::int as points
  from results
  group by season_id, division_id, team_id
),
ordered as (
  select season_id,
         division_id,
         team_id,
         result,
         row_number() over (
           partition by season_id, division_id, team_id
           order by datetime nulls first, match_id
         ) as rn,
         count(*) over (partition by season_id, division_id, team_id) as total
  from results
),
form as (
  select season_id,
         division_id,
         team_id,
         array_agg(result order by rn) as form
  from ordered
  where rn > total - 5
  group by season_id, division_id, team_id
),
scope as (
  select s.id as season_id,
         d.id as division_id,
         t.id as team_id
  from public.seasons s
  cross join public.divisions d
  join public.teams t on t.deleted_at is null
  where s.deleted_at is null
    and (
      -- The live table follows the current registration.
      (s.is_active and t.division_id = d.id)
      -- History follows the division the club actually played in.
      or exists (
        select 1
        from public.matches m
        where m.season_id = s.id
          and m.division_id = d.id
          and m.deleted_at is null
          and t.id in (m.home_id, m.away_id)
      )
    )
)
select sc.season_id,
       sc.team_id,
       t.name as team_name,
       t.code as team_code,
       t.color as team_color,
       coalesce(tt.played, 0) as played,
       coalesce(tt.won, 0) as won,
       coalesce(tt.drawn, 0) as drawn,
       coalesce(tt.lost, 0) as lost,
       coalesce(tt.goals_for, 0) as goals_for,
       coalesce(tt.goals_against, 0) as goals_against,
       coalesce(tt.goals_for, 0) - coalesce(tt.goals_against, 0) as goal_difference,
       coalesce(tt.points, 0) as points,
       coalesce(f.form, '{}'::text[]) as form,
       row_number() over (
         partition by sc.season_id, sc.division_id
         order by coalesce(tt.points, 0) desc,
                  coalesce(tt.goals_for, 0) - coalesce(tt.goals_against, 0) desc,
                  coalesce(tt.goals_for, 0) desc,
                  coalesce(tt.won, 0) desc,
                  t.name asc
       )::int as position,
       sc.division_id
from scope sc
join public.teams t on t.id = sc.team_id
left join totals tt
  on tt.season_id = sc.season_id
 and tt.division_id = sc.division_id
 and tt.team_id = sc.team_id
left join form f
  on f.season_id = sc.season_id
 and f.division_id = sc.division_id
 and f.team_id = sc.team_id;

-- ------------------------------------------------------------
-- 4. GRANTS (RLS still decides what each role may do)
-- ------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.divisions, public.seasons, public.teams, public.players, public.matches, public.match_events to anon, authenticated;
-- Divisions are maintainer-managed: no client role may insert, update or delete them.
revoke insert, update, delete on public.divisions from anon, authenticated;
revoke all on public.v_player_event_totals, public.v_player_stats, public.v_match_results, public.v_standings from public, anon, authenticated;
grant select on public.v_player_event_totals, public.v_player_stats, public.v_match_results, public.v_standings to anon, authenticated;
grant insert, update, delete on public.seasons, public.players to authenticated;
grant insert, update on public.teams, public.matches to authenticated;
-- Team/match deletion and match-event writes are RPC-only so aggregate
-- totals cannot drift. The security-definer RPCs retain owner privileges.
revoke delete on public.teams, public.matches from authenticated;
revoke insert, update, delete on public.match_events from authenticated;
revoke insert, update, delete on public.match_events from anon;
grant select on public.profiles to authenticated;

-- Roadmap B: assignments are readable through RLS (own rows, or every row for
-- admins). Only set_match_officials() writes them.
revoke all on public.match_officials from public, anon, authenticated;
grant select on public.match_officials to anon, authenticated;

-- Task L: a player's licence number and birth date are personal data. No
-- anonymous grant at all, so an anon REST read fails with 401 instead of
-- returning an empty (policy-filtered) list; admins read and write through
-- the policy below.
revoke all on public.player_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.player_profiles to authenticated;

-- Supabase grants every role full privileges on new public tables by default.
-- Anonymous visitors only ever read, so drop every write-type privilege for them on
-- existing tables and on tables created later. RLS stays the second layer.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;

-- ------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.divisions enable row level security;
alter table public.seasons enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.matches enable row level security;
alter table public.match_events enable row level security;
alter table public.match_officials enable row level security;
alter table public.player_profiles enable row level security;

-- Profiles: users see their own role; admins see everyone.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (auth.uid() = id);

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin());

-- Match officials: a scorer sees only their own assignments; admins see all.
-- There is no INSERT/UPDATE/DELETE policy, so writes stay RPC-only.
drop policy if exists match_officials_select_own on public.match_officials;
create policy match_officials_select_own on public.match_officials
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists match_officials_select_admin on public.match_officials;
create policy match_officials_select_admin on public.match_officials
  for select to authenticated
  using (public.is_admin());

-- Player profiles: admin-only for every command. Visitors have no SELECT grant,
-- so they cannot reach the personal columns at all.
drop policy if exists player_profiles_admin_all on public.player_profiles;
create policy player_profiles_admin_all on public.player_profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Divisions: public read, no client writes. The two rows are seeded and only
-- the maintainer adds another tier with SQL.
drop policy if exists divisions_select_all on public.divisions;
create policy divisions_select_all on public.divisions
  for select to anon, authenticated using (true);

-- Seasons: public read, admin write.
-- Trashed rows are invisible to everyone, admins included; admins find
-- them through list_deleted() and bring them back with restore_*().
drop policy if exists seasons_select_all on public.seasons;
create policy seasons_select_all on public.seasons
  for select to anon, authenticated using (deleted_at is null);

drop policy if exists seasons_insert_admin on public.seasons;
create policy seasons_insert_admin on public.seasons
  for insert to authenticated with check (public.is_admin());

drop policy if exists seasons_update_admin on public.seasons;
create policy seasons_update_admin on public.seasons
  for update to authenticated
  using (public.is_admin() and deleted_at is null)
  with check (public.is_admin() and deleted_at is null);

drop policy if exists seasons_delete_admin on public.seasons;
create policy seasons_delete_admin on public.seasons
  for delete to authenticated using (public.is_admin());

-- Teams: public read, admin write.
drop policy if exists teams_select_all on public.teams;
create policy teams_select_all on public.teams
  for select to anon, authenticated using (deleted_at is null);

drop policy if exists teams_insert_admin on public.teams;
create policy teams_insert_admin on public.teams
  for insert to authenticated with check (public.is_admin());

drop policy if exists teams_update_admin on public.teams;
create policy teams_update_admin on public.teams
  for update to authenticated
  using (public.is_admin() and deleted_at is null)
  with check (public.is_admin() and deleted_at is null);

-- Team deletion must go through delete_team() so opponent totals are
-- reversed before the club is moved to the trash. No direct DELETE policy
-- is created.
drop policy if exists teams_delete_admin on public.teams;

-- Players: public read, admin write. Trashed clubs take their squad with
-- them through this policy.
drop policy if exists players_select_all on public.players;
create policy players_select_all on public.players
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.teams t
      where t.id = players.team_id
        and t.deleted_at is null
    )
  );

drop policy if exists players_insert_admin on public.players;
create policy players_insert_admin on public.players
  for insert to authenticated with check (public.is_admin());

drop policy if exists players_update_admin on public.players;
create policy players_update_admin on public.players
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- A player with match history can be archived, but not hard-deleted.
drop policy if exists players_delete_admin on public.players;
create policy players_delete_admin on public.players
  for delete to authenticated
  using (
    public.is_admin()
    and not exists (
      select 1
      from public.match_events e
      where e.player_id = players.id
    )
  );

-- Matches: public read, admin write. Only the active season can be
-- written directly; archived seasons are read-only in the database.
drop policy if exists matches_select_all on public.matches;
create policy matches_select_all on public.matches
  for select to anon, authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from public.teams t
      where t.id = matches.home_id and t.deleted_at is null
    )
    and exists (
      select 1 from public.teams t
      where t.id = matches.away_id and t.deleted_at is null
    )
  );

drop policy if exists matches_insert_admin on public.matches;
create policy matches_insert_admin on public.matches
  for insert to authenticated
  with check (public.is_admin() and public.is_active_season(season_id));

drop policy if exists matches_update_admin on public.matches;
create policy matches_update_admin on public.matches
  for update to authenticated
  using (public.is_admin() and deleted_at is null and public.is_active_season(season_id))
  with check (public.is_admin() and deleted_at is null and public.is_active_season(season_id));

-- Match deletion must go through delete_match() so event contributions are
-- reversed atomically and the fixture moves to the trash. No direct DELETE
-- policy is created.
drop policy if exists matches_delete_admin on public.matches;

-- Match events: public read. A trashed fixture takes its events with it.
-- Writes are RPC-only so the cumulative player totals cannot be changed
-- without the matching event rows.
drop policy if exists match_events_select_all on public.match_events;
create policy match_events_select_all on public.match_events
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.matches m
      where m.id = match_events.match_id
        and m.deleted_at is null
    )
  );

drop policy if exists match_events_insert_admin on public.match_events;
drop policy if exists match_events_update_admin on public.match_events;
drop policy if exists match_events_delete_admin on public.match_events;

-- ------------------------------------------------------------
-- 6. SEASON FUNCTIONS (atomic, admin-only)
-- ------------------------------------------------------------
create or replace function public.create_season(
  p_id text,
  p_name text,
  p_start_date date default null,
  p_end_date date default null
)
returns public.seasons
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create seasons' using errcode = '42501';
  end if;

  if p_id is null or btrim(p_id) = '' then
    raise exception 'Season id is required';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Season name is required';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date < p_start_date then
    raise exception 'End date must be on or after start date';
  end if;
  if exists (select 1 from public.seasons where id = p_id) then
    raise exception 'Season already exists';
  end if;

  update public.seasons set is_active = false where is_active = true;

  insert into public.seasons (id, name, start_date, end_date, is_active)
  values (p_id, btrim(p_name), p_start_date, p_end_date, true)
  returning * into v_season;

  return v_season;
end;
$$;

create or replace function public.activate_season(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can activate seasons' using errcode = '42501';
  end if;

  if not exists (select 1 from public.seasons where id = p_id) then
    raise exception 'Season not found';
  end if;

  update public.seasons set is_active = false where is_active = true;
  update public.seasons set is_active = true where id = p_id;
end;
$$;

revoke execute on function public.create_season(text, text, date, date) from public, anon;
revoke execute on function public.activate_season(text) from public, anon;
grant execute on function public.create_season(text, text, date, date) to authenticated;
grant execute on function public.activate_season(text) to authenticated;

-- ------------------------------------------------------------
-- 6b. MATCH EVENT FUNCTIONS (atomic, admin-only)
-- ------------------------------------------------------------
create or replace function public.replace_match_events(
  p_match_id text,
  p_events jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event jsonb;
  v_id text;
  v_team_id text;
  v_player_id text;
  v_type text;
  v_minute int;
  v_season_id text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change match events' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select season_id
    into v_season_id
  from public.matches
  where id = p_match_id
    and deleted_at is null;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;

  if p_events is null or p_events = 'null'::jsonb then
    p_events := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'Events must be an array';
  end if;

  delete from public.match_events where match_id = p_match_id;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_id := nullif(v_event->>'id', '');
    v_team_id := nullif(v_event->>'teamId', '');
    v_player_id := nullif(v_event->>'playerId', '');
    v_type := nullif(v_event->>'type', '');
    v_minute := nullif(v_event->>'minute', '')::int;

    if v_id is null then
      v_id := 'e_' || replace(gen_random_uuid()::text, '-', '');
    end if;
    if v_team_id is null or v_player_id is null then
      raise exception 'Every event needs a team and a player';
    end if;
    if v_type is null or v_type not in ('goal', 'yellow', 'red') then
      raise exception 'Invalid event type: %', v_type;
    end if;
    if v_minute is null or v_minute < 1 or v_minute > 130 then
      raise exception 'Event minute must be between 1 and 130';
    end if;
    if not exists (
      select 1
      from public.players p
      join public.matches m on m.id = p_match_id
      where p.id = v_player_id
        and p.team_id = v_team_id
        and v_team_id in (m.home_id, m.away_id)
    ) then
      raise exception 'Player % does not belong to this match', v_player_id;
    end if;

    insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
    values (v_id, p_match_id, v_team_id, v_player_id, v_type, v_minute);
  end loop;
end;
$$;

create or replace function public.delete_match(p_match_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id text;
  v_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete matches' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select season_id, deleted_at
    into v_season_id, v_deleted_at
  from public.matches
  where id = p_match_id;

  if not found then
    raise exception 'Match not found';
  end if;
  if v_deleted_at is not null then
    return;  -- already in the trash
  end if;
  if not public.is_active_season(v_season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;

  update public.matches set deleted_at = now() where id = p_match_id;
end;
$$;

revoke execute on function public.replace_match_events(text, jsonb) from public, anon;
revoke execute on function public.delete_match(text) from public, anon;
grant execute on function public.replace_match_events(text, jsonb) to authenticated;
grant execute on function public.delete_match(text) to authenticated;

-- ------------------------------------------------------------
-- 6b-2. LIVE MATCH ENTRY (roadmap B, narrow scorer path)
-- ------------------------------------------------------------
-- A scorer may add a goal or card to a fixture they are assigned to, while
-- that fixture is LIVE or scheduled today in the active season. The first
-- event on a scheduled fixture starts it. Removing an event is an undo:
-- scorers have 15 minutes, admins do not have a time limit. Admins bypass
-- the assignment check but still use the same live/today gate; for older
-- fixtures they keep the full match editor.
create or replace function public.record_live_event(
  p_match_id text,
  p_team_id text,
  p_player_id text,
  p_event_type text,
  p_minute int
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches%rowtype;
  v_event_id text;
  v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then
    raise exception 'Sign in to record live events' using errcode = '42501';
  end if;
  if not v_admin and not public.is_scorer() then
    raise exception 'Only admins and scorers can record live events' using errcode = '42501';
  end if;

  if p_event_type is null or p_event_type not in ('goal', 'yellow', 'red') then
    raise exception 'Invalid event type: %', p_event_type;
  end if;
  if p_minute is null or p_minute < 1 or p_minute > 130 then
    raise exception 'Event minute must be between 1 and 130';
  end if;

  perform pg_advisory_xact_lock(748291);

  select *
    into v_match
  from public.matches
  where id = p_match_id
    and deleted_at is null;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_match.season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;
  if not v_match.events_counted then
    raise exception 'This fixture predates match events; an admin must edit it' using errcode = '42501';
  end if;
  if v_match.status <> 'LIVE'
     and not (
       v_match.status = 'SCHEDULED'
       and v_match.datetime is not null
       and left(v_match.datetime, 10) = to_char(current_date, 'YYYY-MM-DD')
     ) then
    raise exception 'Live entry is open only for a live match or a fixture scheduled today'
      using errcode = '42501';
  end if;

  if not v_admin then
    if not exists (
      select 1
      from public.match_officials o
      where o.match_id = p_match_id
        and o.user_id = auth.uid()
    ) then
      raise exception 'You are not assigned to this match' using errcode = '42501';
    end if;
  end if;

  if not exists (
    select 1
    from public.players p
    where p.id = p_player_id
      and p.team_id = p_team_id
      and p.team_id in (v_match.home_id, v_match.away_id)
  ) then
    raise exception 'Player % does not belong to this match', p_player_id;
  end if;

  v_event_id := 'e_' || replace(gen_random_uuid()::text, '-', '');

  insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
  values (v_event_id, p_match_id, p_team_id, p_player_id, p_event_type, p_minute);

  if p_event_type = 'goal' then
    update public.matches
       set home_score = case when home_id = p_team_id then home_score + 1 else home_score end,
           away_score = case when away_id = p_team_id then away_score + 1 else away_score end
     where id = p_match_id;
  end if;

  update public.matches
     set status = 'LIVE'
   where id = p_match_id
     and status = 'SCHEDULED';

  return v_event_id;
end;
$$;

create or replace function public.remove_live_event(p_event_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.match_events%rowtype;
  v_match public.matches%rowtype;
  v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then
    raise exception 'Sign in to change live events' using errcode = '42501';
  end if;
  if not v_admin and not public.is_scorer() then
    raise exception 'Only admins and scorers can change live events' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select *
    into v_event
  from public.match_events
  where id = p_event_id;

  if not found then
    raise exception 'Event not found';
  end if;

  select *
    into v_match
  from public.matches
  where id = v_event.match_id
    and deleted_at is null;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_match.season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;
  if not v_match.events_counted then
    raise exception 'This fixture predates match events; an admin must edit it' using errcode = '42501';
  end if;
  if v_match.status <> 'LIVE'
     and not (
       v_match.status = 'SCHEDULED'
       and v_match.datetime is not null
       and left(v_match.datetime, 10) = to_char(current_date, 'YYYY-MM-DD')
     ) then
    raise exception 'Live entry is open only for a live match or a fixture scheduled today'
      using errcode = '42501';
  end if;

  if not v_admin then
    if not exists (
      select 1
      from public.match_officials o
      where o.match_id = v_event.match_id
        and o.user_id = auth.uid()
    ) then
      raise exception 'You are not assigned to this match' using errcode = '42501';
    end if;
    if v_event.created_at < now() - interval '15 minutes' then
      raise exception 'The 15-minute undo window has closed' using errcode = '42501';
    end if;
  end if;

  delete from public.match_events where id = p_event_id;

  if v_event.event_type = 'goal' then
    update public.matches
       set home_score = case
             when home_id = v_event.team_id then greatest(0, home_score - 1)
             else home_score
           end,
           away_score = case
             when away_id = v_event.team_id then greatest(0, away_score - 1)
             else away_score
           end
     where id = v_event.match_id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 6b-3. USER ROLES + MATCH OFFICIALS (admin only)
-- ------------------------------------------------------------
-- The app never writes public.profiles or public.match_officials directly.
-- Both RPCs are admin-checked, take the same advisory lock as the other
-- writers, and record an explicit audit entry with the acting admin.
create or replace function public.list_users()
returns table (id uuid, email text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can list users' using errcode = '42501';
  end if;

  return query
    select p.id, p.email, p.role::text, p.created_at
    from public.profiles p
    order by p.email nulls last, p.created_at, p.id;
end;
$$;

create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.app_role;
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'viewer', 'scorer') then
    raise exception 'Unknown role: %', p_role;
  end if;
  if p_user_id = auth.uid() and p_role <> 'admin' then
    raise exception 'You cannot remove your own admin role' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select p.role, p.email
    into v_old, v_email
  from public.profiles p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception 'User not found';
  end if;
  if v_old::text = p_role then
    return;
  end if;

  update public.profiles
     set role = p_role::public.app_role
   where id = p_user_id;

  insert into public.audit_log (
    actor_id, actor_email, action, entity, entity_id, summary, before, after
  )
  values (
    auth.uid(),
    (select u.email from auth.users u where u.id = auth.uid()),
    'SECURITY',
    'profiles',
    p_user_id::text,
    format('Role for %s changed from %s to %s',
           coalesce(v_email, p_user_id::text), v_old::text, p_role),
    jsonb_build_object('role', v_old::text),
    jsonb_build_object('role', p_role)
  );
end;
$$;

create or replace function public.set_match_officials(
  p_match_id text,
  p_user_ids uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id text;
  v_ids uuid[];
  v_added uuid[];
  v_removed uuid[];
  v_id uuid;
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can assign match officials' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select m.season_id
    into v_season_id
  from public.matches m
  where m.id = p_match_id
    and m.deleted_at is null;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;

  select array(
    select distinct x
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as x
    where x is not null
  )
    into v_ids;

  if exists (
    select 1
    from unnest(v_ids) as x
    where not exists (
      select 1
      from public.profiles p
      where p.id = x
        and p.role::text = 'scorer'
    )
  ) then
    raise exception 'Only scorer accounts can be assigned to a match' using errcode = '42501';
  end if;

  select coalesce(array_agg(o.user_id), '{}'::uuid[])
    into v_removed
  from public.match_officials o
  where o.match_id = p_match_id
    and not (o.user_id = any(v_ids));

  select coalesce(array_agg(x), '{}'::uuid[])
    into v_added
  from unnest(v_ids) as x
  where not exists (
    select 1
    from public.match_officials o
    where o.match_id = p_match_id
      and o.user_id = x
  );

  delete from public.match_officials
  where match_id = p_match_id
    and not (user_id = any(v_ids));

  if cardinality(v_ids) > 0 then
    insert into public.match_officials (match_id, user_id, created_by)
    select p_match_id, x, auth.uid()
    from unnest(v_ids) as x
    on conflict do nothing;
  end if;

  foreach v_id in array v_added loop
    select p.email into v_email from public.profiles p where p.id = v_id;
    insert into public.audit_log (
      actor_id, actor_email, action, entity, entity_id, season_id, summary, after
    )
    values (
      auth.uid(),
      (select u.email from auth.users u where u.id = auth.uid()),
      'INSERT',
      'match_officials',
      p_match_id,
      v_season_id,
      format('%s can score match %s',
             coalesce(v_email, v_id::text), p_match_id),
      jsonb_build_object('user_id', v_id, 'email', v_email)
    );
  end loop;

  foreach v_id in array v_removed loop
    select p.email into v_email from public.profiles p where p.id = v_id;
    insert into public.audit_log (
      actor_id, actor_email, action, entity, entity_id, season_id, summary, before
    )
    values (
      auth.uid(),
      (select u.email from auth.users u where u.id = auth.uid()),
      'DELETE',
      'match_officials',
      p_match_id,
      v_season_id,
      format('%s can no longer score match %s',
             coalesce(v_email, v_id::text), p_match_id),
      jsonb_build_object('user_id', v_id, 'email', v_email)
    );
  end loop;
end;
$$;

revoke execute on function public.record_live_event(text, text, text, text, int) from public, anon;
revoke execute on function public.remove_live_event(text) from public, anon;
revoke execute on function public.list_users() from public, anon;
revoke execute on function public.set_user_role(uuid, text) from public, anon;
revoke execute on function public.set_match_officials(text, uuid[]) from public, anon;
grant execute on function public.record_live_event(text, text, text, text, int) to authenticated;
grant execute on function public.remove_live_event(text) to authenticated;
grant execute on function public.list_users() to authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;
grant execute on function public.set_match_officials(text, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- 6c. ATOMIC MATCH + EVENTS SAVE
-- ------------------------------------------------------------
create or replace function public.save_match(
  p_match jsonb,
  p_events jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_season_id text;
  v_division_id text;
  v_round int;
  v_home_id text;
  v_away_id text;
  v_home_division text;
  v_away_division text;
  v_home_score int;
  v_away_score int;
  v_status text;
  v_events_counted boolean;
  v_existing_season_id text;
  v_existing_division_id text;
  v_existing_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can save matches' using errcode = '42501';
  end if;

  if p_match is null or jsonb_typeof(p_match) <> 'object' then
    raise exception 'Match payload must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(748291);

  v_id := nullif(p_match->>'id', '');
  if v_id is null then
    v_id := 'm_' || replace(gen_random_uuid()::text, '-', '');
  end if;

  v_season_id := nullif(p_match->>'season_id', '');
  if v_season_id is null or not public.is_active_season(v_season_id) then
    raise exception 'Matches can only be saved in the active season' using errcode = '42501';
  end if;

  v_round := coalesce((p_match->>'round')::int, 1);
  if v_round < 1 then
    raise exception 'Matchday must be at least 1';
  end if;

  v_home_id := nullif(p_match->>'home_id', '');
  v_away_id := nullif(p_match->>'away_id', '');
  if v_home_id is null or v_away_id is null or v_home_id = v_away_id then
    raise exception 'Home and away teams must be different';
  end if;
  if not exists (
    select 1 from public.teams
    where id = v_home_id and deleted_at is null
  ) or not exists (
    select 1 from public.teams
    where id = v_away_id and deleted_at is null
  ) then
    raise exception 'One or both teams do not exist or are in the trash';
  end if;

  select division_id into v_home_division
  from public.teams where id = v_home_id and deleted_at is null;
  select division_id into v_away_division
  from public.teams where id = v_away_id and deleted_at is null;
  if v_home_division is distinct from v_away_division then
    raise exception 'Home and away teams must be in the same division';
  end if;

  -- The fixture division is derived from its teams; an explicit value is only
  -- accepted when it agrees with both of them.
  v_division_id := nullif(p_match->>'division_id', '');
  if v_division_id is null then
    v_division_id := v_home_division;
  end if;
  if not exists (
    select 1 from public.divisions where id = v_division_id
  ) then
    raise exception 'Unknown division: %', v_division_id;
  end if;
  if v_division_id <> v_home_division then
    raise exception 'The fixture division must be the division of both teams';
  end if;

  v_status := coalesce(nullif(p_match->>'status', ''), 'SCHEDULED');
  if v_status not in ('SCHEDULED', 'LIVE', 'FINISHED') then
    raise exception 'Invalid match status: %', v_status;
  end if;

  v_home_score := coalesce((p_match->>'home_score')::int, 0);
  v_away_score := coalesce((p_match->>'away_score')::int, 0);
  if v_home_score < 0 or v_away_score < 0 then
    raise exception 'Scores cannot be negative';
  end if;

  v_events_counted := coalesce((p_match->>'events_counted')::boolean, true);

  select season_id, division_id, deleted_at
    into v_existing_season_id, v_existing_division_id, v_existing_deleted_at
  from public.matches
  where id = v_id;

  if found and v_existing_deleted_at is not null then
    raise exception 'This match is in the recently deleted list; restore it first';
  end if;
  if found and v_existing_season_id <> v_season_id then
    raise exception 'A match cannot be moved to another season';
  end if;
  if found and v_existing_division_id <> v_division_id then
    raise exception 'A match cannot be moved to another division';
  end if;
  if found and not public.is_active_season(v_existing_season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.matches m
    where m.id <> v_id
      and m.season_id = v_season_id
      and m.round = v_round
      and m.deleted_at is null
      and (
        (m.home_id = v_home_id and m.away_id = v_away_id)
        or (m.home_id = v_away_id and m.away_id = v_home_id)
      )
  ) then
    raise exception 'This fixture already exists in this round';
  end if;

  insert into public.matches (
    id,
    season_id,
    division_id,
    round,
    home_id,
    away_id,
    home_score,
    away_score,
    status,
    datetime,
    venue,
    scorers_text,
    events_counted
  )
  values (
    v_id,
    v_season_id,
    v_division_id,
    v_round,
    v_home_id,
    v_away_id,
    v_home_score,
    v_away_score,
    v_status,
    nullif(p_match->>'datetime', ''),
    nullif(p_match->>'venue', ''),
    nullif(p_match->>'scorers_text', ''),
    v_events_counted
  )
  on conflict (id) do update
    set season_id = excluded.season_id,
        division_id = excluded.division_id,
        round = excluded.round,
        home_id = excluded.home_id,
        away_id = excluded.away_id,
        home_score = excluded.home_score,
        away_score = excluded.away_score,
        status = excluded.status,
        datetime = excluded.datetime,
        venue = excluded.venue,
        scorers_text = excluded.scorers_text,
        events_counted = excluded.events_counted;

  -- A null p_events means "leave the existing event list untouched"
  -- (used by the quick LIVE +1 score buttons).
  if p_events is not null and p_events <> 'null'::jsonb then
    perform public.replace_match_events(v_id, p_events);
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 6c2. MOVE A TEAM BETWEEN DIVISIONS (roadmap K)
-- ------------------------------------------------------------
-- The club keeps its identity, players and all played fixtures; only the
-- current registration changes. The guard (3a) refuses a move while the club
-- has a fixture in the active season, because the live table would no longer
-- match the fixtures it shows.
create or replace function public.set_team_division(p_team_id text, p_division_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can move teams between divisions' using errcode = '42501';
  end if;
  if p_team_id is null or p_division_id is null then
    raise exception 'Team and division are required';
  end if;
  if not exists (select 1 from public.divisions where id = p_division_id) then
    raise exception 'Unknown division: %', p_division_id;
  end if;

  perform pg_advisory_xact_lock(748291);

  if not exists (
    select 1 from public.teams where id = p_team_id and deleted_at is null
  ) then
    raise exception 'Team not found or in the trash';
  end if;

  if exists (
    select 1
    from public.matches m
    join public.seasons s on s.id = m.season_id
    where m.deleted_at is null
      and s.is_active
      and p_team_id in (m.home_id, m.away_id)
  ) then
    raise exception 'A team with fixtures in the active season cannot change division';
  end if;

  update public.teams
  set division_id = p_division_id
  where id = p_team_id
    and division_id is distinct from p_division_id;
end;
$$;

revoke execute on function public.set_team_division(text, text) from public, anon;
grant execute on function public.set_team_division(text, text) to authenticated;

-- ------------------------------------------------------------
-- 6d. SAFE TEAM DELETION + PLAYER ARCHIVE/RESTORE
-- ------------------------------------------------------------
create or replace function public.delete_team(p_team_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete teams' using errcode = '42501';
  end if;

  select deleted_at into v_deleted_at from public.teams where id = p_team_id;
  if not found then
    raise exception 'Team not found';
  end if;
  if v_deleted_at is not null then
    return;  -- already in the trash
  end if;

  perform pg_advisory_xact_lock(748291);

  -- Events and players stay in place: the RLS policies above hide them
  -- while the club is in the trash, and a restore brings them back. The
  -- derived views filter on teams.deleted_at, so the totals follow.
  update public.teams set deleted_at = now() where id = p_team_id;
end;
$$;

-- ------------------------------------------------------------
-- 6d-2. SOFT DELETE + RESTORE (admin only)
--    Trashed rows stay in the database with deleted_at set, so a
--    restore is exact. RLS hides them from every client.
-- ------------------------------------------------------------
create or replace function public.delete_season(p_season_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active boolean;
  v_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete seasons' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select is_active, deleted_at into v_active, v_deleted_at
  from public.seasons
  where id = p_season_id;

  if not found then
    raise exception 'Season not found';
  end if;
  if v_deleted_at is not null then
    return;
  end if;
  if v_active then
    raise exception 'The active season cannot be deleted' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.matches
    where season_id = p_season_id
      and deleted_at is null
  ) then
    raise exception 'Season still has fixtures';
  end if;

  update public.seasons set deleted_at = now() where id = p_season_id;
end;
$$;

create or replace function public.restore_match(p_match_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id text;
  v_home_id text;
  v_away_id text;
  v_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore matches' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select season_id, home_id, away_id, deleted_at
    into v_season_id, v_home_id, v_away_id, v_deleted_at
  from public.matches
  where id = p_match_id;

  if not found then
    raise exception 'Match not found';
  end if;
  if v_deleted_at is null then
    return;
  end if;

  if exists (select 1 from public.seasons where id = v_season_id and deleted_at is not null) then
    raise exception 'Restore the season before this match';
  end if;
  if exists (
    select 1 from public.teams
    where id in (v_home_id, v_away_id) and deleted_at is not null
  ) then
    raise exception 'Restore the teams before this match';
  end if;

  -- The events were never touched, so the views bring the totals back.
  update public.matches set deleted_at = null where id = p_match_id;
end;
$$;

create or replace function public.restore_team(p_team_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore teams' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select deleted_at into v_deleted_at from public.teams where id = p_team_id;
  if not found then
    raise exception 'Team not found';
  end if;
  if v_deleted_at is null then
    return;
  end if;

  -- Players and events were left in place; the views see them again.
  update public.teams set deleted_at = null where id = p_team_id;
end;
$$;

create or replace function public.restore_season(p_season_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore seasons' using errcode = '42501';
  end if;

  if not exists (select 1 from public.seasons where id = p_season_id) then
    raise exception 'Season not found';
  end if;

  update public.seasons set deleted_at = null where id = p_season_id;
end;
$$;

create or replace function public.list_deleted()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the deleted items' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'nameAr', t.name_ar,
        'icon', t.icon,
        'code', t.code,
        'deletedAt', t.deleted_at,
        'playerCount', (select count(*) from public.players p where p.team_id = t.id),
        'matchCount', (
          select count(*) from public.matches m
          where (m.home_id = t.id or m.away_id = t.id)
            and m.deleted_at is null
        )
      ) order by t.deleted_at desc)
      from public.teams t
      where t.deleted_at is not null
    ), '[]'::jsonb),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'homeName', h.name,
        'homeNameAr', h.name_ar,
        'awayName', a.name,
        'awayNameAr', a.name_ar,
        'homeScore', m.home_score,
        'awayScore', m.away_score,
        'round', m.round,
        'seasonId', m.season_id,
        'deletedAt', m.deleted_at
      ) order by m.deleted_at desc)
      from public.matches m
      left join public.teams h on h.id = m.home_id
      left join public.teams a on a.id = m.away_id
      where m.deleted_at is not null
    ), '[]'::jsonb),
    'seasons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'deletedAt', s.deleted_at
      ) order by s.deleted_at desc)
      from public.seasons s
      where s.deleted_at is not null
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.archive_player(p_player_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can archive players' using errcode = '42501';
  end if;
  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'Player not found';
  end if;
  update public.players set is_active = false where id = p_player_id;
end;
$$;

create or replace function public.restore_player(p_player_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore players' using errcode = '42501';
  end if;
  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'Player not found';
  end if;
  update public.players set is_active = true where id = p_player_id;
end;
$$;

revoke execute on function public.save_match(jsonb, jsonb) from public, anon;
revoke execute on function public.delete_team(text) from public, anon;
revoke execute on function public.archive_player(text) from public, anon;
revoke execute on function public.restore_player(text) from public, anon;
grant execute on function public.save_match(jsonb, jsonb) to authenticated;
grant execute on function public.delete_team(text) to authenticated;
grant execute on function public.archive_player(text) to authenticated;
grant execute on function public.restore_player(text) to authenticated;
revoke execute on function public.delete_season(text) from public, anon;
revoke execute on function public.restore_match(text) from public, anon;
revoke execute on function public.restore_team(text) from public, anon;
revoke execute on function public.restore_season(text) from public, anon;
revoke execute on function public.list_deleted() from public, anon;
grant execute on function public.delete_season(text) to authenticated;
grant execute on function public.restore_match(text) to authenticated;
grant execute on function public.restore_team(text) to authenticated;
grant execute on function public.restore_season(text) to authenticated;
grant execute on function public.list_deleted() to authenticated;

-- ------------------------------------------------------------
-- 6d-3. BULK ADD PLAYERS (admin only, atomic)
--    Used by the "Import squad from Excel" dialog: either every
--    row is added or none is.
-- ------------------------------------------------------------
create or replace function public.add_players(p_team_id text, p_players jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_name text;
  v_item jsonb;
  v_idx int := 0;
  v_name text;
  v_name_ar text;
  v_player_id text;
  v_license text;
  v_birth date;
  v_pos text;
  v_num int;
  v_goals int;
  v_yellow int;
  v_red int;
  v_count int := 0;
  v_seen text[] := '{}';
  v_seen_license text[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'Only admins can add players' using errcode = '42501';
  end if;

  select name into v_team_name
  from public.teams
  where id = p_team_id
    and deleted_at is null;
  if not found then
    raise exception 'Team not found';
  end if;

  if p_players is null or jsonb_typeof(p_players) <> 'array' then
    raise exception 'Players must be a JSON array';
  end if;
  if jsonb_array_length(p_players) = 0 then
    raise exception 'There are no players to add';
  end if;
  if jsonb_array_length(p_players) > 100 then
    raise exception 'At most 100 players can be added at once';
  end if;

  perform pg_advisory_xact_lock(748291);

  -- One summary entry in the activity log instead of one row per player.
  perform set_config('app.audit_skip', '1', true);

  for v_item in select value from jsonb_array_elements(p_players)
  loop
    v_idx := v_idx + 1;

    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Row %: expected an object', v_idx;
    end if;

    v_name := regexp_replace(btrim(coalesce(v_item->>'name', '')), '\s+', ' ', 'g');
    if length(v_name) < 1 or length(v_name) > 100 then
      raise exception 'Row %: the name must be 1 to 100 characters', v_idx;
    end if;
    if lower(v_name) = any (v_seen) then
      raise exception 'Row %: "%" appears more than once', v_idx, v_name;
    end if;
    if exists (
      select 1 from public.players
      where team_id = p_team_id
        and is_active
        and lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(v_name)
    ) then
      raise exception 'Row %: "%" is already in this squad', v_idx, v_name;
    end if;
    v_seen := v_seen || lower(v_name);

    v_name_ar := nullif(regexp_replace(btrim(coalesce(v_item->>'name_ar', '')), '\s+', ' ', 'g'), '');
    if v_name_ar is not null and length(v_name_ar) > 100 then
      raise exception 'Row %: the Arabic name must be 1 to 100 characters', v_idx;
    end if;

    v_license := nullif(btrim(coalesce(v_item->>'license_id', '')), '');
    if v_license is not null then
      if length(v_license) > 50 then
        raise exception 'Row %: the licence number must be at most 50 characters', v_idx;
      end if;
      if lower(v_license) = any (v_seen_license) then
        raise exception 'Row %: licence "%" appears more than once', v_idx, v_license;
      end if;
      if exists (
        select 1 from public.player_profiles
        where upper(btrim(license_id)) = upper(v_license)
      ) then
        raise exception 'Row %: licence "%" belongs to another player', v_idx, v_license;
      end if;
      v_seen_license := v_seen_license || lower(v_license);
    end if;

    if coalesce(btrim(v_item->>'birth_date'), '') <> '' then
      if btrim(v_item->>'birth_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'Row %: the birth date must use YYYY-MM-DD', v_idx;
      end if;
      v_birth := btrim(v_item->>'birth_date')::date;
      if v_birth < date '1900-01-01' or v_birth > current_date then
        raise exception 'Row %: the birth date must be between 1900-01-01 and today', v_idx;
      end if;
    else
      v_birth := null;
    end if;

    v_pos := upper(coalesce(nullif(btrim(v_item->>'pos'), ''), 'MID'));
    if v_pos not in ('GK', 'DEF', 'MID', 'FWD') then
      raise exception 'Row %: the position must be GK, DEF, MID or FWD', v_idx;
    end if;

    if coalesce(nullif(btrim(v_item->>'num'), ''), '10') !~ '^[0-9]{1,2}$' then
      raise exception 'Row %: the shirt number must be a whole number from 1 to 99', v_idx;
    end if;
    v_num := coalesce(nullif(btrim(v_item->>'num'), ''), '10')::int;
    if v_num < 1 then
      raise exception 'Row %: the shirt number must be a whole number from 1 to 99', v_idx;
    end if;

    if coalesce(nullif(btrim(v_item->>'goals'), ''), '0') !~ '^[0-9]{1,4}$'
       or coalesce(nullif(btrim(v_item->>'yellow'), ''), '0') !~ '^[0-9]{1,4}$'
       or coalesce(nullif(btrim(v_item->>'red'), ''), '0') !~ '^[0-9]{1,4}$' then
      raise exception 'Row %: goals and cards must be whole numbers, 0 or more', v_idx;
    end if;
    v_goals := coalesce(nullif(btrim(v_item->>'goals'), ''), '0')::int;
    v_yellow := coalesce(nullif(btrim(v_item->>'yellow'), ''), '0')::int;
    v_red := coalesce(nullif(btrim(v_item->>'red'), ''), '0')::int;

    v_player_id := 'p_' || replace(gen_random_uuid()::text, '-', '');

    insert into public.players (
      id, team_id, name, name_ar, pos, num,
      legacy_goals, legacy_yellow, legacy_red,
      is_active
    )
    values (
      v_player_id, p_team_id, v_name, v_name_ar, v_pos, v_num,
      v_goals, v_yellow, v_red,
      true
    );

    -- Licence and birth date are personal data: they stay out of the publicly
    -- readable players table and only get a row when the admin entered one.
    if v_license is not null or v_birth is not null then
      insert into public.player_profiles (player_id, license_id, birth_date)
      values (v_player_id, v_license, v_birth);
    end if;

    v_count := v_count + 1;
  end loop;

  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log (
      actor_id, actor_email, action, entity, entity_id, summary
    )
    values (
      auth.uid(),
      (select u.email from auth.users u where u.id = auth.uid()),
      'IMPORT',
      'players',
      p_team_id,
      format('Imported %s players into %s', v_count, v_team_name)
    );
  end if;

  perform set_config('app.audit_skip', '', true);
  return v_count;
end;
$$;

revoke execute on function public.add_players(text, jsonb) from public, anon;
grant execute on function public.add_players(text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6d-4. MANUAL PLAYER TOTALS (admin only)
--    Moves the legacy offset so the derived view keeps showing the
--    requested number. Totals cannot go below the recorded events.
-- ------------------------------------------------------------
create or replace function public.set_player_totals(
  p_player_id text,
  p_goals int,
  p_yellow int,
  p_red int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_goals int;
  v_event_yellow int;
  v_event_red int;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change player totals' using errcode = '42501';
  end if;

  if p_player_id is null
     or p_goals is null
     or p_yellow is null
     or p_red is null
     or least(p_goals, p_yellow, p_red) < 0 then
    raise exception 'Player totals must be whole numbers, 0 or more';
  end if;

  if not exists (
    select 1
    from public.players p
    join public.teams t on t.id = p.team_id
    where p.id = p_player_id
      and t.deleted_at is null
  ) then
    raise exception 'Player not found';
  end if;

  select count(*) filter (where ev.event_type = 'goal')::int,
         count(*) filter (where ev.event_type = 'yellow')::int,
         count(*) filter (where ev.event_type = 'red')::int
    into v_event_goals, v_event_yellow, v_event_red
  from public.match_events ev
  join public.matches m
    on m.id = ev.match_id
   and m.events_counted
   and m.deleted_at is null
  join public.teams home
    on home.id = m.home_id
   and home.deleted_at is null
  join public.teams away
    on away.id = m.away_id
   and away.deleted_at is null
  join public.seasons s
    on s.id = m.season_id
   and s.deleted_at is null
  where ev.player_id = p_player_id;

  if p_goals < v_event_goals then
    raise exception 'The player already has % goal events; the total cannot be lower', v_event_goals;
  end if;
  if p_yellow < v_event_yellow then
    raise exception 'The player already has % yellow-card events; the total cannot be lower', v_event_yellow;
  end if;
  if p_red < v_event_red then
    raise exception 'The player already has % red-card events; the total cannot be lower', v_event_red;
  end if;

  update public.players
     set legacy_goals = p_goals - v_event_goals,
         legacy_yellow = p_yellow - v_event_yellow,
         legacy_red = p_red - v_event_red
   where id = p_player_id;
end;
$$;

revoke execute on function public.set_player_totals(text, int, int, int) from public, anon;
grant execute on function public.set_player_totals(text, int, int, int) to authenticated;

-- ------------------------------------------------------------
-- 6e. ATOMIC FULL-DATA IMPORT (admin only)
-- ------------------------------------------------------------
create or replace function public.replace_all_data(p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seasons jsonb;
  v_teams jsonb;
  v_players jsonb;
  v_matches jsonb;
  v_match_events jsonb;
  v_season_count int;
  v_active_season_count int;
begin
  if not public.is_admin() then
    raise exception 'Only admins can replace league data' using errcode = '42501';
  end if;

  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Import payload must be a JSON object';
  end if;

  v_seasons := coalesce(p_data->'seasons', '[]'::jsonb);
  v_teams := coalesce(p_data->'teams', '[]'::jsonb);
  v_players := coalesce(p_data->'players', '[]'::jsonb);
  v_matches := coalesce(p_data->'matches', '[]'::jsonb);
  v_match_events := coalesce(p_data->'match_events', '[]'::jsonb);

  if jsonb_typeof(v_seasons) <> 'array'
     or jsonb_typeof(v_teams) <> 'array'
     or jsonb_typeof(v_players) <> 'array'
     or jsonb_typeof(v_matches) <> 'array'
     or jsonb_typeof(v_match_events) <> 'array' then
    raise exception 'Import collections must be JSON arrays';
  end if;

  select count(*),
         count(*) filter (where coalesce((s->>'is_active')::boolean, false))
    into v_season_count, v_active_season_count
  from jsonb_array_elements(v_seasons) as s;

  if v_season_count = 0 then
    raise exception 'Import needs at least one season';
  end if;
  if v_active_season_count <> 1 then
    raise exception 'Import needs exactly one active season';
  end if;

  -- Divisions are seeded, never replaced. Every imported row must point at one
  -- of the existing tiers. A fixture keeps the division it was played in, so it
  -- may differ from its clubs' current division after a between-season move.
  if exists (
    select 1
    from jsonb_to_recordset(v_teams) as t(id text, division_id text)
    where coalesce(t.division_id, 'd1') not in (select id from public.divisions)
  ) then
    raise exception 'Every imported team needs a known division';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as mt(id text, home_id text, away_id text, division_id text)
    left join jsonb_to_recordset(v_teams) as home(id text, division_id text) on home.id = mt.home_id
    where coalesce(mt.division_id, home.division_id, 'd1') not in (select id from public.divisions)
  ) then
    raise exception 'Every imported fixture needs a known division';
  end if;

  -- Licence numbers are optional but unique, and a birth date must be a real
  -- ISO date, so both are checked before anything is deleted.
  if exists (
    select 1
    from (
      select upper(btrim(pl.license_id)) as licence
      from jsonb_to_recordset(v_players) as pl(license_id text)
      where nullif(btrim(coalesce(pl.license_id, '')), '') is not null
    ) licences
    group by licences.licence
    having count(*) > 1
  ) then
    raise exception 'Every imported licence number must be unique';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_players) as pl(birth_date text)
    where nullif(btrim(coalesce(pl.birth_date, '')), '') is not null
      and btrim(pl.birth_date) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ) then
    raise exception 'Every imported birth date must use YYYY-MM-DD';
  end if;

  -- Serialize full imports so two admin tabs cannot delete and reinsert
  -- overlapping data at the same time.
  perform pg_advisory_xact_lock(748291);

  -- Transaction-local: the audit row triggers stay quiet during the
  -- replace, and one IMPORT summary is written at the end instead.
  perform set_config('app.audit_skip', '1', true);

  -- The matches insert restores historical divisions verbatim; the guard is
  -- re-armed immediately afterwards for ordinary writes.
  perform set_config('kickoff.importing', 'on', true);

  -- Supabase enables pg-safeupdate, which rejects DELETE without a WHERE
  -- clause. The primary key is NOT NULL, so this still removes every row.
  delete from public.match_events where id is not null;
  delete from public.matches where id is not null;
  delete from public.player_profiles where player_id is not null;
  delete from public.players where id is not null;
  delete from public.teams where id is not null;
  delete from public.seasons where id is not null;

  insert into public.seasons (id, name, start_date, end_date, is_active)
  select s.id,
         s.name,
         s.start_date,
         s.end_date,
         coalesce(s.is_active, false)
  from jsonb_to_recordset(v_seasons) as s(
    id text,
    name text,
    start_date date,
    end_date date,
    is_active boolean
  );

  insert into public.teams (id, name, name_ar, icon, code, color, division_id)
  select t.id,
         t.name,
         nullif(btrim(coalesce(t.name_ar, '')), ''),
         nullif(btrim(coalesce(t.icon, '')), ''),
         coalesce(t.code, 'TBD'),
         coalesce(t.color, '#16a34a'),
         coalesce(t.division_id, 'd1')
  from jsonb_to_recordset(v_teams) as t(
    id text,
    name text,
    name_ar text,
    icon text,
    code text,
    color text,
    division_id text
  );

  insert into public.players (id, team_id, name, name_ar, pos, num, legacy_goals, legacy_yellow, legacy_red, is_active)
  select pl.id,
         pl.team_id,
         pl.name,
         nullif(btrim(coalesce(pl.name_ar, '')), ''),
         coalesce(pl.pos, 'MID'),
         coalesce(pl.num, 10),
         coalesce(pl.goals, 0),
         coalesce(pl.yellow, 0),
         coalesce(pl.red, 0),
         coalesce(pl.is_active, true)
  from jsonb_to_recordset(v_players) as pl(
    id text,
    team_id text,
    name text,
    name_ar text,
    pos text,
    num int,
    goals int,
    yellow int,
    red int,
    is_active boolean
  );

  -- Licence and birth date are restored into their admin-only table, not onto
  -- the public players row. A player without either keeps no profile row.
  insert into public.player_profiles (player_id, license_id, birth_date)
  select pl.id,
         nullif(btrim(coalesce(pl.license_id, '')), ''),
         nullif(btrim(coalesce(pl.birth_date, '')), '')::date
  from jsonb_to_recordset(v_players) as pl(
    id text,
    license_id text,
    birth_date text
  )
  where nullif(btrim(coalesce(pl.license_id, '')), '') is not null
     or nullif(btrim(coalesce(pl.birth_date, '')), '') is not null;

  insert into public.matches (
    id,
    season_id,
    division_id,
    round,
    home_id,
    away_id,
    home_score,
    away_score,
    status,
    datetime,
    venue,
    scorers_text,
    events_counted
  )
  select mt.id,
         mt.season_id,
         coalesce(
           mt.division_id,
           (select home.division_id from public.teams home where home.id = mt.home_id),
           'd1'
         ),
         coalesce(mt.round, 1),
         mt.home_id,
         mt.away_id,
         coalesce(mt.home_score, 0),
         coalesce(mt.away_score, 0),
         coalesce(mt.status, 'SCHEDULED'),
         mt.datetime,
         mt.venue,
         mt.scorers_text,
         coalesce(mt.events_counted, true)
  from jsonb_to_recordset(v_matches) as mt(
    id text,
    season_id text,
    division_id text,
    round int,
    home_id text,
    away_id text,
    home_score int,
    away_score int,
    status text,
    datetime text,
    venue text,
    scorers_text text,
    events_counted boolean
  );

  -- Fixtures are in place; ordinary writes are guarded again.
  perform set_config('kickoff.importing', 'off', true);

  if exists (
    select 1
    from jsonb_to_recordset(v_match_events) as e(
      id text,
      match_id text,
      team_id text,
      player_id text,
      event_type text,
      minute int
    )
    where not exists (
      select 1
      from public.players p
      join public.matches m on m.id = e.match_id
      where p.id = e.player_id
        and p.team_id = e.team_id
        and e.team_id in (m.home_id, m.away_id)
    )
  ) then
    raise exception 'Every imported event must belong to its fixture team and player';
  end if;

  insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
  select e.id,
         e.match_id,
         e.team_id,
         e.player_id,
         e.event_type,
         e.minute
  from jsonb_to_recordset(v_match_events) as e(
    id text,
    match_id text,
    team_id text,
    player_id text,
    event_type text,
    minute int
  );

  -- The imported totals are authoritative: they start as the legacy offset and
  -- the counted events are taken back out, so the derived views match the
  -- import exactly (including older backups with events_counted = false).
  with counted as (
    select ev.player_id,
           count(*) filter (where ev.event_type = 'goal')::int as goals,
           count(*) filter (where ev.event_type = 'yellow')::int as yellow,
           count(*) filter (where ev.event_type = 'red')::int as red
    from public.match_events ev
    join public.matches m
      on m.id = ev.match_id
     and m.events_counted
     and m.deleted_at is null
    join public.teams home
      on home.id = m.home_id
     and home.deleted_at is null
    join public.teams away
      on away.id = m.away_id
     and away.deleted_at is null
    join public.seasons s
      on s.id = m.season_id
     and s.deleted_at is null
    group by ev.player_id
  )
  update public.players p
     set legacy_goals = greatest(0, p.legacy_goals - coalesce(c.goals, 0)),
         legacy_yellow = greatest(0, p.legacy_yellow - coalesce(c.yellow, 0)),
         legacy_red = greatest(0, p.legacy_red - coalesce(c.red, 0))
  from public.players p2
  left join counted c on c.player_id = p2.id
  where p2.id = p.id;

  -- One readable entry instead of one row per imported record.
  insert into public.audit_log (
    actor_id, actor_email, action, entity, entity_id, summary
  )
  values (
    auth.uid(),
    (select u.email from auth.users u where u.id = auth.uid()),
    'IMPORT',
    'all',
    null,
    format(
      'Imported %s seasons, %s teams, %s players, %s matches, %s events',
      jsonb_array_length(v_seasons),
      jsonb_array_length(v_teams),
      jsonb_array_length(v_players),
      jsonb_array_length(v_matches),
      jsonb_array_length(v_match_events)
    )
  );
end;
$$;

revoke execute on function public.replace_all_data(jsonb) from public, anon;
grant execute on function public.replace_all_data(jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6f. MERGE IMPORT (roadmap H)
-- ------------------------------------------------------------
-- Same definitions as supabase/merge-import-migration.sql.

-- ------------------------------------------------------------
-- 1. IMPORT RUNS (admin-only audit of applied merges)
-- ------------------------------------------------------------
create table if not exists public.import_runs (
  id bigint generated always as identity primary key,
  idempotency_key text not null,
  checksum text not null,
  mode text not null default 'merge',
  actor_id uuid,
  actor_email text,
  payload_counts jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  remove_missing boolean not null default false,
  applied_at timestamptz not null default now(),
  constraint kickoff_import_runs_key_length check (length(btrim(idempotency_key)) between 8 and 200),
  constraint kickoff_import_runs_checksum_format check (checksum ~ '^[0-9a-f]{64}$'),
  constraint kickoff_import_runs_mode check (mode in ('merge'))
);

create unique index if not exists import_runs_idempotency_key_idx
  on public.import_runs (idempotency_key);

create index if not exists import_runs_applied_at_idx
  on public.import_runs (applied_at desc, id desc);

alter table public.import_runs enable row level security;

-- No client grant and no RLS policy: only the security-definer functions below
-- read or write this table. The admin can still see the summary in audit_log.
revoke all on public.import_runs from public, anon, authenticated;
revoke all on sequence public.import_runs_id_seq from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. TEAM DIVISION GUARD: allow a validated import to move a club
-- ------------------------------------------------------------
-- replace_all_data() already sets kickoff.importing; import_merge() uses the
-- same switch so a backup can restore a club that moved between seasons even
-- when it has fixtures in the active season.
create or replace function public.guard_team_division()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('kickoff.importing', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.division_id is distinct from old.division_id then
    if exists (
      select 1
      from public.matches m
      join public.seasons s on s.id = m.season_id
      where m.deleted_at is null
        and s.is_active
        and new.id in (m.home_id, m.away_id)
    ) then
      raise exception 'A team with fixtures in the active season cannot change division';
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 3. CHECKSUM
-- ------------------------------------------------------------
create or replace function public.import_checksum(
  p_data jsonb,
  p_remove_missing boolean default false
)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(
    sha256(convert_to(
      jsonb_build_object(
        'version', 1,
        'mode', 'merge',
        'removeMissing', coalesce(p_remove_missing, false),
        'payload', p_data
      )::text,
      'utf8'
    )),
    'hex'
  );
$$;

revoke execute on function public.import_checksum(jsonb, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. PAYLOAD VALIDATION
-- ------------------------------------------------------------
-- Same rules as replace_all_data() plus the cross-references a merge needs:
-- an imported row may point at a row that already exists live.
create or replace function public.validate_import_payload(p_data jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_seasons jsonb;
  v_teams jsonb;
  v_players jsonb;
  v_matches jsonb;
  v_match_events jsonb;
  v_season_count int;
  v_active_season_count int;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Import payload must be a JSON object';
  end if;

  v_seasons := coalesce(p_data->'seasons', '[]'::jsonb);
  v_teams := coalesce(p_data->'teams', '[]'::jsonb);
  v_players := coalesce(p_data->'players', '[]'::jsonb);
  v_matches := coalesce(p_data->'matches', '[]'::jsonb);
  v_match_events := coalesce(p_data->'match_events', '[]'::jsonb);

  if jsonb_typeof(v_seasons) <> 'array'
     or jsonb_typeof(v_teams) <> 'array'
     or jsonb_typeof(v_players) <> 'array'
     or jsonb_typeof(v_matches) <> 'array'
     or jsonb_typeof(v_match_events) <> 'array' then
    raise exception 'Import collections must be JSON arrays';
  end if;

  -- Required ids, unique within each collection.
  if exists (
    select 1 from jsonb_array_elements(v_seasons) as s
    where nullif(btrim(coalesce(s->>'id', '')), '') is null
       or nullif(btrim(coalesce(s->>'name', '')), '') is null
  ) then
    raise exception 'Every imported season needs an id and a name';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_teams) as t
    where nullif(btrim(coalesce(t->>'id', '')), '') is null
       or nullif(btrim(coalesce(t->>'name', '')), '') is null
  ) then
    raise exception 'Every imported team needs an id and a name';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_players) as p
    where nullif(btrim(coalesce(p->>'id', '')), '') is null
       or nullif(btrim(coalesce(p->>'name', '')), '') is null
       or nullif(btrim(coalesce(p->>'team_id', '')), '') is null
  ) then
    raise exception 'Every imported player needs an id, a name and a team';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_matches) as m
    where nullif(btrim(coalesce(m->>'id', '')), '') is null
       or nullif(btrim(coalesce(m->>'home_id', '')), '') is null
       or nullif(btrim(coalesce(m->>'away_id', '')), '') is null
  ) then
    raise exception 'Every imported fixture needs an id and two teams';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_match_events) as e
    where nullif(btrim(coalesce(e->>'id', '')), '') is null
       or nullif(btrim(coalesce(e->>'match_id', '')), '') is null
       or nullif(btrim(coalesce(e->>'team_id', '')), '') is null
       or nullif(btrim(coalesce(e->>'player_id', '')), '') is null
  ) then
    raise exception 'Every imported event needs an id, a fixture, a team and a player';
  end if;

  if exists (
    select id from (
      select btrim(s->>'id') as id from jsonb_array_elements(v_seasons) as s
    ) rows group by id having count(*) > 1
  ) then
    raise exception 'Every imported season id must be unique';
  end if;
  if exists (
    select id from (
      select btrim(t->>'id') as id from jsonb_array_elements(v_teams) as t
    ) rows group by id having count(*) > 1
  ) then
    raise exception 'Every imported team id must be unique';
  end if;
  if exists (
    select id from (
      select btrim(p->>'id') as id from jsonb_array_elements(v_players) as p
    ) rows group by id having count(*) > 1
  ) then
    raise exception 'Every imported player id must be unique';
  end if;
  if exists (
    select id from (
      select btrim(m->>'id') as id from jsonb_array_elements(v_matches) as m
    ) rows group by id having count(*) > 1
  ) then
    raise exception 'Every imported fixture id must be unique';
  end if;
  if exists (
    select id from (
      select btrim(e->>'id') as id from jsonb_array_elements(v_match_events) as e
    ) rows group by id having count(*) > 1
  ) then
    raise exception 'Every imported event id must be unique';
  end if;

  -- If seasons are imported, exactly one of them is active. import_merge()
  -- deactivates the live season first, so this stays true after the merge.
  select count(*),
         count(*) filter (where coalesce((s->>'is_active')::boolean, false))
    into v_season_count, v_active_season_count
  from jsonb_array_elements(v_seasons) as s;

  if v_season_count > 0 and v_active_season_count <> 1 then
    raise exception 'Import needs exactly one active season';
  end if;

  -- Divisions are seeded, never imported.
  if exists (
    select 1
    from jsonb_to_recordset(v_teams) as t(id text, division_id text)
    where coalesce(t.division_id, 'd1') not in (select id from public.divisions)
  ) then
    raise exception 'Every imported team needs a known division';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as mt(id text, home_id text, division_id text)
    left join jsonb_to_recordset(v_teams) as home(id text, division_id text) on home.id = mt.home_id
    left join public.teams as live_home on live_home.id = mt.home_id
    where coalesce(mt.division_id, home.division_id, live_home.division_id, 'd1')
          not in (select id from public.divisions)
  ) then
    raise exception 'Every imported fixture needs a known division';
  end if;

  -- Every referenced row must be imported or already live (and not trashed).
  if exists (
    select 1
    from jsonb_to_recordset(v_players) as pl(id text, team_id text)
    where not exists (
      select 1 from jsonb_to_recordset(v_teams) as t(id text) where t.id = pl.team_id
    )
    and not exists (
      select 1 from public.teams t where t.id = pl.team_id and t.deleted_at is null
    )
  ) then
    raise exception 'Every imported player needs a known team';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as mt(id text, season_id text)
    where not exists (
      select 1 from jsonb_to_recordset(v_seasons) as s(id text) where s.id = mt.season_id
    )
    and not exists (
      select 1 from public.seasons s where s.id = mt.season_id and s.deleted_at is null
    )
  ) then
    raise exception 'Every imported fixture needs a known season';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as mt(id text, home_id text, away_id text)
    where mt.home_id = mt.away_id
       or (
         not exists (select 1 from jsonb_to_recordset(v_teams) as t(id text) where t.id = mt.home_id)
         and not exists (select 1 from public.teams t where t.id = mt.home_id and t.deleted_at is null)
       )
       or (
         not exists (select 1 from jsonb_to_recordset(v_teams) as t(id text) where t.id = mt.away_id)
         and not exists (select 1 from public.teams t where t.id = mt.away_id and t.deleted_at is null)
       )
  ) then
    raise exception 'Every imported fixture needs two different known teams';
  end if;

  -- Events must belong to their fixture and to the player's current team.
  if exists (
    select 1
    from jsonb_to_recordset(v_match_events) as e(
      id text, match_id text, team_id text, player_id text, event_type text, minute int
    )
    where coalesce(e.event_type, '') not in ('goal', 'yellow', 'red')
       or e.minute is null
       or e.minute < 1
       or e.minute > 130
       or not exists (
         select 1 from jsonb_to_recordset(v_matches) as m(id text) where m.id = e.match_id
       )
       and not exists (
         select 1 from public.matches m where m.id = e.match_id and m.deleted_at is null
       )
  ) then
    raise exception 'Every imported event needs a known fixture and a valid type/minute';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_match_events) as e(
      id text, match_id text, team_id text, player_id text
    )
    where not exists (
      select 1 from jsonb_to_recordset(v_teams) as t(id text) where t.id = e.team_id
    )
    and not exists (
      select 1 from public.teams t where t.id = e.team_id and t.deleted_at is null
    )
  ) then
    raise exception 'Every imported event needs a known team';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_match_events) as e(
      id text, match_id text, team_id text, player_id text
    )
    where not exists (
      select 1 from jsonb_to_recordset(v_players) as p(id text) where p.id = e.player_id
    )
    and not exists (
      select 1 from public.players p where p.id = e.player_id
    )
  ) then
    raise exception 'Every imported event needs a known player';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_match_events) as e(
      id text, match_id text, team_id text, player_id text
    )
    where e.team_id not in (
      coalesce(
        (select m.home_id from jsonb_to_recordset(v_matches) as m(id text, home_id text) where m.id = e.match_id),
        (select m.home_id from public.matches m where m.id = e.match_id and m.deleted_at is null)
      ),
      coalesce(
        (select m.away_id from jsonb_to_recordset(v_matches) as m(id text, away_id text) where m.id = e.match_id),
        (select m.away_id from public.matches m where m.id = e.match_id and m.deleted_at is null)
      )
    )
  ) then
    raise exception 'Every imported event must belong to one of its fixture teams';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_match_events) as e(
      id text, match_id text, team_id text, player_id text
    )
    where coalesce(
      (select pl.team_id from jsonb_to_recordset(v_players) as pl(id text, team_id text) where pl.id = e.player_id),
      (select p.team_id from public.players p where p.id = e.player_id)
    ) is distinct from e.team_id
  ) then
    raise exception 'Every imported event must use a player from its team';
  end if;

  -- Licence numbers are optional but unique in the payload and against live
  -- profiles, except for the imported players whose licence this merge clears
  -- before restoring it.
  if exists (
    select 1
    from (
      select upper(btrim(pl.license_id)) as licence
      from jsonb_to_recordset(v_players) as pl(license_id text)
      where nullif(btrim(coalesce(pl.license_id, '')), '') is not null
    ) licences
    group by licences.licence
    having count(*) > 1
  ) then
    raise exception 'Every imported licence number must be unique';
  end if;

  if exists (
    select 1
    from (
      select upper(btrim(pl.license_id)) as licence
      from jsonb_to_recordset(v_players) as pl(license_id text)
      where nullif(btrim(coalesce(pl.license_id, '')), '') is not null
    ) inc
    join public.player_profiles pp
      on upper(btrim(pp.license_id)) = inc.licence
    where not exists (
      select 1 from jsonb_to_recordset(v_players) as pl(id text) where pl.id = pp.player_id
    )
  ) then
    raise exception 'An imported licence number is already used by another player';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_players) as pl(birth_date text)
    where nullif(btrim(coalesce(pl.birth_date, '')), '') is not null
      and btrim(pl.birth_date) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ) then
    raise exception 'Every imported birth date must use YYYY-MM-DD';
  end if;
end;
$$;

revoke execute on function public.validate_import_payload(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. DIFF HELPER
-- ------------------------------------------------------------
-- Both inputs are arrays of {id, label, doc, removable}. Incoming rows have no
-- removable flag. A live row that is absent from the payload is "removed" only
-- when removable is true; otherwise it is ignored (it is referenced by the
-- payload or already archived).
create or replace function public.import_diff_rows(
  p_incoming jsonb,
  p_live jsonb,
  p_limit int default 100
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with incoming as (
    select id, label, doc
    from jsonb_to_recordset(coalesce(p_incoming, '[]'::jsonb))
      as x(id text, label text, doc jsonb)
  ),
  live as (
    select id, label, doc, coalesce(removable, true) as removable
    from jsonb_to_recordset(coalesce(p_live, '[]'::jsonb))
      as x(id text, label text, doc jsonb, removable boolean)
  ),
  joined as (
    select coalesce(i.id, l.id) as id,
           coalesce(i.label, l.label) as label,
           i.doc as incoming_doc,
           l.doc as live_doc,
           coalesce(l.removable, false) as removable
    from incoming i
    full outer join live l on l.id = i.id
  ),
  classified as (
    select id,
           label,
           case
             when live_doc is null then 'added'
             when incoming_doc is null then case when removable then 'removed' else 'unchanged' end
             when incoming_doc is distinct from live_doc then 'changed'
             else 'unchanged'
           end as state
    from joined
  ),
  counted as (
    select state, count(*)::int as n
    from classified
    group by state
  )
  select jsonb_build_object(
    'added', coalesce((select n from counted where state = 'added'), 0),
    'changed', coalesce((select n from counted where state = 'changed'), 0),
    'removed', coalesce((select n from counted where state = 'removed'), 0),
    'unchanged', coalesce((select n from counted where state = 'unchanged'), 0),
    'addedItems', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'label', label) order by label, id)
      from (
        select id, label from classified where state = 'added'
        order by label, id limit greatest(coalesce(p_limit, 100), 0)
      ) s
    ), '[]'::jsonb),
    'changedItems', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'label', label) order by label, id)
      from (
        select id, label from classified where state = 'changed'
        order by label, id limit greatest(coalesce(p_limit, 100), 0)
      ) s
    ), '[]'::jsonb),
    'removedItems', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'label', label) order by label, id)
      from (
        select id, label from classified where state = 'removed'
        order by label, id limit greatest(coalesce(p_limit, 100), 0)
      ) s
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.import_diff_rows(jsonb, jsonb, int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6. PREVIEW (read only)
-- ------------------------------------------------------------
create or replace function public.import_preview(
  p_data jsonb,
  p_remove_missing boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seasons jsonb;
  v_teams jsonb;
  v_players jsonb;
  v_matches jsonb;
  v_match_events jsonb;
  v_remove boolean := coalesce(p_remove_missing, false);
  v_seasons_in jsonb;
  v_seasons_live jsonb;
  v_teams_in jsonb;
  v_teams_live jsonb;
  v_players_in jsonb;
  v_players_live jsonb;
  v_matches_in jsonb;
  v_matches_live jsonb;
  v_events_in jsonb;
  v_events_live jsonb;
  v_tables jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can preview an import' using errcode = '42501';
  end if;

  perform public.validate_import_payload(p_data);

  v_seasons := coalesce(p_data->'seasons', '[]'::jsonb);
  v_teams := coalesce(p_data->'teams', '[]'::jsonb);
  v_players := coalesce(p_data->'players', '[]'::jsonb);
  v_matches := coalesce(p_data->'matches', '[]'::jsonb);
  v_match_events := coalesce(p_data->'match_events', '[]'::jsonb);

  -- ---------- seasons ----------
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', btrim(s.id),
    'label', btrim(s.name),
    'doc', jsonb_build_object(
      'name', btrim(s.name),
      'startDate', to_jsonb(s.start_date),
      'endDate', to_jsonb(s.end_date),
      'isActive', coalesce(s.is_active, false),
      'deleted', false
    )
  )), '[]'::jsonb)
  into v_seasons_in
  from jsonb_to_recordset(v_seasons) as s(
    id text, name text, start_date date, end_date date, is_active boolean
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'label', s.name,
    'doc', jsonb_build_object(
      'name', s.name,
      'startDate', to_jsonb(s.start_date),
      'endDate', to_jsonb(s.end_date),
      'isActive', s.is_active,
      'deleted', s.deleted_at is not null
    ),
    'removable', v_remove
      and s.deleted_at is null
      and jsonb_array_length(v_seasons) > 0
      and not exists (
        select 1 from jsonb_to_recordset(v_matches) as m(id text, season_id text) where m.season_id = s.id
      )
      and not exists (
        select 1
        from public.matches m
        where m.season_id = s.id
          and m.deleted_at is null
          and (
            exists (select 1 from jsonb_to_recordset(v_matches) as x(id text) where x.id = m.id)
            or exists (select 1 from jsonb_to_recordset(v_match_events) as e(match_id text) where e.match_id = m.id)
          )
      )
  )), '[]'::jsonb)
  into v_seasons_live
  from public.seasons s;

  -- ---------- teams ----------
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', btrim(t.id),
    'label', btrim(t.name),
    'doc', jsonb_build_object(
      'name', btrim(t.name),
      'nameAr', nullif(btrim(coalesce(t.name_ar, '')), ''),
      'icon', nullif(btrim(coalesce(t.icon, '')), ''),
      'code', coalesce(t.code, 'TBD'),
      'color', coalesce(t.color, '#16a34a'),
      'divisionId', coalesce(t.division_id, 'd1'),
      'deleted', false
    )
  )), '[]'::jsonb)
  into v_teams_in
  from jsonb_to_recordset(v_teams) as t(
    id text, name text, name_ar text, icon text, code text, color text, division_id text
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'label', t.name,
    'doc', jsonb_build_object(
      'name', t.name,
      'nameAr', t.name_ar,
      'icon', t.icon,
      'code', t.code,
      'color', t.color,
      'divisionId', t.division_id,
      'deleted', t.deleted_at is not null
    ),
    'removable', v_remove
      and t.deleted_at is null
      and not exists (
        select 1 from jsonb_to_recordset(v_matches) as m(home_id text, away_id text)
        where t.id in (m.home_id, m.away_id)
      )
      and not exists (
        select 1 from jsonb_to_recordset(v_players) as pl(team_id text) where pl.team_id = t.id
      )
      and not exists (
        select 1
        from public.matches m
        where m.deleted_at is null
          and t.id in (m.home_id, m.away_id)
          and (
            exists (select 1 from jsonb_to_recordset(v_matches) as x(id text) where x.id = m.id)
            or exists (select 1 from jsonb_to_recordset(v_match_events) as e(match_id text) where e.match_id = m.id)
          )
      )
  )), '[]'::jsonb)
  into v_teams_live
  from public.teams t;

  -- ---------- players ----------
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', btrim(pl.id),
    'label', btrim(pl.name),
    'doc', jsonb_build_object(
      'teamId', btrim(pl.team_id),
      'name', btrim(pl.name),
      'nameAr', nullif(btrim(coalesce(pl.name_ar, '')), ''),
      'pos', coalesce(pl.pos, 'MID'),
      'num', coalesce(pl.num, 10),
      'goals', coalesce(pl.goals, 0),
      'yellow', coalesce(pl.yellow, 0),
      'red', coalesce(pl.red, 0),
      'isActive', coalesce(pl.is_active, true),
      'licenseId', nullif(btrim(coalesce(pl.license_id, '')), ''),
      'birthDate', nullif(btrim(coalesce(pl.birth_date, '')), '')
    )
  )), '[]'::jsonb)
  into v_players_in
  from jsonb_to_recordset(v_players) as pl(
    id text, team_id text, name text, name_ar text, pos text, num int,
    goals int, yellow int, red int, is_active boolean, license_id text, birth_date text
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'label', p.name,
    'doc', jsonb_build_object(
      'teamId', p.team_id,
      'name', p.name,
      'nameAr', p.name_ar,
      'pos', p.pos,
      'num', p.num,
      'goals', p.legacy_goals + coalesce(e.goals, 0),
      'yellow', p.legacy_yellow + coalesce(e.yellow, 0),
      'red', p.legacy_red + coalesce(e.red, 0),
      'isActive', p.is_active,
      'licenseId', pp.license_id,
      'birthDate', to_jsonb(pp.birth_date)
    ),
    'removable', v_remove
      and p.is_active
      and not exists (
        select 1 from jsonb_to_recordset(v_match_events) as ev(player_id text) where ev.player_id = p.id
      )
  )), '[]'::jsonb)
  into v_players_live
  from public.players p
  left join public.v_player_event_totals e on e.player_id = p.id
  left join public.player_profiles pp on pp.player_id = p.id;

  -- ---------- matches ----------
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', btrim(mt.id),
    'label', btrim(mt.home_id) || ' - ' || btrim(mt.away_id),
    'doc', jsonb_build_object(
      'seasonId', btrim(mt.season_id),
      'divisionId', coalesce(
        mt.division_id,
        (select coalesce(t.division_id, 'd1') from jsonb_to_recordset(v_teams) as t(id text, division_id text) where t.id = mt.home_id),
        (select t.division_id from public.teams t where t.id = mt.home_id),
        'd1'
      ),
      'round', coalesce(mt.round, 1),
      'homeId', btrim(mt.home_id),
      'awayId', btrim(mt.away_id),
      'homeScore', coalesce(mt.home_score, 0),
      'awayScore', coalesce(mt.away_score, 0),
      'status', coalesce(mt.status, 'SCHEDULED'),
      -- The app maps an absent database value to '' in its own model, so the
      -- preview treats NULL and '' as the same "no value" on both sides.
      'datetime', nullif(mt.datetime, ''),
      'venue', nullif(mt.venue, ''),
      'scorersText', nullif(mt.scorers_text, ''),
      'eventsCounted', coalesce(mt.events_counted, true),
      'deleted', false
    )
  )), '[]'::jsonb)
  into v_matches_in
  from jsonb_to_recordset(v_matches) as mt(
    id text, season_id text, division_id text, round int, home_id text, away_id text,
    home_score int, away_score int, status text, datetime text, venue text,
    scorers_text text, events_counted boolean
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'label', m.home_id || ' - ' || m.away_id,
    'doc', jsonb_build_object(
      'seasonId', m.season_id,
      'divisionId', m.division_id,
      'round', m.round,
      'homeId', m.home_id,
      'awayId', m.away_id,
      'homeScore', m.home_score,
      'awayScore', m.away_score,
      'status', m.status,
      'datetime', nullif(m.datetime, ''),
      'venue', nullif(m.venue, ''),
      'scorersText', nullif(m.scorers_text, ''),
      'eventsCounted', m.events_counted,
      'deleted', m.deleted_at is not null
    ),
    'removable', v_remove
      and m.deleted_at is null
      and not exists (
        select 1 from jsonb_to_recordset(v_match_events) as e(match_id text) where e.match_id = m.id
      )
  )), '[]'::jsonb)
  into v_matches_live
  from public.matches m;

  -- ---------- match events ----------
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', btrim(e.id),
    'label', coalesce(e.event_type, 'event') || ' ' || coalesce(e.minute::text, '?') || '''',
    'doc', jsonb_build_object(
      'matchId', btrim(e.match_id),
      'teamId', btrim(e.team_id),
      'playerId', btrim(e.player_id),
      'eventType', e.event_type,
      'minute', e.minute
    )
  )), '[]'::jsonb)
  into v_events_in
  from jsonb_to_recordset(v_match_events) as e(
    id text, match_id text, team_id text, player_id text, event_type text, minute int
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ev.id,
    'label', ev.event_type || ' ' || ev.minute || '''',
    'doc', jsonb_build_object(
      'matchId', ev.match_id,
      'teamId', ev.team_id,
      'playerId', ev.player_id,
      'eventType', ev.event_type,
      'minute', ev.minute
    ),
    'removable', v_remove
      and exists (
        select 1 from jsonb_to_recordset(v_matches) as m(id text) where m.id = ev.match_id
      )
  )), '[]'::jsonb)
  into v_events_live
  from public.match_events ev;

  v_tables := jsonb_build_object(
    'seasons', public.import_diff_rows(v_seasons_in, v_seasons_live),
    'teams', public.import_diff_rows(v_teams_in, v_teams_live),
    'players', public.import_diff_rows(v_players_in, v_players_live),
    'matches', public.import_diff_rows(v_matches_in, v_matches_live),
    'events', public.import_diff_rows(v_events_in, v_events_live)
  );

  return jsonb_build_object(
    'ok', true,
    'removeMissing', v_remove,
    'checksum', public.import_checksum(p_data, v_remove),
    'tables', v_tables,
    'totals', (
      select jsonb_build_object(
        'added', coalesce(sum((value->>'added')::int), 0),
        'changed', coalesce(sum((value->>'changed')::int), 0),
        'removed', coalesce(sum((value->>'removed')::int), 0),
        'unchanged', coalesce(sum((value->>'unchanged')::int), 0)
      )
      from jsonb_each(v_tables)
    )
  );
end;
$$;

revoke execute on function public.import_preview(jsonb, boolean) from public, anon;
grant execute on function public.import_preview(jsonb, boolean) to authenticated;

-- ------------------------------------------------------------
-- 7. MERGE (one transaction, idempotent)
-- ------------------------------------------------------------
create or replace function public.import_merge(
  p_data jsonb,
  p_idempotency_key text,
  p_remove_missing boolean default false,
  p_expected_checksum text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_remove boolean := coalesce(p_remove_missing, false);
  v_checksum text;
  v_previous public.import_runs%rowtype;
  v_preview jsonb;
  v_result jsonb;
  v_run public.import_runs%rowtype;
  v_seasons jsonb;
  v_teams jsonb;
  v_players jsonb;
  v_matches jsonb;
  v_match_events jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can merge an import' using errcode = '42501';
  end if;

  if length(v_key) < 8 or length(v_key) > 200 then
    raise exception 'An import idempotency key must be between 8 and 200 characters';
  end if;

  perform public.validate_import_payload(p_data);
  v_checksum := public.import_checksum(p_data, v_remove);

  if p_expected_checksum is not null
     and btrim(p_expected_checksum) <> ''
     and btrim(p_expected_checksum) <> v_checksum then
    raise exception 'The backup changed after the preview; preview it again';
  end if;

  -- Same lock as replace_all_data(): two admin tabs cannot interleave imports.
  perform pg_advisory_xact_lock(748291);

  select * into v_previous
  from public.import_runs r
  where r.idempotency_key = v_key;

  if found then
    if v_previous.checksum <> v_checksum then
      raise exception 'This idempotency key was already used for a different backup';
    end if;
    return v_previous.result || jsonb_build_object(
      'replayed', true,
      'runId', v_previous.id,
      'appliedAt', v_previous.applied_at
    );
  end if;

  v_preview := public.import_preview(p_data, v_remove);

  v_seasons := coalesce(p_data->'seasons', '[]'::jsonb);
  v_teams := coalesce(p_data->'teams', '[]'::jsonb);
  v_players := coalesce(p_data->'players', '[]'::jsonb);
  v_matches := coalesce(p_data->'matches', '[]'::jsonb);
  v_match_events := coalesce(p_data->'match_events', '[]'::jsonb);

  -- One IMPORT summary is written at the end instead of one row per record.
  perform set_config('app.audit_skip', '1', true);
  perform set_config('kickoff.importing', 'on', true);

  -- ---------- seasons ----------
  if jsonb_array_length(v_seasons) > 0 then
    -- At most one active season. The upsert below sets the imported one true.
    update public.seasons set is_active = false where is_active;

    insert into public.seasons (id, name, start_date, end_date, is_active)
    select btrim(s.id), btrim(s.name), s.start_date, s.end_date, coalesce(s.is_active, false)
    from jsonb_to_recordset(v_seasons) as s(
      id text, name text, start_date date, end_date date, is_active boolean
    )
    on conflict (id) do update
      set name = excluded.name,
          start_date = excluded.start_date,
          end_date = excluded.end_date,
          is_active = excluded.is_active,
          deleted_at = null;
  end if;

  -- ---------- teams ----------
  insert into public.teams (id, name, name_ar, icon, code, color, division_id)
  select btrim(t.id),
         btrim(t.name),
         nullif(btrim(coalesce(t.name_ar, '')), ''),
         nullif(btrim(coalesce(t.icon, '')), ''),
         coalesce(t.code, 'TBD'),
         coalesce(t.color, '#16a34a'),
         coalesce(t.division_id, 'd1')
  from jsonb_to_recordset(v_teams) as t(
    id text, name text, name_ar text, icon text, code text, color text, division_id text
  )
  on conflict (id) do update
    set name = excluded.name,
        name_ar = excluded.name_ar,
        icon = excluded.icon,
        code = excluded.code,
        color = excluded.color,
        division_id = excluded.division_id,
        deleted_at = null;

  -- ---------- players ----------
  -- legacy_* starts at the imported total and is corrected after the events are
  -- in place, so v_player_stats shows the backup number again.
  insert into public.players (
    id, team_id, name, name_ar, pos, num,
    legacy_goals, legacy_yellow, legacy_red, is_active
  )
  select btrim(pl.id),
         btrim(pl.team_id),
         btrim(pl.name),
         nullif(btrim(coalesce(pl.name_ar, '')), ''),
         coalesce(pl.pos, 'MID'),
         coalesce(pl.num, 10),
         coalesce(pl.goals, 0),
         coalesce(pl.yellow, 0),
         coalesce(pl.red, 0),
         coalesce(pl.is_active, true)
  from jsonb_to_recordset(v_players) as pl(
    id text, team_id text, name text, name_ar text, pos text, num int,
    goals int, yellow int, red int, is_active boolean
  )
  on conflict (id) do update
    set team_id = excluded.team_id,
        name = excluded.name,
        name_ar = excluded.name_ar,
        pos = excluded.pos,
        num = excluded.num,
        legacy_goals = excluded.legacy_goals,
        legacy_yellow = excluded.legacy_yellow,
        legacy_red = excluded.legacy_red,
        is_active = excluded.is_active;

  -- Clear the licences of the imported players first so swapping two numbers
  -- cannot trip the unique index halfway through the upsert.
  update public.player_profiles pp
     set license_id = null
   where exists (
     select 1 from jsonb_to_recordset(v_players) as pl(id text) where pl.id = pp.player_id
   );

  insert into public.player_profiles (player_id, license_id, birth_date)
  select btrim(pl.id),
         nullif(btrim(coalesce(pl.license_id, '')), ''),
         nullif(btrim(coalesce(pl.birth_date, '')), '')::date
  from jsonb_to_recordset(v_players) as pl(
    id text, license_id text, birth_date text
  )
  where nullif(btrim(coalesce(pl.license_id, '')), '') is not null
     or nullif(btrim(coalesce(pl.birth_date, '')), '') is not null
  on conflict (player_id) do update
    set license_id = excluded.license_id,
        birth_date = excluded.birth_date,
        updated_at = now();

  -- ---------- matches ----------
  insert into public.matches (
    id, season_id, division_id, round, home_id, away_id,
    home_score, away_score, status, datetime, venue, scorers_text, events_counted
  )
  select btrim(mt.id),
         btrim(mt.season_id),
         coalesce(
           mt.division_id,
           (select coalesce(t.division_id, 'd1') from jsonb_to_recordset(v_teams) as t(id text, division_id text) where t.id = mt.home_id),
           (select t.division_id from public.teams t where t.id = mt.home_id),
           'd1'
         ),
         coalesce(mt.round, 1),
         btrim(mt.home_id),
         btrim(mt.away_id),
         coalesce(mt.home_score, 0),
         coalesce(mt.away_score, 0),
         coalesce(mt.status, 'SCHEDULED'),
         nullif(mt.datetime, ''),
         nullif(mt.venue, ''),
         nullif(mt.scorers_text, ''),
         coalesce(mt.events_counted, true)
  from jsonb_to_recordset(v_matches) as mt(
    id text, season_id text, division_id text, round int, home_id text, away_id text,
    home_score int, away_score int, status text, datetime text, venue text,
    scorers_text text, events_counted boolean
  )
  on conflict (id) do update
    set season_id = excluded.season_id,
        division_id = excluded.division_id,
        round = excluded.round,
        home_id = excluded.home_id,
        away_id = excluded.away_id,
        home_score = excluded.home_score,
        away_score = excluded.away_score,
        status = excluded.status,
        datetime = excluded.datetime,
        venue = excluded.venue,
        scorers_text = excluded.scorers_text,
        events_counted = excluded.events_counted,
        deleted_at = null;

  -- ---------- events ----------
  -- The event list of an imported fixture is authoritative only when the admin
  -- ticks "remove missing rows"; otherwise merge only inserts and updates.
  if v_remove then
    delete from public.match_events ev
    where exists (
      select 1 from jsonb_to_recordset(v_matches) as m(id text) where m.id = ev.match_id
    )
    and not exists (
      select 1 from jsonb_to_recordset(v_match_events) as e(id text) where e.id = ev.id
    );
  end if;

  insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
  select btrim(e.id), btrim(e.match_id), btrim(e.team_id), btrim(e.player_id),
         e.event_type, e.minute
  from jsonb_to_recordset(v_match_events) as e(
    id text, match_id text, team_id text, player_id text, event_type text, minute int
  )
  on conflict (id) do update
    set match_id = excluded.match_id,
        team_id = excluded.team_id,
        player_id = excluded.player_id,
        event_type = excluded.event_type,
        minute = excluded.minute;

  perform set_config('kickoff.importing', 'off', true);

  -- ---------- remove missing rows ----------
  if v_remove then
    -- Fixtures not in the backup, unless an imported event still points at one.
    update public.matches m
       set deleted_at = now()
     where m.deleted_at is null
       and not exists (
         select 1 from jsonb_to_recordset(v_matches) as x(id text) where x.id = m.id
       )
       and not exists (
         select 1 from jsonb_to_recordset(v_match_events) as e(id text, match_id text)
         where e.match_id = m.id
       );

    -- Seasons not in the backup, unless a fixture that stays still uses one.
    update public.seasons s
       set deleted_at = now()
     where s.deleted_at is null
       and jsonb_array_length(v_seasons) > 0
       and not exists (
         select 1 from jsonb_to_recordset(v_seasons) as x(id text) where x.id = s.id
       )
       and not exists (
         select 1
         from public.matches m
         where m.season_id = s.id
           and m.deleted_at is null
           and (
             exists (select 1 from jsonb_to_recordset(v_matches) as x(id text) where x.id = m.id)
             or exists (select 1 from jsonb_to_recordset(v_match_events) as e(match_id text) where e.match_id = m.id)
           )
       );

    -- Clubs not in the backup, unless an imported player or fixture uses one.
    update public.teams t
       set deleted_at = now()
     where t.deleted_at is null
       and not exists (
         select 1 from jsonb_to_recordset(v_teams) as x(id text) where x.id = t.id
       )
       and not exists (
         select 1 from jsonb_to_recordset(v_players) as pl(team_id text) where pl.team_id = t.id
       )
       and not exists (
         select 1 from jsonb_to_recordset(v_matches) as m(home_id text, away_id text)
         where t.id in (m.home_id, m.away_id)
       )
       and not exists (
         select 1
         from public.matches m
         where m.deleted_at is null
           and t.id in (m.home_id, m.away_id)
           and (
             exists (select 1 from jsonb_to_recordset(v_matches) as x(id text) where x.id = m.id)
             or exists (select 1 from jsonb_to_recordset(v_match_events) as e(match_id text) where e.match_id = m.id)
           )
       );

    -- Players are archived, never hard-deleted, so their match history stays.
    update public.players p
       set is_active = false
     where p.is_active
       and not exists (
         select 1 from jsonb_to_recordset(v_players) as x(id text) where x.id = p.id
       )
       and not exists (
         select 1 from jsonb_to_recordset(v_match_events) as e(player_id text) where e.player_id = p.id
       );
  end if;

  -- ---------- imported totals are authoritative ----------
  -- This runs after removals so a player who stays but loses fixtures to the
  -- trash still matches the number in the backup.
  update public.players p
     set legacy_goals = greatest(0, coalesce(inc.goals, 0) - coalesce(e.goals, 0)),
         legacy_yellow = greatest(0, coalesce(inc.yellow, 0) - coalesce(e.yellow, 0)),
         legacy_red = greatest(0, coalesce(inc.red, 0) - coalesce(e.red, 0))
  from jsonb_to_recordset(v_players) as inc(id text, goals int, yellow int, red int)
  left join public.v_player_event_totals e on e.player_id = inc.id
  where p.id = inc.id;

  insert into public.import_runs (
    idempotency_key, checksum, mode, actor_id, actor_email,
    payload_counts, result, remove_missing
  )
  values (
    v_key,
    v_checksum,
    'merge',
    auth.uid(),
    (select u.email from auth.users u where u.id = auth.uid()),
    jsonb_build_object(
      'seasons', jsonb_array_length(v_seasons),
      'teams', jsonb_array_length(v_teams),
      'players', jsonb_array_length(v_players),
      'matches', jsonb_array_length(v_matches),
      'events', jsonb_array_length(v_match_events)
    ),
    v_preview,
    v_remove
  )
  returning * into v_run;

  insert into public.audit_log (
    actor_id, actor_email, action, entity, entity_id, summary
  )
  values (
    auth.uid(),
    (select u.email from auth.users u where u.id = auth.uid()),
    'IMPORT',
    'merge',
    null,
    format(
      'Merged backup %s: %s added, %s changed, %s removed (remove missing %s)',
      left(v_key, 8),
      (v_preview->'totals'->>'added')::int,
      (v_preview->'totals'->>'changed')::int,
      (v_preview->'totals'->>'removed')::int,
      case when v_remove then 'on' else 'off' end
    )
  );

  v_result := v_run.result || jsonb_build_object(
    'replayed', false,
    'runId', v_run.id,
    'appliedAt', v_run.applied_at
  );
  return v_result;
end;
$$;

revoke execute on function public.import_merge(jsonb, text, boolean, text) from public, anon;
grant execute on function public.import_merge(jsonb, text, boolean, text) to authenticated;


-- ------------------------------------------------------------
-- 7. SEED DATA (optional — delete this block to start empty)
-- ------------------------------------------------------------
insert into public.teams (id, name, code, color) values
  ('t1', 'Spartan FC',        'SFC', '#3b82f6'),
  ('t2', 'Titan United',      'TTN', '#10b981'),
  ('t3', 'Phoenix Rovers',    'PHX', '#f59e0b'),
  ('t4', 'Vanguard Athletic', 'VNG', '#ef4444'),
  ('t5', 'Atlas Warriors',    'ATL', '#8b5cf6'),
  ('t6', 'Coastal Sharks',    'CSH', '#06b6d4')
on conflict (id) do nothing;

insert into public.players (id, team_id, name, pos, num, legacy_goals, legacy_yellow, legacy_red) values
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

insert into public.matches (id, season_id, round, home_id, away_id, home_score, away_score, status, datetime, venue, scorers_text) values
  ('m1', 's1', 1, 't1', 't2', 3, 1, 'FINISHED',  '2026-10-03T15:00', 'Main Field - Pitch 1',     'Carlos Ramos (2), David Silva (1) - Ethan Hunt (1)'),
  ('m2', 's1', 1, 't3', 't4', 2, 2, 'FINISHED',  '2026-10-03T17:30', 'Main Field - Pitch 2',     'Leo Mendes (2) - John Terry (1), K. Diaz (1)'),
  ('m3', 's1', 1, 't5', 't6', 1, 0, 'FINISHED',  '2026-10-04T16:00', 'Community Sports Complex', 'Omar Belaid (1)'),
  ('m4', 's1', 2, 't2', 't3', 0, 1, 'FINISHED',  '2026-10-10T15:30', 'United Arena',             'Leo Mendes (1)'),
  ('m5', 's1', 2, 't4', 't5', 2, 2, 'FINISHED',  '2026-10-11T18:00', 'Vanguard Ground',          'John Terry (1), R. Cole (1) - Omar Belaid (2)'),
  ('m6', 's1', 2, 't6', 't1', 1, 1, 'LIVE',      '2026-10-20T19:00', 'Shark Park',               'Lucas Ferrao (1) - Carlos Ramos (1)'),
  ('m7', 's1', 3, 't1', 't3', 0, 0, 'SCHEDULED', '2026-10-24T15:00', 'Main Field - Pitch 1',     ''),
  ('m8', 's1', 3, 't2', 't5', 0, 0, 'SCHEDULED', '2026-10-25T17:00', 'United Arena',             ''),
  ('m9', 's1', 3, 't4', 't6', 0, 0, 'SCHEDULED', '2026-10-25T19:30', 'Vanguard Ground',          '')
on conflict (id) do nothing;

-- Only seed events when the sample match/team/player relations still hold.
insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
select v.id, v.match_id, v.team_id, v.player_id, v.event_type, v.minute
from (values
  ('e1',  'm1', 't1', 'p2', 'goal',   23),
  ('e2',  'm1', 't1', 'p1', 'goal',   54),
  ('e3',  'm1', 't1', 'p2', 'goal',   71),
  ('e4',  'm1', 't2', 'p3', 'goal',   80),
  ('e5',  'm1', 't2', 'p3', 'yellow', 42),
  ('e6',  'm2', 't3', 'p4', 'goal',   12),
  ('e7',  'm2', 't3', 'p4', 'goal',   66),
  ('e8',  'm2', 't4', 'p5', 'goal',   33),
  ('e9',  'm2', 't4', 'p5', 'yellow', 58),
  ('e10', 'm3', 't5', 'p6', 'goal',   77)
) as v(id, match_id, team_id, player_id, event_type, minute)
where exists (
  select 1
  from public.matches m
  join public.players p on p.id = v.player_id and p.team_id = v.team_id
  where m.id = v.match_id
    and v.team_id in (m.home_id, m.away_id)
)
on conflict (id) do nothing;

-- Seed totals are career totals: the sample events are already included in
-- the numbers above. They start as the legacy offset and the counted events
-- are taken back out, so v_player_stats shows the seeded totals.
do $$
begin
  perform set_config('app.audit_skip', '1', true);

  with counted as (
    select ev.player_id,
           count(*) filter (where ev.event_type = 'goal')::int as goals,
           count(*) filter (where ev.event_type = 'yellow')::int as yellow,
           count(*) filter (where ev.event_type = 'red')::int as red
    from public.match_events ev
    join public.matches m
      on m.id = ev.match_id
     and m.events_counted
     and m.deleted_at is null
    join public.teams home
      on home.id = m.home_id
     and home.deleted_at is null
    join public.teams away
      on away.id = m.away_id
     and away.deleted_at is null
    join public.seasons s
      on s.id = m.season_id
     and s.deleted_at is null
    group by ev.player_id
  )
  update public.players p
     set legacy_goals = greatest(0, p.legacy_goals - coalesce(c.goals, 0)),
         legacy_yellow = greatest(0, p.legacy_yellow - coalesce(c.yellow, 0)),
         legacy_red = greatest(0, p.legacy_red - coalesce(c.red, 0))
  from public.players p2
  left join counted c on c.player_id = p2.id
  where p2.id = p.id;

  perform set_config('app.audit_skip', '', true);
end $$;

-- ============================================================
-- 8. MAKE YOURSELF ADMIN
--    ️Sign up once in the app (Admin Login → Create account),
--    confirm your email if required, then run:
--
--    update public.profiles
--       set role = 'admin'
--     where email = 'you@example.com';
--
--    Log out and back in — write controls will appear.
-- ============================================================

-- ============================================================
-- 9. AUDIT LOG
--    Append-only history of league writes, readable by admins
--    through list_audit_log(). Existing projects run
--    supabase/audit-log-migration.sql instead of this file.
-- ============================================================

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  season_id text,
  summary text,
  before jsonb,
  after jsonb,
  prev_hash text,
  row_hash text
);

-- Roadmap D: upgrade an audit_log created before the hash chain existed.
alter table public.audit_log add column if not exists prev_hash text;
alter table public.audit_log add column if not exists row_hash text;

create index if not exists audit_log_occurred_at_idx
  on public.audit_log (occurred_at desc, id desc);

create index if not exists audit_log_entity_idx
  on public.audit_log (entity, entity_id);

alter table public.audit_log enable row level security;

revoke all on public.audit_log from anon, authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

-- ------------------------------------------------------------
-- 9a. HASH CHAIN (roadmap D)
-- ------------------------------------------------------------
create or replace function public.audit_row_hash(
  p_prev text,
  p_id bigint,
  p_occurred_at timestamptz,
  p_actor_id uuid,
  p_actor_email text,
  p_action text,
  p_entity text,
  p_entity_id text,
  p_season_id text,
  p_summary text,
  p_before jsonb,
  p_after jsonb
)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(
    sha256(convert_to(
      jsonb_build_object(
        'version', 1,
        'prev', coalesce(p_prev, ''),
        'id', p_id,
        'occurredAt', to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actorId', p_actor_id,
        'actorEmail', p_actor_email,
        'action', p_action,
        'entity', p_entity,
        'entityId', p_entity_id,
        'seasonId', p_season_id,
        'summary', p_summary,
        'before', p_before,
        'after', p_after
      )::text,
      'utf8'
    )),
    'hex'
  );
$$;

revoke execute on function public.audit_row_hash(
  text, bigint, timestamptz, uuid, text, text, text, text, text, text, jsonb, jsonb
) from public, anon, authenticated;

-- Existing rows from a pre-D table get one hash each; hashed rows are kept.
do $$
declare
  r record;
  v_prev text;
  v_hash text;
begin
  for r in
    select * from public.audit_log where row_hash is null order by id
  loop
    select a.row_hash into v_prev
    from public.audit_log a
    where a.id < r.id
    order by a.id desc
    limit 1;

    v_hash := public.audit_row_hash(
      v_prev, r.id, r.occurred_at, r.actor_id, r.actor_email,
      r.action, r.entity, r.entity_id, r.season_id, r.summary, r.before, r.after
    );

    update public.audit_log
       set prev_hash = v_prev,
           row_hash = v_hash
     where id = r.id;
  end loop;
end;
$$;

create or replace function public.audit_log_chain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  if new.row_hash is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(748292);

  select a.row_hash into v_prev
  from public.audit_log a
  order by a.id desc
  limit 1;

  new.prev_hash := v_prev;
  new.row_hash := public.audit_row_hash(
    v_prev, new.id, new.occurred_at, new.actor_id, new.actor_email,
    new.action, new.entity, new.entity_id, new.season_id, new.summary,
    new.before, new.after
  );
  return new;
end;
$$;

revoke execute on function public.audit_log_chain() from public, anon, authenticated;

drop trigger if exists audit_log_chain on public.audit_log;
create trigger audit_log_chain
  before insert on public.audit_log
  for each row execute function public.audit_log_chain();

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_skip text := current_setting('app.audit_skip', true);
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_actor uuid := auth.uid();
  v_action text := tg_op;
begin
  -- Bulk imports record one summary entry instead of every row.
  if v_skip = '1' then
    return null;
  end if;

  if tg_op <> 'INSERT' then
    v_before := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    v_after := to_jsonb(new);
  end if;
  v_row := coalesce(v_after, v_before);

  -- Soft deletes and restores are updates of deleted_at. Label them so
  -- the activity log reads "Deleted" / "Restored".
  if tg_op = 'UPDATE' then
    if (v_before->>'deleted_at') is null and (v_after->>'deleted_at') is not null then
      v_action := 'DELETE';
    elsif (v_before->>'deleted_at') is not null and (v_after->>'deleted_at') is null then
      v_action := 'RESTORE';
    end if;
  end if;

  insert into public.audit_log (
    actor_id, actor_email, action, entity, entity_id, season_id, before, after
  )
  values (
    v_actor,
    (select u.email from auth.users u where u.id = v_actor),
    v_action,
    tg_table_name,
    v_row->>'id',
    v_row->>'season_id',
    v_before,
    v_after
  );

  return null;  -- AFTER trigger: return value is ignored.
end;
$$;

drop trigger if exists audit_teams on public.teams;
create trigger audit_teams
  after insert or update or delete on public.teams
  for each row execute function public.audit_row_change();

drop trigger if exists audit_players on public.players;
create trigger audit_players
  after insert or update or delete on public.players
  for each row execute function public.audit_row_change();

drop trigger if exists audit_matches on public.matches;
create trigger audit_matches
  after insert or update or delete on public.matches
  for each row execute function public.audit_row_change();

drop trigger if exists audit_match_events on public.match_events;
create trigger audit_match_events
  after insert or update or delete on public.match_events
  for each row execute function public.audit_row_change();

drop trigger if exists audit_seasons on public.seasons;
create trigger audit_seasons
  after insert or update or delete on public.seasons
  for each row execute function public.audit_row_change();

create or replace function public.list_audit_log(p_limit int default 50)
returns setof public.audit_log
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can read the audit log' using errcode = '42501';
  end if;

  return query
    select *
    from public.audit_log
    order by occurred_at desc, id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke execute on function public.list_audit_log(int) from public, anon;
grant execute on function public.list_audit_log(int) to authenticated;

create or replace function public.audit_verify_chain(
  p_expected_head text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_prev text := null;
  v_checked int := 0;
  v_total int;
  v_expected text;
  r record;
begin
  if not public.is_admin() then
    raise exception 'Only admins can verify the audit log' using errcode = '42501';
  end if;

  select count(*)::int into v_total from public.audit_log;

  for r in select * from public.audit_log order by id loop
    if r.prev_hash is distinct from v_prev then
      return jsonb_build_object(
        'ok', false,
        'checked', v_checked,
        'total', v_total,
        'brokenAt', r.id,
        'reason', 'prev_hash',
        'expectedPrev', v_prev,
        'actualPrev', r.prev_hash
      );
    end if;

    v_expected := public.audit_row_hash(
      v_prev, r.id, r.occurred_at, r.actor_id, r.actor_email,
      r.action, r.entity, r.entity_id, r.season_id, r.summary, r.before, r.after
    );

    if r.row_hash is distinct from v_expected then
      return jsonb_build_object(
        'ok', false,
        'checked', v_checked,
        'total', v_total,
        'brokenAt', r.id,
        'reason', 'row_hash',
        'expectedHash', v_expected,
        'actualHash', r.row_hash
      );
    end if;

    v_prev := r.row_hash;
    v_checked := v_checked + 1;
  end loop;

  if p_expected_head is not null
     and p_expected_head is distinct from coalesce(v_prev, '') then
    return jsonb_build_object(
      'ok', false,
      'checked', v_checked,
      'total', v_total,
      'reason', 'head_mismatch',
      'expectedHead', p_expected_head,
      'actualHead', v_prev
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'checked', v_checked,
    'total', v_total,
    'head', v_prev
  );
end;
$$;

revoke execute on function public.audit_verify_chain(text) from public, anon;
grant execute on function public.audit_verify_chain(text) to authenticated;

create or replace function public.audit_chain_head()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'count', count(*)::int,
    'lastId', max(id),
    'at', (select a.occurred_at from public.audit_log a order by a.id desc limit 1),
    'head', (select a.row_hash from public.audit_log a order by a.id desc limit 1)
  )
  from public.audit_log;
$$;

revoke execute on function public.audit_chain_head() from public;
grant execute on function public.audit_chain_head() to anon, authenticated;

-- Ask PostgREST to pick up new tables/functions immediately.
notify pgrst, 'reload schema';
