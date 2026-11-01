# Squad import examples

[العربية](#العربية) · [Français](#français) · [English](#english)

---

## العربية

ملفات جاهزة للاستخدام في **الفرق واللاعبون → (بطاقة الفريق) → استيراد التشكيلة**.

لكل لغة ملفها: نفس اللاعبين الأربعة (حارس ومدافع ووسط ومهاجم) في كل نسخة، ولا يتغيّر
إلا صف العناوين. اختر النسخة التي تناسب من سيملأ الملف.

| الملف | صف العناوين | ملاحظات |
|---|---|---|
| `squad-example-en.xlsx` و`.csv` | `Name, Arabic Name, Position, Number, Licence, Birth date, Goals, Yellow, Red` | فاصلة `,` في CSV |
| `squad-example-fr.xlsx` و`.csv` | `Nom, Nom arabe, Poste, Numéro, Licence, Date de naissance, Buts, Jaunes, Rouges` | فاصلة منقوطة `;` في CSV حتى يفتحه Excel الفرنسي صحيحًا |
| `squad-example-ar.xlsx` و`.csv` | `الاسم, الاسم العربي, المركز, الرقم, رخصة, تاريخ الميلاد, الأهداف, بطاقات صفراء, بطاقات حمراء` | فاصلة `,` في CSV |

ينزّل التطبيق الملف المطابق للغة المعروضة في نافذة الاستيراد:

- **تنزيل مثال معبأ (Excel)** → `squad-example-<اللغة>.xlsx`
- **تنزيل القالب (CSV)** → قالب فارغ بصف عناوين فقط، باللغة نفسها.

كل النسخ تُستورد في أي لغة كانت الواجهة: يقرأ التطبيق صف العناوين بالعربية أو الفرنسية
أو الإنجليزية، فلا داعي لإعادة تسمية الأعمدة.

### الأعمدة

الأسماء أدناه بالإنجليزية؛ النسخة العربية من القالب تستخدم `الاسم`، والفرنسية `Nom`،
وكلها مقبولة. عمود **Name** وحده مطلوب. يمكن حذف أي عمود آخر بالكامل ما دام موجودًا.
يبحث التطبيق عن صف العناوين في أول 15 صفًا، لذا لا مشكلة في وجود سطر عنوان فوقه.

| العمود | مطلوب | القيم المقبولة |
|---|---|---|
| `Name` | نعم | الاسم الكامل، من 1 إلى 60 حرفًا. ويُقبل أيضًا `Nom` و`Player` و`الاسم`. |
| `Arabic Name` | لا | الكتابة العربية، تُعرض عندما يكون التطبيق بالعربية. |
| `Position` | لا | `GK` أو `DEF` أو `MID` أو `FWD`، أو كلمة بالإنجليزية أو الفرنسية أو العربية: `Goalkeeper`، `Gardien`، `حارس`، `Defender`، `Défenseur`، `Attaquant`، `Milieu`… |
| `Number` | لا | رقم القميص، من 1 إلى 99. الأصفار البادئة مقبولة (`04` تصبح `4`). |
| `Licence` | لا | رقم الرخصة، حتى 50 حرفًا، ويجب أن يكون فريدًا داخل الملف. |
| `Birth date` | لا | `YYYY-MM-DD` أو `D/M/YYYY`، بين 1900-01-01 واليوم. |
| `Goals` | لا | عدد صحيح للأهداف المسجّلة في الموسم الحالي. |
| `Yellow` | لا | عدد صحيح للبطاقات الصفراء. |
| `Red` | لا | عدد صحيح للبطاقات الحمراء. |

### ما يحدث عند الاستيراد

1. يُفحص كل صف أولًا؛ **لا يُكتب أي شيء** قبل الضغط على *إضافة اللاعبين*.
2. اللاعب الموجود أصلًا في التشكيلة (بالاسم نفسه) يُتخطى ولا يُكرر.
3. رقم القميص المستخدم مسبقًا **تحذير** فقط: يمكن استيراد الصف رغم ذلك.
4. الاسم الفارغ، أو المركز غير المعروف، أو رقم خارج 1–99، أو رخصة مكررة، أو تاريخ
   ميلاد غير صالح، أو رقم غير مقروء: **خطأ** يمنع الاستيراد كله حتى يُصحح الصف أو
   يُحذف.
5. الحد الأقصى 100 لاعب و2000 صف في الملف الواحد.

### نصائح لجدول البيانات

- أبقِ البيانات في الورقة الأولى؛ اسم الورقة لا يهم.
- لا تدمج الخلايا ولا تضف مجاميع فرعية ولا تترك خلايا عناوين فارغة وسط الصف.
- إذا لم يُحمّل الملف، أعد حفظه بصيغة **.xlsx** (لا .xls) أو صدّره بصيغة **CSV UTF-8**.

---

## Français

Fichiers prêts à l'emploi pour **Équipes & Joueurs → (fiche de l'équipe) → importer l'effectif**.

Chaque langue a son fichier : les quatre mêmes joueurs (gardien, défenseur, milieu,
attaquant) dans chaque version, seule la ligne d'en-tête change. Prenez la version qui
convient à la personne qui remplira le fichier.

| Fichier | Ligne d'en-tête | Remarques |
|---|---|---|
| `squad-example-en.xlsx` et `.csv` | `Name, Arabic Name, Position, Number, Licence, Birth date, Goals, Yellow, Red` | virgule `,` en CSV |
| `squad-example-fr.xlsx` et `.csv` | `Nom, Nom arabe, Poste, Numéro, Licence, Date de naissance, Buts, Jaunes, Rouges` | point-virgule `;` en CSV pour qu'Excel français l'ouvre correctement |
| `squad-example-ar.xlsx` et `.csv` | `الاسم, الاسم العربي, المركز, الرقم, رخصة, تاريخ الميلاد, الأهداف, بطاقات صفراء, بطاقات حمراء` | virgule `,` en CSV |

L'application télécharge le fichier de la langue affichée depuis la fenêtre d'import :

- **Télécharger un exemple rempli (Excel)** → `squad-example-<langue>.xlsx`
- **Télécharger le modèle (CSV)** → un modèle vide avec seulement la ligne d'en-tête, dans la même langue.

Toutes les versions s'importent quelle que soit la langue de l'interface : l'application lit
la ligne d'en-tête en arabe, en français ou en anglais, sans renommer les colonnes.

### Colonnes

Les noms ci-dessous sont en anglais ; le modèle arabe utilise `الاسم`, le français `Nom`,
et tous sont acceptés. Seul **Name** est obligatoire. Toute autre colonne peut être
supprimée, tant que la colonne du nom reste. La ligne d'en-tête est cherchée dans les 15
premières lignes : une ligne de titre au-dessus ne gêne pas.

| Colonne | Obligatoire | Valeurs acceptées |
|---|---|---|
| `Name` | oui | Nom complet, 1 à 60 caractères. `Nom`, `Player` et `الاسم` fonctionnent aussi. |
| `Arabic Name` | non | Écriture arabe, affichée quand l'application est en arabe. |
| `Position` | non | `GK`, `DEF`, `MID` ou `FWD`, ou un mot en anglais, français ou arabe : `Goalkeeper`, `Gardien`, `حارس`, `Defender`, `Défenseur`, `Attaquant`, `Milieu`… |
| `Number` | non | Numéro de maillot, 1 à 99. Les zéros initiaux sont acceptés (`04` devient `4`). |
| `Licence` | non | Numéro de licence, 50 caractères maximum, unique dans le fichier. |
| `Birth date` | non | `YYYY-MM-DD` ou `D/M/YYYY`, entre 1900-01-01 et aujourd'hui. |
| `Goals` | non | Nombre entier de buts déjà marqués cette saison. |
| `Yellow` | non | Nombre entier de cartons jaunes. |
| `Red` | non | Nombre entier de cartons rouges. |

### Ce qui se passe à l'import

1. Chaque ligne est vérifiée d'abord ; **rien n'est écrit** avant de cliquer sur
   *Ajouter les joueurs*.
2. Un joueur déjà présent dans l'effectif (même nom) est ignoré, pas dupliqué.
3. Un numéro de maillot déjà pris est un **avertissement** : la ligne peut quand même
   être importée.
4. Un nom vide, un poste inconnu, un numéro hors 1–99, une licence en double, une date de
   naissance invalide ou un nombre illisible est une **erreur** : tout l'import est
   bloqué jusqu'à correction ou suppression de la ligne.
5. Le maximum est de 100 joueurs et 2000 lignes par fichier.

### Conseils pour le tableur

- Gardez les données sur la première feuille ; le nom de la feuille n'a pas d'importance.
- Ne fusionnez pas de cellules, n'ajoutez pas de sous-totaux et ne laissez pas de cellules
  d'en-tête vides au milieu de la ligne.
- Si un fichier ne se charge pas, réenregistrez-le en **.xlsx** (pas .xls) ou exportez-le
  en **CSV UTF-8**.

---

## English

Ready-to-use files for **Teams → (team card) → import squad**.

Each language has its own file: the same four players (goalkeeper, defender, midfielder,
forward) in every version, only the header row changes. Pick the version that suits whoever
will fill it in.

| File | Header row | Notes |
|---|---|---|
| `squad-example-en.xlsx` and `.csv` | `Name, Arabic Name, Position, Number, Licence, Birth date, Goals, Yellow, Red` | comma `,` in CSV |
| `squad-example-fr.xlsx` and `.csv` | `Nom, Nom arabe, Poste, Numéro, Licence, Date de naissance, Buts, Jaunes, Rouges` | semicolon `;` in CSV so French Excel opens it correctly |
| `squad-example-ar.xlsx` and `.csv` | `الاسم, الاسم العربي, المركز, الرقم, رخصة, تاريخ الميلاد, الأهداف, بطاقات صفراء, بطاقات حمراء` | comma `,` in CSV |

The app downloads the file for the language on screen from the import dialog:

- **Download filled example (Excel)** → `squad-example-<language>.xlsx`
- **Download template (CSV)** → an empty template with only the header row, in the same language.

Every version imports whatever the interface language: the app reads the header row in
Arabic, French or English, so nobody has to rename columns.

### Columns

The names below are English; the Arabic template uses `الاسم`, the French one `Nom`, and all
are accepted. Only **Name** is required. Any other column can be left out entirely, as long
as the name column stays. The header row is looked for in the first 15 rows, so a title line
above it is fine.

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

### What happens on import

1. Every row is checked first; **nothing is written** before you press *Add players*.
2. A player already in the squad (same name) is skipped, not duplicated.
3. A shirt number already taken is a **warning**: the row can still be imported.
4. An empty name, an unknown position, a number outside 1–99, a duplicate licence,
   a bad birth date or an unreadable number is an **error**: the whole import is blocked
   until the row is fixed or removed.
5. The maximum is 100 players and 2000 rows per file.

### Spreadsheet tips

* Keep the data on the first sheet; the sheet name does not matter.
* Do not merge cells, add subtotals or leave blank header cells in the middle of the row.
* If a file does not load, save it again as **.xlsx** (not .xls) or export it as **CSV UTF-8**.
