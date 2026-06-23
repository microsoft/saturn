// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Azure DevOps coordinates of the repository Saturn reviews. */
export interface AzureDevOpsConfig {
  readonly host: string;
  readonly organization: string;
  readonly project: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  /** Default branch to track for review context (e.g. `master` or `main`). */
  readonly defaultBranch: string;
}

// Matches a single `KEY=VALUE` line in a `.env` file (with an optional leading `export `). Group 1 is the
// key, group 2 is the raw value (everything after `=`); surrounding quotes are stripped separately.
const ENV_LINE_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parse the contents of a `.env` file into key/value pairs, skipping blank and `#` comment lines. */
function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = ENV_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Populate `process.env` from the first `.env` file found, WITHOUT overriding variables already present in
 * the real environment (so explicit env vars and test overrides always win). Search order:
 *   1. `SATURN_ENV_FILE` (an explicit path), if set.
 *   2. `<cwd>/.env`              - the common case when running from the package root.
 *   3. `<entry-script dir>/.env` - so the deployed bundle (e.g. `C:\\saturn\\saturnDashboard.cjs`) finds
 *      `C:\\saturn\\.env` even though its launcher does not set a working directory.
 */
function loadEnvFile(): void {
  const candidatePaths: string[] = [];
  const explicitPath = process.env.SATURN_ENV_FILE;
  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    candidatePaths.push(explicitPath.trim());
  }
  candidatePaths.push(join(process.cwd(), '.env'));
  const entryScript = process.argv.at(1);
  if (entryScript !== undefined && entryScript !== '') {
    candidatePaths.push(join(dirname(entryScript), '.env'));
  }
  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }
    const parsed = parseEnvFile(readFileSync(candidatePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return;
  }
}

loadEnvFile();

/** Read a required configuration value from the environment, throwing a clear error if it is missing. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Saturn configuration error: ${name} is not set. Copy .env.example to .env and fill in the Azure DevOps coordinates of the repository to review.`
    );
  }
  return value.trim();
}

/** Read an optional configuration value from the environment, falling back to a default. */
function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Parse an Azure DevOps repository URL into its coordinates. Supports both the modern and legacy forms:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com[/{collection}]/{project}/_git/{repo}
 * Returns undefined if the string is not a recognizable repo URL.
 */
export function parseRepoUrl(
  rawUrl: string
): { organization: string; project: string; repositoryName: string } | undefined {
  const parsed = URL.parse(rawUrl);
  if (parsed === null) {
    return undefined;
  }
  const segments = parsed.pathname
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => segment !== '');
  const gitIndex = segments.indexOf('_git');
  if (gitIndex < 1 || gitIndex + 1 >= segments.length) {
    return undefined;
  }
  const repositoryName = segments[gitIndex + 1];
  const project = segments[gitIndex - 1];
  const hostname = parsed.hostname.toLowerCase();
  const organization = hostname.endsWith('.visualstudio.com')
    ? hostname.slice(0, hostname.length - '.visualstudio.com'.length)
    : segments[0];
  if (organization === '' || project === '' || repositoryName === '') {
    return undefined;
  }
  return { organization, project, repositoryName };
}

// SATURN_REPO_URL is the simplest way to point Saturn at a repo: just the repo's URL, parsed into
// org/project/repo. The individual SATURN_ADO_* variables remain supported as overrides/fallback.
const repoUrl = (process.env.SATURN_REPO_URL ?? '').trim();
const parsedRepo = repoUrl !== '' ? parseRepoUrl(repoUrl) : undefined;
if (repoUrl !== '' && parsedRepo === undefined) {
  throw new Error(
    `Saturn configuration error: SATURN_REPO_URL ("${repoUrl}") is not a recognizable Azure DevOps repo URL (expected .../_git/<repo>).`
  );
}
const adoOrganization = parsedRepo?.organization ?? requireEnv('SATURN_ADO_ORG');
const adoProject = parsedRepo?.project ?? requireEnv('SATURN_ADO_PROJECT');
const adoRepositoryName = parsedRepo?.repositoryName ?? requireEnv('SATURN_ADO_REPO_NAME');

/**
 * Azure DevOps identity for the repository Saturn reviews. Simplest setup: SATURN_REPO_URL (the repo's URL)
 * plus SATURN_ADO_DEFAULT_BRANCH. The individual SATURN_ADO_* vars are still honored as overrides.
 */
export const AZURE_DEVOPS_CONFIG: AzureDevOpsConfig = {
  host: envOrDefault('SATURN_ADO_HOST', 'dev.azure.com'),
  organization: adoOrganization,
  project: adoProject,
  repositoryName: adoRepositoryName,
  // The REST API accepts the repo name in place of the GUID, so the GUID is optional (override via SATURN_ADO_REPO_ID).
  repositoryId: envOrDefault('SATURN_ADO_REPO_ID', adoRepositoryName),
  defaultBranch: envOrDefault('SATURN_ADO_DEFAULT_BRANCH', 'master')
};

/**
 * Human-readable description of the repository under review, shown to the model so the review prompt stays
 * repo-agnostic (no hardcoded product name). Defaults to the ADO repo name; override with
 * SATURN_REPO_DESCRIPTION for a richer phrase (e.g. "the Contoso payments monorepo").
 */
export const REPO_DESCRIPTION: string = envOrDefault('SATURN_REPO_DESCRIPTION', `the ${adoRepositoryName} repository`);

interface LensPathRule {
  readonly pattern: RegExp;
  readonly suppress: readonly string[];
}

// Categories that must never be suppressed by a per-path rule (missing one of these is too costly).
const NEVER_SUPPRESSED_CATEGORIES: ReadonlySet<string> = new Set(['security', 'privacy', 'correctness']);

// Built-in defaults: in test files, skip design/api nits (test code intentionally bends those). Override
// with SATURN_LENS_RULES, JSON like: [{ "glob": "src/auth/**", "suppress": ["design","testing"] }].
const DEFAULT_LENS_RULES: readonly { readonly glob: string; readonly suppress: readonly string[] }[] = [
  { glob: '**/*.test.*', suppress: ['design', 'api'] },
  { glob: '**/*.spec.*', suppress: ['design', 'api'] },
  { glob: '**/test/**', suppress: ['design', 'api'] },
  { glob: '**/__tests__/**', suppress: ['design', 'api'] }
];

const lensRulesSchema = z.array(z.object({ glob: z.string(), suppress: z.array(z.string()) }));

// Convert a minimal glob (** across separators, * within a segment) to an anchored, case-insensitive regex.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, '@@GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@GLOBSTAR@@/g, '.*');
  return new RegExp(`^${pattern}$`, 'i');
}

function parseLensRules(): readonly LensPathRule[] {
  const configured = process.env.SATURN_LENS_RULES;
  let raw: readonly { readonly glob: string; readonly suppress: readonly string[] }[] = DEFAULT_LENS_RULES;
  if (configured !== undefined && configured.trim() !== '') {
    try {
      const parsed = lensRulesSchema.safeParse(JSON.parse(configured));
      if (parsed.success) {
        raw = parsed.data;
      }
    } catch {
      /* malformed SATURN_LENS_RULES JSON - fall back to defaults */
    }
  }
  return raw.map((rule) => ({ pattern: globToRegExp(rule.glob), suppress: rule.suppress }));
}

const LENS_PATH_RULES: readonly LensPathRule[] = parseLensRules();

/**
 * Categories suppressed for a given file path by the per-path lens config (e.g. skip design/api nits in
 * test files). security/privacy/correctness are never suppressed. Configure with SATURN_LENS_RULES.
 */
export function suppressedCategoriesForPath(filePath: string): ReadonlySet<string> {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const suppressed = new Set<string>();
  for (const rule of LENS_PATH_RULES) {
    if (rule.pattern.test(normalized) || rule.pattern.test(`/${normalized}`)) {
      for (const category of rule.suppress) {
        if (!NEVER_SUPPRESSED_CATEGORIES.has(category)) {
          suppressed.add(category);
        }
      }
    }
  }
  return suppressed;
}

/** Build an absolute Azure DevOps Git REST URL for a repository-relative API path. */
export function buildRepositoryApiUrl(relativePath: string): string {
  const { host, organization, project, repositoryId } = AZURE_DEVOPS_CONFIG;
  const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `https://${host}/${organization}/${project}/_apis/git/repositories/${repositoryId}${normalized}`;
}

/** Build the browser URL for a pull request, used in logs and summary comments. */
export function buildPullRequestWebUrl(pullRequestId: number): string {
  const { organization, project, repositoryName } = AZURE_DEVOPS_CONFIG;
  return `https://${organization}.visualstudio.com/${project}/_git/${repositoryName}/pullrequest/${String(pullRequestId)}`;
}

/** Build a deep link that opens a specific comment thread inside a pull request. */
export function buildCommentDeepLink(pullRequestId: number, threadId: number): string {
  return `${buildPullRequestWebUrl(pullRequestId)}?discussionId=${String(threadId)}`;
}

/** The agent's public-facing name, shown in its comments, the dashboard, and logs. */
export const BOT_NAME = 'Saturn';

/**
 * Hidden marker embedded in Saturn's lead summary comment. Detecting it on a PR's threads is how
 * Saturn avoids reviewing the same PR twice. Bump the version suffix to trigger a fresh review wave.
 */
export const BOT_REVIEW_MARKER = '<!-- saturn-review:v1 -->';

/** Port the Saturn dashboard (which also serves the feedback page) listens on; override with SATURN_PORT. */
const configuredDashboardPort = Number.parseInt(process.env.SATURN_PORT ?? '', 10);
export const DASHBOARD_PORT: number =
  Number.isNaN(configuredDashboardPort) || configuredDashboardPort <= 0 ? 6789 : configuredDashboardPort;

/**
 * Base URL of the Saturn feedback page. Set SATURN_FEEDBACK_URL to a corpnet-hosted dashboard (e.g.
 * https://saturn.<corp>/feedback) so other reviewers can reach it; otherwise defaults to the local dashboard.
 */
export function buildFeedbackBaseUrl(): string {
  const configured = process.env.SATURN_FEEDBACK_URL;
  if (configured !== undefined && configured.trim() !== '') {
    return configured.trim();
  }

  return `http://localhost:${String(DASHBOARD_PORT)}/feedback`;
}

/**
 * Build the per-comment feedback URL, carrying the PR id and comment (thread) id so the feedback page can
 * record what the feedback is about and the dashboard can deep-link back to the exact comment in the PR.
 */
export function buildFeedbackUrl(pullRequestId: number, commentId: number): string {
  const base = buildFeedbackBaseUrl();
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}prId=${String(pullRequestId)}&commentId=${String(commentId)}`;
}

/**
 * Whether feedback collection is enabled. Off by default until authenticated user attribution is in place, so
 * Saturn's comments carry no feedback link and the feedback page/endpoint are disabled. Enable with
 * SATURN_ENABLE_FEEDBACK=true.
 */
export function isFeedbackEnabled(): boolean {
  return (process.env.SATURN_ENABLE_FEEDBACK ?? '').trim().toLowerCase() === 'true';
}

/**
 * Pull request authors who have opted out of Saturn reviews; Saturn skips any PR created by a matching
 * author. Each entry may be a display name, email/UPN, or alias (the part before "@") - whichever you
 * prefer. SATURN_OPT_OUT_AUTHORS (comma-separated) extends this list.
 */
const DEFAULT_OPT_OUT_AUTHORS: readonly string[] = ['Angel Duran Maldonado (HE HIM)'];

export const OPT_OUT_AUTHORS: readonly string[] = [
  ...DEFAULT_OPT_OUT_AUTHORS,
  ...(process.env.SATURN_OPT_OUT_AUTHORS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
];

/**
 * True when the given PR author has opted out of Saturn reviews. Matches an opt-out entry against the
 * author's display name, their email/UPN, or their alias (the part before "@"), so the list can use any of
 * those forms.
 */
export function isOptedOutAuthor(authorName: string, authorUniqueName?: string): boolean {
  const candidates = new Set<string>();
  candidates.add(authorName.trim().toLowerCase());
  if (authorUniqueName !== undefined && authorUniqueName.trim() !== '') {
    const unique = authorUniqueName.trim().toLowerCase();
    candidates.add(unique);
    const atIndex = unique.indexOf('@');
    if (atIndex > 0) {
      candidates.add(unique.slice(0, atIndex));
    }
  }
  return OPT_OUT_AUTHORS.some((entry) => candidates.has(entry.trim().toLowerCase()));
}

function normalizeAllowlist(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

const reviewAllowlistSchema = z.object({ entries: z.array(z.string()) }).loose();

function reviewAllowlistFilePath(): string {
  return join(os.homedir(), '.saturn', 'review', 'allowlist.json');
}

/**
 * The reviewer allowlist. When empty, Saturn reviews ALL non-opted-out PRs; otherwise it only reviews a PR
 * whose AUTHOR or a REVIEWER matches an entry (aliases / emails / display names). Editable from the dashboard
 * (persisted to ~/.saturn/review/allowlist.json); seeded from SATURN_REVIEW_ALLOWLIST when no file exists yet.
 */
export function getReviewAllowlist(): readonly string[] {
  try {
    const parsed = reviewAllowlistSchema.safeParse(JSON.parse(readFileSync(reviewAllowlistFilePath(), 'utf8')));
    if (parsed.success) {
      return normalizeAllowlist(parsed.data.entries);
    }
  } catch {
    /* no allowlist file yet - fall back to the env default */
  }
  return normalizeAllowlist((process.env.SATURN_REVIEW_ALLOWLIST ?? '').split(','));
}

/** Persist the reviewer allowlist (dashboard owner action). Returns the normalized list that was stored. */
export function setReviewAllowlist(entries: readonly string[]): readonly string[] {
  const normalized = normalizeAllowlist(entries);
  try {
    mkdirSync(dirname(reviewAllowlistFilePath()), { recursive: true });
    writeFileSync(reviewAllowlistFilePath(), `${JSON.stringify({ entries: normalized }, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort persist */
  }
  return normalized;
}

/**
 * True when the PR is in scope for review given the current allowlist (see getReviewAllowlist). When the
 * allowlist is empty every non-opted-out PR is in scope.
 */
export function isAllowedForReview(
  authorName: string,
  authorUniqueName: string | undefined,
  reviewers: readonly { readonly displayName?: string; readonly uniqueName?: string }[]
): boolean {
  const allowlist = getReviewAllowlist();
  if (allowlist.length === 0) {
    return true;
  }
  const candidates = new Set<string>();
  const addCandidate = (value: string | undefined): void => {
    if (value === undefined || value.trim() === '') {
      return;
    }
    const lower = value.trim().toLowerCase();
    candidates.add(lower);
    const atIndex = lower.indexOf('@');
    if (atIndex > 0) {
      candidates.add(lower.slice(0, atIndex));
    }
  };
  addCandidate(authorName);
  addCandidate(authorUniqueName);
  for (const reviewer of reviewers) {
    addCandidate(reviewer.displayName);
    addCandidate(reviewer.uniqueName);
  }
  return allowlist.some((entry) => candidates.has(entry));
}

/** Build the attribution/disclaimer line shown at the top of each Saturn comment. */
export function buildBotDisclaimer(onBehalfOf: string): string {
  return (
    `**Automated review by Saturn on behalf of ${onBehalfOf}.** ` +
    'Saturn is an AI agent (GitHub Copilot) that reviews code for correctness, design, API, security, and ' +
    'privacy. These comments are AI-generated and may be incomplete or incorrect - this is a best-effort ' +
    'review, not a sign-off or approval. Please verify before merging.'
  );
}

/**
 * Wrap a single inline review comment with Saturn's attribution/disclaimer header and the hidden
 * review marker, so every posted comment is self-describing and carries the idempotency marker.
 */
export function buildCommentWithDisclaimer(commentBody: string, onBehalfOf: string): string {
  return `${buildBotDisclaimer(onBehalfOf)}\n\n${commentBody}\n\n${BOT_REVIEW_MARKER}`;
}

// ---------------------------------------------------------------------------------------------------
// Codebase audit agent (security & privacy sweep of the whole checked-out repo, separate from PR review)
// ---------------------------------------------------------------------------------------------------

/** Stable tag applied to every ADO bug Saturn's codebase audit files, so they are findable by search. */
export const AUDIT_BUG_TAG = 'SaturnAudit';

/** How many source files the audit sends to the model in a single multi-turn batch. */
export function auditBatchFileCount(): number {
  const parsed = Number.parseInt(process.env.SATURN_AUDIT_BATCH_FILES ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 6 : parsed;
}

/**
 * Soft per-call token ceiling for a batch's file content - a safety guardrail, NOT a throttle. The Copilot
 * CLI agent reads the prompt with tools (chunked reads + grep) and caches aggressively, so it comfortably
 * handles 100k+ token calls; this was verified live - a 157k-token file was processed in a single call
 * (~96k tokens used, 71k cached). A normal batch (file count x maxFileLines) stays well under this default,
 * so the ceiling almost never binds and only exists to stop a pathological mega-batch. Files are packed (up
 * to the file count above) until this budget is reached; a single oversized file is still sent whole.
 * Default 120000; override with SATURN_AUDIT_BATCH_TOKENS.
 */
export function auditBatchTokenBudget(): number {
  const parsed = Number.parseInt(process.env.SATURN_AUDIT_BATCH_TOKENS ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 120000 : parsed;
}

/**
 * How many consecutive completed sweeps a finding must stay undetected before its linked ADO bug is
 * auto-resolved (a comment is posted on the first miss). Default 2; override with
 * SATURN_AUDIT_CLOSE_AFTER_SWEEPS.
 */
export function auditCloseAfterSweeps(): number {
  const parsed = Number.parseInt(process.env.SATURN_AUDIT_CLOSE_AFTER_SWEEPS ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 2 : parsed;
}

/**
 * How long (ms) Saturn waits before re-polling a given filed bug's ADO state. Bounds the ADO calls the
 * fix-tracking reconcile makes - a finding's bug state is re-checked at most once per interval. Default 6h;
 * override the hours with SATURN_AUDIT_BUG_POLL_HOURS.
 */
export function auditBugPollIntervalMs(): number {
  const parsed = Number.parseFloat(process.env.SATURN_AUDIT_BUG_POLL_HOURS ?? '');
  const hours = Number.isNaN(parsed) || parsed <= 0 ? 6 : parsed;
  return Math.round(hours * 60 * 60 * 1000);
}

/**
 * How many filed bugs the fix-tracking reconcile polls per audit batch. Keeps the per-batch ADO load
 * bounded while still covering every finding over time. Default 8; override with
 * SATURN_AUDIT_BUG_POLL_BATCH.
 */
export function auditBugPollPerBatch(): number {
  const parsed = Number.parseInt(process.env.SATURN_AUDIT_BUG_POLL_BATCH ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 8 : parsed;
}

/**
 * Whether Saturn may reactivate (reopen) a bug a human marked fixed while Saturn still detects the issue.
 * Defaults OFF so Saturn never fights human triage unasked - when off it only comments. Override with
 * SATURN_AUDIT_BUG_REACTIVATE=true.
 */
export function isAuditBugReactivateOn(): boolean {
  return (process.env.SATURN_AUDIT_BUG_REACTIVATE ?? '').trim().toLowerCase() === 'true';
}

/**
 * The ADO state Saturn sets a bug back to when reactivating it (workflows differ: Agile "Active", Scrum
 * "Committed", Basic "Doing"). Default "Active"; override with SATURN_AUDIT_BUG_REACTIVATE_STATE.
 */
export function auditBugReactivateState(): string {
  const value = (process.env.SATURN_AUDIT_BUG_REACTIVATE_STATE ?? '').trim();
  return value !== '' ? value : 'Active';
}

/** Team-configured ADO state/reason terms that map a bug to a triage category (overriding the heuristics). */
export interface AuditBugStateMapping {
  readonly fixed: readonly string[];
  readonly wontfix: readonly string[];
  readonly needsinfo: readonly string[];
}

/**
 * Team-configurable mapping from ADO state/reason text to a triage category, for workflows whose state names
 * differ from the built-in heuristics. Each var is a comma-separated list of (case-insensitive) substrings
 * matched against "<state> <reason>"; configured terms take precedence over the built-ins. Override with
 * SATURN_AUDIT_BUG_FIXED_STATES / SATURN_AUDIT_BUG_WONTFIX_STATES / SATURN_AUDIT_BUG_NEEDSINFO_STATES.
 */
export function auditBugStateMapping(): AuditBugStateMapping {
  const terms = (value: string | undefined): readonly string[] =>
    (value ?? '')
      .split(',')
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term !== '');
  return {
    fixed: terms(process.env.SATURN_AUDIT_BUG_FIXED_STATES),
    wontfix: terms(process.env.SATURN_AUDIT_BUG_WONTFIX_STATES),
    needsinfo: terms(process.env.SATURN_AUDIT_BUG_NEEDSINFO_STATES)
  };
}

// --- Model configuration (shared by all agents) ----------------------------------------------------------

/** Primary Copilot model for all agents. Override with SATURN_MODEL. */
export function primaryModel(): string {
  const value = (process.env.SATURN_MODEL ?? '').trim();
  return value !== '' ? value : 'claude-opus-4.8';
}

/** Backup model used after consecutive failures on the primary. Override with SATURN_BACKUP_MODEL. */
export function backupModel(): string {
  const value = (process.env.SATURN_BACKUP_MODEL ?? '').trim();
  return value !== '' ? value : 'claude-opus-4.5';
}

/** How many consecutive failures on the primary model before switching to backup. Default 3. */
export function modelFailureThreshold(): number {
  const parsed = Number.parseInt(process.env.SATURN_MODEL_FAILURE_THRESHOLD ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 3 : parsed;
}

/**
 * Reasoning effort level for all agents: none | low | medium | high | xhigh | max. Default 'max' (the
 * Copilot CLI's highest/strongest level). Note: the opus-4.5 backup model has a fixed reasoning level and
 * rejects --effort; the Copilot wrapper detects that and retries without the flag, so this setting only
 * applies to models that accept it.
 */
export function defaultReasoningEffort(): string {
  const value = (process.env.SATURN_REASONING_EFFORT ?? '').trim();
  return value !== '' ? value : 'max';
}

// --- Code Autopilot (the standalone PR-authoring agent) --------------------------------------------------

/**
 * Which audit-finding category Code Autopilot draws bugs from. It only attempts findings of this category
 * that already have a filed ADO bug. Default 'accessibility'; override with SATURN_FIX_CATEGORY.
 */
export function fixTargetCategory(): string {
  const value = (process.env.SATURN_FIX_CATEGORY ?? '').trim();
  return value !== '' ? value : 'accessibility';
}

/**
 * Highest fix "phase" the agent will attempt: 1 = fix isolated to a single file, 2 = within a single
 * package, 3 = anything. The agent always prefers the lowest phase a bug qualifies for. Default 1
 * (single-file only) so it starts conservatively; override with SATURN_FIX_MAX_PHASE.
 */
export function fixMaxPhase(): 1 | 2 | 3 {
  const parsed = Number.parseInt(process.env.SATURN_FIX_MAX_PHASE ?? '', 10);
  return parsed === 2 ? 2 : parsed === 3 ? 3 : 1;
}

/**
 * Maximum number of open PRs Code Autopilot keeps in flight at once. Bounds how much it writes to ADO.
 * Default 1 (one PR at a time - also the safe default for first runs); override SATURN_FIX_MAX_OPEN_PRS.
 */
export function fixMaxOpenPrs(): number {
  const parsed = Number.parseInt(process.env.SATURN_FIX_MAX_OPEN_PRS ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 1 : parsed;
}

/** How often (ms) Code Autopilot iterates over its open PRs + considers starting a new one. Default 10 min. */
export function fixPollIntervalMs(): number {
  const parsed = Number.parseFloat(process.env.SATURN_FIX_POLL_MINUTES ?? '');
  const minutes = Number.isNaN(parsed) || parsed <= 0 ? 10 : parsed;
  return Math.round(minutes * 60 * 1000);
}

/** Branch-name prefix for fix branches (`<prefix>/<bugId>`). Default 'saturn/fix'; override SATURN_FIX_BRANCH_PREFIX. */
export function fixBranchPrefix(): string {
  const value = (process.env.SATURN_FIX_BRANCH_PREFIX ?? '').trim().replace(/\/+$/, '');
  return value !== '' ? value : 'saturn/fix';
}

/**
 * Dry-run mode: Code Autopilot generates + validates a fix locally but never pushes a branch or opens a PR.
 * Defaults OFF. Override with SATURN_FIX_DRY_RUN=true.
 */
export function isFixDryRun(): boolean {
  return (process.env.SATURN_FIX_DRY_RUN ?? '').trim().toLowerCase() === 'true';
}

/**
 * Pin Code Autopilot to a single ADO bug id (for testing - it will only ever work that one bug). Empty/unset
 * means normal selection. Override with SATURN_FIX_ONLY_BUG.
 */
export function fixOnlyBugId(): number | undefined {
  const parsed = Number.parseInt(process.env.SATURN_FIX_ONLY_BUG ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/** Max times Code Autopilot will re-push a PR to address feedback before giving up + leaving it for a human. */
export function fixMaxIterations(): number {
  const parsed = Number.parseInt(process.env.SATURN_FIX_MAX_ITERATIONS ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 5 : parsed;
}

/** Per Copilot fix-invocation timeout (ms). A fix can take a while; default 20 min. SATURN_FIX_TIMEOUT_MS. */
export function fixTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.SATURN_FIX_TIMEOUT_MS ?? '', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 1_200_000 : parsed;
}

/**
 * When true, Code Autopilot runs ESLint on the changed files in its clone before opening/updating a PR and
 * does a corrective model round on failures, so PRs start green. Off by default (it is slow). Override with
 * SATURN_FIX_PREPUSH_VALIDATE=true.
 */
export function isFixPrePushValidate(): boolean {
  return (process.env.SATURN_FIX_PREPUSH_VALIDATE ?? '').trim().toLowerCase() === 'true';
}

/**
 * Whether Code Autopilot rebuts non-actionable automated/bot PR comments: it posts a one-time explanation
 * and marks the thread won't-fix instead of silently ignoring them. On by default; set
 * SATURN_FIX_REBUT_BOT_COMMENTS=false to disable (e.g. if it adds noise on a given repo).
 */
export function isFixRebutBotComments(): boolean {
  return (process.env.SATURN_FIX_REBUT_BOT_COMMENTS ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Shared secret for the dashboard's ADO service-hook endpoint (`POST /api/hooks/ado`). When empty the
 * endpoint is disabled. Set SATURN_WEBHOOK_SECRET and pass it as the `x-saturn-secret` header (or `?secret=`)
 * from the Azure DevOps service hook so Code Autopilot reacts to build failures / comments immediately
 * instead of waiting for the next poll.
 */
export function webhookSecret(): string {
  return (process.env.SATURN_WEBHOOK_SECRET ?? '').trim();
}

/**
 * Whether the audit may file ADO bugs automatically (no human click). Defaults OFF - findings are stored
 * and shown in the dashboard, and a bug is only created when the owner clicks "Create bug" (or flips the
 * auto-create switch on). Override the default with SATURN_AUDIT_AUTO_CREATE=true.
 */
export function isAuditAutoCreateDefaultOn(): boolean {
  return (process.env.SATURN_AUDIT_AUTO_CREATE ?? '').trim().toLowerCase() === 'true';
}

/**
 * Optional fallback ADO area path, used ONLY when a finding's file has no resolvable `ownership.json`
 * (every package in the repo normally has one, which is the primary routing source). Empty by default.
 */
export function bugAreaPath(): string {
  return (process.env.SATURN_BUG_AREA_PATH ?? '').trim();
}

/**
 * Optional ADO iteration-path override. When empty (the default), the bug is filed without an explicit
 * iteration and ADO assigns the project's root iteration, so routing works with no configuration.
 */
export function bugIterationPath(): string {
  return (process.env.SATURN_BUG_ITERATION_PATH ?? '').trim();
}

/** Optional ADO team new audit bugs are assigned/area-defaulted to. Empty when not set. */
export function bugTeam(): string {
  return (process.env.SATURN_BUG_TEAM ?? '').trim();
}

/** Extra tags (comma-separated env) added to every audit bug on top of {@link AUDIT_BUG_TAG}. */
export function bugExtraTags(): readonly string[] {
  return (process.env.SATURN_BUG_TAGS ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** A finding-type -> ADO area path override, so e.g. accessibility findings can route to the a11y team. */
export interface BugTypeRoute {
  readonly category: string;
  readonly areaPath: string;
  readonly label: string;
  readonly assignedTo?: string;
}

const bugTypeRouteSchema = z.array(
  z.object({
    category: z.string(),
    areaPath: z.string(),
    label: z.string().optional(),
    assignedTo: z.string().optional()
  })
);

/**
 * Optional per-type routing overrides offered as alternatives alongside the package-owner route. Configure
 * with SATURN_BUG_TYPE_ROUTES, JSON like:
 *   [{ "category": "accessibility", "areaPath": "Project\\TeamA\\Accessibility", "label": "A11y team" }]
 * Empty by default; the package's `ownership.json` is always the primary route.
 */
export function bugTypeRoutes(): readonly BugTypeRoute[] {
  const configured = process.env.SATURN_BUG_TYPE_ROUTES;
  if (configured === undefined || configured.trim() === '') {
    return [];
  }
  try {
    const parsed = bugTypeRouteSchema.safeParse(JSON.parse(configured));
    if (!parsed.success) {
      return [];
    }
    return parsed.data.map((route) => ({
      category: route.category,
      areaPath: route.areaPath,
      label: route.label ?? `${route.category} team`,
      assignedTo: route.assignedTo
    }));
  } catch {
    return [];
  }
}

/**
 * Whether audit bugs can be routed. Always true: routing is derived from each package's `ownership.json`
 * (owner + ADO area path) at file time, with the env vars above as optional fallback/override, so bug
 * creation works out of the box with no manual area-path configuration.
 */
export function isBugCreationConfigured(): boolean {
  return true;
}

/** Build an absolute Azure DevOps REST URL for a project-scoped API path (e.g. work item tracking). */
export function buildProjectApiUrl(relativePath: string): string {
  const { host, organization, project } = AZURE_DEVOPS_CONFIG;
  const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `https://${host}/${organization}/${project}/_apis${normalized}`;
}

/** Build the browser URL of a work item (bug) by id. */
export function buildWorkItemWebUrl(workItemId: number): string {
  const { organization, project } = AZURE_DEVOPS_CONFIG;
  return `https://${organization}.visualstudio.com/${project}/_workitems/edit/${String(workItemId)}`;
}

/**
 * Build a deep link to a source file in the ADO web UI, highlighting a single line or a range of lines
 * (when `endLine` is past `line`), so the dashboard can point straight at the code a finding refers to.
 */
export function buildSourceFileUrl(filePath: string, line: number, endLine?: number): string {
  const { organization, project, repositoryName, defaultBranch } = AZURE_DEVOPS_CONFIG;
  const cleanPath = `/${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const safeLine = line > 0 ? line : 1;
  const safeEnd = endLine !== undefined && endLine > safeLine ? endLine : safeLine;
  const params = [
    `path=${encodeURIComponent(cleanPath)}`,
    `version=GB${encodeURIComponent(defaultBranch)}`,
    `line=${String(safeLine)}`,
    `lineEnd=${String(safeEnd + 1)}`,
    'lineStartColumn=1',
    'lineEndColumn=1',
    'lineStyle=plain',
    '_a=contents'
  ].join('&');
  return `https://${organization}.visualstudio.com/${project}/_git/${repositoryName}?${params}`;
}

/**
 * Build a shareable Azure DevOps work-item search link that surfaces audit bugs, optionally narrowed by
 * additional tags (e.g. a type tag like "Saturn-Security" or a severity tag). The audit tag is always
 * included so the link only ever returns Saturn's audit bugs.
 */
export function buildAuditSearchUrl(extraTags: readonly string[] = []): string {
  const { host, organization, project } = AZURE_DEVOPS_CONFIG;
  const tagTerms = [AUDIT_BUG_TAG, ...extraTags].map((tag) => `tags:${tag}`).join(' ');
  return `https://${host}/${organization}/${project}/_search?type=workitem&text=${encodeURIComponent(tagTerms)}`;
}

/** The severity + title header (plain text) shown at the top of a posted inline comment (mirrors the dashboard). */
export function buildFindingHeader(severity: string, title: string): string {
  return `${severity.toUpperCase()} \u2014 ${title}`;
}

/** Hidden, per-iteration tag embedded in a reactivation reply so Saturn replies at most once per iteration. */
export function buildIterationTag(iterationId: number): string {
  return `<!-- saturn-iter:${String(iterationId)} -->`;
}

/**
 * Build the reply Saturn posts when a prior comment still applies on a newer iteration. When the author
 * had resolved the thread, the reply notes the attempted fix did not resolve it ("tried but it did not
 * work"); otherwise it notes the issue is still open and unaddressed. The hidden iteration tag makes the
 * reply idempotent per iteration so an error-retry never double-replies.
 */
export function buildReactivationReply(options: {
  readonly iterationId: number;
  readonly authorAttemptedFix: boolean;
  readonly severity: string;
  readonly commentTitle: string;
}): string {
  const { iterationId, authorAttemptedFix, severity, commentTitle } = options;
  const reason = authorAttemptedFix
    ? `This thread was resolved, but the issue still applies as of iteration ${String(iterationId)} \u2014 the change here does not appear to resolve it.`
    : `This still applies as of iteration ${String(iterationId)} and has not been addressed yet.`;
  return `${reason} (Re: ${severity.toUpperCase()} \u2014 ${commentTitle})\n\n${buildIterationTag(iterationId)}`;
}
