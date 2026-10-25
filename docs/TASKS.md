# Task board

One row per task. **Edit only your own row** and keep the table sorted by Order. The authoritative
lock is the open draft PR; this table is the human-readable index. Rules: `docs/COORDINATION.md`.

Status values: `Open` · `Claimed` · `In review` · `Blocked` · `Done`.
Lanes: `DB` database/security · `FE` frontend · `DOC` docs/process (see COORDINATION section 3).

| Order | ID | Task | Lane | Status | Owner | Branch / PR | Depends on | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | C | Security drift monitor (daily check of dashboard-only settings and anon permissions) | DB | Done | claude | merged in #5 | — | Plan section 22.4. First live run found X2 |
| 1 | X2 | Revoke anonymous write privileges (grant layer) | DB | Done | claude | merged in #9 | — | Found by C: anon holds UPDATE/DELETE grants, RLS blocks them. Grant layer now refuses writes; SELECT unchanged |
| 2 | A | Derive player/team totals from events | DB then FE | Open | — | — | — | Plan 22.2. Split: DB PR first, then UI PR |
| 3 | B | `scorer` role for live match entry | DB then FE | Open | — | — | A recommended first | Plan 22.3 |
| 4 | E | Extract pure domain code into ES modules with Node tests | FE | Open | — | — | — | Plan 22.6. Touches `js/app.js` (hot) |
| 5 | H | Merge import with diff preview | DB then FE | Open | — | — | — | Plan 22.9 |
| 6 | D | Tamper-evident audit log and off-site encrypted backup | DB | Open | — | — | — | Plan 22.5 |
| 7 | F | Fixture generator (round-robin) | FE (+DB RPC) | Open | — | — | E helpful | Plan 22.7 |
| 8 | G | Calendar feeds and push notifications | FE | Open | — | — | — | Plan 22.8 |
| 9 | I | Team crests and photos with safe upload | DB then FE | Open | — | — | J first for photos | Plan 22.10 |
| 10 | J | Privacy and retention policy | DOC | Open | — | — | Maintainer input | Plan 22.11. Needs answers to the open questions |
| — | X3 | Import a squad from Excel/CSV into a team (preview, validation, one atomic add) | DB then FE | In review | claude | `claude/X3-squad-excel-import` | — | Requested by the maintainer: ~15 teams each send a filled Excel. Template in EN/FR/AR, row-by-row preview, `add_players()` is admin-only and atomic. Run `add-players-migration.sql` on existing projects |
| — | X1 | Pin GitHub Actions to commit SHAs | DB | Open | — | — | — | Security audit item; Dependabot keeps them current |

## How to add a task

Add a row with the next free ID, lane, and a one-line description. Link the plan section or issue.
Do not renumber other rows.
