-- ============================================================
--  KickOff Division — soft delete + restore migration
--  Teams, matches and seasons are moved to a trash instead of
--  being destroyed, and can be restored with totals intact.
--
--  Run this after audit-log-migration.sql, in
--  Supabase -> SQL Editor -> New query -> Run.
--  Apply to development first, then production. Safe to re-run.
--
--  What changes:
--    * teams / matches / seasons gain deleted_at.
--    * RLS hides trashed rows from everyone, including admins, so the
--      app never shows them; list_deleted() exposes them to admins.
--    * delete_team / delete_match / delete_season stamp deleted_at and
--      reverse player totals; restore_* clear it and re-apply totals.
--    * Trashed rows keep their players, events and foreign keys, so a
--      restore is exact.
-- ============================================================

-- ------------------------------------------------------------
-- 1. COLUMNS
-- ------------------------------------------------------------
alter table public.teams add column if not exists deleted_at timestamptz;
alter table public.matches add column if not exists deleted_at timestamptz;
alter table public.seasons add column if not exists deleted_at timestamptz;

create index if not exists teams_deleted_idx
  on public.teams (deleted_at) where deleted_at is not null;

create index if not exists matches_deleted_idx
  on public.matches (deleted_at) where deleted_at is not null;

create index if not exists seasons_deleted_idx
  on public.seasons (deleted_at) where deleted_at is not null;

create index if not exists matches_home_idx on public.matches (home_id);
create index if not exists matches_away_idx on public.matches (away_id);
create index if not exists match_events_match_idx on public.match_events (match_id);

-- ------------------------------------------------------------
-- 2. RLS: TRASHED ROWS ARE INVISIBLE
-- ------------------------------------------------------------
drop policy if exists seasons_select_all on public.seasons;
create policy seasons_select_all on public.seasons
  for select to anon, authenticated
  using (deleted_at is null);

drop policy if exists seasons_update_admin on public.seasons;
create policy seasons_update_admin on public.seasons
  for update to authenticated
  using (public.is_admin() and deleted_at is null)
  with check (public.is_admin() and deleted_at is null);

drop policy if exists teams_select_all on public.teams;
create policy teams_select_all on public.teams
  for select to anon, authenticated
  using (deleted_at is null);

drop policy if exists teams_update_admin on public.teams;
create policy teams_update_admin on public.teams
  for update to authenticated
  using (public.is_admin() and deleted_at is null)
  with check (public.is_admin() and deleted_at is null);

-- Players follow their club: hiding a team hides its squad.
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

drop policy if exists matches_update_admin on public.matches;
create policy matches_update_admin on public.matches
  for update to authenticated
  using (public.is_admin() and deleted_at is null and public.is_active_season(season_id))
  with check (public.is_admin() and deleted_at is null and public.is_active_season(season_id));

-- Events follow their fixture.
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

-- ------------------------------------------------------------
-- 3. DELETE = MOVE TO TRASH
-- ------------------------------------------------------------
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
  v_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete matches' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select events_counted, season_id, deleted_at
    into v_counted, v_season_id, v_deleted_at
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
  v_match record;
  v_event record;
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

  -- Reverse totals for fixtures that are visible right now. Trashed
  -- fixtures were already reversed when they were deleted.
  for v_match in
    select id, events_counted
    from public.matches
    where (home_id = p_team_id or away_id = p_team_id)
      and deleted_at is null
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

  -- Events and players stay in place: the RLS policies above hide them
  -- while the club is in the trash, and a restore brings them back.
  update public.teams set deleted_at = now() where id = p_team_id;
end;
$$;

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

-- ------------------------------------------------------------
-- 4. RESTORE
-- ------------------------------------------------------------
create or replace function public.restore_match(p_match_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_counted boolean;
  v_season_id text;
  v_home_id text;
  v_away_id text;
  v_deleted_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only admins can restore matches' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select events_counted, season_id, home_id, away_id, deleted_at
    into v_counted, v_season_id, v_home_id, v_away_id, v_deleted_at
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

  update public.matches set deleted_at = null where id = p_match_id;

  if v_counted then
    for v_event in
      select player_id, event_type
      from public.match_events
      where match_id = p_match_id
    loop
      update public.players
         set goals = goals + case when v_event.event_type = 'goal' then 1 else 0 end,
             yellow = yellow + case when v_event.event_type = 'yellow' then 1 else 0 end,
             red = red + case when v_event.event_type = 'red' then 1 else 0 end
       where id = v_event.player_id;
    end loop;
  end if;
end;
$$;

create or replace function public.restore_team(p_team_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
  v_event record;
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

  update public.teams set deleted_at = null where id = p_team_id;

  -- Re-apply totals only for fixtures this restore makes visible again.
  for v_match in
    select id, events_counted
    from public.matches
    where (home_id = p_team_id or away_id = p_team_id)
      and deleted_at is null
  loop
    if v_match.events_counted then
      for v_event in
        select player_id, event_type
        from public.match_events
        where match_id = v_match.id
      loop
        update public.players
           set goals = goals + case when v_event.event_type = 'goal' then 1 else 0 end,
               yellow = yellow + case when v_event.event_type = 'yellow' then 1 else 0 end,
               red = red + case when v_event.event_type = 'red' then 1 else 0 end
         where id = v_event.player_id;
      end loop;
    end if;
  end loop;
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

-- ------------------------------------------------------------
-- 5. TRASH LISTING (admin only)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 6. EXISTING RPCs LEARN ABOUT THE TRASH
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

  select season_id, deleted_at
    into v_existing_season_id, v_existing_deleted_at
  from public.matches
  where id = v_id;

  if found and v_existing_deleted_at is not null then
    raise exception 'This match is in the recently deleted list; restore it first';
  end if;
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

  perform pg_advisory_xact_lock(748291);

  select events_counted, season_id
    into v_counted, v_season_id
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

-- ------------------------------------------------------------
-- 6b. AUDIT LOG: LABEL SOFT DELETES AND RESTORES
--     deleted_at changes are plain UPDATEs at the SQL level; relabel
--     them so the activity log still reads "Deleted" / "Restored".
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 7. GRANTS
-- ------------------------------------------------------------
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

notify pgrst, 'reload schema';
