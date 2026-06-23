// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** A single comment Saturn surfaced for a reviewed pull request iteration. */
export interface StoredComment {
  readonly filePath: string;
  readonly line: number;
  readonly severity: string;
  /** Review lens/aspect (security|privacy|correctness|design|api|testing); optional on legacy records. */
  readonly category?: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string;
  /** ADO thread id this comment was posted to (enables dedup/reactivation across iterations). */
  readonly threadId?: number;
  /** Verification-gate confidence (0..1) that this finding is correct and material (optional on legacy records). */
  readonly confidence?: number;
  /** Stable finding identity (survives line drift) for the per-PR ledger / future calibration. */
  readonly findingId?: string;
  /** Ledger state: 'open' for a posted finding (optional on legacy records). */
  readonly state?: string;
}

/** A finding the verification gate dropped, retained for the owner-only audit view. */
export interface StoredDroppedFinding {
  readonly filePath: string;
  readonly line: number;
  readonly severity: string;
  readonly category?: string;
  readonly title: string;
  readonly reason: string;
  readonly confidence: number;
  /** Stable finding identity (survives line drift) for the per-PR ledger / future calibration. */
  readonly findingId?: string;
  /** Ledger state: 'dropped' for a gate/lens-dropped finding (optional on legacy records). */
  readonly state?: string;
}

/** A persisted record of one reviewed iteration of a pull request. */
export interface StoredIterationReview {
  readonly iterationId: number;
  readonly status: string;
  readonly commentsPosted: number;
  readonly detail: string;
  readonly comments: readonly StoredComment[];
  readonly reviewedAt: string;
  /** How long the review took, in ms (optional on legacy records). */
  readonly durationMs?: number;
  /** Model that produced the review. */
  readonly model?: string;
  /** Files sent to the model vs. total changed (a gap means the diff was truncated). */
  readonly filesReviewed?: number;
  readonly filesChanged?: number;
  /** True when the diff context was truncated (the review may be partial). */
  readonly diffTruncated?: boolean;
  /** Findings the first pass proposed vs. how many survived the verification gate. */
  readonly candidatesProposed?: number;
  readonly candidatesKept?: number;
  /** Reasoning effort used for the review. */
  readonly reasoningEffort?: string;
  /** When the reviewed PR iteration was created/pushed (ISO), for time-to-review latency. */
  readonly iterationCreatedAt?: string;
  /** Findings the verification gate dropped this iteration (owner-only audit). */
  readonly droppedFindings?: readonly StoredDroppedFinding[];
  /** Size in bytes of the review prompt (input-size proxy; cost is a non-concern). */
  readonly promptBytes?: number;
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
  category: z.string().optional(),
  title: z.string(),
  body: z.string(),
  deepLink: z.string(),
  threadId: z.number().optional(),
  confidence: z.number().optional(),
  findingId: z.string().optional(),
  state: z.string().optional()
});

const droppedFindingSchema = z.object({
  filePath: z.string(),
  line: z.number(),
  severity: z.string(),
  category: z.string().optional(),
  title: z.string(),
  reason: z.string(),
  confidence: z.number(),
  findingId: z.string().optional(),
  state: z.string().optional()
});

const iterationSchema = z.object({
  iterationId: z.number(),
  status: z.string(),
  commentsPosted: z.number(),
  detail: z.string(),
  comments: z.array(commentSchema),
  reviewedAt: z.string(),
  durationMs: z.number().optional(),
  model: z.string().optional(),
  filesReviewed: z.number().optional(),
  filesChanged: z.number().optional(),
  diffTruncated: z.boolean().optional(),
  candidatesProposed: z.number().optional(),
  candidatesKept: z.number().optional(),
  reasoningEffort: z.string().optional(),
  iterationCreatedAt: z.string().optional(),
  droppedFindings: z.array(droppedFindingSchema).optional(),
  promptBytes: z.number().optional()
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

let reviewsCache: { readonly signature: string; readonly reviews: readonly StoredReview[] } | undefined;

/** A cheap signature of the reviews directory (file count + newest mtime) used to invalidate the cache. */
function reviewsDirSignature(): string {
  try {
    const dir = reviewsDir();
    if (!existsSync(dir)) {
      return 'none';
    }
    const entries = readdirSync(dir).filter((entry) => entry.endsWith('.json'));
    let newestMtimeMs = 0;
    for (const entry of entries) {
      const mtimeMs = statSync(path.join(dir, entry)).mtimeMs;
      if (mtimeMs > newestMtimeMs) {
        newestMtimeMs = mtimeMs;
      }
    }
    return `${String(entries.length)}:${String(newestMtimeMs)}`;
  } catch {
    return `err:${String(Date.now())}`;
  }
}

/**
 * Read every stored pull-request review, sorted by most-recently-reviewed first. Results are cached in
 * memory and re-read only when the reviews directory changes (a file is added or rewritten), so the
 * always-on dashboard's stats + each cursor page don't re-parse every per-PR file on every call.
 */
export function readAllPullRequestReviews(): readonly StoredReview[] {
  migrateLegacyStateIfNeeded();
  const signature = reviewsDirSignature();
  if (reviewsCache?.signature === signature) {
    return reviewsCache.reviews;
  }
  const dir = reviewsDir();
  if (!existsSync(dir)) {
    reviewsCache = { signature, reviews: [] };
    return reviewsCache.reviews;
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
  reviewsCache = { signature, reviews };
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

/** Optional filters narrowing the reviewed-PR list (all applied with AND). */
export interface ReviewFilters {
  /** Latest-iteration status ('reviewed' | 'no-findings' | 'error'), or 'has-findings' for any iteration with comments. */
  readonly status?: string;
  /** Only PRs with at least one finding in this category, across any iteration. */
  readonly category?: string;
  /** Case-insensitive substring of the author display name. */
  readonly author?: string;
  /** Case-insensitive substring matched against PR id, title, and author. */
  readonly search?: string;
  /** Only PRs last reviewed at or after this epoch-ms. */
  readonly fromMs?: number;
  /** Only PRs last reviewed at or before this epoch-ms. */
  readonly toMs?: number;
}

/** The most-recently-reviewed iteration of a PR (highest iteration id). */
function latestIterationOf(review: StoredReview): StoredIterationReview | undefined {
  let latest: StoredIterationReview | undefined;
  for (const iteration of review.iterations) {
    if (latest === undefined || iteration.iterationId > latest.iterationId) {
      latest = iteration;
    }
  }
  return latest;
}

/** The set of finding categories Saturn ever raised on a PR (across all iterations). */
function reviewCategories(review: StoredReview): Set<string> {
  const categories = new Set<string>();
  for (const iteration of review.iterations) {
    for (const comment of iteration.comments) {
      if (comment.category !== undefined && comment.category !== '') {
        categories.add(comment.category);
      }
    }
  }
  return categories;
}

function matchesFilters(review: StoredReview, filters: ReviewFilters): boolean {
  const reviewedAt = latestReviewedAtMs(review);
  if (filters.fromMs !== undefined && reviewedAt < filters.fromMs) {
    return false;
  }
  if (filters.toMs !== undefined && reviewedAt > filters.toMs) {
    return false;
  }
  if (filters.status !== undefined && filters.status !== '') {
    if (filters.status === 'has-findings') {
      if (!review.iterations.some((iteration) => iteration.comments.length > 0)) {
        return false;
      }
    } else if ((latestIterationOf(review)?.status ?? '') !== filters.status) {
      return false;
    }
  }
  if (filters.category !== undefined && filters.category !== '' && !reviewCategories(review).has(filters.category)) {
    return false;
  }
  if (
    filters.author !== undefined &&
    filters.author !== '' &&
    !review.author.toLowerCase().includes(filters.author.toLowerCase())
  ) {
    return false;
  }
  if (filters.search !== undefined && filters.search !== '') {
    const haystack = `${review.title} ${review.author} ${String(review.pullRequestId)}`.toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/** Read one cursor batch of reviewed pull requests (optionally filtered), newest reviewed first. */
export function readReviewsCursor(
  cursor: string | undefined,
  limit: number,
  filters?: ReviewFilters
): ReviewsCursorPage {
  const safeLimit = limit > 0 ? Math.min(limit, 100) : 25;
  const all = readAllPullRequestReviews().filter((review) => filters === undefined || matchesFilters(review, filters));
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

/** Aggregate health/throughput stats across all reviewed PRs, for the dashboard summary. */
export interface ReviewStats {
  readonly total: number;
  readonly reviewed: number;
  readonly noFindings: number;
  readonly error: number;
  readonly findingsTotal: number;
  readonly bySeverity: Record<string, number>;
  readonly byCategory: Record<string, number>;
  /** Errors grouped by cause (timeout | cli-exit | unparseable | auth | other). */
  readonly errorBreakdown: Record<string, number>;
  /** Average review duration in ms across iterations that recorded one. */
  readonly avgDurationMs: number;
  /** Reviews per day for the last 14 days (oldest first), for the sparkline. */
  readonly daily: readonly { readonly day: string; readonly count: number }[];
  /** Most frequent finding titles (recurring patterns), most common first. */
  readonly topTitles: readonly { readonly title: string; readonly count: number }[];
  /** Files with the most findings (hotspots), most common first. */
  readonly topFiles: readonly { readonly path: string; readonly count: number }[];
  readonly reviewedToday: number;
  readonly reviewedWeek: number;
}

/** Classify an error detail string into a coarse cause, for the dashboard's error-breakdown panel. */
function classifyError(detail: string): string {
  const text = detail.toLowerCase();
  if (text.includes('timed out') || text.includes('timeout')) {
    return 'timeout';
  }
  if (
    text.includes('login') ||
    text.includes('credential') ||
    text.includes('401') ||
    text.includes('403') ||
    text.includes('unauthor')
  ) {
    return 'auth';
  }
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
    return 'rate-limit';
  }
  if (text.includes('could not parse') || text.includes('unparseable') || text.includes('no json')) {
    return 'unparseable';
  }
  if (
    text.includes('enotfound') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('etimedout') ||
    text.includes('fetch failed') ||
    text.includes('socket hang up') ||
    text.includes('network')
  ) {
    return 'network';
  }
  if (
    text.includes('enoent') ||
    text.includes('spawn') ||
    text.includes('could not find the github copilot') ||
    text.includes('not logged in') ||
    text.includes('no output')
  ) {
    return 'cli-missing';
  }
  if (text.includes('exited with code')) {
    return 'cli-exit';
  }
  return 'other';
}

/** Compute aggregate stats (status mix, severity/category/error breakdown, throughput, recurring patterns). */
export function readReviewStats(): ReviewStats {
  const all = readAllPullRequestReviews();
  const now = Date.now();
  const dayAgoMs = now - 24 * 60 * 60 * 1000;
  const weekAgoMs = now - 7 * 24 * 60 * 60 * 1000;
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const errorBreakdown: Record<string, number> = {};
  const titleCounts = new Map<string, { title: string; count: number }>();
  const fileCounts = new Map<string, number>();
  const dayCounts = new Map<string, number>();
  let reviewed = 0;
  let noFindings = 0;
  let error = 0;
  let findingsTotal = 0;
  let reviewedToday = 0;
  let reviewedWeek = 0;
  let durationSum = 0;
  let durationCount = 0;
  for (const review of all) {
    const latest = latestIterationOf(review);
    const status = latest?.status ?? '';
    if (status === 'reviewed') {
      reviewed += 1;
    } else if (status === 'no-findings') {
      noFindings += 1;
    } else if (status === 'error') {
      error += 1;
      const cause = classifyError(latest?.detail ?? '');
      errorBreakdown[cause] = (errorBreakdown[cause] ?? 0) + 1;
    }
    const reviewedAtMs = latestReviewedAtMs(review);
    if (reviewedAtMs >= dayAgoMs) {
      reviewedToday += 1;
    }
    if (reviewedAtMs >= weekAgoMs) {
      reviewedWeek += 1;
    }
    if (reviewedAtMs > 0) {
      const day = new Date(reviewedAtMs).toISOString().slice(0, 10);
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    }
    if (latest?.durationMs !== undefined) {
      durationSum += latest.durationMs;
      durationCount += 1;
    }
    for (const comment of latest?.comments ?? []) {
      findingsTotal += 1;
      bySeverity[comment.severity] = (bySeverity[comment.severity] ?? 0) + 1;
      const category = comment.category !== undefined && comment.category !== '' ? comment.category : 'correctness';
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      const titleKey = comment.title.trim().toLowerCase();
      const existingTitle = titleCounts.get(titleKey);
      if (existingTitle === undefined) {
        titleCounts.set(titleKey, { title: comment.title.trim(), count: 1 });
      } else {
        existingTitle.count += 1;
      }
      if (comment.filePath !== '') {
        fileCounts.set(comment.filePath, (fileCounts.get(comment.filePath) ?? 0) + 1);
      }
    }
  }
  const daily: { day: string; count: number }[] = [];
  for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
    const day = new Date(now - dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    daily.push({ day, count: dayCounts.get(day) ?? 0 });
  }
  const topTitles = [...titleCounts.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => right.count - left.count)
    .slice(0, 8);
  const topFiles = [...fileCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 8);
  return {
    total: all.length,
    reviewed,
    noFindings,
    error,
    findingsTotal,
    bySeverity,
    byCategory,
    errorBreakdown,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    daily,
    topTitles,
    topFiles,
    reviewedToday,
    reviewedWeek
  };
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
