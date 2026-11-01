# Squad import examples

Ready-to-use files for **Teams → (team card) → import squad**.

| File | Use it when |
|---|---|
| `squad-example.xlsx` | You want a filled Excel file to edit: three players, every column. |
| `squad-example.csv` | You prefer a plain text file (opens in Excel too). Same three players. |

Both files are downloaded by the app from the import dialog:
* **Download filled example (Excel)** → `squad-example.xlsx`
* **Download template (CSV)** → an empty template with only the header row, translated to the current language.

## Columns

Only **Name** is required. A column can be left out entirely, as long as **Name** is present.
The header row is looked for in the first 15 rows, so a title line above it is fine.

| Column | Required | Accepted values |
|---|---|---|
| `Name` | yes | Full name, 1–60 characters. `Nom`, `Player`, `الاسم` also work. |
| `Arabic Name` | no | Arabic spelling, shown when the app is in Arabic. |
| `Position` | no | `GK`, `DEF`, `MID`, `FWD`, or a word in EN/FR/AR: `Goalkeeper`, `Gardien`, `حارس`, `Defender`, `Défenseur`, `Attaquant`, `Milieu`, … |
| `Number` | no | Shirt number, 1–99. Leading zeros are fine (`04` → `4`). |
| `Licence` | no | Licence number, up to 50 characters. Must be unique in the file. |
| `Birth date` | no | `YYYY-MM-DD` or `D/M/YYYY`, between 1900-01-01 and today. |
| `Goals` | no | Whole number of goals already scored this season. |
| `Yellow` | no | Whole number of yellow cards. |
| `Red` | no | Whole number of red cards. |

## What happens on import

1. Every row is checked first; **nothing is written** before you press *Add players*.
2. A player already in the squad (same name) is skipped, not duplicated.
3. A shirt number already taken is a **warning**: the row can still be imported.
4. An empty name, an unknown position, a number outside 1–99, a duplicate licence,
   a bad birth date or an unreadable number is an **error**: the whole import is blocked
   until the row is fixed or removed.
5. The maximum is 100 players and 2000 rows per file.

## Spreadsheet tips

* Keep the data on the first sheet; the sheet name does not matter.
* Do not merge cells, add subtotals or leave blank header cells in the middle of the row.
* If a file does not load, save it again as **.xlsx** (not .xls) or export it as **CSV UTF-8**.
