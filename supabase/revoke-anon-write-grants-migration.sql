-- ------------------------------------------------------------
-- KickOff Division - remove anonymous write privileges
-- ------------------------------------------------------------
-- Supabase gives the anon role full privileges on new public tables by default.
-- Row Level Security already stops anonymous writes (an anonymous PATCH or DELETE
-- answers 204 and changes nothing), but the grant layer should say no as well.
-- This keeps SELECT untouched, so public reads are not interrupted, and also
-- covers tables created later. Safe to re-run; no data is changed.
--
-- Run in the Supabase SQL Editor for development, then production. Afterwards
-- `npm run check:drift` should report anonymous PATCH/DELETE as denied (401).
-- ------------------------------------------------------------

revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;

alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;

notify pgrst, 'reload schema';
