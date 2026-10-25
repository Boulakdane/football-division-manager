## Task

<!-- ID from docs/TASKS.md and a one-line summary, e.g. "C: security drift monitor" -->

## Tool

<!-- claude / opencode / maintainer, and the model if known -->

## What changed

<!-- Short list. Mention every hot file you touched (js/app.js, js/i18n.js, supabase/schema.sql, css/tailwind.css, package-lock.json). -->

## How I checked it

- [ ] `npm run check:secrets`
- [ ] `node --check` on every `js/*.js` and `tools/*.js`
- [ ] `npm run test:sql`
- [ ] `npm run test:e2e` (UI changes)
- [ ] `npm run build:css` and committed the result (class changes)
- [ ] New strings added in EN, FR and AR

## Needs the maintainer

<!-- SQL files to apply (development first, then production), Supabase dashboard settings, secrets, or "nothing". -->

## Handoff

- **State:**
- **How to verify:**
- **Decisions and why:**
- **Known gaps / not tested:**
- **Next step:**
