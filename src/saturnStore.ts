import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** A single comment Saturn surfaced for a reviewed pull request iteration. */
export interface StoredComment {
  readonly filePath: string;
  readonly line: number;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string;
  /** ADO thread id this comment was posted to (enables dedup/reactivation across iterations). */
  readonly threadId?: number;
}

/** A persisted record of one reviewed iteration of a pull request. */
export interface StoredIterationReview {
  readonly iterationId: number;
  readonly status: string;
  readonly commentsPosted: number;
  readonly detail: string;
  readonly comments: readonly StoredComment[];
  readonly reviewedAt: string;
}

/** A persisted record of a reviewed pull request, with one entry per reviewed iteration. */
export interface StoredReview {
  readonly pullRequestId: number;
  readonly title: string;
  readonly author: string;
  readonly webUrl: string;
  readonly iterations: readonly StoredIterationReview[];
}

/** The persisted Saturn review history (every reviewed PR, newest reviewed first). */
export interface StoredSaturnState {
  readonly totalReviewed: number;
  readonly reviews: readonly StoredReview[];
}

const commentSchema = z.object({
  filePath: z.string(),
  line: z.number(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  deepLink: z.string(),
  threadId: z.number().optional()
});

const iterationSchema = z.object({
  iterationId: z.number(),
  status: z.string(),
  commentsPosted: z.number(),
  detail: z.string(),
  comments: z.array(commentSchema),
  reviewedAt: z.string()
});

const reviewSchema = z.object({
  pullRequestId: z.number(),
  title: z.string(),
  author: z.string(),
  webUrl: z.string(),
  iterations: z.array(iterationSchema)
});

// Legacy single-file state (pre-iteration). Read once to migrate into the per-PR files.
const legacyReviewSchema = z.object({
  pullRequestId: z.number(),
  title: z.string(),
  author: z.string(),
  webUrl: z.string(),
  status: z.string(),
  commentsPosted: z.number(),
  detail: z.string(),
  comments: z.array(commentSchema),
  reviewedAt: z.string()
});
const legacyStateSchema = z.object({ totalReviewed: z.number(), reviews: z.array(legacyReviewSchema) });

const totalsSchema = z.object({ totalReviewed: z.number() });

function saturnDir(): string {
  return path.join(os.homedir(), '.saturn');
}
function reviewsDir(): string {
  return path.join(saturnDir(), 'reviews');
}
function reviewFilePath(pullRequestId: number): string {
  return path.join(reviewsDir(), `${String(pullRequestId)}.json`);
}
function totalsFilePath(): string {
  return path.join(saturnDir(), 'totals.json');
}
function legacyStateFilePath(): string {
  return path.join(saturnDir(), 'state.json');
}

/** Latest reviewedAt (epoch ms) across a PR's iterations; used to sort PRs newest-reviewed first. */
function latestReviewedAtMs(review: StoredReview): number {
  let latest = 0;
  for (const iteration of review.iterations) {
    const time = Date.parse(iteration.reviewedAt);
    if (!Number.isNaN(time) && time > latest) {
      latest = time;
    }
  }
  return latest;
}

function readTotals(): number {
  try {
    if (existsSync(totalsFilePath())) {
      const parsed = totalsSchema.safeParse(JSON.parse(readFileSync(totalsFilePath(), 'utf8')));
      if (parsed.success) {
        return parsed.data.totalReviewed;
      }
    }
  } catch {
    /* ignore a corrupt totals file */
  }
  return 0;
}

function writeTotals(totalReviewed: number): void {
  try {
    mkdirSync(saturnDir(), { recursive: true });
    writeFileSync(totalsFilePath(), `${JSON.stringify({ totalReviewed }, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort persistence */
  }
}

/** One-time migration of the legacy single-file store into per-PR files (each as iteration 1). */
function migrateLegacyStateIfNeeded(): void {
  const legacyPath = legacyStateFilePath();
  if (!existsSync(legacyPath) || existsSync(reviewsDir())) {
    return;
  }
  try {
    const parsed = legacyStateSchema.safeParse(JSON.parse(readFileSync(legacyPath, 'utf8')));
    if (!parsed.success) {
      return;
    }
    mkdirSync(reviewsDir(), { recursive: true });
    for (const legacy of parsed.data.reviews) {
      const review: StoredReview = {
        pullRequestId: legacy.pullRequestId,
        title: legacy.title,
        author: legacy.author,
        webUrl: legacy.webUrl,
        iterations: [
          {
            iterationId: 1,
            status: legacy.status,
            commentsPosted: legacy.commentsPosted,
            detail: legacy.detail,
            comments: legacy.comments,
            reviewedAt: legacy.reviewedAt
          }
        ]
      };
      writeFileSync(reviewFilePath(legacy.pullRequestId), `${JSON.stringify(review, null, 2)}\n`, 'utf8');
    }
    writeTotals(parsed.data.totalReviewed);
  } catch {
    /* best-effort migration */
  }
}

/** Read a single pull request's stored review (all iterations), or undefined if never reviewed. */
export function readPullRequestReview(pullRequestId: number): StoredReview | undefined {
  migrateLegacyStateIfNeeded();
  const filePath = reviewFilePath(pullRequestId);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = reviewSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    /* ignore a corrupt per-PR file */
  }
  return undefined;
}

/** Read every stored pull-request review, sorted by most-recently-reviewed first. */
export function readAllPullRequestReviews(): readonly StoredReview[] {
  migrateLegacyStateIfNeeded();
  const dir = reviewsDir();
  if (!existsSync(dir)) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const reviews: StoredReview[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const parsed = reviewSchema.safeParse(JSON.parse(readFileSync(path.join(dir, entry), 'utf8')));
      if (parsed.success) {
        reviews.push(parsed.data);
      }
    } catch {
      /* skip a corrupt per-PR file */
    }
  }
  reviews.sort((left, right) => {
    const byReviewedAt = latestReviewedAtMs(right) - latestReviewedAtMs(left);
    return byReviewedAt !== 0 ? byReviewedAt : right.pullRequestId - left.pullRequestId;
  });
  return reviews;
}

/** Read the aggregate Saturn state: running total plus every reviewed PR (newest reviewed first). */
export function readSaturnState(): StoredSaturnState {
  return { totalReviewed: readTotals(), reviews: readAllPullRequestReviews() };
}

/** An opaque-cursor batch of reviewed pull requests for the dashboard's infinite scroll. */
export interface ReviewsCursorPage {
  /** This batch of reviews (newest reviewed first). */
  readonly items: readonly StoredReview[];
  /** Cursor to pass back for the next (older) batch, or null when the end is reached. */
  readonly nextCursor: string | null;
  /** Total number of reviewed pull requests (for display). */
  readonly total: number;
}

// A cursor marks a position in the newest-first ordering: the (latest-reviewed-at, pull-request-id) of the
// last item already returned. The next batch is everything strictly older than it in that total order, which
// keeps paging stable even when fresh reviews are inserted at the top while the user scrolls.
const reviewCursorSchema = z.object({ t: z.number(), id: z.number() });

function encodeReviewCursor(review: StoredReview): string {
  return Buffer.from(JSON.stringify({ t: latestReviewedAtMs(review), id: review.pullRequestId })).toString('base64url');
}

function decodeReviewCursor(raw: string | undefined): { t: number; id: number } | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  try {
    const parsed = reviewCursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Read one cursor batch of reviewed pull requests, newest reviewed first (for infinite scroll). */
export function readReviewsCursor(cursor: string | undefined, limit: number): ReviewsCursorPage {
  const safeLimit = limit > 0 ? Math.min(limit, 100) : 25;
  const all = readAllPullRequestReviews();
  const after = decodeReviewCursor(cursor);
  let startIndex = 0;
  if (after !== undefined) {
    const index = all.findIndex((review) => {
      const reviewedAt = latestReviewedAtMs(review);
      return reviewedAt < after.t || (reviewedAt === after.t && review.pullRequestId < after.id);
    });
    startIndex = index === -1 ? all.length : index;
  }
  const items = all.slice(startIndex, startIndex + safeLimit);
  const last = items.at(-1);
  const nextCursor = last !== undefined && startIndex + items.length < all.length ? encodeReviewCursor(last) : null;
  return { items, nextCursor, total: all.length };
}

/** Cheap summary for the dashboard status poll: running total and number of reviewed PRs. */
export function getReviewSummary(): { readonly totalReviewed: number; readonly reviewedPullRequestCount: number } {
  migrateLegacyStateIfNeeded();
  let reviewedPullRequestCount = 0;
  try {
    if (existsSync(reviewsDir())) {
      reviewedPullRequestCount = readdirSync(reviewsDir()).filter((entry) => entry.endsWith('.json')).length;
    }
  } catch {
    /* ignore */
  }
  return { totalReviewed: readTotals(), reviewedPullRequestCount };
}

/** Identifying metadata for a reviewed pull request. */
export interface PullRequestIdentity {
  readonly pullRequestId: number;
  readonly title: string;
  readonly author: string;
  readonly webUrl: string;
}

/**
 * Upsert one reviewed iteration into the pull request's per-PR file, retaining all older iterations
 * so the full history is kept (no cap). `countsAsReviewed` increments the running total (true for
 * real reviews, false for errors). Re-reads before writing so the CLI and dashboard processes coexist.
 */
export function recordSaturnReview(
  pullRequest: PullRequestIdentity,
  iteration: StoredIterationReview,
  countsAsReviewed: boolean
): void {
  migrateLegacyStateIfNeeded();
  const existing = readPullRequestReview(pullRequest.pullRequestId);
  const iterations = [
    ...(existing?.iterations ?? []).filter((entry) => entry.iterationId !== iteration.iterationId),
    iteration
  ].sort((left, right) => left.iterationId - right.iterationId);
  const review: StoredReview = {
    pullRequestId: pullRequest.pullRequestId,
    title: pullRequest.title,
    author: pullRequest.author,
    webUrl: pullRequest.webUrl,
    iterations
  };
  try {
    mkdirSync(reviewsDir(), { recursive: true });
    writeFileSync(reviewFilePath(pullRequest.pullRequestId), `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort persistence */
  }
  if (countsAsReviewed) {
    writeTotals(readTotals() + 1);
  }
}

/** A thumbs rating attached to a feedback submission. */
export type FeedbackRating = 'up' | 'down' | 'none';

/** A single piece of feedback a reviewer submitted on one of Saturn's review comments. */
export interface StoredFeedback {
  readonly id: string;
  readonly pullRequestId: number;
  readonly commentId: number;
  readonly submittedBy: string;
  readonly rating: FeedbackRating;
  readonly message: string;
  readonly submittedAt: string;
}

const feedbackSchema = z.object({
  id: z.string(),
  pullRequestId: z.number(),
  commentId: z.number(),
  submittedBy: z.string(),
  rating: z.enum(['up', 'down', 'none']),
  message: z.string(),
  submittedAt: z.string()
});
const feedbackListSchema = z.array(feedbackSchema);

function feedbackFilePath(): string {
  return path.join(saturnDir(), 'feedback.json');
}

/** Read every submitted feedback entry, most recent first. */
export function readAllFeedback(): readonly StoredFeedback[] {
  try {
    if (existsSync(feedbackFilePath())) {
      const parsed = feedbackListSchema.safeParse(JSON.parse(readFileSync(feedbackFilePath(), 'utf8')));
      if (parsed.success) {
        return [...parsed.data].sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt));
      }
    }
  } catch {
    /* ignore a corrupt feedback file */
  }

  return [];
}

/** Append one feedback entry (re-reading first so concurrent writers coexist); returns the stored record. */
export function recordFeedback(entry: {
  readonly pullRequestId: number;
  readonly commentId: number;
  readonly submittedBy: string;
  readonly rating: FeedbackRating;
  readonly message: string;
}): StoredFeedback {
  const stored: StoredFeedback = {
    id: randomUUID(),
    pullRequestId: entry.pullRequestId,
    commentId: entry.commentId,
    submittedBy: entry.submittedBy,
    rating: entry.rating,
    message: entry.message,
    submittedAt: new Date().toISOString()
  };
  const existing = readAllFeedback();
  try {
    mkdirSync(saturnDir(), { recursive: true });
    writeFileSync(feedbackFilePath(), `${JSON.stringify([stored, ...existing], null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort persistence */
  }

  return stored;
}
