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
- **Test coverage.** New/changed production logic lacking tests is flagged (major if risky, else minor), scoped strictly to the change delta — never pre-existing code, pure refactors, or non-unit-testable changes.

## Feedback

Every posted comment includes a `Share feedback` link to the dashboard's feedback page, carrying the PR id and comment (thread) id. The feedback page captures the signed-in user (Azure AD identity when hosted behind EasyAuth, the git identity locally), a Helpful/Not-helpful rating, and a message. Submissions are stored and surfaced on the dashboard with a **deep link back to the exact comment** in the PR.

## Dashboard & control

The dashboard updates live via **Server-Sent Events** (no manual refresh). Anyone with access can view history and submit feedback; **Start/Stop is owner-only** — hidden in the UI for other viewers and rejected server-side (`403`) for anyone but the `SATURN_OWNER`.
