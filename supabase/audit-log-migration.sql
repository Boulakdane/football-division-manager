-- ============================================================
--  KickOff Division — audit log migration
--  Records who changed what, when, with before/after snapshots.
--
--  Run this after integrity-migration.sql, in
--  Supabase -> SQL Editor -> New query -> Run.
--  Apply to development first, then production. Safe to re-run.
--
--  The log is append-only for clients: there is no INSERT, UPDATE
--  or DELETE grant, and RLS is enabled with no policy. Only the
--  SECURITY DEFINER trigger and list_audit_log() touch it.
-- ============================================================

-- ------------------------------------------------------------
-- 1. AUDIT TABLE
-- ------------------------------------------------------------
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

-- Clients cannot read or write the table directly; only the RPC below.
revoke all on public.audit_log from anon, authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

-- ------------------------------------------------------------
-- 2. ROW TRIGGER
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

-- ------------------------------------------------------------
-- 3. READ RPC (admin only)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 4. FULL IMPORT LOGS ONE ENTRY
--    replace_all_data() deletes and reinserts every row; without
--    this flag the log would gain thousands of entries per import.
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

  -- Transaction-local: every row trigger below stays quiet.
  perform set_config('app.audit_skip', '1', true);

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
