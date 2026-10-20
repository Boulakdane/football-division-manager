# ⚽ KickOff Division

A lightweight, responsive league manager for local football divisions and amateur
tournaments. The frontend is pure HTML/CSS/JS hosted free on GitHub Pages; data and
accounts live in a free [Supabase](https://supabase.com) project.

## Features

- **Automatic standings** — points, W/D/L, goals for/against, goal difference, last-5 form.
  The table is recalculated instantly whenever a result changes.
- **Fixtures & results** — schedule matchdays, log live scores, and mark matches as
  finished. Duplicate fixtures on the same matchday are rejected.
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
    └── schema.sql             # Tables, RLS policies, trigger and seed data
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

### 2. Add your keys

In Supabase open **Project Settings → API** and copy:

- **Project URL** (e.g. `https://abcdefghijkl.supabase.co`)
- **anon public** key (or **Publishable key** on newer dashboards, starting with
  `sb_publishable_...`)

Put both into [`js/config.js`](js/config.js):

```js
window.KICKOFF_CONFIG = {
  SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
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

## Roles and permissions

| Action | Visitor (no account) | Viewer account | Admin account |
|---|---|---|---|
| View standings, fixtures, squads | ✅ | ✅ | ✅ |
| Add / edit / delete teams, players, matches | ❌ | ❌ | ✅ |
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

Three tables in the `public` schema. Column names are snake_case in Postgres and mapped
to camelCase by `js/backend.js`.

```
teams     (id text pk, name, code, color)
players   (id text pk, team_id → teams.id, name, pos, num, goals, yellow, red)
matches   (id text pk, round, home_id → teams.id, away_id → teams.id,
           home_score, away_score, status, datetime, venue, scorers_text)
profiles  (id uuid pk → auth.users.id, email, role: admin|viewer)
```

`status` is one of `SCHEDULED`, `LIVE`, `FINISHED`. Only `FINISHED` matches count
towards the league table. Deleting a team cascades to its players and matches.
The JSON backup format is the same camelCase shape used by the app:

```json
{
  "teams":   [{ "id": "t1", "name": "Spartan FC", "code": "SFC", "color": "#3b82f6" }],
  "players": [{ "id": "p1", "teamId": "t1", "name": "David Silva", "pos": "MID",
                "num": 10, "goals": 5, "yellow": 1, "red": 0 }],
  "matches": [{ "id": "m1", "round": 1, "homeId": "t1", "awayId": "t2",
                "homeScore": 3, "awayScore": 1, "status": "FINISHED",
                "datetime": "2026-10-03T15:00", "venue": "Main Field",
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

- The Tailwind Play CDN prints a "should not be used in production" warning in the
  console. It is intentional here to keep the project build-free. For a fully optimized
  production bundle, compile Tailwind locally and replace the CDN script with the
  generated stylesheet.
- All user input is escaped before being injected into the DOM.
