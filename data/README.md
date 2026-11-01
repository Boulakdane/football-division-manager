# Bulk data entry with CSV

[العربية](#العربية) · [Français](#français) · [English](#english)

---

## العربية

استخدم ملفات CSV الخمسة في `data/` لبناء دوري كامل، ثم حوّلها إلى نسخة JSON احتياطية
يستوردها التطبيق. هذا أسرع بكثير من كتابة قائمة مباريات كاملة في المتصفح.

### 1. أنشئ ملفات العمل

انسخ الأمثلة:

```powershell
Copy-Item data\examples\*.csv data\
```

حرّر النسخ في `data/`. لا تحرّر الملفات الموجودة في `data/examples/`.

ملفات `data/*.csv` مستثناة من git، فلا تُودع بيانات الدوري الحقيقية عن غير قصد.

إذا كانت لديك نسخة JSON احتياطية، يمكنك توليد ملفات CSV الخمسة منها بدلًا من ذلك:

```powershell
node tools/backup-to-csv.js backups/my-backup.json data --force
```

ترفض الأداة الكتابة فوق ملفات CSV الموجودة ما لم تمرّر `--force`. هذا مفيد لتحرير
دوري موجود في جدول بيانات قبل استيراده من جديد.

### 2. الأعمدة

يجب أن تكون كل الملفات بصيغة CSV بترميز UTF-8. الصف الأول هو صف العناوين. المعرّفات
يجب أن تكون فريدة، وهي التي تربط الصفوف ببعضها.

#### `seasons.csv`

| العمود | مطلوب | ملاحظات |
|---|---|---|
| `id` | نعم | مثل `s1` |
| `name` | نعم | مثل `2026 Season` |
| `startDate` | لا | `YYYY-MM-DD` |
| `endDate` | لا | `YYYY-MM-DD`، في تاريخ `startDate` أو بعده |
| `isActive` | نعم | موسم واحد فقط يجب أن يكون `true` |

#### `teams.csv`

| العمود | مطلوب | ملاحظات |
|---|---|---|
| `id` | نعم | مثل `t1` |
| `name` | نعم | اسم النادي (بالحروف اللاتينية) |
| `nameAr` | لا | الاسم العربي، يُعرض إلى جانب الاسم اللاتيني |
| `icon` | لا | شعار النادي كـ data URL بصيغة PNG/JPEG/WebP (100000 حرف كحد أقصى). ينتجه التطبيق نفسه؛ اتركه فارغًا إن لم يكن لديك شعار. يجب وضعه بين علامتي تنصيص في CSV |
| `code` | نعم | رمز قصير، مثل `SFC` |
| `color` | نعم | ستة أرقام سادس عشرية، مثل `#3b82f6` |

#### `players.csv`

| العمود | مطلوب | ملاحظات |
|---|---|---|
| `id` | نعم | مثل `p1` |
| `teamId` | نعم | يجب أن يوجد في `teams.csv` |
| `name` | نعم | اسم اللاعب (بالحروف اللاتينية) |
| `nameAr` | لا | الاسم العربي، يُعرض إلى جانب الاسم اللاتيني |
| `pos` | نعم | `GK` أو `DEF` أو `MID` أو `FWD` |
| `num` | نعم | رقم القميص، من 1 إلى 99 |
| `goals` | لا | القيمة الافتراضية `0` |
| `yellow` | لا | القيمة الافتراضية `0` |
| `red` | لا | القيمة الافتراضية `0` |
| `isActive` | لا | القيمة الافتراضية `true`؛ و`false` يحفظ سجل اللاعب ويخفيه من التشكيلة النشطة |
| `licenseId` | لا | رقم الرخصة، فريد عند ضبطه. للمشرفين فقط: يُخزّن في `player_profiles` ولا يظهر للزوار |
| `birthDate` | لا | `YYYY-MM-DD` بين 1900-01-01 و2100-12-31. للمشرفين فقط مثل `licenseId` |

#### `matches.csv`

| العمود | مطلوب | ملاحظات |
|---|---|---|
| `id` | نعم | مثل `m1` |
| `seasonId` | نعم | يجب أن يوجد في `seasons.csv` |
| `round` | نعم | رقم الجولة، 1 أو أكثر |
| `homeId` | نعم | يجب أن يوجد في `teams.csv` |
| `awayId` | نعم | يجب أن يوجد في `teams.csv` ويختلف عن `homeId` |
| `homeScore` | لا | القيمة الافتراضية `0` |
| `awayScore` | لا | القيمة الافتراضية `0` |
| `status` | نعم | `SCHEDULED` أو `LIVE` أو `FINISHED` |
| `datetime` | لا | `YYYY-MM-DDTHH:MM` |
| `venue` | لا | نص حر |
| `scorersText` | لا | نص حر |
| `eventsCounted` | لا | `true` (افتراضيًا) أو `false`؛ انظر أدناه |

ضع الحقل بين علامتي تنصيص مزدوجتين عندما يحتوي على فاصلة، مثل:

```csv
m1,s1,1,t1,t2,3,1,FINISHED,2026-10-03T15:00,Main Field,"Carlos Ramos (2), David Silva (1)"
```

المباريات بحالة `FINISHED` وحدها تُحتسب في جدول الترتيب.

#### `events.csv`

اختياري. أضف الأهداف والبطاقات مع الدقيقة التي حدثت فيها. اللاعبون مرتبطون بمباراة
ويجب أن ينتموا إلى أحد الفريقين المتنافسين.

| العمود | مطلوب | ملاحظات |
|---|---|---|
| `id` | نعم | مثل `e1` |
| `matchId` | نعم | يجب أن يوجد في `matches.csv` |
| `teamId` | نعم | يجب أن يكون الفريق المضيف أو الضيف في تلك المباراة |
| `playerId` | نعم | يجب أن يوجد في `players.csv` وينتمي إلى `teamId` |
| `type` | نعم | `goal` أو `yellow` أو `red` |
| `minute` | نعم | من 1 إلى 130 |

مثال:

```csv
id,matchId,teamId,playerId,type,minute
e1,m1,t1,p2,goal,23
e2,m1,t1,p1,goal,54
e3,m1,t2,p3,yellow,42
e4,m1,t2,p3,red,88
```

تبقى الإجماليات في `players.csv` هي المجاميع التراكمية المعروضة على بطاقات اللاعبين.
أما صفوف الأحداث فهي التي تُظهر الخط الزمني للأهداف والبطاقات على المباراة.

يتحكم `eventsCounted` في ما إذا كانت صفوف الأحداث تُعدّل تلك المجاميع التراكمية.
المباريات الجديدة تأخذ `true` افتراضيًا. وعند ترحيل قاعدة بيانات قائمة، تُعلَّم
مبارياتها القديمة بـ `false` حتى لا تُحتسب أهدافها وبطاقاتها المسجّلة يدويًا مرتين عند
إضافة أول أحداث لها. اجعله `true` فقط عندما تكون الإجماليات في `players.csv` **لا**
تتضمن أحداث تلك المباراة بعد.

في المباريات المعلّمة بـ `false`، يؤدي حفظ الأحداث إلى تحديث الخط الزمني مع ترك إجماليات
اللاعبين كما هي؛ حدّثها يدويًا عند الحاجة. أما المباريات الجديدة المنشأة في التطبيق
فتبدأ بـ `true` وتُبقي الإجماليات متزامنة تلقائيًا. وعند تحويل مجموعة CSV قديمة بلا
عمود `eventsCounted` يكون الافتراضي `true`؛ أضف العمود بالقيمة `false` لأي مباريات
تاريخية أهدافها وبطاقاتها موجودة أصلًا في `players.csv`.

### 3. ابنِ نسخة JSON الاحتياطية

من جذر المستودع:

```powershell
node tools/csv-to-backup.js
```

يتحقق السكربت من المعرّفات والمراجع والتواريخ والنتائج وقيم الحالة، ثم يكتب:

```text
backups/kickoff-import-YYYY-MM-DD.json
```

ويمكنك أيضًا اختيار مجلد الإدخال وملف الإخراج:

```powershell
node tools/csv-to-backup.js data backups/my-league.json
```

### 4. استوردها في التطبيق

1. صدّر نسخة JSON احتياطية من قاعدة البيانات الحالية أولًا.
2. سجّل الدخول كمشرف.
3. افتح **استيراد نسخة احتياطية (JSON)**.
4. اختر الملف `backups/kickoff-import-*.json` الذي وُلّد.
5. تحقق من الترتيب والمباريات للموسم النشط.

> الاستيراد يستبدل **كل** الفرق واللاعبين والمواسم والمباريات وأحداث المباريات في قاعدة
> البيانات المتصلة. افعل ذلك في مشروع التطوير أولًا. وعندما تبدو البيانات صحيحة، أعد
> العملية على الإنتاج.

### 5. بعد الاستيراد

- أنشئ موسمًا جديدًا من التطبيق للبطولات القادمة.
- أبقِ `data/*.csv` محدّثة إن أردت إعادة توليد النسخة الاحتياطية لاحقًا.
- استخدم **تصدير نسخة احتياطية (JSON)** بعد إجراء تغييرات في التطبيق.
- استخدم **الترتيب CSV / المباريات CSV / التشكيلات CSV** لمشاركة أو طباعة الموسم
  المعروض حاليًا في التطبيق.

---

## Français

Utilisez les cinq fichiers CSV de `data/` pour construire un championnat complet, puis
convertissez-les en une sauvegarde JSON que l'application peut importer. C'est bien plus
rapide que de saisir tout un calendrier dans le navigateur.

### 1. Créer les fichiers de travail

Copiez les exemples :

```powershell
Copy-Item data\examples\*.csv data\
```

Modifiez les copies dans `data/`. Ne modifiez pas les fichiers de `data/examples/`.

Les fichiers `data/*.csv` sont ignorés par git : de vraies données de championnat ne
peuvent pas être commitées par accident.

Si vous avez déjà une sauvegarde JSON, vous pouvez générer les cinq fichiers CSV à partir
d'elle :

```powershell
node tools/backup-to-csv.js backups/my-backup.json data --force
```

L'outil refuse d'écraser des CSV existants sans `--force`. C'est pratique pour modifier un
championnat existant dans un tableur avant de le réimporter.

### 2. Colonnes

Tous les fichiers doivent être en CSV UTF-8. La première ligne contient les en-têtes. Les
identifiants doivent être uniques et servent à relier les lignes entre elles.

#### `seasons.csv`

| Colonne | Obligatoire | Remarques |
|---|---|---|
| `id` | oui | par exemple `s1` |
| `name` | oui | par exemple `2026 Season` |
| `startDate` | non | `YYYY-MM-DD` |
| `endDate` | non | `YYYY-MM-DD`, à la date de `startDate` ou après |
| `isActive` | oui | exactement une saison doit valoir `true` |

#### `teams.csv`

| Colonne | Obligatoire | Remarques |
|---|---|---|
| `id` | oui | par exemple `t1` |
| `name` | oui | nom du club (écriture latine) |
| `nameAr` | non | nom arabe, affiché à côté du nom latin |
| `icon` | non | écusson du club en data URL PNG/JPEG/WebP (100000 caractères maximum). L'application le produit elle-même ; laissez vide si vous n'en avez pas. Doit être entre guillemets dans le CSV |
| `code` | oui | code court, par exemple `SFC` |
| `color` | oui | hexadécimal à six chiffres, par exemple `#3b82f6` |

#### `players.csv`

| Colonne | Obligatoire | Remarques |
|---|---|---|
| `id` | oui | par exemple `p1` |
| `teamId` | oui | doit exister dans `teams.csv` |
| `name` | oui | nom du joueur (écriture latine) |
| `nameAr` | non | nom arabe, affiché à côté du nom latin |
| `pos` | oui | `GK`, `DEF`, `MID` ou `FWD` |
| `num` | oui | numéro de maillot, 1–99 |
| `goals` | non | vaut `0` par défaut |
| `yellow` | non | vaut `0` par défaut |
| `red` | non | vaut `0` par défaut |
| `isActive` | non | vaut `true` par défaut ; `false` conserve l'historique du joueur mais le cache de l'effectif actif |
| `licenseId` | non | numéro de licence, unique lorsqu'il est renseigné. Réservé aux admins : stocké dans `player_profiles`, jamais montré aux visiteurs |
| `birthDate` | non | `YYYY-MM-DD` entre 1900-01-01 et 2100-12-31. Réservé aux admins, comme `licenseId` |

#### `matches.csv`

| Colonne | Obligatoire | Remarques |
|---|---|---|
| `id` | oui | par exemple `m1` |
| `seasonId` | oui | doit exister dans `seasons.csv` |
| `round` | oui | journée du match, 1 ou plus |
| `homeId` | oui | doit exister dans `teams.csv` |
| `awayId` | oui | doit exister dans `teams.csv` et différer de `homeId` |
| `homeScore` | non | vaut `0` par défaut |
| `awayScore` | non | vaut `0` par défaut |
| `status` | oui | `SCHEDULED`, `LIVE` ou `FINISHED` |
| `datetime` | non | `YYYY-MM-DDTHH:MM` |
| `venue` | non | texte libre |
| `scorersText` | non | texte libre |
| `eventsCounted` | non | `true` (par défaut) ou `false` ; voir plus bas |

Entourez un champ de guillemets doubles lorsqu'il contient une virgule, par exemple :

```csv
m1,s1,1,t1,t2,3,1,FINISHED,2026-10-03T15:00,Main Field,"Carlos Ramos (2), David Silva (1)"
```

Seuls les matchs `FINISHED` comptent pour le classement.

#### `events.csv`

Facultatif. Ajoutez les buts et les cartons avec la minute où ils ont eu lieu. Les joueurs
sont liés à un match et doivent appartenir à l'une des deux équipes qui jouent.

| Colonne | Obligatoire | Remarques |
|---|---|---|
| `id` | oui | par exemple `e1` |
| `matchId` | oui | doit exister dans `matches.csv` |
| `teamId` | oui | doit être l'équipe à domicile ou à l'extérieur de ce match |
| `playerId` | oui | doit exister dans `players.csv` et appartenir à `teamId` |
| `type` | oui | `goal`, `yellow` ou `red` |
| `minute` | oui | 1–130 |

Exemple :

```csv
id,matchId,teamId,playerId,type,minute
e1,m1,t1,p2,goal,23
e2,m1,t1,p1,goal,54
e3,m1,t2,p3,yellow,42
e4,m1,t2,p3,red,88
```

Les totaux de `players.csv` restent les totaux cumulés affichés sur les fiches de joueur.
Ce sont les lignes d'événements qui font apparaître la chronologie des buts et cartons sur
le match.

`eventsCounted` détermine si les lignes d'événements modifient ces totaux cumulés. Les
nouveaux matchs valent `true` par défaut. Lorsqu'une base existante est migrée, ses anciens
matchs passent à `false` pour que l'ajout de leurs premiers événements ne compte pas deux
fois des buts et cartons déjà saisis à la main. Mettez `true` uniquement quand les totaux de
`players.csv` n'incluent **pas** déjà les événements de ce match.

Pour les matchs à `false`, enregistrer des événements met à jour la chronologie mais laisse
les totaux des joueurs inchangés ; corrigez-les à la main si besoin. Les matchs créés dans
l'application démarrent à `true` et gardent les totaux synchronisés automatiquement. En
convertissant un ancien jeu de CSV sans colonne `eventsCounted`, la valeur par défaut est
`true` ; ajoutez la colonne avec `false` pour les matchs historiques dont les buts et
cartons figurent déjà dans `players.csv`.

### 3. Construire la sauvegarde JSON

Depuis la racine du dépôt :

```powershell
node tools/csv-to-backup.js
```

Le script valide les identifiants, les références, les dates, les scores et les statuts,
puis écrit :

```text
backups/kickoff-import-YYYY-MM-DD.json
```

Vous pouvez aussi choisir le dossier d'entrée et le fichier de sortie :

```powershell
node tools/csv-to-backup.js data backups/my-league.json
```

### 4. Importer dans l'application

1. Exportez d'abord une sauvegarde JSON de la base actuelle.
2. Connectez-vous en tant qu'admin.
3. Ouvrez **Importer Sauvegarde (JSON)**.
4. Choisissez le fichier `backups/kickoff-import-*.json` généré.
5. Vérifiez le classement et le calendrier de la saison active.

> L'import remplace **toutes** les équipes, joueurs, saisons, matchs et événements de la
> base connectée. Faites-le d'abord dans le projet de développement. Quand les données
> semblent correctes, répétez l'opération sur la production.

### 5. Après l'import

- Créez une nouvelle saison depuis l'application pour les compétitions à venir.
- Gardez `data/*.csv` à jour si vous voulez régénérer la sauvegarde plus tard.
- Utilisez **Exporter Sauvegarde (JSON)** après des modifications dans l'application.
- Utilisez **Classement CSV / Calendrier CSV / Effectifs CSV** pour partager ou imprimer
  la saison affichée dans l'application.

---

## English

Use the five CSV files in `data/` to build a complete league, then convert them into
a JSON backup the app can import. This is much faster than typing a full fixture list
into the browser.

### 1. Create your working files

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

### 2. Columns

All files must be UTF-8 CSV. The first row is the header. IDs must be unique and are
used to link rows together.

#### `seasons.csv`

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `s1` |
| `name` | yes | e.g. `2026 Season` |
| `startDate` | no | `YYYY-MM-DD` |
| `endDate` | no | `YYYY-MM-DD`, on or after `startDate` |
| `isActive` | yes | Exactly one season must be `true` |

#### `teams.csv`

| Column | Required | Notes |
|---|---|---|
| `id` | yes | e.g. `t1` |
| `name` | yes | Club name (Latin script) |
| `nameAr` | no | Arabic name, shown alongside the Latin one |
| `icon` | no | Club crest as a PNG/JPEG/WebP data URL (max 100000 characters). The app produces this itself; leave blank if you do not have one. Must be quoted in the CSV |
| `code` | yes | Short code, e.g. `SFC` |
| `color` | yes | Six-digit hex, e.g. `#3b82f6` |

#### `players.csv`

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

#### `matches.csv`

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

#### `events.csv`

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

### 3. Build the JSON backup

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

### 4. Import into the app

1. Export a JSON backup of the current database first.
2. Sign in as admin.
3. Open **Settings → Import Backup (JSON)**.
4. Choose the generated `backups/kickoff-import-*.json` file.
5. Check the standings and fixtures for the active season.

> Import replaces **all** teams, players, seasons, matches and match events in the
> connected database. Do this in the development project first. When the data looks
> right, repeat it against production.

### 5. After the import

- Create a new season from the app for future competitions.
- Keep `data/*.csv` up to date if you want to regenerate the backup later.
- Use **Settings → Export Backup (JSON)** after making changes in the app.
- Use **Settings → Standings CSV / Fixtures CSV / Squads CSV** to share or
  print the season currently shown in the app.
