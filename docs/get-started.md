# Get started — run Saturn against your repo

Saturn reviews pull requests in any **Azure DevOps** repository. It is configured entirely through environment variables, so you point it at a repo without changing code.

## 1. Prerequisites

- **Node.js 20+**.
- **git** that can clone the target repo over **HTTPS headlessly** (the OS credential manager / Git Credential Manager must already have working credentials — run a manual `git clone` once to prime them).
- **Azure CLI** logged in (`az login`) — Saturn mints a fresh ADO token from it when a cached git credential is rejected (401).
- **GitHub Copilot CLI** installed and logged in (`copilot`) — this is the review model. Verify with `copilot --version`.

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
| `SATURN_FEEDBACK_URL`       | `https://saturn.contoso.com/feedback`                  | feedback page base URL (only when feedback is enabled)         |

> **Model choice matters most.** Saturn is only as good as the model doing the review - pick the most capable model your Copilot plan offers (the top Claude/GPT tier), as if your most senior engineer reviewed every PR. A weaker model yields weaker reviews.

### Setting the coordinates individually (advanced)

Instead of `SATURN_REPO_URL` you can set `SATURN_ADO_ORG`, `SATURN_ADO_PROJECT`, and `SATURN_ADO_REPO_NAME` (and optionally `SATURN_ADO_HOST`, or `SATURN_ADO_REPO_ID` to pin the repository GUID, or `SATURN_CLONE_URL` for a non-standard clone URL). Any of these override the values parsed from `SATURN_REPO_URL`. The GUID is optional — the REST API accepts the repository name.

## 4. Run locally

```bash
npm run saturn      # starts the dashboard at http://localhost:6789
```

Open the dashboard and click **Start**. Saturn clones the repo into a managed location (`SATURN_CLONE_DIR`, default under the deploy dir), then reviews active PRs. It runs in **dry-run by default** from the CLI; the dashboard always posts.

### One-shot review (CLI)

```bash
npm run review -- --help
npm run review -- --pr 12345            # dry-run a single PR (prints, posts nothing)
npm run review -- --pr 12345 --post     # review and post
```

## 5. Deploy (always-on)

```bash
npm run deploy
```

This bundles `saturnDashboard.cjs` / `saturn-cli.cjs` into `SATURN_DEPLOY_DIR` (default `C:\saturn` on Windows) and, on Windows, registers a hidden logon autostart. The dashboard starts **stopped** — open it and click Start.

For a **multi-user, corpnet-hosted** dashboard (others can view, only you can Start/Stop), host the bundle behind Azure AD (App Service or Container Apps **EasyAuth**) and set `SATURN_OWNER` to your identity. Feedback is **off by default** (`SATURN_ENABLE_FEEDBACK`) until signed-in attribution is wired up; when enabled, set `SATURN_FEEDBACK_URL` to the hosted `/feedback` URL. See [architecture.md](architecture.md).
