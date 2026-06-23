// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { fixBranchPrefix, fixMaxOpenPrs, fixPollIntervalMs } from './config';
import { ensureAdoMcpServer, resolveCopilotCli } from './copilot';
import { type FixRunOptions, monitorFixTask, selectBugToFix, startFix } from './fixAgent';
import {
  clearActivePrErrors,
  countActiveFixTasks,
  fixWakeRequestedSince,
  listActiveFixTasks,
  recoverInterruptedFixTasks
} from './fixStore';
import { deleteLocalFixBranch, ensureFixClone, installRepoDependenciesInBackground, listLocalBranches } from './git';
import { describeError, type Logger } from './util';

/** Tunables for one Code Autopilot run (the model + per-step timeout). */
export interface FixServiceConfig {
  readonly model: string;
  readonly reasoningEffort: string;
  /** Per Copilot edit invocation (a single fix attempt). */
  readonly timeoutMs: number;
}

let running = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True while the fix loop is active (the standalone process drives this; the dashboard only reads fix.db). */
export function isFixLoopRunning(): boolean {
  return running;
}

/** Ask the loop to stop after the current iteration. */
export function stopFixLoop(): void {
  running = false;
}

// Monitor every open PR the agent owns: merges -> cleanup, abandons -> cleanup, blockers -> address.
async function monitorOpenPrs(options: FixRunOptions, logger: Logger): Promise<void> {
  const active = listActiveFixTasks().filter(
    (task) => task.prId !== undefined && (task.status === 'pr-open' || task.status === 'addressing')
  );
  for (const task of active) {
    if (!running) {
      break;
    }
    try {
      await monitorFixTask(task, options, logger);
    } catch (error) {
      logger.warn(`Code Autopilot: monitoring PR for bug ${String(task.bugId)} failed: ${describeError(error)}`);
    }
  }
}

// Delete local fix branches that no longer belong to an in-flight task (their PR merged/abandoned, or the
// run was interrupted) so the fix clone doesn't accumulate stale branches over time.
async function pruneCompletedFixBranches(options: FixRunOptions, logger: Logger): Promise<void> {
  const activeBranches = new Set(listActiveFixTasks().map((task) => task.branch));
  let localBranches: readonly string[] = [];
  try {
    localBranches = await listLocalBranches(options.cloneDir, fixBranchPrefix());
  } catch {
    return;
  }
  for (const branch of localBranches) {
    if (activeBranches.has(branch) || !running) {
      continue;
    }
    try {
      await deleteLocalFixBranch(options.cloneDir, branch, logger);
    } catch {
      /* best-effort cleanup */
    }
  }
}

// Start one new fix when below the open-PR cap and a bug qualifies.
async function maybeStartNewFix(options: FixRunOptions, logger: Logger): Promise<void> {
  const open = countActiveFixTasks();
  const max = fixMaxOpenPrs();
  if (open >= max) {
    logger.info(`Code Autopilot: ${String(open)}/${String(max)} task(s) already in flight; not starting a new fix.`);
    return;
  }
  const candidate = selectBugToFix();
  if (candidate === undefined) {
    logger.info('Code Autopilot: no eligible bug to fix right now.');
    return;
  }
  logger.info(
    `Code Autopilot: starting a fix for bug ${String(candidate.finding.adoBugId)} (phase ${String(candidate.phase)}): ${candidate.finding.title}`
  );
  await startFix(candidate, options, logger);
}

/**
 * Run the standalone fix loop: ensure the dedicated clone, then every interval monitor all open PRs and
 * (below the open-PR cap) start one new fix. Independent of the PR-review + audit agents - it runs in its
 * own process against its own clone so it never interferes with them.
 */
export async function runFixLoop(config: FixServiceConfig, logger: Logger): Promise<void> {
  running = true;
  const cliPath = resolveCopilotCli();
  if (cliPath === undefined) {
    logger.error('Code Autopilot: GitHub Copilot CLI not found; cannot run. Install it and retry.');
    running = false;
    return;
  }

  // Register the Azure DevOps MCP server so Code Autopilot can investigate PRs, builds, and threads itself.
  const allowMcpServerName = ensureAdoMcpServer(undefined);
  if (allowMcpServerName !== undefined) {
    logger.info('Code Autopilot: Azure DevOps MCP tools enabled for PR/build investigation.');
  }

  // Recover any tasks stranded mid-work by a previous restart so they don't hold the open-task cap forever.
  const recovered = recoverInterruptedFixTasks();
  if (recovered.resumed > 0 || recovered.requeued > 0) {
    logger.info(
      `Code Autopilot: recovered ${String(recovered.resumed)} interrupted PR(s) and re-queued ${String(recovered.requeued)} task(s) for retry.`
    );
  }

  // After a restart every recorded error is stale; clear them on live PRs so the dashboard shows current
  // state (the monitor re-sets any genuine error on its next pass).
  const clearedStale = clearActivePrErrors();
  if (clearedStale > 0) {
    logger.info(`Code Autopilot: cleared ${String(clearedStale)} stale error(s) on live PRs after restart.`);
  }

  logger.info('Code Autopilot: ensuring the dedicated fix clone (first run can take several minutes)...');
  const cloneDir = await ensureFixClone(logger);
  installRepoDependenciesInBackground(cloneDir, logger);
  const options: FixRunOptions = {
    cloneDir,
    cliPath,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    timeoutMs: config.timeoutMs,
    ...(allowMcpServerName !== undefined ? { allowMcpServerName } : {})
  };

  logger.info('Code Autopilot: running.');
  while (running) {
    try {
      await monitorOpenPrs(options, logger);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- running flips during the awaits above
      if (running) {
        await pruneCompletedFixBranches(options, logger);
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- running flips during the awaits above
      if (running) {
        await maybeStartNewFix(options, logger);
      }
    } catch (error) {
      logger.warn(`Code Autopilot: loop iteration failed: ${describeError(error)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- running flips during the awaits above
    if (!running) {
      break;
    }
    const intervalMs = fixPollIntervalMs();
    logger.info(
      `Code Autopilot: next iteration in ${String(Math.round(intervalMs / 60_000))} min (or sooner on a webhook).`
    );
    const iterationStart = Date.now();
    const waitUntil = iterationStart + intervalMs;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- running flips via stopFixLoop() during the delay
    while (running && Date.now() < waitUntil) {
      if (fixWakeRequestedSince(iterationStart)) {
        logger.info('Code Autopilot: webhook wake received; running an iteration now.');
        break;
      }
      await delay(5_000);
    }
  }
  logger.info('Code Autopilot: stopped.');
}
