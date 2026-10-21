# Security policy

## Supported versions

Security fixes are applied to the `main` branch and the current production
deployment. There are no long-term support branches.

## Reporting a vulnerability

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

## Response targets

These are best-effort targets for a volunteer-maintained project:

| Stage | Target |
|---|---|
| Acknowledgement | 72 hours |
| Initial triage | 7 days |
| Fix or mitigation for critical/high issues | 30 days |
| Public disclosure | After a fix is deployed, coordinated with the reporter |

## Scope

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

## Safe testing rules

- Prefer the development environment (`?env=dev` or localhost).
- Do not delete, modify or exfiltrate real league data.
- Do not access another person's account or personal data.
- Stop testing and report immediately if you reach real admin credentials or data.
- Give the maintainer reasonable time to fix the issue before disclosure.

## Current security model

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
