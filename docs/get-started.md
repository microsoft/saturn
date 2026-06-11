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
npm run build   # typecheck
npm test
```

## 3. Point it at your repository

Set these environment variables (defaults target office-bohemia):

| Variable               | Example                                     | Notes                                       |
| ---------------------- | ------------------------------------------- | ------------------------------------------- |
| `SATURN_ADO_HOST`      | `dev.azure.com`                             | REST host                                   |
| `SATURN_ADO_ORG`       | `contoso`                                   | organization                                |
| `SATURN_ADO_PROJECT`   | `MyProject`                                 | project                                     |
| `SATURN_ADO_REPO_ID`   | `00000000-0000-0000-0000-000000000000`      | repository GUID (see below)                 |
| `SATURN_ADO_REPO_NAME` | `my-repo`                                   | repository name                             |
| `SATURN_CLONE_URL`     | `https://contoso@dev.azure.com/.../my-repo` | optional; derived from the above when unset |
| `SATURN_OWNER`         | `you@contoso.com`                           | the only identity allowed to Start/Stop     |
| `SATURN_MODEL`         | `claude-opus-4.8`                           | Copilot CLI model                           |
| `SATURN_FEEDBACK_URL`  | `https://saturn.contoso.com/feedback`       | base URL of the feedback page when hosted   |

### Finding the repository GUID

```bash
az repos show --org https://dev.azure.com/<org> --project <project> --repository <repo> --query id -o tsv
```

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

For a **multi-user, corpnet-hosted** dashboard (others can view + give feedback, only you can Start/Stop), host the bundle behind Azure AD (App Service or Container Apps **EasyAuth**), set `SATURN_OWNER` to your identity and `SATURN_FEEDBACK_URL` to the hosted `/feedback` URL. See [architecture.md](architecture.md).
