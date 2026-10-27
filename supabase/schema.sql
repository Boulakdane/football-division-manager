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
  code text not null default 'TBD',
  color text not null default '#16a34a',
  division_id text not null default 'd1' references public.divisions (id) on delete restrict,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kickoff_teams_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_teams_name_length check (length(btrim(name)) between 1 and 100),
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
  pos text not null default 'MID' check (pos in ('GK', 'DEF', 'MID', 'FWD')),
  num int not null default 10,
  legacy_goals int not null default 0,
  legacy_yellow int not null default 0,
  legacy_red int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint kickoff_players_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_players_name_length check (length(btrim(name)) between 1 and 100),
  constraint kickoff_players_num_range check (num between 0 and 999),
  constraint kickoff_players_legacy_totals_range check (legacy_goals >= 0 and legacy_yellow >= 0 and legacy_red >= 0)
);

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
        'awayName', a.name,
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
  v_pos text;
  v_num int;
  v_goals int;
  v_yellow int;
  v_red int;
  v_count int := 0;
  v_seen text[] := '{}';
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

    insert into public.players (
      id, team_id, name, pos, num,
      legacy_goals, legacy_yellow, legacy_red,
      is_active
    )
    values (
      'p_' || replace(gen_random_uuid()::text, '-', ''),
      p_team_id, v_name, v_pos, v_num,
      v_goals, v_yellow, v_red,
      true
    );
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

  insert into public.teams (id, name, code, color, division_id)
  select t.id,
         t.name,
         coalesce(t.code, 'TBD'),
         coalesce(t.color, '#16a34a'),
         coalesce(t.division_id, 'd1')
  from jsonb_to_recordset(v_teams) as t(
    id text,
    name text,
    code text,
    color text,
    division_id text
  );

  insert into public.players (id, team_id, name, pos, num, legacy_goals, legacy_yellow, legacy_red, is_active)
  select pl.id,
         pl.team_id,
         pl.name,
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
    pos text,
    num int,
    goals int,
    yellow int,
    red int,
    is_active boolean
  );

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
  after jsonb
);

create index if not exists audit_log_occurred_at_idx
  on public.audit_log (occurred_at desc, id desc);

create index if not exists audit_log_entity_idx
  on public.audit_log (entity, entity_id);

alter table public.audit_log enable row level security;

revoke all on public.audit_log from anon, authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

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

-- Ask PostgREST to pick up new tables/functions immediately.
notify pgrst, 'reload schema';
