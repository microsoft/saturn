// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import {
  addWorkItemComment,
  createBugWorkItem,
  getExistingThreadComments,
  getWorkItemState,
  reactivateWorkItem,
  resolveCurrentIterationPath,
  resolveTeamIterationPath,
  resolveWorkItem
} from './ado';
import {
  type AuditBugTriage,
  type AuditFinding,
  type AuditFindingFilter,
  type AuditFindingsPage,
  type AuditFixVerification,
  type AuditSeverity,
  type AuditStatusCounts,
  type AuditSummary,
  countAuditFindings,
  dismissAuditFinding,
  findExistingBugForLocation,
  getAuditFindingById,
  queryAuditFindings,
  queryAuditPackageCounts,
  queryAuditStatusCounts,
  queryAuditSummary,
  queryFindingsForBugPoll,
  queryPendingFindings,
  readAuditFindings,
  readAuditProgress,
  recordBugState,
  recoverAuditFinding,
  type ReconcileResult,
  reconcileResolvedFindings,
  setAuditFindingBug
} from './auditStore';
import { runAuditSweepStep, startNewAuditSweep } from './codebaseAudit';
import {
  AUDIT_BUG_TAG,
  type AuditBugStateMapping,
  AZURE_DEVOPS_CONFIG,
  BOT_REVIEW_MARKER,
  auditBatchFileCount,
  auditBatchTokenBudget,
  auditBugPollIntervalMs,
  auditBugPollPerBatch,
  auditBugReactivateState,
  auditBugStateMapping,
  auditCloseAfterSweeps,
  bugExtraTags,
  buildAuditSearchUrl,
  buildSourceFileUrl,
  isAuditAutoCreateDefaultOn,
  isAuditBugReactivateOn,
  isBugCreationConfigured
} from './config';
import { type BugRoute, buildBugRoutes, defaultHorizontalAreaOwners } from './bugRouting';
import { type AreaOwnerEntry, readAreaOwners, writeAreaOwners } from './areaOwners';
import { resolveCopilotCli } from './copilot';
import { defaultManagedCloneDir, installRepoDependenciesInBackground } from './git';
import type { ReviewOutcome } from './reviewPullRequest';
import { runSaturn, type SaturnProgressEvent, type SaturnRunSummary } from './runSaturn';
import {
  getReviewSummary,
  readReviewsCursor,
  readReviewStats,
  type ReviewFilters,
  type ReviewStats
} from './saturnStore';
import { describeError, type Logger } from './util';

const MASTER_UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000; // refresh the clone's master at most every 2 hours
const DEPS_INSTALL_INTERVAL_MS = 24 * 60 * 60 * 1000; // run "yarn install" in the clone at most once a day
const AUDIT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // begin a fresh whole-codebase sweep at most once a day
const AUDIT_BATCH_PACING_MS = 5 * 1000; // brief pause between audit batches so it never monopolizes the box
const AUDIT_MAX_AUTO_BUGS_PER_BATCH = 5; // cap auto-filed bugs per batch so a noisy batch cannot flood ADO

// Map an audit finding's severity to the Azure DevOps Bug "Severity" field value.
const SEVERITY_TO_ADO_SEVERITY: Record<AuditSeverity, string> = {
  blocking: '1 - Critical',
  major: '2 - High',
  minor: '3 - Medium',
  nit: '4 - Low'
};

// Reason/state phrases that mean the bug was closed without a fix (Saturn should respect it and stop
// surfacing the finding). Matched against the combined state + reason text, case-insensitively.
const WONT_FIX_PATTERN =
  /won.?t fix|by design|as designed|deferred|duplicate|not a bug|cannot reproduce|can.?t repro|external|obsolete|removed/i;
// Phrases that mean the bug is waiting on more information (Saturn should post the finding's details).
const NEEDS_INFO_PATTERN = /more info|needs? info|need more info|needinfo|clarif|question/i;
// Done-ish states that (absent a won't-fix reason) mean the owner believes the issue is fixed.
const FIXED_STATE_PATTERN = /resolved|closed|done|completed|fixed/i;

function termsInclude(haystack: string, terms: readonly string[]): boolean {
  return terms.some((term) => haystack.includes(term));
}

// Classify a bug's (state, reason) into the action Saturn should take. Team-configured mappings win over the
// built-in heuristics; among both, needs-info and won't-fix win over a done-ish state so, e.g.,
// "Closed / Duplicate" is respected rather than treated as a fix to validate.
export function classifyBugTriage(state: string, reason: string, mapping: AuditBugStateMapping): AuditBugTriage {
  const combined = `${state} ${reason}`.toLowerCase().trim();
  if (termsInclude(combined, mapping.needsinfo)) {
    return 'needsinfo';
  }
  if (termsInclude(combined, mapping.wontfix)) {
    return 'wontfix';
  }
  if (termsInclude(combined, mapping.fixed)) {
    return 'fixed';
  }
  if (NEEDS_INFO_PATTERN.test(combined)) {
    return 'needsinfo';
  }
  if (WONT_FIX_PATTERN.test(combined)) {
    return 'wontfix';
  }
  if (FIXED_STATE_PATTERN.test(state)) {
    return 'fixed';
  }
  return 'active';
}

// A plain-text summary of a finding, posted as a comment when its bug is waiting on more information.
function buildBugInfoComment(finding: AuditFinding): string {
  const location = `${finding.filePath}:${String(finding.line)}${
    finding.endLine !== undefined ? `-${String(finding.endLine)}` : ''
  }`;
  const lines: string[] = [
    'Saturn codebase-audit details for this bug (posted because it is marked as needing more information):',
    `- Issue: ${finding.title}`,
    `- Severity / category: ${finding.severity} / ${finding.category}`,
    `- Location: ${location}`,
    `- What Saturn found: ${finding.body}`
  ];
  if (finding.detail !== undefined && finding.detail.trim() !== '') {
    lines.push(`- In depth: ${finding.detail}`);
  }
  lines.push(`- Saturn finding id: ${finding.id}`);
  lines.push('(Best-effort automated analysis - please verify before acting.)');
  return lines.join('\n');
}

/** A single comment Saturn posted, as surfaced in the dashboard. */
export interface SaturnComment {
  readonly filePath: string;
  readonly line: number;
  readonly severity: string;
  readonly category?: string;
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
  readonly durationMs?: number;
  readonly model?: string;
  readonly filesReviewed?: number;
  readonly filesChanged?: number;
  readonly diffTruncated?: boolean;
  readonly candidatesProposed?: number;
  readonly candidatesKept?: number;
  readonly reasoningEffort?: string;
  readonly iterationCreatedAt?: string;
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

/** A pull request queued for review this cycle (for the up-next list). */
export interface SaturnUpNext {
  readonly id: number;
  readonly title: string;
}

/** The current ADO status of one of Saturn's comment threads (for the human-resolution signal). */
export interface SaturnThreadStatus {
  readonly threadId: number;
  readonly status: string;
  readonly isSaturn: boolean;
}

/** A snapshot of how the agent is configured (shown on the dashboard). */
export interface SaturnConfigSnapshot {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly scanIntervalMs: number;
  readonly maxReviews: number;
  readonly maxComments: number;
  readonly host: string;
  readonly organization: string;
  readonly project: string;
  readonly repositoryName: string;
  readonly defaultBranch: string;
  readonly commit: string;
}

/** One past scan cycle's outcome, for the dashboard's recent-activity panel. */
export interface SaturnScanRecord {
  readonly at: string;
  readonly kind: string;
  readonly scanned: number;
  readonly reviewed: number;
  readonly errors: number;
  readonly skipped: number;
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
  readonly config: SaturnConfigSnapshot;
  readonly recentScans: readonly SaturnScanRecord[];
  readonly currentPullRequestStartedAt: string | null;
  readonly upNext: readonly SaturnUpNext[];
}

/** Control surface for the always-on Saturn agent. */
export interface SaturnService {
  start(): SaturnState;
  stop(): SaturnState;
  getState(): SaturnState;
  getReviewsCursor(cursor: string | undefined, limit: number, filters?: ReviewFilters): SaturnReviewsCursorPage;
  getReviewStats(): ReviewStats;
  /** One-call bundle for the leadership Dashboard tab: PR-review stats + audit aggregates + sweep state. */
  getDashboardData(): DashboardData;
  getThreadStatuses(pullRequestId: number): Promise<readonly SaturnThreadStatus[]>;
  /** Start the parallel codebase security/privacy audit loop (independent of the PR-review loop). */
  startAudit(): SaturnAuditState;
  /** Stop the codebase audit loop. */
  stopAudit(): SaturnAuditState;
  /** Live state of the codebase audit loop (running, sweep progress, finding counts, toggle). */
  getAuditState(): SaturnAuditState;
  /** All audit findings (newest first), for the dashboard to list and filter. */
  getAuditFindings(): readonly AuditFinding[];
  /** A filtered, paginated page of findings + the total matching the filter (server-side pagination). */
  getAuditFindingsPage(filter: AuditFindingFilter, limit: number, offset: number): AuditFindingsPage;
  /** Pre-aggregated overview counts (severity / category / package facets) for the dashboard charts. */
  getAuditSummary(filter: AuditFindingFilter): AuditSummary;
  /** Candidate ADO routes (owning-team area paths) a finding's bug can be filed under, package owner first. */
  getBugRoutes(id: string): readonly BugRoute[];
  /** File an ADO bug for one finding (one-click). routeIndex picks an offered alternative (default 0). */
  createBugForFinding(id: string, routeIndex?: number, openedBy?: string): Promise<AuditFinding>;
  /** Dismiss a finding (with reason + dismisser alias) so it drops from the list and future sweeps. */
  dismissFinding(id: string, reason: string, dismissedBy: string): AuditFinding | undefined;
  /** Owner recovery: bring a dismissed/resolved finding back to open. */
  recoverFinding(id: string): AuditFinding | undefined;
  /** Flip the auto-create-bug switch (default off). */
  setAuditAutoCreate(enabled: boolean): SaturnAuditState;
  /** Curated area-owner entries (saved) plus auto-derived horizontal suggestions, for the dashboard editor. */
  getAreaOwners(): { readonly entries: readonly AreaOwnerEntry[]; readonly defaults: readonly AreaOwnerEntry[] };
  /** Replace the curated area-owner entries (dashboard editor). Returns the sanitized saved entries. */
  saveAreaOwners(entries: readonly AreaOwnerEntry[]): { readonly entries: readonly AreaOwnerEntry[] };
}

/** Live state of the parallel codebase audit loop, rendered in the dashboard's audit tab. */
export interface SaturnAuditState {
  readonly running: boolean;
  readonly phase: string;
  readonly startedAt: string | null;
  readonly lastBatchAt: string | null;
  /** Whether bugs are filed automatically for new findings (default off). */
  readonly autoCreate: boolean;
  /** Whether the ADO Bug coordinates (area/iteration path) are configured; bug creation is inert if not. */
  readonly bugCreationConfigured: boolean;
  /** Shareable ADO work-item search link that returns Saturn's audit bugs. */
  readonly searchUrl: string;
  readonly sweepNumber: number;
  readonly filesScanned: number;
  readonly totalFiles: number;
  readonly completedSweeps: number;
  readonly findingCount: number;
  readonly openCount: number;
  readonly bugsFiled: number;
}

/** Everything the leadership "Dashboard" tab needs in one call: PR-review stats + audit aggregates. */
export interface DashboardData {
  readonly review: ReviewStats;
  readonly audit: {
    readonly state: SaturnAuditState;
    readonly summary: AuditSummary;
    readonly statusCounts: AuditStatusCounts;
    readonly topPackages: readonly { readonly package: string; readonly count: number }[];
  };
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
  let currentPullRequestStartedAt: string | null = null;
  let upNext: SaturnUpNext[] = [];
  // Codebase-audit loop state, kept independent of the PR-review loop so neither blocks the other.
  let auditRunning = false;
  let auditLoopRunning = false;
  let auditPhase = 'stopped';
  let auditStartedAt: string | null = null;
  let auditLastBatchAt: string | null = null;
  let auditAutoCreate = isAuditAutoCreateDefaultOn();
  const recentScans: SaturnScanRecord[] = [];
  const configSnapshot: SaturnConfigSnapshot = {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    scanIntervalMs: config.scanIntervalMs,
    maxReviews: config.maxReviews,
    maxComments: config.maxComments,
    host: AZURE_DEVOPS_CONFIG.host,
    organization: AZURE_DEVOPS_CONFIG.organization,
    project: AZURE_DEVOPS_CONFIG.project,
    repositoryName: AZURE_DEVOPS_CONFIG.repositoryName,
    defaultBranch: AZURE_DEVOPS_CONFIG.defaultBranch,
    commit: (process.env.SATURN_COMMIT ?? '').trim()
  };

  // Keep a short ring of recent scan cycles so the dashboard can show what the agent has been doing.
  function pushScanRecord(scan: SaturnRunSummary, kind: string): void {
    recentScans.unshift({
      at: new Date().toISOString(),
      kind,
      scanned: scan.scannedPullRequests,
      reviewed: countActualReviews(scan.outcomes),
      errors: scan.outcomes.filter((outcome) => outcome.status === 'error').length,
      skipped: Math.max(0, scan.scannedPullRequests - scan.eligibleCandidates)
    });
    if (recentScans.length > 12) {
      recentScans.length = 12;
    }
  }

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
      reviewedPullRequestCount: summary.reviewedPullRequestCount,
      config: configSnapshot,
      recentScans: [...recentScans],
      currentPullRequestStartedAt,
      upNext: upNext.slice(0, 10)
    };
  }

  function handleProgress(event: SaturnProgressEvent): void {
    if (event.type === 'candidates') {
      upNext = event.pullRequests.map((pullRequest) => ({ id: pullRequest.pullRequestId, title: pullRequest.title }));
      return;
    }
    if (event.type === 'pr-start') {
      phase = 'reviewing';
      currentPullRequest = {
        id: event.pullRequest.pullRequestId,
        title: event.pullRequest.title,
        webUrl: event.pullRequest.webUrl
      };
      currentPullRequestStartedAt = new Date().toISOString();
      upNext = upNext.filter((entry) => entry.id !== event.pullRequest.pullRequestId);
      return;
    }

    // pr-done: runSaturn persists the review record into the shared store; here we only clear live status.
    currentPullRequest = null;
    currentPullRequestStartedAt = null;
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
          pushScanRecord(scan, 'scan');
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
            pushScanRecord(backfill, 'backfill');
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
      currentPullRequestStartedAt = null;
      upNext = [];
    }
  }

  function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Format a finding location as a deep link to the highlighted source (single line or block range).
  function locationLink(filePath: string, line: number, endLine?: number): string {
    const label =
      endLine !== undefined && endLine > line
        ? `${filePath}:${String(line)}-${String(endLine)}`
        : `${filePath}:${String(line)}`;
    return `<a href="${escapeHtml(buildSourceFileUrl(filePath, line, endLine))}">${escapeHtml(label)}</a>`;
  }

  // Build the HTML repro-steps body for a bug filed from an audit finding. Mirrors everything the dashboard
  // shows for the finding so the bug is self-contained: category / severity / confidence, deep-linked
  // location(s), the full details text, and provenance - rather than just a one-line summary.
  function buildBugReproHtml(finding: AuditFinding, openedBy?: string): string {
    const confidence = `${String(Math.round(finding.confidence * 100))}%`;
    const trimmedOpenedBy = openedBy !== undefined ? openedBy.trim() : '';
    const parts: string[] = [];
    if (trimmedOpenedBy !== '') {
      // Manual creation from the dashboard: highlight that a person opened this after reviewing the finding.
      parts.push(
        `<p>&#128270; <b>Opened by ${escapeHtml(trimmedOpenedBy)} after reviewing</b> the issue reported by Saturn&#39;s Code Audit.</p>`
      );
    }
    parts.push(
      `<p><b>Saturn codebase audit finding</b> &mdash; ${escapeHtml(finding.category)} / ${escapeHtml(finding.severity)} &middot; confidence ${escapeHtml(confidence)}</p>`,
      `<p><b>Location:</b> ${locationLink(finding.filePath, finding.line, finding.endLine)}</p>`
    );
    if (finding.relatedLocations !== undefined && finding.relatedLocations.length > 0) {
      const links = finding.relatedLocations
        .map((location) => `<li>${locationLink(location.filePath, location.line, location.endLine)}</li>`)
        .join('');
      parts.push(`<p><b>Also affects:</b></p><ul>${links}</ul>`);
    }
    parts.push(`<p><b>Issue:</b> ${escapeHtml(finding.title)}</p>`);
    parts.push(`<p><b>Details:</b><br/>${escapeHtml(finding.body).replace(/\n/g, '<br/>')}</p>`);
    if (finding.detail !== undefined && finding.detail.trim() !== '') {
      parts.push(`<p><b>In depth:</b><br/>${escapeHtml(finding.detail).replace(/\n/g, '<br/>')}</p>`);
    }
    const provenance: string[] = [];
    if (finding.introducedAt !== undefined) {
      provenance.push(`in the codebase since ${escapeHtml(finding.introducedAt)}`);
    }
    provenance.push(`first flagged ${escapeHtml(finding.firstSeenAt)}`);
    provenance.push(`last seen ${escapeHtml(finding.lastSeenAt)}`);
    if (finding.lastSeenSweep !== undefined) {
      provenance.push(`sweep #${String(finding.lastSeenSweep)}`);
    }
    parts.push(`<p><b>Provenance:</b> ${provenance.join(' &middot; ')}</p>`);
    parts.push(`<p><i>Saturn finding id ${escapeHtml(finding.id)}</i></p>`);
    parts.push(
      trimmedOpenedBy !== ''
        ? `<p><i>Opened by ${escapeHtml(trimmedOpenedBy)} after manually reviewing a Saturn codebase-audit finding - best-effort, please verify before acting.</i></p>`
        : '<p><i>Filed automatically by Saturn&#39;s codebase audit - best-effort, please verify before acting.</i></p>'
    );
    return parts.join('');
  }

  // Resolve the candidate ADO routes (owning-team area paths) for a finding, ordered with the file's
  // package owner first - that default is what auto-filing uses; alternatives are offered in the UI.
  function bugRoutesFor(finding: AuditFinding): readonly BugRoute[] {
    const repoRoot = config.cloneDir ?? defaultManagedCloneDir();
    return buildBugRoutes(repoRoot, finding.filePath, finding.category);
  }

  // File an ADO bug for a single finding (idempotent: a finding that already has a bug is returned as-is).
  // The route (owning-team area path + assignee) is derived from the file's ownership.json; pass routeIndex
  // to file under one of the offered alternatives instead of the package-owner default.
  async function fileBugForFinding(finding: AuditFinding, routeIndex = 0, openedBy?: string): Promise<AuditFinding> {
    if (finding.adoBugId !== undefined) {
      return finding;
    }
    // Avoid logging a duplicate bug: if another finding already filed one for the same file + category +
    // line (a near-certain duplicate, even if the title drifted), reuse that bug instead of creating a new.
    const existingBug = findExistingBugForLocation(finding.filePath, finding.category, finding.line, finding.id);
    if (existingBug !== undefined) {
      return setAuditFindingBug(finding.id, existingBug) ?? finding;
    }
    const routes = bugRoutesFor(finding);
    if (routes.length === 0) {
      throw new Error(
        `No ADO area path could be resolved for ${finding.filePath} (no ownership.json on the path and no SATURN_BUG_AREA_PATH fallback set).`
      );
    }
    const route = routes[Math.min(Math.max(routeIndex, 0), routes.length - 1)];
    const repoRoot = config.cloneDir ?? defaultManagedCloneDir();
    // Prefer the route's iteration override, then the owning team's current sprint, then the project's
    // current sprint; createBugWorkItem's retry drops the iteration if ADO rejects it.
    const iterationPath =
      route.iterationPath ??
      (await resolveTeamIterationPath(repoRoot, route.areaPath)) ??
      (await resolveCurrentIterationPath(repoRoot));
    const tags = [AUDIT_BUG_TAG, `Saturn-${finding.category}`, `Saturn-${finding.severity}`, ...bugExtraTags()];
    const created = await createBugWorkItem(repoRoot, {
      title: `[Saturn audit] ${finding.title}`,
      reproStepsHtml: buildBugReproHtml(finding, openedBy),
      areaPath: route.areaPath,
      iterationPath,
      assignedTo: route.assignedTo,
      severity: SEVERITY_TO_ADO_SEVERITY[finding.severity],
      tags
    });
    return (
      setAuditFindingBug(finding.id, {
        bugId: created.id,
        bugUrl: created.url,
        areaPath: route.areaPath,
        assignedTo: route.assignedTo
      }) ?? finding
    );
  }

  // Auto-create bugs for open, not-yet-filed findings (capped per batch), used only when the toggle is on.
  // Each routes to its package owner's area path automatically, so enabling the toggle "just works".
  async function autoCreatePendingBugs(): Promise<void> {
    const pending = queryPendingFindings(AUDIT_MAX_AUTO_BUGS_PER_BATCH);
    for (const finding of pending) {
      if (!auditRunning) {
        break;
      }
      try {
        await fileBugForFinding(finding);
      } catch (error) {
        logger.warn(`Saturn audit: auto-create bug failed for ${finding.id}: ${describeError(error)}`);
      }
    }
  }

  // After a sweep completes: newly-undetected findings are marked resolved and get an "appears fixed"
  // comment on their bug; findings that have stayed undetected for enough sweeps have their bug
  // auto-resolved in ADO. A false drop is harmless - the finding (and its bug) re-open if a later sweep
  // detects it again.
  async function reconcileResolvedAfterSweep(completedSweep: number): Promise<void> {
    const repoRoot = config.cloneDir ?? defaultManagedCloneDir();
    let result: ReconcileResult = { comment: [], close: [] };
    try {
      result = reconcileResolvedFindings(completedSweep, auditCloseAfterSweeps());
    } catch (error) {
      logger.warn(`Saturn audit: resolve reconciliation failed: ${describeError(error)}`);
      return;
    }
    for (const finding of result.comment) {
      if (!auditRunning || finding.adoBugId === undefined) {
        continue;
      }
      try {
        await addWorkItemComment(
          repoRoot,
          finding.adoBugId,
          `Saturn no longer detects this issue as of audit sweep ${String(completedSweep)} - it may have been fixed. (Saturn re-opens the finding automatically if a later sweep detects it again.)`
        );
      } catch (error) {
        logger.warn(
          `Saturn audit: resolve-comment failed for bug ${String(finding.adoBugId)}: ${describeError(error)}`
        );
      }
    }
    for (const finding of result.close) {
      if (!auditRunning || finding.adoBugId === undefined) {
        continue;
      }
      try {
        await addWorkItemComment(
          repoRoot,
          finding.adoBugId,
          'Saturn has not detected this issue for multiple consecutive sweeps; auto-resolving the bug. (It re-opens automatically if a later sweep detects it again.)'
        );
        await resolveWorkItem(repoRoot, finding.adoBugId);
      } catch (error) {
        logger.warn(`Saturn audit: bug auto-resolve failed for ${String(finding.adoBugId)}: ${describeError(error)}`);
      }
    }
  }

  // Reconcile open/auto-resolved findings against how a human triaged their linked bug. Polls a bounded,
  // cooldown-gated batch of filed bugs each audit batch so the ADO load stays small while every finding is
  // covered over time. The observed state is always recorded (so an unchanged bug is not re-processed) and
  // surfaced in the dashboard.
  async function reconcileBugStatesStep(): Promise<void> {
    const repoRoot = config.cloneDir ?? defaultManagedCloneDir();
    let candidates: readonly AuditFinding[] = [];
    try {
      const staleBefore = new Date(Date.now() - auditBugPollIntervalMs()).toISOString();
      candidates = queryFindingsForBugPoll(staleBefore, auditBugPollPerBatch());
    } catch (error) {
      logger.warn(`Saturn audit: bug-state poll query failed: ${describeError(error)}`);
      return;
    }
    for (const finding of candidates) {
      if (!auditRunning || finding.adoBugId === undefined) {
        break;
      }
      try {
        const observed = await getWorkItemState(repoRoot, finding.adoBugId);
        if (observed !== undefined) {
          await applyBugTriage(repoRoot, finding, observed.state, observed.reason);
        }
      } catch (error) {
        logger.warn(
          `Saturn audit: bug-state reconcile failed for bug ${String(finding.adoBugId)}: ${describeError(error)}`
        );
      }
    }
  }

  // Act on one finding given its bug's observed (state, reason): validate fixes, respect won't-fix, answer
  // needs-info, and always record the state so an unchanged bug is not re-processed next interval.
  async function applyBugTriage(repoRoot: string, finding: AuditFinding, state: string, reason: string): Promise<void> {
    if (finding.adoBugId === undefined) {
      return;
    }
    const triage = classifyBugTriage(state, reason, auditBugStateMapping());
    const nowIso = new Date().toISOString();
    const unchanged = finding.bugState === state && finding.bugStateReason === reason;

    if (triage === 'fixed') {
      // A human marked it fixed: 'confirmed' when Saturn also no longer detects it (status resolved),
      // 'still-present' when Saturn still detects it (status open). The dashboard badge surfaces this - Saturn
      // does not comment on the bug unless it actually reopens one (reactivation), which it then explains.
      const verification: AuditFixVerification = finding.status === 'resolved' ? 'confirmed' : 'still-present';
      const isNew = !(unchanged && finding.fixVerification === verification);
      if (isNew && verification === 'still-present' && isAuditBugReactivateOn()) {
        await addWorkItemComment(
          repoRoot,
          finding.adoBugId,
          `This bug was marked ${state}, but Saturn still detects the issue as of its latest sweep, so it has been reopened to ${auditBugReactivateState()} for another look.`
        );
        await reactivateWorkItem(repoRoot, finding.adoBugId, auditBugReactivateState());
      }
      recordBugState(finding.id, {
        bugState: state,
        bugStateReason: reason,
        bugStateCheckedAt: nowIso,
        bugTriage: triage,
        fixVerification: verification,
        ...(finding.bugInfoProvidedAt !== undefined ? { bugInfoProvidedAt: finding.bugInfoProvidedAt } : {})
      });
      return;
    }

    if (triage === 'wontfix') {
      // The human closed the bug without a fix - do nothing to it (no dismiss, no comment). Just record the
      // state + triage so the dashboard's "Won't fix" filter surfaces it out of the open list.
      recordBugState(finding.id, {
        bugState: state,
        bugStateReason: reason,
        bugStateCheckedAt: nowIso,
        bugTriage: triage,
        ...(finding.fixVerification !== undefined ? { fixVerification: finding.fixVerification } : {}),
        ...(finding.bugInfoProvidedAt !== undefined ? { bugInfoProvidedAt: finding.bugInfoProvidedAt } : {})
      });
      return;
    }

    if (triage === 'needsinfo') {
      // Waiting on information: post the finding's details once per state occurrence.
      let infoProvidedAt = finding.bugInfoProvidedAt;
      if (!(unchanged && finding.bugInfoProvidedAt !== undefined)) {
        await addWorkItemComment(repoRoot, finding.adoBugId, buildBugInfoComment(finding));
        infoProvidedAt = nowIso;
      }
      recordBugState(finding.id, {
        bugState: state,
        bugStateReason: reason,
        bugStateCheckedAt: nowIso,
        bugTriage: triage,
        ...(finding.fixVerification !== undefined ? { fixVerification: finding.fixVerification } : {}),
        ...(infoProvidedAt !== undefined ? { bugInfoProvidedAt: infoProvidedAt } : {})
      });
      return;
    }

    // 'active': still being worked - only record the state (carry forward prior verification/info markers).
    recordBugState(finding.id, {
      bugState: state,
      bugStateReason: reason,
      bugStateCheckedAt: nowIso,
      bugTriage: triage,
      ...(finding.fixVerification !== undefined ? { fixVerification: finding.fixVerification } : {}),
      ...(finding.bugInfoProvidedAt !== undefined ? { bugInfoProvidedAt: finding.bugInfoProvidedAt } : {})
    });
  }

  // The parallel codebase-audit loop: sweep the whole repo in resumable batches, double-checking each
  // finding, and (optionally) auto-filing bugs. Independent of runLoop so neither blocks the other.
  async function runAuditLoop(): Promise<void> {
    auditLoopRunning = true;
    try {
      const cliPath = resolveCopilotCli();
      if (cliPath === undefined) {
        logger.warn('Saturn audit: Copilot CLI not found; the audit loop cannot run.');
        auditRunning = false;
        return;
      }
      const repoRoot = config.cloneDir ?? defaultManagedCloneDir();
      while (auditRunning) {
        auditPhase = 'scanning';
        let sweepComplete = false;
        let addedThisBatch = 0;
        let completedSweep = 0;
        try {
          const step = await runAuditSweepStep({
            repoRoot,
            cliPath,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            batchTimeoutMs: config.reviewTimeoutMs,
            batchFileCount: auditBatchFileCount(),
            batchTokenBudget: auditBatchTokenBudget(),
            maxFileLines: 1500,
            logger
          });
          auditLastBatchAt = new Date().toISOString();
          sweepComplete = step.sweepComplete;
          addedThisBatch = step.added;
          completedSweep = step.sweepNumber;
        } catch (error) {
          logger.warn(`Saturn audit: sweep step failed: ${describeError(error)}`);
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- auditRunning flips during the awaits above
        if (!auditRunning) {
          break;
        }

        if (auditAutoCreate && addedThisBatch > 0) {
          await autoCreatePendingBugs();
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- auditRunning flips during the await above
          if (!auditRunning) {
            break;
          }
        }

        // Reconcile a bounded batch of filed bugs against human triage (fixed / won't-fix / needs-info).
        await reconcileBugStatesStep();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- auditRunning flips during the await above
        if (!auditRunning) {
          break;
        }

        if (sweepComplete) {
          // The whole codebase has been swept: reconcile auto-resolved findings, then idle until ~24h after
          // the sweep began, then start the next.
          auditPhase = 'idle';
          if (completedSweep > 0) {
            await reconcileResolvedAfterSweep(completedSweep);
          }
          const progress = readAuditProgress();
          const sweepStartedMs = progress !== undefined ? Date.parse(progress.sweepStartedAt) : Date.now();
          const waitUntil = (Number.isNaN(sweepStartedMs) ? Date.now() : sweepStartedMs) + AUDIT_SWEEP_INTERVAL_MS;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- auditRunning is flipped by stopAudit() during the awaited delay
          while (auditRunning && Date.now() < waitUntil) {
            await delay(2000);
          }
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- auditRunning is flipped by stopAudit() during the awaited delay
          if (auditRunning) {
            startNewAuditSweep(repoRoot);
          }
          continue;
        }

        // Pace between batches so the audit shares the box gracefully with the PR-review loop.
        const pacingUntil = Date.now() + AUDIT_BATCH_PACING_MS;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- auditRunning is flipped by stopAudit() during the awaited delay
        while (auditRunning && Date.now() < pacingUntil) {
          await delay(1000);
        }
      }
    } finally {
      auditLoopRunning = false;
      auditPhase = 'stopped';
    }
  }

  function auditSnapshot(): SaturnAuditState {
    const counts = countAuditFindings();
    const progress = readAuditProgress();
    return {
      running: auditRunning,
      phase: auditPhase,
      startedAt: auditStartedAt,
      lastBatchAt: auditLastBatchAt,
      autoCreate: auditAutoCreate,
      bugCreationConfigured: isBugCreationConfigured(),
      searchUrl: buildAuditSearchUrl(),
      sweepNumber: progress?.sweepNumber ?? 0,
      filesScanned: progress?.filesScanned ?? 0,
      totalFiles: progress?.totalFiles ?? 0,
      completedSweeps: progress?.completedSweeps ?? 0,
      findingCount: counts.total,
      openCount: counts.open,
      bugsFiled: counts.withBug
    };
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
    getReviewsCursor(cursor: string | undefined, limit: number, filters?: ReviewFilters): SaturnReviewsCursorPage {
      return readReviewsCursor(cursor, limit, filters);
    },
    getReviewStats(): ReviewStats {
      return readReviewStats();
    },
    getDashboardData(): DashboardData {
      return {
        review: readReviewStats(),
        audit: {
          state: auditSnapshot(),
          summary: queryAuditSummary({ status: 'open' }),
          statusCounts: queryAuditStatusCounts(),
          topPackages: queryAuditPackageCounts(8)
        }
      };
    },
    async getThreadStatuses(pullRequestId: number): Promise<readonly SaturnThreadStatus[]> {
      const repoRoot = config.cloneDir ?? defaultManagedCloneDir();
      try {
        const threads = await getExistingThreadComments(repoRoot, pullRequestId);
        return threads
          .filter((thread) => thread.threadId !== undefined)
          .map((thread) => ({
            threadId: thread.threadId ?? 0,
            status: thread.status ?? '',
            isSaturn: thread.content.includes(BOT_REVIEW_MARKER)
          }));
      } catch {
        return [];
      }
    },
    startAudit(): SaturnAuditState {
      if (!auditRunning) {
        auditRunning = true;
        auditStartedAt = new Date().toISOString();
        auditPhase = 'scanning';
        if (!auditLoopRunning) {
          void runAuditLoop();
        }
      }
      return auditSnapshot();
    },
    stopAudit(): SaturnAuditState {
      auditRunning = false;
      auditPhase = 'stopped';
      return auditSnapshot();
    },
    getAuditState(): SaturnAuditState {
      return auditSnapshot();
    },
    getAuditFindings(): readonly AuditFinding[] {
      return readAuditFindings();
    },
    getAuditFindingsPage(filter: AuditFindingFilter, limit: number, offset: number): AuditFindingsPage {
      return queryAuditFindings(filter, limit, offset);
    },
    getAuditSummary(filter: AuditFindingFilter): AuditSummary {
      return queryAuditSummary(filter);
    },
    getAreaOwners(): { readonly entries: readonly AreaOwnerEntry[]; readonly defaults: readonly AreaOwnerEntry[] } {
      const repoRoot = config.cloneDir ?? defaultManagedCloneDir();
      return { entries: readAreaOwners().entries, defaults: defaultHorizontalAreaOwners(repoRoot) };
    },
    saveAreaOwners(entries: readonly AreaOwnerEntry[]): { readonly entries: readonly AreaOwnerEntry[] } {
      return writeAreaOwners(entries);
    },
    getBugRoutes(id: string): readonly BugRoute[] {
      const finding = getAuditFindingById(id);
      return finding === undefined ? [] : bugRoutesFor(finding);
    },
    async createBugForFinding(id: string, routeIndex?: number, openedBy?: string): Promise<AuditFinding> {
      const finding = getAuditFindingById(id);
      if (finding === undefined) {
        throw new Error(`Unknown audit finding: ${id}`);
      }
      return fileBugForFinding(finding, routeIndex ?? 0, openedBy);
    },
    dismissFinding(id: string, reason: string, dismissedBy: string): AuditFinding | undefined {
      return dismissAuditFinding(id, reason, dismissedBy);
    },
    recoverFinding(id: string): AuditFinding | undefined {
      return recoverAuditFinding(id);
    },
    setAuditAutoCreate(enabled: boolean): SaturnAuditState {
      auditAutoCreate = enabled;
      return auditSnapshot();
    }
  };
}
