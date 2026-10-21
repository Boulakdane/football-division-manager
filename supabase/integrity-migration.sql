-- ============================================================
--  KickOff Division — integrity migration
--  Adds soft-archiving for players, database-enforced active-season
--  writes, atomic match+event saves, and safe team deletion.
--
--  Run this after seasons-migration.sql, match-events-migration.sql and
--  atomic-import-migration.sql, in Supabase -> SQL Editor -> New query -> Run.
--  Apply to development first, then production. Safe to re-run.
--
--  After this migration, direct DELETE on teams/matches and direct writes on
--  match_events are denied. Use delete_team(), delete_match(), save_match(),
--  replace_match_events() or replace_all_data().
-- ============================================================

-- ------------------------------------------------------------
-- 1. PLAYER ARCHIVING
-- ------------------------------------------------------------
alter table public.players
  add column if not exists is_active boolean not null default true;

-- ------------------------------------------------------------
-- 2. ACTIVE-SEASON HELPER
-- ------------------------------------------------------------
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
-- 3. ARCHIVED SEASONS ARE READ-ONLY IN THE DATABASE
-- ------------------------------------------------------------
drop policy if exists matches_insert_admin on public.matches;
create policy matches_insert_admin on public.matches
  for insert to authenticated
  with check (public.is_admin() and public.is_active_season(season_id));

drop policy if exists matches_update_admin on public.matches;
create policy matches_update_admin on public.matches
  for update to authenticated
  using (public.is_admin() and public.is_active_season(season_id))
  with check (public.is_admin() and public.is_active_season(season_id));

-- Deletes go through delete_match() / delete_team() so totals are reversed
-- before the cascade. No direct DELETE policy is created.
revoke delete on public.matches from authenticated;
revoke delete on public.teams from authenticated;
drop policy if exists matches_delete_admin on public.matches;

-- Team deletion must go through delete_team() as well.
drop policy if exists teams_delete_admin on public.teams;

-- Match events are RPC-only. Public reads stay enabled, but direct writes
-- would bypass the player-total adjustments.
revoke insert, update, delete on public.match_events from authenticated;
revoke insert, update, delete on public.match_events from anon;
drop policy if exists match_events_insert_admin on public.match_events;
drop policy if exists match_events_update_admin on public.match_events;
drop policy if exists match_events_delete_admin on public.match_events;

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

-- ------------------------------------------------------------
-- 4. MATCH EVENT FUNCTIONS (active-season guarded)
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
  v_old record;
  v_id text;
  v_team_id text;
  v_player_id text;
  v_type text;
  v_minute int;
  v_counted boolean;
  v_season_id text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change match events' using errcode = '42501';
  end if;

  -- Serialize match/event/team writes with full imports.
  perform pg_advisory_xact_lock(748291);

  select events_counted, season_id
    into v_counted, v_season_id
  from public.matches
  where id = p_match_id;

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

  if v_counted then
    for v_old in
      select * from public.match_events where match_id = p_match_id
    loop
      update public.players
         set goals = greatest(0, goals - case when v_old.event_type = 'goal' then 1 else 0 end),
             yellow = greatest(0, yellow - case when v_old.event_type = 'yellow' then 1 else 0 end),
             red = greatest(0, red - case when v_old.event_type = 'red' then 1 else 0 end)
       where id = v_old.player_id;
    end loop;
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

    if v_counted then
      update public.players
         set goals = goals + case when v_type = 'goal' then 1 else 0 end,
             yellow = yellow + case when v_type = 'yellow' then 1 else 0 end,
             red = red + case when v_type = 'red' then 1 else 0 end
       where id = v_player_id;
    end if;
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
  v_old record;
  v_counted boolean;
  v_season_id text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete matches' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select events_counted, season_id
    into v_counted, v_season_id
  from public.matches
  where id = p_match_id;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;

  if v_counted then
    for v_old in
      select * from public.match_events where match_id = p_match_id
    loop
      update public.players
         set goals = greatest(0, goals - case when v_old.event_type = 'goal' then 1 else 0 end),
             yellow = greatest(0, yellow - case when v_old.event_type = 'yellow' then 1 else 0 end),
             red = greatest(0, red - case when v_old.event_type = 'red' then 1 else 0 end)
       where id = v_old.player_id;
    end loop;
  end if;

  delete from public.matches where id = p_match_id;
end;
$$;

-- ------------------------------------------------------------
-- 5. ATOMIC MATCH + EVENTS SAVE
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
  v_round int;
  v_home_id text;
  v_away_id text;
  v_home_score int;
  v_away_score int;
  v_status text;
  v_events_counted boolean;
  v_existing_season_id text;
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
  if not exists (select 1 from public.teams where id = v_home_id)
     or not exists (select 1 from public.teams where id = v_away_id) then
    raise exception 'One or both teams do not exist';
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

  select season_id
    into v_existing_season_id
  from public.matches
  where id = v_id;

  if found and v_existing_season_id <> v_season_id then
    raise exception 'A match cannot be moved to another season';
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
-- 6. SAFE TEAM DELETION + PLAYER ARCHIVE/RESTORE
-- ------------------------------------------------------------
create or replace function public.delete_team(p_team_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
  v_event record;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete teams' using errcode = '42501';
  end if;

  if not exists (select 1 from public.teams where id = p_team_id) then
    raise exception 'Team not found';
  end if;

  perform pg_advisory_xact_lock(748291);

  for v_match in
    select id, events_counted
    from public.matches
    where home_id = p_team_id or away_id = p_team_id
  loop
    if v_match.events_counted then
      for v_event in
        select player_id, event_type
        from public.match_events
        where match_id = v_match.id
      loop
        update public.players
           set goals = greatest(0, goals - case when v_event.event_type = 'goal' then 1 else 0 end),
               yellow = greatest(0, yellow - case when v_event.event_type = 'yellow' then 1 else 0 end),
               red = greatest(0, red - case when v_event.event_type = 'red' then 1 else 0 end)
         where id = v_event.player_id;
      end loop;
    end if;
  end loop;

  -- Remove events before the team cascade so the history-protection
  -- policy on players cannot block the cascade.
  delete from public.match_events
  where match_id in (
    select id
    from public.matches
    where home_id = p_team_id or away_id = p_team_id
  );

  delete from public.teams where id = p_team_id;
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

revoke execute on function public.replace_match_events(text, jsonb) from public, anon;
revoke execute on function public.delete_match(text) from public, anon;
revoke execute on function public.save_match(jsonb, jsonb) from public, anon;
revoke execute on function public.delete_team(text) from public, anon;
revoke execute on function public.archive_player(text) from public, anon;
revoke execute on function public.restore_player(text) from public, anon;
grant execute on function public.replace_match_events(text, jsonb) to authenticated;
grant execute on function public.delete_match(text) to authenticated;
grant execute on function public.save_match(jsonb, jsonb) to authenticated;
grant execute on function public.delete_team(text) to authenticated;
grant execute on function public.archive_player(text) to authenticated;
grant execute on function public.restore_player(text) to authenticated;

-- ------------------------------------------------------------
-- 7. FULL IMPORT PRESERVES PLAYER ARCHIVE STATE
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

  perform pg_advisory_xact_lock(748291);

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
end;
$$;

revoke execute on function public.replace_all_data(jsonb) from public, anon;
grant execute on function public.replace_all_data(jsonb) to authenticated;

notify pgrst, 'reload schema';
