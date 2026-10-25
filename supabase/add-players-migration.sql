-- ------------------------------------------------------------
-- KickOff Division - bulk add players (Import squad from Excel)
-- ------------------------------------------------------------
-- Adds public.add_players(team_id, players jsonb): admin only, atomic,
-- validates every row, rejects duplicates, and writes one summary entry
-- to the activity log. Safe to re-run; no existing data is changed.
-- Fresh installs already get this function from schema.sql.
--
-- Run in the Supabase SQL Editor for development, then production.
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
  v_pos text;
  v_num int;
  v_goals int;
  v_yellow int;
  v_red int;
  v_count int := 0;
  v_seen text[] := '{}';
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

    insert into public.players (id, team_id, name, pos, num, goals, yellow, red, is_active)
    values (
      'p_' || replace(gen_random_uuid()::text, '-', ''),
      p_team_id, v_name, v_pos, v_num, v_goals, v_yellow, v_red, true
    );
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

notify pgrst, 'reload schema';
