-- ============================================================
--  KickOff Division — match events migration
--  Adds goals and yellow/red cards with a minute, linked to a
--  match, team and player. Safe to run more than once.
--
--  Run this once in Supabase → SQL Editor → New query → Run
--  for every existing project (development and production).
-- ============================================================

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

-- ------------------------------------------------------------
-- GRANTS + ROW LEVEL SECURITY
-- ------------------------------------------------------------
grant select on public.match_events to anon, authenticated;
grant insert, update, delete on public.match_events to authenticated;

alter table public.match_events enable row level security;

drop policy if exists match_events_select_all on public.match_events;
create policy match_events_select_all on public.match_events
  for select to anon, authenticated using (true);

drop policy if exists match_events_insert_admin on public.match_events;
create policy match_events_insert_admin on public.match_events
  for insert to authenticated with check (public.is_admin());

drop policy if exists match_events_update_admin on public.match_events;
create policy match_events_update_admin on public.match_events
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists match_events_delete_admin on public.match_events;
create policy match_events_delete_admin on public.match_events
  for delete to authenticated using (public.is_admin());

-- ------------------------------------------------------------
-- ATOMIC REPLACEMENT + PLAYER TOTAL ADJUSTMENT
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
begin
  if not public.is_admin() then
    raise exception 'Only admins can change match events' using errcode = '42501';
  end if;

  if not exists (select 1 from public.matches where id = p_match_id) then
    raise exception 'Match not found';
  end if;

  select events_counted into v_counted
  from public.matches
  where id = p_match_id;

  if p_events is null then
    p_events := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'Events must be an array';
  end if;

  -- Remove the previous events and reverse their contribution to player totals.
  -- Historical matches with events_counted = false keep their manual totals.
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

  -- Insert the submitted events and add their contribution to player totals.
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

-- Delete a match in one transaction, including the player-total rollback.
create or replace function public.delete_match(p_match_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old record;
  v_counted boolean;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete matches' using errcode = '42501';
  end if;

  if not exists (select 1 from public.matches where id = p_match_id) then
    raise exception 'Match not found';
  end if;

  select events_counted into v_counted
  from public.matches
  where id = p_match_id;

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

revoke execute on function public.replace_match_events(text, jsonb) from public, anon;
revoke execute on function public.delete_match(text) from public, anon;
grant execute on function public.replace_match_events(text, jsonb) to authenticated;
grant execute on function public.delete_match(text) to authenticated;

-- Ask PostgREST to pick up the new table and functions immediately.
notify pgrst, 'reload schema';
