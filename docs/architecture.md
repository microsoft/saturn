# Architecture

Saturn is a single Node process: an HTTP **dashboard server** that hosts a controllable **review loop**, a parallel **codebase-audit loop**, and an on-demand **Builder Autopilot** (chat) surface; **Code Autopilot** runs as its own standalone process. Everything else (git, Azure CLI, the GitHub Copilot CLI, Azure DevOps) is reached by shelling out or over REST — a few local stores use SQLite, but there is no server framework.

## Components (`src/`)

| Module                 | Responsibility                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `saturnDashboard.ts`   | HTTP server: dashboard UI, feedback page, JSON + Server-Sent-Events endpoints, identity/owner.                        |
| `saturnService.ts`     | The always-on loop (scan → backfill → idle), live status, start/stop.                                                 |
| `runSaturn.ts`         | One scan: list candidates, select non-draft (optionally date-bounded), review up to N.                                |
| `reviewPullRequest.ts` | Per-PR pipeline: skip decision, fetch diff, model review, verification gate, post/reactivate.                         |
| `review.ts`            | Prompt construction, response parsing/validation, severity policy.                                                    |
| `copilot.ts`           | Runs the GitHub Copilot CLI (the model), locates it, registers the Azure DevOps MCP server, and applies the model-fallback + reasoning-effort policy. |
| `ado.ts`               | Azure DevOps REST: list PRs, iterations, changed files, blobs, threads, post/reactivate/edit, create bugs + comments. |
| `git.ts`               | Managed clone of the target repo (gives the model a working tree), master refresh.                                    |
| `saturnStore.ts`       | JSON persistence under `~/.saturn/` (reviews, totals, feedback).                                                      |
| `auditStore.ts`        | JSON persistence of audit findings + sweep progress under `~/.saturn/audit/`.                                         |
| `codebaseAudit.ts`     | Codebase audit sweep: enumerate, batch, generate + double-verify, dedup, best-effort git age.                         |
| `bugRouting.ts`        | Resolve a finding's owning team + ADO area path from the nearest `ownership.json`.                                    |
| `sarif.ts`             | SARIF 2.1.0 export of PR-review and codebase-audit findings.                                                          |
| `fixService.ts`        | Code Autopilot's standalone loop: recover interrupted tasks, monitor open PRs, start one new fix under the cap.        |
| `fixAgent.ts`          | Code Autopilot's per-bug pipeline: select/retry, generate, self-validate, open PR, and remediate all PR failures.      |
| `fixStore.ts`          | SQLite store of Code Autopilot tasks (`~/.saturn/fix/fix.db`): status, cap counting, retries, restart recovery.        |
| `fixStart.ts`          | Entry point for the standalone `saturn-autopilot` process.                                                             |
| `chatService.ts`       | Builder Autopilot orchestration: runs a design turn, persists messages/artifacts, and (on approval) starts a feature build. |
| `designAgent.ts`       | The conversational, **read-only** design agent: researches the repo, judges feasibility, proposes options, drafts the design doc (Azure DevOps + GitHub MCP write tools denied). |
| `featureBuild.ts`      | Feature-build pipeline: approved design → branch → implement → self-validate twice → lint → open PR.                    |
| `chatStore.ts`         | SQLite store for Builder Autopilot (`~/.saturn/chat/chat.db`): conversations, messages, design-doc artifacts, feature builds. |
| `markdownRender.ts`    | Safe (escape-first) markdown → HTML for design docs + transcripts (preview, HTML export, watermark).                  |
| `config.ts`            | Loads `.env`, exposes the Azure DevOps coordinates, and builds URL/feedback links.                                    |
| `util.ts`              | Process spawning and logging helpers.                                                                                 |

## Data flow

```
dashboard/loop (saturnService)
  -> runSaturn: ado.listActivePullRequests
  -> reviewPullRequest:
       ado.getLatestIterationId  --> store.readPullRequestReview  (skip if this iteration done)
       ado.getChangedFiles + getBlobText/getFileTextAtCommit
       copilot.runCopilotReview (review pass) --> review.parseReviewResult
       copilot.runCopilotReview (verification pass) --> kept comments
       ado.postInlineComment / reactivateThreadAndReply (+ append feedback link)
  -> store.recordSaturnReview (per PR + iteration)
```

The Copilot CLI runs with its working directory set to the **managed clone**, so the model can read surrounding code, not just the diff.

## Why the Copilot CLI, not a cloud coding agent

The target repository lives in **Azure DevOps**, and GitHub's cloud coding agent only services repositories on **GitHub.com** (it acts on GitHub issues/PRs and runs on GitHub Actions). For an ADO-hosted monorepo it simply isn't an option. The **Copilot CLI** is also the better fit on the merits: it runs against Saturn's own **persistent managed clone** (no multi-gigabyte re-clone per task on a large monorepo), keeps every git / PR / package operation under Saturn's control (the model only edits files in an isolated clone), and lets Code Autopilot reach ADO build logs + PR threads through the **Azure DevOps MCP server** — so it can diagnose and fix failures like a developer. If the repo ever moved to GitHub, a cloud-agent backend could be reconsidered.

## Storage layout (`~/.saturn/`)

- `reviews/<prId>.json` — one file per PR, with an entry per reviewed iteration (full history, no cap).
- `totals.json` — the running reviewed count.
- `feedback.json` — submitted feedback entries.
- `audit/audit.db` — SQLite store of codebase-audit findings (de-duped, with status, dismiss reason + dismisser, and any filed-bug link) plus the per-file `scanned_files` index that drives incremental sweeps.
- `audit/progress.json` — the resumable audit sweep cursor.
- A legacy single `state.json` is migrated into per-PR files on first read.

## Authentication

- **Azure DevOps REST** — Basic auth from the git credential helper (the same mechanism `git pull` uses). On a `401`, Saturn mints a fresh bearer token from `az account get-access-token` (the Azure CLI silently refreshes), and prefers the CLI thereafter for that repo. No PAT is required for the happy path.
- **Dashboard identity** — when hosted behind Azure AD (App Service / Container Apps **EasyAuth**), the signed-in user arrives in the `x-ms-client-principal-name` header; locally it falls back to the machine's git identity. This identity is used to (a) stamp feedback submissions and (b) gate Start/Stop to the `SATURN_OWNER`.

## HTTP surface (`saturnDashboard.ts`)

| Route                            | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `GET /`                          | Dashboard UI.                                            |
| `GET /vendor/chart.umd.min.js`   | Self-hosted Chart.js for the Dashboard charts (no CDN).  |
| `GET /api/events`                | Server-Sent Events stream of live state (reactive UI).   |
| `GET /api/state`                 | Live status snapshot (counts only; cheap).               |
| `GET /api/stats`                 | PR-review aggregates (severity/aspect, daily, hotspots). |
| `GET /api/dashboard`             | One-call bundle for the leadership **Dashboard** tab.    |
| `GET /api/reviews?page=`         | Paginated review history.                                |
| `GET /api/whoami`                | `{ user, owner, isOwner }` for the current viewer.       |
| `POST /api/start` `/api/stop`    | Control the loop — **owner-only** (403 otherwise).       |
| `GET /api/audit/state`           | Codebase-audit loop status + aggregate counts.           |
| `GET /api/audit/summary`         | Audit severity / category / package aggregates.          |
| `GET /api/audit/findings`        | Audit findings (read-only) with source deep links.       |
| `GET /api/audit/routes?id=`      | Candidate ADO routes for a finding (read-only).          |
| `POST /api/audit/start` `/stop`  | Control the audit loop — **owner-only**.                 |
| `POST /api/audit/create-bug`     | File an ADO bug for a finding (any viewer).              |
| `POST /api/audit/dismiss`        | Dismiss a finding (reason + alias) — any viewer.         |
| `POST /api/audit/recover`        | Recover a dismissed/resolved finding — any viewer.       |
| `POST /api/audit/auto-create`    | Toggle automatic bug filing — **owner-only**.            |
| `GET /api/audit/sarif`           | SARIF 2.1.0 export of audit findings.                    |
| `GET /feedback?prId=&commentId=` | Feedback page for a specific comment.                    |
| `GET` / `POST /api/feedback`     | List / submit feedback.                                  |

## Hosting for multiple users

Locally the dashboard is single-user (localhost). To let other corpnet users view it and submit feedback while keeping the agent in your context and Start/Stop limited to you:

1. Build the image and deploy behind **Azure AD Easy Auth** (App Service or Container Apps) - see [`Dockerfile`](../Dockerfile) and [`scripts/deploy-azure.ps1`](../scripts/deploy-azure.ps1).
2. Set `SATURN_OWNER` to your signed-in identity (UPN). Easy Auth injects the `x-ms-client-principal-name` header, which Saturn trusts for per-user identity and owner gating; a relayed request is otherwise treated as a non-owner viewer automatically.
3. Set `SATURN_FEEDBACK_URL` to the hosted `/feedback` URL and persist `~/.saturn/` (e.g. an Azure Files mount) so history/feedback survive restarts.

The agent still runs as one identity (its git/Azure CLI/Copilot credentials); Easy Auth only identifies _viewers_ for feedback attribution and owner gating.

> **Tunnels (e.g. `devtunnel`) are different:** they gate _access_ via login but forward from localhost and do **not** inject an identity header. Through a tunnel Saturn cannot prove who a viewer is, so visitors are **anonymous** (their feedback is recorded as `anonymous`, never a typed-in name) and **Start/Stop is disabled** (owner control is limited to direct, on-machine requests). Only Easy Auth gives true per-user identities and lets the owner control the loop remotely.
