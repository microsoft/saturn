# How Saturn works

## The review loop

The always-on service (`saturnService`) runs a simple loop:

1. **Scan** — list the newest ~100 active, non-draft PRs and review up to **10** per cycle.
2. **Backfill** — if the scan reviewed nothing (the top-100 are all caught up), review **one** older active PR created in the last **14 days**, then immediately re-scan the newest PRs so fresh work always preempts the backlog.
3. **Idle** — wait 5 minutes, then repeat.

Reviews run sequentially. The 10-per-cycle cap throttles cost/latency, not throughput: skips and error-retries don't count against it, so a backlog drains ~10 new reviews per cycle until it's clear, then the loop idles.

## PR + iteration is the idempotency key

Every reviewed iteration is recorded in the store. Saturn **skips** a PR only when its _current_ iteration was already reviewed without error. So:

- No new commits → skipped forever (no repeat comments).
- A **new iteration** (new push) → re-reviewed (catches newly introduced issues).
- A prior **error** → retried on the next scan.

## The two-pass review

For each reviewed PR, Saturn fetches the changed files (via ADO REST) and runs the GitHub Copilot CLI with a structured prompt covering correctness, design, API, security, privacy, and **test coverage of the change delta**. A second **verification pass** re-checks every proposed comment against the real code and drops anything unverified — Saturn fails closed, preferring zero comments to a wrong one.

## Comment behavior (low noise)

- **Clean PR → no comment.** Saturn does not post an "all clear"; the no-findings result is recorded (so the iteration isn't re-reviewed) and shown on the dashboard only.
- **Severity drives thread status.** `blocking`/`major` post as **Active** (the author must act). `nit`/`minor` post as **Resolved** so they're visible but don't add to the PR's open-thread count, and they're not re-surfaced as Active on later iterations.
- **No duplicates.** On a new iteration, a finding that still applies **reactivates and replies on the existing thread** (noting whether the author's attempted fix didn't resolve it, vs. still unaddressed) instead of opening a new one. If a human already raised the same point, Saturn stays silent.
- **Self-describing.** Each comment leads with the severity + title, carries an attribution/disclaimer, and ends with a **Share feedback** link.

## The fix loop (standalone Code Autopilot)

A third, **standalone** agent (`saturn-autopilot`) turns assigned audit bugs into pull requests. It runs in its own process against its **own dedicated clone** (`C:\saturn\fix-repo\<repo>`), so the heavy editing it does never interferes with the always-on review + audit agents - and it runs with or without them.

Every iteration (default every **10 minutes**, or **immediately** when an Azure DevOps service hook fires — see *Reacting immediately* below) it:

1. **Monitors its open PRs like a developer.** Merged → the local branch is cleaned up and the task marked merged; abandoned → cleaned up. For an active PR it reads the **branch-policy evaluations + CI statuses** and reacts the way a developer would: a **failed build** → it pulls the build's **actual error logs** (timeline error issues + per-task log tails, with a `targetUrl` build-id fallback) and feeds them to the model to fix the **root cause**; an **expired** check (the PR "Re-queue" button) → it **re-queues** it via the policy API with **no code change** (and if a check can only be re-run from an external system, it **surfaces** that on the bug for a human); a check still **running** → it **waits** instead of re-pushing; **unresolved review comments** or a **merge conflict** → it regenerates the fix and pushes an update — all with the **Azure DevOps MCP tools** enabled so it can dig into logs/threads itself. After too many feedback rounds (`SATURN_FIX_MAX_ITERATIONS`, default 5) it stops and leaves the PR for a human.
2. **Starts one new fix** (while under the open-task cap, default **1**): it picks an open finding of the target category (default **accessibility**) that has a filed bug, fits the phase cap, is **within the configured scope** (a dashboard **Scope** setting / `SATURN_FIX_SCOPE_PATHS` of package or repo-path prefixes — empty = no limit; the fix may still touch files outside it), and either hasn't been attempted or is a failed task with retries left; creates a branch off the **latest** default branch; has the Copilot CLI make the **smallest** change that resolves the bug; **self-validates** the change; commits, pushes, and opens a PR **linked to the bug**.

**Self-validation before every PR.** Before committing, Code Autopilot reviews its own changed files against the same categories the audit agent uses (security, privacy, secrets, correctness, accessibility, resilience, performance) and **aborts the attempt** if it introduced a blocking or major issue — so it doesn't open a PR that trades one problem for another.

**Optional pre-push validation.** With `SATURN_FIX_PREPUSH_VALIDATE=true`, Code Autopilot runs ESLint on the changed files in its clone before pushing and does a corrective model round on any errors, so PRs start green. It is off by default because it is slow; the PR pipeline stays the final gate.

**Reacting immediately (webhook).** The dashboard exposes `POST /api/hooks/ado` (guarded by `SATURN_WEBHOOK_SECRET`). Point an Azure DevOps **service hook** (e.g. *pull request updated* / *build completed*) at it and Code Autopilot breaks its poll-sleep and runs an iteration within seconds instead of waiting up to `SATURN_FIX_POLL_MINUTES` — polling stays the reliable fallback when the hook can't reach the dashboard.

**Caps, retries, and restart recovery.** The open-task cap (`SATURN_FIX_MAX_OPEN_PRS`) counts **every** in-flight task — not just open PRs — so it never runs more than N fixes at once. A failed task is retried up to **3** times before it's left for a human. If the process is restarted mid-fix, any task stranded in progress is recovered on startup — **resumed** if it already had a PR (no duplicate PR), otherwise **re-queued** for retry — so it never permanently holds a cap slot. Each cycle it also **prunes local branches** whose PR already merged/abandoned, so the fix clone stays clean.

**Phased scope.** The agent prefers the narrowest change a bug allows - **phase 1** = the fix is isolated to a single file, **phase 2** = within a single package, **phase 3** = anything. `SATURN_FIX_MAX_PHASE` caps how far it will go (default 1, single-file only).

The agent **never merges PRs itself** and only ever pushes its own feature branches - humans (or branch policies) merge. The PRs it opens appear in the dashboard's **Code Autopilot** tab.
- **Test coverage.** New/changed production logic lacking tests is flagged (major if risky, else minor), scoped strictly to the change delta — never pre-existing code, pure refactors, or non-unit-testable changes.

## Builder Autopilot (on-demand design + feature build)

Unlike the three always-on / standalone agents above, **Builder Autopilot** runs only when you use it, from the dashboard's **Builder Autopilot** tab.

1. **Design turn (read-only).** You describe what you want; the design agent runs the Copilot CLI over the codebase in read-only mode and **streams live chain-of-thought** (its reasoning + which files it reads/searches) before the answer. It judges feasibility, proposes options, and produces a **design-document artifact** (markdown + mermaid) that is stored and can be copied as markdown or exported as HTML. On this path the Azure DevOps + GitHub MCP servers are **denied**, so the agent cannot open a PR, file a work item, or change anything while researching.
2. **Approval gate.** A pull request is created **only after you explicitly approve** a design — the UI shows a confirmation dialog stating a branch and PR will be opened, so nothing is built by a stray click.
3. **Feature build.** Approval hands the design to the feature-build pipeline (an extension of Code Autopilot): it branches off the latest default branch, implements the design, **self-validates twice**, lints, and opens a **PR linked back to the conversation** — surfaced both in the chat and on the Code Autopilot tab. It **never merges** its own PR.

Prior design docs are reused as **cross-session memory** for later conversations, and every design doc carries a **"Created by Saturn"** watermark.

## Feedback

Every posted comment includes a `Share feedback` link to the dashboard's feedback page, carrying the PR id and comment (thread) id. The feedback page captures the signed-in user (Azure AD identity when hosted behind EasyAuth, the git identity locally), a Helpful/Not-helpful rating, and a message. Submissions are stored and surfaced on the dashboard with a **deep link back to the exact comment** in the PR.

## Dashboard & control

The dashboard opens on a **Dashboard** tab — an all-visual, **interactive Chart.js** leadership/manager overview (a live sweep-progress slider, KPI cards, and severity / category / lifecycle **doughnuts + bar charts** for the audit, plus review outcomes, a 14-day per-day trend, throughput, and file hotspots for the reviewer), assembled from a single `/api/dashboard` call and refreshed live. Further tabs — **PR review**, **Codebase audit**, **Code Autopilot**, **Documentation**, and **Builder Autopilot** — hold the detailed, filterable lists and the on-demand design-and-build surface. The UI updates live via **Server-Sent Events** (no manual refresh). Anyone with access can view history and submit feedback; **Start/Stop is owner-only** — hidden in the UI for other viewers and rejected server-side (`403`) for anyone but the `SATURN_OWNER`.

## The codebase audit loop

A second, parallel loop audits the **whole checked-out codebase** (not PRs), surfaced in the dashboard's **Codebase audit** tab. It is independent of the review loop and read-only against the same managed clone.

- **Resumable, prioritized sweep.** It enumerates all source files (security/privacy-sensitive paths first, deterministically) and audits them in **multi-turn batches**, persisting a cursor so a run resumes where it left off. When a full sweep completes it idles until the next day, then starts a fresh sweep; an in-progress sweep always finishes first.
- **Broad categories.** Each finding is tagged `security`, `privacy`, `secrets`, `telemetry`, `telemetry-gap` (a production path with no telemetry/log to diagnose a live-site incident), `correctness`, `resilience`, `performance`, `accessibility`, `dependency`, `api-compat`, `dead-code`, or `config`, with a severity.
- **Double quality check.** One generation pass proposes findings; **two** independent verification passes re-check them (all instructed to use the read-only tools to trace source → sink and read related code first). A finding is stored only if **both** passes keep it.
- **De-dup + age.** Findings are keyed by a stable id; the same issue is refreshed (not re-added) across sweeps, and a second bug is never logged for the same file+category+line. Each shows **"in codebase since"** (the file's first git commit) and **"first flagged"**, and deep-links to the highlighted source line — or the whole **block** when the issue spans a line range (plus any related locations for a multi-file issue). Filter by type, severity, status, package, or path.
- **Owner-aware ADO bugs.** "Create bug" resolves the file's owning team from its `ownership.json` (area path + owner) and offers alternatives (including type-team routes auto-discovered from `ownership.json`); the chosen route files a **tagged Bug** assigned to the package owner in the owning team's current sprint. If ADO rejects a stale/renamed area path, Saturn **walks up to the nearest valid parent area** instead of dropping it, keeping the owner assignee wherever ADO accepts the identity. **Auto-create** (default off) files new findings to the package-owner route automatically.
- **Access model.** The findings list, deep links, **Create bug**, **Open/edit bug**, **Dismiss**, and **Recover** are available to any viewer; only **Start/Stop** and auto-create are owner-only. Dismiss prompts for a **reason** and your **alias** (a stand-in until sign-in exists) and records who dismissed it and why; the finding is retained so it can be recovered later.
- **Auto-resolve + auto-close.** A finding no longer detected in a completed sweep is marked **resolved** and its bug gets a comment; after it stays undetected for `SATURN_AUDIT_CLOSE_AFTER_SWEEPS` sweeps (default 2) the ADO bug is resolved. It re-opens if a later sweep finds it again.
- **Bug fix-tracking.** Subsequent sweeps poll each filed bug's ADO **state** (cooldown-gated via `SATURN_AUDIT_BUG_POLL_HOURS`, bounded per batch via `SATURN_AUDIT_BUG_POLL_BATCH`) and reconcile — the status is tracked in `audit.db` and shown as a **card badge**, and Saturn doesn't comment on the bug unless it acts. A bug a human marked **fixed** is validated against Saturn's own detection (**fix confirmed** when Saturn also no longer detects it, **still detected** when it does; with `SATURN_AUDIT_BUG_REACTIVATE` on, a still-detected bug is reopened to `SATURN_AUDIT_BUG_REACTIVATE_STATE` with a one-line comment). A **won't-fix / by-design / duplicate** closure is left untouched and dropped from the **Open** list (it moves under the **Won't fix** filter). A **needs-more-info** bug gets the finding's details posted once. Unchanged bugs aren't re-processed, and the classifier is configurable for custom ADO workflows (`SATURN_AUDIT_BUG_FIXED_STATES` / `_WONTFIX_STATES` / `_NEEDSINFO_STATES`).
- **SARIF.** All findings are downloadable as SARIF 2.1.0 from `/api/audit/sarif`.

Findings live under `~/.saturn/audit/` (a SQLite `audit.db`). The list, bug-filing, and dismiss/recover are open to all dashboard viewers; only loop control (Start/Stop) is owner-only.
