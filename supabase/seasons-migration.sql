-- ============================================================
--  KickOff Division — seasons migration
--
--  Run this once in Supabase → SQL Editor → New query → Run.
--  It upgrades an existing database created before seasons were
--  added. Safe to re-run: every step is idempotent.
--
--  After running it, reload the app. The season switcher and
--  "New season" button will appear for admins.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. SEASONS TABLE
-- ------------------------------------------------------------
create table if not exists public.seasons (
  id text primary key,
  name text not null,
  start_date date,
  end_date date,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

-- Existing fixtures are assigned to this default season.
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

-- ------------------------------------------------------------
-- 2. LINK MATCHES TO A SEASON
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 3. GRANTS + RLS
-- ------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.seasons to anon, authenticated;
grant insert, update, delete on public.seasons to authenticated;

alter table public.seasons enable row level security;

drop policy if exists seasons_select_all on public.seasons;
create policy seasons_select_all on public.seasons
  for select to anon, authenticated using (true);

drop policy if exists seasons_insert_admin on public.seasons;
create policy seasons_insert_admin on public.seasons
  for insert to authenticated with check (public.is_admin());

drop policy if exists seasons_update_admin on public.seasons;
create policy seasons_update_admin on public.seasons
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists seasons_delete_admin on public.seasons;
create policy seasons_delete_admin on public.seasons
  for delete to authenticated using (public.is_admin());

-- ------------------------------------------------------------
-- 4. ATOMIC SEASON FUNCTIONS
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

commit;
