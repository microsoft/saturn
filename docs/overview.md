# Saturn — an always-on engineering agent: codebase audit, PR review, Code Autopilot & Builder Autopilot

Saturn does three jobs continuously, without anyone having to ask:

1. It **audits the entire existing codebase** for security, privacy, reliability, and telemetry-gap issues that are *already* there.
2. It **reviews every new pull request** the moment it's pushed.
3. It **fixes assigned bugs by opening pull requests** — a standalone agent that turns audit bugs into reviewed PRs.

And, on request, a fourth: **Builder Autopilot** designs and builds a new feature — you describe it, Saturn researches the codebase and drafts a design document, and after you approve, it opens the pull request.

Think of it as a tireless senior engineer that never sleeps — sweeping the whole repository for long-standing risks, checking every change as it lands, drafting the fixes, and — when asked — designing and building new work.

## Codebase audit — finding the issues already in the code

Most review tools only look at *new* changes. Saturn's bigger job is the opposite: it continuously sweeps the **whole codebase** to surface problems that already shipped and would otherwise sit undiscovered.

- **Finds existing risks across the repo** — security and privacy issues, leaked secrets, correctness and resilience bugs, plus performance, accessibility, dependency, and dead-code problems.
- **Closes telemetry gaps for livesite** — it flags production code paths that have **no logging or telemetry**, so when a live-site incident happens the data needed to diagnose it is already there instead of missing.
- **Triage-ready and owner-routed** — every finding gets a severity and category, links straight to the exact line, shows how long it's been in the code, and can be filed as a bug that's **automatically routed to the team that owns that area** (or dismissed with a reason).
- **High signal** — two independent verification passes confirm each finding before it's kept, and issues that get fixed close themselves automatically.

## PR review — catching issues as they're introduced

Alongside the audit, Saturn reviews **every pull request the moment it's pushed**, holding new work to the same bar.

- **Reviews every change automatically** — newest first, and re-reviews whenever a PR is updated.
- **Stays quiet unless it matters** — a clean PR gets zero comments; only findings worth acting on open a thread.
- **Flags missing tests** — highlights new or changed code that ships without coverage.
- **Checks its own work** — a verification pass removes false alarms before anything is posted.
- **Always labeled** — every comment states it's an automated review by Saturn, and that it is not a sign-off.

## Code Autopilot — turning bugs into pull requests

Beyond finding and reviewing, Saturn can also **fix**. A standalone agent — **Code Autopilot** — picks an assigned bug (starting with accessibility), makes the smallest change that resolves it, and opens a pull request **linked to the bug** — then shepherds that PR: addressing review comments, build errors, and merge conflicts, and cleaning up its branch once the PR merges.

- **Phased and conservative** — it starts with fixes isolated to a single file, then (when allowed) a single package, then anything; one PR at a time by default.
- **Fully isolated** — it runs as its own process against its own clone, so it never disturbs the audit or PR-review agents.
- **Human-gated** — it never merges its own PRs; people (or branch policies) do.

## Builder Autopilot — designing and building features on request

The other three agents run on their own; **Builder Autopilot** works *with* you. From the dashboard's **Builder Autopilot** tab you describe what you want built, and the agent:

- **Researches read-only and proposes a design** — it reads and searches the whole codebase to judge feasibility, proposes options, and produces a **design document** (markdown with diagrams) you can copy or export. During this step it can only read — it cannot open pull requests, file work items, or change anything.
- **Builds only after you approve** — nothing is created until you explicitly approve a design; approval starts a build that opens a **pull request** (branch → implement → self-check twice → PR) for your review. As with Code Autopilot, a human always merges.

It runs **on demand** (only while you're using it), so it consumes no capacity in the background.

## Why it matters

- **Fixes what's already broken — not just new changes.** The audit surfaces long-standing risks across the whole codebase; the PR reviewer stops new ones at the door.
- **Fewer blind live-site incidents.** Telemetry-gap findings put the diagnostics in place *before* something breaks in production.
- **A consistent bar, every time.** The same careful review on every file and every PR, regardless of who's busy.
- **Findings that actually get owned.** Audit issues become bugs assigned to the right team, not a report nobody acts on.
- **Quiet by design.** Only actionable findings surface, so the signal stays high.

## Live dashboard

Saturn serves a live dashboard at **http://localhost:6789** — a visual overview of both the audit and the PR reviewer: findings by severity and category, bugs filed, sweep progress, review history, and per-comment feedback.

When hosted for a team behind an authenticating proxy, the dashboard is **view-only** and access-controlled; nothing on it can change the running agent, and starting and stopping stays with the owner.

## Trust & safety

- **Read-only where it should be; human-gated everywhere else.** The audit and PR-review agents only comment and file bugs — they never change code. Code Autopilot and Builder Autopilot do open pull requests, but only ever their own branches, and **a human merges every one** — Saturn never merges its own PR, and Builder Autopilot never opens one without your explicit approval.
- **Clearly labeled** as automated, and explicitly not an approval.
- **Owner-only control** — anyone can watch, but only the owner can start or stop it.
- **Never spams** — it won't post the same comment twice, won't log a duplicate bug, and clean PRs get nothing.
- **As good as the best model** — Saturn always uses the most capable model available, so its quality improves as the models do.

## Built to point anywhere

Saturn isn't tied to one repository. Aiming it at a new repo is essentially a two-line change — the repo's address and its main branch — with no per-repo setup. The same auditor and reviewer can watch any team's code.

## Where it lives

Saturn is open-sourced at **https://github.com/microsoft/saturn**, where deeper get-started, how-it-works, and architecture docs live for anyone who wants the details.
