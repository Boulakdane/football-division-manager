# Database review brief — for Gemini

**Purpose:** give an AI assistant enough context to recommend the right database/hosting for this project without access to the repository.

**How to use:** open Gemini and paste the *Prompt for Gemini* section below (or attach this whole file and add “review this project”). No credentials, personal data or API keys are included.

---

## Prompt for Gemini

> You are a senior backend/database architect reviewing a small, real-world sports league app. Recommend the best database and backend platform for it, with a migration plan from the current stack. Be concrete, compare options, and prioritise low cost and low operational burden. The current stack works; this is a “should we stay or move?” review, not a rewrite request.
>
> ### 1. What the app does
>
> “KickOff Division” is a football (soccer) league manager for a single amateur division. It is a static HTML/CSS/JavaScript site (no application server, no build-time backend) hosted on GitHub Pages. Visitors can browse standings, fixtures, results and squads without an account. A small number of admins (currently 1–2) sign in to manage seasons, teams, players, fixtures, goals and cards.
>
> Features:
> - Automatic standings (points, W/D/L, goal difference, form), fixtures by matchday, squads, top scorers.
> - Multiple seasons; one active season at a time; archived seasons are read-only.
> - Structured match events (goal, yellow card, red card) with minute and player, which update cumulative player totals atomically.
> - Full JSON export/import (backup and full replacement), plus CSV import/export using a five-file spreadsheet workflow.
> - Admin-only activity log (append-only audit trail with before/after snapshots).
> - Reversible deletes (“recently deleted” trash) for teams, matches and seasons.
> - Admin MFA (TOTP) with database-enforced step-up: once enabled, a password-only session cannot write.
> - Trilingual UI (English, French, Arabic with RTL). This is a frontend concern only.
>
> ### 2. Current stack
>
> - Frontend: static HTML/CSS/vanilla JS on GitHub Pages (free).
> - Backend: Supabase Free plan — two independent Postgres projects (production and development).
> - Auth: Supabase Auth, email + password; sign-ups disabled; admin role stored in a `profiles` table and promoted manually via SQL.
> - Data access: Supabase JS client over PostgREST. RLS is the security boundary.
> - Writes: most destructive/multi-row operations are `SECURITY DEFINER` Postgres RPCs (`save_match`, `delete_match`, `replace_match_events`, `delete_team`, `restore_*`, `replace_all_data`, MFA toggle).
> - Hosting cost target: €0/month if reasonable; willing to pay roughly $10–25/month only if there is a clear reliability or security benefit.
>
> ### 3. Data model (Postgres)
>
> - `profiles` — `id uuid` (FK to auth user), `email`, `role` (`admin` | `viewer`), timestamps.
> - `seasons` — `id text` PK, `name`, `start_date`, `end_date`, `is_active` (only one active, enforced by a partial unique index), `deleted_at` (soft delete).
> - `teams` — `id text` PK, `name`, `code`, `color`, `deleted_at`.
> - `players` — `id text` PK, `team_id` FK, `name`, `pos` (GK/DEF/MID/FWD), `num`, cumulative `goals`, `yellow`, `red`, `is_active` (archive flag), timestamp.
> - `matches` — `id text` PK, `season_id` FK, `round`, `home_id`/`away_id` FKs, `home_score`, `away_score`, `status` (SCHEDULED/LIVE/FINISHED), `datetime`, `venue`, `scorers_text` (legacy fallback), `events_counted` bool, `deleted_at`.
> - `match_events` — `id text` PK, `match_id` FK, `team_id` FK, `player_id` FK, `event_type` (goal/yellow/red), `minute` (1–130), timestamp.
> - `audit_log` — append-only, identity PK, `occurred_at`, `actor_id`, `actor_email`, `action`, `entity`, `entity_id`, `season_id`, `summary`, `before jsonb`, `after jsonb`; written only by triggers; readable only through an admin RPC.
> - `security_settings` — single row, `require_admin_mfa` bool, `updated_at`.
>
> Relationships are simple one-to-many. No joins beyond team/season lookups. No file storage or images today (team colours only). No geospatial data. No full-text search beyond an in-memory squad filter.
>
> ### 4. Security requirements (non-negotiable)
>
> - Public read of league tables; **no** public writes.
> - Only authenticated users with `role = 'admin'` may write; enforced by the database, not just the UI.
> - RLS policies must also hide soft-deleted rows from everyone, including admins (admins use a separate RPC to list/restore them).
> - Admin writes must be able to require a second factor (TOTP) at the database/API boundary, e.g. by checking the session assurance level (`aal2`) — not merely a UI prompt.
> - Audit log must be append-only and unreadable by anonymous users.
> - All writes must be attributable to an authenticated user.
> - Secrets used by the browser must be publishable/anon keys only; no service-role key in client code.
>
> ### 5. Current scale and realistic growth
>
> Current production dataset: **1 season, 6 teams, 9 players, 9 matches, 1 match event**. The full JSON export is **~6 KB**. The audit log has a few dozen rows.
>
> Realistic target (the actual league, not a global service):
> - **Typical:** 1 season, 8–16 teams, 150–350 players, 60–120 matches/season, 300–800 events/season; maybe 3–5 seasons retained.
> - **Busy:** 20 teams, 500 players, 200 matches/season, 2,000 events/season, 10 seasons archived.
> - **Traffic:** a few hundred to a few thousand page views per month; spikes on matchday. 1-3 admins editing. One full page load currently fetches the whole league (all tables) in parallel, paged at 1,000 rows per request.
> - **Writes:** tens to low hundreds per week. Audit log grows by roughly 1–3 KB per write.
> - No images, video, file uploads, chat, notifications, or high-frequency telemetry.
>
> ### 6. Current pain points / risks
>
> 1. Supabase Free has **no automatic backups** and pauses projects after about **7 days of low activity** (mitigated by a daily public-read backup and a 4×/day keepalive). Backups are validated JSON exports kept as CI artifacts / local files.
> 2. Free plan log retention is **1 day**, which limits incident investigation.
> 3. The RLS + RPC + MFA model is tightly coupled to Supabase/Postgres features. Moving to a non-Postgres or non-RLS platform would require re-implementing authorization in an API layer.
> 4. The browser talks directly to PostgREST; there is no custom API server. Any replacement must preserve this “static frontend + managed backend” shape or add serverless functions.
> 5. Vendor lock-in: auth users, RLS policies, triggers and RPCs are Supabase/Postgres-specific.
> 6. No session timeout / “sign out all devices” / login notifications on the Free plan (some are Pro-only features).
> 7. The whole league is fetched on each load (paged at 1,000 rows to avoid PostgREST's default cap). Archived seasons could be lazy-loaded later, but the payload is still small at the realistic scale.
>
> ### 7. Current Supabase Free limits (October 2026, for comparison)
>
> - 500 MB database per project, 5 GB egress, 5 GB cached egress, 1 GB file storage.
> - 50,000 monthly active users; unlimited API requests.
> - 2 active projects; projects pause after ~1 week of low database activity (a few requests per day are recommended).
> - No automatic backups; 1-day log retention; 200 concurrent Realtime connections.
> - Pro is from ~$25/month (includes 8 GB disk, 250 GB egress, daily backups, 7-day logs, no pausing, session timeouts/leaked-password protection).
>
> ### 8. What I want from you
>
> 1. **Verdict:** is Supabase Free sufficient for the typical and busy scenarios? If not, at what threshold should I move to Pro or another platform?
> 2. **Comparison:** evaluate at least these options against the requirements, using a table:
>    - Stay on Supabase (Free vs Pro)
>    - Neon (Postgres) + an auth/API layer
>    - Turso / libSQL
>    - Cloudflare D1 + Workers
>    - PlanetScale (MySQL/Postgres, if applicable)
>    - PocketBase (self-hosted or managed)
>    - Appwrite Cloud
>    - Firebase / Firestore
>    - Convex
>    - Any other option you think is a genuinely better fit
> 3. **Scoring criteria:** free-tier generosity, Postgres/SQL compatibility, row-level authorization, built-in auth + MFA, RLS-equivalent enforcement, backups/PITR, egress, cold starts/pausing, realtime (optional), vendor lock-in, migration effort, operational burden, and total 3-year cost at the “busy” scale.
> 4. **Recommendation:** one primary choice and one fallback, with reasoning. Explicitly say whether the current architecture can stay as-is.
> 5. **Migration plan (only if you recommend moving):** step-by-step for schema, auth users, RLS/RPC logic, MFA, audit triggers, backups, and a rollback path. Include effort estimate and the data-integrity checks to run before cutover.
> 6. **Cost guardrails:** what usage would trigger a paid tier, and what alerts/limits should be configured.
> 7. **Do not** recommend a platform that requires a custom server for basic CRUD/auth unless you explain the added operational cost and why it is justified.
>
> Please structure the answer as: **Verdict → Comparison table → Recommendation → Risks → Migration plan (if any) → Cost guardrails.** State assumptions explicitly and flag anything where current pricing or limits may have changed.

---

## Facts to keep the advice grounded

| Item | Value |
|---|---|
| Frontend hosting | GitHub Pages, static, €0 |
| Backend | Supabase Free, two projects (prod + dev) |
| Current production rows | 1 season / 6 teams / 9 players / 9 matches / 1 event |
| Full JSON export size | ~5.8 KB |
| Expected busy dataset | 20 teams / 500 players / 200 matches / 2,000 events per season |
| Expected traffic | hundreds–thousands of page views/month, matchday spikes |
| Admins | 1–3 |
| Writes | tens–low hundreds/week |
| Auth | Supabase email/password + TOTP MFA (`aal2`) |
| Security boundary | Postgres RLS + `SECURITY DEFINER` RPCs |
| Backups | Validated JSON export; daily GitHub Actions artifact (90 days) + 4×/day keepalive + local files |
| Budget | €0 preferred; up to ~$25/month if justified |
| Non-negotiables | public read, DB-enforced admin writes, MFA step-up, audit log, reversible deletes, static frontend |

## Notes for the human

- Do not paste real admin credentials into Gemini. The brief deliberately contains none.
- The current Supabase project URLs and publishable keys are public, but they are not needed for this review.
- If Gemini recommends a move, ask for a **phased** plan that keeps the app working on Supabase until the new backend passes the same RLS/MFA tests.
- The existing `tools/export-backup.js` output is a portable JSON snapshot, which makes any future migration easier.
