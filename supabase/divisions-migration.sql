-- ------------------------------------------------------------
-- KickOff Division - two divisions (roadmap item K)
-- ------------------------------------------------------------
-- Adds Division 1 and Division 2 while keeping one shared season:
--
--   * public.divisions is seeded with d1/d2 and is maintainer-managed;
--   * teams.division_id stores the current registration (existing clubs go to
--     Division 1);
--   * matches.division_id stamps the division a fixture was played in, derived
--     from its teams at creation and never rewritten by a later team move;
--   * v_match_results / v_standings expose and group by division;
--   * save_match(), set_team_division() and replace_all_data() understand the
--     new field, and triggers guard direct REST writes.
--
-- Additive and safe to re-run. It does not delete or rewrite any row: an
-- existing fixture keeps the division of its home team at the time of the
-- upgrade, and moving a club later only changes its current registration.
--
-- Run in the Supabase SQL Editor for development, then production. It assumes
-- the roadmap A migration (players.legacy_*, v_player_event_totals) and the
-- integrity/season migrations have already been applied.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. DIVISIONS
-- ------------------------------------------------------------
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

grant select on public.divisions to anon, authenticated;
revoke insert, update, delete on public.divisions from anon, authenticated;

alter table public.divisions enable row level security;

drop policy if exists divisions_select_all on public.divisions;
create policy divisions_select_all on public.divisions
  for select to anon, authenticated using (true);

-- ------------------------------------------------------------
-- 2. TEAMS BELONG TO A DIVISION
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 3. FIXTURES REMEMBER THEIR DIVISION
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 4. DIVISION GUARDS
-- ------------------------------------------------------------
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
-- 5. DERIVED VIEWS
-- ------------------------------------------------------------
-- New columns are appended at the end so create or replace can upgrade the
-- pre-division views in place.

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
-- 6. SAVE MATCHES INSIDE A DIVISION
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

  if p_events is not null and p_events <> 'null'::jsonb then
    perform public.replace_match_events(v_id, p_events);
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 7. MOVE A TEAM BETWEEN DIVISIONS
-- ------------------------------------------------------------
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
-- 8. FULL IMPORT KEEPS DIVISIONS
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


notify pgrst, 'reload schema';
