# Project documentation

| Document | Purpose |
|---|---|
| [PROGRESS.md](PROGRESS.md) | Current release status, completed work, blockers and release checklist |
| [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | Threat model, findings, remediation plan and verification steps |
| [MODERNIZATION_PLAN.md](MODERNIZATION_PLAN.md) | Phased roadmap and sophisticated technical/product changes |

## Suggested reading order

1. **PROGRESS.md** — where the project is today and what must happen before the next deploy.
2. **SECURITY_AUDIT.md** — what can go wrong and the P0/P1/P2 fixes.
3. **MODERNIZATION_PLAN.md** — where the product goes over the next 6 months.

## Documentation rules

- Update `PROGRESS.md` when a milestone ships or a blocker changes.
- Re-run the security review before every production release and after any RLS/RPC change.
- Keep the modernization plan honest: move items between phases instead of pretending they are done.
- Link to exact files and commands so a new maintainer can reproduce the work.
