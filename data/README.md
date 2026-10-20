# Bulk data entry with CSV

Use the four CSV files in `data/` to build a complete league, then convert them into
a JSON backup the app can import. This is much faster than typing a full fixture list
into the browser.

## 1. Create your working files

Copy the examples:

```powershell
Copy-Item data\examples\*.csv data\
```

Edit the copies in `data/`. Do not edit the files in `data/examples/`.

`data/*.csv` is git-ignored, so real league data is not committed by accident.

If you already have a JSON backup, you can generate the four CSV files from it instead:

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
| `name` | yes | Club name |
| `code` | yes | Short code, e.g. `SFC` |
| `color` | yes | Six-digit hex, e.g. `#3b82f6` |

### `players.csv`

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `p1` |
| `teamId` | yes | Must exist in `teams.csv` |
| `name` | yes | Player name |
| `pos` | yes | `GK`, `DEF`, `MID` or `FWD` |
| `num` | yes | Shirt number, 1–99 |
| `goals` | no | Defaults to `0` |
| `yellow` | no | Defaults to `0` |
| `red` | no | Defaults to `0` |

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

Wrap a field in double quotes when it contains a comma, for example:

```csv
m1,s1,1,t1,t2,3,1,FINISHED,2026-10-03T15:00,Main Field,"Carlos Ramos (2), David Silva (1)"
```

Only `FINISHED` matches count towards the league table.

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

> Import replaces **all** teams, players, seasons and matches in the connected
> database. Do this in the development project first. When the data looks right,
> repeat it against production.

## 5. After the import

- Create a new season from the app for future competitions.
- Keep `data/*.csv` up to date if you want to regenerate the backup later.
- Use **Settings → Export Backup (JSON)** after making changes in the app.
- Use **Settings → Standings CSV / Fixtures CSV / Squads CSV** to share or
  print the season currently shown in the app.
