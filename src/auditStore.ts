// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/** The issue classes the codebase audit sweep looks for (expanded from the original security/privacy). */
export const AUDIT_CATEGORIES = [
  'security',
  'privacy',
  'correctness',
  'dependency',
  'secrets',
  'telemetry',
  'telemetry-gap',
  'accessibility',
  'performance',
  'dead-code',
  'api-compat',
  'resilience',
  'config'
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** One source location (repo-relative file + 1-based line, optionally a line range) a finding points at. */
export interface AuditLocation {
  readonly filePath: string;
  readonly line: number;
  /** Inclusive end line when the issue spans a block of lines (defaults to a single line). */
  readonly endLine?: number;
}

/** Finding severity, mirroring the PR-review scale so the dashboard can render both consistently. */
export type AuditSeverity = 'blocking' | 'major' | 'minor' | 'nit';

/** Lifecycle of an audit finding: open (shown), dismissed by the owner, or auto-resolved (no longer found). */
export type AuditFindingStatus = 'open' | 'dismissed' | 'resolved';

/** Outcome of re-checking a finding whose linked bug a human marked fixed. */
export type AuditFixVerification = 'confirmed' | 'still-present';

/** How the audit reconciled a finding against its linked bug's ADO triage. */
export type AuditBugTriage = 'fixed' | 'wontfix' | 'needsinfo' | 'active';

/** A single issue the audit sweep surfaced for a file (or files) in the checked-out codebase. */
export interface AuditFinding {
  /** Stable identity (sha1 of file|title|category) so the same issue is not re-reported each sweep. */
  readonly id: string;
  readonly filePath: string;
  readonly line: number;
  /** Inclusive end line when the issue spans a block (the dashboard deep-links the whole range). */
  readonly endLine?: number;
  readonly severity: AuditSeverity;
  readonly category: AuditCategory;
  readonly title: string;
  readonly body: string;
  /** Optional in-depth explanation (mechanism, why it matters, how to fix), shown behind an expander. */
  readonly detail?: string;
  /** Confidence (0..1) after the double quality-check passes. */
  readonly confidence: number;
  readonly status: AuditFindingStatus;
  /** Why the finding was dismissed (free text from the dismisser), shown on dismissed findings. */
  readonly dismissReason?: string;
  /** Who dismissed the finding (alias entered in the dashboard, until auth attributes the logged-in user). */
  readonly dismissedBy?: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Additional source locations the issue spans (each deep-linked in the dashboard). */
  readonly relatedLocations?: readonly AuditLocation[];
  /** Sweep number this finding was last (re-)confirmed in, for auto-resolve reconciliation. */
  readonly lastSeenSweep?: number;
  /** When the file the finding lives in first appeared in git history (best-effort "in codebase since"). */
  readonly introducedAt?: string;
  /** ADO bug id once a bug has been filed for this finding (one-click or auto-create). */
  readonly adoBugId?: number;
  readonly adoBugUrl?: string;
  /** Area path the bug was filed under (the resolved owning team), shown against the finding. */
  readonly adoAreaPath?: string;
  /** Assignee the bug was filed to (package owner), when one was set. */
  readonly adoAssignedTo?: string;
  /** Sweep number at which this finding was auto-resolved (drives close-after-N-sweeps). */
  readonly resolvedAtSweep?: number;
  /** True once the linked bug has been auto-resolved in ADO (so it is not resolved twice). */
  readonly bugClosed?: boolean;
  /** Last-observed ADO state of the linked bug (e.g. "Active", "Resolved", "Closed"). */
  readonly bugState?: string;
  /** Last-observed ADO reason for that state (e.g. "Fixed", "As Designed", "Deferred"). */
  readonly bugStateReason?: string;
  /** When Saturn last polled the linked bug's state (ISO), so unchanged states are not re-processed. */
  readonly bugStateCheckedAt?: string;
  /**
   * Result of validating a bug a human marked fixed: 'confirmed' when Saturn also no longer detects the
   * issue, 'still-present' when Saturn still detects it (the fix looks incomplete).
   */
  readonly fixVerification?: AuditFixVerification;
  /** When Saturn last posted the finding's details onto a bug asking for more info (ISO), to avoid repeats. */
  readonly bugInfoProvidedAt?: string;
  /** How the linked bug was last triaged (fixed/won't-fix/needs-info/active); drives the "Won't fix" filter. */
  readonly bugTriage?: AuditBugTriage;
}

/** Resumable sweep cursor so a daily run continues where the previous one left off. */
export interface AuditProgress {
  readonly sweepNumber: number;
  readonly sweepStartedAt: string;
  /** Index into the enumerated file list where the next batch resumes. */
  readonly nextFileIndex: number;
  readonly totalFiles: number;
  readonly filesScanned: number;
  readonly completedSweeps: number;
  readonly lastBatchAt?: string;
}

/** Filter applied to finding queries: status/category/severity are exact, package/path are substrings. */
export interface AuditFindingFilter {
  readonly status?: string;
  readonly category?: string;
  readonly severity?: string;
  readonly pkg?: string;
  readonly path?: string;
}

/** One page of findings plus the total number matching the filter (for cursor pagination). */
export interface AuditFindingsPage {
  readonly findings: readonly AuditFinding[];
  readonly total: number;
}

/** Pre-aggregated counts for the dashboard overview charts (computed in SQL, not by scanning in JS). */
export interface AuditSummary {
  readonly total: number;
  readonly sev: Record<string, number>;
  readonly byCategory: readonly { readonly category: string; readonly count: number }[];
  readonly bySeverity: readonly { readonly severity: string; readonly count: number }[];
  readonly packages: readonly string[];
}

/** Cheap headline counts for the audit state (no full-table read). */
export interface AuditCounts {
  readonly total: number;
  readonly open: number;
  readonly withBug: number;
}

const auditSeveritySchema = z.enum(['blocking', 'major', 'minor', 'nit']).catch('major');
const auditCategorySchema = z.enum(AUDIT_CATEGORIES).catch('security');
const auditStatusSchema = z.enum(['open', 'dismissed', 'resolved']).catch('open');
const auditLocationSchema = z.object({
  filePath: z.string(),
  line: z.number(),
  endLine: z.number().optional()
});

// Validates a JSON-imported finding (the one-time migration from the legacy findings.json store).
const auditFindingSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  line: z.number(),
  endLine: z.number().optional(),
  severity: auditSeveritySchema,
  category: auditCategorySchema,
  title: z.string(),
  body: z.string(),
  detail: z.string().optional(),
  confidence: z.number(),
  status: auditStatusSchema,
  dismissReason: z.string().optional(),
  dismissedBy: z.string().optional(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  relatedLocations: z.array(auditLocationSchema).optional(),
  lastSeenSweep: z.number().optional(),
  introducedAt: z.string().optional(),
  adoBugId: z.number().optional(),
  adoBugUrl: z.string().optional(),
  adoAreaPath: z.string().optional(),
  adoAssignedTo: z.string().optional(),
  resolvedAtSweep: z.number().optional(),
  bugClosed: z.boolean().optional()
});

const auditProgressSchema = z.object({
  sweepNumber: z.number(),
  sweepStartedAt: z.string(),
  nextFileIndex: z.number(),
  totalFiles: z.number(),
  filesScanned: z.number(),
  completedSweeps: z.number(),
  lastBatchAt: z.string().optional()
});

// A row read back from SQLite: NULLs come through as null and the boolean is stored as 0/1. `.loose()`
// tolerates the extra package/pathKey columns the table also carries.
const findingRowSchema = z
  .object({
    id: z.string(),
    filePath: z.string(),
    line: z.number(),
    endLine: z.number().nullable(),
    severity: auditSeveritySchema,
    category: auditCategorySchema,
    title: z.string(),
    body: z.string(),
    detail: z.string().nullable(),
    confidence: z.number(),
    status: auditStatusSchema,
    dismissReason: z.string().nullable(),
    dismissedBy: z.string().nullable(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    relatedLocations: z.string().nullable(),
    lastSeenSweep: z.number().nullable(),
    introducedAt: z.string().nullable(),
    adoBugId: z.number().nullable(),
    adoBugUrl: z.string().nullable(),
    adoAreaPath: z.string().nullable(),
    adoAssignedTo: z.string().nullable(),
    resolvedAtSweep: z.number().nullable(),
    bugClosed: z.number().nullable(),
    bugState: z.string().nullable(),
    bugStateReason: z.string().nullable(),
    bugStateCheckedAt: z.string().nullable(),
    fixVerification: z.string().nullable(),
    bugInfoProvidedAt: z.string().nullable(),
    bugTriage: z.string().nullable()
  })
  .loose();

const countRowSchema = z.object({ n: z.number() });
const countsRowSchema = z.object({ total: z.number(), open: z.number(), withBug: z.number() });
const auditStatusCountsRowSchema = z.object({
  total: z.number(),
  open: z.number(),
  wontfix: z.number(),
  dismissed: z.number(),
  resolved: z.number(),
  withBug: z.number()
});
const groupRowSchema = z.object({ key: z.string(), count: z.number() });
const packageRowSchema = z.object({ package: z.string() });
const scannedRowSchema = z.object({ pathKey: z.string(), contentHash: z.string() });

const AUDIT_SEVERITY_ORDER: readonly AuditSeverity[] = ['blocking', 'major', 'minor', 'nit'];

function auditDir(): string {
  const override = process.env.SATURN_AUDIT_DIR;
  return override !== undefined && override.trim() !== '' ? override : path.join(os.homedir(), '.saturn', 'audit');
}

function dbFilePath(): string {
  return path.join(auditDir(), 'audit.db');
}

function legacyFindingsFilePath(): string {
  return path.join(auditDir(), 'findings.json');
}

function progressFilePath(): string {
  return path.join(auditDir(), 'progress.json');
}

// The package a file belongs to (its top two path segments), stored for fast facet + filter queries.
function packageForPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? '';
}

// Case/separator-insensitive path key, matching auditFindingId's normalization, for duplicate + file lookup.
function normalizePathKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

const FINDINGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  filePath TEXT NOT NULL,
  package TEXT NOT NULL DEFAULT '',
  pathKey TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL,
  endLine INTEGER,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  detail TEXT,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  dismissReason TEXT,
  dismissedBy TEXT,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  relatedLocations TEXT,
  lastSeenSweep INTEGER,
  introducedAt TEXT,
  adoBugId INTEGER,
  adoBugUrl TEXT,
  adoAreaPath TEXT,
  adoAssignedTo TEXT,
  resolvedAtSweep INTEGER,
  bugClosed INTEGER,
  bugState TEXT,
  bugStateReason TEXT,
  bugStateCheckedAt TEXT,
  fixVerification TEXT,
  bugInfoProvidedAt TEXT,
  bugTriage TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_lastSeenAt ON findings(lastSeenAt);
CREATE INDEX IF NOT EXISTS idx_findings_category ON findings(category);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_package ON findings(package);
CREATE INDEX IF NOT EXISTS idx_findings_pathKey ON findings(pathKey);
CREATE TABLE IF NOT EXISTS scanned_files (
  pathKey TEXT PRIMARY KEY,
  filePath TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  scannedSweep INTEGER NOT NULL
);
`;

const INSERT_FINDING_SQL = `
INSERT OR REPLACE INTO findings (
  id, filePath, package, pathKey, line, endLine, severity, category, title, body, detail, confidence,
  status, dismissReason, dismissedBy, firstSeenAt, lastSeenAt, relatedLocations, lastSeenSweep, introducedAt,
  adoBugId, adoBugUrl, adoAreaPath, adoAssignedTo, resolvedAtSweep, bugClosed, bugState, bugStateReason,
  bugStateCheckedAt, fixVerification, bugInfoProvidedAt, bugTriage
) VALUES (
  :id, :filePath, :package, :pathKey, :line, :endLine, :severity, :category, :title, :body, :detail,
  :confidence, :status, :dismissReason, :dismissedBy, :firstSeenAt, :lastSeenAt, :relatedLocations,
  :lastSeenSweep, :introducedAt, :adoBugId, :adoBugUrl, :adoAreaPath, :adoAssignedTo, :resolvedAtSweep,
  :bugClosed, :bugState, :bugStateReason, :bugStateCheckedAt, :fixVerification, :bugInfoProvidedAt, :bugTriage
)
`;

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
  mkdirSync(auditDir(), { recursive: true });
  const database = new DatabaseSync(target);
  database.exec(FINDINGS_TABLE_SQL);
  ensureFindingColumns(database);
  migrateLegacyJson(database);
  dbInstance = database;
  dbInstancePath = target;
  return database;
}

/** Close the SQLite handle (used by tests to start from a clean store). */
export function closeAuditDb(): void {
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

// Add columns introduced after a store was first created (SQLite CREATE TABLE IF NOT EXISTS won't add them
// to an existing DB). Each ALTER is best-effort: a duplicate-column error on an already-migrated DB is
// expected and ignored. Column names are literals, never user input, so there is no injection surface.
function ensureFindingColumns(database: DatabaseSync): void {
  for (const ddl of [
    'ALTER TABLE findings ADD COLUMN dismissReason TEXT',
    'ALTER TABLE findings ADD COLUMN dismissedBy TEXT',
    'ALTER TABLE findings ADD COLUMN bugState TEXT',
    'ALTER TABLE findings ADD COLUMN bugStateReason TEXT',
    'ALTER TABLE findings ADD COLUMN bugStateCheckedAt TEXT',
    'ALTER TABLE findings ADD COLUMN fixVerification TEXT',
    'ALTER TABLE findings ADD COLUMN bugInfoProvidedAt TEXT',
    'ALTER TABLE findings ADD COLUMN bugTriage TEXT'
  ]) {
    try {
      database.exec(ddl);
    } catch {
      /* column already exists - ignore */
    }
  }
}

// One-time import of the legacy findings.json into SQLite, then archive it so it is not re-imported.
function migrateLegacyJson(database: DatabaseSync): void {
  const jsonPath = legacyFindingsFilePath();
  if (!existsSync(jsonPath)) {
    return;
  }
  const existingCount = countRowSchema.safeParse(database.prepare('SELECT COUNT(*) AS n FROM findings').get());
  if (existingCount.success && existingCount.data.n > 0) {
    archiveLegacyJson(jsonPath);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return;
  }
  const findings = z.array(auditFindingSchema).safeParse(parsed);
  if (!findings.success) {
    return;
  }
  const insert = database.prepare(INSERT_FINDING_SQL);
  database.exec('BEGIN');
  try {
    for (const finding of findings.data) {
      insert.run(findingParams(finding));
    }
    database.exec('COMMIT');
  } catch {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    return;
  }
  archiveLegacyJson(jsonPath);
}

function archiveLegacyJson(jsonPath: string): void {
  try {
    renameSync(jsonPath, `${jsonPath}.imported`);
  } catch {
    /* ignore */
  }
}

// Bind values for one row. Booleans become 0/1, optionals become null, relatedLocations becomes JSON text.
function findingParams(finding: AuditFinding): Record<string, string | number | null> {
  return {
    id: finding.id,
    filePath: finding.filePath,
    package: packageForPath(finding.filePath),
    pathKey: normalizePathKey(finding.filePath),
    line: finding.line,
    endLine: finding.endLine ?? null,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    detail: finding.detail ?? null,
    confidence: finding.confidence,
    status: finding.status,
    dismissReason: finding.dismissReason ?? null,
    dismissedBy: finding.dismissedBy ?? null,
    firstSeenAt: finding.firstSeenAt,
    lastSeenAt: finding.lastSeenAt,
    relatedLocations: finding.relatedLocations !== undefined ? JSON.stringify(finding.relatedLocations) : null,
    lastSeenSweep: finding.lastSeenSweep ?? null,
    introducedAt: finding.introducedAt ?? null,
    adoBugId: finding.adoBugId ?? null,
    adoBugUrl: finding.adoBugUrl ?? null,
    adoAreaPath: finding.adoAreaPath ?? null,
    adoAssignedTo: finding.adoAssignedTo ?? null,
    resolvedAtSweep: finding.resolvedAtSweep ?? null,
    bugClosed: finding.bugClosed === undefined ? null : finding.bugClosed ? 1 : 0,
    bugState: finding.bugState ?? null,
    bugStateReason: finding.bugStateReason ?? null,
    bugStateCheckedAt: finding.bugStateCheckedAt ?? null,
    fixVerification: finding.fixVerification ?? null,
    bugInfoProvidedAt: finding.bugInfoProvidedAt ?? null,
    bugTriage: finding.bugTriage ?? null
  };
}

function parseRelatedLocations(json: string): readonly AuditLocation[] | undefined {
  try {
    const parsed = z.array(auditLocationSchema).safeParse(JSON.parse(json));
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// Map a raw SQLite row to an AuditFinding (omitting optional fields that are null), or undefined if invalid.
function rowToFinding(raw: unknown): AuditFinding | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const parsed = findingRowSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const row = parsed.data;
  const related = row.relatedLocations !== null ? parseRelatedLocations(row.relatedLocations) : undefined;
  return {
    id: row.id,
    filePath: row.filePath,
    line: row.line,
    ...(row.endLine !== null ? { endLine: row.endLine } : {}),
    severity: row.severity,
    category: row.category,
    title: row.title,
    body: row.body,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    confidence: row.confidence,
    status: row.status,
    ...(row.dismissReason !== null ? { dismissReason: row.dismissReason } : {}),
    ...(row.dismissedBy !== null ? { dismissedBy: row.dismissedBy } : {}),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    ...(related !== undefined ? { relatedLocations: related } : {}),
    ...(row.lastSeenSweep !== null ? { lastSeenSweep: row.lastSeenSweep } : {}),
    ...(row.introducedAt !== null ? { introducedAt: row.introducedAt } : {}),
    ...(row.adoBugId !== null ? { adoBugId: row.adoBugId } : {}),
    ...(row.adoBugUrl !== null ? { adoBugUrl: row.adoBugUrl } : {}),
    ...(row.adoAreaPath !== null ? { adoAreaPath: row.adoAreaPath } : {}),
    ...(row.adoAssignedTo !== null ? { adoAssignedTo: row.adoAssignedTo } : {}),
    ...(row.resolvedAtSweep !== null ? { resolvedAtSweep: row.resolvedAtSweep } : {}),
    ...(row.bugClosed !== null ? { bugClosed: row.bugClosed === 1 } : {}),
    ...(row.bugState !== null ? { bugState: row.bugState } : {}),
    ...(row.bugStateReason !== null ? { bugStateReason: row.bugStateReason } : {}),
    ...(row.bugStateCheckedAt !== null ? { bugStateCheckedAt: row.bugStateCheckedAt } : {}),
    ...(row.fixVerification === 'confirmed' || row.fixVerification === 'still-present'
      ? { fixVerification: row.fixVerification }
      : {}),
    ...(row.bugInfoProvidedAt !== null ? { bugInfoProvidedAt: row.bugInfoProvidedAt } : {}),
    ...(row.bugTriage === 'fixed' ||
    row.bugTriage === 'wontfix' ||
    row.bugTriage === 'needsinfo' ||
    row.bugTriage === 'active'
      ? { bugTriage: row.bugTriage }
      : {})
  };
}

function mapRows(rows: readonly unknown[]): readonly AuditFinding[] {
  const result: AuditFinding[] = [];
  for (const row of rows) {
    const finding = rowToFinding(row);
    if (finding !== undefined) {
      result.push(finding);
    }
  }
  return result;
}

interface WhereClause {
  readonly clause: string;
  readonly params: Record<string, string>;
}

// Open findings still worth acting on: excludes those whose linked bug a human triaged "won't fix" (kept as
// status='open' for the record, surfaced under the dedicated "Won't fix" filter). Literals, no user input.
const OPEN_ACTIONABLE_SQL = "status = 'open' AND (bugTriage IS NULL OR bugTriage != 'wontfix')";
const WONTFIX_OPEN_SQL = "status = 'open' AND bugTriage = 'wontfix'";

// Build a parameterized WHERE from a filter (status/category/severity exact; package/path case-insensitive
// substring). Column names are literals, never user input, so there is no injection surface.
function buildWhere(filter: AuditFindingFilter): WhereClause {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.status === 'open') {
    // The default open view hides findings whose linked bug a human triaged "won't fix" - they stay
    // status='open' for the record but are surfaced under the "Won't fix" filter, not "Open".
    conditions.push(OPEN_ACTIONABLE_SQL);
  } else if (filter.status === 'wontfix') {
    conditions.push(WONTFIX_OPEN_SQL);
  } else if (filter.status !== undefined && filter.status !== '') {
    conditions.push('status = :status');
    params.status = filter.status;
  }
  if (filter.category !== undefined && filter.category !== '') {
    conditions.push('category = :category');
    params.category = filter.category;
  }
  if (filter.severity !== undefined && filter.severity !== '') {
    conditions.push('severity = :severity');
    params.severity = filter.severity;
  }
  if (filter.pkg !== undefined && filter.pkg !== '') {
    conditions.push('lower(package) LIKE :pkg');
    params.pkg = `%${filter.pkg.toLowerCase()}%`;
  }
  if (filter.path !== undefined && filter.path !== '') {
    conditions.push('lower(filePath) LIKE :path');
    params.path = `%${filter.path.toLowerCase()}%`;
  }
  return { clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function countWhere(database: DatabaseSync, where: WhereClause): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM findings ${where.clause}`).get(where.params);
  const parsed = countRowSchema.safeParse(row);
  return parsed.success ? parsed.data.n : 0;
}

function groupCount(
  database: DatabaseSync,
  column: 'severity' | 'category',
  where: WhereClause
): readonly { readonly key: string; readonly count: number }[] {
  const rows = database
    .prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM findings ${where.clause} GROUP BY ${column}`)
    .all(where.params);
  const result: { readonly key: string; readonly count: number }[] = [];
  for (const row of rows) {
    const parsed = groupRowSchema.safeParse(row);
    if (parsed.success) {
      result.push(parsed.data);
    }
  }
  return result;
}

function distinctPackages(database: DatabaseSync, where: WhereClause): readonly string[] {
  const clause = where.clause !== '' ? `${where.clause} AND package != ''` : "WHERE package != ''";
  const rows = database.prepare(`SELECT DISTINCT package FROM findings ${clause} ORDER BY package`).all(where.params);
  const result: string[] = [];
  for (const row of rows) {
    const parsed = packageRowSchema.safeParse(row);
    if (parsed.success) {
      result.push(parsed.data.package);
    }
  }
  return result;
}

/** Compute the stable identity for a finding (survives line drift; keyed by file + title + category). */
export function auditFindingId(filePath: string, title: string, category: AuditCategory): string {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha1').update(`${normalizedPath}\u0000${normalizedTitle}\u0000${category}`).digest('hex');
}

/** Read every persisted audit finding (newest first). Returns an empty list when the store is empty. */
export function readAuditFindings(): readonly AuditFinding[] {
  return mapRows(getDb().prepare('SELECT * FROM findings ORDER BY lastSeenAt DESC').all());
}

/** A filtered, paginated page of findings plus the total matching the filter (newest-first). */
export function queryAuditFindings(filter: AuditFindingFilter, limit: number, offset: number): AuditFindingsPage {
  const database = getDb();
  const where = buildWhere(filter);
  const total = countWhere(database, where);
  const rows = database
    .prepare(`SELECT * FROM findings ${where.clause} ORDER BY lastSeenAt DESC, id ASC LIMIT :limit OFFSET :offset`)
    .all({ ...where.params, limit, offset });
  return { findings: mapRows(rows), total };
}

/**
 * Pre-aggregated overview counts computed in SQL: severity totals over the status/package/path scope, a
 * by-category breakdown (further scoped by the selected severity), a by-severity breakdown (further scoped
 * by the selected category), and the distinct package facet - so the dashboard never scans the full table.
 */
export function queryAuditSummary(filter: AuditFindingFilter): AuditSummary {
  const database = getDb();
  const scope = buildWhere({ status: filter.status, pkg: filter.pkg, path: filter.path });
  const total = countWhere(database, scope);

  const sev: Record<string, number> = { blocking: 0, major: 0, minor: 0, nit: 0 };
  for (const row of groupCount(database, 'severity', scope)) {
    if (row.key in sev) {
      sev[row.key] = row.count;
    }
  }

  const categoryScope = buildWhere({
    status: filter.status,
    pkg: filter.pkg,
    path: filter.path,
    severity: filter.severity
  });
  const byCategory = groupCount(database, 'category', categoryScope)
    .map((row) => ({ category: row.key, count: row.count }))
    .sort((first, second) => second.count - first.count);

  const severityScope = buildWhere({
    status: filter.status,
    pkg: filter.pkg,
    path: filter.path,
    category: filter.category
  });
  const severityCounts = new Map<string, number>();
  for (const row of groupCount(database, 'severity', severityScope)) {
    severityCounts.set(row.key, row.count);
  }
  const bySeverity = AUDIT_SEVERITY_ORDER.map((severity) => ({
    severity,
    count: severityCounts.get(severity) ?? 0
  }));

  return { total, sev, byCategory, bySeverity, packages: distinctPackages(database, scope) };
}

/** Headline counts for the audit state - total findings, how many are open, and how many have a filed bug. */
export function countAuditFindings(): AuditCounts {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS total, ' +
        `COALESCE(SUM(CASE WHEN ${OPEN_ACTIONABLE_SQL} THEN 1 ELSE 0 END), 0) AS open, ` +
        'COALESCE(SUM(CASE WHEN adoBugId IS NOT NULL THEN 1 ELSE 0 END), 0) AS withBug FROM findings'
    )
    .get();
  const parsed = countsRowSchema.safeParse(row);
  return parsed.success ? parsed.data : { total: 0, open: 0, withBug: 0 };
}

/** Per-status finding counts for the leadership dashboard (plus how many findings have a filed bug). */
export interface AuditStatusCounts {
  readonly total: number;
  readonly open: number;
  readonly wontfix: number;
  readonly dismissed: number;
  readonly resolved: number;
  readonly withBug: number;
}

/** Count findings grouped by lifecycle status (open/dismissed/resolved) + the filed-bug total, in one scan. */
export function queryAuditStatusCounts(): AuditStatusCounts {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS total, ' +
        `COALESCE(SUM(CASE WHEN ${OPEN_ACTIONABLE_SQL} THEN 1 ELSE 0 END), 0) AS open, ` +
        `COALESCE(SUM(CASE WHEN ${WONTFIX_OPEN_SQL} THEN 1 ELSE 0 END), 0) AS wontfix, ` +
        "COALESCE(SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END), 0) AS dismissed, " +
        "COALESCE(SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved, " +
        'COALESCE(SUM(CASE WHEN adoBugId IS NOT NULL THEN 1 ELSE 0 END), 0) AS withBug FROM findings'
    )
    .get();
  const parsed = auditStatusCountsRowSchema.safeParse(row);
  return parsed.success ? parsed.data : { total: 0, open: 0, wontfix: 0, dismissed: 0, resolved: 0, withBug: 0 };
}

/** Top packages by open-finding count (the codebase hotspots), highest first, for the dashboard charts. */
export function queryAuditPackageCounts(
  limit: number
): readonly { readonly package: string; readonly count: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT package AS key, COUNT(*) AS count FROM findings WHERE ${OPEN_ACTIONABLE_SQL} AND package != '' ` +
        'GROUP BY package ORDER BY count DESC, package ASC LIMIT :limit'
    )
    .all({ limit });
  const result: { readonly package: string; readonly count: number }[] = [];
  for (const row of rows) {
    const parsed = groupRowSchema.safeParse(row);
    if (parsed.success) {
      result.push({ package: parsed.data.key, count: parsed.data.count });
    }
  }
  return result;
}

/** Open findings that have not yet had a bug filed (for the bounded auto-create pass). */
export function queryPendingFindings(limit: number): readonly AuditFinding[] {
  const rows = getDb()
    .prepare("SELECT * FROM findings WHERE status = 'open' AND adoBugId IS NULL ORDER BY lastSeenAt DESC LIMIT :limit")
    .all({ limit });
  return mapRows(rows);
}

/** Findings living in any of the given files (used to scope the per-batch semantic-dedup comparison). */
export function findingsForFiles(filePaths: readonly string[]): readonly AuditFinding[] {
  const keys = [...new Set(filePaths.map(normalizePathKey))].filter((key) => key !== '');
  if (keys.length === 0) {
    return [];
  }
  const placeholders = keys.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM findings WHERE pathKey IN (${placeholders}) ORDER BY lastSeenAt DESC`)
    .all(...keys);
  return mapRows(rows);
}

/** The content hash recorded for each given file the last time it was scanned (keyed by repo-relative path). */
export function scannedFileHashes(filePaths: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const keys = [...new Set(filePaths.map(normalizePathKey))].filter((key) => key !== '');
  if (keys.length === 0) {
    return result;
  }
  const placeholders = keys.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT pathKey, contentHash FROM scanned_files WHERE pathKey IN (${placeholders})`)
    .all(...keys);
  for (const row of rows) {
    const parsed = scannedRowSchema.safeParse(row);
    if (parsed.success) {
      result.set(parsed.data.pathKey, parsed.data.contentHash);
    }
  }
  return result;
}

/** Record that the given files were scanned this sweep, with their current content hash (upsert). */
export function recordScannedFiles(
  entries: readonly { readonly filePath: string; readonly contentHash: string }[],
  sweepNumber: number
): void {
  if (entries.length === 0) {
    return;
  }
  const database = getDb();
  const upsert = database.prepare(
    'INSERT OR REPLACE INTO scanned_files (pathKey, filePath, contentHash, scannedSweep) ' +
      'VALUES (:pathKey, :filePath, :contentHash, :scannedSweep)'
  );
  database.exec('BEGIN');
  try {
    for (const entry of entries) {
      upsert.run({
        pathKey: normalizePathKey(entry.filePath),
        filePath: entry.filePath,
        contentHash: entry.contentHash,
        scannedSweep: sweepNumber
      });
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
}

// Bump lastSeenSweep for the open findings of the given files. Used when an unchanged file is skipped during
// an incremental sweep, so the post-sweep reconcile does not treat its still-valid findings as resolved.
export function touchFindingsForFiles(filePaths: readonly string[], sweepNumber: number): void {
  const keys = [...new Set(filePaths.map(normalizePathKey))].filter((key) => key !== '');
  if (keys.length === 0) {
    return;
  }
  const placeholders = keys.map(() => '?').join(',');
  getDb()
    .prepare(`UPDATE findings SET lastSeenSweep = ? WHERE status = 'open' AND pathKey IN (${placeholders})`)
    .run(sweepNumber, ...keys);
}

/** A candidate the sweep produced for one file; identity/timestamps are assigned on upsert. */
export interface AuditFindingCandidate {
  readonly filePath: string;
  readonly line: number;
  readonly endLine?: number;
  readonly severity: AuditSeverity;
  readonly category: AuditCategory;
  readonly title: string;
  readonly body: string;
  /** Optional in-depth explanation, surfaced behind an expander and copied into the bug. */
  readonly detail?: string;
  readonly confidence: number;
  /** Additional source locations the issue spans (deep-linked in the dashboard). */
  readonly relatedLocations?: readonly AuditLocation[];
  /** Best-effort ISO time the file first appeared in git history ("in codebase since"). */
  readonly introducedAt?: string;
  /** Canonical id assigned by the semantic-dedup pass when this is the same issue as an existing finding. */
  readonly matchId?: string;
}

/**
 * Merge a batch of candidates into the store. A candidate whose stable id already exists refreshes the
 * existing finding's lastSeenAt (and body/line/severity/detail) while preserving its status and any filed
 * bug; a dismissed finding is never resurrected. New candidates are inserted as open findings. Returns how
 * many were added vs. refreshed.
 */
export function upsertAuditFindings(
  candidates: readonly AuditFindingCandidate[],
  now: string,
  sweepNumber: number
): { readonly added: number; readonly refreshed: number } {
  if (candidates.length === 0) {
    return { added: 0, refreshed: 0 };
  }
  const database = getDb();
  const insert = database.prepare(INSERT_FINDING_SQL);
  const selectById = database.prepare('SELECT * FROM findings WHERE id = :id');
  let added = 0;
  let refreshed = 0;
  database.exec('BEGIN');
  try {
    for (const candidate of candidates) {
      // The semantic-dedup pass may have matched this candidate to an existing finding (or an earlier
      // candidate); when it has, merge into that canonical id instead of the title-derived one.
      const id = candidate.matchId ?? auditFindingId(candidate.filePath, candidate.title, candidate.category);
      const prior = rowToFinding(selectById.get({ id }));
      if (prior === undefined) {
        insert.run(
          findingParams({
            id,
            filePath: candidate.filePath,
            ...(candidate.endLine !== undefined ? { endLine: candidate.endLine } : {}),
            line: candidate.line,
            severity: candidate.severity,
            category: candidate.category,
            title: candidate.title,
            body: candidate.body,
            ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
            confidence: candidate.confidence,
            status: 'open',
            firstSeenAt: now,
            lastSeenAt: now,
            lastSeenSweep: sweepNumber,
            ...(candidate.relatedLocations !== undefined ? { relatedLocations: candidate.relatedLocations } : {}),
            ...(candidate.introducedAt !== undefined ? { introducedAt: candidate.introducedAt } : {})
          })
        );
        added += 1;
        continue;
      }
      insert.run(
        findingParams({
          ...prior,
          line: candidate.line,
          endLine: candidate.endLine ?? prior.endLine,
          severity: candidate.severity,
          body: candidate.body,
          detail: candidate.detail ?? prior.detail,
          confidence: candidate.confidence,
          lastSeenAt: now,
          lastSeenSweep: sweepNumber,
          relatedLocations: candidate.relatedLocations ?? prior.relatedLocations,
          // A previously dismissed finding stays dismissed; an auto-resolved one re-opens when seen again.
          status: prior.status === 'resolved' ? 'open' : prior.status,
          // Re-opening clears the auto-resolve bookkeeping so it can resolve/close cleanly again later.
          resolvedAtSweep: prior.status === 'resolved' ? undefined : prior.resolvedAtSweep,
          bugClosed: prior.status === 'resolved' ? false : prior.bugClosed,
          introducedAt: prior.introducedAt ?? candidate.introducedAt
        })
      );
      refreshed += 1;
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
  return { added, refreshed };
}

/** Details of the bug filed for a finding, persisted so the dashboard can show the route + link. */
export interface FiledBug {
  readonly bugId: number;
  readonly bugUrl: string;
  readonly areaPath?: string;
  readonly assignedTo?: string;
}

/** Record the ADO bug filed for a finding. Returns the updated finding, or undefined if the id is unknown. */
export function setAuditFindingBug(id: string, filed: FiledBug): AuditFinding | undefined {
  getDb()
    .prepare(
      'UPDATE findings SET adoBugId = :adoBugId, adoBugUrl = :adoBugUrl, adoAreaPath = :adoAreaPath, ' +
        'adoAssignedTo = :adoAssignedTo WHERE id = :id'
    )
    .run({
      id,
      adoBugId: filed.bugId,
      adoBugUrl: filed.bugUrl,
      adoAreaPath: filed.areaPath ?? null,
      adoAssignedTo: filed.assignedTo ?? null
    });
  return getAuditFindingById(id);
}

/** Set a finding's status (e.g. owner dismissal). Returns the updated finding, or undefined if unknown. */
export function setAuditFindingStatus(id: string, status: AuditFindingStatus): AuditFinding | undefined {
  getDb().prepare('UPDATE findings SET status = :status WHERE id = :id').run({ id, status });
  return getAuditFindingById(id);
}

/**
 * Dismiss a finding with attribution: records who dismissed it and why (free text from the dashboard) so the
 * dismissed view can show the reason + dismisser and that person can be contacted (until auth attributes the
 * logged-in user). Returns the updated finding, or undefined if the id is unknown.
 */
export function dismissAuditFinding(id: string, reason: string, dismissedBy: string): AuditFinding | undefined {
  getDb()
    .prepare("UPDATE findings SET status = 'dismissed', dismissReason = :reason, dismissedBy = :by WHERE id = :id")
    .run({ id, reason, by: dismissedBy });
  return getAuditFindingById(id);
}

/** Look up a single finding by id. */
export function getAuditFindingById(id: string): AuditFinding | undefined {
  return rowToFinding(getDb().prepare('SELECT * FROM findings WHERE id = :id').get({ id }));
}

/**
 * Open or auto-resolved findings that have a filed bug whose state has not been polled since
 * `staleBeforeIso` (never-polled first). Used to reconcile findings against how a human triaged the bug
 * (fixed / won't-fix / needs-info) without re-polling the same bug every batch. Saturn-auto-closed bugs
 * (bugClosed = 1) are skipped - those were resolved by the resolve-after-N-sweeps path, not a human.
 */
export function queryFindingsForBugPoll(staleBeforeIso: string, limit: number): readonly AuditFinding[] {
  return mapRows(
    getDb()
      .prepare(
        "SELECT * FROM findings WHERE adoBugId IS NOT NULL AND status IN ('open', 'resolved') AND " +
          '(bugClosed IS NULL OR bugClosed = 0) AND (bugStateCheckedAt IS NULL OR bugStateCheckedAt < :stale) ' +
          'ORDER BY (bugStateCheckedAt IS NULL) DESC, bugStateCheckedAt ASC LIMIT :limit'
      )
      .all({ stale: staleBeforeIso, limit })
  );
}

/** Fields persisted after polling a linked bug's state (drives skip-on-unchanged + the dashboard badge). */
export interface BugStateRecord {
  readonly bugState: string;
  readonly bugStateReason: string;
  readonly bugStateCheckedAt: string;
  readonly bugTriage?: AuditBugTriage;
  readonly fixVerification?: AuditFixVerification;
  readonly bugInfoProvidedAt?: string;
}

/** Persist the last-observed bug state + fix-verification for a finding. Returns the updated finding. */
export function recordBugState(id: string, record: BugStateRecord): AuditFinding | undefined {
  getDb()
    .prepare(
      'UPDATE findings SET bugState = :bugState, bugStateReason = :bugStateReason, ' +
        'bugStateCheckedAt = :bugStateCheckedAt, bugTriage = :bugTriage, fixVerification = :fixVerification, ' +
        'bugInfoProvidedAt = :bugInfoProvidedAt WHERE id = :id'
    )
    .run({
      id,
      bugState: record.bugState,
      bugStateReason: record.bugStateReason,
      bugStateCheckedAt: record.bugStateCheckedAt,
      bugTriage: record.bugTriage ?? null,
      fixVerification: record.fixVerification ?? null,
      bugInfoProvidedAt: record.bugInfoProvidedAt ?? null
    });
  return getAuditFindingById(id);
}

/** Outcome of a post-sweep reconciliation: bugs to comment "appears fixed" on, and bugs to auto-resolve. */
export interface ReconcileResult {
  /** Newly auto-resolved findings that have a filed bug (comment that the issue appears fixed). */
  readonly comment: readonly AuditFinding[];
  /** Findings whose bug should now be resolved in ADO (missed for enough consecutive sweeps). */
  readonly close: readonly AuditFinding[];
}

/**
 * After a sweep completes, reconcile auto-resolved findings:
 *   - an OPEN finding not re-confirmed this sweep becomes 'resolved' (records the sweep) and its bug, if
 *     any, is returned in `comment` so the caller can note it appears fixed;
 *   - a finding that has stayed 'resolved' for `closeAfterSweeps` sweeps and still has an un-closed bug is
 *     returned in `close` (and marked closed) so the caller can resolve the ADO bug.
 * A resolved finding re-opens automatically (via upsert) if a later sweep detects it again.
 */
export function reconcileResolvedFindings(completedSweepNumber: number, closeAfterSweeps: number): ReconcileResult {
  const database = getDb();
  const comment: AuditFinding[] = [];
  const close: AuditFinding[] = [];
  database.exec('BEGIN');
  try {
    const toResolve = mapRows(
      database
        .prepare(
          "SELECT * FROM findings WHERE status = 'open' AND lastSeenSweep IS NOT NULL AND lastSeenSweep < :sweep"
        )
        .all({ sweep: completedSweepNumber })
    );
    const setResolved = database.prepare(
      "UPDATE findings SET status = 'resolved', resolvedAtSweep = :sweep WHERE id = :id"
    );
    for (const finding of toResolve) {
      setResolved.run({ id: finding.id, sweep: completedSweepNumber });
      const resolved: AuditFinding = { ...finding, status: 'resolved', resolvedAtSweep: completedSweepNumber };
      if (resolved.adoBugId !== undefined) {
        comment.push(resolved);
      }
    }

    const threshold = Math.max(1, closeAfterSweeps);
    const toClose = mapRows(
      database
        .prepare(
          "SELECT * FROM findings WHERE status = 'resolved' AND adoBugId IS NOT NULL AND " +
            '(bugClosed IS NULL OR bugClosed = 0) AND resolvedAtSweep IS NOT NULL AND ' +
            '(:sweep - resolvedAtSweep) >= :threshold'
        )
        .all({ sweep: completedSweepNumber, threshold })
    );
    const setClosed = database.prepare('UPDATE findings SET bugClosed = 1 WHERE id = :id');
    for (const finding of toClose) {
      setClosed.run({ id: finding.id });
      close.push({ ...finding, bugClosed: true });
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
  return { comment, close };
}

/** Recover a dismissed/resolved finding back to open (owner action). Clears auto-resolve bookkeeping. */
export function recoverAuditFinding(id: string): AuditFinding | undefined {
  // Drop lastSeenSweep so the next sweep gets a clean chance to confirm before any auto-resolve.
  getDb()
    .prepare(
      "UPDATE findings SET status = 'open', dismissReason = NULL, dismissedBy = NULL, lastSeenSweep = NULL, " +
        'resolvedAtSweep = NULL, bugClosed = 0 WHERE id = :id'
    )
    .run({ id });
  return getAuditFindingById(id);
}

/**
 * Find an already-filed bug for the same file + category + line (a near-certain duplicate), so the caller
 * can reuse it instead of logging a second bug. Excludes the finding with `excludeId`.
 */
export function findExistingBugForLocation(
  filePath: string,
  category: AuditCategory,
  line: number,
  excludeId: string
): FiledBug | undefined {
  const rows = mapRows(
    getDb()
      .prepare(
        'SELECT * FROM findings WHERE pathKey = :pathKey AND category = :category AND line = :line AND ' +
          'adoBugId IS NOT NULL AND id != :excludeId LIMIT 1'
      )
      .all({ pathKey: normalizePathKey(filePath), category, line, excludeId })
  );
  if (rows.length === 0) {
    return undefined;
  }
  const match = rows[0];
  if (match.adoBugId === undefined) {
    return undefined;
  }
  return {
    bugId: match.adoBugId,
    bugUrl: match.adoBugUrl ?? '',
    areaPath: match.adoAreaPath,
    assignedTo: match.adoAssignedTo
  };
}

/** Read the resumable sweep cursor, or undefined when no sweep has started yet. */
export function readAuditProgress(): AuditProgress | undefined {
  const filePath = progressFilePath();
  if (!existsSync(filePath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  const result = auditProgressSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Persist the resumable sweep cursor. */
export function writeAuditProgress(progress: AuditProgress): void {
  mkdirSync(auditDir(), { recursive: true });
  writeFileSync(progressFilePath(), `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}
