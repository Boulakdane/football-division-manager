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

1. **Admin account/session compromise.** An admin can legitimately replace or delete the entire dataset. There is no MFA, step-up authentication, session policy or audit trail.
2. **XSS and supply-chain exposure.** The app still renders with `innerHTML` template strings, so a missed `esc()` would inject markup. `v3.6.1` self-hosted every asset and `v3.6.2` removed all inline handlers, so `script-src` is now exactly `'self'` and injected script is blocked. A same-origin compromise could still read the Supabase session from browser storage.
3. **Destructive imports still lack a preview and audit trail.** Atomic rollback is now live-tested in production, but an admin can still replace all data without a dry-run diff or audit record. See SEC-05 for the audit/restore work.

The current pass already reduced some risk: every runtime asset is now self-hosted (Lucide, the Supabase client and the Inter/Cairo webfonts live in `vendor/` and `fonts/`), a Content-Security-Policy in `index.html` pins scripts, styles, fonts and connections to this origin plus Supabase, `v3.6.2` replaced every inline handler with delegated `data-*` actions so `script-src` no longer allows `'unsafe-inline'`, a secret scanner runs in CI, Dependabot is configured, imports are atomic, and the working tree adds database-enforced archive reads, player archiving, safe team deletion and atomic match saves. The integrity SQL has been applied to the hosted development and production projects and verified live. The plan below closes the remaining gaps.

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
| SEC-01 | High | No MFA/step-up authentication for a role that can erase the league | Open |
| SEC-02 | High | No strict CSP; inline handlers and `innerHTML` keep XSS impact high | Mitigated: all inline handlers replaced by delegated `data-*` actions, CSP ships `script-src 'self'`; residual `style-src 'unsafe-inline'` and template-string escaping discipline |
| SEC-03 | High | Atomic full-data import RPC installed and live-tested; no-op and rollback verified | Mitigated |
| SEC-04 | Medium | Third-party CDN and font dependency | Mitigated: Lucide, Supabase JS and the Inter/Cairo fonts are vendored; CSP leaves no external script/style/font origin |
| SEC-05 | Medium | No audit log, soft delete or restore path | Partially mitigated: player archive/restore; no audit or team/match trash |
| SEC-06 | Medium | Archived seasons are read-only only in the UI | Mitigated in code; integrity migration pending |
| SEC-07 | Medium | Server-side data validation is incomplete | Partially mitigated: import references validated in RPC; CHECK constraints still open |
| SEC-08 | Medium | Security headers cannot be set on GitHub Pages | Open |
| SEC-09 | Medium | CSV formula injection in exported files | Mitigated |
| SEC-10 | Low | Environment override (`?env=prod`) can point local work at production | Open |
| SEC-11 | Low | No rate limiting or statement timeout for admin RPCs | Open |
| SEC-12 | Low | Local backups are unencrypted | Open |
| SEC-13 | Medium | Destructive deletes could leave aggregate totals inconsistent | Mitigated in code; integrity migration pending |

### SEC-01 — Admin account takeover has no second factor

**Severity:** High
**Evidence:** `js/auth.js` uses email + password only. Password minimum is 6 characters. There is no MFA prompt, no `aal2` check in `is_admin()`, no session timeout, no “sign out all devices”, and no notification on admin login. The admin role can call `replace_match_events`, `delete_match`, `activate_season` and full-data replacement.

**Impact:** A phished or reused admin password gives an attacker full control of the league. They can delete seasons, rewrite results, corrupt player totals or replace the entire dataset.

**Remediation:**

1. Enable Supabase Auth MFA (TOTP) and require enrollment for admins.
2. Enforce assurance level in the database, not just the UI:

   ```sql
   -- Example policy helper: require aal2 for admin writes.
   create or replace function public.is_admin()
   returns boolean
   language sql
   stable
   security definer
   set search_path = public
   as $$
     select exists (
       select 1
       from public.profiles
       where id = auth.uid()
         and role = 'admin'
     )
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
   $$;
   ```

   Test this carefully: existing sessions without MFA would lose write access until they enroll.
3. Require a fresh password or MFA challenge before destructive actions (“step-up auth”).
4. Raise the password minimum to 12 characters and enable Supabase leaked-password protection.
5. Add a “sign out all sessions” action and a short admin session lifetime.
6. Add login notifications or an admin activity digest.

**Acceptance criteria:**

- A password-only admin session cannot execute write RPCs.
- An `aal2` admin can write.
- A viewer or anonymous caller receives `42501` for every write RPC.
- The UI explains how to enroll MFA.

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
**Status:** Installed and live-tested in development and production. The first production attempt was safely rejected by Supabase `pg-safeupdate`; the patched function now uses qualified deletes. No-op admin imports completed through `replace_all_data` with no client fallback and identical pre/post data hashes in both projects, and invalid event imports rolled back without inserting their test rows.
**Evidence:** before this change, `js/backend.js` `dbReplaceAll()` deleted `match_events`, `matches`, `players`, `teams` and `seasons` in separate requests, then inserted each table in separate requests. RLS protects who can do it, but not what happens if a request fails halfway. The new `public.replace_all_data(jsonb)` performs the delete and insert in one database transaction and the frontend prefers it automatically.

**Impact:** A network error, constraint violation or malformed import can leave the league partially deleted or with orphaned/incomplete data only if the RPC is unavailable and the frontend falls back. The admin may not have a fresh backup. This is the most likely way to lose real data.

**Remediation:**

1. ✅ Implement one admin-only `replace_all_data(payload jsonb)` RPC in
   [`supabase/atomic-import-migration.sql`](../supabase/atomic-import-migration.sql) and
   [`supabase/schema.sql`](../supabase/schema.sql).
2. ✅ Add `pg_advisory_xact_lock` so two admins cannot import concurrently.
3. ✅ Validate payload shape, exactly one active season, and event-to-fixture/team/player
   relationships server-side. Broader value-range `CHECK` constraints remain SEC-07.
4. ❌ Add a dry-run mode that returns counts and a diff summary before commit.
5. ❌ Store an import checksum/idempotency key and a “last import” record.
6. ❌ Require a fresh JSON backup download before the replacement, and keep the previous
   snapshot for rollback.
7. ❌ Show a clear confirmation with counts of rows to be deleted.

**Acceptance criteria:**

- ✅ An intentionally invalid import leaves every table byte-for-byte unchanged
  (verified locally, in development and in production; the test rows were absent).
- ✅ A successful import is atomic and completes in one transaction.
- ✅ No-op imports in development and production preserved the pre/post SHA-256
  hashes and used only `replace_all_data`, with no client fallback.
- ✅ Concurrent imports are serialized by the advisory lock.
- ❌ The admin sees a dry-run summary before commit.

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

**Severity:** Medium
**Evidence:** There is no `audit_log` table, no `deleted_at` for teams/matches/seasons, and no restore action for them. Player totals and match events can change with no record of who changed them. The integrity release adds `players.is_active`, so players with history can be archived and restored, but this is not a full audit or trash system.

**Impact:** Accidental or malicious changes are difficult to investigate and may be unrecoverable without a manual backup.

**Remediation:**

1. Add `public.audit_log` (`id`, `actor_id`, `action`, `entity`, `entity_id`, `before`, `after`, `created_at`, client metadata).
2. Write audit rows from triggers on `teams`, `players`, `matches`, `match_events`, `seasons`, and from import RPCs.
3. Add `deleted_at` soft delete for teams, matches and seasons; filter deleted rows in views. Keep `players.is_active` for squad archiving.
4. Add an admin-only restore action and a purge job.
5. Keep archived seasons immutable at the database level.

**Acceptance criteria:**

- Every admin write produces an audit row.
- A deleted match can be restored with its events and totals.
- Audit rows are admin-readable only and cannot be edited by clients.

### SEC-06 - Archived seasons were not write-protected in the database

**Severity:** Medium
**Status:** Mitigated in code by `supabase/integrity-migration.sql`; hosted projects need the migration.

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
**Evidence:** `backups/` is gitignored (good), but JSON backups contain the full league and player names in plain text on the local filesystem.

**Impact:** Device loss or shared-folder access exposes league data.

**Remediation:**

- Store backups in an encrypted archive (7-Zip/Age) or an encrypted cloud folder.
- Define a retention policy and a restore drill.
- Do not commit backups; keep the existing `.gitignore` rule.

**Acceptance criteria:**

- Backups at rest are encrypted.
- A restore from the archive is tested quarterly.

### SEC-13 - Destructive deletes could leave aggregate totals inconsistent

**Severity:** Medium
**Status:** Mitigated in code by `supabase/integrity-migration.sql`; hosted projects need the migration.

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
| Add MFA for admins and enforce `aal2` for writes | Password-only admin cannot write |
| ✅ Replace `dbReplaceAll` with an atomic import RPC | RPC installed and live-tested in production; no-op import and rollback passed |
| ✅ Remove inline handlers and add a strict CSP | 0 inline `on*` attributes; `<script>` injection blocked by `script-src 'self'`; all delegated actions tested live on development |
| ✅ Add CSV formula-injection protection | Dangerous cells export as text; round-trip stable |
| Add audit log and soft delete | Every write is attributable and restorable |

### P1 — 1 to 4 weeks

- Add database `CHECK` constraints and extend server-side JSON validation.
- ✅ Enforce archived-season immutability in the database (pending hosted migration).
- ✅ Make match saves, team deletes and event writes atomic/RPC-only (pending hosted migration).
- Move hosting to Cloudflare Pages for security headers, or add an edge proxy.
- Self-host Supabase JS, Lucide and fonts.
- ✅ Add an in-memory SQL/RLS regression suite (PGlite) and run it in CI; Playwright is still pending.
- Add rate limits/statement timeouts and Supabase log alerts.
- Encrypt backups and document a restore drill.

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
