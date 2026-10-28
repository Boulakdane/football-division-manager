-- ------------------------------------------------------------
-- KickOff Division - tamper-evident audit chain (roadmap D)
-- ------------------------------------------------------------
-- The audit log was append-only for clients, but a row could still be edited
-- or deleted by someone with database access. This migration chains every row:
--
--   * prev_hash is the row_hash of the previous audit row;
--   * row_hash is the SHA-256 of a canonical JSON document containing
--     prev_hash plus the row's own fields.
--
-- A BEFORE INSERT trigger on public.audit_log computes both values, so every
-- insert path (row triggers, security RPCs, imports) is covered, and an
-- advisory lock keeps concurrent inserts in one line.
--
-- audit_verify_chain() (admin only) walks the chain and reports the first
-- broken row, optionally comparing the head with a published value.
-- audit_chain_head() is public and returns only the count, last id, time and
-- head hash, so the daily backup can publish it without exposing entries.
--
-- Additive and re-runnable: existing rows are backfilled once, and a row that
-- already has a hash is never rewritten. Re-running after tampering therefore
-- does not repair the chain.
--
-- Run this after audit-log-migration.sql, in development, then production.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. CHAIN COLUMNS
-- ------------------------------------------------------------
alter table public.audit_log add column if not exists prev_hash text;
alter table public.audit_log add column if not exists row_hash text;

-- ------------------------------------------------------------
-- 2. CANONICAL HASH
-- ------------------------------------------------------------
-- The timestamp is formatted in UTC with microseconds so the value does not
-- depend on the session TimeZone or DateStyle. jsonb_build_object produces a
-- canonical key order, so the same row always hashes to the same text.
create or replace function public.audit_row_hash(
  p_prev text,
  p_id bigint,
  p_occurred_at timestamptz,
  p_actor_id uuid,
  p_actor_email text,
  p_action text,
  p_entity text,
  p_entity_id text,
  p_season_id text,
  p_summary text,
  p_before jsonb,
  p_after jsonb
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
        'prev', coalesce(p_prev, ''),
        'id', p_id,
        'occurredAt', to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actorId', p_actor_id,
        'actorEmail', p_actor_email,
        'action', p_action,
        'entity', p_entity,
        'entityId', p_entity_id,
        'seasonId', p_season_id,
        'summary', p_summary,
        'before', p_before,
        'after', p_after
      )::text,
      'utf8'
    )),
    'hex'
  );
$$;

revoke execute on function public.audit_row_hash(
  text, bigint, timestamptz, uuid, text, text, text, text, text, text, jsonb, jsonb
) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. BACKFILL (once)
-- ------------------------------------------------------------
-- Only rows without a hash are processed. A row that already has one is left
-- untouched, so a later tamper cannot be "fixed" by running this file again.
do $$
declare
  r record;
  v_prev text;
  v_hash text;
begin
  for r in
    select * from public.audit_log where row_hash is null order by id
  loop
    select a.row_hash into v_prev
    from public.audit_log a
    where a.id < r.id
    order by a.id desc
    limit 1;

    v_hash := public.audit_row_hash(
      v_prev, r.id, r.occurred_at, r.actor_id, r.actor_email,
      r.action, r.entity, r.entity_id, r.season_id, r.summary, r.before, r.after
    );

    update public.audit_log
       set prev_hash = v_prev,
           row_hash = v_hash
     where id = r.id;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 4. CHAIN TRIGGER
-- ------------------------------------------------------------
create or replace function public.audit_log_chain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  -- A backfilled or explicitly chained row keeps its values.
  if new.row_hash is not null then
    return new;
  end if;

  -- Serialise inserts so two concurrent writes cannot share a predecessor.
  perform pg_advisory_xact_lock(748292);

  select a.row_hash into v_prev
  from public.audit_log a
  order by a.id desc
  limit 1;

  new.prev_hash := v_prev;
  new.row_hash := public.audit_row_hash(
    v_prev, new.id, new.occurred_at, new.actor_id, new.actor_email,
    new.action, new.entity, new.entity_id, new.season_id, new.summary,
    new.before, new.after
  );
  return new;
end;
$$;

revoke execute on function public.audit_log_chain() from public, anon, authenticated;

drop trigger if exists audit_log_chain on public.audit_log;
create trigger audit_log_chain
  before insert on public.audit_log
  for each row execute function public.audit_log_chain();

-- ------------------------------------------------------------
-- 5. VERIFY (admin only)
-- ------------------------------------------------------------
create or replace function public.audit_verify_chain(
  p_expected_head text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_prev text := null;
  v_checked int := 0;
  v_total int;
  v_expected text;
  r record;
begin
  if not public.is_admin() then
    raise exception 'Only admins can verify the audit log' using errcode = '42501';
  end if;

  select count(*)::int into v_total from public.audit_log;

  for r in select * from public.audit_log order by id loop
    if r.prev_hash is distinct from v_prev then
      return jsonb_build_object(
        'ok', false,
        'checked', v_checked,
        'total', v_total,
        'brokenAt', r.id,
        'reason', 'prev_hash',
        'expectedPrev', v_prev,
        'actualPrev', r.prev_hash
      );
    end if;

    v_expected := public.audit_row_hash(
      v_prev, r.id, r.occurred_at, r.actor_id, r.actor_email,
      r.action, r.entity, r.entity_id, r.season_id, r.summary, r.before, r.after
    );

    if r.row_hash is distinct from v_expected then
      return jsonb_build_object(
        'ok', false,
        'checked', v_checked,
        'total', v_total,
        'brokenAt', r.id,
        'reason', 'row_hash',
        'expectedHash', v_expected,
        'actualHash', r.row_hash
      );
    end if;

    v_prev := r.row_hash;
    v_checked := v_checked + 1;
  end loop;

  if p_expected_head is not null
     and p_expected_head is distinct from coalesce(v_prev, '') then
    return jsonb_build_object(
      'ok', false,
      'checked', v_checked,
      'total', v_total,
      'reason', 'head_mismatch',
      'expectedHead', p_expected_head,
      'actualHead', v_prev
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'checked', v_checked,
    'total', v_total,
    'head', v_prev
  );
end;
$$;

revoke execute on function public.audit_verify_chain(text) from public, anon;
grant execute on function public.audit_verify_chain(text) to authenticated;

-- ------------------------------------------------------------
-- 6. PUBLIC CHAIN HEAD
-- ------------------------------------------------------------
-- Contains no entry data: only how many rows exist, the last id/time and the
-- head hash. Publishing it with each backup makes a rewritten history visible
-- even if the database owner updates every row.
create or replace function public.audit_chain_head()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'count', count(*)::int,
    'lastId', max(id),
    'at', (select a.occurred_at from public.audit_log a order by a.id desc limit 1),
    'head', (select a.row_hash from public.audit_log a order by a.id desc limit 1)
  )
  from public.audit_log;
$$;

revoke execute on function public.audit_chain_head() from public;
grant execute on function public.audit_chain_head() to anon, authenticated;

notify pgrst, 'reload schema';
