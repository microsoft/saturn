#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { defaultReasoningEffort, fixTimeoutMs, isSaturnConfigured, primaryModel } from './config';
import { runFixLoop } from './fixService';
import { consoleLogger, describeError } from './util';

const HELP = `Saturn Code Autopilot - autonomously turns assigned audit bugs into pull requests.

Runs continuously: every interval it monitors its open PRs (addressing review
comments, build/PR errors, and merge conflicts, and cleaning up branches once a
PR is merged) and, while under the open-PR cap, starts one new fix from an
assigned bug. Each fix is generated on a fresh branch off the latest default
branch, then a PR is opened and linked to the bug.

This agent is fully STANDALONE: it does NOT require the PR-review or
codebase-audit agents, and it works in its OWN dedicated clone
(C:\\saturn\\fix-repo\\<repo>) so the heavy editing never interferes with them.

Key environment variables (all optional):
  SATURN_FIX_CATEGORY           Audit category to draw bugs from (default: accessibility)
  SATURN_FIX_MAX_PHASE          1 = single file, 2 = single package, 3 = anything (default: 1)
  SATURN_FIX_MAX_OPEN_PRS       Open PRs kept in flight at once (default: 1)
  SATURN_FIX_ONLY_BUG           Pin to a single ADO bug id (for testing one PR)
  SATURN_FIX_DRY_RUN            true = generate + commit locally, never push or open a PR
  SATURN_FIX_POLL_MINUTES       Iteration interval in minutes (default: 10)
  SATURN_MODEL                  Primary Copilot model (default: claude-opus-4.8)
  SATURN_BACKUP_MODEL           Backup model after 3 consecutive failures (default: claude-opus-4.5)
  SATURN_MODEL_FAILURE_THRESHOLD  Failures before switching to backup (default: 3)
  SATURN_REASONING_EFFORT       Reasoning effort: none/low/medium/high/xhigh/max (default: max)
  SATURN_FIX_CLONE_DIR          Override the dedicated fix clone location
`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    consoleLogger.info(HELP);
    return;
  }
  if (!isSaturnConfigured()) {
    consoleLogger.error(
      'Saturn is not configured yet. Open the dashboard and complete setup (repository + model) first.'
    );
    return;
  }
  const model =
    (process.env.SATURN_FIX_MODEL ?? '').trim() !== '' ? (process.env.SATURN_FIX_MODEL ?? '').trim() : primaryModel();
  const reasoningEffort =
    (process.env.SATURN_FIX_EFFORT ?? '').trim() !== ''
      ? (process.env.SATURN_FIX_EFFORT ?? '').trim()
      : defaultReasoningEffort();
  await runFixLoop({ model, reasoningEffort, timeoutMs: fixTimeoutMs() }, consoleLogger);
}

main().catch((error: unknown) => {
  consoleLogger.error(describeError(error));
  process.exitCode = 1;
});
