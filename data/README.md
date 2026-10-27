# Bulk data entry with CSV

Use the five CSV files in `data/` to build a complete league, then convert them into
a JSON backup the app can import. This is much faster than typing a full fixture list
into the browser.

## 1. Create your working files

Copy the examples:

```powershell
Copy-Item data\examples\*.csv data\
```

Edit the copies in `data/`. Do not edit the files in `data/examples/`.

`data/*.csv` is git-ignored, so real league data is not committed by accident.

If you already have a JSON backup, you can generate the five CSV files from it instead:

```powershell
node tools/backup-to-csv.js backups/my-backup.json data --force
```

The tool refuses to overwrite existing CSV files unless `--force` is supplied. This is
useful for editing an existing league in a spreadsheet before importing it again.

## 2. Columns

All files must be UTF-8 CSV. The first row is the header. IDs must be unique and are
used to link rows together.

### `seasons.csv`

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `s1` |
| `name` | yes | e.g. `2026 Season` |
| `startDate` | no | `YYYY-MM-DD` |
| `endDate` | no | `YYYY-MM-DD`, on or after `startDate` |
| `isActive` | yes | Exactly one season must be `true` |

### `teams.csv`

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `t1` |
| `name` | yes | Club name (Latin script) |
| `nameAr` | no | Arabic name, shown alongside the Latin one |
| `code` | yes | Short code, e.g. `SFC` |
| `color` | yes | Six-digit hex, e.g. `#3b82f6` |

### `players.csv`

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `p1` |
| `teamId` | yes | Must exist in `teams.csv` |
| `name` | yes | Player name (Latin script) |
| `nameAr` | no | Arabic name, shown alongside the Latin one |
| `pos` | yes | `GK`, `DEF`, `MID` or `FWD` |
| `num` | yes | Shirt number, 1–99 |
| `goals` | no | Defaults to `0` |
| `yellow` | no | Defaults to `0` |
| `red` | no | Defaults to `0` |
| `isActive` | no | Defaults to `true`; `false` keeps the player's history but hides them from the active squad |
| `licenseId` | no | Licence number, unique when set. Admin-only: it is stored in `player_profiles` and never shown to visitors |
| `birthDate` | no | `YYYY-MM-DD` between 1900-01-01 and 2100-12-31. Admin-only, like `licenseId` |

### `matches.csv`

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `m1` |
| `seasonId` | yes | Must exist in `seasons.csv` |
| `round` | yes | Match round, 1 or higher |
| `homeId` | yes | Must exist in `teams.csv` |
| `awayId` | yes | Must exist in `teams.csv`, different from `homeId` |
| `homeScore` | no | Defaults to `0` |
| `awayScore` | no | Defaults to `0` |
| `status` | yes | `SCHEDULED`, `LIVE` or `FINISHED` |
| `datetime` | no | `YYYY-MM-DDTHH:MM` |
| `venue` | no | Free text |
| `scorersText` | no | Free text |
| `eventsCounted` | no | `true` (default) or `false`; see below |

Wrap a field in double quotes when it contains a comma, for example:

```csv
m1,s1,1,t1,t2,3,1,FINISHED,2026-10-03T15:00,Main Field,"Carlos Ramos (2), David Silva (1)"
```

Only `FINISHED` matches count towards the league table.

### `events.csv`

Optional. Add goals and cards with the minute they happened. Players are linked to a
match and must belong to one of the two teams playing.

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `e1` |
| `matchId` | yes | Must exist in `matches.csv` |
| `teamId` | yes | Must be the home or away team of that match |
| `playerId` | yes | Must exist in `players.csv` and belong to `teamId` |
| `type` | yes | `goal`, `yellow` or `red` |
| `minute` | yes | 1–130 |

Example:

```csv
id,matchId,teamId,playerId,type,minute
e1,m1,t1,p2,goal,23
e2,m1,t1,p1,goal,54
e3,m1,t2,p3,yellow,42
e4,m1,t2,p3,red,88
```

The player totals in `players.csv` remain the aggregate career totals shown on the
player cards. Event rows are what make the scorer/card timeline appear on the fixture.

`eventsCounted` controls whether event rows adjust those aggregate totals. New matches
default to `true`. When an existing database is migrated, its old fixtures are marked
`false` so adding their first events does not double-count goals/cards that were already
entered manually. Set it to `true` only when the totals in `players.csv` do **not**
already include that match's events.

For matches marked `false`, saving events updates the timeline but leaves player totals
unchanged; update the player totals by hand if needed. New matches created in the app
start as `true` and keep player totals in sync automatically. When converting an older
CSV set that has no `eventsCounted` column, the default is `true`; add the column with
`false` for any historical matches whose goals/cards are already in `players.csv`.

## 3. Build the JSON backup

From the repository root:

```powershell
node tools/csv-to-backup.js
```

The script validates IDs, references, dates, scores and status values, then writes:

```text
backups/kickoff-import-YYYY-MM-DD.json
```

You can also choose the input folder and output file:

```powershell
node tools/csv-to-backup.js data backups/my-league.json
```

## 4. Import into the app

1. Export a JSON backup of the current database first.
2. Sign in as admin.
3. Open **Settings → Import Backup (JSON)**.
4. Choose the generated `backups/kickoff-import-*.json` file.
5. Check the standings and fixtures for the active season.

> Import replaces **all** teams, players, seasons, matches and match events in the
> connected database. Do this in the development project first. When the data looks
> right, repeat it against production.

## 5. After the import

- Create a new season from the app for future competitions.
- Keep `data/*.csv` up to date if you want to regenerate the backup later.
- Use **Settings → Export Backup (JSON)** after making changes in the app.
- Use **Settings → Standings CSV / Fixtures CSV / Squads CSV** to share or
  print the season currently shown in the app.
