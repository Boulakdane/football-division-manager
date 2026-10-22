-- ============================================================
--  KickOff Division — admin MFA / step-up migration
--  Adds a database-enforced second factor for admin writes.
--
--  Run this after soft-delete-migration.sql, in
--  Supabase -> SQL Editor -> New query -> Run.
--  Safe to re-run.
--
--  Design:
--    * Totp factors are enrolled through Supabase Auth (frontend).
--    * The JWT then carries aal = aal2 after the factor is verified.
--    * is_admin() only returns true for aal2 sessions once the admin
--      turns the requirement on, so every existing RLS policy and RPC
--      inherits the gate without being rewritten.
--    * The requirement defaults to OFF so the migration is additive.
-- ============================================================

-- ------------------------------------------------------------
-- 1. SETTINGS (one row)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 2. HELPERS
-- ------------------------------------------------------------
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

-- The role check stays the same; the aal check is added only while the
-- requirement is enabled. Reads by anonymous visitors never touch this.
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

-- ------------------------------------------------------------
-- 3. TOGGLE (step-up required)
-- ------------------------------------------------------------
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

  -- Changing the security posture is itself a sensitive action: require
  -- a verified factor in this session, never a password-only session.
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

notify pgrst, 'reload schema';
