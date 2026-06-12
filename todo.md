# Saturn - TODO

Pending work and known follow-ups.

## Review quality

- **Exact per-PR working-tree context.** Optionally check out each PR's source branch in a throwaway
  worktree (never the user's tree) so the model sees each PR's exact surrounding code.
- **Precise changed-line anchoring.** Compute a unified diff (hunks with new line numbers) so inline
  comments anchor only to lines the PR actually changed.
- **Startup model validation.** The model is pinned (`SATURN_MODEL`); optionally validate it against the
  Copilot CLI's available models at startup.
- **Per-run summary artifact.** Emit a per-run JSON summary for deployment dashboards. (Transient-failure
  retries/backoff already exist in `ado.ts`.)

## Configuration & hosting

- **Configurable dashboard port.** `DASHBOARD_PORT` is a constant (6789); make it read
  `SATURN_DASHBOARD_PORT`.
- **Multi-user hosting.** Host the bundle behind Azure AD EasyAuth (App Service / Container Apps) so
  corpnet users can view and give feedback while Start/Stop stays owner-only; persist `~/.saturn/` across
  restarts.

## Release

- **LICENSE.** Add an MIT `LICENSE` before any public open-source release.

## Feedback & access (planned)

- **Owner-only feedback view.** The owner can view submitted feedback in the dashboard; other (tunnel)
  viewers must not see it.
- **Feedback page links back to the dashboard.**
- **Per-comment thumbs up/down.** Each posted comment carries thumbs-up / thumbs-down icons that open the
  feedback page (via the devtunnel URL) with Helpful / Not-helpful preselected; store the feedback so the
  owner can see it in the dashboard. (Depends on authenticated attribution being in place.)
- **Start/Stop is owner-only** - hidden and rejected for non-owners. (Implemented; keep verified.)
