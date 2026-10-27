-- ------------------------------------------------------------
-- KickOff Division - bilingual names, licence number, birth date (task L)
-- ------------------------------------------------------------
-- Adds:
--
--   * teams.name_ar / players.name_ar - an optional Arabic name; the Latin
--     name stays required and is still the sort/search key;
--   * public.player_profiles - an admin-only row per player holding the
--     optional licence number and birth date. It is a separate table because
--     public.players is readable by anonymous visitors (players_select_all),
--     so personal data cannot live there;
--   * a partial unique index on the trimmed, upper-cased licence number, so a
--     licence can be blank but never shared by two players;
--   * add_players() and replace_all_data() understand both new names plus the
--     profile fields, and v_player_stats exposes name_ar but not the personal
--     columns.
--
-- Every column is optional, so existing rows stay valid. Additive and safe to
-- re-run. It does not delete or rewrite league data.
--
-- Run in the Supabase SQL Editor for development, then production. It assumes
-- the divisions migration (public.divisions, teams.division_id) has been
-- applied.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. OPTIONAL ARABIC NAMES (public data)
-- ------------------------------------------------------------
alter table public.teams add column if not exists name_ar text;
alter table public.players add column if not exists name_ar text;

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
end $$;

-- ------------------------------------------------------------
-- 2. ADMIN-ONLY PLAYER PROFILES (licence number, birth date)
-- ------------------------------------------------------------
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

revoke all on public.player_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.player_profiles to authenticated;

alter table public.player_profiles enable row level security;

drop policy if exists player_profiles_admin_all on public.player_profiles;
create policy player_profiles_admin_all on public.player_profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- 3. v_player_stats EXPOSES THE ARABIC NAME ONLY
-- ------------------------------------------------------------
-- The view gains a column, and CREATE OR REPLACE cannot insert one in the
-- middle, so it is recreated. Nothing else depends on it and it stores no data.
drop view if exists public.v_player_stats;

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

revoke all on public.v_player_stats from public, anon, authenticated;
grant select on public.v_player_stats to anon, authenticated;

-- ------------------------------------------------------------
-- 4. add_players() STORES THE NEW FIELDS
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
-- 5. replace_all_data() RESTORES THE NEW FIELDS
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

  insert into public.teams (id, name, name_ar, code, color, division_id)
  select t.id,
         t.name,
         nullif(btrim(coalesce(t.name_ar, '')), ''),
         coalesce(t.code, 'TBD'),
         coalesce(t.color, '#16a34a'),
         coalesce(t.division_id, 'd1')
  from jsonb_to_recordset(v_teams) as t(
    id text,
    name text,
    name_ar text,
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
