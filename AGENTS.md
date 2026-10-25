# AGENTS.md — rules for every AI coding tool in this repository

This file is the **single source of truth** for AI coding agents (Claude Code, opencode and
any other). `CLAUDE.md` imports it, and opencode reads `AGENTS.md` directly, so both tools
see the same rules. Edit rules here, never in a tool-specific file.

**Before you change anything, read [docs/COORDINATION.md](docs/COORDINATION.md)** — it says
how Claude and opencode avoid stepping on each other (branches, claims, hot files, handoff).

## What this project is

KickOff Division: a zero-server football league manager. Static HTML/CSS/vanilla JS on
GitHub Pages, data and auth in a free Supabase project (Postgres + RLS). Public read,
admin-only write. English, French and Arabic (RTL). See `README.md` and `docs/`.

## Hard rules (a violation is a bug, whichever tool made it)

1. **Never commit secrets.** Only the publishable `sb_publishable_…` keys in `js/config.js`
   belong in the repo. Never a service-role/secret key, JWT secret or database URL with a
   password. `npm run check:secrets` must pass.
2. **Never touch production.** Do not run SQL, imports, deletes or admin actions against
   the production Supabase project. Migrations are written and tested locally (PGlite);
   the maintainer applies them: development first, then production.
3. **No inline handlers, no new third-party origins.** The CSP is `script-src 'self'`.
   Use `data-action` / `data-change` / `data-input` / `data-submit` and the delegated
   dispatchers in `js/app.js`. Vendor libraries into `vendor/`; do not add CDNs.
4. **Escape every interpolated value** in template strings with `esc()`. Numbers go through
   `toInt()`. Prefer `textContent` over `innerHTML` in new code.
5. **The database is the security boundary.** Every new write path is an admin-checked RPC
   (`public.is_admin()`, `security definer`, `set search_path = public`, `revoke … from
   public, anon`) or an RLS policy. Never rely on hidden buttons.
6. **Migrations are additive and re-runnable.** One new file `supabase/<topic>-migration.sql`
   plus the same change in `supabase/schema.sql`; extend `tools/test-sql-integrity.js`.
7. **Do not weaken a check to make it pass** (tests, CSP, RLS, secret scan, constraints).
   If a check looks wrong, say so in the PR instead.
8. **No force-push, no rewriting shared history, no pushing to `main`.** Work on your own
   branch and open a pull request. The maintainer merges.

## Code conventions

- Vanilla JS, classic scripts loaded in this order: `i18n → store → config → backend →
  auth → app`. Keep the order if you add a script. No build step for JS.
- `css/tailwind.css` is **generated and committed**: after changing classes in
  `index.html` or `js/`, run `npm run build:css` and commit the result (CI checks it).
- Every user-facing string goes in `js/i18n.js` in **all three** languages (EN/FR/AR).
  Use logical CSS properties (`ms-`, `me-`, `text-start`) so RTL keeps working.
- Dates and numbers: use `Intl`; never concatenate translated fragments.
- Keep functions small and pure where possible; domain logic must not touch the DOM.
- Match the style of the surrounding file (2-space indent, single quotes, semicolons).

## Commands

| Task | Command |
|---|---|
| Serve locally (dev project) | `npm run serve` → http://localhost:8765 |
| Secret scan | `npm run check:secrets` |
| JS syntax | `for f in js/*.js tools/*.js; do node --check "$f"; done` |
| SQL / RLS tests (PGlite) | `npm run test:sql` |
| Browser smoke test | `npm run test:e2e` |
| Rebuild CSS | `npm run build:css` |
| Backup validation / restore drill | `npm run check:backup -- file.json` / `npm run drill:backup -- file.json` |
| See what other agents are doing | `npm run agents:status` |

## Definition of done for a pull request

- [ ] Secret scan, syntax check, SQL tests and (for UI changes) e2e tests pass locally.
- [ ] `css/tailwind.css` rebuilt if any class changed.
- [ ] New strings exist in EN, FR and AR.
- [ ] Docs updated **only** where the PR template says (see `docs/COORDINATION.md`).
- [ ] The PR description has a **Handoff** section so the other tool can continue.
- [ ] Commit messages end with a `Co-Authored-By:` line naming the tool and model.

## Where to look

| Need | File |
|---|---|
| Roadmap and open proposals | `docs/MODERNIZATION_PLAN.md` (section 22 = current proposals) |
| Who is doing what | `docs/TASKS.md` and `npm run agents:status` |
| Security findings and threat model | `docs/SECURITY_AUDIT.md` |
| Release state and evidence | `docs/PROGRESS.md` |
