# Saturn

An always-on, **repo-agnostic** autonomous engineering agent for **Azure DevOps**, powered by the **GitHub Copilot CLI**. Saturn runs four cooperating agents: a continuous **PR reviewer** (two-pass review + verified inline comments), a whole-**codebase security & privacy auditor**, **Code Autopilot** (which opens and iterates pull requests to fix assigned bugs), and **Builder Autopilot** (an on-demand, conversational design agent that researches the codebase, drafts a design document, and — after explicit human approval — builds the feature as a pull request). A dashboard (http://localhost:6789) shows live status, history, and reviewer feedback.

## Highlights

- **Continuous, iteration-aware review** — reviews active PRs newest-first; **PR + iteration** is the idempotency key, so each iteration is reviewed exactly once and a new push is re-reviewed.
- **Backlog backfill** — when caught up, drains older active PRs (last 2 weeks) one at a time, always letting fresh PRs preempt.
- **Low noise** — clean PRs get _zero_ comments; non-actionable findings (nit/minor) post as **Resolved**; only blocking/major show as active threads; recurring findings reactivate the existing thread instead of re-posting.
- **Test-coverage lens** — flags new/changed production code lacking tests (the change delta only, never pre-existing code).
- **Reactive dashboard** — live updates via Server-Sent Events (no manual refresh) with paginated history.
- **Leadership Dashboard tab** — the default tab is an all-visual, **interactive Chart.js** overview (live sweep-progress slider, KPI cards, severity/category/status doughnuts + bars for the audit, and review outcomes, a 14-day trend, throughput, and file hotspots for the reviewer); the detailed, filterable lists live on the other two tabs. Assembled from one `/api/dashboard` call; charts use a self-hosted Chart.js (the `chart.js` npm package, served from `/vendor/`, no external CDN) and fall back to inline SVG offline.
- **Feedback loop** — every comment links to a feedback page that captures the signed-in user; feedback shows on the dashboard with a deep link back to the exact comment.
- **Owner-only control** — anyone who can reach the dashboard (e.g., on your corporate network) can view it and submit feedback, but only the owner can Start/Stop (enforced server-side).

## Codebase audit agent

A **second, parallel agent** continuously audits the **whole checked-out codebase** (not PRs), from its own **"Codebase audit"** tab in the dashboard (Start/Stop are owner/localhost-only). It covers **security, privacy, secrets, telemetry/PII, telemetry-gaps** (production paths with no diagnostics for live-site debugging)**, correctness, resilience, performance, accessibility, dependency, API-compatibility, dead-code, and config/IaC** issues.

- **Resumable daily sweep**, security/privacy-sensitive paths first; an in-progress sweep always completes before the next starts.
- **Double quality check** — a generation pass plus **two** independent verification passes, all instructed to use read-only tools (and the per-batch import graph) to trace source → sink before a finding is reported or kept.
- **De-duplicated + dated** by a stable finding id; each shows **"in codebase since"** (the file's first git commit) and **"first flagged"**, and **deep-links** to the highlighted source line — or the whole **block** when the issue spans a line range (plus related locations for a multi-file issue).
- **Owner-aware ADO routing + dedup** — "Create bug" resolves the file's owning team from its `ownership.json` (area path + owner) and offers alternatives (including type-team routes auto-discovered from `ownership.json`, e.g. accessibility → an a11y team); the chosen route files a tagged ADO Bug assigned to the package owner in the **owning team's current sprint** (best-effort). If ADO rejects a stale/renamed area path it **walks up to the nearest valid parent area** instead of dropping it, keeping the owner assignee wherever ADO accepts the identity. A second bug is never logged for the same file+category+line.
- **Access model** — the findings list, deep links, **Create bug**, **Open/edit bug**, **Dismiss**, and **Recover** are available to any viewer; only **Start/Stop** and auto-create are owner-only.
- **Dismiss / recover + filters** — Dismiss prompts for a **reason** and your **alias** (a stand-in until sign-in exists) so the finding records **who dismissed it and why**; filter by **Dismissed** to see the reason + dismisser and recover it. Filter by **type, severity, status, package, or path**.
- **Auto-create toggle (default OFF)** — when on, new findings auto-file to the package-owner route, so enabling it "just works".
- **Auto-resolve + auto-close** — a finding no longer detected is marked resolved and its bug gets a comment; after `SATURN_AUDIT_CLOSE_AFTER_SWEEPS` missed sweeps (default 2) the bug is auto-resolved. It re-opens if a later sweep finds it again.
- **SARIF export** at `/api/audit/sarif`. Findings are stored under `~/.saturn/audit/`; the list, bug-filing, and dismiss/recover are open to all viewers, while loop control (Start/Stop) stays owner-only.

Routing works out of the box from `ownership.json`; the `SATURN_BUG_*` / `SATURN_AUDIT_*` env vars (see the table below) are optional overrides.

## Builder Autopilot agent

A fourth, **on-demand** agent lives on the dashboard's **"Builder Autopilot"** tab — a conversational design-and-build surface. It does **not** run in the background and only uses the model when you send a message.

- **Conversational design** — describe what you want; the agent researches the **whole codebase read-only**, judges feasibility, proposes options, and streams a **design document** (markdown + mermaid) with live chain-of-thought. It **cannot** create pull requests, work items, branches, or commits while researching (the Azure DevOps + GitHub MCP servers are denied on this read-only path).
- **Approve, then build** — a PR is only ever created after you **explicitly approve** a design (a confirmation dialog states a branch + pull request will be opened). Approval hands off to the **feature-build pipeline** — an extension of Code Autopilot from bugs to features: branch → implement → **self-validate twice** → lint → open a PR, surfaced in the chat and on the Code Autopilot tab. It never merges its own PR.
- **Design docs** — every design doc can be **copied as markdown** or opened/exported as HTML, carries a **"Created by Saturn"** watermark, and prior design docs are reused as cross-session memory for new conversations.

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

Saturn reads its configuration from a **`.env` file** (copy [`.env.example`](.env.example) to `.env`) or from real environment variables. `config.ts` loads the first `.env` it finds — the path in `SATURN_ENV_FILE`, then the working directory, then the running bundle's directory — and never overrides variables already set in the environment. The simplest setup is **`SATURN_REPO_URL`** (the repo's URL) plus `SATURN_ADO_DEFAULT_BRANCH`; Saturn parses the org/project/repo from the URL (no GUID needed — the REST API accepts the repo name). The individual `SATURN_ADO_*` coordinates are an alternative/override; everything else has a default.

| Env var                           | Default                | Meaning                                                        |
| --------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `SATURN_REPO_URL`                 | —                      | repo URL; org/project/repo parsed from it (simplest config)    |
| `SATURN_ADO_DEFAULT_BRANCH`       | `master`               | branch tracked for review context                              |
| `SATURN_ADO_HOST`                 | `dev.azure.com`        | REST host                                                      |
| `SATURN_ADO_ORG`                  | from `SATURN_REPO_URL` | organization (required if no `SATURN_REPO_URL`)                |
| `SATURN_ADO_PROJECT`              | from `SATURN_REPO_URL` | project (required if no `SATURN_REPO_URL`)                     |
| `SATURN_ADO_REPO_NAME`            | from `SATURN_REPO_URL` | repository name (required if no `SATURN_REPO_URL`)             |
| `SATURN_ADO_REPO_ID`              | repo name              | repository GUID (optional; the name works without it)          |
| `SATURN_CLONE_URL`                | derived                | explicit clone URL (optional)                                  |
| `SATURN_CLONE_DIR`                | `<deploy>/repo/<repo>` | managed clone location                                         |
| `SATURN_OWNER`                    | git `user.email`       | identity allowed to Start/Stop the agent                       |
| `SATURN_FEEDBACK_URL`             | local dashboard        | base URL of the feedback page (set when hosted)                |
| `SATURN_MODEL`                    | `claude-opus-4.8`      | Copilot CLI model                                              |
| `SATURN_DEPLOY_DIR`               | `C:\saturn` (Win)      | deploy output directory                                        |
| `SATURN_ENV_FILE`                 | (auto-discovered)      | explicit path to the `.env` file                               |
| `SATURN_BUG_AREA_PATH`            | (ownership.json)       | fallback ADO area path when a file has no `ownership.json`     |
| `SATURN_BUG_ITERATION_PATH`       | ADO default            | iteration override for filed audit bugs                        |
| `SATURN_BUG_TYPE_ROUTES`          | —                      | JSON per-type area-path alternatives (e.g. a11y team)          |
| `SATURN_BUG_TAGS`                 | —                      | extra tags on every audit bug (on top of `SaturnAudit`)        |
| `SATURN_AUDIT_AUTO_CREATE`        | `false`                | default the audit auto-file-bug toggle on                      |
| `SATURN_AUDIT_CLOSE_AFTER_SWEEPS` | `2`                    | missed sweeps before a resolved finding's bug is auto-resolved |
| `SATURN_AUDIT_BATCH_FILES`        | `6`                    | files per multi-turn audit batch                               |

See [docs/get-started.md](docs/get-started.md) for the full list and examples.

## Scripts

- `npm run build` — typecheck (`tsc --noEmit`)
- `npm test` — unit tests (jest)
- `npm run lint` — eslint
- `npm run saturn` — run the dashboard locally (via `tsx`)
- `npm run review` — one-shot CLI review (`--help` for flags)
- `npm run deploy` — bundle (esbuild) to `SATURN_DEPLOY_DIR` and register Windows logon autostart

## Deploy

`npm run deploy` produces self-contained `saturnDashboard.cjs` / `saturn-cli.cjs` bundles (with `zod` inlined) plus a hidden launcher, fully independent of this source tree. For a multi-user, hosted dashboard with real per-user identity, host it behind Azure AD (App Service / Container Apps EasyAuth) and set `SATURN_OWNER` + `SATURN_FEEDBACK_URL`. See [docs/architecture.md](docs/architecture.md).

## Responsible AI

Saturn is an AI agent built on the GitHub Copilot CLI. Its review comments, audit findings, and code changes
are **AI-generated and may be incomplete or incorrect** — they are best-effort assistance, not a sign-off, and
a human reviews and merges every change. Saturn analyzes **code and engineering artifacts only**; it is **not**
a people-analytics tool and must not be used to evaluate, score, or rank individuals. See
[TRANSPARENCY.md](TRANSPARENCY.md) for intended uses, limitations, data handling, and responsible-use guidance.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor
License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your
contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and
decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot.
You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Security

Please do not report security vulnerabilities through public GitHub issues. See [SECURITY.md](SECURITY.md) for how
to report them to the Microsoft Security Response Center (MSRC).

## License

Licensed under the [MIT License](LICENSE).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft
sponsorship. Any use of third-party trademarks or logos are subject to those third-party's policies.
