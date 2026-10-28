-- ------------------------------------------------------------
-- KickOff Division - team icons (roadmap item I, team-crest half)
-- ------------------------------------------------------------
-- Adds one optional column, teams.icon, holding a small club crest as a data
-- URL. Inline storage is deliberate:
--
--   * the strict CSP stays `img-src 'self' data:`: no bucket, no new origin;
--   * the browser downscales and re-encodes the chosen file before saving,
--     which also strips EXIF metadata, and the check constraint only accepts
--     PNG/JPEG/WebP data URLs (no SVG, no http(s) hotlinking);
--   * a JSON backup or a CSV export carries the image, so restoring into
--     another project does not leave a URL pointing at the old one;
--   * the app keeps working without a backend (local demo mode).
--
-- Also re-creates list_deleted() (the trash dialog shows the crest) and
-- replace_all_data() (a full import restores it). Additive, and safe to
-- re-run.
--
-- Assumes the task L migration (arabic-names-and-license-migration.sql) has
-- been applied: replace_all_data() also restores player_profiles.
--
-- Run in the Supabase SQL Editor for development, then production.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. THE COLUMN
-- ------------------------------------------------------------
alter table public.teams add column if not exists icon text;

do $$
begin
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

-- ------------------------------------------------------------
-- 2. TRASH: list_deleted() returns the crest
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

revoke execute on function public.list_deleted() from public, anon;
grant execute on function public.list_deleted() to authenticated;

-- ------------------------------------------------------------
-- 3. IMPORT: replace_all_data() restores the crest
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

notify pgrst, 'reload schema';
