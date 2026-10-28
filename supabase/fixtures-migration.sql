-- ============================================================
--  KickOff Division - fixture plan and reschedule (roadmap F)
-- ============================================================
-- The fixture generator in the browser builds a complete round-robin plan
-- (pairings, dates, venues) and shows it to the admin before anything is
-- written. This migration adds the two atomic write paths it needs:
--
--   * create_fixtures(payload) validates the whole plan and inserts every
--     fixture in one transaction. A bad row therefore never leaves half a
--     schedule behind.
--   * shift_fixture_rounds(...) moves the dates of the unplayed fixtures in
--     one division from a given round onwards, which is what a postponement
--     needs.
--
-- Both are admin-only, only write the active season, derive the division from
-- the two clubs (never from the payload), and record one summary activity-log
-- row instead of one row per fixture.
--
-- Run this after soft-delete-migration.sql, in
-- Supabase -> SQL Editor -> New query -> Run.
-- Apply to development first, then production. Safe to re-run.
-- ============================================================

create or replace function public.create_fixtures(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id text;
  v_division_id text;
  v_replace boolean;
  v_matches jsonb;
  v_count int;
  v_rounds int;
  v_removed int := 0;
  v_actor_email text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can generate fixtures' using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Fixture plan must be a JSON object';
  end if;

  v_season_id := nullif(btrim(coalesce(p_payload->>'season_id', '')), '');
  if v_season_id is null or not public.is_active_season(v_season_id) then
    raise exception 'Fixtures can only be generated in the active season' using errcode = '42501';
  end if;

  v_matches := coalesce(p_payload->'matches', 'null'::jsonb);
  if jsonb_typeof(v_matches) <> 'array' or jsonb_array_length(v_matches) = 0 then
    raise exception 'The fixture plan needs at least one match';
  end if;
  if jsonb_array_length(v_matches) > 5000 then
    raise exception 'A fixture plan can contain at most 5000 matches';
  end if;

  v_replace := coalesce((p_payload->>'replace_existing')::boolean, false);

  -- Every row must describe one usable fixture.
  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as x(round int, home_id text, away_id text)
    where nullif(btrim(coalesce(x.home_id, '')), '') is null
       or nullif(btrim(coalesce(x.away_id, '')), '') is null
       or btrim(x.home_id) = btrim(x.away_id)
       or coalesce(x.round, 0) < 1
       or coalesce(x.round, 0) > 1000
  ) then
    raise exception 'Every fixture needs two different teams and a round between 1 and 1000';
  end if;

  -- Optional client ids must be unique and fit the matches.id constraint.
  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as x(id text)
    where nullif(btrim(coalesce(x.id, '')), '') is not null
      and length(btrim(x.id)) > 100
  ) then
    raise exception 'A fixture id can be at most 100 characters';
  end if;

  if exists (
    select 1
    from (
      select btrim(x.id) as id
      from jsonb_to_recordset(v_matches) as x(id text)
      where nullif(btrim(coalesce(x.id, '')), '') is not null
    ) ids
    group by ids.id
    having count(*) > 1
  ) then
    raise exception 'Every fixture id must be unique';
  end if;

  -- The browser sends local wall-clock time from a datetime-local input.
  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as x(datetime text)
    where nullif(btrim(coalesce(x.datetime, '')), '') is not null
      and btrim(x.datetime) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
  ) then
    raise exception 'Every fixture date must use YYYY-MM-DDTHH:MM';
  end if;

  begin
    if exists (
      select 1
      from (
        select btrim(x.datetime) as dt
        from jsonb_to_recordset(v_matches) as x(datetime text)
        where btrim(x.datetime) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
      ) d
      where to_char(
              to_timestamp(d.dt, 'YYYY-MM-DD"T"HH24:MI'),
              'YYYY-MM-DD"T"HH24:MI'
            ) <> d.dt
    ) then
      raise exception 'Every fixture date must be a real calendar date and time';
    end if;
  exception
    when datetime_field_overflow or invalid_datetime_format then
      raise exception 'Every fixture date must be a real calendar date and time';
  end;

  -- Teams must exist, be out of the trash, and share one division. The
  -- division is taken from the clubs, never from the payload.
  select t.division_id into v_division_id
  from public.teams t
  where t.id = btrim(v_matches->0->>'home_id')
    and t.deleted_at is null;

  if v_division_id is null then
    raise exception 'The first fixture needs a known home team';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as x(home_id text, away_id text)
    left join public.teams h on h.id = btrim(x.home_id) and h.deleted_at is null
    left join public.teams a on a.id = btrim(x.away_id) and a.deleted_at is null
    where h.id is null
       or a.id is null
       or h.division_id <> v_division_id
       or a.division_id <> v_division_id
  ) then
    raise exception 'Every fixture needs two known teams from one division';
  end if;

  -- A pairing may appear once (single round-robin) or twice with one home
  -- game each (double round-robin). Three legs or two identical legs are a
  -- broken plan.
  if exists (
    select 1
    from (
      select least(btrim(x.home_id), btrim(x.away_id)) as a,
             greatest(btrim(x.home_id), btrim(x.away_id)) as b,
             count(*) as n,
             count(distinct btrim(x.home_id)) as homes
      from jsonb_to_recordset(v_matches) as x(home_id text, away_id text)
      group by 1, 2
    ) p
    where p.n > 2
       or (p.n = 2 and p.homes <> 2)
  ) then
    raise exception 'A pairing can appear at most twice, once with each home team';
  end if;

  -- The id may also exist in the trash: the primary key would reject it.
  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as x(id text)
    join public.matches m on m.id = btrim(x.id)
    where nullif(btrim(coalesce(x.id, '')), '') is not null
  ) then
    raise exception 'A fixture id in the plan already exists';
  end if;

  -- Same lock as save_match() and the imports: two admin tabs cannot create
  -- overlapping fixtures at the same time.
  perform pg_advisory_xact_lock(748291);

  if v_replace then
    -- Replacing a schedule must never erase a result, an event, a scorer list
    -- or a live match. Only untouched SCHEDULED rows may go to the trash.
    if exists (
      select 1
      from public.matches m
      where m.season_id = v_season_id
        and m.division_id = v_division_id
        and m.deleted_at is null
        and (
          m.status <> 'SCHEDULED'
          or m.home_score <> 0
          or m.away_score <> 0
          or nullif(btrim(coalesce(m.scorers_text, '')), '') is not null
          or exists (
            select 1 from public.match_events e where e.match_id = m.id
          )
        )
    ) then
      raise exception 'Only unplayed, empty fixtures can be replaced';
    end if;

    update public.matches
       set deleted_at = now()
     where season_id = v_season_id
       and division_id = v_division_id
       and deleted_at is null;
    get diagnostics v_removed = row_count;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_matches) as x(home_id text, away_id text)
    join public.matches m
      on m.season_id = v_season_id
     and m.division_id = v_division_id
     and m.deleted_at is null
     and least(m.home_id, m.away_id) = least(btrim(x.home_id), btrim(x.away_id))
     and greatest(m.home_id, m.away_id) = greatest(btrim(x.home_id), btrim(x.away_id))
  ) then
    raise exception 'This pairing already has a fixture in the season';
  end if;

  select count(*), count(distinct x.round)
    into v_count, v_rounds
  from jsonb_to_recordset(v_matches) as x(round int);

  -- One summary audit row instead of one chained row per fixture.
  perform set_config('app.audit_skip', '1', true);

  insert into public.matches (
    id, season_id, division_id, round, home_id, away_id,
    home_score, away_score, status, datetime, venue, events_counted
  )
  select coalesce(
           nullif(btrim(x.id), ''),
           'm_' || replace(gen_random_uuid()::text, '-', '')
         ),
         v_season_id,
         v_division_id,
         x.round,
         btrim(x.home_id),
         btrim(x.away_id),
         0,
         0,
         'SCHEDULED',
         nullif(btrim(x.datetime), ''),
         nullif(btrim(x.venue), ''),
         true
  from jsonb_to_recordset(v_matches) as x(
    id text, round int, home_id text, away_id text, datetime text, venue text
  );

  perform set_config('app.audit_skip', '', true);

  select u.email into v_actor_email from auth.users u where u.id = auth.uid();

  insert into public.audit_log (
    actor_id, actor_email, action, entity, entity_id, season_id, summary
  )
  values (
    auth.uid(),
    v_actor_email,
    'IMPORT',
    'matches',
    null,
    v_season_id,
    format(
      'Generated %s fixtures over %s rounds in %s%s',
      v_count,
      v_rounds,
      v_division_id,
      case when v_removed > 0 then format(' (replaced %s)', v_removed) else '' end
    )
  );

  return jsonb_build_object(
    'created', v_count,
    'removed', v_removed,
    'rounds', v_rounds,
    'divisionId', v_division_id,
    'seasonId', v_season_id
  );
end;
$$;

revoke execute on function public.create_fixtures(jsonb) from public, anon;
grant execute on function public.create_fixtures(jsonb) to authenticated;

create or replace function public.shift_fixture_rounds(
  p_season_id text,
  p_division_id text,
  p_from_round int,
  p_days int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id text := nullif(btrim(coalesce(p_season_id, '')), '');
  v_division_id text := nullif(btrim(coalesce(p_division_id, '')), '');
  v_from int := coalesce(p_from_round, 0);
  v_days int := coalesce(p_days, 0);
  v_count int := 0;
  v_first text;
  v_last text;
  v_actor_email text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can reschedule fixtures' using errcode = '42501';
  end if;

  if v_season_id is null or not public.is_active_season(v_season_id) then
    raise exception 'Fixtures can only be rescheduled in the active season' using errcode = '42501';
  end if;

  if v_division_id is null
     or not exists (select 1 from public.divisions where id = v_division_id) then
    raise exception 'Choose a known division';
  end if;

  if v_from < 1 or v_from > 1000 then
    raise exception 'The starting round must be between 1 and 1000';
  end if;

  if v_days = 0 or abs(v_days) > 365 then
    raise exception 'The date shift must be between 1 and 365 days';
  end if;

  perform pg_advisory_xact_lock(748291);

  if exists (
    select 1
    from public.matches m
    where m.season_id = v_season_id
      and m.division_id = v_division_id
      and m.round >= v_from
      and m.deleted_at is null
      and (
        m.status <> 'SCHEDULED'
        or m.home_score <> 0
        or m.away_score <> 0
        or nullif(btrim(coalesce(m.scorers_text, '')), '') is not null
        or exists (
          select 1 from public.match_events e where e.match_id = m.id
        )
      )
  ) then
    raise exception 'Only unplayed fixtures can be rescheduled';
  end if;

  if exists (
    select 1
    from public.matches m
    where m.season_id = v_season_id
      and m.division_id = v_division_id
      and m.round >= v_from
      and m.deleted_at is null
      and m.datetime is not null
      and btrim(m.datetime) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
  ) then
    raise exception 'A fixture in this range has an invalid date';
  end if;

  -- One summary audit row instead of one chained row per fixture.
  perform set_config('app.audit_skip', '1', true);

  update public.matches m
     set datetime = to_char(
           to_timestamp(m.datetime, 'YYYY-MM-DD"T"HH24:MI')::timestamp
             + make_interval(days => v_days),
           'YYYY-MM-DD"T"HH24:MI'
         )
   where m.season_id = v_season_id
     and m.division_id = v_division_id
     and m.round >= v_from
     and m.deleted_at is null
     and m.datetime is not null;
  get diagnostics v_count = row_count;

  perform set_config('app.audit_skip', '', true);

  select min(m.datetime), max(m.datetime)
    into v_first, v_last
  from public.matches m
  where m.season_id = v_season_id
    and m.division_id = v_division_id
    and m.round >= v_from
    and m.deleted_at is null
    and m.datetime is not null;

  select u.email into v_actor_email from auth.users u where u.id = auth.uid();

  insert into public.audit_log (
    actor_id, actor_email, action, entity, entity_id, season_id, summary
  )
  values (
    auth.uid(),
    v_actor_email,
    'IMPORT',
    'matches',
    null,
    v_season_id,
    format(
      'Moved rounds %s onwards by %s day(s) in %s (%s fixtures)',
      v_from,
      v_days,
      v_division_id,
      v_count
    )
  );

  return jsonb_build_object(
    'shifted', v_count,
    'days', v_days,
    'fromRound', v_from,
    'divisionId', v_division_id,
    'firstDate', v_first,
    'lastDate', v_last
  );
end;
$$;

revoke execute on function public.shift_fixture_rounds(text, text, int, int) from public, anon;
grant execute on function public.shift_fixture_rounds(text, text, int, int) to authenticated;

-- Ask PostgREST to pick up the new functions immediately.
notify pgrst, 'reload schema';
