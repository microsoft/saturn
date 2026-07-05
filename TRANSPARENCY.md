# Saturn — Responsible AI Transparency Note

This note describes what Saturn does, what it is and is not intended for, and how to use it
responsibly. It complements the [README](README.md) and follows Microsoft's Responsible AI
principles (accountability, transparency, fairness, reliability & safety, privacy & security,
inclusiveness).

## What Saturn is

Saturn is an always-on, repo-agnostic autonomous engineering agent for Azure DevOps, built on the
**GitHub Copilot CLI**. It runs four cooperating agents:

- **PR Reviewer** — reviews active pull requests and posts inline review comments.
- **Codebase Auditor** — sweeps the checked-out codebase for security, privacy, correctness, and
  related issues and routes them to owning teams as bugs.
- **Code Autopilot** — opens and iterates pull requests to fix assigned bugs.
- **Builder Autopilot** — an on-demand conversational design agent that researches the codebase and
  drafts a design document; after a human explicitly approves it, it builds the feature as a pull request.

## How it works

- Saturn sends code, diffs, and pull-request / work-item context to a large language model via the
  GitHub Copilot CLI, and turns the model's output into review comments, audit findings, or proposed
  code changes.
- Outputs are **grounded**: review comments anchor to specific lines, audit findings deep-link to the
  source, and fixes are proposed as pull requests.
- Every posted comment is labeled as **automated and AI-generated** and carries a disclaimer that it
  is best-effort and **not** a sign-off.
- A **human reviews and merges every code change** — Saturn does not merge its own pull requests.

## Intended uses

- Assisting engineers by surfacing potential correctness, design, API, security, and privacy issues
  in pull requests.
- Auditing a codebase for security/privacy/quality issues and routing them to the owning team as bugs.
- Drafting candidate fixes as pull requests for human review.
- Use by an engineering team on code and Azure DevOps projects the operator is authorized to access.

## Unsupported / out-of-scope uses

- **Not a people-analytics or performance-management tool.** Saturn must **not** be used to evaluate,
  score, rank, or infer the performance, abilities, characteristics, emotional state, or attitudes of
  any individual. It analyzes code and engineering artifacts, not people.
- Not a substitute for human code review, security review, or formal sign-off.
- Not for use on code or systems the operator is not authorized to access.
- Not a guarantee that code is correct, secure, complete, or compliant.

## Limitations

- Outputs are **AI-generated and may be incomplete, inaccurate, or outdated** — always verify before
  acting on them.
- Coverage is best-effort and non-exhaustive; the **absence** of a finding does not mean code is
  issue-free.
- Quality depends on the underlying model and the context provided, and may vary across runs.

## Data, privacy, and security

- Saturn operates on code and engineering artifacts (pull-request diffs, work items) from the
  configured Azure DevOps repository.
- To perform its analysis, that content is sent to the **GitHub Copilot CLI** (the model provider),
  subject to Copilot's terms and data-handling practices.
- Saturn does **not** send telemetry to Microsoft. Local state (findings, feedback) is stored on the
  operator's machine under `~/.saturn/`.
- Access control: anyone who can reach the dashboard can view it and submit feedback or file bugs;
  only the owner can Start/Stop each agent (enforced server-side).

## Human oversight and control

- The owner starts and stops each agent.
- Operators scope what Saturn touches: review allowlist, fix package/path scope, per-bug phase, and an
  open-pull-request cap.
- Code changes are delivered as **pull requests that require human review and merge**.
- Findings can be dismissed or recovered with an attributed reason.

## Responsible-use guidance

- Treat Saturn's output as **assistance, not authority** — verify before merging, filing, or relying
  on it.
- Do **not** use Saturn's output as an individual performance signal or to rank contributors.
- Keep a human in the loop for all consequential actions.

## Feedback

Use the in-dashboard feedback control on any comment, or open an issue in this repository.
