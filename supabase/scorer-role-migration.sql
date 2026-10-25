-- ============================================================
--  KickOff Division — scorer role and match officials (roadmap B)
-- ============================================================
--  Adds a least-privilege `scorer` role for match-day entry:
--
--    * match_officials: which scorer may score which fixture;
--    * record_live_event() / remove_live_event(): a narrow event path
--      instead of the full admin match editor;
--    * list_users(), set_user_role(), set_match_officials(): admin-only
--      management, with an explicit audit entry for every change.
--
--  A scorer can only add goals/cards to a fixture they are assigned to,
--  while it is LIVE or scheduled today in the active season. The first
--  event on a scheduled fixture starts it. A scorer can undo an event for
--  15 minutes; admins have no time limit. is_admin() is unchanged, so
--  scorers never inherit the admin RPCs or RLS write policies.
--
--  Run this after drop-stored-totals-migration.sql (and therefore after the
--  audit-log migration), development first, then production. Safe to re-run.
--
--  The enum value is added outside the main transaction on purpose: on
--  PostgreSQL versions before 12 an enum value cannot be added inside a
--  transaction. The functions below compare roles as text, so they can be
--  created by the same script that adds the value.
-- ============================================================

alter type public.app_role add value if not exists 'scorer';

begin;

-- ------------------------------------------------------------
-- 1. MATCH-DAY HELPER
-- ------------------------------------------------------------
create or replace function public.is_scorer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    -- Compare as text so this helper can be created in the same transaction
    -- that adds the enum value on an older database.
    where id = auth.uid() and role::text = 'scorer'
  );
$$;

revoke execute on function public.is_scorer() from public, anon;
grant execute on function public.is_scorer() to authenticated;

-- ------------------------------------------------------------
-- 2. MATCH OFFICIALS
-- ------------------------------------------------------------
create table if not exists public.match_officials (
  match_id text not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (match_id, user_id)
);

create index if not exists match_officials_user_id_idx
  on public.match_officials (user_id);

alter table public.match_officials enable row level security;

revoke all on public.match_officials from public, anon, authenticated;
grant select on public.match_officials to anon, authenticated;

drop policy if exists match_officials_select_own on public.match_officials;
create policy match_officials_select_own on public.match_officials
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists match_officials_select_admin on public.match_officials;
create policy match_officials_select_admin on public.match_officials
  for select to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------
-- 3. LIVE MATCH ENTRY
-- ------------------------------------------------------------
create or replace function public.record_live_event(
  p_match_id text,
  p_team_id text,
  p_player_id text,
  p_event_type text,
  p_minute int
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches%rowtype;
  v_event_id text;
  v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then
    raise exception 'Sign in to record live events' using errcode = '42501';
  end if;
  if not v_admin and not public.is_scorer() then
    raise exception 'Only admins and scorers can record live events' using errcode = '42501';
  end if;

  if p_event_type is null or p_event_type not in ('goal', 'yellow', 'red') then
    raise exception 'Invalid event type: %', p_event_type;
  end if;
  if p_minute is null or p_minute < 1 or p_minute > 130 then
    raise exception 'Event minute must be between 1 and 130';
  end if;

  perform pg_advisory_xact_lock(748291);

  select *
    into v_match
  from public.matches
  where id = p_match_id
    and deleted_at is null;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_match.season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;
  if not v_match.events_counted then
    raise exception 'This fixture predates match events; an admin must edit it' using errcode = '42501';
  end if;
  if v_match.status <> 'LIVE'
     and not (
       v_match.status = 'SCHEDULED'
       and v_match.datetime is not null
       and left(v_match.datetime, 10) = to_char(current_date, 'YYYY-MM-DD')
     ) then
    raise exception 'Live entry is open only for a live match or a fixture scheduled today'
      using errcode = '42501';
  end if;

  if not v_admin then
    if not exists (
      select 1
      from public.match_officials o
      where o.match_id = p_match_id
        and o.user_id = auth.uid()
    ) then
      raise exception 'You are not assigned to this match' using errcode = '42501';
    end if;
  end if;

  if not exists (
    select 1
    from public.players p
    where p.id = p_player_id
      and p.team_id = p_team_id
      and p.team_id in (v_match.home_id, v_match.away_id)
  ) then
    raise exception 'Player % does not belong to this match', p_player_id;
  end if;

  v_event_id := 'e_' || replace(gen_random_uuid()::text, '-', '');

  insert into public.match_events (id, match_id, team_id, player_id, event_type, minute)
  values (v_event_id, p_match_id, p_team_id, p_player_id, p_event_type, p_minute);

  if p_event_type = 'goal' then
    update public.matches
       set home_score = case when home_id = p_team_id then home_score + 1 else home_score end,
           away_score = case when away_id = p_team_id then away_score + 1 else away_score end
     where id = p_match_id;
  end if;

  update public.matches
     set status = 'LIVE'
   where id = p_match_id
     and status = 'SCHEDULED';

  return v_event_id;
end;
$$;

create or replace function public.remove_live_event(p_event_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.match_events%rowtype;
  v_match public.matches%rowtype;
  v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then
    raise exception 'Sign in to change live events' using errcode = '42501';
  end if;
  if not v_admin and not public.is_scorer() then
    raise exception 'Only admins and scorers can change live events' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select *
    into v_event
  from public.match_events
  where id = p_event_id;

  if not found then
    raise exception 'Event not found';
  end if;

  select *
    into v_match
  from public.matches
  where id = v_event.match_id
    and deleted_at is null;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_match.season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;
  if not v_match.events_counted then
    raise exception 'This fixture predates match events; an admin must edit it' using errcode = '42501';
  end if;
  if v_match.status <> 'LIVE'
     and not (
       v_match.status = 'SCHEDULED'
       and v_match.datetime is not null
       and left(v_match.datetime, 10) = to_char(current_date, 'YYYY-MM-DD')
     ) then
    raise exception 'Live entry is open only for a live match or a fixture scheduled today'
      using errcode = '42501';
  end if;

  if not v_admin then
    if not exists (
      select 1
      from public.match_officials o
      where o.match_id = v_event.match_id
        and o.user_id = auth.uid()
    ) then
      raise exception 'You are not assigned to this match' using errcode = '42501';
    end if;
    if v_event.created_at < now() - interval '15 minutes' then
      raise exception 'The 15-minute undo window has closed' using errcode = '42501';
    end if;
  end if;

  delete from public.match_events where id = p_event_id;

  if v_event.event_type = 'goal' then
    update public.matches
       set home_score = case
             when home_id = v_event.team_id then greatest(0, home_score - 1)
             else home_score
           end,
           away_score = case
             when away_id = v_event.team_id then greatest(0, away_score - 1)
             else away_score
           end
     where id = v_event.match_id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 4. ADMIN MANAGEMENT
-- ------------------------------------------------------------
create or replace function public.list_users()
returns table (id uuid, email text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can list users' using errcode = '42501';
  end if;

  return query
    select p.id, p.email, p.role::text, p.created_at
    from public.profiles p
    order by p.email nulls last, p.created_at, p.id;
end;
$$;

create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.app_role;
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'viewer', 'scorer') then
    raise exception 'Unknown role: %', p_role;
  end if;
  if p_user_id = auth.uid() and p_role <> 'admin' then
    raise exception 'You cannot remove your own admin role' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select p.role, p.email
    into v_old, v_email
  from public.profiles p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception 'User not found';
  end if;
  if v_old::text = p_role then
    return;
  end if;

  update public.profiles
     set role = p_role::public.app_role
   where id = p_user_id;

  insert into public.audit_log (
    actor_id, actor_email, action, entity, entity_id, summary, before, after
  )
  values (
    auth.uid(),
    (select u.email from auth.users u where u.id = auth.uid()),
    'SECURITY',
    'profiles',
    p_user_id::text,
    format('Role for %s changed from %s to %s',
           coalesce(v_email, p_user_id::text), v_old::text, p_role),
    jsonb_build_object('role', v_old::text),
    jsonb_build_object('role', p_role)
  );
end;
$$;

create or replace function public.set_match_officials(
  p_match_id text,
  p_user_ids uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id text;
  v_ids uuid[];
  v_added uuid[];
  v_removed uuid[];
  v_id uuid;
  v_email text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can assign match officials' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(748291);

  select m.season_id
    into v_season_id
  from public.matches m
  where m.id = p_match_id
    and m.deleted_at is null;

  if not found then
    raise exception 'Match not found';
  end if;
  if not public.is_active_season(v_season_id) then
    raise exception 'Only the active season can be edited' using errcode = '42501';
  end if;

  select array(
    select distinct x
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) as x
    where x is not null
  )
    into v_ids;

  if exists (
    select 1
    from unnest(v_ids) as x
    where not exists (
      select 1
      from public.profiles p
      where p.id = x
        and p.role::text = 'scorer'
    )
  ) then
    raise exception 'Only scorer accounts can be assigned to a match' using errcode = '42501';
  end if;

  select coalesce(array_agg(o.user_id), '{}'::uuid[])
    into v_removed
  from public.match_officials o
  where o.match_id = p_match_id
    and not (o.user_id = any(v_ids));

  select coalesce(array_agg(x), '{}'::uuid[])
    into v_added
  from unnest(v_ids) as x
  where not exists (
    select 1
    from public.match_officials o
    where o.match_id = p_match_id
      and o.user_id = x
  );

  delete from public.match_officials
  where match_id = p_match_id
    and not (user_id = any(v_ids));

  if cardinality(v_ids) > 0 then
    insert into public.match_officials (match_id, user_id, created_by)
    select p_match_id, x, auth.uid()
    from unnest(v_ids) as x
    on conflict do nothing;
  end if;

  foreach v_id in array v_added loop
    select p.email into v_email from public.profiles p where p.id = v_id;
    insert into public.audit_log (
      actor_id, actor_email, action, entity, entity_id, season_id, summary, after
    )
    values (
      auth.uid(),
      (select u.email from auth.users u where u.id = auth.uid()),
      'INSERT',
      'match_officials',
      p_match_id,
      v_season_id,
      format('%s can score match %s',
             coalesce(v_email, v_id::text), p_match_id),
      jsonb_build_object('user_id', v_id, 'email', v_email)
    );
  end loop;

  foreach v_id in array v_removed loop
    select p.email into v_email from public.profiles p where p.id = v_id;
    insert into public.audit_log (
      actor_id, actor_email, action, entity, entity_id, season_id, summary, before
    )
    values (
      auth.uid(),
      (select u.email from auth.users u where u.id = auth.uid()),
      'DELETE',
      'match_officials',
      p_match_id,
      v_season_id,
      format('%s can no longer score match %s',
             coalesce(v_email, v_id::text), p_match_id),
      jsonb_build_object('user_id', v_id, 'email', v_email)
    );
  end loop;
end;
$$;

revoke execute on function public.record_live_event(text, text, text, text, int) from public, anon;
revoke execute on function public.remove_live_event(text) from public, anon;
revoke execute on function public.list_users() from public, anon;
revoke execute on function public.set_user_role(uuid, text) from public, anon;
revoke execute on function public.set_match_officials(text, uuid[]) from public, anon;
grant execute on function public.record_live_event(text, text, text, text, int) to authenticated;
grant execute on function public.remove_live_event(text) to authenticated;
grant execute on function public.list_users() to authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;
grant execute on function public.set_match_officials(text, uuid[]) to authenticated;

commit;
