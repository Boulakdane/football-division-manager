# ⚽ KickOff Division

A lightweight, responsive league manager for local football divisions and amateur
tournaments. The frontend is pure HTML/CSS/JS hosted free on GitHub Pages; data and
accounts live in a free [Supabase](https://supabase.com) project.

## Features

- **Automatic standings** — points, W/D/L, goals for/against, goal difference, last-5 form.
  The table is recalculated instantly whenever a result changes.
- **Fixtures & results** — schedule matchdays, log live scores, and mark matches as
  finished. Duplicate fixtures on the same matchday are rejected.
- **Goals & cards with minutes** — log each goal, yellow card and red card against a
  player from the correct team, with the minute. Events appear on the fixture card and
  update the player's goal/card totals.
- **Multiple seasons** — create a new season, switch between active and archived
  seasons, and keep every past table and fixture intact. Archived seasons are
  read-only in the UI until an admin makes them active again.
- **Teams & squads** — create/edit clubs, add players with positions, squad numbers,
  goals, yellow and red cards.
- **Trilingual UI** — English, French and Arabic, with automatic RTL layout for Arabic.
- **Real accounts & roles** — Supabase Auth with email + password. Spectators browse
  without an account; only users with the `admin` role can add, edit or delete.
- **Database-enforced permissions** — Postgres Row Level Security blocks writes from
  non-admins even if they tamper with the page or call the API directly.
- **Shared data** — every visitor sees the same league, from any device.
- **JSON backup** — export/import the full dataset from the admin settings menu.
- **CSV tools** — export the current season's standings, fixtures and squads,
  bulk-build a league from five CSV files, or turn a JSON backup back into
  editable CSV files.
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
│   ├── auth.js                # Login/signup, session, role-based UI
│   └── app.js                 # Rendering, standings math, modals, import/export
├── package.json               # Tailwind build scripts (dev-only dependency)
├── tailwind.config.js         # Tailwind theme (pitch palette, fonts, content)
├── data/
│   ├── README.md              # CSV column reference and workflow
│   └── examples/              # Template seasons/teams/players/matches/events CSV files
├── docs/
│   ├── PROGRESS.md            # Current status, blockers and release checklist
│   ├── SECURITY_AUDIT.md      # Findings, threat model and remediation plan
│   └── MODERNIZATION_PLAN.md  # Phased roadmap and advanced improvements
├── tools/
│   ├── csv-to-backup.js       # Validate CSVs and build an importable JSON backup
│   ├── backup-to-csv.js       # Turn a JSON backup into editable CSV files
│   └── check-secrets.js       # Fail CI if a privileged secret is committed
├── SECURITY.md                # Private vulnerability reporting policy
└── supabase/
    ├── schema.sql                   # Tables, RLS policies, triggers and seed data
    ├── seasons-migration.sql        # Upgrade an existing database to seasons
    ├── match-events-migration.sql   # Upgrade an existing database to match events
    └── atomic-import-migration.sql  # Install the one-transaction full-data import RPC
```

Scripts are loaded in dependency order in `index.html`:
`i18n.js` → `store.js` → `config.js` → `backend.js` → `auth.js` → `app.js`
(all `defer`red). Keep that order if you add modules.

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
>    it automatically and falls back to the older client-side path until it is installed.
>
> Alternatively, re-run the full [`supabase/schema.sql`](supabase/schema.sql); it is
> idempotent and creates anything that is missing. Do not re-run the sample seed block
> on a production database with real data.

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

### Confirmation email issues

If a confirmation link redirects to `localhost:3000` or says it expired:

1. Set **Authentication → URL Configuration → Site URL** to your deployed URL
   (`https://<user>.github.io/<repo>/`) and add the same URL under **Redirect URLs**.
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
   `http://localhost:8765` and add the same value under **Redirect URLs**.
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
is applied to `update`/`delete` on `teams`, `players` and `matches`. Public `select`
policies make the league readable without logging in.

## Run locally

The compiled Tailwind stylesheet is committed, so the site runs without a build step.
Serve the folder with any static server, for example:

```bash
# Node (no dependencies)
node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>{let u=q.url==='/'?'/index.html':q.url;f.readFile(p.join(process.cwd(),u),(e,d)=>{if(e){s.writeHead(404);s.end('Not found');return;}const t={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json'}[p.extname(u)]||'application/octet-stream';s.writeHead(200,{'Content-Type':t});s.end(d);});}).listen(8000)"
```

Then open <http://localhost:8000>.

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

## Bulk data entry (CSV)

For a full league, editing five CSV files is faster than entering every fixture in the
browser. Copy the templates from [`data/examples/`](data/examples), edit the copies in
`data/`, then run:

```powershell
node tools/csv-to-backup.js
```

This validates the data and writes `backups/kickoff-import-YYYY-MM-DD.json`, which you
import from **Settings → Import Backup (JSON)**. See [`data/README.md`](data/README.md)
for the column reference. Test the import in the development project first — importing
replaces all teams, players, seasons, matches and match events in the connected database.

If you already have a JSON backup and want to edit it in a spreadsheet, generate the
five CSV files from it first:

```powershell
node tools/backup-to-csv.js backups/kickoff-backup-YYYY-MM-DD.json data --force
```

The tool refuses to overwrite existing CSV files unless `--force` is supplied, so it
cannot silently replace real league data by accident.

## Deploy to GitHub Pages (free)

1. Push the repository to GitHub (public).
2. Open **Settings → Pages**.
3. Under *Build and deployment*, choose **Deploy from a branch**, select `main` and
   `/ (root)`, then save.
4. Your app is live at `https://<user>.github.io/<repo>/`.
5. In Supabase, add that URL under **Authentication → URL Configuration → Site URL**
   (and *Redirect URLs*) so confirmation emails point back to the app.

## Data model

Six tables in the `public` schema. Column names are snake_case in Postgres and mapped
to camelCase by `js/backend.js`.

```
seasons      (id text pk, name, start_date, end_date, is_active, created_at)
teams        (id text pk, name, code, color)
players      (id text pk, team_id → teams.id, name, pos, num, goals, yellow, red)
matches      (id text pk, season_id → seasons.id, round, home_id → teams.id,
              away_id → teams.id, home_score, away_score, status, datetime, venue,
              scorers_text, events_counted)
match_events (id text pk, match_id → matches.id, team_id → teams.id,
              player_id → players.id, event_type: goal|yellow|red, minute, created_at)
profiles     (id uuid pk → auth.users.id, email, role: admin|viewer)
```

`status` is one of `SCHEDULED`, `LIVE`, `FINISHED`. Only `FINISHED` matches count
towards the league table. Deleting a team cascades to its players and matches.
A unique partial index guarantees that at most one season is active. The
`create_season` and `activate_season` database functions are admin-only and run in
a single transaction, so the active season always switches cleanly.

`match_events` powers the scorer/card timeline. `replace_match_events` and
`delete_match` are admin-only database functions that replace a match's events and
adjust the cumulative `players.goals`, `players.yellow` and `players.red` counters by
the difference in one transaction. Imported backups treat the player totals as
authoritative, so events are inserted without being counted twice.

`matches.events_counted` prevents double-counting historical data. Existing fixtures
are marked `false` during the migration because their goals/cards were already entered
manually; their event timeline is saved without touching player totals. New fixtures
default to `true`, so events keep the totals in sync. Imported backups preserve the
flag. See [`data/README.md`](data/README.md#eventscsv) for the CSV column.

The JSON backup format is the same camelCase shape used by the app. Backups created
before seasons existed are upgraded automatically into a single default season:

```json
{
  "seasons": [{ "id": "s1", "name": "2026 Season", "startDate": "2026-08-01",
                "endDate": "2027-05-31", "isActive": true }],
  "teams":   [{ "id": "t1", "name": "Spartan FC", "code": "SFC", "color": "#3b82f6" }],
  "players": [{ "id": "p1", "teamId": "t1", "name": "David Silva", "pos": "MID",
                "num": 10, "goals": 5, "yellow": 1, "red": 0 }],
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
  Use a strong, unique password for the admin account.

## Notes

- Archived seasons hide all match-writing controls. An admin can select the season
  and click **Make active** to correct an old result; the previously active season
  then becomes the archive.
- An archived season with no fixtures shows **Delete season** in the season bar.
  The active season and any season that still has fixtures cannot be deleted.
- Player goals and cards remain cumulative totals, so the top-scorer card is all-time
  rather than per-season. For fixtures with `events_counted = true`, adding or removing
  a match event adjusts those totals by one in the same database transaction.
- Match events are optional for backward compatibility. Until the match-events
  migration is run, the app keeps working with the free-text `scorersText` field and
  shows a one-time migration notice in the match modal.
- Tailwind is compiled locally, so there is no Play CDN warning and no runtime
  dependency on the Tailwind CDN. The generated stylesheet is committed; rebuild it
  with `npm run build:css` after changing classes.
- All user input is escaped before being injected into the DOM.
