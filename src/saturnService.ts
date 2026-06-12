import { defaultManagedCloneDir, installRepoDependenciesInBackground } from './git';
import type { ReviewOutcome } from './reviewPullRequest';
import { runSaturn, type SaturnProgressEvent } from './runSaturn';
import { getReviewSummary, readReviewsCursor } from './saturnStore';
import type { Logger } from './util';

const MASTER_UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000; // refresh the clone's master at most every 2 hours
const DEPS_INSTALL_INTERVAL_MS = 24 * 60 * 60 * 1000; // run "yarn install" in the clone at most once a day

/** A single comment Saturn posted, as surfaced in the dashboard. */
export interface SaturnComment {
  readonly filePath: string;
  readonly line: number;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string;
  readonly threadId?: number;
}

/** A record of one reviewed iteration of a pull request. */
export interface SaturnIterationRecord {
  readonly iterationId: number;
  readonly status: string;
  readonly commentsPosted: number;
  readonly detail: string;
  readonly comments: readonly SaturnComment[];
  readonly reviewedAt: string;
}

/** A reviewed pull request, with one entry per reviewed iteration (newest iteration last). */
export interface SaturnReviewRecord {
  readonly pullRequestId: number;
  readonly title: string;
  readonly author: string;
  readonly webUrl: string;
  readonly iterations: readonly SaturnIterationRecord[];
}

/** A cursor batch of reviewed pull requests (each appears once), newest reviewed first. */
export interface SaturnReviewsCursorPage {
  readonly items: readonly SaturnReviewRecord[];
  readonly nextCursor: string | null;
  readonly total: number;
}

/** The PR Saturn is currently reviewing. */
export interface SaturnCurrentPullRequest {
  readonly id: number;
  readonly title: string;
  readonly webUrl: string;
}

/** The live state the dashboard renders. Review history is fetched separately and paginated. */
export interface SaturnState {
  readonly running: boolean;
  readonly phase: string;
  readonly currentPullRequest: SaturnCurrentPullRequest | null;
  readonly startedAt: string | null;
  readonly lastScanAt: string | null;
  readonly totalReviewed: number;
  readonly reviewedPullRequestCount: number;
}

/** Control surface for the always-on Saturn agent. */
export interface SaturnService {
  start(): SaturnState;
  stop(): SaturnState;
  getState(): SaturnState;
  getReviewsCursor(cursor: string | undefined, limit: number): SaturnReviewsCursorPage;
}

/** Configuration for the Saturn agent loop. */
export interface SaturnServiceConfig {
  readonly cloneDir?: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly maxComments: number;
  readonly maxReviews: number;
  readonly scanLimit: number;
  readonly onBehalfOf: string;
  readonly installDeps: boolean;
  readonly scanIntervalMs: number;
  readonly reviewTimeoutMs: number;
  /** Older-PR backfill: how many active PRs to list when draining the backlog (beyond the top-N scan). */
  readonly backfillScanLimit: number;
  /** Older-PR backfill: only backfill PRs created within this many days. */
  readonly backfillWindowDays: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function defaultMaxPromptBytes(): number {
  return process.platform === 'win32' ? 24_000 : 200_000;
}

/** Count outcomes that did real review work (so skips and errors neither trigger nor extend the backfill). */
function countActualReviews(outcomes: readonly ReviewOutcome[]): number {
  return outcomes.filter((outcome) => outcome.status === 'reviewed' || outcome.status === 'no-findings').length;
}

/**
 * Create the always-on Saturn agent: a controllable loop that continuously reviews active PRs from a
 * managed clone, posting verified security/privacy comments and tracking live state for the dashboard.
 */
export function createSaturnService(config: SaturnServiceConfig, logger: Logger): SaturnService {
  let running = false;
  let phase = 'stopped';
  let currentPullRequest: SaturnCurrentPullRequest | null = null;
  let startedAt: string | null = null;
  let lastScanAt: string | null = null;
  let loopRunning = false;

  function snapshot(): SaturnState {
    // Live status lives in this process; the running total and reviewed-PR count come from the shared
    // store via a cheap summary read (it does not parse every per-PR file). The full review history is
    // served separately and paginated via getReviewsCursor so this frequently-polled snapshot stays light.
    const summary = getReviewSummary();
    return {
      running,
      phase,
      currentPullRequest,
      startedAt,
      lastScanAt,
      totalReviewed: summary.totalReviewed,
      reviewedPullRequestCount: summary.reviewedPullRequestCount
    };
  }

  function handleProgress(event: SaturnProgressEvent): void {
    if (event.type === 'pr-start') {
      phase = 'reviewing';
      currentPullRequest = {
        id: event.pullRequest.pullRequestId,
        title: event.pullRequest.title,
        webUrl: event.pullRequest.webUrl
      };
      return;
    }

    // runSaturn persists the review record into the shared store; here we only clear live status.
    currentPullRequest = null;
    phase = running ? 'scanning' : 'stopped';
  }

  async function runLoop(): Promise<void> {
    loopRunning = true;
    let lastMasterUpdateMs = 0;
    let lastDepsInstallMs = 0;
    try {
      while (running) {
        phase = 'scanning';
        lastScanAt = new Date().toISOString();
        const now = Date.now();
        const shouldUpdateMaster = lastMasterUpdateMs === 0 || now - lastMasterUpdateMs >= MASTER_UPDATE_INTERVAL_MS;
        const shouldInstallDeps =
          config.installDeps && (lastDepsInstallMs === 0 || now - lastDepsInstallMs >= DEPS_INSTALL_INTERVAL_MS);
        if (shouldUpdateMaster) {
          lastMasterUpdateMs = now;
        }
        if (shouldInstallDeps) {
          lastDepsInstallMs = now;
        }
        let reviewedThisCycle = 0;
        try {
          const scan = await runSaturn({
            repoRoot: process.cwd(),
            post: true,
            listOnly: false,
            maxReviews: config.maxReviews,
            scanLimit: config.scanLimit,
            maxComments: config.maxComments,
            maxFiles: 20,
            maxFileLines: 1500,
            maxPromptBytes: defaultMaxPromptBytes(),
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            onBehalfOf: config.onBehalfOf,
            withAdoMcp: false,
            force: false,
            updateMaster: shouldUpdateMaster,
            managedClone: true,
            cloneDir: config.cloneDir,
            installDeps: false,
            reviewTimeoutMs: config.reviewTimeoutMs,
            onProgress: handleProgress,
            shouldStop: () => !running,
            logger
          });
          reviewedThisCycle = countActualReviews(scan.outcomes);
        } catch (error) {
          logger.warn(`Saturn: scan failed: ${String(error)}`);
        }

        // Refresh dependencies (corepack yarn install) in the background on the daily cadence so the
        // review loop never blocks on it; node_modules becomes available for subsequent scans.
        if (shouldInstallDeps) {
          installRepoDependenciesInBackground(config.cloneDir ?? defaultManagedCloneDir(), logger);
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- running is flipped by stop() during the await above
        if (!running) {
          break;
        }

        // When the top-N scan is fully caught up (nothing new to review), drain the older backlog one PR at
        // a time: review a single active PR from the last `backfillWindowDays`, then loop back to re-scan the
        // newest PRs so fresh work always preempts the lower-priority backlog. Idle only when both the top-N
        // and the backlog are exhausted.
        if (reviewedThisCycle === 0) {
          phase = 'backfill';
          let backfilledThisCycle = 0;
          try {
            const backfill = await runSaturn({
              repoRoot: process.cwd(),
              post: true,
              listOnly: false,
              maxReviews: 1,
              scanLimit: config.backfillScanLimit,
              createdWithinDays: config.backfillWindowDays,
              maxComments: config.maxComments,
              maxFiles: 20,
              maxFileLines: 1500,
              maxPromptBytes: defaultMaxPromptBytes(),
              model: config.model,
              reasoningEffort: config.reasoningEffort,
              onBehalfOf: config.onBehalfOf,
              withAdoMcp: false,
              force: false,
              updateMaster: false,
              managedClone: true,
              cloneDir: config.cloneDir,
              installDeps: false,
              reviewTimeoutMs: config.reviewTimeoutMs,
              onProgress: handleProgress,
              shouldStop: () => !running,
              logger
            });
            backfilledThisCycle = countActualReviews(backfill.outcomes);
          } catch (error) {
            logger.warn(`Saturn: backfill scan failed: ${String(error)}`);
          }

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- running is flipped by stop() during the awaited backfill
          if (!running) {
            break;
          }

          // Reviewed an older PR - skip the idle wait and immediately re-scan the newest PRs.
          if (backfilledThisCycle > 0) {
            continue;
          }
        }

        phase = 'idle';
        const waitUntil = Date.now() + config.scanIntervalMs;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- running is flipped by stop() during the awaited scan
        while (running && Date.now() < waitUntil) {
          await delay(1000);
        }
      }
    } finally {
      loopRunning = false;
      phase = 'stopped';
      currentPullRequest = null;
    }
  }

  return {
    start(): SaturnState {
      if (!running) {
        running = true;
        startedAt = new Date().toISOString();
        phase = 'scanning';
        if (!loopRunning) {
          void runLoop();
        }
      }

      return snapshot();
    },
    stop(): SaturnState {
      running = false;
      phase = 'stopped';
      return snapshot();
    },
    getState(): SaturnState {
      return snapshot();
    },
    getReviewsCursor(cursor: string | undefined, limit: number): SaturnReviewsCursorPage {
      return readReviewsCursor(cursor, limit);
    }
  };
}
