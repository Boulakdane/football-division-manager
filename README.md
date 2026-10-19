# ⚽ KickOff Division

A lightweight, responsive league manager for local football divisions and amateur
tournaments. Everything runs client-side — no backend, no database, no hosting costs.

## Features

- **Automatic standings** — points, W/D/L, goals for/against, goal difference, last-5 form.
  The table is recalculated instantly whenever a result changes.
- **Fixtures & results** — schedule matchdays, log live scores, and mark matches as
  finished. Duplicate fixtures on the same matchday are rejected.
- **Teams & squads** — create/edit clubs, add players with positions, squad numbers,
  goals, yellow and red cards.
- **Trilingual UI** — English, French and Arabic, with automatic RTL layout for Arabic.
- **Zero-server storage** — all data persists in `localStorage`; export/import a JSON
  backup from the settings menu.
- **Live score shortcuts** — matches in `LIVE` state get `+` buttons on the fixture card.

## Project structure

```
.
├── index.html              # Markup only (header, views, modals, script tags)
├── css/
│   └── styles.css          # Fonts (incl. Arabic/RTL) and scrollbar styling
└── js/
    ├── tailwind.config.js  # Tailwind theme (pitch palette, fonts)
    ├── i18n.js             # EN/FR/AR dictionary, t(), language + RTL switching
    ├── store.js            # Demo data, localStorage load/save/normalize
    └── app.js              # Rendering, standings math, modals, CRUD, import/export
```

Script load order is defined in `index.html` (`i18n.js` → `store.js` → `app.js`, all
`defer`red). Keep that order if you add more modules.

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

## Data model

Stored under the `kickoff_division_data` key:

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

Match `status` is one of `SCHEDULED`, `LIVE`, `FINISHED`. Only `FINISHED` matches count
towards the league table. The active language is stored separately as `kickoff_lang`.

## Notes

- The Tailwind Play CDN prints a “should not be used in production” warning in the
  console. It is intentional here to keep the project build-free. For a fully optimized
  production bundle, compile Tailwind locally and replace the CDN script with the
  generated stylesheet.
- All user input is escaped before being injected into the DOM.
