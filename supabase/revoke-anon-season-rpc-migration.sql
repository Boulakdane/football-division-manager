-- ------------------------------------------------------------
-- KickOff Division - close anonymous access to season RPCs
-- ------------------------------------------------------------
-- create_season() and activate_season() already reject non-admins
-- internally; this removes the default PUBLIC/anon EXECUTE grant too,
-- matching every other admin RPC (defence in depth). Safe to re-run.
-- Run in the Supabase SQL Editor for development, then production.
-- ------------------------------------------------------------

revoke execute on function public.create_season(text, text, date, date) from public, anon;
revoke execute on function public.activate_season(text) from public, anon;
grant execute on function public.create_season(text, text, date, date) to authenticated;
grant execute on function public.activate_season(text) to authenticated;

notify pgrst, 'reload schema';
