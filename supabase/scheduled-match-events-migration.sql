-- ------------------------------------------------------------
-- KickOff Division - count events on upcoming fixtures
-- ------------------------------------------------------------
-- The match-events migration marked every fixture that already existed as
-- events_counted = false. That is correct for finished or live matches whose
-- player totals had been maintained by hand, but wrong for an upcoming fixture:
-- a goal or card saved on it was stored in match_events and then deliberately
-- kept out of the player totals.
--
-- This one-time repair counts every visible event on an active-season fixture
-- that is still SCHEDULED and has events_counted = false, then marks it as
-- counted. Future fixtures already default to true, so later saves use the
-- normal add/subtract path in replace_match_events().
--
-- Safe to re-run: the second run finds no scheduled fixture with
-- events_counted = false. It changes no archived season and no finished/live
-- fixture, so historical totals are left exactly as they are.
--
-- Run in the Supabase SQL Editor for development, then production. Run it again
-- after importing an older backup that still marks upcoming fixtures as false.
-- ------------------------------------------------------------

do $$
declare
  v_match record;
  v_event record;
begin
  perform pg_advisory_xact_lock(748291);

  for v_match in
    select id
    from public.matches
    where status = 'SCHEDULED'
      and events_counted = false
      and deleted_at is null
      and public.is_active_season(season_id)
    for update
  loop
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

    update public.matches
       set events_counted = true
     where id = v_match.id;
  end loop;
end $$;

notify pgrst, 'reload schema';
