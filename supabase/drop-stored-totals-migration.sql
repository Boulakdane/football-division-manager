-- ------------------------------------------------------------
-- KickOff Division - drop the stored player totals
-- ------------------------------------------------------------
-- Stage 3 of roadmap item A. Stage 1 added the legacy offsets and
-- v_player_stats; stage 2 switched the app to read the view (#14). This file
-- removes the last copy of the totals: players.goals / yellow / red.
--
-- What stays:
--   * players.legacy_goals / legacy_yellow / legacy_red, the part of a total
--     that has no event row (history entered before match_events existed);
--   * v_player_stats, the only place a total is read from now on;
--   * matches.events_counted, which marks the fixtures whose events are
--     already inside the legacy offset. Dropping it would count those events
--     twice, so it stays on purpose (see roadmap A).
--
-- The backfill runs first: legacy = stored total - counted events, so every
-- total the app shows today is preserved exactly. The RPCs are then replaced
-- by versions that no longer touch the stored columns, and the columns are
-- dropped. Safe to re-run: the backfill is skipped once the columns are gone.
--
-- Run supabase/derive-totals-migration.sql first (on a project that predates
-- this file), then this one, development before production.
--
-- After this file, an older migration that still inserts players.goals cannot
-- be re-run as-is. Recreate the columns first, or start from schema.sql plus
-- the two roadmap A migrations.
-- ------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 1. KEEP THE CURRENT TOTALS
-- ------------------------------------------------------------
-- The stored total is authoritative at this point (the dual run in
-- development compared it with the view). Keep only the part that has no
-- counted event as the legacy offset.
do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'players'
      and column_name = 'goals'
  ) then
    perform set_config('app.audit_skip', '1', true);

    execute $backfill$
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
      where p2.id = p.id
    $backfill$;

    perform set_config('app.audit_skip', '', true);
  end if;
end $migration$;

-- ------------------------------------------------------------
-- 2. FUNCTIONS THAT NO LONGER WRITE TOTALS
-- ------------------------------------------------------------
-- Events are the source of truth, so replacing, deleting or restoring a
-- fixture needs no arithmetic: the views follow the rows.

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


-- ------------------------------------------------------------
-- 3. DROP THE STORED COLUMNS
-- ------------------------------------------------------------
alter table public.players
  drop constraint if exists kickoff_players_totals_range;

alter table public.players drop column if exists goals;
alter table public.players drop column if exists yellow;
alter table public.players drop column if exists red;

notify pgrst, 'reload schema';

commit;
