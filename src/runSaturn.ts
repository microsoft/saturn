import { getPullRequestById, listActivePullRequests } from './ado';
import { isOptedOutAuthor } from './config';
import { ensureAdoMcpServer, resolveCopilotCli } from './copilot';
import { ensureManagedClone, installRepoDependencies, updateRepoFromMaster } from './git';
import type { PullRequestSummary } from './review';
import { reviewPullRequest, type ReviewOutcome, type ReviewOutcomeStatus } from './reviewPullRequest';
import { recordSaturnReview } from './saturnStore';
import { consoleLogger, type Logger } from './util';

/** Live progress events emitted during a run (consumed by the Saturn dashboard service). */
export type SaturnProgressEvent =
  | { readonly type: 'pr-start'; readonly pullRequest: PullRequestSummary }
  | { readonly type: 'pr-done'; readonly pullRequest: PullRequestSummary; readonly outcome: ReviewOutcome };

/** Options controlling a full run of the bot. */
export interface SaturnOptions {
  readonly repoRoot: string;
  readonly post: boolean;
  readonly listOnly: boolean;
  readonly maxReviews: number;
  readonly scanLimit: number;
  /** When set, only consider PRs created within this many days (used to bound the older-PR backfill). */
  readonly createdWithinDays?: number;
  readonly maxComments: number;
  readonly maxFiles: number;
  readonly maxFileLines: number;
  readonly maxPromptBytes: number;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly onBehalfOf: string;
  readonly withAdoMcp: boolean;
  readonly force: boolean;
  readonly updateMaster: boolean;
  readonly managedClone: boolean;
  readonly cloneDir?: string;
  readonly specificPullRequestId?: number;
  readonly reviewTimeoutMs: number;
  readonly installDeps: boolean;
  readonly onProgress?: (event: SaturnProgressEvent) => void;
  readonly shouldStop?: () => boolean;
  readonly logger?: Logger;
}

/** Summary of a completed run. */
export interface SaturnRunSummary {
  readonly scannedPullRequests: number;
  readonly outcomes: readonly ReviewOutcome[];
}

function selectCandidates(activePullRequests: readonly PullRequestSummary[]): readonly PullRequestSummary[] {
  return [...activePullRequests]
    .filter((pullRequest) => !pullRequest.isDraft)
    .filter((pullRequest) => !isOptedOutAuthor(pullRequest.authorName))
    .sort((left, right) => right.pullRequestId - left.pullRequestId);
}

function summarizeOutcomes(outcomes: readonly ReviewOutcome[], logger: Logger): void {
  const counts = new Map<ReviewOutcomeStatus, number>();
  let totalComments = 0;
  for (const outcome of outcomes) {
    counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
    totalComments += outcome.commentsPosted;
  }

  const parts = [...counts.entries()].map(([status, count]) => `${status}: ${String(count)}`);
  logger.info('');
  logger.info(`Done. ${parts.join(', ')}. Inline comments posted: ${String(totalComments)}.`);
}

/**
 * Run the PR review bot: list active pull requests, skip drafts and already-reviewed PRs, and review
 * up to `maxReviews` of them. In dry-run mode (the default) nothing is posted; pass `post: true`
 * (the `--post` flag) to publish comments.
 */
export async function runSaturn(options: SaturnOptions): Promise<SaturnRunSummary> {
  const logger = options.logger ?? consoleLogger;

  let repoRoot = options.repoRoot;
  if (options.managedClone && !options.listOnly) {
    repoRoot = await ensureManagedClone(options.cloneDir, logger, options.updateMaster);
  } else if (!options.listOnly && options.updateMaster) {
    await updateRepoFromMaster(repoRoot, logger);
  }

  if (options.installDeps && !options.listOnly) {
    await installRepoDependencies(repoRoot, logger);
  }

  let scannedPullRequests = 0;
  let candidates: readonly PullRequestSummary[];
  if (options.specificPullRequestId !== undefined) {
    const requested = await getPullRequestById(repoRoot, options.specificPullRequestId);
    if (requested === undefined) {
      logger.warn(`PR #${String(options.specificPullRequestId)} was not found in office-bohemia.`);
      candidates = [];
    } else {
      logger.info(`Targeting PR #${String(requested.pullRequestId)}: ${requested.title}`);
      candidates = [requested];
    }

    scannedPullRequests = candidates.length;
  } else {
    const activePullRequests = await listActivePullRequests(repoRoot, options.scanLimit);
    scannedPullRequests = activePullRequests.length;
    candidates = selectCandidates(activePullRequests);
    if (options.createdWithinDays !== undefined) {
      const cutoffMs = Date.now() - options.createdWithinDays * 24 * 60 * 60 * 1000;
      candidates = candidates.filter(
        (pullRequest) => pullRequest.createdAt !== undefined && Date.parse(pullRequest.createdAt) >= cutoffMs
      );
    }
    logger.info(
      `Scanned ${String(activePullRequests.length)} active PR(s); ${String(candidates.length)} non-draft candidate(s)` +
        (options.createdWithinDays !== undefined ? ` within ${String(options.createdWithinDays)} day(s)` : '') +
        '.'
    );
  }

  if (options.listOnly) {
    for (const pullRequest of candidates) {
      logger.info(`  #${String(pullRequest.pullRequestId)} ${pullRequest.title}  (${pullRequest.authorName})`);
    }

    return { scannedPullRequests, outcomes: [] };
  }

  const cliPath = resolveCopilotCli();
  if (cliPath === undefined) {
    throw new Error(
      'Could not find the GitHub Copilot CLI. Install it (npm install -g @github/copilot), run `copilot` once to log in, or set COPILOT_CLI_PATH.'
    );
  }

  const allowMcpServerName = options.withAdoMcp ? ensureAdoMcpServer(undefined) : undefined;
  if (options.withAdoMcp && allowMcpServerName === undefined) {
    logger.warn('Could not register the Azure DevOps MCP server; continuing with the diff fed directly to the model.');
  }

  if (!options.post) {
    logger.info('DRY-RUN: no comments will be posted. Pass --post to publish the review comments.');
  }

  const outcomes: ReviewOutcome[] = [];
  let reviewedCount = 0;
  for (const pullRequest of candidates) {
    if (options.shouldStop?.() === true) {
      logger.info('Stop requested - ending this scan.');
      break;
    }

    if (options.specificPullRequestId === undefined && reviewedCount >= options.maxReviews) {
      break;
    }

    options.onProgress?.({ type: 'pr-start', pullRequest });
    const outcome = await reviewPullRequest(pullRequest, {
      repoRoot,
      cliPath,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      maxComments: options.maxComments,
      maxFiles: options.maxFiles,
      maxFileLines: options.maxFileLines,
      maxPromptBytes: options.maxPromptBytes,
      reviewTimeoutMs: options.reviewTimeoutMs,
      onBehalfOf: options.onBehalfOf,
      allowMcpServerName,
      post: options.post,
      force: options.force,
      logger
    });
    outcomes.push(outcome);
    options.onProgress?.({ type: 'pr-done', pullRequest, outcome });
    if (outcome.status === 'reviewed' || outcome.status === 'no-findings') {
      reviewedCount += 1;
    }

    // Record terminal outcomes (including errors) to the shared store so both the CLI and the
    // always-on dashboard surface what the agent actually did.
    if (outcome.status === 'reviewed' || outcome.status === 'no-findings' || outcome.status === 'error') {
      recordSaturnReview(
        {
          pullRequestId: outcome.pullRequestId,
          title: pullRequest.title,
          author: pullRequest.authorName,
          webUrl: pullRequest.webUrl
        },
        {
          iterationId: outcome.iterationId ?? 0,
          status: outcome.status,
          commentsPosted: outcome.commentsPosted,
          detail: outcome.detail ?? '',
          comments: (outcome.postedComments ?? []).map((comment) => ({
            filePath: comment.filePath,
            line: comment.line,
            severity: comment.severity,
            category: comment.category,
            title: comment.title,
            body: comment.body,
            deepLink: comment.deepLink,
            threadId: comment.threadId
          })),
          reviewedAt: new Date().toISOString(),
          durationMs: outcome.durationMs,
          model: outcome.model,
          filesReviewed: outcome.filesReviewed,
          filesChanged: outcome.filesChanged,
          diffTruncated: outcome.diffTruncated,
          candidatesProposed: outcome.candidatesProposed,
          candidatesKept: outcome.candidatesKept
        },
        outcome.status === 'reviewed' || outcome.status === 'no-findings'
      );
    }

    if (outcome.detail !== undefined) {
      logger.info(`  -> ${outcome.status}: ${outcome.detail}`);
    }
  }

  summarizeOutcomes(outcomes, logger);
  return { scannedPullRequests, outcomes };
}
