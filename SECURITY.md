# Security policy

[العربية](#العربية) · [Français](#français) · [English](#english)

---

## العربية

### الإصدارات المدعومة

تُطبَّق إصلاحات الأمان على فرع `main` والنشر الإنتاجي الحالي. لا توجد فروع دعم طويلة
الأمد.

### الإبلاغ عن ثغرة

من فضلك **لا** تفتح بلاغًا عامًا لثغرة قد تكشف بيانات أو حسابات مشرفين أو صلاحية كتابة.

استخدم الإبلاغ الخاص عن الثغرات في GitHub لهذا المستودع إن كان مفعّلًا:

<https://github.com/Boulakdane/football-division-manager/security/advisories/new>

إذا لم يتوفر الإبلاغ الخاص، تواصل مع المشرف عبر ملفه في GitHub المرتبط بالمستودع
واطلب قناة خاصة. لا تضع تفاصيل الاستغلال في بلاغ عام.

أرفق:

- الرابط أو الملف أو دالة قاعدة البيانات المتأثرة؛
- خطوات إعادة إنتاج المشكلة؛
- التأثير الذي تعتقد أنه ممكن؛
- تفاصيل المتصفح أو الجهاز وأي سجلات أو صور شاشة ذات صلة؛
- إصلاحًا مقترحًا إن كان لديك واحد.

### أهداف الاستجابة

هذه أهداف على أساس الجهد في مشروع يخدمه متطوعون:

| المرحلة | الهدف |
|---|---|
| الإقرار | 72 ساعة |
| الفرز المبدئي | 7 أيام |
| إصلاح أو تخفيف للمشاكل الحرجة/العالية | 30 يومًا |
| الإفصاح العام | بعد نشر الإصلاح، بالتنسيق مع المُبلّغ |

### النطاق

داخل النطاق:

- الواجهة الساكنة في هذا المستودع؛
- Supabase Auth وسياسات RLS ودوال RPC ونموذج البيانات؛
- استيراد وتصدير CSV/JSON؛
- سير عمل GitHub Actions وإعدادات النشر.

خارج النطاق أو أولوية أدنى:

- حجب الخدمة عن بنية تحتية مجانية؛
- الهندسة الاجتماعية؛
- رؤوس استجابة مفقودة لا يستطيع GitHub Pages ضبطها (أبلغ عنها رغم ذلك؛ فهي متتبَّعة
  في خطة الأمان)؛
- مفتاح Supabase العام publishable/anon، فهو مصمم ليكون عامًا؛
- البيانات التجريبية/النموذجية.

### قواعد الاختبار الآمن

- فضّل بيئة التطوير (`?env=dev` أو localhost).
- لا تحذف بيانات دوري حقيقية ولا تعدّلها ولا تسرّبها.
- لا تدخل إلى حساب شخص آخر أو بياناته الشخصية.
- توقف وأبلغ فورًا إذا وصلت إلى بيانات أو بيانات دخول مشرف حقيقية.
- امنح المشرف وقتًا معقولًا لإصلاح المشكلة قبل الإفصاح.

### نموذج الأمان الحالي

- الزوار المجهولون لديهم وصول للقراءة فقط.
- لا يكتب إلا المستخدمون الموثّقون ذوو `role = 'admin'`.
- Row Level Security في Postgres هو حد الفرض؛ إخفاء أزرار الواجهة مجرد تسهيل.
- بعد تطبيق `supabase/integrity-migration.sql` تصبح المواسم المؤرشفة للقراءة فقط في
  RLS. حذف الفرق والمباريات وكتابة أحداث المباريات تمر عبر دوال RPC للمشرفين وحدهم حتى
  تبقى إجماليات اللاعبين متسقة؛ وقد سُحبت صلاحيات الحذف المباشرة.
- لا تُشحن إلى المتصفح إلا مفاتيح Supabase العامة. لا تُودع مفتاح service-role/secret
  أبدًا.
- ترقية المشرف عملية SQL يدوية.
- التسجيل الذاتي معطّل.
- تُشغّل CI ماسحًا للأسرار واختبارات تكامل SQL/RLS، وDependabot مفعّل.

انظر [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) للنتائج الكاملة وخطة المعالجة.

---

## Français

### Versions prises en charge

Les correctifs de sécurité sont appliqués à la branche `main` et au déploiement de
production actuel. Il n'y a pas de branche de support à long terme.

### Signaler une vulnérabilité

Merci de **ne pas** ouvrir d'issue publique pour une vulnérabilité qui pourrait exposer
des données, des comptes admin ou un accès en écriture.

Utilisez le signalement privé de vulnérabilités GitHub pour ce dépôt s'il est activé :

<https://github.com/Boulakdane/football-division-manager/security/advisories/new>

Si le signalement privé n'est pas disponible, contactez le mainteneur via son profil
GitHub lié au dépôt et demandez un canal privé. N'incluez pas de détails d'exploitation
dans une issue publique.

Indiquez :

- l'URL, le fichier ou la fonction de base de données concernés ;
- les étapes de reproduction ;
- l'impact que vous jugez possible ;
- les détails de navigateur/appareil et les journaux ou captures pertinents ;
- un correctif suggéré, si vous en avez un.

### Délais de réponse

Ce sont des objectifs de bonnes pratiques pour un projet maintenu bénévolement :

| Étape | Objectif |
|---|---|
| Accusé de réception | 72 heures |
| Qualification initiale | 7 jours |
| Correctif ou atténuation pour les problèmes critiques/élevés | 30 jours |
| Divulgation publique | après déploiement du correctif, en accord avec le rapporteur |

### Périmètre

Dans le périmètre :

- le frontend statique de ce dépôt ;
- Supabase Auth, les politiques RLS, les fonctions RPC et le modèle de données ;
- l'import et l'export CSV/JSON ;
- les workflows GitHub Actions et la configuration de déploiement.

Hors périmètre ou priorité moindre :

- le déni de service contre une infrastructure gratuite ;
- l'ingénierie sociale ;
- les en-têtes de réponse manquants que GitHub Pages ne peut pas définir (signalez-les
  quand même ; ils sont suivis dans le plan de sécurité) ;
- la clé Supabase publishable/anon publique, conçue pour être publique ;
- les données d'exemple/démo.

### Règles de test sûres

- Privilégiez l'environnement de développement (`?env=dev` ou localhost).
- Ne supprimez, ne modifiez pas et n'exfiltrez pas de vraies données de championnat.
- N'accédez pas au compte ou aux données personnelles d'autrui.
- Arrêtez le test et signalez immédiatement si vous atteignez de vrais identifiants ou de
  vraies données d'admin.
- Laissez au mainteneur un délai raisonnable pour corriger avant toute divulgation.

### Modèle de sécurité actuel

- Les visiteurs anonymes ont un accès en lecture seule.
- Seuls les utilisateurs authentifiés avec `role = 'admin'` peuvent écrire.
- Le Row Level Security de Postgres est la barrière d'application ; masquer des contrôles
  d'interface n'est qu'un confort.
- Une fois `supabase/integrity-migration.sql` appliqué, les saisons archivées sont en
  lecture seule dans le RLS. La suppression d'équipes/de matchs et l'écriture d'événements
  passent par des RPC réservées aux admins pour garder les totaux des joueurs cohérents ;
  les droits de suppression directe sont révoqués.
- Seules les clés Supabase publiques sont envoyées au navigateur. Ne commitez jamais une
  clé service-role/secret.
- La promotion admin est une opération SQL manuelle.
- Les inscriptions sont désactivées.
- La CI exécute un scanner de secrets et des tests SQL/RLS, et Dependabot est activé.

Voir [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) pour les constats complets et le plan
de remédiation.

---

## English

### Supported versions

Security fixes are applied to the `main` branch and the current production
deployment. There are no long-term support branches.

### Reporting a vulnerability

Please do **not** open a public issue for a vulnerability that could expose data,
admin accounts or write access.

Use GitHub's private vulnerability reporting for this repository if it is enabled:

<https://github.com/Boulakdane/football-division-manager/security/advisories/new>

If private reporting is unavailable, contact the maintainer through the GitHub
profile linked from the repository and ask for a private channel. Do not include
exploit details in a public issue.

Include:

- the affected URL, file or database function;
- steps to reproduce;
- the impact you believe is possible;
- browser/device details and any relevant logs or screenshots;
- a suggested fix, if you have one.

### Response targets

These are best-effort targets for a volunteer-maintained project:

| Stage | Target |
|---|---|
| Acknowledgement | 72 hours |
| Initial triage | 7 days |
| Fix or mitigation for critical/high issues | 30 days |
| Public disclosure | After a fix is deployed, coordinated with the reporter |

### Scope

In scope:

- the static frontend in this repository;
- Supabase Auth, RLS policies, RPC functions and data model;
- CSV/JSON import and export;
- GitHub Actions workflows and deployment configuration.

Out of scope or lower priority:

- denial of service against free-tier infrastructure;
- social engineering;
- missing response headers that GitHub Pages cannot set (still report them; they
  are tracked in the security plan);
- the public Supabase publishable/anon key, which is designed to be public;
- sample/demo data.

### Safe testing rules

- Prefer the development environment (`?env=dev` or localhost).
- Do not delete, modify or exfiltrate real league data.
- Do not access another person's account or personal data.
- Stop testing and report immediately if you reach real admin credentials or data.
- Give the maintainer reasonable time to fix the issue before disclosure.

### Current security model

- Anonymous visitors have read-only access.
- Only authenticated users with `role = 'admin'` can write.
- Postgres Row Level Security is the enforcement boundary; hidden UI controls are
  only a convenience.
- Once `supabase/integrity-migration.sql` is applied, archived seasons are read-only
  in RLS. Team/match deletion and match-event writes go through admin-only RPCs so
  player totals stay consistent; direct destructive grants are revoked.
- Only publishable Supabase keys are shipped to the browser. Never commit a
  service-role/secret key.
- Admin promotion is a manual SQL operation.
- Signups are disabled.
- CI runs a secret scanner, SQL integrity/RLS tests and Dependabot is enabled.

See [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) for the full findings and
remediation plan.
