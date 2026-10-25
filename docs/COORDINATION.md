# Coordination: Claude, opencode and the maintainer

Two AI tools (Claude Code and opencode) plus one human work in this repository. They share
no memory, so **git and these files are the only channel between them**. The protocol below
keeps their work from colliding and makes every handoff cheap.

## 1. Principles

1. **One owner per task.** A task is claimed by exactly one tool until it is merged or released.
2. **Isolate by branch.** Each tool works only on its own branches and never on `main`.
3. **Small, finished pull requests.** One task, one PR, reviewable in one sitting.
4. **Serialize the hot files** (section 4). Parallel edits there are the main source of conflicts.
5. **Leave a handoff.** Whoever stops first writes down state, so the other can continue cold.
6. **The maintainer decides.** Priorities, merges and anything touching production are theirs.

## 2. Branches and claims

| Item | Rule |
|---|---|
| Branch name | `claude/<id>-<slug>` or `opencode/<id>-<slug>`, for example `claude/C-drift-monitor`. Human branches use `maintainer/…`. |
| Task ID | The ID from `docs/TASKS.md` (A–J for the plan proposals, `X1…` for ad-hoc work). |
| Base | Always branch from the latest `origin/main`, never from another tool's branch. If you truly depend on unmerged work, say so in the PR and wait for it to merge. |
| Claim | **Push the branch and open a draft PR in your first hour.** The branch prefix shows the owner; the draft PR is the lock. |
| Check before starting | `npm run agents:status` (or `git ls-remote --heads origin 'claude/*' 'opencode/*'` and `gh pr list`). If someone has the task, pick another. |
| Release | If you stop, comment on the draft PR "releasing" and update `docs/TASKS.md` status to Open in your PR. Never leave a stale claim. |
| Stale claim | A claim with no commit for 7 days may be taken over after a comment on its PR. |
| Updating | Rebase **your own** branch on `origin/main`; never rebase, force-push or reset someone else's branch. |

## 3. Lanes (default split to reduce overlap)

| Lane | Paths | Typical tasks |
|---|---|---|
| **1. Database and security** | `supabase/`, `tools/`, `.github/workflows/`, `tests/` for SQL, `docs/SECURITY_AUDIT.md` | C, A (DB half), B, D, H |
| **2. Frontend** | `js/`, `css/`, `index.html`, `js/i18n.js`, `tests/e2e/`, `vendor/` | E, F, G, I, UI halves of A/B/H |
| **3. Docs and process** | `docs/`, `README.md`, `AGENTS.md` | J and housekeeping |

The maintainer assigns lane owners in `docs/TASKS.md`. A tool working outside its lane must say so
in the PR. **Cross-lane tasks are split in two PRs**: the database PR merges first (and is applied
to development), then the frontend PR builds on it. Never put a schema change and the UI that
depends on it in the same unreviewed jump.

## 4. Hot files: one open PR at a time

These files change often or are generated, so two open PRs touching one of them will conflict.
Before editing one, run `npm run agents:status`; if another open branch already touches it, wait
or coordinate on that PR.

| File | Why it is hot | Rule |
|---|---|---|
| `js/app.js` | ~2,500 lines of shared globals | One open PR at a time |
| `js/i18n.js` | Every UI change adds keys | Add keys in a block at the end of each language object; one open PR at a time |
| `supabase/schema.sql` | Source of truth for fresh installs | One open PR at a time; migration files are separate, so those are fine |
| `css/tailwind.css` | Generated | Never hand-edit; rebuild with `npm run build:css` after merging `main`; on conflict, rebuild instead of merging text |
| `package-lock.json` | Generated | Change only when dependencies change; on conflict, regenerate |
| `docs/PROGRESS.md` | Release journal | **Feature PRs do not edit it.** Put evidence in the PR description; the maintainer (or one chosen tool) rolls it up after merge |
| `docs/TASKS.md` | Task board | Edit only your own row |
| `docs/MODERNIZATION_PLAN.md` | Roadmap | Only add a decision-log row or tick a box; no reformatting |

## 5. What each tool does before and after work

Before starting:
1. `git fetch origin --prune` and branch from `origin/main`.
2. Read `AGENTS.md`, this file, `docs/TASKS.md`, and the task's section in `docs/MODERNIZATION_PLAN.md`.
3. `npm run agents:status` → confirm nobody else owns the task or the hot files you need.
4. Push the branch and open a **draft** PR titled `[claude] C: security drift monitor`
   (or `[opencode] …`). Put the task ID first.

Before asking for review:
1. Merge or rebase onto the latest `origin/main`, resolve conflicts yourself.
2. Run the checks in the Definition of Done (see `AGENTS.md`).
3. Fill in the PR template, including **Handoff**. Mark the PR ready.

## 6. Handoff note (required in every PR)

Write it for a reader with no memory of your session:

- **State:** done / partly done / not started, in one line each.
- **How to verify:** the exact commands and the expected result.
- **Decisions and why:** anything non-obvious, and alternatives you rejected.
- **Known gaps:** what you did not test (for example "no network, so the live Supabase calls were not exercised").
- **Next step:** the single most useful thing to do next, and which files it touches.

## 7. Commits

- One logical change per commit, imperative subject, body explains why.
- End every commit with a `Co-Authored-By:` line naming the tool and model that wrote it, so
  `git log` shows who did what. Claude's line is
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>`; opencode's should name opencode and its
  model in the same format.
- Never commit generated or local files (`node_modules/`, `playwright-report/`, `backups/`, `data/*.csv`).

## 8. Conflicts and disagreements

| Situation | What to do |
|---|---|
| Two PRs edit the same hot file | The later one waits, or rebases after the earlier merges. Say so on the PR. |
| Two tools disagree on a design | Write both options in the PR description. Do not push competing implementations; the maintainer picks. |
| A tool finds a bug in the other's open PR | Comment on that PR. Do not push to its branch. |
| A check fails and you think the check is wrong | Do not edit or skip it. Explain in the PR and ask the maintainer. |
| You are unsure whether something touches production | Assume it does and stop; ask the maintainer. |

## 9. Maintainer checklist (about two minutes per PR)

1. Does the PR touch only its task, and is the diff small enough to read?
2. Do CI checks pass (`Validate`, `E2E smoke`)?
3. Read the Handoff and the "not tested" list. Do any SQL files need applying? Apply them to
   development first, then production, then tick the box in the PR.
4. Merge, then have the next task claimed. Delete the merged branch.

## 10. Tool-specific setup

| Tool | How it picks up the rules |
|---|---|
| Claude Code | Reads `CLAUDE.md`, which imports `AGENTS.md`. |
| opencode | Reads `AGENTS.md` from the repository root. Start it from the repo root so it finds the file. |
| Any other agent | Point it at `AGENTS.md` and this file in its first prompt. |

Suggested first prompt for either tool:

> Read `AGENTS.md` and `docs/COORDINATION.md`. Run `npm run agents:status`. Take the next Open task in
> `docs/TASKS.md` that is in your lane and not claimed, create your branch from `origin/main`, open a
> draft PR, and follow the Definition of Done. Do not touch production or `main`.
