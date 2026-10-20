# ⚽ KickOff Division

A lightweight, responsive league manager for local football divisions and amateur
tournaments. The frontend is pure HTML/CSS/JS hosted free on GitHub Pages; data and
accounts live in a free [Supabase](https://supabase.com) project.

## Features

- **Automatic standings** — points, W/D/L, goals for/against, goal difference, last-5 form.
  The table is recalculated instantly whenever a result changes.
- **Fixtures & results** — schedule matchdays, log live scores, and mark matches as
  finished. Duplicate fixtures on the same matchday are rejected.
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
- **Live score shortcuts** — matches in `LIVE` state get `+` buttons on the fixture card.
- **Read-only demo mode** — until Supabase is configured, the site shows the sample
  league with all write controls hidden and a banner explaining how to connect it.

## Project structure

```
.
├── index.html                 # Markup only (header, views, modals, script tags)
├── css/
│   └── styles.css             # Fonts (incl. Arabic/RTL) and scrollbar styling
├── js/
│   ├── tailwind.config.js     # Tailwind theme (pitch palette, fonts)
│   ├── config.js              # ⚠️ Supabase URL + anon key (edit this)
│   ├── i18n.js                # EN/FR/AR dictionary, t(), language + RTL switching
│   ├── store.js               # In-memory state + demo/seed dataset
│   ├── backend.js             # Supabase client, reads, writes, row mapping
│   ├── auth.js                # Login/signup, session, role-based UI
│   └── app.js                 # Rendering, standings math, modals, import/export
└── supabase/
    ├── schema.sql             # Tables, RLS policies, trigger and seed data
    └── seasons-migration.sql  # Upgrade an existing database to seasons
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

> **Upgrading an existing project?** If you created the database before multiple
> seasons were added, run [`supabase/seasons-migration.sql`](supabase/seasons-migration.sql)
> once in the SQL Editor instead. It adds the `seasons` table, links existing
> fixtures to a default season, and installs the season functions.

### 2. Add your keys

In Supabase open **Project Settings → API** and copy:

- **Project URL** (e.g. `https://abcdefghijkl.supabase.co`)
- **anon public** key (or **Publishable key** on newer dashboards, starting with
  `sb_publishable_...`)

Put the project's URL and anon key into the `PRODUCTION` block in
[`js/config.js`](js/config.js). Leave the `DEVELOPMENT` block empty until you create
a separate dev project (recommended — see the next section):

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

Open [`js/config.js`](js/config.js) and fill the `DEVELOPMENT` block with the second
project's URL and anon/publishable key:

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

No build step. Serve the folder with any static server, for example:

```bash
# Node (no dependencies)
node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>{let u=q.url==='/'?'/index.html':q.url;f.readFile(p.join(process.cwd(),u),(e,d)=>{if(e){s.writeHead(404);s.end('Not found');return;}const t={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json'}[p.extname(u)]||'application/octet-stream';s.writeHead(200,{'Content-Type':t});s.end(d);});}).listen(8000)"
```

Then open <http://localhost:8000>.

> Opening `index.html` directly via `file://` also works in most browsers, but a local
> server matches GitHub Pages behavior more closely.

## Deploy to GitHub Pages (free)

1. Push the repository to GitHub (public).
2. Open **Settings → Pages**.
3. Under *Build and deployment*, choose **Deploy from a branch**, select `main` and
   `/ (root)`, then save.
4. Your app is live at `https://<user>.github.io/<repo>/`.
5. In Supabase, add that URL under **Authentication → URL Configuration → Site URL**
   (and *Redirect URLs*) so confirmation emails point back to the app.

## Data model

Five tables in the `public` schema. Column names are snake_case in Postgres and mapped
to camelCase by `js/backend.js`.

```
seasons   (id text pk, name, start_date, end_date, is_active, created_at)
teams     (id text pk, name, code, color)
players   (id text pk, team_id → teams.id, name, pos, num, goals, yellow, red)
matches   (id text pk, season_id → seasons.id, round, home_id → teams.id,
           away_id → teams.id, home_score, away_score, status, datetime, venue,
           scorers_text)
profiles  (id uuid pk → auth.users.id, email, role: admin|viewer)
```

`status` is one of `SCHEDULED`, `LIVE`, `FINISHED`. Only `FINISHED` matches count
towards the league table. Deleting a team cascades to its players and matches.
A unique partial index guarantees that at most one season is active. The
`create_season` and `activate_season` database functions are admin-only and run in
a single transaction, so the active season always switches cleanly.

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
                "venue": "Main Field",
                "scorersText": "Carlos Ramos (2), David Silva (1) - Ethan Hunt (1)" }]
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
- Player goals and cards are cumulative player totals, so the top-scorer card is
  all-time rather than per-season. Per-season player statistics would require
  structured match events.
- The Tailwind Play CDN prints a "should not be used in production" warning in the
  console. It is intentional here to keep the project build-free. For a fully optimized
  production bundle, compile Tailwind locally and replace the CDN script with the
  generated stylesheet.
- All user input is escaped before being injected into the DOM.
