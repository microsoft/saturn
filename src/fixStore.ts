// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/** Lifecycle of a single fix attempt the agent owns end-to-end. */
export type FixTaskStatus =
  | 'selected' // bug picked, work not yet started
  | 'branching' // creating the fix branch off latest default
  | 'fixing' // the model is editing files
  | 'validating' // local build/lint of the change
  | 'pushed' // branch pushed; PR not yet opened
  | 'pr-open' // PR opened, awaiting review/merge
  | 'addressing' // addressing PR feedback / build errors
  | 'merged' // PR merged; local branch cleaned up
  | 'abandoned' // PR abandoned by a human
  | 'failed'; // the agent gave up (see lastError)

/** A fix the agent is (or was) driving from an assigned bug to a merged PR. */
export interface FixTask {
  /** Stable id (the linked bug id as a string, so a bug is never worked twice concurrently). */
  readonly id: string;
  readonly findingId: string;
  readonly bugId: number;
  readonly bugUrl?: string;
  readonly title: string;
  readonly filePath: string;
  readonly package: string;
  /** 1 = single-file fix, 2 = single-package, 3 = anything. */
  readonly phase: 1 | 2 | 3;
  readonly branch: string;
  readonly status: FixTaskStatus;
  readonly prId?: number;
  readonly prUrl?: string;
  /** How many times the agent has pushed (initial + each feedback round). */
  readonly iterations: number;
  /** Human-readable note about the most recent step (shown in the dashboard). */
  readonly lastAction?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt?: string;
}

/** Fields that may be patched on an existing task. */
export interface FixTaskPatch {
  readonly status?: FixTaskStatus;
  readonly branch?: string;
  readonly phase?: 1 | 2 | 3;
  readonly prId?: number;
  readonly prUrl?: string;
  readonly iterations?: number;
  readonly lastAction?: string;
  readonly lastError?: string | null;
  readonly mergedAt?: string;
}

const statusSchema = z
  .enum([
    'selected',
    'branching',
    'fixing',
    'validating',
    'pushed',
    'pr-open',
    'addressing',
    'merged',
    'abandoned',
    'failed'
  ])
  .catch('selected');

const phaseSchema = z
  .number()
  .transform((value) => (value === 2 ? 2 : value === 3 ? 3 : 1))
  .pipe(z.union([z.literal(1), z.literal(2), z.literal(3)]));

const rowSchema = z
  .object({
    id: z.string(),
    findingId: z.string(),
    bugId: z.number(),
    bugUrl: z.string().nullable(),
    title: z.string(),
    filePath: z.string(),
    package: z.string(),
    phase: phaseSchema,
    branch: z.string(),
    status: statusSchema,
    prId: z.number().nullable(),
    prUrl: z.string().nullable(),
    iterations: z.number(),
    lastAction: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    mergedAt: z.string().nullable()
  })
  .loose();

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS fix_tasks (
  id TEXT PRIMARY KEY,
  findingId TEXT NOT NULL,
  bugId INTEGER NOT NULL,
  bugUrl TEXT,
  title TEXT NOT NULL,
  filePath TEXT NOT NULL,
  package TEXT NOT NULL DEFAULT '',
  phase INTEGER NOT NULL DEFAULT 1,
  branch TEXT NOT NULL,
  status TEXT NOT NULL,
  prId INTEGER,
  prUrl TEXT,
  iterations INTEGER NOT NULL DEFAULT 0,
  lastAction TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  mergedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_fix_status ON fix_tasks(status);
CREATE INDEX IF NOT EXISTS idx_fix_updatedAt ON fix_tasks(updatedAt);
CREATE INDEX IF NOT EXISTS idx_fix_findingId ON fix_tasks(findingId);
`;

const INSERT_SQL = `
INSERT OR REPLACE INTO fix_tasks (
  id, findingId, bugId, bugUrl, title, filePath, package, phase, branch, status, prId, prUrl, iterations,
  lastAction, lastError, createdAt, updatedAt, mergedAt
) VALUES (
  :id, :findingId, :bugId, :bugUrl, :title, :filePath, :package, :phase, :branch, :status, :prId, :prUrl,
  :iterations, :lastAction, :lastError, :createdAt, :updatedAt, :mergedAt
)
`;

// Statuses an in-flight task occupies - used for monitoring + the open-task cap.
const ACTIVE_STATUSES = ['selected', 'branching', 'fixing', 'validating', 'pushed', 'pr-open', 'addressing'] as const;

function fixDir(): string {
  const override = process.env.SATURN_FIX_DIR;
  return override !== undefined && override.trim() !== '' ? override : path.join(os.homedir(), '.saturn', 'fix');
}

function dbFilePath(): string {
  return path.join(fixDir(), 'fix.db');
}

function fixWakeFilePath(): string {
  return path.join(fixDir(), 'wake');
}

/**
 * Signal the standalone fix loop to run an iteration immediately (called by the dashboard's ADO webhook).
 * Cross-process: the loop polls the file's mtime during its sleep and breaks early when it changes.
 */
export function signalFixWake(): void {
  try {
    mkdirSync(fixDir(), { recursive: true });
    writeFileSync(fixWakeFilePath(), new Date().toISOString(), 'utf8');
  } catch {
    /* best-effort wake signal */
  }
}

/** True when a wake was signalled (wake-file mtime) after `sinceMs` - lets the loop break its sleep early. */
export function fixWakeRequestedSince(sinceMs: number): boolean {
  try {
    return statSync(fixWakeFilePath()).mtimeMs > sinceMs;
  } catch {
    return false;
  }
}

function fixScopeFilePath(): string {
  return path.join(fixDir(), 'scope.json');
}

const fixScopeSchema = z.object({ paths: z.array(z.string()) }).loose();

function normalizeScopePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    const trimmed = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (trimmed !== '' && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * The package / path-prefix scope for Code Autopilot. When non-empty, the agent only fixes bugs whose
 * footprint touches at least one of these repo-relative prefixes (the fix may still modify files elsewhere).
 * Editable from the dashboard; seeded from SATURN_FIX_SCOPE_PATHS when no file exists yet. Empty = no limit.
 */
export function getFixScopePaths(): readonly string[] {
  try {
    const parsed = fixScopeSchema.safeParse(JSON.parse(readFileSync(fixScopeFilePath(), 'utf8')));
    if (parsed.success) {
      return normalizeScopePaths(parsed.data.paths);
    }
  } catch {
    /* no scope file yet - fall back to the env default */
  }
  return normalizeScopePaths((process.env.SATURN_FIX_SCOPE_PATHS ?? '').split(','));
}

/** Persist the package / path scope (dashboard owner action). Returns the normalized list that was stored. */
export function setFixScopePaths(paths: readonly string[]): readonly string[] {
  const normalized = normalizeScopePaths(paths);
  try {
    mkdirSync(fixDir(), { recursive: true });
    writeFileSync(fixScopeFilePath(), `${JSON.stringify({ paths: normalized }, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort persist */
  }
  return normalized;
}

let dbInstance: DatabaseSync | undefined;
let dbInstancePath: string | undefined;

function getDb(): DatabaseSync {
  const target = dbFilePath();
  if (dbInstance !== undefined && dbInstancePath === target) {
    return dbInstance;
  }
  if (dbInstance !== undefined) {
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
    dbInstance = undefined;
  }
  mkdirSync(fixDir(), { recursive: true });
  const database = new DatabaseSync(target);
  database.exec(TABLE_SQL);
  dbInstance = database;
  dbInstancePath = target;
  return database;
}

/** Close the SQLite handle (used by tests to start from a clean store). */
export function closeFixDb(): void {
  if (dbInstance !== undefined) {
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
    dbInstance = undefined;
    dbInstancePath = undefined;
  }
}

function rowToTask(raw: unknown): FixTask | undefined {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const row = parsed.data;
  return {
    id: row.id,
    findingId: row.findingId,
    bugId: row.bugId,
    ...(row.bugUrl !== null ? { bugUrl: row.bugUrl } : {}),
    title: row.title,
    filePath: row.filePath,
    package: row.package,
    phase: row.phase,
    branch: row.branch,
    status: row.status,
    ...(row.prId !== null ? { prId: row.prId } : {}),
    ...(row.prUrl !== null ? { prUrl: row.prUrl } : {}),
    iterations: row.iterations,
    ...(row.lastAction !== null ? { lastAction: row.lastAction } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.mergedAt !== null ? { mergedAt: row.mergedAt } : {})
  };
}

function mapRows(rows: readonly unknown[]): readonly FixTask[] {
  const result: FixTask[] = [];
  for (const row of rows) {
    const task = rowToTask(row);
    if (task !== undefined) {
      result.push(task);
    }
  }
  return result;
}

/** Inputs to start a new fix task (timestamps + bookkeeping are filled in here). */
export interface NewFixTask {
  readonly id: string;
  readonly findingId: string;
  readonly bugId: number;
  readonly bugUrl?: string;
  readonly title: string;
  readonly filePath: string;
  readonly package: string;
  readonly phase: 1 | 2 | 3;
  readonly branch: string;
}

/** Create and persist a new fix task in the 'selected' state. */
export function createFixTask(input: NewFixTask): FixTask {
  const now = new Date().toISOString();
  const task: FixTask = { ...input, status: 'selected', iterations: 0, createdAt: now, updatedAt: now };
  getDb()
    .prepare(INSERT_SQL)
    .run({
      id: task.id,
      findingId: task.findingId,
      bugId: task.bugId,
      bugUrl: task.bugUrl ?? null,
      title: task.title,
      filePath: task.filePath,
      package: task.package,
      phase: task.phase,
      branch: task.branch,
      status: task.status,
      prId: null,
      prUrl: null,
      iterations: task.iterations,
      lastAction: null,
      lastError: null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      mergedAt: null
    });
  return task;
}

/** Apply a partial update to a task. Column names are literals (no injection); returns the updated task. */
export function updateFixTask(id: string, patch: FixTaskPatch): FixTask | undefined {
  const sets: string[] = ['updatedAt = :updatedAt'];
  const params: Record<string, string | number | null> = { id, updatedAt: new Date().toISOString() };
  if (patch.status !== undefined) {
    sets.push('status = :status');
    params.status = patch.status;
  }
  if (patch.branch !== undefined) {
    sets.push('branch = :branch');
    params.branch = patch.branch;
  }
  if (patch.phase !== undefined) {
    sets.push('phase = :phase');
    params.phase = patch.phase;
  }
  if (patch.prId !== undefined) {
    sets.push('prId = :prId');
    params.prId = patch.prId;
  }
  if (patch.prUrl !== undefined) {
    sets.push('prUrl = :prUrl');
    params.prUrl = patch.prUrl;
  }
  if (patch.iterations !== undefined) {
    sets.push('iterations = :iterations');
    params.iterations = patch.iterations;
  }
  if (patch.lastAction !== undefined) {
    sets.push('lastAction = :lastAction');
    params.lastAction = patch.lastAction;
  }
  if (patch.lastError !== undefined) {
    sets.push('lastError = :lastError');
    params.lastError = patch.lastError;
  }
  if (patch.mergedAt !== undefined) {
    sets.push('mergedAt = :mergedAt');
    params.mergedAt = patch.mergedAt;
  }
  getDb()
    .prepare(`UPDATE fix_tasks SET ${sets.join(', ')} WHERE id = :id`)
    .run(params);
  return getFixTaskById(id);
}

/** Look up a single task by id. */
export function getFixTaskById(id: string): FixTask | undefined {
  return rowToTask(getDb().prepare('SELECT * FROM fix_tasks WHERE id = :id').get({ id }));
}

/** Look up the task for a given finding (so the agent never starts two fixes for the same finding). */
export function getFixTaskByFinding(findingId: string): FixTask | undefined {
  return rowToTask(getDb().prepare('SELECT * FROM fix_tasks WHERE findingId = :findingId LIMIT 1').get({ findingId }));
}

/** All tasks, newest-first, for the dashboard tab. */
export function listFixTasks(
  limit: number,
  offset: number
): { readonly tasks: readonly FixTask[]; readonly total: number } {
  const database = getDb();
  const totalRow = database.prepare('SELECT COUNT(*) AS n FROM fix_tasks').get();
  const total = z.object({ n: z.number() }).safeParse(totalRow).data?.n ?? 0;
  const rows = database
    .prepare('SELECT * FROM fix_tasks ORDER BY updatedAt DESC, createdAt DESC LIMIT :limit OFFSET :offset')
    .all({ limit, offset });
  return { tasks: mapRows(rows), total };
}

/** Tasks still in flight (selected through addressing) - what the loop progresses + monitors. */
export function listActiveFixTasks(): readonly FixTask[] {
  const placeholders = ACTIVE_STATUSES.map((status) => `'${status}'`).join(', ');
  return mapRows(
    getDb().prepare(`SELECT * FROM fix_tasks WHERE status IN (${placeholders}) ORDER BY createdAt ASC`).all()
  );
}

/** Get a failed task for a finding if it can be retried from scratch: it has retries left AND has not yet
 * opened a PR (a failed task that already has a PR is resumed by the monitor, never re-run, to avoid dupes). */
export function getRetryableFailedTask(findingId: string, maxRetries: number): FixTask | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM fix_tasks WHERE findingId = ? AND status = 'failed' AND prId IS NULL AND iterations < ?`)
    .get(findingId, maxRetries);
  return row !== undefined ? rowToTask(row) : undefined;
}

/** How many tasks are in flight (any active status) - enforces the open-task cap to prevent starting too many at once. */
export function countActiveFixTasks(): number {
  const placeholders = ACTIVE_STATUSES.map((status) => `'${status}'`).join(', ');
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM fix_tasks WHERE status IN (${placeholders})`).get();
  return z.object({ n: z.number() }).safeParse(row).data?.n ?? 0;
}

/** @deprecated Use countActiveFixTasks instead - this only counted open PRs, not in-flight tasks. */
export function countOpenFixPrs(): number {
  return countActiveFixTasks();
}

/**
 * Statuses a task occupies mid-work, before it has a live PR the monitor loop watches. A process restart can
 * strand a task in one of these (Code Autopilot was actively branching/fixing/validating/pushing when it was
 * killed), where nothing ever advances it - it just holds a slot against the open-task cap forever.
 */
const INTERRUPTIBLE_STATUSES = ['selected', 'branching', 'fixing', 'validating', 'pushed'] as const;

/**
 * Recover tasks stranded mid-work by a restart so they don't permanently occupy the open-task cap:
 *   - a task that had already opened a PR (has prId) is reset to 'pr-open' so the monitor loop resumes it
 *     (re-evaluating feedback) instead of opening a duplicate PR;
 *   - a task with no PR yet is reset to 'failed' (with a note) so the normal retry path re-attempts it.
 * Returns how many tasks were resumed vs. re-queued for retry. Safe to call once at loop startup.
 */
export function recoverInterruptedFixTasks(): { readonly resumed: number; readonly requeued: number } {
  const placeholders = INTERRUPTIBLE_STATUSES.map((status) => `'${status}'`).join(', ');
  // Tasks interrupted mid-work, plus any task that failed but still has a live PR - the latter must be
  // resumed (re-monitored), never retried from scratch, or it would open a duplicate PR for the same branch.
  const stranded = mapRows(
    getDb()
      .prepare(`SELECT * FROM fix_tasks WHERE status IN (${placeholders}) OR (status = 'failed' AND prId IS NOT NULL)`)
      .all()
  );
  let resumed = 0;
  let requeued = 0;
  for (const task of stranded) {
    if (task.prId !== undefined) {
      updateFixTask(task.id, { status: 'pr-open', lastAction: 'resumed after restart', lastError: null });
      resumed += 1;
    } else {
      updateFixTask(task.id, {
        status: 'failed',
        lastError: 'interrupted by a restart before opening a PR; will retry',
        lastAction: 'interrupted by restart'
      });
      requeued += 1;
    }
  }
  return { resumed, requeued };
}

/**
 * Clear stale errors on LIVE PRs (pr-open / addressing) so the dashboard reflects current state instead of an
 * error from a previous run. Called once at loop startup - after a restart every lastError is stale by
 * definition, and the monitor re-sets any genuine error on its next pass. Returns how many rows were cleared.
 */
export function clearActivePrErrors(): number {
  const result = getDb()
    .prepare(
      `UPDATE fix_tasks SET lastError = NULL, updatedAt = :updatedAt WHERE status IN ('pr-open', 'addressing') AND lastError IS NOT NULL`
    )
    .run({ updatedAt: new Date().toISOString() });
  return Number(result.changes);
}

/** Counts by status for the dashboard header. */
export function fixTaskStatusCounts(): Record<string, number> {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM fix_tasks GROUP BY status').all();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const parsed = z.object({ status: z.string(), n: z.number() }).safeParse(row);
    if (parsed.success) {
      counts[parsed.data.status] = parsed.data.n;
    }
  }
  return counts;
}
