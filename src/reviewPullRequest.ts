import {
  getBlobText,
  getChangedFiles,
  getExistingThreadComments,
  getFileTextAtCommit,
  getLatestIterationId,
  postInlineComment,
  reactivateThreadAndReply,
  type ExistingThreadComment
} from './ado';
import {
  BOT_REVIEW_MARKER,
  buildCommentDeepLink,
  buildCommentWithDisclaimer,
  buildFindingHeader,
  buildIterationTag,
  buildReactivationReply
} from './config';
import { runCopilotReview } from './copilot';
import {
  buildDiffPayload,
  buildReviewPrompt,
  buildVerificationPrompt,
  limitComments,
  parseReviewResult,
  parseVerificationResult,
  severityRequiresAuthorAction,
  type ChangedFile,
  type DiffFileInput,
  type PullRequestSummary,
  type ReviewComment,
  type ReviewResult
} from './review';
import { readPullRequestReview } from './saturnStore';
import { describeError, type Logger } from './util';

/** Terminal status of reviewing a single pull request. */
export type ReviewOutcomeStatus = 'reviewed' | 'no-findings' | 'skipped-existing' | 'skipped-empty' | 'error';

/** A comment Saturn posted, with its thread id and deep link (surfaced in the dashboard). */
export interface PostedComment extends ReviewComment {
  readonly threadId: number;
  readonly deepLink: string;
}

/** Result of reviewing a single pull request. */
export interface ReviewOutcome {
  readonly pullRequestId: number;
  readonly status: ReviewOutcomeStatus;
  readonly commentsPosted: number;
  readonly iterationId?: number;
  readonly detail?: string;
  readonly postedComments?: readonly PostedComment[];
  /** How long the review (model passes) took, in ms. */
  readonly durationMs?: number;
  /** The model that produced this review. */
  readonly model?: string;
  /** Files actually sent to the model vs. total changed (a gap means the diff was truncated). */
  readonly filesReviewed?: number;
  readonly filesChanged?: number;
  /** True when the diff context sent to the model was truncated (partial review). */
  readonly diffTruncated?: boolean;
  /** Findings the first pass proposed vs. how many survived the verification gate. */
  readonly candidatesProposed?: number;
  readonly candidatesKept?: number;
}

/** Everything {@link reviewPullRequest} needs to review and (optionally) post on one pull request. */
export interface ReviewPullRequestDeps {
  readonly repoRoot: string;
  readonly cliPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly maxComments: number;
  readonly maxFiles: number;
  readonly maxFileLines: number;
  readonly maxPromptBytes: number;
  readonly reviewTimeoutMs: number;
  readonly onBehalfOf: string;
  readonly allowMcpServerName?: string;
  readonly post: boolean;
  readonly force: boolean;
  readonly logger: Logger;
}

// Extensions we never try to review as text (binaries, generated artifacts, lockfiles, snapshots).
const NON_REVIEWABLE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.bin',
  '.lock',
  '.snap',
  '.map'
]);

function isReviewableFile(filePath: string, changeType: string): boolean {
  if (changeType.includes('delete')) {
    return false;
  }

  const lower = filePath.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  const extension = dotIndex >= 0 ? lower.slice(dotIndex) : '';
  return !NON_REVIEWABLE_EXTENSIONS.has(extension);
}

function looksBinary(content: string): boolean {
  return content.includes('\u0000');
}

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** ADO thread statuses that mean the author engaged with the thread (an attempted fix), not ignored it. */
function isResolvedThreadStatus(status: string | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  const normalized = status.toLowerCase();
  return ['fixed', 'closed', 'wontfix', 'bydesign', '2', '3', '4', '5'].includes(normalized);
}

/** How a proposed comment relates to the PR's existing threads. */
type ExistingCommentMatch =
  | { readonly kind: 'saturn'; readonly thread: ExistingThreadComment }
  | { readonly kind: 'human' }
  | { readonly kind: 'none' };

/**
 * Classify a proposed comment against the PR's existing threads. A Saturn thread at the same file/line
 * (or one whose text already carries the gist) is a `saturn` match - Saturn reactivates and replies on it
 * instead of opening a duplicate. A human thread that already said the same thing is a `human` match -
 * Saturn stays silent so it never repeats a human reviewer. Otherwise the comment is brand new (`none`).
 */
function classifyExistingComment(
  existing: readonly ExistingThreadComment[],
  comment: ReviewComment
): ExistingCommentMatch {
  const bodySnippet = normalizeForDedup(comment.body).slice(0, 80);
  let humanMatch = false;
  let saturnGistMatch: ExistingThreadComment | undefined;
  for (const thread of existing) {
    const isSaturn = thread.content.includes(BOT_REVIEW_MARKER);
    const sameLocation = thread.filePath === comment.filePath && thread.line === comment.line;
    if (sameLocation && isSaturn) {
      return { kind: 'saturn', thread };
    }

    const sameThingSaid = bodySnippet !== '' && normalizeForDedup(thread.content).includes(bodySnippet);
    if (sameThingSaid) {
      if (isSaturn) {
        saturnGistMatch ??= thread;
      } else {
        humanMatch = true;
      }
    }
  }

  if (saturnGistMatch !== undefined) {
    return { kind: 'saturn', thread: saturnGistMatch };
  }

  return humanMatch ? { kind: 'human' } : { kind: 'none' };
}

async function collectFileInputs(
  pullRequestId: number,
  files: readonly ChangedFile[],
  baseCommit: string | undefined,
  deps: ReviewPullRequestDeps
): Promise<readonly DiffFileInput[]> {
  const fileInputs: DiffFileInput[] = [];
  for (const file of files) {
    try {
      const content = await getBlobText(deps.repoRoot, file.objectId);
      if (looksBinary(content)) {
        continue;
      }

      // Fetch the merge-base version so the model is shown a real diff. Added files have no base, and a
      // failed base fetch falls back to '' (review the whole file) rather than dropping the file.
      let baseContent = '';
      if (baseCommit !== undefined && !file.changeType.includes('add')) {
        try {
          baseContent = await getFileTextAtCommit(deps.repoRoot, file.path, baseCommit);
        } catch (baseError) {
          deps.logger.warn(
            `PR #${String(pullRequestId)}: could not fetch base for ${file.path}; reviewing the whole file. ${describeError(baseError)}`
          );
        }
      }

      fileInputs.push({ path: file.path, changeType: file.changeType, content, baseContent });
    } catch (error) {
      deps.logger.warn(`PR #${String(pullRequestId)}: could not fetch ${file.path}: ${describeError(error)}`);
    }
  }

  return fileInputs;
}

/**
 * Verification gate: a second model pass re-checks the proposed comments against the real code and
 * returns only the ones that are verified, correct, and material. On any failure it returns an empty
 * list, so Saturn fails closed (never posts unverified comments).
 */
async function verifyComments(
  pullRequest: PullRequestSummary,
  comments: readonly ReviewComment[],
  deps: ReviewPullRequestDeps
): Promise<readonly ReviewComment[]> {
  deps.logger.info(
    `PR #${String(pullRequest.pullRequestId)}: verifying ${String(comments.length)} proposed comment(s)...`
  );
  const result = await runCopilotReview({
    cliPath: deps.cliPath,
    prompt: buildVerificationPrompt(pullRequest, comments),
    model: deps.model,
    reasoningEffort: deps.reasoningEffort,
    cwd: deps.repoRoot,
    timeoutMs: deps.reviewTimeoutMs,
    allowMcpServerName: deps.allowMcpServerName
  });
  if (result.status !== 0) {
    deps.logger.warn(`PR #${String(pullRequest.pullRequestId)}: verification call failed; dropping all comments.`);
    return [];
  }

  const verdict = parseVerificationResult(result.stdout);
  if (verdict === undefined) {
    deps.logger.warn(
      `PR #${String(pullRequest.pullRequestId)}: unparseable verification verdict; dropping all comments.`
    );
    return [];
  }

  if (!verdict.approved) {
    deps.logger.info(`PR #${String(pullRequest.pullRequestId)}: verification not approved - ${verdict.reason}`);
    return [];
  }

  const kept = verdict.keepIndices
    .filter((index) => index >= 0 && index < comments.length)
    .map((index) => comments[index]);
  return [...new Set(kept)];
}

/**
 * Review a single pull request: skip if already reviewed, fetch the changed files, ask the model for
 * a structured review, then either print (dry-run) or post the inline comments plus a lead summary.
 */
export async function reviewPullRequest(
  pullRequest: PullRequestSummary,
  deps: ReviewPullRequestDeps
): Promise<ReviewOutcome> {
  const { repoRoot, logger } = deps;
  const pullRequestId = pullRequest.pullRequestId;
  const startedAtMs = Date.now();
  let iterationId: number | undefined;

  try {
    iterationId = await getLatestIterationId(repoRoot, pullRequestId);
    if (!deps.force && iterationId !== undefined) {
      // PR + iteration is Saturn's idempotency key: skip only when this exact iteration was already
      // reviewed without error. A newer iteration (new commits) or a prior error falls through and is
      // re-reviewed, so newly introduced issues are caught and partial/failed posts are retried.
      const currentIteration = iterationId;
      const priorReview = readPullRequestReview(pullRequestId);
      const priorIteration = priorReview?.iterations.find((entry) => entry.iterationId === currentIteration);
      if (priorIteration !== undefined && priorIteration.status !== 'error') {
        logger.info(
          `PR #${String(pullRequestId)}: iteration ${String(currentIteration)} already reviewed by Saturn - skipping.`
        );
        return { pullRequestId, status: 'skipped-existing', commentsPosted: 0, iterationId: currentIteration };
      }

      if (priorReview !== undefined) {
        logger.info(
          `PR #${String(pullRequestId)}: iteration ${String(currentIteration)} is new (or a prior review errored) - reviewing.`
        );
      }
    }

    const {
      iterationId: changedIterationId,
      baseCommit,
      files: changedFiles
    } = await getChangedFiles(repoRoot, pullRequestId);
    iterationId = changedIterationId ?? iterationId;
    const reviewable = changedFiles.filter(
      (file) => isReviewableFile(file.path, file.changeType) && file.objectId !== ''
    );
    if (reviewable.length === 0) {
      logger.info(`PR #${String(pullRequestId)}: no reviewable text changes - skipping.`);
      return { pullRequestId, status: 'skipped-empty', commentsPosted: 0, iterationId };
    }

    const selectedFiles = reviewable.slice(0, deps.maxFiles);
    const fileInputs = await collectFileInputs(pullRequestId, selectedFiles, baseCommit, deps);
    if (fileInputs.length === 0) {
      return { pullRequestId, status: 'skipped-empty', commentsPosted: 0, iterationId };
    }

    const diffPayload = buildDiffPayload(fileInputs, {
      maxTotalBytes: deps.maxPromptBytes,
      maxFileLines: deps.maxFileLines
    });
    const reviewMeta = {
      model: deps.model,
      filesReviewed: fileInputs.length,
      filesChanged: changedFiles.length,
      diffTruncated: diffPayload.truncated
    };
    const prompt = buildReviewPrompt({
      pullRequest,
      diffPayload,
      changedFiles: selectedFiles,
      maxComments: deps.maxComments
    });

    // The model occasionally emits unparseable output (truncated or garbled JSON). Re-run once before
    // giving up; a process-level failure (e.g. timeout) is returned immediately and not retried.
    let review: ReviewResult | undefined;
    let parseFailureDetail = 'could not parse a JSON review from the model output';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      logger.info(
        `PR #${String(pullRequestId)}: reviewing ${String(fileInputs.length)} file(s) with ${deps.model}${attempt > 1 ? ' (retry after unparseable output)' : ''}...`
      );
      const processResult = await runCopilotReview({
        cliPath: deps.cliPath,
        prompt,
        model: deps.model,
        reasoningEffort: deps.reasoningEffort,
        cwd: repoRoot,
        timeoutMs: deps.reviewTimeoutMs,
        allowMcpServerName: deps.allowMcpServerName
      });
      if (processResult.status !== 0) {
        return {
          pullRequestId,
          status: 'error',
          commentsPosted: 0,
          iterationId,
          detail: `copilot exited with code ${String(processResult.status)}: ${processResult.stderr.slice(0, 300)}`,
          ...reviewMeta,
          durationMs: Date.now() - startedAtMs
        };
      }

      review = parseReviewResult(processResult.stdout);
      if (review !== undefined) {
        break;
      }

      const outputSnippet = `${processResult.stdout}\n${processResult.stderr}`
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      parseFailureDetail =
        outputSnippet === ''
          ? 'could not parse a JSON review from the model output (no output - is the copilot CLI logged in?)'
          : `could not parse a JSON review from the model output (copilot said: ${outputSnippet})`;
    }

    if (review === undefined) {
      return {
        pullRequestId,
        status: 'error',
        commentsPosted: 0,
        iterationId,
        detail: parseFailureDetail,
        ...reviewMeta,
        durationMs: Date.now() - startedAtMs
      };
    }

    const comments = limitComments(review.comments, deps.maxComments);

    if (!review.hasFindings || comments.length === 0) {
      // No blocking findings: stay silent on the PR (no "all clear" comment). The no-findings outcome is
      // still recorded in the store, so this iteration is not re-reviewed and the dashboard reflects it.
      logger.info(`PR #${String(pullRequestId)}: no blocking findings - leaving no comment.`);
      return {
        pullRequestId,
        status: 'no-findings',
        commentsPosted: 0,
        iterationId,
        ...reviewMeta,
        durationMs: Date.now() - startedAtMs,
        candidatesProposed: comments.length,
        candidatesKept: 0
      };
    }

    // Verification gate: a second model pass re-checks the proposed comments and keeps only the
    // verified, material ones. Saturn never posts a comment that fails this gate.
    const verifiedComments = await verifyComments(pullRequest, comments, deps);
    if (verifiedComments.length === 0) {
      // Every proposed comment failed the verification gate: nothing material to say, so stay silent.
      logger.info(
        `PR #${String(pullRequestId)}: ${String(comments.length)} proposed comment(s) all dropped by the verification gate - leaving no comment.`
      );
      return {
        pullRequestId,
        status: 'no-findings',
        commentsPosted: 0,
        iterationId,
        detail: 'all proposed comments dropped by the verification gate',
        ...reviewMeta,
        durationMs: Date.now() - startedAtMs,
        candidatesProposed: comments.length,
        candidatesKept: 0
      };
    }

    if (!deps.post) {
      logger.info(
        `PR #${String(pullRequestId)} [dry-run]: ${String(verifiedComments.length)} verified comment(s) (of ${String(comments.length)} proposed):`
      );
      for (const comment of verifiedComments) {
        logger.info(
          `  - ${comment.severity.toUpperCase()} ${comment.filePath}:${String(comment.line)} - ${comment.title}`
        );
      }

      return {
        pullRequestId,
        status: 'reviewed',
        commentsPosted: 0,
        iterationId,
        detail: `${String(verifiedComments.length)} verified comment(s) not posted (dry-run)`,
        ...reviewMeta,
        durationMs: Date.now() - startedAtMs,
        candidatesProposed: comments.length,
        candidatesKept: verifiedComments.length
      };
    }

    // Fetch the PR's current threads so Saturn never opens a duplicate: it reactivates and replies on its
    // own prior thread when the issue still applies, and stays silent when a human already said the same.
    const existingThreads = await getExistingThreadComments(repoRoot, pullRequestId);
    const iterationTag = iterationId === undefined ? undefined : buildIterationTag(iterationId);
    let commentsPosted = 0;
    let commentsReactivated = 0;
    let skippedDuplicates = 0;
    const postedComments: PostedComment[] = [];
    for (const comment of verifiedComments) {
      const match = classifyExistingComment(existingThreads, comment);

      if (match.kind === 'human') {
        skippedDuplicates += 1;
        logger.info(
          `PR #${String(pullRequestId)}: skipping comment on ${comment.filePath}:${String(comment.line)} - a human reviewer already raised it.`
        );
        continue;
      }

      if (match.kind === 'saturn') {
        const { thread } = match;
        // Already handled on this thread for this iteration (e.g. an error-retry of the same iteration)?
        // The hidden iteration tag in the reply makes reactivation idempotent, so don't reply twice.
        if (thread.threadId === undefined || (iterationTag !== undefined && thread.content.includes(iterationTag))) {
          skippedDuplicates += 1;
          continue;
        }

        // A non-actionable finding (nit/minor) already has its thread; don't re-surface it as Active on a
        // new iteration - that would only add noise. Leave the existing (already-resolved) thread as-is.
        if (!severityRequiresAuthorAction(comment.severity)) {
          skippedDuplicates += 1;
          continue;
        }

        try {
          // A resolved/closed thread means the author engaged with it (attempted a fix); an active one
          // means the issue is still open and unaddressed. The reply explains which case applies.
          await reactivateThreadAndReply(
            repoRoot,
            pullRequestId,
            thread.threadId,
            buildReactivationReply({
              iterationId: iterationId ?? 0,
              authorAttemptedFix: isResolvedThreadStatus(thread.status),
              severity: comment.severity,
              commentTitle: comment.title
            })
          );
          commentsReactivated += 1;
          postedComments.push({
            ...comment,
            threadId: thread.threadId,
            deepLink: buildCommentDeepLink(pullRequestId, thread.threadId)
          });
        } catch (error) {
          logger.warn(
            `PR #${String(pullRequestId)}: failed to reactivate thread ${String(thread.threadId)} on ${comment.filePath}:${String(comment.line)}: ${describeError(error)}`
          );
        }
        continue;
      }

      try {
        // Lead each posted comment with the same severity + title shown on the dashboard; Saturn's
        // attribution/disclaimer is prepended too, so there is no separate summary thread. Non-actionable
        // findings (nit/minor) are posted already-resolved so they don't add to the PR's open-thread count.
        const finding = `${buildFindingHeader(comment.severity, comment.title)}\n\n${comment.body}`;
        const threadId = await postInlineComment(
          repoRoot,
          pullRequestId,
          { ...comment, body: buildCommentWithDisclaimer(finding, deps.onBehalfOf) },
          !severityRequiresAuthorAction(comment.severity)
        );
        commentsPosted += 1;
        postedComments.push({ ...comment, threadId, deepLink: buildCommentDeepLink(pullRequestId, threadId) });
      } catch (error) {
        logger.warn(
          `PR #${String(pullRequestId)}: failed to post comment on ${comment.filePath}:${String(comment.line)}: ${describeError(error)}`
        );
      }
    }

    logger.info(
      `PR #${String(pullRequestId)}: posted ${String(commentsPosted)} new comment(s)` +
        (commentsReactivated > 0 ? `, reactivated ${String(commentsReactivated)}` : '') +
        (skippedDuplicates > 0 ? `, skipped ${String(skippedDuplicates)} duplicate(s)` : '') +
        '.'
    );
    return {
      pullRequestId,
      status: 'reviewed',
      commentsPosted: commentsPosted + commentsReactivated,
      iterationId,
      postedComments,
      ...reviewMeta,
      durationMs: Date.now() - startedAtMs,
      candidatesProposed: comments.length,
      candidatesKept: verifiedComments.length
    };
  } catch (error) {
    return {
      pullRequestId,
      status: 'error',
      commentsPosted: 0,
      iterationId,
      detail: describeError(error),
      model: deps.model,
      durationMs: Date.now() - startedAtMs
    };
  }
}
