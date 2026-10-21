# KickOff Division — Progress Update

- **Last updated:** 2026-10-21
- **Working-tree version:** `v3.4.5`
- **Deployed version:** `v3.4.5` (current `main`, tagged `prod`)
- **Live site:** <https://boulakdane.github.io/football-division-manager/>
- **Repository:** <https://github.com/Boulakdane/football-division-manager>

## 1. Status at a glance

| Area | Status | Notes |
|---|---|---|
| Public standings, fixtures and squads | ✅ Done | Works without login; shared across devices |
| Admin authentication and roles | ✅ Done | Supabase Auth; `admin` / `viewer`; signups disabled |
| Database-enforced permissions | ✅ Done | RLS policies plus admin-only RPCs |
| Multiple seasons and archive | ✅ Done | Archived seasons are read-only in the UI |
| CSV bulk entry and admin exports | ✅ Done | Five-file workflow including `events.csv` |
| JSON backup and restore | ✅ Done | Full replacement; development round-trip passed, production import pending |
| Atomic full-data import | ✅ Deployed and migrated | `replace_all_data(jsonb)` rolls back the entire import on any error; installed in development and production |
| Structured match events | ✅ Deployed, migrated and tested | Goals/cards with minutes, player dropdowns; RPCs and live production UI flow tested |
| Security hardening pass | 🟡 In progress | SRI, secret scanning, dependency updates, XSS helper |
| Production migration | ✅ Applied | `match_events` and `events_counted` exist with RLS and RPCs |
| Real league data | ⛔ Not started | Waiting for real teams, players, seasons and fixtures |

**Bottom line:** the core league manager is usable, publicly readable and `v3.4.5` is deployed. It adds an admin-only, single-transaction `replace_all_data(jsonb)` import RPC, now installed in both Supabase projects. Public filtering, language/RTL, login/logout, team/player CRUD, seasons, results, live score updates, CSV/JSON exports and the admin event flow have all been exercised live. A full JSON replacement import, including events, passed in development. The next step is to load the real league data into development, then import it into production only after a fresh backup.

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
| `players` | Global player records with cumulative goals/cards |
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
- Admin-only `create_season`, `activate_season`, `replace_match_events`, `delete_match` and `replace_all_data` RPCs.
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

## 4. Verification evidence

| Check | Result |
|---|---|
| `node --check` on all `js/*.js` and `tools/*.js` | Passed |
| CSV round trip with `data/examples` | Stable; 10 events preserved |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Lighthouse (local, mocked events) | Accessibility 100, Best Practices 100, SEO 100 |
| Lighthouse (production, v3.4.4) | Accessibility 100, Best Practices 100, SEO 100 |
| Browser smoke test | 9 fixtures render; no console errors after CDN/SRI load |
| SRI load test | Lucide and Supabase JS loaded with integrity checks |
| Inline-handler XSS test | Malicious ID rendered as a string literal; no execution |
| `npm run check:secrets` | No privileged secrets found |
| Production deploy | `v3.4.5` live; version badge and all asset URLs updated; 6 standings rows and 9 fixtures render; no console warnings/errors |
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
| Production JSON import | Not run: destructive full replacement; test with real data in development first |
| Historical flag RPC | `events_counted = false` stored an event without changing player totals in development and production |
| Production backup | Fresh JSON export validated: 1 season, 6 teams, 9 players, 9 matches, 0 events; no smoke data |
| Production backup after migration | `prod-backup-2026-10-21-post-atomic.json` matches the 2026-10-20 backup exactly; data unchanged |
| Admin RPC success path | Verified in development and production |

## 5. Current blockers and risks

1. **Real data is not loaded.** The app still contains sample fixtures and players.
2. **The atomic import admin path has not been exercised live since migration.** The RPC is installed in both projects, local rollback tests passed, and anonymous calls are denied. The next admin import should be treated as the live confirmation.
3. **Production full-replacement import is untested.** The atomic RPC makes it safer, but run the real backup in development first, then production with a fresh backup. Keep the previous production JSON export for rollback.
4. **Production and development differ.** For example, `m6` is 1–1 in development but 1–3 in production, and Karim Ziani has different card totals. Do not assume the environments are identical.
5. **Destructive edits still have data-integrity gaps.** Deleting a team cascades its matches and events without reversing other players' aggregate totals; deleting a player removes their historical events; a player transfer leaves old events attached to the former team. Keep a backup and prefer the planned RPC/soft-delete work.
6. **Operational gaps.** There is no audit log, MFA, automated RLS test suite or automated browser test yet. These are covered in the security and modernization plans.

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

### Atomic import migration (v3.4.5)

- [x] Run `supabase/atomic-import-migration.sql` in the **development** project SQL Editor.
- [x] Run `supabase/atomic-import-migration.sql` in the **production** project SQL Editor.
- [ ] Reload both apps and confirm an admin import still succeeds.
- [ ] Submit an intentionally invalid import and confirm every table is unchanged.
- [x] Confirm an anonymous `replace_all_data` call returns `401` / `42501`.
- [ ] Export a fresh production backup before the first real-data import.

## 7. Recommended next work

### P0 — finish this release

- Load the real league data into development, verify standings, fixtures and squads, then import into production.
- Keep the fresh production backup and export another one immediately before the production import.
- Re-run the final anonymous/RLS checks after the import.

### P1 — data integrity

- [x] Replace client-side `dbReplaceAll` with one transactional `replace_all_data(jsonb)` RPC (installed in both projects).
- Add an audit log, soft delete and restore.
- Add database `CHECK` constraints for scores, names, colours and dates.
- Add a SQL/RLS test suite and a Playwright smoke test.

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
python -m http.server 8765
# then open http://localhost:8765

# Rebuild Tailwind after changing classes
npm.cmd run build:css

# Validate CSV data and build an import file
node tools/csv-to-backup.js

# Validate committed source for privileged secrets
npm.cmd run check:secrets
```

See the root [README](../README.md) for setup, CSV columns and deployment details.
