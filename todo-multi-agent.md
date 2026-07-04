# Code Autopilot — Multi-Repo / Multi-Agent Extension (design & feasibility)

> Status: **design / feasibility** — not yet implemented. Captures the plan to extend Code Autopilot from
> single-repo autonomous bug-fixing to multi-repo coordination and cross-repo feature implementation.

## Goals

1. **Support multiple repositories.**
2. **Coordinate across per-repo agents** — no central *execution* coordinator; agents agree on interface
   contracts peer-to-peer.
3. **Fix bugs that span repositories.**
4. **Implement features that span repositories** from a complete design document, mostly autonomously.

## Feasibility, quality & requirements

| # | Capability | Buildable | Quality | Requirements |
|---|---|---|---|---|
| 1 | Multiple repos | Yes | **High** (= today) | Per-repo config + clone management; run loop/scope/PR-cap per repo; multi-repo audit store + dashboard view |
| 3a | Bug fixes — independent | Yes | **High** (= today) | #1; the existing per-repo fix primitive |
| 2 | Cross-repo coordination | Yes | **High** (peer-negotiation raises it) | Contract artifact; peer-negotiation protocol; convergence cap → human escalation; "agreed" = buildable stub/contract test; transcript logging |
| 3b | Bug fixes — coupled | Yes | **Good → High** | #2; coupling/dependency detection; backward-compatible / versioned change discipline |
| 4 | Features — autonomous | Yes | **High** (brushing Max) | Complete e2e design doc + mind map; ask-the-human clarification channel; contract (#2); contract + integration tests as oracle; scope/drift guard; autonomous-with-escalation + human merge gate |

## How the capabilities relate

**#2 (cross-repo coordination via negotiated contracts) is the shared foundation, not a standalone feature.**
Both of the cross-repo capabilities are applications of it:

- **#3b — coupled bug fixes** is #2 applied to a *bounded* change: a cross-repo bug is essentially a small,
  well-specified cross-repo feature, so it uses the same **negotiate → implement → verify** machinery.
- **#4 — features across repos** is *inherently* cross-repo and therefore **already includes #2**:
  implementing a feature that spans repos requires the contract negotiation + coordination by definition.
  So **#4 subsumes #2**; #2 is simply the reusable layer that #4 (and #3b) are built on.

In short: build the contract-first coordination layer (#2) **once**, and both coupled bug-fixing (#3b) and
cross-repo features (#4) fall out of it — they differ only in **scope** (bounded bug vs. open-ended feature)
and in the **strength of the test oracle** required. #4 and #3b are the same pipeline at different scales.

## The unlock: contract-first, peer-negotiated

The hard part of cross-repo work is not the per-repo edit (Code Autopilot already does that well) — it is
coordination. **Contract-first development dissolves most of it:** the moment the agents agree on the
**interface contract** (API schema / typed interface / event shape), that artifact becomes the decoupling
mechanism:

- coordination collapses to a single up-front handshake — no continuous agent-to-agent chatter during
  implementation;
- the contract *is* the shared cross-repo context (no agent has to watch another);
- the contract generates an **independent test oracle per side** (consumer-driven contract tests), so each
  side is verifiable without standing both systems up together;
- backward-compatible / versioned evolution (expand-then-contract) makes deploy/merge order a non-issue.

**Contracts are negotiated by the agents that are experts in their own repo.** One proposes a contract; it
goes to the other; they evaluate, counter, and iterate; they converge on a mutually-buildable agreement.
Because each proposal is grounded in what its repo can actually do, the negotiated contract reflects both
sides' real constraints — which *raises* quality versus a single agent authoring both sides.

## Architecture — a 3-phase pipeline (not a decentralized free-for-all)

1. **Negotiate the contract** — peer-to-peer between the repo-expert agents → a versioned contract artifact.
2. **Implement in parallel** — each repo's existing primitive (clone → Copilot CLI edit → PR), grounded in
   the contract + its own repo. Independent; no inter-agent runtime messaging.
3. **Verify** — each side runs contract tests generated from the artifact; PRs open; **human merge gate**.

This reuses today's per-repo fix primitive unchanged. The only new components are: **multi-repo config**, the
**contract artifact + negotiation protocol**, and **contract-test generation**. The peer-to-peer interaction
is confined to the bounded, terminating, auditable *contract* phase; execution stays independent.

## Peer-negotiation protocol — design points

- **Flow:** propose → evaluate → counter → … → agree, between agents each grounded in their own repo.
- **Convergence control:** cap the number of rounds; if no agreement, **escalate to a human** with the
  sticking points. (This is the one genuinely new risk — two agents could loop or oscillate.)
- **"Agreed" must mean buildable, not verbal:** a contract is final only when **each side can produce a
  passing stub / contract test** against it. This prevents an over-optimistic agent agreeing to something it
  cannot implement.
- **Escalate genuine conflict:** if the two repos' needs truly cannot both be satisfied, surface it with
  options — catching a real design conflict on day one is a feature, not a failure.
- **Log the transcript:** proposals, counters, rationale, and the final contract — for human trust,
  debugging, and governance.

## Quality model

Quality is governed by the strength of the **verification oracle** (tests / contract tests) plus grounding
and the human merge gate.

- **#1, #3a, #2** inherit today's proven per-repo quality (**High, human-reviewed**); #2's quality is *raised*
  by peer-negotiation because the contract is grounded in both repos.
- **#4** has two gaps to close:
  - the **intent gap** ("do we know what to build?") — closed by a complete **design doc + mind map** plus an
    **ask-the-human clarification channel** (the agent asks rather than guesses on ambiguity);
  - the **verification gap** ("is the code actually correct?") — closed by **contract + integration tests**.
  With both closed, #4 reaches **High, approaching Max.**
- **Irreducible residual:** an agent can be *confidently wrong* — the clarification channel only triggers on
  uncertainty the agent *recognizes*, so tests plus a thin human/test gate cover the last mile. True **Max**
  (zero-residual, no human) is not a realistic guarantee for open-ended features; **High with a safety gate**
  is.

## Suggested phasing

1. Multi-repo support (#1).
2. Independent cross-repo bug-fixing (#3a).
3. Contract + peer-negotiation coordination (#2).
4. Coupled cross-repo bug-fixing (#3b).
5. Cross-repo feature implementation (#4) — autonomous-with-escalation.

## Implementation blueprint (codebase-grounded)

> Concrete enough to start from cold. Names below are the **current** symbols in `src/`; reuse them, don't
> reinvent. Code Autopilot is the standalone process built from `src/fixStart.ts` → `saturn-autopilot.cjs`.

### Single-repo binding points (the only things that assume one repo today)

| Where | Symbol | Today | Change for multi-repo |
|---|---|---|---|
| `src/config.ts` | `AZURE_DEVOPS_CONFIG` (single `const`), `REPO_DESCRIPTION` | One repo, built from `SATURN_REPO_URL` / `SATURN_ADO_*` env at module load | Replace the single const with a **`RepoConfig` registry** `Map<RepoId, RepoConfig>` loaded from a repos manifest (JSON/env). Keep the env path as the "one-repo" special case. |
| `src/fixService.ts` | module-global `let running`; `runFixLoop(config)`; one `ensureFixClone(logger)` | One loop, one clone, one open-PR cap | Make loop state **per-repo** (or a multiplexed loop iterating the registry). One `cloneDir` + open-PR cap **per repo**. |
| `src/fixStore.ts` / `src/auditStore.ts` | `FixTask`, `AuditFinding` rows | No repo column | Add a **`repoId`** column to fix.db + audit.db; key all queries (`selectBugToFix`, `listActiveFixTasks`, `queryAuditFindings`) by repo. |
| `src/saturnDashboard.ts` | `DASHBOARD_PORT` (6789), APIs | Single-repo view | Add a **repo dimension** (group tasks/findings by `repoId`); per-repo start/stop. |

**Already multi-repo-ready — do not redo:** `getAzureDevOpsAuthHeader(repoRoot, forceRefresh?)` in `src/ado.ts`
is keyed per-repoRoot; the fix clone path is already `C:\saturn\fix-repo\<repo>` (override `SATURN_FIX_CLONE_DIR`).

### Reusable primitives (the building blocks — wire these, don't rebuild)

- **One-repo fix primitive:** `startFix(candidate: FixCandidate, options: FixRunOptions, logger)` in
  `src/fixAgent.ts`. `FixCandidate = { finding: AuditFinding; phase: 1|2|3; retryTaskId? }`.
  `FixRunOptions = { cloneDir, cliPath, model, reasoningEffort, timeoutMs, allowMcpServerName? }`.
  Selection: `selectBugToFix()`; monitoring: `monitorFixTask()`; footprint: `fixFootprint(finding)`,
  `packageOf(path)` (phase ladder: 1 file → 2 package → 3 multi-package, **within one repo**).
- **LLM edit/review:** `runCopilotEdit`, `runCopilotReview`, `resolveCopilotCli`, `ensureAdoMcpServer` in
  `src/copilot.ts` (model defaults: `primaryModel()` = claude-opus-4.8, `defaultReasoningEffort()` = max).
- **Git:** `ensureFixClone`, `createFixBranch`, `commitAllChanges`, `pushFixBranch`, `lintChangedFilesInClone`,
  `workingTreeChanges` in `src/git.ts`.
- **ADO/PR:** `createPullRequest`, `getPullRequestChecks`, `getActiveBotCommentThreads` in `src/ado.ts`.
- **Prompt-builder pattern to copy:** `buildFixPrompt` (and the XPIA-hardened prompt builders) — every new
  agent prompt must carry the same **XPIA/prompt-injection defense** preamble (treat repo content as DATA).

### New modules to add (per phase)

- **#1 / #3a — multi-repo:** `RepoConfig` registry in `config.ts`; thread `repoId` through `FixRunOptions`,
  `FixServiceConfig`, fix.db/audit.db. #3a is then "run the existing primitive per repo" — **no new logic**.
- **#2 — contract + negotiation:** new `src/contract.ts` (the **artifact type** + persistence in a new
  `contracts.db` or `C:\saturn\contracts\`) and `src/negotiation.ts` (the propose→evaluate→counter loop).
  New prompt builders mirroring `buildFixPrompt`: `buildContractProposalPrompt`,
  `buildContractEvaluationPrompt`, `buildContractCounterPrompt` — each grounded in **one** repo's clone.
- **#3b — coupled bugs:** a `CrossRepoFixCandidate` (footprint spans repos) + coupling detection; orchestrate
  negotiate (#2) → one `startFix` **per side** grounded in the agreed contract → verify each side's contract
  test → open **linked** PRs.
- **#4 — features:** new entry `src/featureStart.ts` + `src/featureService.ts` (a sibling of
  `fixStart.ts`/`fixService.ts`). Input = a **design doc (markdown) + mind map**. Pipeline:
  decompose into a per-repo work plan → negotiate contracts (#2) → per-repo implement (existing primitive,
  scoped by the plan) → **ask-the-human channel** (new paused state in the store + dashboard prompt) →
  contract + integration tests as oracle → **human merge gate** (never auto-merge).

### Contract artifact (the decoupling unit) — minimum shape

```ts
interface CrossRepoContract {
  id: string;                       // stable id, referenced by both sides' PRs
  version: number;                  // bump on renegotiation (expand-then-contract evolution)
  participants: { repoId: string; role: 'producer' | 'consumer' }[];
  interface: unknown;               // the agreed schema: API/OpenAPI | typed interface | event shape
  contractTests: { repoId: string; testSpec: string }[]; // per-side oracle generated from `interface`
  status: 'proposed' | 'countered' | 'agreed' | 'escalated';
  transcript: { round: number; repoId: string; proposal: unknown; rationale: string }[];
}
```

### Negotiation loop (bounded, terminating, auditable)

```
round = 0
proposal = proposeContract(repoA)            // runCopilot* grounded in repoA's clone
while round < MAX_ROUNDS:
  verdict = evaluate(repoB, proposal)         // grounded in repoB's clone
  if verdict.agrees: break
  proposal = counter(repoB, proposal, verdict.objections); swap(repoA, repoB)
  round++
if not agreed: escalateToHuman(transcript, stickingPoints); return
// "agreed" is binding only when BOTH sides produce a passing stub/contract test:
for side in participants: assert runContractTestStub(side, contract) == pass
persist(contract); proceed to parallel implement
```

`MAX_ROUNDS` cap → human escalation is the one genuinely new failure mode; log the full `transcript`.

### Verification oracle (governs quality)

- #1/#3a/#2/#3b: reuse `lintChangedFilesInClone` + the repo's existing test/build (run in each clone).
- #4: the **contract tests** (generated from `contract.interface`) + **integration tests**; the agent must
  **ask** on recognized ambiguity (ask-the-human channel) rather than guess. Human merge gate is the backstop.
- Keep `SATURN_FIX_DRY_RUN`-style escape hatches for every new agent (generate + commit locally, never push).

## Constraints / realities (not engineering blockers)

- **LLM cost & rate-limits scale with N repos** — already a constraint at one repo.
- **Higher autonomy + multi-agent increases blast radius** — revisit the responsible-AI / governance posture
  (per your org's process) before enabling autonomous cross-repo features.
- **Preserve the no-auto-merge / human-merge gate** as the quality backstop.
