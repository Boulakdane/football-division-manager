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
| 3.6 | L | Optional Arabic names for teams and players; admin-only player licence number and birth date | DB then FE | Done | opencode | merged in #24 | K (done) | Requested by the maintainer 2026-10-27. `teams.name_ar` / `players.name_ar` are optional public data (the Latin name stays required); the licence number and birth date live in the new admin-only `player_profiles` table (partial unique licence index, RLS, no anon grant). Both names show in EN/FR/AR, search, exports and backups; the personal fields are admin-only in the squad table, CSV and JSON. Migration applied in development and production (2026-10-28) |
| 4 | E | Extract pure domain code into ES modules with Node tests | FE | Done | opencode | merged in #26 / #27 | — | Plan 22.6. `js/domain/format.js` and `js/domain/standings.js` hold the DOM-free helpers and `calculateStandings()`; `node --test` covers XSS, number parsing, 2-/4-team leagues, every tie-breaker, a postponed fixture, an empty season, an archived late joiner, Arabic names and form. `npm run test:standings-dual` seeds the same fixtures into PGlite and compares the JS table with `v_standings` row-for-row. `js/app.js` stays classic, loads the deferred module and keeps only the two `appState` adapters. Stage 3 (`renderInto` + ESLint, JSDoc/TypeScript) is deliberately separate |
| 5 | H | Merge import with diff preview | DB then FE | Done | opencode | merged in #29 | — | Plan 22.9. `import_preview(payload, remove_missing)` returns per-table added/changed/removed/unchanged counts and capped entity lists without writing; `import_merge(payload, key, remove_missing, expected_checksum)` upserts by id in one transaction, soft-deletes missing seasons/teams/matches and archives missing players only when the box is ticked, and stores the SHA-256 checksum plus the idempotency key in `import_runs` so a retry replays the stored result. The dialog previews the diff, sends the checksum, and keeps `replace_all_data` behind MFA and a typed REPLACE. Migration applied in development and production (2026-10-28) |
| 6 | D | Tamper-evident audit log and off-site encrypted backup | DB | Open | — | — | — | Plan 22.5 |
| 7 | F | Fixture generator (round-robin) | FE (+DB RPC) | Open | — | — | E helpful | Plan 22.7 |
| 8 | G | Calendar feeds and push notifications | FE | Open | — | — | — | Plan 22.8 |
| 9 | I | Team crests and photos with safe upload | DB then FE | Done | opencode | merged in #25 | L (done) | Plan 22.10, crest half only. Each club can carry an optional crest (`teams.icon`): the browser downscales it to 128px, strips EXIF and stores a PNG/JPEG/WebP **data URL** inline, so the strict CSP (`img-src 'self' data:`) is unchanged, no bucket or new origin is needed and a JSON/CSV backup carries the image. Check constraint refuses SVG, http(s) and script URIs. Player photos stay deferred to J (personal data). Migration applied in development and production after L (2026-10-28) |
| 10 | J | Privacy and retention policy | DOC | Open | — | — | Maintainer input | Plan 22.11. Needs answers to the open questions |
| — | X3 | Import a squad from Excel/CSV into a team (preview, validation, one atomic add) | DB then FE | Done | claude | merged in #10 | — | Shipped: EN/FR/AR template, row-by-row preview, admin-only atomic `add_players()`. Migration applied to development and production; import live-tested in development |
| — | X1 | Pin GitHub Actions to commit SHAs | DB | Open | — | — | — | Security audit item; Dependabot keeps them current |
| 11 | X4 | Count events saved on upcoming fixtures (`events_counted = false`) | DB | Done | opencode | merged in #11 | - | Data repair + PGlite test; applied to development and production and verified in the UI. Re-run after importing an older backup |

## How to add a task

Add a row with the next free ID, lane, and a one-line description. Link the plan section or issue.
Do not renumber other rows.
