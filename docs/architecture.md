# Architecture

Saturn is a single Node process: an HTTP **dashboard server** that hosts a controllable **review loop**. Everything else (git, Azure CLI, the GitHub Copilot CLI, Azure DevOps) is reached by shelling out or over REST — there is no database and no framework.

## Components (`src/`)

| Module                 | Responsibility                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `saturnDashboard.ts`   | HTTP server: dashboard UI, feedback page, JSON + Server-Sent-Events endpoints, identity/owner. |
| `saturnService.ts`     | The always-on loop (scan → backfill → idle), live status, start/stop.                          |
| `runSaturn.ts`         | One scan: list candidates, select non-draft (optionally date-bounded), review up to N.         |
| `reviewPullRequest.ts` | Per-PR pipeline: skip decision, fetch diff, model review, verification gate, post/reactivate.  |
| `review.ts`            | Prompt construction, response parsing/validation, severity policy.                             |
| `copilot.ts`           | Runs the GitHub Copilot CLI (the model) and locates it.                                        |
| `ado.ts`               | Azure DevOps REST: list PRs, iterations, changed files, blobs, threads, post/reactivate/edit.  |
| `git.ts`               | Managed clone of the target repo (gives the model a working tree), master refresh.             |
| `saturnStore.ts`       | JSON persistence under `~/.saturn/` (reviews, totals, feedback).                               |
| `config.ts`            | Loads `.env`, exposes the Azure DevOps coordinates, and builds URL/feedback links.             |
| `util.ts`              | Process spawning and logging helpers.                                                          |

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

## Storage layout (`~/.saturn/`)

- `reviews/<prId>.json` — one file per PR, with an entry per reviewed iteration (full history, no cap).
- `totals.json` — the running reviewed count.
- `feedback.json` — submitted feedback entries.
- A legacy single `state.json` is migrated into per-PR files on first read.

## Authentication

- **Azure DevOps REST** — Basic auth from the git credential helper (the same mechanism `git pull` uses). On a `401`, Saturn mints a fresh bearer token from `az account get-access-token` (the Azure CLI silently refreshes), and prefers the CLI thereafter for that repo. No PAT is required for the happy path.
- **Dashboard identity** — when hosted behind Azure AD (App Service / Container Apps **EasyAuth**), the signed-in user arrives in the `x-ms-client-principal-name` header; locally it falls back to the machine's git identity. This identity is used to (a) stamp feedback submissions and (b) gate Start/Stop to the `SATURN_OWNER`.

## HTTP surface (`saturnDashboard.ts`)

| Route                            | Purpose                                                |
| -------------------------------- | ------------------------------------------------------ |
| `GET /`                          | Dashboard UI.                                          |
| `GET /api/events`                | Server-Sent Events stream of live state (reactive UI). |
| `GET /api/state`                 | Live status snapshot (counts only; cheap).             |
| `GET /api/reviews?page=`         | Paginated review history.                              |
| `GET /api/whoami`                | `{ user, owner, isOwner }` for the current viewer.     |
| `POST /api/start` `/api/stop`    | Control the loop — **owner-only** (403 otherwise).     |
| `GET /feedback?prId=&commentId=` | Feedback page for a specific comment.                  |
| `GET` / `POST /api/feedback`     | List / submit feedback.                                |

## Hosting for multiple users

Locally the dashboard is single-user (localhost). To let other corpnet users view it and submit feedback while keeping the agent in your context and Start/Stop limited to you:

1. Build the image and deploy behind **Azure AD Easy Auth** (App Service or Container Apps) - see [`Dockerfile`](../Dockerfile) and [`scripts/deploy-azure.ps1`](../scripts/deploy-azure.ps1).
2. Set `SATURN_OWNER` to your signed-in identity (UPN). Easy Auth injects the `x-ms-client-principal-name` header, which Saturn trusts for per-user identity and owner gating; a relayed request is otherwise treated as a non-owner viewer automatically.
3. Set `SATURN_FEEDBACK_URL` to the hosted `/feedback` URL and persist `~/.saturn/` (e.g. an Azure Files mount) so history/feedback survive restarts.

The agent still runs as one identity (its git/Azure CLI/Copilot credentials); Easy Auth only identifies _viewers_ for feedback attribution and owner gating.

> **Tunnels (e.g. `devtunnel`) are different:** they gate _access_ via login but forward from localhost and do **not** inject an identity header. Through a tunnel Saturn cannot prove who a viewer is, so visitors are **anonymous** (their feedback is recorded as `anonymous`, never a typed-in name) and **Start/Stop is disabled** (owner control is limited to direct, on-machine requests). Only Easy Auth gives true per-user identities and lets the owner control the loop remotely.
