-- ------------------------------------------------------------
-- KickOff Division - merge import with a diff preview (roadmap H)
-- ------------------------------------------------------------
-- replace_all_data() is the disaster-recovery path: one transaction, but it
-- deletes everything first. This migration adds a second, non-destructive
-- import:
--
--   * import_preview(payload, remove_missing) compares a backup with the live
--     data and returns per-table added/changed/removed counts plus a capped
--     entity list. It never writes.
--   * import_merge(payload, idempotency_key, remove_missing, expected_checksum)
--     upserts by id in one transaction. Without remove_missing it only inserts
--     and updates. With it, missing rows are soft-deleted (seasons/teams/
--     matches), deactivated (players) or removed when they belong to an
--     imported match (events).
--   * import_runs stores the SHA-256 checksum and the idempotency key, so a
--     retried upload returns the stored result instead of applying twice.
--   * For the nullable match text fields (datetime, venue, scorers_text), a
--     stored NULL and a payload '' mean the same "no value": the preview
--     normalises both sides and the merge writes NULL back.
--
-- replace_all_data() stays available for disaster recovery. The UI keeps it
-- behind MFA and a typed confirmation.
--
-- Additive and re-runnable. Assumes the task I (team-icons-migration.sql) and
-- task L (arabic-names-and-license-migration.sql) schema is in place.
--
-- Run in the Supabase SQL Editor for development, then production.
-- ------------------------------------------------------------

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

notify pgrst, 'reload schema';
