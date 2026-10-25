# ⚽ KickOff Division

A lightweight, responsive league manager for local football divisions and amateur
tournaments. The frontend is pure HTML/CSS/JS hosted free on GitHub Pages; data and
accounts live in a free [Supabase](https://supabase.com) project.

## Features

- **Automatic standings** — points, W/D/L, goals for/against, goal difference, points
  per game and last-5 form. The table is recalculated instantly whenever a result changes.
- **Fixtures & results** — schedule matchdays, log live scores, and mark matches as
  finished. Duplicate fixtures on the same matchday are rejected. The soonest upcoming
  match is highlighted, and matchday/status filters can be cleared in one click.
- **Goals & cards with minutes** — log each goal, yellow card and red card against a
  player from the correct team, with the minute. Each fixture card shows a chronological
  match timeline and a per-match goal/card summary.
- **Shareable views** — the active tab, season, filters and squad search live in the URL,
  so a copied link reopens exactly what you were looking at. A **Copy link** button does
  this for you.
- **Top scorers** — an all-time leaderboard under the league table ranks the top five
  goalscorers with their club and total.
- **Multiple seasons** — create a new season, switch between active and archived
  seasons, and keep every past table and fixture intact. Archived seasons are
  read-only in both the UI and the database until an admin makes them active again.
- **Teams & squads** — create/edit clubs, add players with positions, squad numbers,
  goals, yellow and red cards. Players with history can be archived and restored
  without losing their events.
- **Trilingual UI** — English, French and Arabic, with automatic RTL layout for Arabic.
- **Real accounts & roles** — Supabase Auth with email + password. Spectators browse
  without an account; only users with the `admin` role can add, edit or delete.
- **Database-enforced permissions** — Postgres Row Level Security blocks writes from
  non-admins even if they tamper with the page or call the API directly.
- **Two-factor authentication** — admins can enrol any TOTP authenticator app. When the
  requirement is enabled, the database rejects writes from password-only (`aal1`)
  sessions, so a stolen password is not enough to change the league.
- **Account recovery & idle logout** — request a password-reset link from the login
  dialog; a successful reset signs out every existing session. Signed-in sessions end
  after 30 minutes without activity.
- **Sign out everywhere** — admins can revoke every refresh token, including on other
  devices, from the settings menu.
- **Shared data** — every visitor sees the same league, from any device.
- **Activity log** — admins see the last 50 changes (adds, edits, deletes, restores,
  imports and security changes) with who made them, when, and before/after values. The
  log is append-only and invisible to spectators and other signed-in users.
- **Recently deleted** — teams, matches and seasons go to a trash instead of being
  destroyed; admins can restore them with their squad, events and totals intact.
- **JSON backup** — export/import the full dataset from the admin settings menu.
- **CSV tools** - export the current season's standings, fixtures and squads,
  bulk-build a league from five CSV files, or turn a JSON backup back into
  editable CSV files.
- **Squad import** - each team can fill a bilingual Excel/CSV template; the admin
  previews every row and adds the whole squad in one atomic step.
- **Live score shortcuts** — matches in `LIVE` state get `+` buttons on the fixture card.
- **Read-only demo mode** — until Supabase is configured, the site shows the sample
  league with all write controls hidden and a banner explaining how to connect it.

## Documentation

- [Progress update](docs/PROGRESS.md) — current release state, verification evidence,
  blockers and the next deploy checklist.
- [Security review and plan](docs/SECURITY_AUDIT.md) — threat model, findings,
  prioritised remediation and verification commands.
- [Modernization plan](docs/MODERNIZATION_PLAN.md) — phased roadmap and sophisticated
  data, security, UX and platform improvements.
- [Database review brief](docs/DATABASE_REVIEW_BRIEF.md) — self-contained prompt for an
  external review of the database/hosting choice, including current limits and scale.
- [Coordination guide](docs/COORDINATION.md) and [task board](docs/TASKS.md) — how AI coding
  tools (Claude Code, opencode) and the maintainer work in parallel; shared rules in
  [AGENTS.md](AGENTS.md).
- [Security policy](SECURITY.md) — how to report a vulnerability privately.

## Project structure

```
.
├── index.html                 # Markup only (header, views, modals, script tags)
├── css/
│   ├── tailwind.input.css     # Tailwind source file (build input)
│   ├── tailwind.css           # Compiled, minified stylesheet (committed)
│   └── styles.css             # Theme polish, fonts (incl. Arabic/RTL), motion
├── js/
│   ├── config.js              # ⚠️ Supabase URL + anon key (edit this)
│   ├── i18n.js                # EN/FR/AR dictionary, t(), language + RTL switching
│   ├── store.js               # In-memory state + demo/seed dataset
│   ├── backend.js             # Supabase client, reads, writes, row mapping
│   ├── auth.js                # Login/signup/recovery, idle logout, role-based UI
│   └── app.js                 # Rendering, standings math, modals, import/export
├── package.json               # Tailwind build and test scripts (dev-only dependencies)
├── playwright.config.js       # Chromium smoke-test configuration and local server
├── tailwind.config.js         # Tailwind theme (pitch palette, fonts, content)
├── data/
│   ├── README.md              # CSV column reference and workflow
│   └── examples/              # Template seasons/teams/players/matches/events CSV files
├── docs/
│   ├── PROGRESS.md            # Current status, blockers and release checklist
│   ├── SECURITY_AUDIT.md      # Findings, threat model and remediation plan
│   ├── MODERNIZATION_PLAN.md  # Phased roadmap and advanced improvements
│   └── DATABASE_REVIEW_BRIEF.md # Prompt for an independent database review
├── tools/
│   ├── csv-to-backup.js       # Validate CSVs and build an importable JSON backup
│   ├── backup-to-csv.js       # Turn a JSON backup into editable CSV files
│   ├── export-backup.js       # Export public data without an admin session
│   ├── validate-backup.js     # Check structure and referential integrity
│   ├── restore-drill.js       # Restore a backup into in-memory Postgres and compare
│   ├── backup-map.js          # Shared camelCase ⇄ database row mapping
│   ├── keepalive.js           # One public read to prevent Free-tier pausing
│   ├── check-secrets.js       # Fail CI if a privileged secret is committed
│   └── agent-status.js        # Show in-flight branches and overlapping files
├── tests/
│   └── e2e/
│       └── public.spec.js     # Public read, FR/AR, RTL and login-dialog smoke test
├── vendor/
│   ├── lucide-1.60.0.js       # Icon set (ISC) served from this origin
│   └── supabase-js-2.118.0.js # Supabase client (MIT) served from this origin
├── fonts/                     # Self-hosted Inter + Cairo woff2 (OFL) and licenses
├── SECURITY.md                # Private vulnerability reporting policy
└── supabase/
    ├── schema.sql                   # Tables, RLS policies, triggers and seed data
    ├── seasons-migration.sql        # Upgrade an existing database to seasons
    ├── match-events-migration.sql   # Upgrade an existing database to match events
    ├── atomic-import-migration.sql  # Install the one-transaction full-data import RPC
    ├── integrity-migration.sql      # Archive players, lock archived seasons and make deletes safe
    ├── audit-log-migration.sql      # Trigger-fed, admin-only audit log + Activity log panel
    ├── soft-delete-migration.sql    # Trash + restore for teams, matches and seasons
    ├── mfa-migration.sql            # Database-enforced admin two-factor requirement
    ├── check-constraints-migration.sql # Reject malformed names, colours, scores and dates
    ├── add-players-migration.sql    # Install add_players() for Excel/CSV squad import
    ├── scheduled-match-events-migration.sql # Count events already saved on upcoming fixtures
    └── derive-totals-migration.sql # Legacy offsets + event-derived player/standings views (roadmap A)
```

Scripts are loaded in dependency order in `index.html`:
`i18n.js` → `store.js` → `config.js` → `backend.js` → `auth.js` → `mfa.js` →
`squad-import.js` → `app.js` (all `defer`red). Keep that order if you add modules.

The Supabase client is served from `vendor/supabase-js-2.118.0.js` (same
origin, pinned version, MIT license included) rather than a CDN, so a
blocked third-party host can no longer drop the app into read-only demo
mode and break admin sign-in. Lucide icons (`vendor/lucide-1.60.0.js`) and
the Inter/Cairo webfonts (`fonts/`) are self-hosted for the same reason, and
`index.html` ships a Content-Security-Policy that allows only this origin
plus Supabase.

## Setup: connect Supabase (5 minutes, free)

### 1. Create the project

1. Sign up at <https://supabase.com> and create a **New project** (free tier:
   500 MB database, 50,000 monthly active users).
2. Wait for provisioning, then open **SQL Editor → New query**.
3. Paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   This creates the tables, trigger and Row Level Security policies, and inserts the
   sample league (delete the seed block if you want to start empty).

> **Upgrading an existing project?** Run the migrations in order, once each, in the
> SQL Editor:
>
> 1. [`supabase/seasons-migration.sql`](supabase/seasons-migration.sql) — if the
>    database predates multiple seasons. It adds the `seasons` table, links existing
>    fixtures to a default season, and installs the season functions.
> 2. [`supabase/match-events-migration.sql`](supabase/match-events-migration.sql) —
>    adds goals/cards with minutes, RLS policies and the atomic event functions.
> 3. [`supabase/atomic-import-migration.sql`](supabase/atomic-import-migration.sql) —
>    installs the admin-only `replace_all_data(jsonb)` RPC so a full JSON import
>    either commits completely or leaves every table unchanged. The frontend uses
>    only this RPC; if the migration is missing the import fails closed instead of
>    falling back to a non-atomic table-by-table write.
> 4. [`supabase/integrity-migration.sql`](supabase/integrity-migration.sql) —
>    adds player archiving, makes archived seasons read-only in the database, installs
>    the atomic `save_match` and safe `delete_team` RPCs, and protects players with
>    match history from hard deletion.
> 5. [`supabase/audit-log-migration.sql`](supabase/audit-log-migration.sql) —
>    creates the append-only `audit_log` (triggers on teams, players, matches,
>    events and seasons) and the admin-only `list_audit_log()` RPC used by the
>    **Activity log** panel.
> 6. [`supabase/soft-delete-migration.sql`](supabase/soft-delete-migration.sql) —
>    turns deletion into a reversible trash for teams, matches and seasons. It adds
>    `deleted_at`, hides trashed rows through RLS, and installs `delete_season`,
>    `restore_team`, `restore_match`, `restore_season` and `list_deleted()` for the
>    **Recently deleted** panel. **Run this after the audit log**; if you re-run
>    an earlier migration afterwards, run this one again.
> 7. [`supabase/mfa-migration.sql`](supabase/mfa-migration.sql) — adds the
>    `security_settings` table, `admin_mfa_required()` and `set_require_admin_mfa()`.
>    Once an admin enrols an authenticator and enables the requirement, `is_admin()`
>    only returns true for `aal2` sessions, so every existing RLS policy and RPC
>    rejects password-only writes. The requirement defaults to **off**, so this
>    migration changes nothing until you opt in.
> 8. [`supabase/check-constraints-migration.sql`](supabase/check-constraints-migration.sql)
>    — adds database-level checks for non-blank names/IDs, team codes and hex colours,
>    non-negative player numbers/totals, valid rounds/scores, distinct home and away
>    teams, and season date order. It fails and rolls back if existing rows violate a
>    rule, so export a backup first and fix the reported rows.
> 9. [`supabase/add-players-migration.sql`](supabase/add-players-migration.sql) —
>    installs the admin-only, atomic `add_players(team_id, players)` RPC used by
>    **Import squad from Excel**. It validates every row, rejects duplicates and adds
>    at most 100 players per call. Without it, the import screen shows a
>    “migration required” message and saves nothing.
> 10. [`supabase/scheduled-match-events-migration.sql`](supabase/scheduled-match-events-migration.sql)
>    — counts goals and cards that were already saved on upcoming fixtures while
>    `events_counted` was false, then marks those fixtures as counted. It is safe to
>    re-run, leaves finished/live and archived fixtures untouched, and should also be
>    run after importing an older backup that still marks upcoming fixtures as false.
> 11. [`supabase/derive-totals-migration.sql`](supabase/derive-totals-migration.sql) —
>    adds the legacy goal/card offsets and the `v_player_stats`, `v_standings`,
>    `v_match_results` and `v_player_event_totals` views that recompute totals from
>    events. It also installs `set_player_totals()` and teaches `add_players()` /
>    `replace_all_data()` to seed the offset. The stored totals and
>    `events_counted` keep working, so the app is unchanged on a project that has
>    not run this file. Once it is applied, the next page load reads
>    `v_player_stats` and the player form saves totals through
>    `set_player_totals()`, with no redeploy needed. If you re-run an earlier
>    migration that replaces `add_players()` or `replace_all_data()`, run this
>    file again afterwards.
>
> Alternatively, re-run the full [`supabase/schema.sql`](supabase/schema.sql); it is
> idempotent and creates anything that is missing. It does **not** add the new `CHECK`
> constraints to tables that already exist, so run step 8 separately on an upgraded
> database. Do not re-run the sample seed block on a production database with real data.
>
> After the integrity migration, team/match deletion and match-event writes are
> intentionally RPC-only. The app uses `delete_team`, `delete_match`, `save_match` and
> `replace_match_events`; direct REST deletes/writes are denied so player totals cannot
> drift from the event history. After the soft-delete migration, deletes only stamp
> `deleted_at`; restoring re-applies the same event totals.

### 2. Add your keys

In Supabase open **Project Settings → API** and copy:

- **Project URL** (e.g. `https://abcdefghijkl.supabase.co`)
- **anon public** key (or **Publishable key** on newer dashboards, starting with
  `sb_publishable_...`)

Put your project's URL and anon key into the `PRODUCTION` block in
[`js/config.js`](js/config.js). This repository is already wired to a production and a
development project; if you fork it, replace both blocks with your own credentials
(see the next section):

```js
const PRODUCTION = {
  SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_...'
};

const DEVELOPMENT = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: ''
};
```

> The anon/publishable key is **meant to be public** — it only identifies the project.
> Row Level Security is what protects your data. Never put the `service_role` or
> `secret` key in this file.

### 3. Create your admin account

1. Open the site, click **Admin Login → No account yet? Create one**.
2. If Supabase email confirmation is enabled (default), confirm your email first.
3. Promote your account in **SQL Editor**:

```sql
update public.profiles
   set role = 'admin'
 where email = 'you@example.com';
```

4. Log out and back in. The **Admin** badge, *Log Match*, *Add Team*, edit/delete
   controls and the settings menu appear.

Optional: disable email confirmation under **Authentication → Providers → Email**
if you don't want new accounts to confirm their address. Once your admin account
exists, you can also turn off public sign-ups there to prevent extra accounts.

### 4. Protect the admin account with two-factor

1. Run [`supabase/mfa-migration.sql`](supabase/mfa-migration.sql) in the SQL Editor.
2. Log in as admin, open the data menu and choose **Two-factor authentication**.
3. **Set up authenticator app**, scan the QR code (or type the key) in Google
   Authenticator, Authy, 1Password or any TOTP app, then enter the 6-digit code.
4. Tick **Require two-factor for admin writes**. From then on the database only accepts
   writes from a session whose JWT carries `aal2`; a password-only session can still
   read the league but every write RPC and RLS policy rejects it.

The app asks for the code after login whenever the requirement is on. Keep a backup of
the authenticator: if it is lost, use another admin account or remove the factor under
**Authentication → Users** in the Supabase dashboard. SQL Editor access always remains
available for recovery. Turning the requirement off also needs a verified session.

### 5. Password recovery and idle logout

1. In each Supabase project, open **Authentication → URL Configuration**. Set the
   **Site URL** to the matching site (production for the production project,
   `http://localhost:8765/` for development), then add both redirect patterns to **both**
   projects:
   - `https://<user>.github.io/<repo>/**`
   - `http://localhost:8765/**`

   The trailing `**` allows the optional `?env=dev` / `?env=prod` query that the app
   preserves when it builds the return URL.
2. In the login dialog, click **Forgot password?**, enter the account email and request
   the link. Account lookups get a deliberately generic response, so the form cannot be
   used to discover which emails have accounts; network/server failures and rate limits
   show a retry message.
3. Open the link from the inbox. The app asks for a new password (6+ characters). Saving
   it signs out **all** existing sessions, including the recovery session, then returns
   to the login dialog.
4. Test recovery against the development project from `http://localhost:8765/`; the
   `?env=dev` preview on GitHub Pages also returns to the development project now that
   the environment is preserved.
5. As an admin, **Data settings → Sign out all devices** revokes every active refresh
   token without changing the password. Use it if another device may be compromised.

Signed-in sessions end after **30 minutes without pointer, keyboard, touch or scroll
activity**. The check also runs when the tab becomes visible again, so background timer
throttling cannot keep a forgotten session alive. Signed-in tabs share the last-activity
timestamp, so an active tab keeps the session alive while an anonymous tab cannot. This
is an app-level control: it clears the browser session and calls Supabase sign-out, but
it does not shorten the server-side JWT lifetime. The normal **Log out** button and idle
timeout end only the current browser session. Password recovery and the admin-only
**Sign out all devices** action revoke every refresh token. If no email arrives, check the
project's Auth email rate limits and SMTP settings; old or reused links are rejected.

### Confirmation email issues

If a confirmation link redirects to `localhost:3000` or says it expired:

1. Set **Authentication → URL Configuration → Site URL** to your deployed URL
   (`https://<user>.github.io/<repo>/`) and add `https://<user>.github.io/<repo>/**`
   under **Redirect URLs** (the wildcard allows the optional `?env=` query). Add
   `http://localhost:8765/**` too if you test locally.
2. In the login modal, enter your email and click **Didn't get the confirmation email?
   Resend it**. Old links cannot be reused.
3. Or disable **Confirm email** under **Authentication → Providers → Email**, delete the
   unconfirmed user under **Authentication → Users**, and sign up again.

## Development vs production databases

Use **two independent Supabase projects**. Never test new features directly against
real league data.

| | Production | Development |
|---|---|---|
| Purpose | Real league | Experiments and sample data |
| Used by | GitHub Pages | `http://localhost:8765` |
| Data | Real teams, players, results | Sample data, safe to reset |
| Admin account | Your real admin | A separate dev admin |
| Backups | Export regularly | Not required |

Both anon/publishable keys are safe to publish. Row Level Security still blocks
non-admin writes in both projects.

### Create the development project

1. In Supabase, create a **second project** in the same organization.
2. Run `supabase/schema.sql` in its SQL Editor. This also inserts the sample league.
3. Under **Authentication → Providers → Email**, disable public sign-ups.
4. Create a dev admin account (temporarily enable sign-ups if needed), confirm it,
   then promote it:
   ```sql
   update public.profiles
      set role = 'admin'
    where email = 'dev-admin@example.com';
   ```
5. Set **Authentication → URL Configuration → Site URL** to
   `http://localhost:8765/` and add `http://localhost:8765/**` under **Redirect URLs**
   (plus `https://<user>.github.io/<repo>/**` if you use the deployed `?env=dev` preview).
6. Optionally disable email confirmation in the dev project to speed up sign-in.

### Add the development keys

The checked-in `DEVELOPMENT` block already points at the original dev project. If you
are setting up your own copy, replace it with the second project's URL and
anon/publishable key:

```js
const DEVELOPMENT = {
  SUPABASE_URL: 'https://your-dev-project.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_...'
};
```

The `PRODUCTION` block keeps the real project. The app picks the database like this:

- `http://localhost:8765` → **development** (once the dev keys are filled)
- GitHub Pages → **production**
- `?env=dev` on the deployed site → development, with a blue banner
- `?env=prod` → production, even on localhost
- If the dev keys are empty, localhost falls back to production and shows an amber
  warning so you don't edit real data by accident.

Auth sessions are separate because each Supabase project uses its own storage key.
Logging into the dev admin does not log you into production.

### Schema changes and data

1. Apply every schema change to the **development** project first.
2. Test the full feature there, including login, writes, archived seasons and import.
3. Run the same SQL in **production** only after it is verified.
4. Keep dev data disposable. Use **Settings → Reset Sample Data** or import a small
   test backup; do not import real data into dev unless you are comfortable with that
   project being publicly readable.
5. Export a production backup before running migrations:
   **Settings → Export Backup (JSON)**.

> Free Supabase projects pause after a period of inactivity. The development project
> may need to be restored from the dashboard before you start working; the app shows a
> retry banner while it is unavailable.

## Roles and permissions

| Action | Visitor (no account) | Viewer account | Admin account |
|---|---|---|---|
| View standings, fixtures, squads | ✅ | ✅ | ✅ |
| Add / edit / delete teams, players, matches | ❌ | ❌ | ✅ |
| Create seasons / switch the active season | ❌ | ❌ | ✅ |
| Delete an empty archived season | ❌ | ❌ | ✅ |
| View archived season tables and fixtures | ✅ | ✅ | ✅ |
| Import / reset data, export backup | ❌ | ❌ | ✅ |

Visitors and viewers get a read-only UI. The real enforcement is in
`supabase/schema.sql`:

```sql
create policy teams_insert_admin on public.teams
  for insert to authenticated with check (public.is_admin());
```

`public.is_admin()` checks `profiles.role = 'admin'` for `auth.uid()`. The same pattern
is applied to `update` on teams/players and to insert/update on matches/players. Match
inserts and updates additionally require the parent season to be active. Team/match
deletes and match-event writes are RPC-only, so the total-adjusting functions cannot be
bypassed. Public `select` policies make the league readable without logging in.

## Run locally

The compiled Tailwind stylesheet is committed, so the site runs without a build step.
Serve the folder with the dependency-free local server:

```bash
node tools/serve.js
```

Then open <http://localhost:8765>. You can also use `npm.cmd run serve`; plain
`npm run serve` may be blocked by PowerShell execution policy.

> Opening `index.html` directly via `file://` also works in most browsers, but a local
> server matches GitHub Pages behavior more closely.

### Styling changes

Tailwind is compiled locally into `css/tailwind.css` (about 22 KB) instead of loading
the Play CDN. The generated file is committed, so visitors and GitHub Pages need no
build tooling. If you add or change Tailwind classes in `index.html` or `js/`, rebuild
the stylesheet:

```bash
npm install          # first time only
npm run build:css    # one-off build
npm run watch:css    # rebuild while editing
```

The GitHub Actions workflow rebuilds the CSS on every push and fails if the committed
file is out of date.

### Tests

```bash
npm run test:sql        # in-memory Postgres: RLS, archive locks, atomic saves, trash restore, audit log, MFA gate
npm run test:e2e        # Chromium: public read, fixtures, squads, FR/AR + RTL, login dialog
npm run check:secrets   # fail if a privileged key is committed
```

`test:sql` uses PGlite (Postgres compiled to WASM), so it needs no Docker daemon or
hosted database. CI also runs the JavaScript syntax check and the CSV round-trip test.

The Playwright smoke test starts `tools/serve.js`, opens `/?env=prod`, and asserts that
the public standings, fixtures and squads load, that French and Arabic (RTL) switch
correctly, that the admin login dialog opens, and that the browser records no console
or page errors. It uses no credentials and performs no writes. Install Chromium once
locally with `npx playwright install chromium`; the
[`E2E smoke`](.github/workflows/e2e.yml) workflow installs it automatically on every
push and pull request. Admin login, saves, archive/restore and import rollback remain
manual until a dedicated test account and disposable development data are available.

### Backups and keepalive

Supabase Free has no automatic database backups, so the repository includes a
public-read exporter, a validator, and two scheduled GitHub Actions jobs:

```bash
npm run backup:prod     # writes backups/prod-backup-YYYY-MM-DD.json
npm run backup:dev      # writes backups/dev-backup-YYYY-MM-DD.json
npm run check:backup -- backups/prod-backup-2026-10-24.json
npm run drill:backup -- backups/prod-backup-2026-10-24.json
npm run keepalive:prod  # one lightweight read, for manual testing
```

The scripts use only the publishable/anon key, so no secret is needed in CI. They
refuse to write an empty backup if the project is unreachable or has no seasons/teams.
The output is the same JSON shape as **Export Backup (JSON)** in the admin menu and can
be re-imported there.

- [`Daily data backup`](.github/workflows/backup.yml) runs at 06:15 UTC, validates every
  foreign key and the active-season rule, **restores the backup into an in-memory
  Postgres database**, uploads the JSON as a 90-day artifact, and prints the row counts
  in the workflow summary. Artifact storage is tiny: even a 400 KB “busy” export × 90
  days is ~36 MB of the 500 MB GitHub allowance.
- [`Database keepalive`](.github/workflows/keepalive.yml) makes one public read every
  six hours. Supabase's current guidance is “a few requests per day”; one ping per week
  is **not** enough to prevent a Free project from being paused.
- `validate-backup.js` proves the payload is structurally sound and every reference
  resolves. `restore-drill.js` goes further: it runs `replace_all_data` against
  `supabase/schema.sql` in PGlite, then compares the restored database back to the
  backup (counts, active season, audit row and every field). It still does not prove the
  live import path or RLS, so also import the artifact into the **development** project
  and check standings, fixtures and squads before touching production.

GitHub disables scheduled workflows after 60 days without repository activity. During a
long off-season, run either job from **Actions → Run workflow**, or make a small commit.
Supabase also emails the project owner about a week before pausing a project.
Download an artifact before any risky migration and keep a local copy; artifacts expire.

## Bulk data entry (CSV)

For a full league, editing five CSV files is faster than entering every fixture in the
browser. Copy the templates from [`data/examples/`](data/examples), edit the copies in
`data/`, then run:

```powershell
node tools/csv-to-backup.js
```

This validates the data and writes `backups/kickoff-import-YYYY-MM-DD.json`, which you
import from **Settings → Import Backup (JSON)**. The import asks for confirmation and
downloads the current league as a safety backup before replacing anything. See
[`data/README.md`](data/README.md) for the column reference. Test the import in the
development project first — importing replaces all teams, players, seasons, matches and
match events in the connected database.

If you already have a JSON backup and want to edit it in a spreadsheet, generate the
five CSV files from it first:

```powershell
node tools/backup-to-csv.js backups/kickoff-backup-YYYY-MM-DD.json data --force
```

The tool refuses to overwrite existing CSV files unless `--force` is supplied, so it
cannot silently replace real league data by accident.

## Import a squad from Excel (one team at a time)

This is the fastest way to collect squads from many clubs: send each club one file, then
import it into the matching team.

1. Open **Teams & Players**, find the team and press the spreadsheet button
   (**Import squad from Excel**). Press **Download template (CSV)** to get a blank file
   in the current language. French templates use `;` so Excel in French locales opens
   them correctly; English and Arabic use `,`.
2. Columns are **Name**, **Position** (GK/DEF/MID/FWD, or `Goalkeeper`, `Défenseur`,
   `حارس`…), **Number** (1–99), and optional **Goals**, **Yellow**, **Red**. The header
   row can sit below a title row, and both `.xlsx` and CSV work (legacy `.xls` must be
   saved as `.xlsx`).
3. Pick the file. The preview lists every row with a status: *ready*, *ready (noted)*,
   *skipped* (already in the squad) or *error*. Import stays disabled while any row has
   an error; numbers already used by a teammate are only a warning.
4. Press **Add players**. All rows are inserted in one transaction by
   `add_players()`, at most 100 per import, and one `IMPORT` summary appears in the
   Activity log. Nothing else in the league is changed.

The database re-checks every row, so a hand-edited file cannot bypass validation. If
the app says the migration is missing, run
[`supabase/add-players-migration.sql`](supabase/add-players-migration.sql) first.

## Deploy to GitHub Pages (free)

1. Push the repository to GitHub (public).
2. Open **Settings → Pages**.
3. Under *Build and deployment*, choose **Deploy from a branch**, select `main` and
   `/ (root)`, then save.
4. Your app is live at `https://<user>.github.io/<repo>/`.
5. In Supabase, add that URL under **Authentication → URL Configuration → Site URL**
   (and *Redirect URLs*) so confirmation emails point back to the app.

## Data model

Seven tables in the `public` schema. Column names are snake_case in Postgres and mapped
to camelCase by `js/backend.js`.

```
seasons      (id text pk, name, start_date, end_date, is_active, created_at,
              deleted_at)
teams        (id text pk, name, code, color, deleted_at)
players      (id text pk, team_id → teams.id, name, pos, num, goals, yellow, red,
              is_active)
matches      (id text pk, season_id → seasons.id, round, home_id → teams.id,
              away_id → teams.id, home_score, away_score, status, datetime, venue,
              scorers_text, events_counted, deleted_at)
match_events (id text pk, match_id → matches.id, team_id → teams.id,
              player_id → players.id, event_type: goal|yellow|red, minute, created_at)
profiles     (id uuid pk → auth.users.id, email, role: admin|viewer)
audit_log    (id bigint pk, occurred_at, actor_id, actor_email, action, entity,
              entity_id, season_id, summary, before jsonb, after jsonb)
security_settings (id boolean pk, require_admin_mfa, updated_at)
```

`status` is one of `SCHEDULED`, `LIVE`, `FINISHED`. Only `FINISHED` matches count
towards the league table. Deleting a team hides it and its squad/fixtures from every
client without destroying the rows; the `delete_team` RPC first reverses that team's
event contributions to opponent player totals. A unique partial index guarantees that at
most one season is active. The `create_season` and `activate_season` database functions
are admin-only and run in a single transaction, so the active season always switches
cleanly.

### Recently deleted (soft delete)

`seasons`, `teams` and `matches` carry a nullable `deleted_at`. A delete stamps it and
RLS immediately hides the row, its squad and its events from anonymous and signed-in
readers alike. Admins see the trash through `list_deleted()` and bring items back with
`restore_team`, `restore_match` or `restore_season`; restoring clears `deleted_at` and
re-applies the event totals that were reversed on delete, so standings, squads and
timelines return exactly as they were. A match can only be restored after its season and
both teams are visible again, and a season can only be trashed when it is inactive and
has no visible fixtures. `deleted_at` changes are labelled `DELETE` / `RESTORE` in the
activity log.

`players.is_active` is `false` for archived players. Archived players keep their goals,
cards and match history, are hidden from public squads and new event dropdowns, and can
be restored by an admin. A player with match events cannot be hard-deleted; the app
archives them instead.

`match_events` powers the scorer/card timeline. `save_match` saves a fixture and its
event list in one transaction, while `replace_match_events` and `delete_match` adjust
the cumulative `players.goals`, `players.yellow` and `players.red` counters by the
difference in one transaction. Match and event writes are rejected for archived
seasons in the database, not just in the UI. Imported backups treat the player totals
as authoritative, so events are inserted without being counted twice.

`matches.events_counted` prevents double-counting historical data. Existing fixtures
are marked `false` during the migration because their goals/cards were already entered
manually; their event timeline is saved without touching player totals. New fixtures
default to `true`, so events keep the totals in sync. Imported backups preserve the
flag. See [`data/README.md`](data/README.md#eventscsv) for the CSV column.

`audit_log` is written by AFTER triggers on the five league tables and by
`replace_all_data` (one `IMPORT` row per import). Soft deletes and restores are labelled
`DELETE` and `RESTORE` instead of a generic update, and changing the MFA requirement
writes a `SECURITY` row. There are no client grants on the table and RLS is enabled with
no policy; admins read the newest entries through `list_audit_log(limit)`. It is a
history, not a backup — export JSON regularly.

### Two-factor authentication

TOTP factors are enrolled and verified through Supabase Auth in the browser. Once an
admin ticks **Require two-factor for admin writes**, `public.is_admin()` also requires
`auth.jwt()->>'aal' = 'aal2'`, so the gate applies to every RLS policy and every
admin-only RPC without duplicating checks. The flag itself can only be changed from an
`aal2` session. `security_settings` is a one-row table with RLS and no client grants;
`admin_mfa_required()` is readable so the app can prompt for step-up. Before the
migration is applied, the frontend hides the feature behind a one-line notice and
admin writes keep working as before.

The JSON backup format is the same camelCase shape used by the app. Backups created
before seasons existed are upgraded automatically into a single default season:

```json
{
  "seasons": [{ "id": "s1", "name": "2026 Season", "startDate": "2026-08-01",
                "endDate": "2027-05-31", "isActive": true }],
  "teams":   [{ "id": "t1", "name": "Spartan FC", "code": "SFC", "color": "#3b82f6" }],
  "players": [{ "id": "p1", "teamId": "t1", "name": "David Silva", "pos": "MID",
                "num": 10, "goals": 5, "yellow": 1, "red": 0, "isActive": true }],
  "matches": [{ "id": "m1", "seasonId": "s1", "round": 1, "homeId": "t1",
                "awayId": "t2", "homeScore": 3, "awayScore": 1,
                "status": "FINISHED", "datetime": "2026-10-03T15:00",
                "venue": "Main Field", "eventsCounted": true,
                "scorersText": "Carlos Ramos 23', David Silva 54', Carlos Ramos 71' - Ethan Hunt 80'" }],
  "matchEvents": [
    { "id": "e1", "matchId": "m1", "teamId": "t1", "playerId": "p2",
      "type": "goal", "minute": 23 },
    { "id": "e2", "matchId": "m1", "teamId": "t1", "playerId": "p1",
      "type": "goal", "minute": 54 },
    { "id": "e3", "matchId": "m1", "teamId": "t1", "playerId": "p2",
      "type": "goal", "minute": 71 },
    { "id": "e4", "matchId": "m1", "teamId": "t2", "playerId": "p3",
      "type": "goal", "minute": 80 },
    { "id": "e5", "matchId": "m1", "teamId": "t2", "playerId": "p3",
      "type": "yellow", "minute": 42 }
  ]
}
```

## Security notes

- Authorization is enforced by **Row Level Security**, not by hidden buttons. A viewer
  can open DevTools and call the API, but Postgres rejects the write.
- The anon key is public by design. The `service_role` key bypasses RLS — keep it out of
  the repository and out of the browser.
- Supabase free projects **pause after ~7 days of inactivity**. Open the dashboard and
  restore the project to wake it; the app shows a "could not load data" banner with a
  **Retry** button while the backend is unavailable.
- Passwords are handled by Supabase Auth (hashed and never stored in this repository).
  Use a strong, unique password for the admin account. Recovery links are single-use,
  expire according to the project's Auth settings, and a successful reset signs out all
  sessions.
- Admins can add a TOTP second factor. For enforcement, the database checks the JWT
  assurance level (`aal2`) in `is_admin()`, not just the UI. The requirement is opt-in
  and can only be switched off from a verified session.
- The 30-minute idle logout is a browser-side safety net. It does not revoke a token
  that has already been copied out of the browser; Supabase's JWT expiry, MFA gate and
  RLS remain the server-side controls. Use **Data settings → Sign out all devices** (or
  **Forgot password**) to revoke every refresh token after a suspected compromise.
- No third-party JavaScript, CSS or fonts are loaded at runtime. A CSP meta tag pins
  every directive to this origin, with Supabase allowed only for API/auth connections.
  `script-src` is exactly `'self'`: there are no inline handlers, and buttons, selects,
  inputs and forms are wired through delegated `data-action` / `data-change` /
  `data-input` / `data-submit` attributes. `style-src` still allows inline team-colour
  attributes.
- `npm run check:secrets` fails CI if a privileged key is ever committed.
- The audit log is append-only: clients hold no grants on `audit_log`, and reads go
  through the admin-checked `list_audit_log()` RPC. A full JSON import records one
  summary entry rather than one row per imported record.

## Notes

- Archived seasons hide all match-writing controls. An admin can select the season
  and click **Make active** to correct an old result; the previously active season
  then becomes the archive.
- An archived season with no fixtures shows **Delete season** in the season bar.
  The active season and any season that still has fixtures cannot be deleted.
- Player goals and cards remain cumulative totals, so the top-scorer card is all-time
  rather than per-season. For fixtures with `events_counted = true`, adding or removing
  a match event adjusts those totals by one in the same database transaction.
- To remove a player who already has match events, use **Delete** and confirm the
  archive prompt: the player disappears from the active squad but their history stays
  intact. Archived players appear in a small **Archived players** section under the
  squad for admins, with a **Restore** button.
- Match events are optional for backward compatibility. Until the match-events
  migration is run, the app keeps working with the free-text `scorersText` field and
  shows a one-time migration notice in the match modal.
- Tailwind is compiled locally, so there is no Play CDN warning and no runtime
  dependency on the Tailwind CDN. The generated stylesheet is committed; rebuild it
  with `npm run build:css` after changing classes.
- All user input is escaped before being injected into the DOM.
