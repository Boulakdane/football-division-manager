# KickOff Division — Progress Update

- **Last updated:** 2026-10-22
- **Working-tree version:** `v3.6.1`
- **Deployed version:** `v3.6.1` (current `main`); `prod` tag moves with each verified release; integrity migration applied in development and production
- **Live site:** <https://boulakdane.github.io/football-division-manager/>
- **Repository:** <https://github.com/Boulakdane/football-division-manager>

## 1. Status at a glance

| Area | Status | Notes |
|---|---|---|
| Public standings, fixtures and squads | ✅ Done | Works without login; shared across devices |
| Admin authentication and roles | ✅ Done | Supabase Auth; `admin` / `viewer`; signups disabled |
| Database-enforced permissions | ✅ Done | RLS policies plus admin-only RPCs |
| Multiple seasons and archive | ✅ Done | Archived seasons are read-only in the UI and in RLS |
| Player history protection | ✅ Deployed and live-tested | `players.is_active`; history players are archived and restorable |
| Destructive operations | ✅ Deployed and live-tested | Team/match deletes and event writes are RPC-only; match saves are atomic |
| CSV bulk entry and admin exports | ✅ Done | Five-file workflow including `events.csv` |
| JSON backup and restore | ✅ Done | Full replacement; development round-trip and production no-op import passed |
| Atomic full-data import | ✅ Deployed and live-tested in both environments | Patched RPC invoked successfully in development and production; no-op imports kept each data hash unchanged and did not use the fallback |
| Structured match events | ✅ Deployed, migrated and tested | Goals/cards with minutes, player dropdowns; RPCs and live production UI flow tested |
| Security hardening pass | 🟡 In progress | All runtime assets self-hosted, CSP meta in place, secret scanning, dependency updates, XSS helper; inline handlers still to remove |
| UX polish and shareability | ✅ Done in `v3.6.0` | Shareable filter URLs, clear filters, guided empty states, match timeline, keyboard/focus handling, Lighthouse 100/100/100 |
| Production migration | ✅ Applied in development and production | `integrity-migration.sql` is live in both projects; `PLAYERS_ARCHIVE_READY` is true |
| Real league data | ⛔ Not started | Waiting for real teams, players, seasons and fixtures |

**Bottom line:** the core league manager is usable, publicly readable and `v3.6.1` is on `main`. The integrity hardening is live in both hosted projects: archived seasons are read-only in RLS, players with history are archived instead of deleted, team/match deletes and event writes go through total-adjusting RPCs, and `save_match` writes a fixture plus its events in one transaction. `v3.5.1` removed the last CDN dependency on the auth path by serving the Supabase client from `vendor/`, and `v3.6.1` finishes the job: Lucide and the webfonts are self-hosted too, and a CSP limits the page to its own origin plus Supabase. `v3.6.0` added the shareability and accessibility layer (filter-aware links, guided empty states, match timeline, keyboard-safe dialogs, Lighthouse 100/100/100). The remaining work is operational: decide what to do with the single leftover test event, then load the real league data.

## 2. Architecture

```text
Static browser app (HTML/CSS/JS)
        │
        ├── Supabase Auth (email + password)
        ├── Supabase REST / PostgREST
        │       └── Postgres tables + Row Level Security + RPC functions
        └── Public reads for anonymous visitors

Local CSV / JSON tools
        └── Admin browser import ──► Supabase (full replacement)
```

### Environment split

| Environment | Supabase project | Used by |
|---|---|---|
| Production | `vbegrfxsxsbldgwvwpeb` | GitHub Pages |
| Development | `dcpdzyieicvtnknqlhyh` | `localhost`, and `?env=dev` on the deployed site |

- Localhost automatically uses development.
- `?env=prod` forces production even on localhost (use with care).
- Only publishable/anon keys are in the repository. The service-role key is never used in the browser.

### Data model

| Table | Purpose |
|---|---|
| `profiles` | Auth user profile and `admin` / `viewer` role |
| `seasons` | Active and archived seasons; one active season at a time |
| `teams` | Global club records |
| `players` | Global player records with cumulative goals/cards and `is_active` archive flag |
| `matches` | Season-scoped fixtures, results, status and venue |
| `match_events` | Goals, yellow cards and red cards with minute |

`matches.events_counted` prevents double-counting when events are added to historical fixtures whose goals/cards were already maintained manually.

## 3. What has been completed

### Foundation and hosting

- Pure static frontend deployed on GitHub Pages; no application server.
- Supabase free tier for database, auth and API.
- Separate production and development projects.
- Compiled Tailwind CSS committed to the repository; no Play CDN in production.
- Responsive dark theme with English, French and Arabic (RTL) support.
- Favicon, theme colour, Open Graph metadata and deferred CDN assets.

### League management

- Automatic standings with points, W/D/L, goals for/against, goal difference and last-5 form.
- Fixture creation, editing, live score shortcuts, status changes and deletion.
- Team and player CRUD.
- Multiple seasons with archive/activate and empty archived-season deletion.
- Duplicate-fixture protection and validation.
- CSV exports scoped to the season currently shown.
- JSON full backup/export and import.

### Security and correctness

- Supabase Auth with role lookup from `profiles`.
- RLS on all league tables: public read, admin-only writes.
- Admin-only `create_season`, `activate_season`, `replace_match_events`, `delete_match`, `save_match`, `delete_team`, `archive_player`, `restore_player` and `replace_all_data` RPCs.
- `save_match(jsonb, jsonb)` writes the fixture and its events in one transaction; a rejected event rolls back the match too.
- `delete_team` reverses that team's event contributions to opponent totals before the cascade; direct team/match deletes and direct match-event writes are denied by RLS.
- `players.is_active` archives players with history; the history-protection delete policy blocks hard deletion while events exist.
- Archived seasons are read-only through RLS for matches and match events, not just through hidden buttons.
- `replace_all_data(jsonb)` performs the full JSON replacement in one transaction, validates shape/references and serializes concurrent imports with an advisory lock.
- Anonymous write attempts rejected by Postgres.
- Signups disabled in Supabase project settings.
- `is_admin()` uses `security definer` with a fixed `search_path`.
- Match-event RPCs revoke `PUBLIC`/`anon` execute and re-grant only to `authenticated`.
- Pinned Lucide and Supabase JS versions with Subresource Integrity (SRI).
- `Referrer-Policy` meta tag.
- Inline event-handler IDs escaped with a JSON-aware helper (`jsString`) to close a DOM-XSS injection path.
- CI secret scanner and weekly Dependabot updates.

### Match events (current working tree)

- Normalized `public.match_events` table.
- Event types: `goal`, `yellow`, `red`; minute range `1–130`.
- Home/away event panels with player dropdowns filtered by team.
- Add goal, add card, change type, change minute and remove controls.
- Goal-count versus score hint.
- Atomic replacement of a match’s events with player-total adjustment through `replace_match_events`.
- Atomic match deletion with player-total rollback through `delete_match`.
- Legacy `matches.scorers_text` fallback until the migration is applied.
- JSON import/export and five-file CSV round trip include events.
- Historical fixtures can opt out of automatic totals with `events_counted = false`.

### Integrity hardening (current working tree)

- `supabase/integrity-migration.sql` adds `players.is_active` and `is_active_season()`.
- RLS rejects match inserts, updates and deletes in archived seasons; match events are RPC-only.
- `players` hard deletion is blocked while a player has match events; the UI archives instead.
- `delete_team` reverses opponent player totals, then deletes the team and its cascade.
- `delete_match` and `replace_match_events` keep their total adjustments and are the only delete/edit paths.
- `save_match` makes match + event saves atomic; `dbSaveMatch` prefers it and keeps the old client path only as a fallback for un-migrated projects.
- A shared advisory lock (`748291`) serializes imports, team deletion and match/event writes.
- Archived players stay selectable in an existing event dropdown so editing a match does not silently drop their history.
- JSON/CSV tools preserve the optional `isActive` field; older backups without it default to active.

## 4. Verification evidence

| Check | Result |
|---|---|
| `node --check` on all `js/*.js` and `tools/*.js` | Passed |
| CSV round trip with `data/examples` | Stable; 10 events preserved |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Lighthouse (local, mocked events) | Accessibility 100, Best Practices 100, SEO 100 |
| Lighthouse (production, v3.4.4) | Accessibility 100, Best Practices 100, SEO 100 |
| Browser smoke test | 9 fixtures render; no console errors after the vendored client load |
| SRI load test | Lucide loaded with an integrity check; the Supabase client is served from `vendor/` |
| Inline-handler XSS test | Malicious ID rendered as a string literal; no execution |
| `npm run check:secrets` | No privileged secrets found |
| Production deploy | `v3.5.1` live; version badge and all asset URLs updated; production reads 1 season / 6 teams / 9 players / 9 matches / 1 event; 6 standings rows, 9 fixtures and 6 team cards render; no console warnings/errors; `PLAYERS_ARCHIVE_READY=true` after the integrity migration |
| Development integrity migration (live) | `PLAYERS_ARCHIVE_READY = true`; direct `teams`/`matches` deletes and `match_events` writes rejected with `42501`; archive/restore keeps the event history; `save_match` rolled back an invalid event; `delete_team` reversed opponent totals (1 goal / 1 yellow → 0 / 0); archived-season writes rejected; anonymous writes and RPCs returned `401`; sample data restored to 1/6/9/9/0 |
| Production integrity migration (live) | `players.is_active` and `matches.events_counted` present; public reads 1/6/9/9/1; 6 standings rows, 9 fixtures, 6 team cards, no migration notice; anonymous insert and every admin RPC returned `401` / `42501`; live hash identical to the pre-migration backup |
| Production backup before the integrity migration | `prod-backup-2026-10-21-pre-integrity.json`, SHA-256 `435a86db…c80f54`, 1 season / 6 teams / 9 players / 9 matches / 1 event; `m6` = 2–4 and the Ethan Hunt event preserved |
| Production admin flows (live, post-migration) | Production admin session: archive/restore kept the goal and the total, `save_match` rolled back an invalid event with no rows left behind (`p1` unchanged), `delete_team` reversed the opponent from 1 goal / 1 yellow to 0 / 0; all temporary rows deleted and the live hash returned to `435a86db…c80f54` |
| Production data hash after the admin checks | `435a86dbcb7d69161f16fcfefef172ff703b0a6b9169a6ada027d879e6c80f54` — identical to the pre-migration backup, so the checks left no residue |
| Vendored Supabase client | `vendor/supabase-js-2.118.0.js` (MIT, license included) is served from the same origin; the login modal no longer reports "not configured" when only the CDN was blocked |
| CSV formula-injection hardening | `=1+1`, `+SUM(A1)`, `-1+1`, `@cmd`, tab and newline prefixes export as text; numeric `-3` stays numeric; backup → CSV → JSON round trip restores the original value |
| v3.4.6 bug-fix checks | Missing `btnAddPlayer` translations added for EN/FR/AR; empty team/player names rejected; transfer with existing match events blocked; delete-player history warning; JSON export uses a Blob for large backups; Lucide failure no longer breaks rendering |
| Production anonymous write | `POST /rest/v1/teams` returned `401` / `42501` |
| Development migration | `match_events` and `events_counted` exist; REST returns `200` |
| Production migration | `match_events` and `events_counted` exist; REST returns `200` |
| Atomic import migration | `replace_all_data(jsonb)` installed in development and production |
| Atomic import anonymous call | Both projects return `401` / `42501` (permission denied); function is no longer missing |
| Historical-match flag | Existing fixtures have `events_counted = false` |
| Anonymous event RPC | `replace_match_events` returned `401` in development and production |
| Development admin event RPC | Add goal/yellow, replace yellow with red, delete match: all totals and rows verified |
| Production admin event RPC | Add goal/yellow, replace yellow with red, delete match: all totals and rows verified |
| Live production admin UI | Created a fixture through the live Add Match modal, added goal/yellow, edited to red, deleted it; totals restored |
| Live auth and language | Login form, admin role, logout, French LTR and Arabic RTL all passed |
| Live filters | Matchday, status and reset filters matched the visible fixture counts |
| Live team/player CRUD | Create, edit and delete for a club and a player passed; no leftovers |
| Live seasons | Create auto-active season, archived read-only state, Make Active, and delete empty archived season passed |
| Live score/status | LIVE +1 stepper persisted, FINISHED 2-1 updated the table, delete restored the baseline |
| Live CSV/JSON exports | Standings 7 lines, fixtures 10 lines, squads 10 lines; JSON backup valid |
| Development JSON import | Full replacement with and without events; exact round trip, event inserted, totals preserved |
| Atomic import RPC (local) | PGlite/Postgres-compatible run: valid import, invalid-event rollback, duplicate-active-season rejection and empty import all passed |
| Atomic import payload (local) | Backend sends snake-case arrays, active-season fallback, `events_counted` and event rows to `replace_all_data` |
| Atomic import invalid request (production) | Admin request with no seasons rejected with `Import needs at least one season`; all counts unchanged |
| Atomic import first attempt (production) | Reached RPC, then safely failed on `pg-safeupdate`: `DELETE requires a WHERE clause`; data hash unchanged |
| Development atomic no-op import (patched) | Admin `demo@kickoff.com`; `dbReplaceAll` called only `replace_all_data`, no fallback; pre/post SHA-256 `a3b72e56...6b5a25` identical with 1/6/9/9/0 rows |
| Development atomic rollback (patched) | Invalid event rejected with `Every imported event must belong to its fixture team and player`; test row absent, hash unchanged at `a3b72e56...6b5a25` |
| Production atomic no-op import (patched) | `dbReplaceAll` called only `replace_all_data`, no fallback; pre/post SHA-256 `bc03039b...7e3dde` identical with 1/6/9/9/0 rows |
| Production atomic rollback (patched) | Invalid event rejected with `Every imported event must belong to its fixture team and player`; test row absent and counts unchanged |
| Historical flag RPC | `events_counted = false` stored an event without changing player totals in development and production |
| Production backup | Fresh JSON export validated: 1 season, 6 teams, 9 players, 9 matches, 0 events; no smoke data |
| Production backup after migration | `prod-backup-2026-10-21-post-atomic.json` matches the 2026-10-20 backup exactly; data unchanged |
| Production backup after live import | `prod-backup-2026-10-21-post-import.json`: 1 season, 6 teams, 9 players, 9 matches, 1 event; event is m8 / Ethan Hunt / 10' with `events_counted = false` |
| Current production hash | `06110f15f5347c51172cfdca69eca4ce9f51cba606bdd157a302b3aadaf8914e` after the event appeared |
| Admin RPC success path | Verified in development and production |
| Integrity SQL suite (PGlite/Postgres-compatible) | Passed: archived-season table/RPC rejection, atomic `save_match` rollback and totals, `delete_match` rollback, safe `delete_team` reversal, player history delete block, archive/restore, full-import `is_active`, RPC-only destructive writes, cross-season fixtures, anonymous denial; committed as `npm run test:sql` and wired into CI |
| Integrity migration upgrade path | Passed: old schema -> atomic import migration -> integrity migration, applied twice without error; sample rows preserved |
| Cross-season fixture check | Same teams/round allowed in a different season; duplicate blocked within a season |
| Frontend compatibility (development, pre-migration) | New frontend loaded with `PLAYERS_ARCHIVE_READY = false`; team/player/match fallback saves and deletes passed; archive RPC reported `INTEGRITY_MIGRATION_REQUIRED` |
| Frontend archive UI (local) | Archived player row shows **Archived players** + **Restore** for admins, hidden for viewers; archived event player remains selected with an **(Archived)** label |
| CSV `isActive` round trip | `backup-to-csv` -> `csv-to-backup` preserved `true` and `false`; counts unchanged |
| Versioned assets | `v3.5.1` query strings and badge prepared |

## 5. Current blockers and risks

1. **Real data is not loaded.** The app still contains sample fixtures and players.
2. **A single event appeared in production during the live test window.** `m8` / Ethan Hunt / 10' is present with `events_counted = false`, so player totals are unchanged. Decide whether to keep it or remove it before loading real data.
3. **Real-data replacement is still untested.** The no-op production import and rollback paths passed; now test with real data in development first, then production with a fresh backup and keep the previous JSON export for rollback.
4. **Production and development differ.** For example, `m6` is 1–1 in development but 2–4 in production, and Karim Ziani has different card totals. Do not assume the environments are identical.
5. **The integrity migration is live; re-apply it after any older migration.** `supabase/integrity-migration.sql` has been run in development and production and `PLAYERS_ARCHIVE_READY` is true in both. If an older migration is re-run later, run the integrity migration again afterwards and re-check `PLAYERS_ARCHIVE_READY`.
6. **Some destructive actions are still permanent by design.** `delete_team` removes all of a team's matches and events across every season (after reversing opponent totals), and `delete_match` removes a fixture's events. There is no audit log, soft-delete/trash for teams or matches, or transfer/registration history. Transfers for players with events remain blocked in the UI. Keep a backup before destructive edits.
7. **Operational gaps.** There is no MFA, password reset flow, automated hosted RLS test suite or automated browser test yet. These are covered in the security and modernization plans.

## 6. Release checklist for the match-events release

- [x] Commit the working tree, push `main`, move the `prod` tag and verify GitHub Pages.
- [x] Confirm `v3.4.4` is live, SRI is active and the public league loads.
- [x] Re-run the anonymous write rejection test against production (`401` / `42501`).
- [x] Run `supabase/match-events-migration.sql` in the **development** project SQL Editor.
- [x] Run `supabase/match-events-migration.sql` in the **production** project SQL Editor.
- [x] Reload both apps and confirm the migration notice disappears and no `match_events` `404` remains.
- [x] Sign in as a development admin and add one goal and one card to a test match.
- [x] Confirm the event timeline, minute and player totals.
- [x] Edit and remove events; confirm totals return to the original values.
- [x] Delete a test match; confirm events and totals are cleaned up.
- [x] Confirm a match with `events_counted = false` stores events without changing player totals.
- [x] Repeat the admin smoke test in **production**.
- [x] Export and validate a fresh production JSON backup.

### Integrity hardening release (v3.5.0)

- [x] Run `supabase/integrity-migration.sql` in the **development** project SQL Editor.
- [x] Reload development and confirm `PLAYERS_ARCHIVE_READY` is true and no console errors appear.
- [x] In development, archive and restore a player with events; confirm the event/total history is unchanged.
- [x] In development, delete a player without events; confirm the hard-delete path still works.
- [x] In development, save a match and an invalid event together; confirm the match is not left behind.
- [x] In development, delete a team that has events against an opponent; confirm opponent totals are reversed.
- [x] In development, switch to an archived season and confirm direct REST writes are rejected.
- [x] Export and validate a fresh **production** JSON backup before touching production.
- [x] Run `supabase/integrity-migration.sql` in the **production** project.
- [x] Re-run the anonymous write and anonymous RPC checks in production.
- [x] Commit, push `main`, move the `prod` tag and verify the live `v3.5.0` badge/assets.
- [x] Re-run the public smoke test: production reads 1 season / 6 teams / 9 players / 9 matches / 1 event; 6 standings rows and 9 fixtures render.
- [x] After the migration, test the admin archive/restore, atomic match-save and safe team-delete flows on the live production site (production admin session, temporary rows, all removed afterwards).

### Vendored client release (v3.5.1)

- [x] Confirm the "Supabase is not configured yet" message was caused by a blocked CDN, not by `js/config.js`.
- [x] Copy `@supabase/supabase-js@2.118.0` into `vendor/` with its MIT license.
- [x] Point `index.html` at `vendor/supabase-js-2.118.0.js` and drop the jsdelivr preconnect.
- [x] Add the `authLibraryMissing` message (EN/FR/AR) so a missing client is not reported as missing configuration.
- [x] Re-run `node --check`, `npm run check:secrets` and `npm run test:sql`.
- [x] Commit, push `main` and move the `prod` tag.
- [x] Verify the live site loads the vendored client and signs in with the production database.

### v3.4.6 bug-fix release

- [x] Add formula-injection protection to in-app CSV exports and `tools/backup-to-csv.js`.
- [x] Add matching unescape logic to `tools/csv-to-backup.js` and a UTF-8 BOM to generated CSVs.
- [x] Add the missing `btnAddPlayer` translation and the new validation/confirmation strings in EN/FR/AR.
- [x] Reject empty team/player names and block transfers when the player already has match events.
- [x] Use a Blob for JSON exports and guard optional Lucide rendering.
- [x] Update local-server documentation to `node tools/serve.js`.
- [x] Commit, push `main`, move the `prod` tag and verify the live `v3.4.6` badge/assets.

### Atomic import migration (v3.4.5)

- [x] Run the initial `supabase/atomic-import-migration.sql` in development and production.
- [x] Re-run the patched migration (`DELETE ... WHERE id IS NOT NULL`) in **development** and confirm it live.
- [x] Re-run the patched migration in **production**.
- [x] Confirm an admin no-op import succeeds through `replace_all_data` only in development and production.
- [x] Submit an invalid import with no seasons; production rejected it and left every count unchanged.
- [x] Submit an invalid event import; both projects rejected it, the test row was absent, and counts/hashes were unchanged.
- [x] Confirm an anonymous `replace_all_data` call returns `401` / `42501` in both projects.
- [x] Confirm the post-import hash matches the pre-import state in development and production.
- [x] Export a fresh production backup after the live import.
- [ ] Decide whether to keep the single event that appeared during the live test window.

## 7. Recommended next work

### P0 — finish this release

- Sign in on the live production site and repeat the archive/restore, atomic match-save and safe team-delete checks with temporary data.
- Load the real league data into development, verify standings, fixtures and squads, then import into production.
- Keep the fresh production backup and export another one immediately before the production import.
- Re-run the final anonymous/RLS checks after the import.

### P1 — data integrity

- [x] Replace client-side `dbReplaceAll` with one transactional `replace_all_data(jsonb)` RPC (installed and live-tested in production).
- Add an audit log, soft delete and restore.
- Add database `CHECK` constraints for scores, names, colours and dates.
- [x] Add a SQL/RLS suite with PGlite and run it in CI.
- Add a Playwright smoke test (public read, login, admin save, archive, import).

### P2 — product and operations

- Admin MFA and step-up authentication for destructive actions.
- Strict Content Security Policy and removal of inline handlers.
- Per-season player statistics and transfer/registration history.
- Real-time live match updates.
- PWA offline read-only mode and shareable match cards.

See [SECURITY_AUDIT.md](SECURITY_AUDIT.md) and [MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md) for the detailed plans.

## 8. How to work on the project

```powershell
# Local preview (from the repository root)
node tools/serve.js
# then open http://localhost:8765

# Rebuild Tailwind after changing classes
npm.cmd run build:css

# Validate CSV data and build an import file
node tools/csv-to-backup.js

# Validate committed source for privileged secrets
npm.cmd run check:secrets
```

See the root [README](../README.md) for setup, CSV columns and deployment details.

## 9. Session note (2026-10-22): waiting on real data

Real league data is still not available, so the app was polished instead of imported.

Shipped in `e23ffbe` (on `main`, not yet released as a new tag):

- **PPG column** in the standings table (points per game, visible from `md` up) with the empty-state colspan updated.
- **LIVE badge pulse** using a pinging dot so in-progress matches stand out at a glance.

Synthetic test data for future import rehearsals:

- `backups/synthetic-league-full.json` (gitignored, local only) — 1 season, 6 teams, 18 players, 6 finished matches, 20 events. Generated from the five-CSV workflow via `node tools/csv-to-backup.js`, so it exercises the same path as real data.
- The intermediate CSV folder (`data/synth/`) was removed; it can be regenerated from the backup if needed.
- Nothing was imported into development or production. Both databases are unchanged from the `v3.5.1` baseline (`435a86dbcb7d69161f16fcfefef172ff703b0a6b9169a6ada027d879e6c80f54` for production).

Next up: either continue the UX polish backlog (shareable filter URLs, "clear filters", empty states with CTAs, match timeline grouping, accessibility/focus states) or import the synthetic backup into development as a rehearsal and delete it afterwards.

## 10. UX polish release (v3.6.0)

Shipped on `main` after the small standings/LIVE tweaks. All of it is read-only friendly: no database changes, no migrations, no production data touched.

### Shareable views
- The current view is mirrored into the query string with `history.replaceState` (no history spam): `tab`, `season`, `round`, `status`, `q`.
- Defaults are stripped so ordinary URLs stay clean; `env` and any other existing parameters are preserved.
- Opening a shared URL restores the tab, season, both fixture filters and the squad search.
- `applyUrlState()` consumes the state captured at page load, so the first render pass cannot erase it before the data arrives.
- New **Copy link** button in the fixtures header copies the filter-aware URL and confirms with a toast (with a `execCommand` fallback for blocked clipboard permissions).

### Filters and empty states
- New **Clear filters** button appears only while a fixture filter is active.
- Fixtures now distinguish two empty states: "No fixtures yet" (with an admin CTA to log the first match) and "No matches for these filters" (with a clear-filters CTA).
- Empty standings and empty squads show a short hint plus an admin CTA.
- A squad search with no hits shows a "no results" card with a clear-search button instead of a blank grid.
- The soonest upcoming fixture gets a subtle green border and a **Next up** badge.

### Match timeline
- Goals and cards render as one chronological timeline (minute, ball/card marker, player, team code) instead of two grouped chip rows.
- Header line summarises the match: `2 goals · 1 card`, with singular/plural handling in all three languages.
- Screen readers get the event type via an `sr-only` label; the visual marker is `aria-hidden`.
- Finished matches without recorded detail show a muted admin-only nudge to add events.

### Top scorers leaderboard
- New card under the league table ranks the top five goalscorers with rank, club colour, club code and total.
- Labelled **All-time**, because player totals are career totals and are not season-scoped.
- Archived players are excluded; empty state reads "No goals scored yet."

### Accessibility and interaction
- `Escape` closes the topmost dialog and focus returns to the element that opened it; `Tab` is trapped inside the open dialog.
- `aria-current="page"` marks the active tab (replaced an invalid `aria-selected` on plain buttons).
- Icon-only buttons in fixtures, squads and dialogs have `aria-label`/`title`.
- Data-settings dropdown exposes `aria-haspopup`, `aria-expanded` and `aria-controls`.
- Fixtures grid is `aria-live="polite"` so filter changes are announced.
- Icons created after the first render are re-hydrated via `refreshIcons()` (previously, filtering could leave empty icon slots).

### Verification
- `node --check` clean on `js/app.js`, `js/i18n.js`.
- Manual browser pass in the development project: URL round-trip, filter + clear, both fixture empty states, squad search empty state, timeline ordering (12', 38', 54', 77'), next-up badge, toast, dialog Escape/focus return, EN/FR/AR switch with RTL.
- Lighthouse on the local build: **Accessibility 100, Best Practices 100, SEO 100**.
- Tailwind rebuilt (`npm.cmd run build:css`) so new utility classes ship.
- No data imported or mutated: the in-memory test events used during the browser pass were never saved.

### Live deployment check
- GitHub Pages serves `v3.6.0` (`js/app.js?v=3.6.0`, badge `v3.6.0`).
- Production data is unchanged: 1 season, 6 teams, 9 players, 9 matches, 1 event; all matches keep `events_counted = false`.
- The single production event renders through the new timeline (`4' ⚽ Ethan Hunt`, TTN), top scorers render five rows, and the console is clean.
- `v3.6.0` tag created; the `prod` tag moved from `36d85c9` to `3be0967`.

## 11. Zero-CDN release (v3.6.1)

No database changes and no data touched; this is an asset and hardening release.

### Self-hosted assets
- **Lucide 1.60.0** now lives in `vendor/lucide-1.60.0.js`. The downloaded file was checked against the SRI hash that was already pinned in `index.html`
  (`sha384-7t6ugxIvI5KM451iZguW/w4WR9KsajFzrdbn/efIoggU1wLCUBTbdndWJwbkPFQP`) before the CDN tag was removed.
- **Inter 300..800** and **Cairo 400..800** are self-hosted variable woff2 files in `fonts/` (5 files, ~210 KB total), served by `css/fonts.css`.
  Only `latin`, `latin-ext` and `arabic` subsets are kept; `latin` Inter is preloaded. OFL license texts are included next to the files.
- The unpkg and Google Fonts `<link rel="preconnect">` hints are gone. Runtime requests now go only to this origin and Supabase.

### Content Security Policy
- `index.html` carries a CSP meta tag: `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data:`, `font-src 'self'`, `connect-src 'self' https://*.supabase.co wss://*.supabase.co`, `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`.
- `'unsafe-inline'` remains for script because the markup uses inline `onclick` handlers; removing those is the next hardening step.
- A compromised CDN can no longer inject script: no external script or style origin is allowed.

### Print styles
- Added an `@media print` sheet: hides navigation, banners, season bar, filters and admin controls, flattens the dark theme to black-on-white,
  keeps table headers repeating across pages and avoids breaking fixture/team cards mid-page.
- Intended use: print or save the current tab (table, fixtures or squads) as a PDF for club noticeboards.

### Verification
- Font faces report `loaded` for Inter (latin) and, in Arabic, Cairo (arabic + latin); `document.fonts.check()` passes for both families.
- Page resource origins during a development session: `http://localhost:8765` and the Supabase project only; no third-party requests.
- `BACKEND_READY = true`, data loads, login modal opens, Lucide icons all hydrate, console is empty.
- Lighthouse (local, en): Accessibility 100, Best Practices 100, SEO 100.
- `npm run check:secrets` and `npm run test:sql` still pass.
- Print sheet reviewed by applying it as an all-media stylesheet in the browser: white background, readable table header, no clipped cards.
