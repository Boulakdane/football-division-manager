# KickOff Division — Modernization Plan

- **Status:** proposal; the v3.5.x integrity and vendoring work is live in development and production
- **Horizon:** 6 months, delivered in small reversible releases
- **Constraints:** free hosting, no application server we operate, static frontend, Supabase free tier, separate HTML/CSS/JS files, trilingual EN/FR/AR with RTL, public read access, admin-only writes.

## 1. Goals

1. Make the league data trustworthy: imports, edits and deletions must be atomic, validated and recoverable.
2. Make the admin role hard to take over and easy to audit.
3. Make the frontend safe by construction, not by remembering to escape every string.
4. Make the experience feel like a modern sports product: fast, live, shareable, installable and accessible.
5. Keep the project free to host and simple enough for one maintainer.
6. Avoid a big-bang rewrite. Improve the current app behind tests and feature flags.

## 2. Non-goals

- Paid infrastructure or a custom backend we have to operate.
- Native mobile apps.
- Payments, betting or advertising.
- A full club-management ERP.
- Rewriting everything in a framework for its own sake.
- Storing service-role keys in the browser.

## 3. Current baseline

| Layer | Today |
|---|---|
| Frontend | Vanilla HTML/CSS/JS, classic scripts loaded in dependency order |
| Styling | Tailwind compiled locally into committed `css/tailwind.css` |
| Data | Supabase Postgres + PostgREST; RLS public read/admin write; RPC-only destructive writes; archived seasons read-only |
| Auth | Supabase Auth email + password; `profiles.role` |
| Realtime | Not used |
| Imports | Client-side validation plus atomic `replace_all_data(jsonb)` RPC; the non-atomic client fallback was removed (2026-10-24), so an import now fails closed if the migration is missing |
| History | `players.is_active` archive/restore; `save_match` atomic match + events; `delete_team` reverses opponent totals |
| CSV | Node tools + browser exports |
| Tests | JS syntax, CSV round trip, PGlite/Postgres integrity suite, manual browser/Lighthouse checks |
| CI/CD | GitHub Actions validate workflow; GitHub Pages deploy |
| Observability | Browser console and Supabase logs only |

**Strengths:** small surface area, no build step for JS, easy to audit, cheap, portable data.

**Weaknesses:** string-built UI, no type system, no component boundary, no automated hosted DB/browser tests, no audit trail, no team/match trash, no per-season stats, no realtime.

## 4. Target architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Static frontend (GitHub Pages / Cloudflare Pages)            │
│  • ES modules or Vite build (optional)                        │
│  • Design tokens + small component layer                      │
│  • Typed API client + Zod validation                          │
│  • Event delegation, no inline handlers                       │
│  • Strict CSP, SRI/self-hosted assets                         │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS
┌───────────────────────────▼──────────────────────────────────┐
│ Supabase                                                     │
│  • Auth + MFA                                                 │
│  • PostgREST + RLS                                            │
│  • SQL views/functions: standings, player stats, imports      │
│  • Realtime: live scores/events                               │
│  • Edge Functions (optional): import validation, rate limits  │
│  • Postgres: audit log, soft delete, constraints, migrations   │
└──────────────────────────────────────────────────────────────┘
```

### Design rules

- The database is the source of truth. The UI is a client, not the security boundary.
- Every write goes through a narrow, validated RPC or a table with explicit RLS.
- Every destructive action is auditable and reversible.
- Every release is deployable from `main` with one command.
- Prefer platform features over new dependencies.
- Keep the public read path fast and cache-friendly.

## 5. Sophisticated changes worth doing

| # | Change | Why it matters | Effort | Impact |
|---|---|---|---|---|
| 1 | Atomic `replace_all_data(jsonb)` import RPC | Eliminates partial wipes; enables dry-run and rollback | M | Very high |
| 2 | Audit log + soft delete + restore | Accountability and recovery for a role that can erase history | M | Very high |
| 3 | Admin MFA + `aal2` enforcement | Turns a stolen password into a dead end | M | Very high |
| 4 | Strict CSP + event delegation + Trusted Types | Removes the easiest XSS path and protects the admin session | L | Very high |
| 5 | SQL standings and player-stat views | One definition of truth; reusable by API/widgets | M | High |
| 6 | Per-season player stats + registrations | Fixes transfers and makes stats meaningful per season | L | High |
| 7 | Supabase Realtime live match mode | Live scores without polling; a genuinely modern UX | M | High |
| 8 | PWA read-only offline cache | Works on poor connections at the pitch | M | Medium |
| 9 | Typed data layer (JSDoc/TypeScript + generated types) | Catches schema drift and refactor errors | M | High |
| 10 | Versioned migrations + pgTAP RLS tests | Makes schema changes reviewable and safe | M | High |
| 11 | Playwright + axe + Lighthouse CI | Prevents regressions in auth, RLS, accessibility and performance | M | High |
| 12 | Multi-competition data model | Opens the door to cups, divisions and multiple leagues | L | Strategic |
| 13 | Optimistic concurrency + idempotency keys | Prevents two admins overwriting each other | S | High |
| 14 | Public read-only API + embeddable widgets | Lets local media/sites show standings | M | Strategic |
| 15 | Design system + motion tokens | Consistent, accessible, faster UI work | M | Medium |

Effort: S = days, M = 1–3 weeks, L = 3–6 weeks.

## 6. Phased roadmap

### Phase 0 — Stabilize the current release (0–2 weeks)

**Goal:** the match-events release is safe to deploy and the worst data-loss path is closed.

- ✅ Apply `match-events-migration.sql` in development, test, then production.
- ✅ Add the atomic import RPC and switch the UI to it (development and production no-op/rollback passed).
- ✅ Add player archive/restore, database-enforced archive reads, RPC-only destructive writes and atomic `save_match` in the working tree.
- ✅ Apply `integrity-migration.sql` in development, test, then production.
- ✅ Add audit logging (`v3.7.0`).
- ✅ Add soft delete and restore for matches, teams and seasons (`v3.8.0`).
- ✅ Add MFA for admins and enforce `aal2` on write RPCs (`v3.9.0`; opt-in, SQL migration pending in both hosted projects).
- ✅ Remove inline handlers; introduce event delegation (`v3.6.2`: 85 handlers → `data-*` actions + one dispatcher per event type).
- ✅ Add strict CSP and self-host Supabase JS/Lucide/fonts (or keep pinned SRI with a tight allowlist).
  - ✅ Self-hosted: Supabase JS (`vendor/`), Lucide (`vendor/`) and Inter/Cairo woff2 (`fonts/`). CSP meta now ships `script-src 'self'` with no `'unsafe-inline'`; `style-src` keeps it only for inline team colours.
- ✅ Add CSV formula-injection protection.
- ✅ Add a PGlite SQL/RLS suite for anon/admin, archive locks, atomic saves and safe deletes; run it in CI.
- Add a Playwright smoke test: public read, login, admin edit, event add/remove, import dry-run.

**Success metrics:**

- Invalid import leaves the database unchanged.
- Password-only admin cannot write.
- No inline script executes under CSP.
- CI catches a broken RLS policy and a broken admin flow.

### Phase 1 — Trustworthy data platform (2–6 weeks)

**Goal:** the league can be run for a full season without fear of corruption.

- Add `CHECK` constraints and extend server-side JSON validation.
- ✅ Enforce archived-season immutability in the database (pending hosted migration).
- Add `updated_at`/version columns and optimistic concurrency.
- Add idempotency keys to imports and destructive actions.
- Move standings math into a SQL view/function with configurable tiebreakers.
- Add `player_season_stats` and `team_registrations` (transfer-aware).
- ✅ Replace team deletion with `delete_team()` and archive players with events; match deletion already goes through `delete_match()`.
- Add a restore UI for soft-deleted records.
- Add encrypted backup guidance and a quarterly restore drill.
- Add statement timeouts and write-volume alerts.

**Success metrics:**

- A full season can be imported, edited and restored without manual SQL.
- Two concurrent admin edits produce a clear conflict, not a silent overwrite.
- Archived-season writes are rejected by the API.
- RLS tests run on every PR.

### Phase 2 — Modern match-day experience (6–12 weeks)

**Goal:** the app feels alive on match day and is pleasant on a phone at the pitch.

- Supabase Realtime for live scores and event timelines.
- Live match mode: clock, period, score, event feed, admin presence.
- Optimistic UI for score/event updates with rollback on error.
- PWA: installable, offline read-only cache of the last league snapshot.
- Share cards: generate an OG image for a match/result (serverless or static template).
- Deep links: `#/match/:id`, `#/team/:id`, `#/season/:id`.
- Command palette and keyboard shortcuts for admins.
- Undo toast for deletes; confirmation with typed team name for season deletion.
- Print/PDF match sheet and standings.
- Skeleton loaders, empty states and error boundaries.
- Real-time “last updated” indicator and reconnect banner.

**Success metrics:**

- A live match updates for spectators without a page refresh.
- The app is usable offline for reading the last snapshot.
- Share links open the correct match/team/season.
- Mobile Lighthouse performance stays above 90 on a mid-tier profile.

### Phase 3 — Scale and ecosystem (3–6 months)

**Goal:** support more competitions and let the data travel.

- Multi-competition model: `organizations`, `competitions`, `competition_seasons`, `venues`.
- Cup/bracket support and configurable tiebreakers.
- Public read-only API views and an embeddable standings/fixtures widget.
- JSON-LD (`SportsEvent`, `SportsTeam`), sitemap, canonical URLs, OG images.
- Player career pages with season-by-season stats.
- Head-to-head, form heatmaps and season comparison.
- Privacy-friendly analytics and Web Vitals RUM (with consent if required).
- Feature flags and remote config for gradual rollout.
- Optional TypeScript/Vite migration if the JS surface keeps growing.

**Success metrics:**

- A second competition can be created without schema surgery.
- An external site can embed standings with a small script.
- Search engines can index fixtures and results.
- A new maintainer can ship a change using the docs and tests.

## 7. Data model evolution

### 7.1 Atomic import

```sql
create or replace function public.replace_all_data(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_checksum text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can import data' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('kickoff:import'));

  -- Validate shape, IDs, references and ranges before deleting anything.
  -- Then delete + insert inside this single transaction.
  -- Return counts and a checksum for the UI/audit log.

  return jsonb_build_object('ok', true, 'checksum', v_checksum);
end;
$$;
```

Add a dry-run variant or a `p_dry_run boolean` argument that returns the diff without writing.

### 7.2 Standings as a database view

Move the standings calculation into SQL so the web app, an API consumer and a future widget all agree:

- `v_match_results`: finished matches with home/away points.
- `v_standings`: aggregated points, W/D/L, GF/GA/GD, form.
- Configurable tiebreakers: points, goal difference, goals scored, head-to-head, fair-play.
- Keep the JavaScript calculation as a fallback until the view is verified.

### 7.3 Season-aware player stats

The current `players.team_id` is a global “current team”. That loses transfer history. Add:

```text
team_registrations (id, season_id, team_id, player_id, shirt_number, joined_at, left_at)
player_season_stats (season_id, player_id, team_id, goals, assists, yellow, red, minutes)
match_player_stats (match_id, player_id, minutes, goals, assists, yellow, red, rating)
```

Then compute career totals as a view. This also makes `events_counted` less necessary because stats can be derived from events per season.

### 7.4 Richer match events

Extend `match_events` with:

- `period` (first half, second half, extra time, shootout)
- `stoppage_minute`
- `own_goal`, `penalty`
- `assist_player_id`
- `substitution_on/off`
- `description`

Use `minute` plus `stoppage_minute` for display (`45+2'`) without losing sortability.

### 7.5 Audit and soft delete

```text
audit_log (id, occurred_at, actor_id, actor_email, action, entity, entity_id, season_id, summary, before jsonb, after jsonb)
```

- ✅ Triggers on `teams`, `players`, `matches`, `match_events` and `seasons`, plus one `IMPORT` summary row per full import (`v3.7.0`).
- ✅ Admin-only read through `list_audit_log(p_limit)`; no client grants on the table.
- ✅ `deleted_at` on teams, matches and seasons (`v3.8.0`).
- ✅ RLS hides deleted rows from every client; admins read them through `list_deleted()`.
- ✅ Admin-only `restore_team` / `restore_match` / `restore_season` RPCs recalculate totals. A permanent purge job after a retention window is still optional.

## 8. Frontend architecture evolution

### 8.1 Keep it simple, but add boundaries

Current files are large. Split along seams without a framework:

```text
js/
  core/        config, supabase client, errors, env
  data/        repositories, row mappers, validation
  domain/      standings, events, seasons, stats
  ui/          render helpers, components, modals, toasts
  pages/       standings, fixtures, teams, admin
  app.js       composition root
```

Use ES modules and a single `<script type="module" src="js/app.js">` if browser support allows. Keep the compiled CSS pipeline.

### 8.2 Typed contracts

- Generate TypeScript types from Supabase (`supabase gen types typescript`).
- Add JSDoc `@typedef` if a full TypeScript migration is too much.
- Validate imports with Zod or a small schema module shared by browser and Node tools.
- Add a `schemaVersion` to JSON backups and a migration function for old backups.

### 8.3 Safe rendering

- ✅ Remove inline `on*` attributes (`v3.6.2`).
- ✅ Use `data-action` + one delegated listener per event type.
- Prefer `textContent`/DOM APIs over `innerHTML`.
- If templates remain, use one audited `html` tagged template that escapes by default.
- Add ESLint rules for `innerHTML`, `eval`, `new Function` and inline handlers.
- Enable Trusted Types after the refactor.

### 8.4 Design system

- Tokens: colour, spacing, radius, shadow, motion, typography.
- Components: button, badge, card, modal, table, empty state, toast, form field.
- States: hover, focus-visible, active, disabled, loading, error.
- Motion: short, purposeful, `prefers-reduced-motion` respected.
- Dark theme stays default; consider a light theme only if requested.

### 8.5 Internationalization

- Use `Intl.DateTimeFormat`, `Intl.NumberFormat` and `Intl.RelativeTimeFormat`.
- Add pluralization and interpolation instead of string concatenation.
- Keep language in the URL (`?lang=fr`) or a path prefix for shareable links.
- Add RTL visual regression tests.
- Translation QA checklist for EN/FR/AR.

## 9. Realtime and live match mode

- Supabase Realtime channel per active match or per season.
- Broadcast score/event changes from an admin RPC or Postgres changes.
- Spectators subscribe read-only; admins get presence indicators.
- Fallback to polling if Realtime is unavailable.
- Optimistic update + server confirmation + rollback on error.
- Show “live”, “reconnecting” and “last updated” states.
- Rate-limit event writes and debounce minute inputs.

## 10. PWA and offline

- Cache the app shell and the last successful league snapshot.
- Read-only offline mode by default.
- Admin drafts can be queued with idempotency keys, but never auto-apply destructive actions offline.
- Show a clear offline banner and a “sync pending” indicator.
- Add an install prompt and app icons.
- Never cache authenticated API responses in a shared cache.

## 11. Security and operations

- ✅ Enforce MFA `aal2` for admin writes (`v3.9.0`; opt-in until the migration is run and an admin enrols).
- Add step-up auth for imports, season deletion and reset.
- Add CSP, `nosniff`, frame protection and `Permissions-Policy` at the edge (Cloudflare Pages `_headers` or a proxy).
- Self-host third-party scripts and fonts.
- Keep SRI for any remaining CDN asset.
- Add audit log, soft delete, restore and retention.
- Add rate limits and statement timeouts.
- Add encrypted backups and a restore drill.
- Add dependency review, Dependabot and pinned GitHub Actions by SHA.
- Add a private vulnerability disclosure process (`SECURITY.md`).

## 12. Testing and CI

### Test pyramid

| Level | Tool | What it covers |
|---|---|---|
| Unit | Node test runner / Vitest | Standings, validation, CSV, event summaries |
| Database | pgTAP + Supabase local | RLS matrix, RPC permissions, constraints, audit triggers |
| Contract | Generated types + Zod | Row mapping and import schema |
| E2E | Playwright | Public read, login, admin CRUD, event editor, import dry-run |
| Accessibility | axe-core + manual | WCAG 2.2 AA, focus, RTL |
| Performance | Lighthouse CI | LCP/CLS/INP budgets, bundle size |
| Security | secret scanner, CSP test, XSS/CSV payloads | Regressions |

### CI pipeline

```text
checkout
  → secret scan
  → install
  → CSS build freshness
  → JS syntax / typecheck
  → unit tests
  → SQL lint / migration check
  → pgTAP RLS tests
  → Playwright smoke (against a preview Supabase project)
  → Lighthouse CI budgets
  → deploy preview
  → manual approval → production
```

### Release rules

- No schema change without a migration file and a rollback note.
- No destructive migration on production before development.
- No release without a fresh backup.
- No release with a failing security or accessibility check.
- Tag every production release and keep a changelog.

## 13. Observability

- Sentry (free tier) for frontend errors with PII scrubbing.
- Web Vitals RUM: LCP, CLS, INP, TTFB.
- Supabase logs/alerts for failed auth, RLS denials and slow queries.
- Uptime monitor for the public site and Supabase health.
- Import/export audit events.
- A simple status page or banner for Supabase outages.
- Alert on unusual write volume or repeated `42501` responses.

## 14. Performance and accessibility budgets

| Metric | Budget |
|---|---|
| LCP (mobile, mid-tier) | < 2.5 s |
| CLS | < 0.1 |
| INP | < 200 ms |
| Initial JS (compressed) | < 150 KB excluding Supabase |
| Lighthouse accessibility | 100 |
| Lighthouse best practices | 100 |
| Lighthouse SEO | 100 |
| WCAG | 2.2 AA |

Techniques:

- Split JS by view; load admin/editor code only when needed.
- Preload the critical CSS and the Supabase client; defer the rest.
- Subset and self-host fonts; use `font-display: swap`.
- Compress and lazy-load team/player images when added.
- Use content-hashed asset names for long-lived caching.
- Virtualize long tables if leagues grow beyond a few hundred rows.
- Add `aria-live` for score updates and save confirmations.
- Add a skip link, focus trap in modals and keyboard support for the event editor.
- Test with screen readers and RTL.

## 15. Multi-competition model (strategic)

If KickOff expands beyond one division:

```text
organizations (id, name, slug, owner_id)
competitions (id, organization_id, name, type: league|cup, slug)
competition_seasons (id, competition_id, name, start_date, end_date, is_active)
team_registrations (id, competition_season_id, team_id, player_id, ...)
venues (id, organization_id, name, address)
```

RLS becomes membership-based:

- Public read for published competitions.
- Admin write only for members of the organization.
- A super-admin role for platform operations.

This is a larger change; do it only when a second competition is a real requirement.

## 16. Public API and widgets (strategic)

- Read-only SQL views: `api_standings`, `api_fixtures`, `api_results`, `api_squads`.
- Stable JSON shape with a version field.
- Cache-friendly headers and ETags.
- Embeddable widget: a small script that renders standings into a container.
- JSON-LD for fixtures/results to improve search results.
- Rate-limit and monitor public API usage.

## 17. Migration strategy

1. **Strangler, not rewrite.** Keep the current app working while introducing modules and RPCs.
2. **Database first.** Add views/RPCs and test them before switching the UI.
3. **Dual-run.** Compute standings in JS and SQL and compare in development.
4. **Feature flags.** Ship behind `?features=...` or a config flag; remove the flag after verification.
5. **Backward-compatible data.** Keep old backup import support; add `schemaVersion` and migrations.
6. **Reversible migrations.** Prefer additive columns and views; avoid destructive `drop` until a later release.
7. **Production gate.** Development → preview/staging → production, with a fresh backup at each step.

## 18. Risks and trade-offs

| Risk | Mitigation |
|---|---|
| A framework/bundler adds complexity | Keep vanilla JS; introduce Vite/TS only when tests justify it |
| Supabase free-tier limits | Cache public reads, paginate, monitor usage, avoid polling |
| Realtime cost/complexity | Use per-match channels and a polling fallback |
| Migration downtime | Additive migrations, dual-run, maintenance banner |
| Two sources of standings truth | Compare JS and SQL in CI; remove one after verification |
| Admin lockout after MFA | Recovery codes and a documented SQL recovery path |
| CSP breaks inline styles | Move team colours to CSS variables or nonce-based styles |
| Over-engineering | Ship Phase 0 first; measure before Phase 2 |

## 19. First PRs to open next

1. `feat(db): add atomic replace_all_data RPC with dry-run` — RPC installed and live-tested in both environments; dry-run and real-data confirmation pending
2. `feat(db): add audit_log, soft delete and restore RPC`
3. `feat(auth): require MFA aal2 for admin writes`
4. `refactor(ui): replace inline handlers with event delegation`
5. `feat(security): self-host CDN assets and add strict CSP`
6. `feat(csv): neutralise spreadsheet formulas on export`
7. `test(db): add pgTAP RLS matrix`
8. `test(e2e): add Playwright public/admin smoke tests`
9. `feat(stats): add SQL standings view and per-season player stats`
10. `feat(realtime): add live match channel with polling fallback`

## 20. Definition of done for the modernization program

- [ ] A failed import cannot change production data.
- [ ] Every admin write is attributable and reversible.
- [ ] Password-only admin sessions cannot write.
- [ ] A strict CSP is enforced in production.
- [ ] No third-party JavaScript is required at runtime.
- [ ] RLS, unit, E2E, accessibility and Lighthouse checks run in CI.
- [ ] A full season can be imported, played, archived and restored without manual SQL.
- [ ] The app works read-only offline and updates live on match day.
- [ ] A new maintainer can ship a change using the docs and tests.
- [ ] The project still runs on free hosting.

## 21. Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-10-20 | Keep static frontend and Supabase | Meets free/zero-server constraint |
| 2026-10-20 | Add `events_counted` to matches | Avoid double-counting historical player totals |
| 2026-10-20 | Prefer atomic RPCs over multi-request client writes | Data integrity |
| 2026-10-20 | Keep the current vanilla stack until tests exist | Avoid a risky rewrite |
| 2026-10-20 | Add security work before flashy features | Admin role can erase the league |
| 2026-10-24 | Remove the non-atomic import fallback; revoke `anon` EXECUTE on season RPCs | A failed fallback could half-delete the league; defence in depth for admin RPCs |
| 2026-10-24 | Add reviewer proposals (section 22) | Independent code and security review; see section 22 for priorities |

## 22. Reviewer proposals (2026-10-24)

Added after an independent read of the code, SQL and workflows (see `SECURITY_AUDIT.md` for the findings this builds on). These complement sections 5–16 and avoid repeating them. Each proposal says what it removes or enables, how to prove it works, and where it fits in the phases.

### 22.1 Priority at a glance

| # | Proposal | Tier | Effort | Why now |
|---|---|---|---|---|
| A | Derive player and team totals from events instead of storing them | Data integrity | M | Removes the whole class of "totals drifted" bugs and the need for `events_counted` |
| B | Least-privilege roles: `scorer` for live match entry | Security | M | Lets more people help on match day without handing out `admin` |
| C | Security drift monitor in CI | Security | S | Catches a dashboard toggle (signups, MFA) silently flipping back |
| D | Tamper-evident audit log and off-site backup copy | Security | M | A compromised admin is the main residual risk; today the log lives in the same database it protects |
| E | Extract pure domain code into ES modules with Node tests | Maintainability | M | `js/app.js` is ~2,500 lines of globals; the first safe seam to cut |
| F | Fixture generator (round-robin scheduler) | Product | M | Biggest time saver for the person running a real league |
| G | Calendar feeds (`.ics`) and web push for followed teams | Product | M | Matches how people actually follow local football |
| H | Merge import with a diff preview | Data integrity | M | Replaces "wipe everything" as the normal bulk path |
| I | Team crests and photos with a safe upload path | Product / security | M | Looks modern; must not reopen XSS or privacy holes |
| J | Privacy and retention policy for player data | Compliance | S | Many local leagues include minors; names are public by design |

Suggested order: **C → A → B → E → H → D → F → G → I → J.** C is a day of work and protects what is already deployed; A and B change the data model and should land before real league data is loaded.

### 22.2 A — Derive totals from events

**Today:** `players.goals / yellow / red` and match scores are stored values that RPCs (`save_match`, `delete_match`, `delete_team`, `restore_*`) must adjust by hand, and `matches.events_counted` exists to avoid double counting. Every new write path is another place to get the arithmetic wrong.

**Proposal:**
- Make `match_events` the single source of truth for goals and cards.
- Replace the stored columns with views: `v_player_stats(season_id, player_id, goals, yellow, red)` and `v_standings` (see 7.2).
- Keep a nullable `legacy_goals / legacy_yellow / legacy_red` offset only for historical rows imported without events, then drop `events_counted`.
- Add a CHECK-style guard (trigger or RPC validation) that a finished match's score equals the goal events for each side whenever events exist; otherwise reject with a clear message.

**Prove it:**
- PGlite test: every existing RPC leaves `v_player_stats` equal to a recomputation from raw events (property-style, random operation sequences).
- The scale rehearsal from `PROGRESS.md` section 21 still round-trips with an identical hash.
- Dual-run in development: the UI shows both the old and new totals and logs any difference before the old columns are removed.

**Risk:** views over thousands of events are cheap, but index `match_events (match_id)` and `(player_id)` and confirm the read path stays well under the Lighthouse budget.

**Delivered (2026-10-25):** three stages. #13 added the non-null `legacy_*`
offsets, the four views and `set_player_totals()`; #14 switched the app to read
`v_player_stats` and to save through the RPC. `drop-stored-totals-migration.sql`
then backfills `legacy_* = stored total - counted events` and drops
`players.goals / yellow / red`. Two deviations from the proposal above:

- `legacy_*` is **not nullable**: a missing value means zero history, and that
  keeps every arithmetic expression simple.
- `matches.events_counted` **stays**. The pre-events fixtures have it `false`
  and their goals live only in `legacy_*`; dropping the flag would count any
  later event detail twice, and `set_player_totals()` would then refuse the
  correction because a total cannot sit below its counted events. It is the
  per-fixture "already inside the legacy offset" marker, not a second totals
  store.

The score-vs-events CHECK guard from the proposal is **not** included: the app
validates the score while saving, and a hard database rule would reject
legitimate corrections to historical fixtures whose timeline is incomplete. It
remains a candidate follow-up.

### 22.3 B — A `scorer` role for live match entry

**Today:** the only privileged role is `admin`, and an admin can replace the whole dataset. Match day needs several helpers entering goals and cards.

**Proposal:**
- Add `app_role = 'scorer'` and a `match_officials (match_id, user_id)` assignment table.
- New RPC `record_live_event(match_id, event)` that a scorer may call only for an assigned match that is `LIVE` or scheduled today, in the active season, and only for goal/yellow/red inserts and removals within a short undo window.
- Scorers cannot edit teams, seasons, imports or other matches; `is_admin()` stays unchanged.
- Admin-only RPC to grant and revoke roles, writing an audit row, replacing "promotion is manual SQL".
- Require MFA for scorers too if it is practical, otherwise keep their reach small enough that a stolen scorer password is a nuisance, not a disaster.

**Prove it:** extend the RLS/RPC matrix test so a scorer gets `42501` on every admin RPC and on unassigned matches, and the audit log records the actor for every event.

### 22.4 C — Security drift monitor

Some protections live in the Supabase dashboard and cannot be seen in the repo (signups disabled, email confirmation, MFA requirement). Add a scheduled workflow that fails loudly if any of them changes:

- `GET /auth/v1/settings` (public, already used by `loadAuthSettings`) must report signups disabled for production.
- `rpc/admin_mfa_required` (public) must return `true` for production.
- A probe with the anon key must receive `42501` or a permission error from each admin RPC (`create_season`, `activate_season`, `replace_all_data`, `save_match`, `list_audit_log`) and an empty result for direct writes.
- Expected values live in a small `tools/check-security-drift.js`, reusing `tools/supabase-config.js`; the workflow runs daily next to the keepalive and opens an issue (or fails) on mismatch.
- Anon probes must use obviously invalid arguments and never send a write that could succeed.

**Done when:** flipping signups back on in a test project turns the next run red.

### 22.5 D — Tamper-evident log and off-site copy

- Add `prev_hash` and `row_hash` to `audit_log` (hash of the previous row plus the new row's canonical JSON), computed in the existing trigger. A periodic job re-verifies the chain, so an edit or deletion of history by someone with database access is detectable.
- Publish the latest chain head with each daily backup. The backup workflow already exports data; also keep the artifact somewhere the Supabase admin cannot rewrite, such as a private repository, a release asset or an encrypted object store. Note that artifacts on a public repository can be downloaded by any signed-in GitHub user and expire after 90 days.
- Encrypt backups at rest (age or GPG with a key held outside the repo) before they leave CI, and document the restore path in `docs/PROGRESS.md`.

**Done when:** a restored backup plus the log's hash chain proves the sequence of changes, and a quarterly restore drill from the off-site copy is on the calendar.

### 22.6 E — Extract pure domain code into ES modules

`js/app.js` is about 97 KB of global functions sharing one mutable `appState`, with 27 `innerHTML` render sites. A rewrite is not needed; cut along the seams that are already pure:

1. Move `esc`, `toInt`, `csvEscape`, `contrastTextColor`, `calculateStandings` and the event-summary helpers into `js/domain/*.js` as ES modules with no DOM access.
2. Load them with `<script type="module">` (CSP `script-src 'self'` already covers it), keeping classic scripts for the rest until each piece is moved.
3. Run the same modules under `node --test` in CI, with fixtures for tiebreakers, postponed matches, empty seasons and RTL names.
4. Replace direct `innerHTML` assignment with one `renderInto(element, html)` helper plus an ESLint rule (`no-restricted-syntax` on `innerHTML`) so every new render path is forced through the audited escape function.
5. Only then consider TypeScript or JSDoc types, starting with the domain modules.

**Done when:** standings logic has unit tests that run without a browser, and the JS and SQL standings can be compared in CI (section 17, "dual-run").

### 22.7 F — Fixture generator

Running a league means building 100+ fixtures by hand. Add an admin tool that produces a full schedule:

- Single or double round-robin using the circle method, with bye rounds for an odd number of teams.
- Home/away balancing so no team has more than two consecutive home or away games.
- Constraints: venues, kick-off slots, blackout dates, minimum rest days between a team's games.
- Preview before saving, then insert through one atomic RPC (reuse the import validation) so a bad schedule never half-applies.
- Rescheduling helper that shifts later rounds after a postponement.

**Done when:** a 20-team double round-robin generates in under a second, passes the same invariants the import validator enforces, and every team plays every other exactly twice.

### 22.8 G — Calendar feeds and push notifications

- Per-team and per-competition `.ics` feeds generated from the public read views (a static file refreshed by a GitHub Action after data changes, or a small Edge Function), so fixtures appear in the user's own calendar app.
- Optional web push for "my team" kick-off reminders and final scores, with the subscription stored per device and no personal account required.
- "Follow a team" kept in `localStorage` on the device; never put follower lists in the public database.
- Respect `prefers-reduced-motion` and offline mode from section 10; never cache authenticated responses.

### 22.9 H — Merge import with a diff preview

`replace_all_data` is safe but blunt. Add a second mode that compares an uploaded backup with the live data and shows what would be added, changed and removed per table before anything is written:

- `import_preview(payload)` returns counts and a per-entity diff without writing.
- `import_merge(payload, idempotency_key)` upserts by id inside one transaction and never deletes unless the admin ticks an explicit "remove missing rows" box.
- Store a checksum and the key in an `import_runs` table, so retrying the same upload cannot apply twice.
- Keep `replace_all_data` for disaster recovery, behind step-up MFA and a typed confirmation.

This closes the open acceptance items in `SECURITY_AUDIT.md` SEC-03 (dry-run summary, idempotency key, confirmation with counts).

### 22.10 I — Team crests and player photos

- Store images in Supabase Storage with an admin-only write policy and public read.
- Accept PNG/JPEG/WebP only; **do not accept SVG uploads** (script and external-reference risk). Re-encode and resize server-side or in the browser before upload, and strip metadata (EXIF location).
- Keep the CSP's `img-src` to this origin plus the project's storage host; no hotlinking.
- Photos of players are personal data; make them opt-in and see 22.11 first.

### 22.11 J — Privacy and retention

- Document what personal data the site publishes (names, shirt numbers, goals and cards) and who may request correction or removal.
- Add a small "request removal or correction" path and an admin action that anonymises a player (for example to "Player 12") without deleting their history. Check the local data-protection rules that apply to your leagues, such as Algeria's Law 18-07, and the GDPR if you have EU visitors.
- Treat youth leagues as higher risk: consider initials or first names only, and no photos.
- Define retention: how long soft-deleted and archived records, audit rows and backups are kept, and who can purge them.

### 22.12 Mapping to the phases

| Phase | Add these proposals |
|---|---|
| Phase 1 — Trustworthy data platform | C, A, B, H (D as the log hardening step) |
| Phase 2 — Modern match-day experience | E (as the enabling refactor), F, G |
| Phase 3 — Scale and ecosystem | I, J, and the multi-competition work in section 15 |

### 22.13 Open questions for the maintainer

1. Will more than one or two people enter results on match day? If yes, B moves to the top.
2. Are any leagues youth or school leagues? If yes, J and the photo policy in I come before any photo feature.
3. Is a second competition expected within a year? If not, skip section 15 and spend that time on A, F and G.
4. Is there a budget for a custom domain and Cloudflare in front of GitHub Pages? Real response headers (`frame-ancestors`, `Permissions-Policy`) remove the last CSP gaps listed in `SECURITY_AUDIT.md` SEC-02 and SEC-08.
