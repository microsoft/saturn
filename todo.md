# Saturn — TODO

Future work and known follow-ups.

## Recently shipped

- **Iteration-aware re-review** — PR + latest iteration is the idempotency key, so a new push is
  re-reviewed and clean/unchanged PRs are skipped.
- **Configuration via `.env`** — Azure DevOps coordinates are loaded from a git-ignored `.env`
  (`config.ts` reads it; the deploy copies it next to the bundle); `.env.example` is the template.
- **Owner-only Start/Stop, reactive (Server-Sent Events) dashboard, and a per-comment feedback page.**

## Pending

- **Hosting for multi-user access.** Host the bundle behind Azure AD EasyAuth (App Service / Container
  Apps) so corpnet users can view and give feedback while Start/Stop stays owner-only. Persist
  `~/.saturn/` (e.g. an Azure Files mount) across restarts.
- **Configurable dashboard port.** `DASHBOARD_PORT` is a constant (6789); make it read
  `SATURN_DASHBOARD_PORT`.
- **LICENSE.** Add an MIT `LICENSE` before any public open-source release.
- **Exact per-PR working-tree context.** Optionally check out each PR's source branch in a throwaway
  worktree (never the user's tree) so the model sees each PR's exact surrounding code.
- **Precise changed-line anchoring.** Compute a unified diff (hunks with new line numbers) so inline
  comments anchor only to lines the PR actually changed.
- **Resilience.** Retries/backoff for transient Azure DevOps REST failures, and a per-run JSON summary
  artifact for deployment dashboards.
