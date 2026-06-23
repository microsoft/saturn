// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import {
  getBlobText,
  getChangedFiles,
  getExistingThreadComments,
  getFileTextAtCommit,
  getLatestIterationId,
  getPullRequestDescription,
  postInlineComment,
  postThreadReply,
  reactivateThreadAndReply,
  setThreadStatus,
  type ExistingThreadComment
} from './ado';
import {
  BOT_REVIEW_MARKER,
  buildCommentDeepLink,
  buildCommentWithDisclaimer,
  buildFindingHeader,
  buildIterationTag,
  buildReactivationReply,
  suppressedCategoriesForPath
} from './config';
import { runCopilotReview } from './copilot';
import {
  buildDiffPayload,
  buildReplyClassificationPrompt,
  buildReviewPrompt,
  buildVerificationPrompt,
  limitComments,
  parseReplyClassification,
  parseReviewResult,
  parseVerificationResult,
  severityRequiresAuthorAction,
  type ChangedFile,
  type DiffFileInput,
  type PullRequestSummary,
  type ReplyClassification,
  type ReviewCategory,
  type ReviewComment,
  type ReviewResult,
  type ReviewSeverity,
  type VerificationDecision
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

/** A proposed finding the verification gate dropped, retained for the owner-only audit ("dropped findings"). */
export interface DroppedFinding {
  readonly filePath: string;
  readonly line: number;
  readonly severity: ReviewSeverity;
  readonly category: ReviewCategory;
  readonly title: string;
  /** Why the gate dropped it (verification reason or "below confidence bar"). */
  readonly reason: string;
  /** Verification confidence (0..1) at drop time. */
  readonly confidence: number;
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
  /** Reasoning effort the model used for this review. */
  readonly reasoningEffort?: string;
  /** When the reviewed PR iteration was created/pushed (ISO), for time-to-review latency. */
  readonly iterationCreatedAt?: string;
  /** Findings the verification gate dropped this iteration (owner-only audit view). */
  readonly droppedFindings?: readonly DroppedFinding[];
  /** Size in bytes of the review prompt sent to the model (input-size proxy; cost is a non-concern). */
  readonly promptBytes?: number;
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

/** ADO thread statuses where the author explicitly DECLINED the finding (won't-fix / by-design). Never reactivate. */
function isAuthorDeclinedStatus(status: string | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  const normalized = status.toLowerCase();
  return ['wontfix', 'bydesign', '3', '5'].includes(normalized);
}

/** ADO thread statuses that mean the author engaged with the thread (attempted a fix), not ignored it. */
function isAuthorAttemptedFixStatus(status: string | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  const normalized = status.toLowerCase();
  return ['fixed', 'closed', '2', '4'].includes(normalized);
}

/** ADO thread statuses that are still open/unaddressed (active or pending). */
function isOpenThreadStatus(status: string | undefined): boolean {
  if (status === undefined) {
    return true;
  }
  const normalized = status.toLowerCase();
  return ['active', '1', 'pending', '6'].includes(normalized);
}

/**
 * Auto-resolve pass: a Saturn thread that is still open, was NOT re-raised this iteration, and whose file
 * we actually reviewed is treated as addressed and set to Fixed (status 2). Threads the author declined or
 * replied on are skipped (respect the author / never close an active human discussion). Returns the count
 * resolved. Only call when posting.
 */
async function autoResolveAddressedThreads(
  repoRoot: string,
  pullRequestId: number,
  iterationId: number | undefined,
  reviewedFilePaths: ReadonlySet<string>,
  matchedSaturnThreadIds: ReadonlySet<number>,
  existingThreads: readonly ExistingThreadComment[],
  logger: Logger
): Promise<number> {
  let resolved = 0;
  for (const thread of existingThreads) {
    if (
      thread.threadId === undefined ||
      !thread.isSaturn ||
      thread.hasHumanReply ||
      !isOpenThreadStatus(thread.status) ||
      matchedSaturnThreadIds.has(thread.threadId) ||
      thread.filePath === '' ||
      !reviewedFilePaths.has(thread.filePath)
    ) {
      continue;
    }
    try {
      // status 2 = Fixed.
      await setThreadStatus(
        repoRoot,
        pullRequestId,
        thread.threadId,
        2,
        `This looks addressed as of iteration ${String(iterationId ?? 0)} - resolving. ${buildIterationTag(iterationId ?? 0)}`
      );
      resolved += 1;
    } catch (error) {
      logger.warn(
        `PR #${String(pullRequestId)}: failed to auto-resolve thread ${String(thread.threadId)}: ${describeError(error)}`
      );
    }
  }
  return resolved;
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

/** A proposed comment kept by the gate, plus the candidates it dropped (for the owner-only audit view). */
interface VerificationOutcome {
  readonly kept: readonly ReviewComment[];
  readonly dropped: readonly DroppedFinding[];
}

/**
 * The confidence bar a verified finding must clear to be posted. Security/privacy/correctness are expensive
 * to miss and concrete to verify, so they pass at a moderate bar; design/api/testing/style nits are the
 * "stupid comment" risk, so they require high confidence (precision-first).
 */
function confidenceBarFor(category: ReviewCategory): number {
  return category === 'security' || category === 'privacy' || category === 'correctness' ? 0.5 : 0.8;
}

/**
 * Read the author's reply on one of Saturn's threads and classify it (acknowledged / dismissed / question /
 * other), drafting an answer when the author asked a question. Returns undefined on any model/parse failure
 * (the caller then falls back to the safe "hands off, don't reactivate" behavior).
 */
async function classifyThreadReply(
  thread: ExistingThreadComment,
  finding: ReviewComment,
  deps: ReviewPullRequestDeps,
  timeoutMs: number
): Promise<ReplyClassification | undefined> {
  if (thread.humanReplyText === '') {
    return undefined;
  }
  const result = await runCopilotReview({
    cliPath: deps.cliPath,
    prompt: buildReplyClassificationPrompt(finding, thread.humanReplyText),
    model: deps.model,
    reasoningEffort: deps.reasoningEffort,
    cwd: deps.repoRoot,
    timeoutMs,
    allowMcpServerName: deps.allowMcpServerName
  });
  if (result.status !== 0) {
    return undefined;
  }
  return parseReplyClassification(result.stdout);
}

/**
 * Verification gate: a second model pass re-checks each proposed comment INDEPENDENTLY against the real
 * code, returning a per-candidate keep/drop with a confidence and reason. A kept candidate is posted only
 * if its confidence clears the per-category bar; everything else is recorded as a dropped finding. On any
 * failure every candidate is dropped, so Saturn fails closed (never posts unverified comments).
 */
async function verifyComments(
  pullRequest: PullRequestSummary,
  comments: readonly ReviewComment[],
  deps: ReviewPullRequestDeps,
  timeoutMs: number
): Promise<VerificationOutcome> {
  deps.logger.info(
    `PR #${String(pullRequest.pullRequestId)}: verifying ${String(comments.length)} proposed comment(s)...`
  );
  const dropAll = (reason: string): VerificationOutcome => ({
    kept: [],
    dropped: comments.map((comment) => ({
      filePath: comment.filePath,
      line: comment.line,
      severity: comment.severity,
      category: comment.category,
      title: comment.title,
      reason,
      confidence: 0
    }))
  });

  const result = await runCopilotReview({
    cliPath: deps.cliPath,
    prompt: buildVerificationPrompt(pullRequest, comments),
    model: deps.model,
    reasoningEffort: deps.reasoningEffort,
    cwd: deps.repoRoot,
    timeoutMs,
    allowMcpServerName: deps.allowMcpServerName
  });
  if (result.status !== 0) {
    deps.logger.warn(`PR #${String(pullRequest.pullRequestId)}: verification call failed; dropping all comments.`);
    return dropAll('verification call failed');
  }

  const verdict = parseVerificationResult(result.stdout);
  if (verdict === undefined) {
    deps.logger.warn(
      `PR #${String(pullRequest.pullRequestId)}: unparseable verification verdict; dropping all comments.`
    );
    return dropAll('unparseable verification verdict');
  }

  const decisionByIndex = new Map<number, VerificationDecision>();
  for (const decision of verdict.decisions) {
    decisionByIndex.set(decision.index, decision);
  }

  const kept: ReviewComment[] = [];
  const dropped: DroppedFinding[] = [];
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index];
    const decision = decisionByIndex.get(index);
    const confidence = decision?.confidence ?? 0;
    // No decision for a candidate is a drop (fail closed). A kept candidate must also clear the bar.
    if (decision?.keep === true && confidence >= confidenceBarFor(comment.category)) {
      kept.push({ ...comment, confidence });
    } else {
      dropped.push({
        filePath: comment.filePath,
        line: comment.line,
        severity: comment.severity,
        category: comment.category,
        title: comment.title,
        reason:
          decision === undefined
            ? 'no verification decision returned'
            : decision.keep
              ? `kept but below confidence bar (${confidence.toFixed(2)})`
              : decision.reason !== ''
                ? decision.reason
                : 'dropped by verification gate',
        confidence
      });
    }
  }
  return { kept, dropped };
}

/**
 * Scale the model timeout up for large PRs (more files and more diff lines need more time to review well),
 * never below the configured floor and capped at 3x so a runaway can't stall the queue. The floor is kept
 * exactly as configured - the minimum timeout is never shortened.
 */
function adaptiveReviewTimeoutMs(baseTimeoutMs: number, fileCount: number, diffLineCount: number): number {
  const sizeUnits = fileCount + diffLineCount / 400;
  const factor = 1 + sizeUnits / 40;
  return Math.min(Math.round(baseTimeoutMs * factor), baseTimeoutMs * 3);
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
      iterationCreatedAt,
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
    // Larger PRs get a proportionally longer (capped) timeout so big diffs are not cut off mid-review; the
    // configured timeout remains the floor and is never shortened.
    const effectiveTimeoutMs = adaptiveReviewTimeoutMs(
      deps.reviewTimeoutMs,
      fileInputs.length,
      diffPayload.text.split('\n').length
    );
    // Fetch the PR description so the reviewer can judge the change against the author's stated intent.
    const prDescription = await getPullRequestDescription(repoRoot, pullRequestId);
    const prompt = buildReviewPrompt({
      pullRequest: prDescription === undefined ? pullRequest : { ...pullRequest, description: prDescription },
      diffPayload,
      changedFiles: selectedFiles,
      maxComments: deps.maxComments
    });
    const reviewMeta = {
      model: deps.model,
      reasoningEffort: deps.reasoningEffort,
      filesReviewed: fileInputs.length,
      filesChanged: changedFiles.length,
      diffTruncated: diffPayload.truncated,
      iterationCreatedAt,
      // Input-size proxy (cost is a non-concern; this just confirms we feed a large context, not trim it).
      promptBytes: Buffer.byteLength(prompt, 'utf8')
    };

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
        timeoutMs: effectiveTimeoutMs,
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
      // No blocking findings this iteration: anything Saturn previously flagged on a file we just reviewed is
      // therefore addressed - auto-resolve those threads (when posting). Then stay silent (no "all clear").
      if (deps.post) {
        const priorThreads = await getExistingThreadComments(repoRoot, pullRequestId);
        const reviewedPaths = new Set(selectedFiles.map((file) => file.path));
        const autoResolved = await autoResolveAddressedThreads(
          repoRoot,
          pullRequestId,
          iterationId,
          reviewedPaths,
          new Set<number>(),
          priorThreads,
          logger
        );
        if (autoResolved > 0) {
          logger.info(`PR #${String(pullRequestId)}: auto-resolved ${String(autoResolved)} addressed thread(s).`);
        }
      }
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

    // Verification gate: a second model pass re-checks each proposed comment INDEPENDENTLY and keeps only
    // the verified, material ones that clear the per-category confidence bar. Dropped candidates are
    // retained for the owner-only audit view. Saturn never posts a comment that fails this gate.
    const verification = await verifyComments(pullRequest, comments, deps, effectiveTimeoutMs);
    // Per-path lens config: drop findings whose category is suppressed for their file (e.g. design/api nits
    // in test files). security/privacy/correctness are never suppressed. Suppressed ones join the audit list.
    const verifiedComments: ReviewComment[] = [];
    const lensDropped: DroppedFinding[] = [];
    for (const candidate of verification.kept) {
      if (suppressedCategoriesForPath(candidate.filePath).has(candidate.category)) {
        lensDropped.push({
          filePath: candidate.filePath,
          line: candidate.line,
          severity: candidate.severity,
          category: candidate.category,
          title: candidate.title,
          reason: 'suppressed by per-path lens config',
          confidence: candidate.confidence ?? 0
        });
      } else {
        verifiedComments.push(candidate);
      }
    }
    const droppedFindings: readonly DroppedFinding[] = [...verification.dropped, ...lensDropped];
    // Post the highest-severity findings first (streaming-style) so the most important feedback lands even if
    // a later post fails - blocking, then major, then minor, then nit. Verification still gates everything.
    const severityRank: Record<ReviewSeverity, number> = { blocking: 0, major: 1, minor: 2, nit: 3 };
    verifiedComments.sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
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
        candidatesKept: 0,
        droppedFindings
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
        candidatesKept: verifiedComments.length,
        droppedFindings
      };
    }

    // Fetch the PR's current threads so Saturn never opens a duplicate: it reactivates and replies on its
    // own prior thread when the issue still applies, and stays silent when a human already said the same.
    const existingThreads = await getExistingThreadComments(repoRoot, pullRequestId);
    const iterationTag = iterationId === undefined ? undefined : buildIterationTag(iterationId);
    const matchedSaturnThreadIds = new Set<number>();
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
        if (thread.threadId !== undefined) {
          // This Saturn thread was re-raised this iteration, so it must not be auto-resolved below.
          matchedSaturnThreadIds.add(thread.threadId);
        }
        // Already handled on this thread for this iteration (e.g. an error-retry of the same iteration)?
        // The hidden iteration tag in the reply makes reactivation idempotent, so don't reply twice.
        if (thread.threadId === undefined || (iterationTag !== undefined && thread.content.includes(iterationTag))) {
          skippedDuplicates += 1;
          continue;
        }

        // Respect the author's disposition: never reactivate a thread the author declined (won't-fix /
        // by-design).
        if (isAuthorDeclinedStatus(thread.status)) {
          skippedDuplicates += 1;
          continue;
        }

        // The author replied on this thread - READ the reply instead of blindly reactivating. Classify it:
        // a dismissal means leave it (and don't re-raise); a question gets a concise answer; anything else
        // is treated as "the author is engaged", so Saturn stays hands-off this iteration.
        if (thread.hasHumanReply) {
          const classification = await classifyThreadReply(thread, comment, deps, effectiveTimeoutMs);
          const disposition = classification?.disposition ?? 'other';
          if (
            disposition === 'question' &&
            thread.lastCommentIsHuman &&
            classification !== undefined &&
            classification.answer.trim() !== ''
          ) {
            try {
              await postThreadReply(
                repoRoot,
                pullRequestId,
                thread.threadId,
                `${classification.answer.trim()}\n\n${BOT_REVIEW_MARKER}`
              );
              logger.info(
                `PR #${String(pullRequestId)}: answered the author's question on thread ${String(thread.threadId)}.`
              );
            } catch (error) {
              logger.warn(
                `PR #${String(pullRequestId)}: failed to answer thread ${String(thread.threadId)}: ${describeError(error)}`
              );
            }
          } else if (disposition === 'dismissed') {
            logger.info(
              `PR #${String(pullRequestId)}: author dismissed the finding on thread ${String(thread.threadId)} - suppressing, not reactivating.`
            );
          }
          // In every replied-thread case, do not reactivate (respect the author's engagement).
          skippedDuplicates += 1;
          continue;
        }

        // A low-severity finding (nit/minor) already has an open thread; don't post a "still applies" reply
        // on a new iteration - that would only add noise. The existing thread stays active and visible.
        if (!severityRequiresAuthorAction(comment.severity)) {
          skippedDuplicates += 1;
          continue;
        }

        try {
          // A fixed/closed thread means the author engaged with it (attempted a fix); an active one means
          // the issue is still open and unaddressed. The reply explains which case applies.
          await reactivateThreadAndReply(
            repoRoot,
            pullRequestId,
            thread.threadId,
            buildReactivationReply({
              iterationId: iterationId ?? 0,
              authorAttemptedFix: isAuthorAttemptedFixStatus(thread.status),
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
        // Lead each posted comment with the same severity + title shown on the dashboard, so a nit reads
        // "NIT - ..." right in the comment. Saturn's attribution/disclaimer is prepended too. Every kept
        // finding is posted ACTIVE/actionable (we no longer post low-severity findings already-resolved).
        const finding = `${buildFindingHeader(comment.severity, comment.title)}\n\n${comment.body}`;
        const threadId = await postInlineComment(
          repoRoot,
          pullRequestId,
          { ...comment, body: buildCommentWithDisclaimer(finding, deps.onBehalfOf) },
          false
        );
        commentsPosted += 1;
        postedComments.push({ ...comment, threadId, deepLink: buildCommentDeepLink(pullRequestId, threadId) });
      } catch (error) {
        logger.warn(
          `PR #${String(pullRequestId)}: failed to post comment on ${comment.filePath}:${String(comment.line)}: ${describeError(error)}`
        );
      }
    }

    // Auto-resolve any of Saturn's own open threads on reviewed files that this iteration did NOT re-raise
    // (the author addressed them). Declined/human-replied threads are respected inside the helper.
    const reviewedFilePaths = new Set(selectedFiles.map((file) => file.path));
    const commentsResolved = await autoResolveAddressedThreads(
      repoRoot,
      pullRequestId,
      iterationId,
      reviewedFilePaths,
      matchedSaturnThreadIds,
      existingThreads,
      logger
    );

    logger.info(
      `PR #${String(pullRequestId)}: posted ${String(commentsPosted)} new comment(s)` +
        (commentsReactivated > 0 ? `, reactivated ${String(commentsReactivated)}` : '') +
        (commentsResolved > 0 ? `, auto-resolved ${String(commentsResolved)}` : '') +
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
      candidatesKept: verifiedComments.length,
      droppedFindings
    };
  } catch (error) {
    return {
      pullRequestId,
      status: 'error',
      commentsPosted: 0,
      iterationId,
      detail: describeError(error),
      model: deps.model,
      reasoningEffort: deps.reasoningEffort,
      durationMs: Date.now() - startedAtMs
    };
  }
}
