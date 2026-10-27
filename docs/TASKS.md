# Task board

One row per task. **Edit only your own row** and keep the table sorted by Order. The authoritative
lock is the open draft PR; this table is the human-readable index. Rules: `docs/COORDINATION.md`.

Status values: `Open` · `Claimed` · `In review` · `Blocked` · `Done`.
Lanes: `DB` database/security · `FE` frontend · `DOC` docs/process (see COORDINATION section 3).

| Order | ID | Task | Lane | Status | Owner | Branch / PR | Depends on | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | C | Security drift monitor (daily check of dashboard-only settings and anon permissions) | DB | Done | claude | merged in #5 | — | Plan section 22.4. First live run found X2 |
| 1 | X2 | Revoke anonymous write privileges (grant layer) | DB | Done | claude | merged in #9 | — | Found by C: anon holds UPDATE/DELETE grants, RLS blocks them. Grant layer now refuses writes; SELECT unchanged |
| 2 | A | Derive player/team totals from events | DB then FE | Done | opencode | merged in #13 / #14 / #15 | — | Plan 22.2. Stage 1 #13 added the `legacy_*` offsets, the views and `set_player_totals()`; stage 2 #14 switched the app to `v_player_stats`; stage 3 #15 dropped `players.goals / yellow / red` and kept `events_counted` as the historical-fixture marker. Migration applied in development and production |
| 3 | B | `scorer` role for live match entry | DB then FE | Done | opencode | merged in #16 | A (done) | Plan 22.3. Adds `scorer`, `match_officials`, narrow `record_live_event()` / `remove_live_event()` (assigned + LIVE/today + 15-minute undo), and admin `list_users()` / `set_user_role()` / `set_match_officials()` with audit. PGlite matrix in `tools/test-scorer-role.js`. Migration applied in development and production |
| 3.5 | K | Two divisions: Division 1 and Division 2, each with its own teams | DB then FE | Done | opencode | merged in #18 | — | Requested by the maintainer 2026-10-27, before E. Plan 22.14. One shared season; `teams.division_id` is movable between seasons; `matches.division_id` stamps the division played so a move never rewrites history; seeded `divisions` rows with a fixed switcher. Migration applied in development and production, drift checks 28/28 in both; evidence in PROGRESS section 24 |
| 3.6 | L | Optional Arabic names for teams and players; admin-only player licence number and birth date | DB then FE | In review | opencode | opencode/L-profile-fields + PR | K (done) | Requested by the maintainer 2026-10-27. `teams.name_ar` / `players.name_ar` are optional public data (the Latin name stays required); the licence number and birth date live in the new admin-only `player_profiles` table (partial unique licence index, RLS, no anon grant). Both names show in EN/FR/AR, search, exports and backups; the personal fields are admin-only in the squad table, CSV and JSON. `supabase/arabic-names-and-license-migration.sql` must be applied to development, then production |
| 4 | E | Extract pure domain code into ES modules with Node tests | FE | Open | — | — | — | Plan 22.6. Touches `js/app.js` (hot) |
| 5 | H | Merge import with diff preview | DB then FE | Open | — | — | — | Plan 22.9 |
| 6 | D | Tamper-evident audit log and off-site encrypted backup | DB | Open | — | — | — | Plan 22.5 |
| 7 | F | Fixture generator (round-robin) | FE (+DB RPC) | Open | — | — | E helpful | Plan 22.7 |
| 8 | G | Calendar feeds and push notifications | FE | Open | — | — | — | Plan 22.8 |
| 9 | I | Team crests and photos with safe upload | DB then FE | Open | — | — | J first for photos | Plan 22.10 |
| 10 | J | Privacy and retention policy | DOC | Open | — | — | Maintainer input | Plan 22.11. Needs answers to the open questions |
| — | X3 | Import a squad from Excel/CSV into a team (preview, validation, one atomic add) | DB then FE | Done | claude | merged in #10 | — | Shipped: EN/FR/AR template, row-by-row preview, admin-only atomic `add_players()`. Migration applied to development and production; import live-tested in development |
| — | X1 | Pin GitHub Actions to commit SHAs | DB | Open | — | — | — | Security audit item; Dependabot keeps them current |
| 11 | X4 | Count events saved on upcoming fixtures (`events_counted = false`) | DB | Done | opencode | merged in #11 | - | Data repair + PGlite test; applied to development and production and verified in the UI. Re-run after importing an older backup |

## How to add a task

Add a row with the next free ID, lane, and a one-line description. Link the plan section or issue.
Do not renumber other rows.
