# KickOff Division — Modernization Plan

- **Status:** proposal
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
| Data | Supabase Postgres + PostgREST; RLS public read/admin write |
| Auth | Supabase Auth email + password; `profiles.role` |
| Realtime | Not used |
| Imports | Client-side validation plus atomic `replace_all_data(jsonb)` RPC; legacy fallback retained for older projects |
| CSV | Node tools + browser exports |
| Tests | JS syntax, CSV round trip, manual browser/Lighthouse checks |
| CI/CD | GitHub Actions validate workflow; GitHub Pages deploy |
| Observability | Browser console and Supabase logs only |

**Strengths:** small surface area, no build step for JS, easy to audit, cheap, portable data.

**Weaknesses:** string-built UI, no type system, no component boundary, no automated browser/DB tests, atomic import dry-run pending, no audit trail, no realtime.

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

- Apply `match-events-migration.sql` in development, test, then production.
- ✅ Add the atomic import RPC and switch the UI to it (development and production no-op/rollback passed).
- Add audit logging and soft delete for matches, players, teams and seasons.
- Add MFA for admins and enforce `aal2` on write RPCs.
- Remove inline handlers; introduce event delegation.
- Add strict CSP and self-host Supabase JS/Lucide/fonts (or keep pinned SRI with a tight allowlist).
- Add CSV formula-injection protection.
- Add a Playwright smoke test: public read, login, admin edit, event add/remove, import dry-run.
- Add a pgTAP/RLS test for anon/viewer/admin.

**Success metrics:**

- Invalid import leaves the database unchanged.
- Password-only admin cannot write.
- No inline script executes under CSP.
- CI catches a broken RLS policy and a broken admin flow.

### Phase 1 — Trustworthy data platform (2–6 weeks)

**Goal:** the league can be run for a full season without fear of corruption.

- Add `CHECK` constraints and server-side JSON validation.
- Enforce archived-season immutability in the database.
- Add `updated_at`/version columns and optimistic concurrency.
- Add idempotency keys to imports and destructive actions.
- Move standings math into a SQL view/function with configurable tiebreakers.
- Add `player_season_stats` and `team_registrations` (transfer-aware).
- Replace team/player cascade deletes with RPCs that reverse event totals or archive history.
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
audit_log (id, actor_id, action, entity, entity_id, before jsonb, after jsonb, created_at)
```

- Triggers on all league tables.
- `deleted_at` on teams, players, matches and seasons.
- Views filter `deleted_at is null`.
- Admin-only restore RPC.
- Purge job after a retention window.

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

- Remove inline `on*` attributes.
- Use `data-action` + one delegated listener per view.
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

- Enforce MFA `aal2` for admin writes.
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
