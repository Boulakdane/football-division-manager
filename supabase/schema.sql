-- ============================================================
--  KickOff Division — Supabase schema
--  Run this once in Supabase → SQL Editor → New query → Run.
--  Safe to re-run: tables use IF NOT EXISTS, policies are dropped
--  and recreated, and the seed rows use ON CONFLICT DO NOTHING.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ROLES + PROFILES
-- ------------------------------------------------------------
do $$
begin
  create type public.app_role as enum ('admin', 'viewer');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role public.app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

-- Every new Supabase Auth user gets a read-only profile automatically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for accounts created before this schema existed.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Helper used by the write policies below. SECURITY DEFINER avoids
-- recursive RLS checks on public.profiles.
create table if not exists public.security_settings (
  id boolean primary key default true check (id),
  require_admin_mfa boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.security_settings (id, require_admin_mfa)
values (true, false)
on conflict (id) do nothing;

alter table public.security_settings enable row level security;
revoke all on public.security_settings from anon, authenticated;

create or replace function public.admin_mfa_required()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select require_admin_mfa from public.security_settings where id),
    false
  );
$$;

grant execute on function public.admin_mfa_required() to anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  )
  and (
    not public.admin_mfa_required()
    or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- Changing the MFA requirement needs a verified factor in this session.
create or replace function public.set_require_admin_mfa(p_required boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required boolean := coalesce(p_required, false);
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Only admins can change the MFA requirement' using errcode = '42501';
  end if;

  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
    raise exception 'Verify your authenticator app before changing MFA settings'
      using errcode = '42501';
  end if;

  update public.security_settings
     set require_admin_mfa = v_required,
         updated_at = now()
   where id;

  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log (actor_id, actor_email, action, entity, summary)
    values (
      auth.uid(),
      (select u.email from auth.users u where u.id = auth.uid()),
      'SECURITY',
      'security',
      case
        when v_required then 'Admin two-factor requirement enabled'
        else 'Admin two-factor requirement disabled'
      end
    );
  end if;
end;
$$;

revoke execute on function public.set_require_admin_mfa(boolean) from public, anon;
grant execute on function public.set_require_admin_mfa(boolean) to authenticated;

-- ------------------------------------------------------------
-- 2. SEASONS
-- ------------------------------------------------------------
create table if not exists public.seasons (
  id text primary key,
  name text not null,
  start_date date,
  end_date date,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kickoff_seasons_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_seasons_name_length check (length(btrim(name)) between 1 and 100),
  constraint kickoff_seasons_dates_order check (start_date is null or end_date is null or start_date <= end_date)
);

-- Keep the existing default season (or create it) without changing
-- which season is already active on a re-run.
insert into public.seasons (id, name, start_date, end_date, is_active)
values ('s1', '2026 Season', null, null, false)
on conflict (id) do nothing;

-- Repair multiple active seasons before enforcing the unique index.
update public.seasons s
set is_active = false
where s.is_active = true
  and s.id <> (
    select id from public.seasons
    where is_active = true
    order by created_at desc, id
    limit 1
  );

-- If every season is archived, reactivate the oldest one.
update public.seasons
set is_active = true
where id = (
  select id from public.seasons order by created_at asc, id asc limit 1
)
and not exists (select 1 from public.seasons where is_active = true);

create unique index if not exists seasons_one_active_idx
  on public.seasons (is_active)
  where is_active;

-- Used by the write policies and RPCs to keep archived seasons read-only.
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
-- 3. LEAGUE TABLES
-- ------------------------------------------------------------
create table if not exists public.teams (
  id text primary key,
  name text not null,
  code text not null default 'TBD',
  color text not null default '#16a34a',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kickoff_teams_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_teams_name_length check (length(btrim(name)) between 1 and 100),
  constraint kickoff_teams_code_length check (length(btrim(code)) between 1 and 8),
  constraint kickoff_teams_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$')
);

create table if not exists public.players (
  id text primary key,
  team_id text not null references public.teams (id) on delete cascade,
  name text not null,
  pos text not null default 'MID' check (pos in ('GK', 'DEF', 'MID', 'FWD')),
  num int not null default 10,
  goals int not null default 0,
  yellow int not null default 0,
  red int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint kickoff_players_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_players_name_length check (length(btrim(name)) between 1 and 100),
  constraint kickoff_players_num_range check (num between 0 and 999),
  constraint kickoff_players_totals_range check (goals >= 0 and yellow >= 0 and red >= 0)
);

alter table public.players
  add column if not exists is_active boolean not null default true;

create table if not exists public.matches (
  id text primary key,
  season_id text not null references public.seasons (id) on delete restrict,
  round int not null default 1,
  home_id text not null references public.teams (id) on delete cascade,
  away_id text not null references public.teams (id) on delete cascade,
  home_score int not null default 0,
  away_score int not null default 0,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'LIVE', 'FINISHED')),
  datetime text,
  venue text,
  scorers_text text,
  events_counted boolean not null default true,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kickoff_matches_id_not_blank check (length(btrim(id)) between 1 and 100),
  constraint kickoff_matches_round_range check ("round" between 1 and 1000),
  constraint kickoff_matches_scores_range check (home_score between 0 and 999 and away_score between 0 and 999),
  constraint kickoff_matches_distinct_teams check (home_id <> away_id)
);

-- Upgrade a matches table created before seasons existed.
alter table public.matches add column if not exists season_id text;

-- Put any legacy fixture into the active season (or the oldest one).
update public.matches
set season_id = coalesce(
  (select id from public.seasons where is_active order by created_at desc limit 1),
  (select id from public.seasons order by created_at asc limit 1)
)
where season_id is null
   or season_id not in (select id from public.seasons);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'matches_season_id_fkey'
      and conrelid = 'public.matches'::regclass
  ) then
    alter table public.matches
      add constraint matches_season_id_fkey
      foreign key (season_id) references public.seasons (id) on delete restrict;
  end if;
end $$;

alter table public.matches alter column season_id set not null;

-- Existing fixtures already contributed to the manually maintained player
-- totals. Keep their events out of the counters to avoid double-counting;
-- new fixtures default to events_counted = true.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'matches'
      and column_name = 'events_counted'
  ) then
    alter table public.matches add column events_counted boolean not null default true;
    update public.matches set events_counted = false;
  end if;
end $$;

-- Goals and cards with a minute. Player totals remain the aggregate
-- counters on public.players; the event functions below keep them in sync.
create table if not exists public.match_events (
  id text primary key,
  match_id text not null references public.matches (id) on delete cascade,
  team_id text not null references public.teams (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  event_type text not null check (event_type in ('goal', 'yellow', 'red')),
  minute int not null check (minute between 1 and 130),
  created_at timestamptz not null default now()
);

create index if not exists match_events_match_id_idx
  on public.match_events (match_id);

create index if not exists match_events_player_id_idx
  on public.match_events (player_id);

-- Trash columns for projects created before soft delete existed.
alter table public.seasons add column if not exists deleted_at timestamptz;
alter table public.teams add column if not exists deleted_at timestamptz;
alter table public.matches add column if not exists deleted_at timestamptz;

create index if not exists seasons_deleted_idx
  on public.seasons (deleted_at) where deleted_at is not null;

create index if not exists teams_deleted_idx
  on public.teams (deleted_at) where deleted_at is not null;

create index if not exists matches_deleted_idx
  on public.matches (deleted_at) where deleted_at is not null;

create index if not exists matches_home_id_idx on public.matches (home_id);
create index if not exists matches_away_id_idx on public.matches (away_id);

-- ------------------------------------------------------------
-- 4. GRANTS (RLS still decides what each role may do)
-- ------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.seasons, public.teams, public.players, public.matches, public.match_events to anon, authenticated;
grant insert, update, delete on public.seasons, public.players to authenticated;
grant insert, update on public.teams, public.matches to authenticated;
-- Team/match deletion and match-event writes are RPC-only so aggregate
-- totals cannot drift. The security-definer RPCs retain owner privileges.
revoke delete on public.teams, public.matches from authenticated;
revoke insert, update, delete on public.match_events from authenticated;
revoke insert, update, delete on public.match_events from anon;
grant select on public.profiles to authenticated;

-- ------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.seasons enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.matches enable row level security;
alter table public.match_events enable row level security;

-- Profiles: users see their own role; admins see everyone.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (auth.uid() = id);

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin());

-- Seasons: public read, admin write.
-- Trashed rows are invisible to everyone, admins included; admins find
-- them through list_deleted() and bring them back with restore_*().
drop policy if exists seasons_select_all on public.seasons;
create policy seasons_select_all on public.seasons
  for select to anon, authenticated using (deleted_at is null);

drop policy if exists seasons_insert_admin on public.seasons;
create policy seasons_insert_admin on public.seasons
  for insert to authenticated with check (public.is_admin());

drop policy if exists seasons_update_admin on public.seasons;
create policy seasons_update_admin on public.seasons
  for update to authenticated
  using (public.is_admin() and deleted_at is null)
  with check (public.is_admin() and deleted_at is null);

drop policy if exists seasons_delete_admin on public.seasons;
create policy seasons_delete_admin on public.seasons
  for delete to authenticated using (public.is_admin());

-- Teams: public read, admin write.
drop policy if exists teams_select_all on public.teams;
create policy teams_select_all on public.teams
  for select to anon, authenticated using (deleted_at is null);

drop policy if exists teams_insert_admin on public.teams;
create policy teams_insert_admin on public.teams
  for insert to authenticated with check (public.is_admin());

drop policy if exists teams_update_admin on public.teams;
create policy teams_update_admin on public.teams
  for update to authenticated
  using (public.is_admin() and deleted_at is null)
  with check (public.is_admin() and deleted_at is null);

-- Team deletion must go through delete_team() so opponent totals are
-- reversed before the club is moved to the trash. No direct DELETE policy
-- is created.
drop policy if exists teams_delete_admin on public.teams;

-- Players: public read, admin write. Trashed clubs take their squad with
-- them through this policy.
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

drop policy if exists players_insert_admin on public.players;
create policy players_insert_admin on public.players
  for insert to authenticated with check (public.is_admin());

drop policy if exists players_update_admin on public.players;
create policy players_update_admin on public.players
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

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

-- Matches: public read, admin write. Only the active season can be
-- written directly; archived seasons are read-only in the database.
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

drop policy if exists matches_insert_admin on public.matches;
create policy matches_insert_admin on public.matches
  for insert to authenticated
  with check (public.is_admin() and public.is_active_season(season_id));

drop policy if exists matches_update_admin on public.matches;
create policy matches_update_admin on public.matches
  for update to authenticated
  using (public.is_admin() and deleted_at is null and public.is_active_season(season_id))
  with check (public.is_admin() and deleted_at is null and public.is_active_season(season_id));

-- Match deletion must go through delete_match() so event contributions are
-- reversed atomically and the fixture moves to the trash. No direct DELETE
-- policy is created.
drop policy if exists matches_delete_admin on public.matches;

-- Match events: public read. A trashed fixture takes its events with it.
-- Writes are RPC-only so the cumulative player totals cannot be changed
-- without the matching event rows.
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

drop policy if exists match_events_insert_admin on public.match_events;
drop policy if exists match_events_update_admin on public.match_events;
drop policy if exists match_events_delete_admin on public.match_events;

-- ------------------------------------------------------------
-- 6. SEASON FUNCTIONS (atomic, admin-only)
-- ------------------------------------------------------------
create or replace function public.create_season(
  p_id text,
  p_name text,
  p_start_date date default null,
  p_end_date date default null
)
returns public.seasons
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create seasons' using errcode = '42501';
  end if;

  if p_id is null or btrim(p_id) = '' then
    raise exception 'Season id is required';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Season name is required';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date < p_start_date then
    raise exception 'End date must be on or after start date';
  end if;
  if exists (select 1 from public.seasons where id = p_id) then
    raise exception 'Season already exists';
  end if;

  update public.seasons set is_active = false where is_active = true;

  insert into public.seasons (id, name, start_date, end_date, is_active)
  values (p_id, btrim(p_name), p_start_date, p_end_date, true)
  returning * into v_season;

  return v_season;
end;
$$;

create or replace function public.activate_season(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can activate seasons' using errcode = '42501';
  end if;

  if not exists (select 1 from public.seasons where id = p_id) then
    raise exception 'Season not found';
  end if;

  update public.seasons set is_active = false where is_active = true;
  update public.seasons set is_active = true where id = p_id;
end;
$$;

grant execute on function public.create_season(text, text, date, date) to authenticated;
grant execute on function public.activate_season(text) to authenticated;

-- ------------------------------------------------------------
-- 6b. MATCH EVENT FUNCTIONS (atomic, admin-only)
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

revoke execute on function public.replace_match_events(text, jsonb) from public, anon;
revoke execute on function public.delete_match(text) from public, anon;
grant execute on function public.replace_match_events(text, jsonb) to authenticated;
grant execute on function public.delete_match(text) to authenticated;

-- ------------------------------------------------------------
-- 6c. ATOMIC MATCH + EVENTS SAVE
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

-- ------------------------------------------------------------
-- 6d. SAFE TEAM DELETION + PLAYER ARCHIVE/RESTORE
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

-- ------------------------------------------------------------
-- 6d-2. SOFT DELETE + RESTORE (admin only)
--    Trashed rows stay in the database with deleted_at set, so a
--    restore is exact. RLS hides them from every client.
-- ------------------------------------------------------------
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

revoke execute on function public.save_match(jsonb, jsonb) from public, anon;
revoke execute on function public.delete_team(text) from public, anon;
revoke execute on function public.archive_player(text) from public, anon;
revoke execute on function public.restore_player(text) from public, anon;
grant execute on function public.save_match(jsonb, jsonb) to authenticated;
grant execute on function public.delete_team(text) to authenticated;
grant execute on function public.archive_player(text) to authenticated;
grant execute on function public.restore_player(text) to authenticated;
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

-- ------------------------------------------------------------
-- 6e. ATOMIC FULL-DATA IMPORT (admin only)
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
-- 7. SEED DATA (optional — delete this block to start empty)
-- ------------------------------------------------------------
insert into public.teams (id, name, code, color) values
  ('t1', 'Spartan FC',        'SFC', '#3b82f6'),
  ('t2', 'Titan United',      'TTN', '#10b981'),
  ('t3', 'Phoenix Rovers',    'PHX', '#f59e0b'),
  ('t4', 'Vanguard Athletic', 'VNG', '#ef4444'),
  ('t5', 'Atlas Warriors',    'ATL', '#8b5cf6'),
  ('t6', 'Coastal Sharks',    'CSH', '#06b6d4')
on conflict (id) do nothing;

insert into public.players (id, team_id, name, pos, num, goals, yellow, red) values
  ('p1', 't1', 'David Silva',  'MID', 10, 5, 1, 0),
  ('p2', 't1', 'Carlos Ramos', 'FWD',  9, 7, 0, 0),
  ('p3', 't2', 'Ethan Hunt',   'FWD', 11, 4, 2, 0),
  ('p4', 't3', 'Leo Mendes',   'MID',  8, 6, 0, 0),
  ('p5', 't4', 'John Terry',   'DEF',  4, 1, 3, 1),
  ('p6', 't5', 'Omar Belaid',  'FWD',  7, 8, 1, 0),
  ('p7', 't5', 'Karim Ziani',  'MID',  6, 2, 2, 0),
  ('p8', 't6', 'Lucas Ferrao', 'FWD',  9, 3, 0, 0),
  ('p9', 't6', 'Sam Okafor',   'GK',   1, 0, 0, 0)
on conflict (id) do nothing;

insert into public.matches (id, season_id, round, home_id, away_id, home_score, away_score, status, datetime, venue, scorers_text) values
  ('m1', 's1', 1, 't1', 't2', 3, 1, 'FINISHED',  '2026-10-03T15:00', 'Main Field - Pitch 1',     'Carlos Ramos (2), David Silva (1) - Ethan Hunt (1)'),
  ('m2', 's1', 1, 't3', 't4', 2, 2, 'FINISHED',  '2026-10-03T17:30', 'Main Field - Pitch 2',     'Leo Mendes (2) - John Terry (1), K. Diaz (1)'),
  ('m3', 's1', 1, 't5', 't6', 1, 0, 'FINISHED',  '2026-10-04T16:00', 'Community Sports Complex', 'Omar Belaid (1)'),
  ('m4', 's1', 2, 't2', 't3', 0, 1, 'FINISHED',  '2026-10-10T15:30', 'United Arena',             'Leo Mendes (1)'),
  ('m5', 's1', 2, 't4', 't5', 2, 2, 'FINISHED',  '2026-10-11T18:00', 'Vanguard Ground',          'John Terry (1), R. Cole (1) - Omar Belaid (2)'),
  ('m6', 's1', 2, 't6', 't1', 1, 1, 'LIVE',      '2026-10-20T19:00', 'Shark Park',               'Lucas Ferrao (1) - Carlos Ramos (1)'),
  ('m7', 's1', 3, 't1', 't3', 0, 0, 'SCHEDULED', '2026-10-24T15:00', 'Main Field - Pitch 1',     ''),
  ('m8', 's1', 3, 't2', 't5', 0, 0, 'SCHEDULED', '2026-10-25T17:00', 'United Arena',             ''),
  ('m9', 's1', 3, 't4', 't6', 0, 0, 'SCHEDULED', '2026-10-25T19:30', 'Vanguard Ground',          '')
on conflict (id) do nothing;

-- Only seed events when the sample match/team/player relations still hold.
insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
select v.id, v.match_id, v.team_id, v.player_id, v.event_type, v.minute
from (values
  ('e1',  'm1', 't1', 'p2', 'goal',   23),
  ('e2',  'm1', 't1', 'p1', 'goal',   54),
  ('e3',  'm1', 't1', 'p2', 'goal',   71),
  ('e4',  'm1', 't2', 'p3', 'goal',   80),
  ('e5',  'm1', 't2', 'p3', 'yellow', 42),
  ('e6',  'm2', 't3', 'p4', 'goal',   12),
  ('e7',  'm2', 't3', 'p4', 'goal',   66),
  ('e8',  'm2', 't4', 'p5', 'goal',   33),
  ('e9',  'm2', 't4', 'p5', 'yellow', 58),
  ('e10', 'm3', 't5', 'p6', 'goal',   77)
) as v(id, match_id, team_id, player_id, event_type, minute)
where exists (
  select 1
  from public.matches m
  join public.players p on p.id = v.player_id and p.team_id = v.team_id
  where m.id = v.match_id
    and v.team_id in (m.home_id, m.away_id)
)
on conflict (id) do nothing;

-- ============================================================
-- 8. MAKE YOURSELF ADMIN
--    ️Sign up once in the app (Admin Login → Create account),
--    confirm your email if required, then run:
--
--    update public.profiles
--       set role = 'admin'
--     where email = 'you@example.com';
--
--    Log out and back in — write controls will appear.
-- ============================================================

-- ============================================================
-- 9. AUDIT LOG
--    Append-only history of league writes, readable by admins
--    through list_audit_log(). Existing projects run
--    supabase/audit-log-migration.sql instead of this file.
-- ============================================================

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

revoke all on public.audit_log from anon, authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

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

-- Ask PostgREST to pick up new tables/functions immediately.
notify pgrst, 'reload schema';
