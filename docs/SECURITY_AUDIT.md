# KickOff Division — Security Review and Remediation Plan

- **Review date:** 2026-10-21
- **Scope:** static frontend, Supabase schema/RLS/RPCs, authentication flow, CSV/JSON tooling, GitHub Actions
- **Method:** manual code review, dependency audit, browser smoke tests, source-level abuse cases, and review of the deployed architecture. No destructive testing was performed against production data.

## 1. Executive summary

The application has a sensible security model for a free, zero-server deployment:

- Anonymous visitors can read league data.
- Only authenticated users with `role = 'admin'` can write.
- The real boundary is Postgres Row Level Security, not hidden buttons.
- Only publishable Supabase keys are shipped to the browser.
- Signups are disabled.
- Admin-only RPCs check `public.is_admin()` and run with a fixed `search_path`.

No critical vulnerability was found in this review. The largest residual risks are:

1. **Admin account/session compromise.** An admin can legitimately replace or delete the entire dataset. There is no MFA, step-up authentication, session policy or audit trail. `v3.9.0` adds database-enforced TOTP step-up (the requirement is opt-in until an admin enrols); session policy and login notifications remain open. See SEC-01.
2. **XSS and supply-chain exposure.** The app still renders with `innerHTML` template strings, so a missed `esc()` would inject markup. `v3.6.1` self-hosted every asset and `v3.6.2` removed all inline handlers, so `script-src` is now exactly `'self'` and injected script is blocked. A same-origin compromise could still read the Supabase session from browser storage.
3. **Destructive imports still lack a preview and audit trail.** Atomic rollback is live-tested in production, and `v3.7.0` adds an admin-only audit log, but an admin can still replace all data without a dry-run diff. Trash/restore for teams, matches and seasons landed in `v3.8.0`; see SEC-05.

The current pass already reduced some risk: every runtime asset is now self-hosted (Lucide, the Supabase client and the Inter/Cairo webfonts live in `vendor/` and `fonts/`), a Content-Security-Policy in `index.html` pins scripts, styles, fonts and connections to this origin plus Supabase, `v3.6.2` replaced every inline handler with delegated `data-*` actions so `script-src` no longer allows `'unsafe-inline'`, a secret scanner runs in CI, Dependabot is configured, imports are atomic, and the working tree adds database-enforced archive reads, player archiving, safe team deletion, atomic match saves, reversible deletes and opt-in TOTP step-up. The integrity SQL has been applied to the hosted development and production projects and verified live. The plan below closes the remaining gaps.

## 2. Trust boundaries and assets

| Asset | Why it matters |
|---|---|
| Supabase admin session | Grants full league write access; stored in browser storage by `supabase-js` |
| `profiles.role` | The only privilege flag; promotion is manual SQL |
| League data | Public to read, but integrity matters for standings and history |
| JSON/CSV backups | Complete dataset; may contain personal names and contact-adjacent data |
| CI workflow | Can publish to GitHub Pages and run with repository permissions |
| Publishable Supabase key | Public by design; not a secret, but abuse still costs quota |

```text
Visitor ──read──► Supabase REST ──RLS──► public tables
Admin   ──login─► Supabase Auth ──JWT──► PostgREST ──RLS/RPC──► tables
Admin   ──import─► browser ──multiple requests──► tables
CI      ──push──► GitHub Pages
```

## 3. Threat model

| Actor | Capability | Desired outcome |
|---|---|---|
| Anonymous visitor | Read-only API, can inspect JS and call REST directly | Cannot write, cannot read private profiles |
| Authenticated viewer | Valid account without admin role | Cannot write even with crafted requests |
| Compromised admin | Valid admin session or stolen password | Limit blast radius, detect changes, restore data |
| Malicious backup | Crafted JSON/CSV imported by an admin | Cannot execute script, corrupt stats or inject spreadsheet formulas |
| Compromised CDN | Serves modified third-party JS | SRI/CSP prevents execution |
| Lost admin device | Cached session | Session expiry/revocation, MFA, device sign-out |
| Abusive client | Repeated RPC calls | Rate limits, statement timeouts, quotas |

## 4. Findings

### Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC-01 | High | No MFA/step-up authentication for a role that can erase the league | Mitigated and live in both hosted projects (`v3.9.0`); production MFA required and enrolled, development off by design |
| SEC-02 | High | No strict CSP; inline handlers and `innerHTML` keep XSS impact high | Mitigated: all inline handlers replaced by delegated `data-*` actions, CSP ships `script-src 'self'`; residual `style-src 'unsafe-inline'` and template-string escaping discipline |
| SEC-03 | High | Atomic full-data import RPC installed and live-tested; no-op and rollback verified | Mitigated |
| SEC-04 | Medium | Third-party CDN and font dependency | Mitigated: Lucide, Supabase JS and the Inter/Cairo fonts are vendored; CSP leaves no external script/style/font origin |
| SEC-05 | Medium | No audit log, soft delete or restore path | Mitigated and applied in both hosted projects (`v3.7.0` audit log, `v3.8.0` trash/restore) |
| SEC-06 | Medium | Archived seasons are read-only only in the UI | Mitigated and applied in both hosted projects (integrity migration) |
| SEC-07 | Medium | Server-side data validation is incomplete | Partially mitigated: import references validated in RPC; CHECK constraints still open |
| SEC-08 | Medium | Security headers cannot be set on GitHub Pages | Open |
| SEC-09 | Medium | CSV formula injection in exported files | Mitigated |
| SEC-10 | Low | Environment override (`?env=prod`) can point local work at production | Open |
| SEC-11 | Low | No rate limiting or statement timeout for admin RPCs | Open |
| SEC-12 | Low | Local backups are unencrypted | Open |
| SEC-13 | Medium | Destructive deletes could leave aggregate totals inconsistent | Mitigated and applied in both hosted projects (integrity migration) |

### SEC-01 — Admin account takeover has no second factor

**Severity:** High
**Status:** Mitigated and verified in both hosted projects (`v3.9.0`). The real production admin has now enrolled a TOTP factor and enabled the requirement; `admin_mfa_required()` returns `true` in production. Development remains off for disposable testing.

**Evidence (original):** `js/auth.js` used email + password only. Password minimum is 6 characters. There was no MFA prompt, no `aal2` check in `is_admin()`, no session timeout, no “sign out all devices”, and no notification on admin login. The admin role can call `replace_match_events`, `delete_match`, `activate_season` and full-data replacement.

**Impact:** A phished or reused admin password gives an attacker full control of the league. They can delete seasons, rewrite results, corrupt player totals or replace the entire dataset.

**Remediation implemented:**
1. TOTP enrolment and step-up live in `js/mfa.js` and use Supabase Auth MFA (`enroll`, `challenge`, `verify`, `listFactors`, `unenroll`). The dialog handles enrolment (QR + manual key), verification and disabling.
2. The database enforces the assurance level, not the UI: `supabase/mfa-migration.sql` replaces `is_admin()` with a role check **and**, while `security_settings.require_admin_mfa` is on, `coalesce(auth.jwt()->>'aal','aal1') = 'aal2'`. Every RLS policy and admin RPC inherits the gate.
3. The requirement defaults to off, so the migration cannot lock anyone out. `set_require_admin_mfa()` is admin-only, requires an `aal2` session, and records a `SECURITY` audit entry.
4. The frontend prompts for the code after login when the session is locked, shows a header shield/badge, and degrades quietly when the migration has not been applied.
5. `v3.10.0` adds self-service password recovery and a 30-minute app-level idle logout. `v3.10.1` adds an admin **Sign out all devices** action. A successful recovery or global sign-out calls `signOut({ scope: 'global' })`, invalidating every existing refresh token; closing recovery or logging out normally uses the local scope. The idle timer checks wall-clock time on visibility/focus changes, but it is client-side only.

**Still open (tracked elsewhere):** password minimum/pwned-password protection (SEC-03), server-enforced session lifetime, login notifications, and rate limits (SEC-11).

**Acceptance criteria:**
- ✅ A password-only (`aal1`) admin session cannot execute write RPCs (PGlite: direct updates filtered; `save_match`, `list_audit_log`, `list_deleted` raise `42501`).
- ✅ An `aal2` admin can write (PGlite).
- ✅ A viewer or anonymous caller receives `42501` for every write RPC, including the MFA toggle.
- ✅ The UI explains how to enrol MFA and prompts for step-up.
- ✅ `mfa-migration.sql` is applied in development and production; a real admin login (`aal1`) could not update teams or call admin RPCs until a TOTP code was verified, and writes succeeded after step-up. Production data hashed identically before and after the test.
- ✅ The real production admin enrolled a TOTP factor and enabled the requirement; the public `admin_mfa_required()` RPC returns `true` (2026-10-24). Development returns `false` so disposable tests stay password-only.

### SEC-02 — XSS risk from `innerHTML` rendering (mitigated in `v3.6.2`)

**Severity:** High (largely mitigated in `v3.6.2`; residual risk is unescaped interpolation)
**Status:** Mitigated in code. `v3.6.2` deleted all 85 inline `on*` handlers and replaced them with delegated `data-action` / `data-change` / `data-input` / `data-submit` listeners in `js/app.js`. `script-src` is now exactly `'self'`. A live browser test injected an external `<script>`; CSP refused it while same-origin scripts kept running. Every button, select, input and form was exercised through the dispatcher on the development project without touching data.

**Evidence:** historically `index.html` carried inline `onclick`, `onchange` and `oninput` attributes, `js/app.js` builds UI with `innerHTML` and template strings, and `supabase-js` persists the session client-side. `v3.6.2` removed the attribute execution surface entirely: markup now only declares data attributes, and the dispatcher reads untrusted identifiers from `dataset` instead of re-parsing them as JavaScript source.

**Impact:** Any future unescaped field, malicious imported value or compromised dependency that executes script can read the admin session and perform admin actions. `script-src 'self'` prevents injected inline/external script from running, but a same-origin compromise would still execute.

**Remediation:**

1. ✅ Remove inline event handlers. `data-action` / `data-id` attributes plus one delegated `click` / `change` / `input` / `submit` dispatcher.
2. Replace `innerHTML` rendering with DOM construction or a small escaping/template layer with a lint rule. Do not interpolate untrusted values into HTML strings. (Still template strings; every value goes through `esc()`.)
3. ✅ Strict CSP, live in `index.html`:
   - `default-src 'self'`
   - `script-src 'self'`
   - `style-src 'self' 'unsafe-inline'` (inline team-colour styles only)
   - `img-src 'self' data:`
   - `font-src 'self'`
   - `connect-src 'self' https://*.supabase.co wss://*.supabase.co`
   - `base-uri 'self'`
   - `form-action 'self'`
   - `object-src 'none'`
4. Prefer Cloudflare Pages or a Cloudflare proxy for real headers. A meta CSP cannot enforce `frame-ancestors`; GitHub Pages does not allow custom headers.
5. Add `Trusted Types` after the DOM rendering refactor.
6. Add an automated axe/Lighthouse check and a small XSS regression test.

**Acceptance criteria:**

- ✅ No inline `on*` attributes remain in shipped HTML/JS.
- ✅ A strict CSP blocks an injected inline script in a browser test.
- ✅ Admin session data is not readable by injected script.

**Residual work:** `style-src` still needs `'unsafe-inline'` for team-colour `style` attributes; setting them through the CSSOM would allow dropping it. Render paths still use template strings, so every new interpolation must use `esc()`. Trusted Types is not enabled.

### SEC-03 - Full-data import atomic RPC (live-tested)

**Severity:** High
**Status:** Installed and live-tested in development and production. The first production attempt was safely rejected by Supabase `pg-safeupdate`; the patched function now uses qualified deletes. No-op admin imports completed through `replace_all_data` with no client fallback and identical pre/post data hashes in both projects, and invalid event imports rolled back without inserting their test rows. The roadmap H merge-import migration was applied to both projects on 2026-10-28; read-only probes find `import_preview`, `import_merge`, `import_runs` and the L/I columns, and anonymous access is denied.
**Evidence:** before this change, `js/backend.js` `dbReplaceAll()` deleted `match_events`, `matches`, `players`, `teams` and `seasons` in separate requests, then inserted each table in separate requests. RLS protects who can do it, but not what happens if a request fails halfway. The new `public.replace_all_data(jsonb)` performs the delete and insert in one database transaction and the frontend prefers it automatically.

**Impact:** A network error, constraint violation or malformed import can leave the league partially deleted or with orphaned/incomplete data only if the RPC is unavailable and the frontend falls back. The admin may not have a fresh backup. This is the most likely way to lose real data.

**Remediation:**

1. ✅ Implement one admin-only `replace_all_data(payload jsonb)` RPC in
   [`supabase/atomic-import-migration.sql`](../supabase/atomic-import-migration.sql) and
   [`supabase/schema.sql`](../supabase/schema.sql).
2. ✅ Add `pg_advisory_xact_lock` so two admins cannot import concurrently.
3. ✅ Validate payload shape, exactly one active season, and event-to-fixture/team/player
   relationships server-side. Broader value-range `CHECK` constraints remain SEC-07.
4. ✅ Add a dry-run mode that returns counts and a diff summary before commit. Done in the
   roadmap H PR: `import_preview(payload, remove_missing)` returns per-table
   added/changed/removed/unchanged counts plus a capped entity list and writes nothing.
   Applied in development and production (2026-10-28).
5. ✅ Store an import checksum/idempotency key and a “last import” record. Done in the
   roadmap H PR: `import_runs` stores the SHA-256 checksum, the idempotency key and the
   stored result, so a retry returns `replayed: true` and a key reused for a different
   payload is rejected. Applied in development and production (2026-10-28).
6. ✅ Require a fresh JSON backup download before the replacement, and keep the previous
   snapshot for rollback. The replace-all panel still calls `exportData()` before
   `replace_all_data`, and the merge mode now means a full replacement is no longer the
   normal bulk path.
7. ✅ Show a clear confirmation with counts of rows to be deleted. The dialog shows the
   per-table diff and the live-row count (`changed + unchanged + removed`) before the merge,
   and replace-all stays behind step-up MFA plus a typed `REPLACE`.

**Acceptance criteria:**

- ✅ An intentionally invalid import leaves every table byte-for-byte unchanged
  (verified locally, in development and in production; the test rows were absent).
- ✅ A successful import is atomic and completes in one transaction.
- ✅ No-op imports in development and production preserved the pre/post SHA-256
  hashes and used only `replace_all_data`, with no client fallback.
- ✅ Concurrent imports are serialized by the advisory lock.
- ✅ The admin sees a dry-run summary before commit (and a fresh preview whenever
  “remove missing rows” changes). PGlite and browser tests cover it; a hosted admin round trip
  in development confirmed the preview/merge/replay path on 2026-10-28, and read-only probes
  confirm that `import_preview` exists in both hosted projects and refuses anonymous callers.

**Merge follow-up (roadmap H, applied 2026-10-28):**
[`supabase/merge-import-migration.sql`](../supabase/merge-import-migration.sql) adds
`import_preview(payload, remove_missing)` and
`import_merge(payload, idempotency_key, remove_missing, expected_checksum)`. The merge
upserts by id in one transaction and only soft-deletes missing seasons/teams/matches and
archives missing players when the box is ticked; it never hard-deletes. `import_runs`
stores the checksum, the key and the result, and `import_merge` rejects a payload whose
`expected_checksum` no longer matches the preview. The dialog loads the diff, sends the
checksum and a fresh key, and reports a replay instead of applying twice. Applied to
development and production on 2026-10-28. A real admin preview/merge round trip in
development found and fixed one NULL-versus-empty-string mismatch in the match text fields;
the updated migration was re-applied to both projects and re-verified in development
(preview 0/0/0, merge keeps NULL, replay returns `runId 3`).

### SEC-04 — Third-party CDN and font dependency

**Severity:** Medium (resolved in `v3.6.1`)
**Evidence:** Lucide and Supabase JS were originally loaded from unpinned `latest`/`@2` URLs; the fonts came from Google Fonts. All of them are now self-hosted: Supabase JS (`vendor/supabase-js-2.118.0.js`, MIT), Lucide (`vendor/lucide-1.60.0.js`, ISC, byte-for-byte identical to the SRI-pinned CDN build) and variable Inter/Cairo WOFF2 files (`fonts/`, OFL, latin/latin-ext/arabic only). `index.html` adds a CSP whose `script-src`, `style-src` and `font-src` allow only this origin.

**Impact:** A compromised CDN could have served malicious JavaScript, and Google Fonts saw visitor IPs. Both paths are gone.

**Remediation:**

1. ✅ Self-host Supabase JS and Lucide in `vendor/` and serve from the same origin.
2. ✅ Self-host subsetted Inter and Cairo WOFF2 files.
3. ✅ Add a CSP allowlist: `connect-src` permits only this origin and `https://*.supabase.co`.
4. ✅ Do not use `@latest` in production.

**Acceptance criteria:**

- ✅ The production page has no third-party script origins.
- ✅ Fonts are served from the same origin.
- ✅ A CDN outage or compromise cannot break or alter the app.

**Residual work:** `style-src` keeps `'unsafe-inline'` only for team-colour `style` attributes; setting those through the CSSOM would allow dropping it. `script-src` no longer allows inline code as of `v3.6.2`.

### SEC-05 — No audit log, soft delete or restore path

**Severity:** Medium (audit/trash and hash chain deployed)
**Status:** Mitigated in code (`v3.8.0`) and deployed. `supabase/audit-log-migration.sql` adds an append-only `public.audit_log` fed by AFTER triggers on `teams`, `players`, `matches`, `match_events` and `seasons`, plus `list_audit_log(int)` for admins and an "Activity log" panel. `supabase/soft-delete-migration.sql` adds `deleted_at`, hides trashed rows in RLS and installs `delete_season`, `restore_team`, `restore_match`, `restore_season` and `list_deleted()` for a "Recently deleted" panel. Both migrations are applied in development and production; a live delete/restore round trip passed in development, and anonymous production calls to both admin RPCs are rejected with `42501`.

**Evidence (history):** there was no `audit_log` table, no `deleted_at` for teams/matches/seasons, and no restore action for them. Player totals and match events could change with no record of who changed them. The integrity release added `players.is_active`, so players with history can be archived and restored, but that was not a full audit or trash system.

**How the log works:**
- Each row stores `occurred_at`, `actor_id`, `actor_email`, `action` (`INSERT` / `UPDATE` / `DELETE` / `RESTORE` / `IMPORT`), `entity`, `entity_id`, `season_id`, `before` and `after` snapshots.
- Clients have no table grants and RLS is enabled with no policy, so the log is append-only: only the `SECURITY DEFINER` trigger writes and only `list_audit_log()` reads (admin check, max 200 rows).
- A full import sets `app.audit_skip` for the transaction and writes a single `IMPORT` summary, so replacing the dataset does not produce hundreds of rows.
- Soft deletes and restores are `deleted_at` updates relabelled as `DELETE` / `RESTORE`, so the history stays readable even though no row is physically removed.

**Tamper evidence (roadmap D):** clients were never able to edit the log, but a database administrator could still update or delete a row. `supabase/audit-chain-migration.sql` adds `prev_hash` and `row_hash`; a `BEFORE INSERT` trigger computes the SHA-256 of a canonical JSON document holding the previous hash and the row, under an advisory lock, so every insert path is covered. A one-time backfill hashes existing rows and never rewrites a row that already has a hash, so re-running the file cannot repair tampering. `audit_verify_chain(expected_head)` (admin only) walks the chain and reports the first broken id and reason; `audit_chain_head()` is public but returns only the row count, last id/time and head hash. The daily backup stores that head next to the data, so a rewritten log fails the next comparison even if every row is re-hashed. Covered by `npm run test:audit-chain` (trigger, backfill, re-run, edit, middle delete, rewritten tail, anon/viewer denial). The migration was applied in development and production on 2026-10-28. Development verified live with `audit_verify_chain()`: `ok=true`, 61/61 rows, head `d01a01b7…`. Production publishes `count=32`, head `68d2e69b…`; backup run 5 recorded exactly that head inside the encrypted artifact, and decrypting it reproduced the same value before validate and restore drill passed.

**Impact:** Accidental or malicious changes are attributable, and a wrongly deleted team, match or season can be restored from the trash without a backup. The log itself is still not a backup.

**Remediation:**

1. ✅ Add `public.audit_log` with before/after snapshots, actor and timestamp.
2. ✅ Write audit rows from triggers on `teams`, `players`, `matches`, `match_events`, `seasons`, and one summary row per import.
3. ✅ Add `deleted_at` soft delete for teams, matches and seasons; filter deleted rows in RLS so the app never sees them, and expose them through admin RPCs.
4. ✅ Add admin-only restore actions with total recalculation, plus an admin trash panel. (A permanent purge path is still optional.)
5. ✅ Keep archived seasons immutable at the database level.
6. ✅ Hash-chain the audit log and add admin verification plus a public head, with a PGlite suite (roadmap D).
7. ✅ Apply `audit-chain-migration.sql` in development and production (2026-10-28); the daily backup publishes the head.

**Acceptance criteria:**

- ✅ Every admin write produces an audit row (verified in the PGlite suite).
- ✅ A deleted match can be restored with its events and totals (verified in the PGlite suite and by a live dev round trip).
- ✅ Audit rows are admin-readable only and cannot be edited by clients (anon select and RPC both rejected in tests).
- ✅ Run `soft-delete-migration.sql` in development and production; the live development delete/restore round trip passed.
- ✅ An edited row, a deleted middle row and a rewritten tail are detected, and re-running the migration does not repair them (PGlite).
- ✅ The chain migration is applied in both hosted projects; development reports `61/61` verified rows and the production head is recorded in the encrypted backup.

### SEC-06 - Archived seasons were not write-protected in the database

**Severity:** Medium
**Status:** Mitigated and applied in both hosted projects. `supabase/integrity-migration.sql` is live in development and production (`PLAYERS_ARCHIVE_READY` is `true` in both), so archived-season matches are write-protected by the policies and RPCs below.

**Evidence:** The UI blocked edits when a season was archived, but the old `matches_insert_admin`, `matches_update_admin` and `matches_delete_admin` policies only checked `public.is_admin()`. The integrity migration adds `public.is_active_season(text)` and applies it to match insert/update policies, drops direct match delete in favour of `delete_match()`, and makes match events RPC-only. The RPCs reject archived seasons with `Matches can only be saved in the active season` or `Only the active season can be edited`.

**Impact before fix:** The "archive" promise was not enforced. A careless or compromised admin could rewrite history through the API.

**Remediation applied:**

- Added `is_active_season(season_id)` and active-season policies for `matches`.
- Forced match deletion through `delete_match()` so event totals are reversed.
- Forced match-event writes through `replace_match_events()` / `save_match()`.
- Kept "Make active" as the explicit escape hatch.

**Acceptance criteria:**

- Direct REST writes to archived-season matches are rejected. (Verified in PGlite/Postgres tests.)
- Activating the season restores write access. (Verified by the active-season RPC tests.)
- The UI error message is clear. (Existing archived-season alert retained.)

### SEC-07 — Server-side validation is incomplete

**Severity:** Medium
**Status:** Partially mitigated. `replace_all_data` now validates the active-season count, fixture references and event team/player membership atomically; CHECK constraints are still missing.

**Evidence:** Client-side validation covers most forms, but the database has limited checks: scores are plain integers, names have no length limits, colours are text, dates are text, and IDs are client-generated. A crafted admin request can bypass UI validation. Import validation is no longer client-side only: the RPC rejects malformed references and rolls back the whole import.

**Impact:** Corrupt data, broken layouts, negative scores, invalid dates, duplicate IDs or extremely long values. A malicious or buggy client can make standings nonsensical.

**Remediation:**

1. Add `CHECK` constraints:
   - `home_score between 0 and 99`, `away_score between 0 and 99`
   - `round between 1 and 99`
   - `length(name) between 1 and 80`
   - `length(code) between 2 and 5`
   - `color ~ '^#[0-9a-fA-F]{6}$'`
   - `status in (...)`
   - date format checks where possible
2. Move import validation into the `replace_all_data` RPC.
3. Use server-generated UUIDs for new rows.
4. Add a JSON schema version to backups and reject unknown versions.

**Acceptance criteria:**

- Invalid values are rejected by Postgres, not just the UI.
- A malformed import is rejected before any delete.
- IDs are unique and server-generated for new records.

### SEC-08 — GitHub Pages cannot set security headers

**Severity:** Medium
**Evidence:** GitHub Pages does not allow custom response headers. The app has no `Content-Security-Policy`, `X-Content-Type-Options`, `Permissions-Policy` or frame protection. A `Referrer-Policy` meta tag was added this pass.

**Impact:** Reduced defence in depth against XSS, clickjacking and MIME sniffing.

**Remediation:**

1. Move hosting to Cloudflare Pages (free) and add a `_headers` file:

   ```text
   /*
     Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://<project>.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
     X-Content-Type-Options: nosniff
     Referrer-Policy: strict-origin-when-cross-origin
     Permissions-Policy: geolocation=(), camera=(), microphone=()
   ```

2. If GitHub Pages must remain, put Cloudflare in front and inject headers at the edge.
3. Keep the meta `Referrer-Policy` as a fallback.

**Acceptance criteria:**

- Security headers are present on the production response.
- A CSP violation test blocks an injected inline script.
- Clickjacking is blocked by `frame-ancestors 'none'`.

### SEC-09 — CSV formula injection

**Severity:** Medium
**Status:** Mitigated. Both the in-app CSV exports and `tools/backup-to-csv.js` now prefix text cells that begin with `=`, `+`, `-`, `@`, tab, CR or LF with a single quote. Numeric values are left numeric. `tools/csv-to-backup.js` strips the protective prefix on import, so a backup → CSV → JSON round-trip preserves the original value. `tools/backup-to-csv.js` also writes a UTF-8 BOM for Excel.
**Evidence:** `js/app.js` `csvEscape()`, `tools/backup-to-csv.js` `csvCell()`, and `tools/csv-to-backup.js` `unescapeFormula()`. A temporary player named `=1+1` exported as `'=1+1`, and the exported file round-tripped back to `=1+1`.

**Impact:** Opening an exported CSV in Excel/Sheets can execute a formula (for example a command or data exfiltration payload) when an admin or league official opens the file.

**Remediation:**

1. ✅ Prefix dangerous cells with a single quote before export, and document the behaviour.
2. ✅ Strip the safe prefix on CSV import so round-trips remain stable.
3. ✅ Regression-tested with `=`, `+`, `-`, `@`, tab and newline prefixes.
4. ✅ Keep the UTF-8 BOM for Excel compatibility.

**Acceptance criteria:**

- ✅ A player named `=1+1` is exported as text in Excel, not as a formula.
- ✅ CSV round-trip remains stable.
- ✅ A test covers `=`, `+`, `-`, `@`, tab and newline prefixes.

### SEC-10 — Environment override can point local work at production

**Severity:** Low
**Evidence:** `js/config.js` accepts `?env=prod` on localhost and `?env=dev` on the deployed site. This is useful for testing but increases the chance of editing real data by mistake.

**Impact:** Accidental production changes from a local test or a shared link.

**Remediation:**

- Remove `?env=prod` from production builds, or require an explicit confirmation dialog.
- Show a persistent red banner when localhost is connected to production.
- Consider a compile-time environment flag instead of a query parameter.

**Acceptance criteria:**

- Production data cannot be edited from localhost without a clear, deliberate confirmation.
- The environment banner is impossible to miss.

### SEC-11 — No rate limiting or statement timeout for admin RPCs

**Severity:** Low
**Evidence:** Admin RPCs are authenticated but can be called repeatedly. Supabase Auth has rate limits; Postgres RPCs do not have an application-level limit.

**Impact:** Quota exhaustion, accidental loops, or a compromised admin token causing excessive writes.

**Remediation:**

- Add a statement timeout for API roles.
- Add a simple Postgres token bucket or an Edge Function rate limit for imports and destructive RPCs.
- Monitor Supabase logs and set alerts for unusual write volume.

**Acceptance criteria:**

- Repeated import RPCs are throttled.
- A long-running query is cancelled by statement timeout.
- Alerts fire on abnormal write volume.

### SEC-12 — Local backups are unencrypted

**Severity:** Low
**Status:** Mitigated and running for the daily CI backup (roadmap D); local admin exports remain plain text by design.
**Evidence:** `backups/` is gitignored (good), but JSON backups contain the full league and player names in plain text on the local filesystem. The scheduled workflow previously uploaded a plain `backup.json` artifact.

**Impact:** Device loss or shared-folder access exposes league data, and a plain artifact is readable by anyone who can list the repository's Actions artifacts.

**How the encrypted backup works:**
- `tools/backup-crypt.js` encrypts with AES-256-GCM and a scrypt-derived key (`N=32768`, `r=8`, `p=1`). The JSON envelope stores the salt, nonce, tag, plaintext size and checksum; the header is additional authenticated data, so editing any of those fields fails instead of yielding different plaintext.
- The passphrase comes only from `KICKOFF_BACKUP_PASSPHRASE` (environment or repository secret), never from `argv`. The workflow fails closed when the secret is missing.
- The workflow exports and validates the plaintext, runs the in-memory restore drill, records the audit chain head, encrypts to `backup.kob`, decrypts it again and compares byte for byte, deletes the plaintext, and uploads only `backup.kob`.
- `npm run test:backup-crypt` proves the round trip, rejects a wrong passphrase and edited ciphertext/metadata, and checks the CLI fails without the secret.
- Backup run 5 (2026-10-28) uploaded a 10,732-byte `backup.kob`. Downloading it, decrypting with the stored passphrase, validating and restoring it locally reproduced the production chain head and passed the restore drill; the decrypted file's SHA-256 was `34eb386e…`.

**Remediation:**

- ✅ Encrypt the daily CI backup before upload and fail closed without the secret.
- ✅ Test decryption inside the workflow on every run, then delete the plaintext.
- ✅ Test wrong-passphrase and tamper rejection without a database (`npm run test:backup-crypt`).
- ✅ Add the `KICKOFF_BACKUP_PASSPHRASE` repository secret (2026-10-28); the repository contains no copy of the passphrase.
- ⬜ Copy the artifacts somewhere the Supabase/GitHub administrator cannot rewrite (private repository, release asset or encrypted object store) and define retention. GitHub artifacts are off Supabase but remain deletable by a repository admin.
- ⬜ Schedule the quarterly restore from that off-site copy; keep `.gitignore` rules for local backups.

**Acceptance criteria:**

- ✅ Uploaded backups are authenticated ciphertext, and the plaintext is removed from the runner.
- ✅ A restore from the encrypted artifact is exercised on every run, and a manual download → decrypt → validate → restore drill passed on 2026-10-28.
- ⬜ Quarterly restore drill from the off-site copy is on the maintainer's calendar.

### SEC-13 - Destructive deletes could leave aggregate totals inconsistent

**Severity:** Medium
**Status:** Mitigated and applied in both hosted projects. `supabase/integrity-migration.sql` is live in development and production, so every destructive path runs through the total-adjusting RPCs below and a player with history is archived instead of hard-deleted.

**Evidence:** Before this pass, deleting a team cascaded its matches and `match_events`, but opponent players' cumulative goals/cards stayed counted. Deleting a player removed their historical events. A match and its events were saved with separate client requests, so a rejected event could leave a half-saved match. Direct REST deletes could bypass the total-adjusting RPCs.

**Impact:** Standings and player statistics could silently drift from the event history.

**Remediation applied:**

- `delete_team(p_team_id)` locks writes, reverses event contributions to opponents, deletes the team's events, then deletes the team.
- `delete_match(p_match_id)` reverses the match's counted events before deletion.
- `save_match(p_match, p_events)` upserts the fixture and replaces events in one transaction; any invalid event rolls back the whole save.
- `players.is_active` lets the app archive players who have events instead of hard-deleting them; the delete policy blocks hard deletion while events exist.
- Direct `DELETE` on `teams` and `matches`, and all direct writes on `match_events`, are denied. These operations go through the admin-only RPCs (security-definer functions and full import bypass RLS internally).
- All four write paths share advisory lock `748291`.

**Acceptance criteria:**

- A rejected event leaves no new match. (Verified in PGlite/Postgres tests.)
- Deleting a team reverses opponent totals. (Verified.)
- A player with events cannot be hard-deleted. (Verified.)
- Archived seasons reject match/event writes. (Verified.)

## 5. Controls currently working well

- RLS is enabled on every league table.
- Public read policies are explicit; writes require `public.is_admin()`.
- `is_admin()` is `security definer` with `set search_path = public`, avoiding recursive profile RLS.
- Admin RPCs check the role inside the function, not only in the UI.
- Match-event RPCs revoke `PUBLIC`/`anon` execute.
- Team/match deletion and match-event writes are RPC-only; direct destructive policies are dropped and write/delete grants are revoked from `authenticated`.
- `save_match` and `replace_all_data` use shared advisory lock `748291`.
- `create_fixtures` and `shift_fixture_rounds` are admin-only, take the same advisory lock, re-validate every row (division derived from the home club, real calendar dates, one home leg per pairing), and refuse `replace_existing` when a fixture has a result, an event or a live status.
- `players` hard deletion is blocked while events reference the player.
- `profiles` has no client update policy; role promotion requires SQL.
- Signups are disabled server-side.
- Only publishable keys are in the repository; the secret scanner checks for leaked privileged keys.
- Lucide is pinned with SRI; the Supabase client is vendored at a pinned version in `vendor/` and served from the same origin.
- The app uses parameterised Supabase client calls, not string-concatenated SQL.
- `esc()` covers the rendering paths, and no markup interpolates into JavaScript source: actions and identifiers live in `data-*` attributes read by one delegated dispatcher.
- Backups and working CSV data are gitignored.
- `npm audit --omit=dev` reports 0 vulnerabilities.

## 6. Prioritised remediation plan

### P0 — next 7 days

| Task | Acceptance |
|---|---|
| ✅ Apply `match-events-migration.sql` in development, then production | Migration applied; admin RPC smoke test passed |
| ✅ Re-apply patched `atomic-import-migration.sql` in development and production | Both passed no-op/hash/anon/rollback checks |
| ✅ Apply `integrity-migration.sql` in development, then production | Archived-season writes rejected; archive/restore, atomic save and safe team delete pass live |
| Re-run anonymous/viewer/admin RLS matrix | Anon and viewer writes return `42501`; admin writes succeed |
| ✅ Add MFA for admins and enforce `aal2` for writes | SQL gate and UI implemented; PGlite proves password-only admin cannot write; applied in both hosted projects and verified live (password-only writes rejected until TOTP step-up) |
| ✅ Replace `dbReplaceAll` with an atomic import RPC | RPC installed and live-tested in production; no-op import and rollback passed |
| ✅ Remove inline handlers and add a strict CSP | 0 inline `on*` attributes; `<script>` injection blocked by `script-src 'self'`; all delegated actions tested live on development |
| ✅ Add CSV formula-injection protection | Dangerous cells export as text; round-trip stable |
| ✅ Add audit log | Triggers record actor + snapshots; admin-only RPC and panel; anon denied |
| ✅ Add soft delete and restore for teams, matches and seasons | Applied in both projects; a deleted record can be restored with totals intact |

### P1 — 1 to 4 weeks

- Add database `CHECK` constraints and extend server-side JSON validation.
- ✅ Enforce archived-season immutability in the database (applied in both hosted projects).
- ✅ Make match saves, team deletes and event writes atomic/RPC-only (applied in both hosted projects).
- Move hosting to Cloudflare Pages for security headers, or add an edge proxy.
- Self-host Supabase JS, Lucide and fonts.
- ✅ Add an in-memory SQL/RLS regression suite (PGlite) and run it in CI; add a credential-free Playwright public smoke test. Admin E2E remains manual.
- ✅ Add self-service password recovery (with global sign-out), an app-level 30-minute idle logout (`v3.10.0`) and an admin **Sign out all devices** action (`v3.10.1`). Server-enforced session lifetime is still open.
- Add rate limits/statement timeouts and Supabase log alerts.
- ✅ Encrypt the daily CI backup and test decryption on every run (roadmap D). Still to do: keep a copy outside GitHub/Supabase and schedule the quarterly drill.

### P2 — 1 to 3 months

- Add `updated_at`/version optimistic concurrency to prevent lost updates.
- Add idempotency keys for imports and destructive actions.
- Add a security regression suite: XSS payloads, CSV formulas, RLS matrix, CSP checks.
- Add a private vulnerability disclosure workflow and a release security checklist.
- Add dependency review and pinned GitHub Actions by SHA.
- Add a staging project for release candidates; never test destructive migrations on production first.

## 7. Verification checklist

Run these before every production release:

```powershell
# 1. No privileged secrets in source
npm.cmd run check:secrets

# 2. Dependency audit
npm.cmd audit --omit=dev

# 3. JavaScript syntax
Get-ChildItem js/*.js, tools/*.js | ForEach-Object { node --check $_.FullName }

# 4. SQL integrity/RLS suite (in-memory Postgres, no Docker)
npm.cmd run test:sql

# 4a. Tamper-evident audit chain and encryption (roadmap D)
npm.cmd run test:audit-chain
npm.cmd run test:backup-crypt
npm.cmd run test:export-chain-head

# 5. CSV round trip
node tools/csv-to-backup.js data/examples "$env:TEMP\kickoff-first.json"
node tools/backup-to-csv.js "$env:TEMP\kickoff-first.json" "$env:TEMP\kickoff-csv"
node tools/csv-to-backup.js "$env:TEMP\kickoff-csv" "$env:TEMP\kickoff-second.json"
```

### Anonymous write test

Use the publishable key and an anonymous request. The expected result is `401`/`403`, never a successful insert:

```powershell
$headers = @{
  apikey = '<publishable-key>'
  Authorization = 'Bearer <publishable-key>'
  Prefer = 'return=minimal'
}
Invoke-RestMethod -Method Post `
  -Uri 'https://<project>.supabase.co/rest/v1/teams' `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body '{"id":"sec-test","name":"Should fail","code":"SEC","color":"#000000"}'
```

### Database RLS matrix

Run in a transaction against a test project:

```sql
begin;
set local role anon;
select count(*) from public.teams; -- allowed
insert into public.teams (id, name, code, color)
values ('sec-test', 'Should fail', 'SEC', '#000000'); -- must fail
rollback;
```

Repeat for an authenticated viewer and an admin. For authenticated tests, use a real test account or a Supabase test harness that sets the JWT claims correctly.

### Admin RPC smoke test

1. Sign in as an admin in development.
2. Add a goal and a yellow card to a test match.
3. Confirm the fixture timeline and `players.goals` / `players.yellow`.
4. Edit the minute and type; confirm totals change by delta.
5. Remove the events; confirm totals return to the original values.
6. Delete the match; confirm events and totals are cleaned up.

## 8. Incident response

If an admin account is suspected compromised:

1. Demote the account in `profiles` and sign out all sessions.
2. Rotate the password and require MFA re-enrollment.
3. Inspect Supabase Auth and Postgres logs; export a backup immediately.
4. Compare current data with the last known-good backup.
5. Restore from backup if integrity is in doubt.
6. If a publishable key is being abused, rotate it in Supabase and update `js/config.js`; never rotate to a service-role key in the frontend.
7. If a CDN is compromised, remove the CDN script and rely on self-hosted assets.

## 9. Out of scope and accepted risks

- The publishable Supabase key is public by design. It is not a secret.
- Public league data is intentionally readable by anyone.
- GitHub Pages availability, Supabase free-tier limits and DDoS protection are provider responsibilities.
- Sample/demo data is not sensitive.
- The app does not process payments or store government IDs.

## 10. Review cadence

- Re-run this review before each production release and after any schema/RPC change.
- Review Dependabot PRs weekly.
- Re-test RLS whenever a table, policy or `security definer` function changes.
- Review Supabase Auth settings quarterly.
- Keep this document and the [modernization plan](MODERNIZATION_PLAN.md) in sync.
