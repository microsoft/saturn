# Saturn

An always-on, **repo-agnostic** security & privacy pull-request reviewer for **Azure DevOps**, powered by the **GitHub Copilot CLI**. Saturn continuously scans active PRs, runs a two-pass (review + verification) model review, and posts verified inline comments on your behalf. A dashboard (http://localhost:6789) shows live status, the full review history, and reviewer feedback.

## Highlights

- **Continuous, iteration-aware review** — reviews active PRs newest-first; **PR + iteration** is the idempotency key, so each iteration is reviewed exactly once and a new push is re-reviewed.
- **Backlog backfill** — when caught up, drains older active PRs (last 2 weeks) one at a time, always letting fresh PRs preempt.
- **Low noise** — clean PRs get _zero_ comments; non-actionable findings (nit/minor) post as **Resolved**; only blocking/major show as active threads; recurring findings reactivate the existing thread instead of re-posting.
- **Test-coverage lens** — flags new/changed production code lacking tests (the change delta only, never pre-existing code).
- **Reactive dashboard** — live updates via Server-Sent Events (no manual refresh) with paginated history.
- **Feedback loop** — every comment links to a feedback page that captures the signed-in user; feedback shows on the dashboard with a deep link back to the exact comment.
- **Owner-only control** — anyone on corpnet can view the dashboard and submit feedback, but only the owner can Start/Stop (enforced server-side).

## Documentation

- [docs/get-started.md](docs/get-started.md) — run Saturn against your own Azure DevOps repo.
- [docs/how-saturn-works.md](docs/how-saturn-works.md) — the review loop, comment behavior, and feedback flow.
- [docs/architecture.md](docs/architecture.md) — components, data flow, storage, and auth.

## Requirements (all shelled out — no repo-specific dependencies)

- **git** with a working credential helper for the target Azure DevOps repo (a headless HTTPS clone must succeed).
- **Azure CLI** (`az login`) — used to mint a fresh ADO token on a 401.
- **GitHub Copilot CLI** (`copilot`) installed and logged in — this is the review model.
- **Node.js 20+**.

The only npm runtime dependency is `zod`.

## Configuration

Defaults point at office-bohemia; override via environment variables to target any Azure DevOps repo:

| Env var                | Default                | Meaning                                         |
| ---------------------- | ---------------------- | ----------------------------------------------- |
| `SATURN_ADO_HOST`      | `dev.azure.com`        | REST host                                       |
| `SATURN_ADO_ORG`       | `office`               | organization                                    |
| `SATURN_ADO_PROJECT`   | `OC`                   | project                                         |
| `SATURN_ADO_REPO_ID`   | office-bohemia GUID    | repository GUID                                 |
| `SATURN_ADO_REPO_NAME` | `office-bohemia`       | repository name                                 |
| `SATURN_CLONE_URL`     | derived                | explicit clone URL (optional)                   |
| `SATURN_CLONE_DIR`     | `<deploy>/repo/<repo>` | managed clone location                          |
| `SATURN_OWNER`         | git `user.email`       | identity allowed to Start/Stop the agent        |
| `SATURN_FEEDBACK_URL`  | local dashboard        | base URL of the feedback page (set when hosted) |
| `SATURN_MODEL`         | `claude-opus-4.8`      | Copilot CLI model                               |
| `SATURN_DEPLOY_DIR`    | `C:\saturn` (Win)      | deploy output directory                         |

See [docs/get-started.md](docs/get-started.md) for the full list and examples.

## Scripts

- `npm run build` — typecheck (`tsc --noEmit`)
- `npm test` — unit tests (jest)
- `npm run lint` — eslint
- `npm run saturn` — run the dashboard locally (via `tsx`)
- `npm run review` — one-shot CLI review (`--help` for flags)
- `npm run deploy` — bundle (esbuild) to `SATURN_DEPLOY_DIR` and register Windows logon autostart

## Deploy

`npm run deploy` produces self-contained `saturnDashboard.cjs` / `saturn-cli.cjs` bundles (with `zod` inlined) plus a hidden launcher, fully independent of this source tree. For a multi-user, corpnet-hosted dashboard with real per-user identity, host it behind Azure AD (App Service / Container Apps EasyAuth) and set `SATURN_OWNER` + `SATURN_FEEDBACK_URL`. See [docs/architecture.md](docs/architecture.md).
