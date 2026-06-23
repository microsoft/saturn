# saturn - TODO

Pending work and known follow-ups. (Completed items are removed; see git history / docs for what shipped.)

## Configuration & hosting

- **Corpnet reachability / multi-user hosting.** Host the bundle behind Azure AD EasyAuth (App Service /
  Container Apps) so corpnet users can view + give feedback while Start/Stop stays owner-only; persist
  `~/.saturn/` across restarts. (A Cloud PC is typically not inbound-reachable, and reaching the dashboard
  on the LAN needs the port opened in the host firewall.)

## Release / maintenance

- **Open-source release — finish in the OSPO portal.** `microsoft/saturn` now carries the MIT `LICENSE`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, and README **Contributing / Security / Trademarks**
  sections (`package.json` declares `license: MIT`). The remaining steps are human-only via
  <https://repos.opensource.microsoft.com/orgs/microsoft/repos/saturn>: complete the OSS release business
  review, flip the repo to **public**, and enable the **CLA bot**.

## Feedback & access (planned)

- **Owner-only feedback view.** The owner can view submitted feedback in the dashboard; other (tunnel)
  viewers must not see it.
- **Feedback page links back to the dashboard.**
- **Per-comment thumbs up/down.** Each posted comment carries thumbs-up / thumbs-down icons that open the
  feedback page (via the devtunnel URL) with Helpful / Not-helpful preselected; store the feedback so the
  owner can see it in the dashboard. (Depends on authenticated attribution being in place.)
- Brittle opt‑out. Author opt‑out is by display‑name substring — fragile and spoofable; should key off a stable identity.

## Codebase audit agent — follow-ups

- **Gate viewer-writable actions + replace the alias box.** Filing a bug, editing area-owners, and now
  dismissing / recovering findings are all open to every viewer (devtunnel users included) to match the
  "anyone can file a bug" model, with inputs sanitized + bounded server-side. Dismissals are attributed via a
  free-text **alias box** (a stand-in until sign-in exists) plus a required reason, shown on the dismissed
  finding. Once authenticated hosting (EasyAuth) lands, replace the alias box with the logged-in identity and
  owner-gate or audit-log these mutations so findings can't be hidden — or the area→team map changed —
  anonymously.
- **Bug-filing routing visibility + assignee validation.** Filing now walks the area path up to the nearest
  valid ancestor (instead of dropping it) and keeps the package-owner assignee through area retries. Two
  follow-ups: (a) surface which ancestor a bug was actually filed under, so a stale leaf silently routing to
  a broad parent area is visible; and (b) when `ownership.json`'s first owner is a distribution list or
  non-ADO identity, ADO drops it and the bug lands unassigned — validate the identity (or fall back to a
  team alias) so findings don't silently go unowned.
- **Prune / retain the SQLite store.** Findings and the per-file scan index (`scanned_files`) now live in a
  local SQLite DB (`audit.db`) with indexed pagination + aggregates. Both grow as sweeps run; add a retention
  policy (drop long-resolved findings + stale scan rows, periodic `VACUUM`) so it stays bounded over months.
- **Sweep throughput — parallelism deferred.** Sweeps now cache the file enumeration per sweep and skip
  files whose content hash is unchanged since their last scan (incremental sweeps), so re-sweeps are cheap.
  The remaining lever — running batches concurrently / the two verify passes in parallel — is intentionally
  **not** done to avoid LLM rate-limit/instability; revisit only if a higher-throughput model path exists.
- **`node:sqlite` is experimental.** The store uses Node's built-in `node:sqlite` (no native dependency,
  bundles cleanly) which prints an experimental-feature warning and could change across Node majors; revisit
  if a Node upgrade changes the API.

## Code Autopilot — follow-ups

- **Pre-push build / type-check (not just lint).** The optional pre-push gate (`SATURN_FIX_PREPUSH_VALIDATE`)
  runs ESLint on the changed files plus a corrective model round so PRs start green. Extend it to a real
  `tsc` / `yarn build --to <changed package>` (needs path→package-name mapping; slower) so type/build errors
  are caught before the PR opens, not just lint.
- **Register the ADO service hook (ops step).** The receiver (`POST /api/hooks/ado`, guarded by
  `SATURN_WEBHOOK_SECRET`) and a registration script (`npm run register-ado-hook -- --url <public>/api/hooks/ado`)
  both exist. Remaining is the one-time ops step: run the script against the live tunnel URL with the secret
  and keep the tunnel reachable — otherwise Code Autopilot falls back to `SATURN_FIX_POLL_MINUTES`.
- **Hard phase enforcement.** The prompt instructs single-file (phase 1) scope and the dashboard shows the
  phase, but out-of-scope edits are not blocked. Follow-up: reject + retry (or down-scope) a change whose
  footprint exceeds the task's phase.
- **Context window is model-inherent.** The Copilot CLI exposes no context-window flag — each model uses its
  own full window (opus-4.8 / 4.5 are large). Revisit only if the CLI adds a window/truncation control.
- **Raise the open-PR cap after verification.** Currently pinned to **4** (`SATURN_FIX_MAX_OPEN_PRS=4`) while
  the agent is being verified and not yet released. Increase once its PRs are trusted.

