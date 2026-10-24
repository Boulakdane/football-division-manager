-- ------------------------------------------------------------
-- KickOff Division — data quality constraints
-- ------------------------------------------------------------
-- Safe to re-run. Each constraint is added only when missing.
-- If existing rows violate a rule, the ALTER TABLE fails and the
-- migration rolls back instead of silently accepting bad data.
--
-- Run in the Supabase SQL Editor for development, then production.
-- Fresh installs already get the same constraints from schema.sql.
-- ------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('seasons', 'kickoff_seasons_id_not_blank',   'length(btrim(id)) between 1 and 100'),
      ('seasons', 'kickoff_seasons_name_length',    'length(btrim(name)) between 1 and 100'),
      ('seasons', 'kickoff_seasons_dates_order',   'start_date is null or end_date is null or start_date <= end_date'),
      ('teams',   'kickoff_teams_id_not_blank',     'length(btrim(id)) between 1 and 100'),
      ('teams',   'kickoff_teams_name_length',      'length(btrim(name)) between 1 and 100'),
      ('teams',   'kickoff_teams_code_length',      'length(btrim(code)) between 1 and 8'),
      ('teams',   'kickoff_teams_color_hex',        'color ~ ''^#[0-9A-Fa-f]{6}$'''),
      ('players', 'kickoff_players_id_not_blank',   'length(btrim(id)) between 1 and 100'),
      ('players', 'kickoff_players_name_length',    'length(btrim(name)) between 1 and 100'),
      ('players', 'kickoff_players_num_range',      'num between 0 and 999'),
      ('players', 'kickoff_players_totals_range',   'goals >= 0 and yellow >= 0 and red >= 0'),
      ('matches', 'kickoff_matches_id_not_blank',   'length(btrim(id)) between 1 and 100'),
      ('matches', 'kickoff_matches_round_range',    '"round" between 1 and 1000'),
      ('matches', 'kickoff_matches_scores_range',   'home_score between 0 and 999 and away_score between 0 and 999'),
      ('matches', 'kickoff_matches_distinct_teams', 'home_id <> away_id')
    ) as t(table_name, constraint_name, expression)
  loop
    if not exists (
      select 1
      from pg_constraint
      where conname = r.constraint_name
        and conrelid = ('public.' || r.table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (%s)',
        r.table_name,
        r.constraint_name,
        r.expression
      );
    end if;
  end loop;
end $$;

-- Ask PostgREST to pick up the new constraints immediately.
notify pgrst, 'reload schema';
