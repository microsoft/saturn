# Get started — run Saturn against your repo

Saturn reviews pull requests, audits your whole codebase, fixes assigned bugs, and (on request) designs and builds features in any **Azure DevOps** repository — you point it at a repo without changing code.

> **Quickest start:** you can skip hand-editing `.env`. Install the prerequisites (below), run `npm run saturn`, and open <http://localhost:6789> — when Saturn is not configured yet it serves a **setup page** that walks you through the repository URL + branch, the model provider, the model, and the reasoning effort, then restarts itself. Visit **`/setup`** anytime to reconfigure. The environment-variable route below is the equivalent, and is what a headless / hosted deployment uses.

## 1. Prerequisites

- **Node.js 20+**.
- **git** that can clone the target repo over **HTTPS headlessly** (the OS credential manager / Git Credential Manager must already have working credentials — run a manual `git clone` once to prime them).
- **Azure CLI** logged in (`az login`) — Saturn mints a fresh ADO token from it when a cached git credential is rejected (401).
- **GitHub Copilot CLI** installed and logged in — this is the model behind every agent. Install it with `npm install -g @github/copilot`, then run `copilot` once to sign in (a GitHub Copilot subscription is required). Verify with `copilot --version`; see [GitHub's Copilot documentation](https://docs.github.com/copilot). If it lives in a non-standard location, point Saturn at it with `COPILOT_CLI_PATH`.

Saturn shells out to all three; none are bundled, and none are tied to a specific repo.

## 2. Install

```bash
npm ci
cp .env.example .env   # then fill in your repo's coordinates (step 3)
npm run build   # typecheck
npm test
```

## 3. Point it at your repository

Edit your `.env` (copied from [`.env.example`](../.env.example) in step 2); Saturn loads it automatically. The simplest setup is **just the repo URL and a branch** — Saturn parses the org/project/repo from the URL (no repository GUID needed; the REST API accepts the repo name):

```dotenv
SATURN_REPO_URL=https://dev.azure.com/contoso/MyProject/_git/my-repo
SATURN_ADO_DEFAULT_BRANCH=main
```

Real environment variables take precedence over `.env`. Variables (with examples):

| Variable                    | Example                                                | Notes                                                          |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `SATURN_REPO_URL`           | `https://dev.azure.com/contoso/MyProject/_git/my-repo` | **the repo to review** (org/project/repo parsed from it)       |
| `SATURN_ADO_HOST`           | `dev.azure.com`                                        | REST host                                                      |
| `SATURN_ADO_ORG`            | `contoso`                                              | organization                                                   |
| `SATURN_ADO_PROJECT`        | `MyProject`                                            | project                                                        |
| `SATURN_ADO_REPO_ID`        | `00000000-0000-0000-0000-000000000000`                 | repository GUID (see below)                                    |
| `SATURN_ADO_REPO_NAME`      | `my-repo`                                              | repository name                                                |
| `SATURN_ADO_DEFAULT_BRANCH` | `main`                                                 | branch tracked for review context (default `master`)           |
| `SATURN_CLONE_URL`          | `https://dev.azure.com/contoso/MyProject/_git/my-repo` | optional; derived from host/org/project/repo when unset        |
| `SATURN_OWNER`              | `you@contoso.com`                                      | the only identity allowed to Start/Stop                        |
| `SATURN_MODEL`              | `claude-opus-4.8`                                      | Copilot model - use the best your plan offers (see note below) |
| `SATURN_ENABLE_FEEDBACK`    | `false`                                                | feedback page + comment feedback links (default off)           |
| `SATURN_OPT_OUT_AUTHORS`    | `Jane Doe,John Smith`                                  | comma-separated PR author display names to skip                |
| `SATURN_REVIEW_ALLOWLIST`   | `jdoe,jsmith`                                             | comma-separated aliases/emails; empty = review all, else only PRs authored by or with a reviewer matching an entry |
| `SATURN_FEEDBACK_URL`       | `https://saturn.contoso.com/feedback`                  | feedback page base URL (only when feedback is enabled)         |

> **Model choice matters most.** Saturn is only as good as the model doing the review - pick the most capable model your Copilot plan offers (the top Claude/GPT tier), as if your most senior engineer reviewed every PR. A weaker model yields weaker reviews.
>
> **Backup model + reasoning effort.** All three agents run the primary `SATURN_MODEL` (default `claude-opus-4.8`) at the strongest reasoning effort (`SATURN_REASONING_EFFORT`, default `max`). If the primary is reported "not available" — or fails `SATURN_MODEL_FAILURE_THRESHOLD` times in a row (default **3**) — they switch to `SATURN_BACKUP_MODEL` (default `claude-opus-4.5`) until the process restarts. Some models (including the opus-4.5 backup) have a fixed reasoning level and reject an effort setting; Saturn detects that and automatically retries the call without `--effort`.

### Setting the coordinates individually (advanced)

Instead of `SATURN_REPO_URL` you can set `SATURN_ADO_ORG`, `SATURN_ADO_PROJECT`, and `SATURN_ADO_REPO_NAME` (and optionally `SATURN_ADO_HOST`, or `SATURN_ADO_REPO_ID` to pin the repository GUID, or `SATURN_CLONE_URL` for a non-standard clone URL). Any of these override the values parsed from `SATURN_REPO_URL`. The GUID is optional — the REST API accepts the repository name.

## 4. Run locally

```bash
npm run saturn      # starts the dashboard at http://localhost:6789
```

Open the dashboard and click **Start**. Saturn clones the repo into a managed location (`SATURN_CLONE_DIR`, default under the deploy dir), then reviews active PRs. It runs in **dry-run by default** from the CLI; the dashboard always posts.

The dashboard opens on the **Dashboard** tab — an all-visual overview of both agents (sweep progress, finding/severity/category charts, and review trends + hotspots) aimed at leadership and managers. Switch to **PR review** or **Codebase audit** for the detailed, filterable lists, and start the codebase auditor from the **Codebase audit** tab's **Start audit** button.

### One-shot review (CLI)

```bash
npm run review -- --help
npm run review -- --pr 12345            # dry-run a single PR (prints, posts nothing)
npm run review -- --pr 12345 --post     # review and post
```

### Run the other agents

Saturn runs four agents, all reachable from the dashboard:

- **PR review** — click **Start** (or `npm run review` for a one-shot, above).
- **Codebase audit** — open the **Codebase audit** tab and click **Start audit**.
- **Builder Autopilot** — open the **Builder Autopilot** tab and describe what you want to design or build. It is **on-demand** (no background loop) and only calls the model when you send a message: it researches the codebase read-only, drafts a design doc, and — after you **explicitly approve** — builds the feature as a PR (reusing Code Autopilot's pipeline, so the same push / PR access applies).
- **Code Autopilot** — the standalone loop that turns assigned audit bugs into pull requests; see below.

**Code Autopilot** runs continuously in its own dedicated clone (it does not need the review or audit agents):

```bash
npm run fix            # see `npm run fix -- --help` for all options
```

Common options (all optional):

| Variable                  | Default   | Meaning                                            |
| ------------------------- | --------- | -------------------------------------------------- |
| `SATURN_FIX_CATEGORY`     | `accessibility` | audit category to draw bugs from             |
| `SATURN_FIX_MAX_PHASE`    | `1`       | 1 = single file, 2 = single package, 3 = anything  |
| `SATURN_FIX_MAX_OPEN_PRS` | `1`       | open PRs kept in flight at once                    |
| `SATURN_FIX_POLL_MINUTES` | `10`      | how often it checks its PRs + considers a new fix  |
| `SATURN_FIX_DRY_RUN`      | `false`   | generate + commit locally, never push or open a PR |
| `SATURN_FIX_TIMEOUT_MS`   | `1800000` | per model-call timeout (30 min)                    |

**Builder Autopilot** options (all optional): `SATURN_CHAT_EFFORT` (default `max`), `SATURN_CHAT_TIMEOUT_MS` (30 min), `SATURN_CHAT_RETENTION_DAYS` (`90`), `SATURN_MAX_CONTINUES` (`50`), `SATURN_CONTEXT_TIER` (`long_context`). An optional **Export to Loop** button appears only when `SATURN_LOOP_BASE_URL` + `SATURN_LOOP_WORKSPACE_ID` are set and the Loop service is reachable.

## 5. Deploy (always-on)

```bash
npm run deploy
```

This bundles `saturnDashboard.cjs` / `saturn-cli.cjs` into `SATURN_DEPLOY_DIR` (default `C:\saturn` on Windows) and, on Windows, registers a hidden logon autostart. The dashboard starts **stopped** — open it and click Start.

For a **multi-user, corpnet-hosted** dashboard (others can view, only you can Start/Stop), host the bundle behind Azure AD (App Service or Container Apps **EasyAuth**) and set `SATURN_OWNER` to your identity. Feedback is **off by default** (`SATURN_ENABLE_FEEDBACK`) until signed-in attribution is wired up; when enabled, set `SATURN_FEEDBACK_URL` to the hosted `/feedback` URL. See [architecture.md](architecture.md).

## 6. Troubleshooting

- **"Saturn is not configured"** — finish the setup page (or set `SATURN_REPO_URL` + `SATURN_ADO_DEFAULT_BRANCH` in `.env`), then restart.
- **Copilot CLI not found** — make sure `copilot --version` works in the same shell; if it is installed in a non-standard location, set `COPILOT_CLI_PATH` to its launcher.
- **Clone or push fails (401/403)** — prime git once with a manual `git clone` of the repo over HTTPS, and make sure `az login` succeeds — Saturn mints a fresh Azure DevOps token from the Azure CLI when a cached git credential is rejected.
- **Reviews look shallow / the model badge shows the backup** — the primary model was unavailable or failed repeatedly; pick the most capable model your Copilot plan offers via the setup page or `SATURN_MODEL`.
