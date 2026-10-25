-- ------------------------------------------------------------
-- KickOff Division - derive player and team totals from events
-- ------------------------------------------------------------
-- Stage 1 of roadmap item A. This migration is additive and keeps the
-- current app working: players.goals / yellow / red and matches.events_counted
-- are still maintained by the existing RPCs, while the new views recompute
-- the same totals from match_events (plus a legacy offset for totals that
-- have no event rows).
--
-- What it adds:
--   * players.legacy_goals / legacy_yellow / legacy_red, a fixed offset for
--     goals/cards entered before structured events existed;
--   * v_player_event_totals, the event side of a player's totals;
--   * v_player_stats, legacy + counted events (all-time, like the UI);
--   * v_match_results and v_standings, the table calculation in SQL;
--   * set_player_totals(), an admin-only way to edit a player's manual total
--     without breaking the view;
--   * add_players() and replace_all_data() now seed legacy offsets.
--
-- events_counted still decides which event rows count, exactly as the RPCs
-- do today. A follow-up frontend PR switches reads to these views; only after
-- that can the stored columns and events_counted be dropped.
--
-- Safe to re-run: the backfill recomputes legacy = stored totals - counted
-- events, so running it again leaves the views equal to the stored totals.
-- If you re-run an earlier migration that replaces add_players() or
-- replace_all_data(), run this file again afterwards.
--
-- Run in the Supabase SQL Editor for development, then production.
-- Fresh installs already get the same objects from schema.sql.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. LEGACY OFFSETS
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 2. DERIVED VIEWS
-- ------------------------------------------------------------
-- security_invoker keeps RLS in force for clients. Every view also filters
-- trashed rows and trashed teams explicitly, so admins and the service role
-- see exactly what a public visitor sees.

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
       p.legacy_red + coalesce(e.red, 0) as red
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
       end as away_result
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

-- Mirrors calculateStandings() in js/app.js:
--   * every visible club appears in the active season,
--   * an archived season only lists clubs that played in it,
--   * tie-breakers are points, goal difference, goals scored, wins, name.
create or replace view public.v_standings
with (security_invoker = true) as
with results as (
  select r.season_id,
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
         team_id,
         count(*)::int as played,
         count(*) filter (where result = 'W')::int as won,
         count(*) filter (where result = 'D')::int as drawn,
         count(*) filter (where result = 'L')::int as lost,
         coalesce(sum(goals_for), 0)::int as goals_for,
         coalesce(sum(goals_against), 0)::int as goals_against,
         coalesce(sum(points), 0)::int as points
  from results
  group by season_id, team_id
),
ordered as (
  select season_id,
         team_id,
         result,
         row_number() over (
           partition by season_id, team_id
           order by datetime nulls first, match_id
         ) as rn,
         count(*) over (partition by season_id, team_id) as total
  from results
),
form as (
  select season_id,
         team_id,
         array_agg(result order by rn) as form
  from ordered
  where rn > total - 5
  group by season_id, team_id
),
scope as (
  select s.id as season_id,
         t.id as team_id
  from public.seasons s
  join public.teams t on true
  where s.deleted_at is null
    and t.deleted_at is null
    and (
      s.is_active
      or exists (
        select 1
        from public.matches m
        where m.season_id = s.id
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
         partition by sc.season_id
         order by coalesce(tt.points, 0) desc,
                  coalesce(tt.goals_for, 0) - coalesce(tt.goals_against, 0) desc,
                  coalesce(tt.goals_for, 0) desc,
                  coalesce(tt.won, 0) desc,
                  t.name asc
       )::int as position
from scope sc
join public.teams t on t.id = sc.team_id
left join totals tt
  on tt.season_id = sc.season_id
 and tt.team_id = sc.team_id
left join form f
  on f.season_id = sc.season_id
 and f.team_id = sc.team_id;

revoke all on public.v_player_event_totals from public, anon, authenticated;
revoke all on public.v_player_stats from public, anon, authenticated;
revoke all on public.v_match_results from public, anon, authenticated;
revoke all on public.v_standings from public, anon, authenticated;

grant select on public.v_player_event_totals to anon, authenticated;
grant select on public.v_player_stats to anon, authenticated;
grant select on public.v_match_results to anon, authenticated;
grant select on public.v_standings to anon, authenticated;

-- ------------------------------------------------------------
-- 3. MANUAL PLAYER TOTALS
-- ------------------------------------------------------------
-- The player form still upserts the player row, but totals must go through
-- this RPC once the UI reads the view: it moves the legacy offset so the
-- view keeps showing the requested number.
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
     set goals = p_goals,
         yellow = p_yellow,
         red = p_red,
         legacy_goals = p_goals - v_event_goals,
         legacy_yellow = p_yellow - v_event_yellow,
         legacy_red = p_red - v_event_red
   where id = p_player_id;
end;
$$;

revoke execute on function public.set_player_totals(text, int, int, int) from public, anon;
grant execute on function public.set_player_totals(text, int, int, int) to authenticated;

-- ------------------------------------------------------------
-- 4. WRITE PATHS SEED THE LEGACY OFFSET
-- ------------------------------------------------------------
-- add_players() inserts totals with no event rows, so the whole total is the
-- legacy offset.
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
      goals, yellow, red,
      legacy_goals, legacy_yellow, legacy_red,
      is_active
    )
    values (
      'p_' || replace(gen_random_uuid()::text, '-', ''),
      p_team_id, v_name, v_pos, v_num,
      v_goals, v_yellow, v_red,
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

-- replace_all_data() recomputes the offset after inserting the imported
-- events, so an older backup with events_counted = false still round-trips.
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

  -- Serialize full imports so two admin tabs cannot delete and reinsert
  -- overlapping data at the same time.
  perform pg_advisory_xact_lock(748291);

  -- Transaction-local: the audit row triggers stay quiet during the
  -- replace, and one IMPORT summary is written at the end instead.
  perform set_config('app.audit_skip', '1', true);

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

  insert into public.teams (id, name, code, color)
  select t.id,
         t.name,
         coalesce(t.code, 'TBD'),
         coalesce(t.color, '#16a34a')
  from jsonb_to_recordset(v_teams) as t(
    id text,
    name text,
    code text,
    color text
  );

  insert into public.players (id, team_id, name, pos, num, goals, yellow, red, is_active)
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

  -- The imported stored totals are authoritative. Keep only the part that has
  -- no event row as the legacy offset, so the derived views match the import
  -- exactly (including older backups with events_counted = false).
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
     set legacy_goals = greatest(0, p.goals - coalesce(c.goals, 0)),
         legacy_yellow = greatest(0, p.yellow - coalesce(c.yellow, 0)),
         legacy_red = greatest(0, p.red - coalesce(c.red, 0))
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
-- 5. BACKFILL
-- ------------------------------------------------------------
-- Counted events are the ones a public visitor can see on a fixture that
-- events_counted says already contributed to the stored totals. Everything
-- else is preserved as the legacy offset.
do $$
begin
  -- Do not spam the activity log with one row per player.
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
     set legacy_goals = greatest(0, p.goals - coalesce(c.goals, 0)),
         legacy_yellow = greatest(0, p.yellow - coalesce(c.yellow, 0)),
         legacy_red = greatest(0, p.red - coalesce(c.red, 0))
  from public.players p2
  left join counted c on c.player_id = p2.id
  where p2.id = p.id;

  perform set_config('app.audit_skip', '', true);
end $$;

notify pgrst, 'reload schema';
