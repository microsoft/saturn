# saturn - TODO

Pending work and known follow-ups. (Completed items are removed; see git history / docs for what shipped.)

## Configuration & hosting

- **Corporate-network reachability / multi-user hosting.** Host the bundle behind Azure AD EasyAuth (App Service /
  Container Apps) so corporate-network users can view + give feedback while Start/Stop stays owner-only; persist
  `~/.saturn/` across restarts. (A cloud-hosted dev VM is typically not inbound-reachable, and reaching the dashboard
  on the LAN needs the port opened in the host firewall.)


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

## Chat + conversational design / feature-building agent — follow-ups

Shipped: a **React** Chat tab (self-hosted React 18 UMD) with a conversation list, a message thread, and an
**on-demand, resizable** design-doc panel (opens only when you click to view a design doc; draggable
splitters); **server-streamed** replies over SSE with **live chain-of-thought** — the design agent runs the
Copilot CLI in JSONL event mode (`--output-format json --stream on`), so the model's reasoning, MCP
connections, and tool activity (reading / searching / editing files) stream into a **collapsible CoT panel**
that folds into an accordion once the answer starts streaming token-by-token; a **dedicated quick-LLM call**
generates the conversation title as soon as a chat starts (and never re-titles an already-titled chat); the
prompt composer accepts up to **~1 MB**; **delete conversation**; an
**intent-based** design agent (no PM/spec toggle — it infers whether the requester is technical and asks
clarifying questions); **cross-session memory** (a new chat reuses relevant prior design docs); and the
**feature-build pipeline** extending Code Autopilot from bugs to features (approved design → branch →
implement → **self-validate twice** → lint → PR, surfaced in chat + on the Code Autopilot tab). The dashboard
now uses the full screen width consistently across every tab (stable scrollbar gutter, no tab-switch shift),
and the design-doc panel becomes a full-height overlay on narrow screens instead of crushing the conversation
thread; the doc panel offers **Copy markdown** (clipboard) and every served/exported doc carries a **"Created
by Saturn"** watermark. For non-owner (devtunnel) viewers the tab is **read-only** — they can read and export
design docs, but only the owner can chat, approve, and build (server-enforced). All Builder Autopilot calls
run **opus-4.8 at max reasoning effort with the largest (~1M) context window**, and the design + feature-build
agents **create a persisted todo list** (under `~/.saturn/chat/plans/`, outside the repo) and **iterate until
it is done** (via the CLI's `--max-autopilot-continues` loop). Remaining follow-ups (not done):

- **Saturn-orchestrated iteration + plan UI.** "Iterate until the todo list is done" currently relies on the
  Copilot CLI's `--max-autopilot-continues` (the model auto-continues within one invocation) plus a persisted
  plan; Saturn does not yet run its own multi-pass loop that re-invokes the model per pending item, and
  per-item "done" tracking is coarse (a whole-plan `complete` flag). Follow-ups: a Saturn-level continue-loop
  with per-item progress, and surfacing the todo checklist (from `~/.saturn/chat/plans/`) live in the UI.
- **Title generation effort.** The dedicated title call still runs at low effort (kept fast) rather than max —
  a deliberate exception to the "max thinking for all calls" default; make it configurable if desired.

- **Remove the legacy vanilla chat JS.** The pre-React chat script still ships inside the dashboard HTML
  template literal as inert (unused) code — only `chatEsc` + `loadFeatureBuilds` are still needed. Delete the
  rest. (Left in place deliberately: editing that large template-literal string is risky and a bad edit can
  silently break the whole dashboard script; remove it carefully with a browser smoke-test.)
- **Chain-of-thought polish.** The live CoT streams the model's **raw reasoning** verbatim, which can be
  verbose — consider summarizing / rate-limiting reasoning lines. Also the narration-vs-answer split is a
  heuristic (text streamed before a `tool.execution_start` is treated as narration and reset), so an answer
  interleaved with a final tool call can briefly reset before the authoritative reply on `done` corrects it.
- **Dedicated title call cost.** New conversations now fire a **separate** low-effort Copilot call just for the
  title (so it appears immediately, decoupled from the main turn). That is an extra CLI invocation per new
  chat; revisit if cost/latency matters (e.g. derive the title from the main turn's first tokens instead).
- **Automated tests.** `chatStore`, `designAgent`, `featureBuild`, `chatService`, `markdownRender`, and the
  SSE stream endpoint (incl. the new **JSONL CoT parser** + `[[META]]` hold-back) have no unit tests yet — add
  coverage (store round-trips, JSON-parse fallbacks, the safe-markdown renderer, option-selection, the
  twice-validate gate, SSE framing, and event→CoT/delta mapping).
- **Feature-build PR monitoring.** Unlike the bug-fix loop, a feature build opens the PR and stops; it does not
  address review/build feedback or clean up the branch afterward. Add monitoring (reuse the fix monitor) or an
  explicit "address feedback" action from chat.
- **Build-trigger authorization + MCP write-tool denial.** Approve-&-build is now gated by a confirmation
  dialog, but that is client-side only and the endpoint is still reachable by any (Microsoft-authenticated)
  viewer with only the requester recorded — once EasyAuth lands, gate builds to the owner/devs and enforce it
  **server-side**. Separately, the feature-BUILD and Code-Autopilot model calls still run with the ADO/GitHub
  MCP reachable (they need MCP reads); deny the MCP *write* tools (create/update PR, work item, issue) so only
  Saturn's REST code ever creates those. (The read-only design agent is already fully MCP-denied.)
- **Richer cross-session memory.** Retrieval is keyword/`LIKE`-based over artifact title+body; consider FTS5 or
  embeddings for better recall, and include prior chat messages (not just design docs).
- **Chat store retention.** `chat.db` (conversations/messages/artifacts/feature_builds) grows unbounded — add a
  retention/prune policy like the audit store needs.
- **Downloaded-HTML size.** Offline HTML downloads inline the full mermaid bundle (~3.4 MB) so diagrams render
  without a network; revisit if a lighter self-contained diagram option becomes available.
- **Dependency audit.** Adding `mermaid` + `react`/`react-dom` introduced one moderate `npm audit` advisory
  (transitive) — review and resolve or document it.
- **Textarea polish.** The composer is a fixed 2-row textarea (Enter sends, Shift+Enter newlines); add
  auto-grow up to a max height for longer prompts.
- **Export design doc to Loop (parked — feasibility done, blocked on environment).** LWS exposes
  `POST /v0.1/workspaces/{workspaceId}/pages` (title + `content:{type:'raw', value:<markdown>}`; markdown
  auto-converts to Loop content), and the signed-in `az` user already holds the delegated scope
  `LoopWorkspaces.ReadWrite.All` (plus a SharePoint token). Not built because the service isn't reachable from
  the host today: the token audience `api.loop.cloud.microsoft` has no A record and the `.com` data host fails
  a TLS cert-principal check (needs corpnet/VPN or the correct gateway host), and it's unconfirmed whether LWS
  accepts the Azure-CLI delegated token (client allowlist) vs. needing a registered app / pftpop allowlist
  entry. When unblocked: add a conditional **Export to Loop** button — shown only when an LWS base URL is
  configured and `GET /v0.1/health/ready` succeeds — that posts the doc's title + markdown and links the new
  Loop page back into the chat.

## Setup installer & multi-repo

Shipped (single-repo): a **web setup installer** — when Saturn is unconfigured the dashboard serves a Setup
page (and `/setup` is always available to reconfigure). It configures the **Azure DevOps repo URL + default
branch**, an **LLM provider** (pluggable; GitHub Copilot CLI today via `llmProvider.ts`), the **model**
(provider list + custom entry), and **thinking effort** (Copilot: none…max, defaults to the highest). Context
size shows **"Model default"** for Copilot (the CLI has no context-window control) and is ready to become a
real dropdown for API providers. Save writes a persisted config (`~/.saturn/saturn.config.json` via
`writeSaturnConfig`), then the process re-execs so the new repo coordinates take effect. `config.ts` no longer
throws when unconfigured (`isSaturnConfigured()`), and the review/autopilot entrypoints exit with a clear
message until setup is done. A `SATURN_HOME` instance-root helper (`saturnHome()`) was added as the isolation
foundation.

Not done — **multi-repo** (deferred, to be discussed):

- **Route ALL data dirs through `saturnHome()`.** Today `fixStore`/`chatStore`/`auditStore`/review dirs still
  use `~/.saturn/<area>` and clones use `C:\saturn\fix-repo|feature-repo`. For true per-repo isolation every
  store, clone, working dir, and memory path must derive from `saturnHome()` so `SATURN_HOME=<instance>` fully
  separates an instance (own DBs, files, memory, working dirs, config). **Nothing shared.**
- **Per-repo processes + supervisor.** Each repo runs as its own set of processes (dashboard/review/audit/
  autopilot) with its own `SATURN_HOME`, `SATURN_CONFIG_FILE`, and `SATURN_PORT`. Add a supervisor to
  spawn/monitor/stop instances and a per-instance port allocation.
- **"Add repository" UI.** A settings menu in the dashboard to register another repo (local or on a remote
  host) and launch its instance; an aggregated multi-repo view.
- **Provider expansion.** Real OpenAI / Anthropic / Azure OpenAI providers (API keys, live model listing, and
  selectable context sizes) behind the existing `llmProvider` interface.

