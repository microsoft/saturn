// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import {
  addWorkItemComment,
  type BotCommentThread,
  createPullRequest,
  getActiveBotCommentThreads,
  getActivePullRequestComments,
  getAzureDevOpsAuthHeader,
  getPullRequestChecks,
  getPullRequestProgress,
  markThreadWontFix,
  type PullRequestChecks,
  requeuePolicyEvaluation,
  SATURN_BOT_REBUTTAL_MARKER
} from './ado';
import { AUDIT_CATEGORIES, type AuditFinding, getAuditFindingById, queryAuditFindings } from './auditStore';
import {
  AZURE_DEVOPS_CONFIG,
  fixBranchPrefix,
  fixMaxIterations,
  fixMaxPhase,
  fixOnlyBugId,
  fixTargetCategory,
  isFixDryRun,
  isFixPrePushValidate,
  isFixRebutBotComments
} from './config';
import { runCopilotEdit, runCopilotReview } from './copilot';
import {
  commitAllChanges,
  createFixBranch,
  deleteLocalFixBranch,
  lintChangedFilesInClone,
  pushFixBranch,
  workingTreeChanges
} from './git';
import {
  createFixTask,
  type FixTask,
  getFixScopePaths,
  getFixTaskById,
  getFixTaskByFinding,
  getRetryableFailedTask,
  updateFixTask
} from './fixStore';
import { describeError, type Logger } from './util';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** A bug Code Autopilot is about to attempt, with the phase its footprint qualifies for. */
export interface FixCandidate {
  readonly finding: AuditFinding;
  readonly phase: 1 | 2 | 3;
  /** If set, this is a retry of a previously failed task. */
  readonly retryTaskId?: string;
}

/** Per-run inputs shared by the selection + generation + monitoring steps. */
export interface FixRunOptions {
  readonly cloneDir: string;
  readonly cliPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly timeoutMs: number;
  /** When set, the Azure DevOps MCP server name to allow so the agent can investigate PRs/builds itself. */
  readonly allowMcpServerName?: string;
}

// Derive the owning package of a repo-relative path (mirrors the audit store's package grouping).
export function packageOf(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  const root = parts[0] ?? '';
  if (parts.length >= 2 && (root === 'packages' || root === 'apps' || root === 'tools' || root === 'common')) {
    return `${root}/${String(parts[1])}`;
  }
  return root;
}

// The set of files a finding spans (primary + related locations).
function fixFootprint(finding: AuditFinding): readonly string[] {
  const files = new Set<string>([finding.filePath]);
  for (const location of finding.relatedLocations ?? []) {
    files.add(location.filePath);
  }
  return [...files];
}

// Phase 1 = single file, 2 = single package, 3 = multiple packages.
export function phaseForFiles(files: readonly string[]): 1 | 2 | 3 {
  const unique = [...new Set(files)];
  if (unique.length <= 1) {
    return 1;
  }
  const packages = new Set(unique.map(packageOf));
  return packages.size <= 1 ? 2 : 3;
}

function determinePhase(finding: AuditFinding): 1 | 2 | 3 {
  return phaseForFiles(fixFootprint(finding));
}

/**
 * Per-bug phase promotion. Every bug is first attempted at the narrowest scope (phase 1 - single file) and
 * is only widened when a narrower attempt fails, never beyond the configured cap. Given the phase of the
 * attempt that just failed, return the next (one-wider) phase to try.
 */
export function promotedPhase(previousPhase: 1 | 2 | 3, maxPhase: 1 | 2 | 3): 1 | 2 | 3 {
  const next = Math.min(previousPhase + 1, maxPhase);
  return next >= 3 ? 3 : next === 2 ? 2 : 1;
}

// True when a finding's footprint touches at least one configured scope prefix (or the scope is empty).
function findingTouchesScope(finding: AuditFinding, scopePaths: readonly string[]): boolean {
  if (scopePaths.length === 0) {
    return true;
  }
  return fixFootprint(finding).some((file) => {
    const normalized = file.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    return scopePaths.some((prefix) => {
      const lowerPrefix = prefix.toLowerCase();
      return normalized === lowerPrefix || normalized.startsWith(`${lowerPrefix}/`);
    });
  });
}

function locLabel(filePath: string, line: number, endLine?: number): string {
  return endLine !== undefined && endLine > line
    ? `${filePath}:${String(line)}-${String(endLine)}`
    : `${filePath}:${String(line)}`;
}

/**
 * Pick the next bug to fix: the first open finding (newest-first) of the target category that has a filed
 * ADO bug, fits within the configured phase cap, and either hasn't been attempted yet or has a failed task
 * with retries remaining. When SATURN_FIX_ONLY_BUG is set, only that exact bug is ever returned.
 * Returns undefined when nothing qualifies.
 */
export function selectBugToFix(): FixCandidate | undefined {
  const onlyBug = fixOnlyBugId();
  const maxPhase = fixMaxPhase();
  const maxRetries = 3; // Allow up to 3 retry attempts for failed tasks
  const scopePaths = getFixScopePaths();
  const pageSize = 200;
  for (let offset = 0; offset < 4000; offset += pageSize) {
    const filter = onlyBug !== undefined ? { status: 'open' } : { status: 'open', category: fixTargetCategory() };
    const page = queryAuditFindings(filter, pageSize, offset);
    if (page.findings.length === 0) {
      break;
    }
    for (const finding of page.findings) {
      if (finding.adoBugId === undefined) {
        continue;
      }
      if (onlyBug !== undefined && finding.adoBugId !== onlyBug) {
        continue;
      }
      if (onlyBug === undefined && !findingTouchesScope(finding, scopePaths)) {
        continue;
      }
      // The footprint phase is the *minimum* scope the bug inherently needs (single file / package / repo);
      // it gates whether the bug is in range of the configured cap. The actual attempt always starts at the
      // narrowest phase and is promoted on failure, so a bug fixable in a narrower scope than its footprint
      // suggests is not over-scoped up front.
      const footprintPhase = determinePhase(finding);
      if (onlyBug === undefined && footprintPhase > maxPhase) {
        continue;
      }
      const existingTask = getFixTaskByFinding(finding.id);
      if (existingTask !== undefined) {
        // Check if it's a failed task that can be retried
        const retryableTask = getRetryableFailedTask(finding.id, maxRetries);
        if (retryableTask !== undefined) {
          // Promote one phase per failed attempt (capped at maxPhase) so a bug that couldn't be fixed in a
          // narrow scope is retried with a wider one. The onlyBug debug path keeps its exact footprint phase.
          const phase = onlyBug !== undefined ? footprintPhase : promotedPhase(retryableTask.phase, maxPhase);
          return { finding, phase, retryTaskId: retryableTask.id };
        }
        continue;
      }
      // Fresh bug: always start at the narrowest scope (phase 1) and let failures promote it.
      return { finding, phase: onlyBug !== undefined ? footprintPhase : 1 };
    }
    if (offset + pageSize >= page.total) {
      break;
    }
  }
  return undefined;
}

function scopeInstruction(phase: 1 | 2 | 3, finding: AuditFinding): string {
  if (phase === 1) {
    return `SCOPE (phase 1 - single file): Change ONLY the file \`${finding.filePath}\`. Do not create or edit any other file, not even a test file.`;
  }
  if (phase === 2) {
    return `SCOPE (phase 2 - single package): Change only files within the package \`${packageOf(finding.filePath)}\`. Do not touch any other package.`;
  }
  return 'SCOPE (phase 3): Change whatever files are necessary, but keep the change as small as possible.';
}

function buildFixPrompt(finding: AuditFinding, phase: 1 | 2 | 3, feedback: string | undefined): string {
  const related = (finding.relatedLocations ?? []).map(
    (location) => `  - ${locLabel(location.filePath, location.line, location.endLine)}`
  );
  const lines: string[] = [
    `You are an automated coding agent for the ${AZURE_DEVOPS_CONFIG.repositoryName} repository. Make the SMALLEST correct code change that fully resolves the bug below, following the repository's existing conventions and code style. Do NOT refactor unrelated code, add comments to code you did not change, change public APIs, or edit lockfiles, snapshots, or generated files.`,
    '',
    `BUG: ${finding.title}`,
    `WHAT IS WRONG: ${finding.body}`,
    ...(finding.detail !== undefined && finding.detail.trim() !== '' ? [`DETAILS: ${finding.detail}`] : []),
    `PRIMARY LOCATION: ${locLabel(finding.filePath, finding.line, finding.endLine)}`,
    ...(related.length > 0 ? ['ALSO AFFECTS:', ...related] : []),
    '',
    scopeInstruction(phase, finding),
    '',
    'REQUIREMENTS:',
    '- The change must compile and must not break existing tests.',
    '- Keep the change minimal and targeted strictly to this bug.',
    "- Reuse the repository's existing utilities, design tokens, and patterns rather than inventing new ones."
  ];
  if (feedback !== undefined && feedback.trim() !== '') {
    lines.push(
      '',
      'IMPORTANT - the pull request you already opened has the blocking feedback below. Redo the fix on the current files so ALL of it is resolved:',
      feedback
    );
  }
  lines.push(
    '',
    'When you are finished editing, reply with a one-paragraph summary of exactly what you changed and why.'
  );
  return lines.join('\n');
}

function buildPrDescription(finding: AuditFinding): string {
  const parts: string[] = [
    `Automated fix by Saturn's Code Autopilot for **${finding.title}**.`,
    '',
    finding.body,
    ...(finding.detail !== undefined && finding.detail.trim() !== '' ? ['', finding.detail] : []),
    '',
    `Location: \`${locLabel(finding.filePath, finding.line, finding.endLine)}\``,
    ...(finding.adoBugUrl !== undefined ? [`Bug: ${finding.adoBugUrl}`] : []),
    '',
    '_Best-effort automated change - please review carefully before merging._'
  ];
  return parts.join('\n');
}

// Max file size to include in validation (skip very large files).
const MAX_VALIDATION_FILE_BYTES = 100_000;

/** Load file content with line numbers for validation. */
function loadFileForValidation(repoRoot: string, filePath: string): { filePath: string; content: string } | undefined {
  const absolutePath = path.join(repoRoot, filePath);
  try {
    const stats = statSync(absolutePath);
    if (stats.size > MAX_VALIDATION_FILE_BYTES) {
      return undefined;
    }
    const content = readFileSync(absolutePath, 'utf8');
    const lines = content.split('\n');
    const numbered = lines.map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`).join('\n');
    return { filePath, content: numbered };
  } catch {
    return undefined;
  }
}

/** Build a validation prompt for changed files - checks the same categories as the audit agent. */
function buildValidationPrompt(files: readonly { filePath: string; content: string }[]): string {
  const categories = AUDIT_CATEGORIES.join(' | ');
  const header = [
    'You are validating code changes made by Code Autopilot (an automated coding agent). Check the files below for any NEW',
    'issues the fix may have introduced. Focus on BLOCKING and MAJOR issues only - we want to catch serious',
    'problems, not stylistic nits.',
    '',
    `Categories to check: ${categories}`,
    '',
    'For each category, look for:',
    '- security: injection, broken auth, XSS, unsafe eval, missing input validation',
    '- privacy: logging PII, leaking identifiers, missing data classification',
    '- secrets: hardcoded keys/tokens/passwords',
    '- correctness: null hazards, race conditions, unhandled rejections',
    '- accessibility: missing roles/labels/alt text',
    '- resilience: missing error handling, swallowed errors',
    '- performance: N+1 patterns, unbounded loops',
    '',
    'Respond with ONLY a JSON object in this exact shape (no prose outside the JSON):',
    '```json',
    '{',
    '  "issues": [',
    '    {',
    '      "filePath": "<exact file path>",',
    '      "line": <1-based line>,',
    '      "severity": "blocking | major",',
    '      "category": "<one of the categories above>",',
    '      "title": "short headline",',
    '      "body": "what is wrong and how to fix it"',
    '    }',
    '  ]',
    '}',
    '```',
    'If there are NO blocking or major issues, return {"issues": []}.',
    '',
    'Files to validate:'
  ].join('\n');

  const fileBlocks = files.map((file) => [`----- FILE: ${file.filePath} -----`, file.content].join('\n')).join('\n\n');

  return `${header}\n\n${fileBlocks}\n`;
}

/** Schema for validation response. */
const validationIssueSchema = z.object({
  filePath: z.string(),
  line: z.number(),
  severity: z.enum(['blocking', 'major']),
  category: z.string(),
  title: z.string(),
  body: z.string()
});

const validationResponseSchema = z.object({
  issues: z.array(validationIssueSchema)
});

/** Extract JSON from model output (handles markdown code fences). */
function extractJsonFromOutput(output: string): string | undefined {
  // Try to find JSON in code fence
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
  if (fenceMatch?.[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  // Try to find raw JSON object
  const jsonMatch = /\{[\s\S]*\}/.exec(output);
  return jsonMatch?.[0];
}

/** Validate the changed files for audit issues before committing. Returns issues found or empty array. */
async function validateFixChanges(
  changedFiles: readonly string[],
  options: FixRunOptions,
  logger: Logger
): Promise<readonly { filePath: string; line: number; severity: string; category: string; title: string }[]> {
  const filesToValidate: { filePath: string; content: string }[] = [];
  for (const filePath of changedFiles) {
    const loaded = loadFileForValidation(options.cloneDir, filePath);
    if (loaded !== undefined) {
      filesToValidate.push(loaded);
    }
  }

  if (filesToValidate.length === 0) {
    return [];
  }

  logger.info(`Code Autopilot: validating ${String(filesToValidate.length)} changed file(s) for audit issues...`);

  const result = await runCopilotReview({
    cliPath: options.cliPath,
    prompt: buildValidationPrompt(filesToValidate),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: options.cloneDir,
    timeoutMs: options.timeoutMs
  });

  if (result.status !== 0) {
    logger.warn(`Code Autopilot: validation check failed with exit code ${String(result.status)}, skipping.`);
    return [];
  }

  const jsonString = extractJsonFromOutput(result.stdout);
  if (jsonString === undefined) {
    logger.warn('Code Autopilot: could not parse validation response, skipping.');
    return [];
  }

  try {
    const parsed = JSON.parse(jsonString);
    const validated = validationResponseSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn('Code Autopilot: validation response schema mismatch, skipping.');
      return [];
    }
    return validated.data.issues;
  } catch {
    logger.warn('Code Autopilot: could not parse validation JSON, skipping.');
    return [];
  }
}

// When SATURN_FIX_PREPUSH_VALIDATE is on, lint the changed files in the clone before pushing and do up to a
// couple of corrective model rounds on failures so the PR starts green. The PR pipeline stays the final gate,
// so this never blocks forever - it just reduces obviously-broken PRs.
async function prePushValidate(
  task: FixTask,
  finding: AuditFinding,
  options: FixRunOptions,
  logger: Logger
): Promise<void> {
  const maxRounds = 2;
  for (let round = 0; round < maxRounds; round += 1) {
    const changed = await workingTreeChanges(options.cloneDir);
    const lint = await lintChangedFilesInClone(options.cloneDir, changed, logger);
    if (lint.ok) {
      if (round > 0) {
        logger.info('Code Autopilot: local lint clean after corrective round.');
      }
      return;
    }
    logger.info(`Code Autopilot: local lint failed; corrective round ${String(round + 1)}/${String(maxRounds)}.`);
    updateFixTask(task.id, { status: 'fixing', lastAction: `fixing local lint errors (round ${String(round + 1)})` });
    const result = await runCopilotEdit({
      cliPath: options.cliPath,
      prompt: buildFixPrompt(
        finding,
        task.phase,
        `Your change has LINT errors that must be fixed before the PR is opened. Fix the ROOT CAUSE of each (do not disable rules):\n${lint.output}`
      ),
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      cwd: options.cloneDir,
      timeoutMs: options.timeoutMs,
      ...(options.allowMcpServerName !== undefined ? { allowMcpServerName: options.allowMcpServerName } : {})
    });
    if (result.status !== 0) {
      logger.warn('Code Autopilot: corrective lint round did not complete; proceeding to push.');
      return;
    }
  }
  logger.warn('Code Autopilot: local lint still failing after corrective rounds; pushing anyway (pipeline will gate).');
}

// True for a git failure that looks like an expired / rejected credential (vs. a real push error).
function isAuthFailure(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes('authentication failed') ||
    message.includes('could not read username') ||
    message.includes('403') ||
    message.includes('401')
  );
}

// Push the fix branch; if the cached Azure DevOps credential has expired (auth failure), mint a fresh token
// and retry once. Keeps the always-on agent pushing across token lifetimes without manual intervention.
async function pushWithAuthRetry(cloneDir: string, branch: string, logger: Logger, force: boolean): Promise<void> {
  try {
    await pushFixBranch(cloneDir, branch, getAzureDevOpsAuthHeader(cloneDir), logger, force);
  } catch (error) {
    if (!isAuthFailure(error)) {
      throw error;
    }
    logger.warn('Code Autopilot: git push auth failed; refreshing the Azure DevOps token and retrying.');
    await pushFixBranch(cloneDir, branch, getAzureDevOpsAuthHeader(cloneDir, true), logger, force);
  }
}

// Generate the fix on a fresh branch off the latest default, commit, and (unless dry-run) push. Shared by
// the initial attempt and each feedback round. `force` force-pushes (used when re-creating the branch).
async function generateAndPush(
  task: FixTask,
  finding: AuditFinding,
  options: FixRunOptions,
  logger: Logger,
  feedback: string | undefined,
  force: boolean
): Promise<void> {
  updateFixTask(task.id, {
    status: 'branching',
    lastAction: feedback !== undefined ? 'addressing feedback' : 'creating branch'
  });
  await createFixBranch(options.cloneDir, task.branch, logger);

  updateFixTask(task.id, { status: 'fixing', lastAction: 'generating fix with Copilot' });
  const result = await runCopilotEdit({
    cliPath: options.cliPath,
    prompt: buildFixPrompt(finding, task.phase, feedback),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: options.cloneDir,
    timeoutMs: options.timeoutMs,
    ...(options.allowMcpServerName !== undefined ? { allowMcpServerName: options.allowMcpServerName } : {})
  });
  if (result.status !== 0) {
    throw new Error(`Copilot edit exited with code ${String(result.status)}: ${result.stderr.slice(0, 400)}`);
  }

  const changed = await workingTreeChanges(options.cloneDir);
  if (changed.length === 0) {
    throw new Error('the model made no file changes.');
  }
  logger.info(
    `Code Autopilot: ${task.branch} changed ${String(changed.length)} file(s): ${changed.slice(0, 6).join(', ')}`
  );

  updateFixTask(task.id, { status: 'validating', lastAction: `validating ${String(changed.length)} file(s)` });

  // Self-validation: check changed files for audit issues before committing.
  const validationIssues = await validateFixChanges(changed, options, logger);
  const blockingOrMajor = validationIssues.filter(
    (issue) => issue.severity === 'blocking' || issue.severity === 'major'
  );
  if (blockingOrMajor.length > 0) {
    const issueList = blockingOrMajor
      .map(
        (issue) => `- [${issue.severity}] ${issue.category}: ${issue.title} (${issue.filePath}:${String(issue.line)})`
      )
      .join('\n');
    throw new Error(
      `Validation failed - the fix introduces ${String(blockingOrMajor.length)} audit issue(s):\n${issueList}`
    );
  }
  if (validationIssues.length === 0) {
    logger.info('Code Autopilot: validation passed - no audit issues detected.');
  }

  // Optional (slow) pre-push gate: lint the changed files locally and correct them so the PR starts green.
  if (isFixPrePushValidate()) {
    await prePushValidate(task, finding, options, logger);
  }

  const committed = await commitAllChanges(
    options.cloneDir,
    `Code Autopilot: ${finding.title} (bug ${String(task.bugId)})`,
    logger
  );
  if (!committed) {
    throw new Error('nothing to commit after the model run.');
  }

  if (isFixDryRun()) {
    updateFixTask(task.id, { status: 'validating', lastAction: 'dry-run: committed locally, not pushed' });
    return;
  }

  await pushWithAuthRetry(options.cloneDir, task.branch, logger, force);
}

/**
 * Start a new fix: create a task, generate + push the fix on a fresh branch, and open a PR linked to the
 * bug. On any failure the task is marked 'failed' with the error. Returns the resulting task.
 */
export async function startFix(
  candidate: FixCandidate,
  options: FixRunOptions,
  logger: Logger
): Promise<FixTask | undefined> {
  const { finding, phase, retryTaskId } = candidate;
  const bugId = finding.adoBugId;
  if (bugId === undefined) {
    return undefined;
  }
  const branch = `${fixBranchPrefix()}/${String(bugId)}`;

  // If this is a retry of a failed task, reuse the existing task; otherwise create a new one.
  let task: FixTask;
  if (retryTaskId !== undefined) {
    const existingTask = getFixTaskById(retryTaskId);
    if (existingTask === undefined) {
      logger.warn(`Code Autopilot: retry task ${retryTaskId} not found, creating new task for bug ${String(bugId)}.`);
      task = createFixTask({
        id: String(bugId),
        findingId: finding.id,
        bugId,
        ...(finding.adoBugUrl !== undefined ? { bugUrl: finding.adoBugUrl } : {}),
        title: finding.title,
        filePath: finding.filePath,
        package: packageOf(finding.filePath),
        phase,
        branch
      });
    } else {
      const escalated = existingTask.phase !== phase;
      logger.info(
        `Code Autopilot: retrying failed task for bug ${String(bugId)} (attempt ${String(existingTask.iterations + 1)}` +
          (escalated ? `, phase ${String(existingTask.phase)} -> ${String(phase)}` : '') +
          ').'
      );
      // Persist the (possibly promoted) phase so the retry runs at the wider scope.
      updateFixTask(retryTaskId, {
        status: 'selected',
        phase,
        lastAction: escalated ? `retrying at wider scope (phase ${String(phase)})` : 'retrying after failure',
        lastError: null
      });
      task = getFixTaskById(retryTaskId) ?? existingTask;
    }
  } else {
    task = createFixTask({
      id: String(bugId),
      findingId: finding.id,
      bugId,
      ...(finding.adoBugUrl !== undefined ? { bugUrl: finding.adoBugUrl } : {}),
      title: finding.title,
      filePath: finding.filePath,
      package: packageOf(finding.filePath),
      phase,
      branch
    });
  }

  try {
    await generateAndPush(task, finding, options, logger, undefined, false);
    if (isFixDryRun()) {
      logger.info(
        `Code Autopilot: dry-run complete for bug ${String(bugId)} (branch ${branch} committed locally, not pushed).`
      );
      return getFixTaskById(task.id);
    }
    updateFixTask(task.id, { status: 'pushed', lastAction: 'opening pull request' });
    const pr = await createPullRequest(options.cloneDir, {
      sourceBranch: branch,
      targetBranch: AZURE_DEVOPS_CONFIG.defaultBranch,
      title: `[Code Autopilot] ${finding.title}`,
      description: buildPrDescription(finding),
      workItemId: bugId
    });
    try {
      await addWorkItemComment(
        options.cloneDir,
        bugId,
        `Saturn's Code Autopilot opened PR !${String(pr.id)} to fix this: ${pr.url}`
      );
    } catch {
      /* best-effort bug link */
    }
    updateFixTask(task.id, {
      status: 'pr-open',
      prId: pr.id,
      prUrl: pr.url,
      iterations: 1,
      lastAction: 'PR opened',
      lastError: null
    });
    logger.info(`Code Autopilot: opened PR !${String(pr.id)} for bug ${String(bugId)} (${pr.url}).`);
    return getFixTaskById(task.id);
  } catch (error) {
    const message = describeError(error);
    // Count the failed attempt so retries are bounded (getRetryableFailedTask gates on iterations) and so
    // per-bug phase promotion advances one step on each failure.
    updateFixTask(task.id, {
      status: 'failed',
      iterations: task.iterations + 1,
      lastError: message,
      lastAction: 'fix attempt failed'
    });
    logger.warn(`Code Autopilot: fix attempt failed for bug ${String(bugId)}: ${message}`);
    return getFixTaskById(task.id);
  }
}

async function safeCleanup(task: FixTask, options: FixRunOptions, logger: Logger): Promise<void> {
  try {
    await deleteLocalFixBranch(options.cloneDir, task.branch, logger);
  } catch {
    /* best-effort local branch cleanup */
  }
}

// Surface checks Code Autopilot could NOT auto-re-queue (an external system owns them) as an action item in
// the dashboard so a human re-runs them. Dashboard-only - no bug comment is posted.
function surfaceStuckChecks(task: FixTask, stuckCheckNames: readonly string[]): void {
  const names = stuckCheckNames.join(', ');
  updateFixTask(task.id, { status: 'pr-open', lastAction: `needs manual re-run: ${names}`, lastError: null });
}

// --- Automated bot-comment triage --------------------------------------------------------------------------
// CI/build bots (code-coverage, lint-health, bundle-size, ...) post their reports as ordinary PR comments.
// Most are non-actionable status reports, not review feedback. Rather than silently ignore them, the agent
// judges each (raising the bar - default non-actionable), rebuts the bogus ones with a one-time explanation
// and marks the thread won't-fix, and folds any genuinely actionable one into the fix feedback.

const botJudgmentSchema = z.object({
  decisions: z.array(z.object({ index: z.number(), actionable: z.boolean(), reason: z.string() }))
});

function buildBotTriagePrompt(comments: readonly BotCommentThread[]): string {
  const blocks = comments
    .map((comment, index) => {
      const text = comment.content.length > 1500 ? `${comment.content.slice(0, 1500)}\u2026` : comment.content;
      return `--- COMMENT ${String(index)} ---\n${text}`;
    })
    .join('\n\n');
  return [
    'You are triaging AUTOMATED bot comments left on a pull request. They come from CI/build bots (code-',
    'coverage, lint-health, bundle-size, and the like). The VAST MAJORITY are informational status reports,',
    'NOT actionable review feedback. Raise the bar: mark a comment "actionable" ONLY if it clearly states a',
    'concrete defect or regression that REQUIRES a code change in THIS pull request (e.g. a NEW lint or build',
    'error the PR introduced, or a real failing test it names). Score deltas, coverage / bundle-size summaries,',
    'advisory notes, and anything merely informational are NOT actionable.',
    '',
    'Respond with ONLY this JSON object (no prose): {"decisions":[{"index":<n>,"actionable":<true|false>,"reason":"<short reason>"}]}',
    'Include exactly one entry per comment index below.',
    '',
    blocks
  ].join('\n');
}

// Judge each bot comment. Defaults every thread to NON-actionable so any model/parse hiccup errs toward
// rebutting (the safe, high-bar choice). Keyed by threadId.
async function classifyBotComments(
  comments: readonly BotCommentThread[],
  options: FixRunOptions
): Promise<Map<number, { actionable: boolean; reason: string }>> {
  const result = new Map<number, { actionable: boolean; reason: string }>();
  for (const comment of comments) {
    result.set(comment.threadId, {
      actionable: false,
      reason: 'Automated status report - not actionable review feedback.'
    });
  }
  try {
    const review = await runCopilotReview({
      cliPath: options.cliPath,
      prompt: buildBotTriagePrompt(comments),
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      cwd: options.cloneDir,
      timeoutMs: Math.min(options.timeoutMs, 5 * 60_000)
    });
    if (review.status !== 0) {
      return result;
    }
    const json = extractJsonFromOutput(review.stdout);
    if (json === undefined) {
      return result;
    }
    const parsed = botJudgmentSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      return result;
    }
    for (const decision of parsed.data.decisions) {
      const thread = comments[decision.index];
      if (thread !== undefined) {
        result.set(thread.threadId, { actionable: decision.actionable, reason: decision.reason });
      }
    }
  } catch {
    /* keep the conservative (non-actionable) defaults */
  }
  return result;
}

function buildBotRebuttal(reason: string): string {
  const why =
    reason.trim() !== '' ? reason.trim() : 'It is an automated status report, not actionable review feedback.';
  return [
    SATURN_BOT_REBUTTAL_MARKER,
    "**Saturn Code Autopilot** reviewed this automated comment and is **not** making a code change for it; " +
      "marking this thread *won't fix*.",
    '',
    `Why: ${why}`,
    '',
    'If this reflects a real regression that should block the PR, please surface it as a **failing required ' +
      'build/policy check** (which this agent does act on) rather than an informational comment - otherwise it ' +
      'just adds noise to every PR without a clear, gating signal.'
  ].join('\n');
}

// Triage the PR's automated bot comments: rebut the non-actionable ones (post a one-time explanation + mark
// the thread won't-fix) and return any the model judges genuinely actionable, to fold into the fix feedback.
async function handleBotComments(task: FixTask, options: FixRunOptions, logger: Logger): Promise<string[]> {
  if (task.prId === undefined || !isFixRebutBotComments()) {
    return [];
  }
  let botThreads: readonly BotCommentThread[] = [];
  try {
    botThreads = await getActiveBotCommentThreads(options.cloneDir, task.prId);
  } catch {
    return [];
  }
  if (botThreads.length === 0) {
    return [];
  }
  const judgments = await classifyBotComments(botThreads, options);
  const actionable: string[] = [];
  for (const bot of botThreads) {
    const judgment = judgments.get(bot.threadId) ?? { actionable: false, reason: '' };
    if (judgment.actionable) {
      actionable.push(bot.content);
      continue;
    }
    try {
      await markThreadWontFix(options.cloneDir, task.prId, bot.threadId, buildBotRebuttal(judgment.reason));
      logger.info(
        `Code Autopilot: rebutted + closed bot thread ${String(bot.threadId)} on PR !${String(task.prId)}.`
      );
    } catch (error) {
      logger.warn(`Code Autopilot: could not rebut bot thread ${String(bot.threadId)}: ${describeError(error)}`);
    }
  }
  return actionable;
}

/**
 * Monitor one open PR: merge -> clean up the local branch + mark merged; abandoned -> clean up; otherwise
 * gather blocking feedback (merge conflicts + unresolved review comments) and, if any, regenerate + push an
 * update. Gives up after SATURN_FIX_MAX_ITERATIONS feedback rounds, leaving the PR for a human.
 */
export async function monitorFixTask(task: FixTask, options: FixRunOptions, logger: Logger): Promise<void> {
  if (task.prId === undefined) {
    return;
  }
  const progress = await getPullRequestProgress(options.cloneDir, task.prId);
  if (progress === undefined) {
    updateFixTask(task.id, { status: 'abandoned', lastAction: 'PR no longer exists', lastError: null });
    await safeCleanup(task, options, logger);
    return;
  }

  const status = progress.status.toLowerCase();
  if (status === 'completed') {
    updateFixTask(task.id, {
      status: 'merged',
      mergedAt: new Date().toISOString(),
      lastAction: 'PR merged',
      lastError: null
    });
    await safeCleanup(task, options, logger);
    logger.info(`Code Autopilot: PR !${String(task.prId)} merged; cleaned up ${task.branch}.`);
    return;
  }
  if (status === 'abandoned') {
    updateFixTask(task.id, { status: 'abandoned', lastAction: 'PR abandoned', lastError: null });
    await safeCleanup(task, options, logger);
    return;
  }

  // The PR is active - clear any stale error from a previous iteration so the dashboard shows THIS pass's state.
  if (task.lastError !== undefined) {
    updateFixTask(task.id, { lastError: null });
  }

  let comments: readonly string[] = [];
  try {
    comments = await getActivePullRequestComments(options.cloneDir, task.prId);
  } catch {
    /* treat unreadable threads as no feedback this round */
  }

  // Inspect the PR's builds/policies: genuine failures (need a code fix, with logs), EXPIRED checks (just
  // re-queue - no code change), and whether anything is still running (so we wait instead of re-pushing).
  let checks: PullRequestChecks = { failures: [], requeueable: [], inProgress: false };
  try {
    checks = await getPullRequestChecks(options.cloneDir, task.prId, progress.projectId);
  } catch {
    /* treat unreadable checks as none this round */
  }

  // Re-queue any EXPIRED build validations (the API behind the PR "Re-queue" button) - no code change needed.
  // Checks we could NOT re-queue are owned by an external system; surface those for a human to re-run.
  if (checks.requeueable.length > 0) {
    let requeued = 0;
    const couldNotRequeue: string[] = [];
    for (const check of checks.requeueable) {
      if (await requeuePolicyEvaluation(options.cloneDir, check.evaluationId)) {
        requeued += 1;
      } else {
        couldNotRequeue.push(check.name);
      }
    }
    if (requeued > 0) {
      logger.info(`Code Autopilot: re-queued ${String(requeued)} expired check(s) on PR !${String(task.prId)}.`);
      updateFixTask(task.id, {
        status: 'pr-open',
        lastAction: `re-queued ${String(requeued)} expired check(s)`,
        lastError: null
      });
    }
    if (couldNotRequeue.length > 0) {
      surfaceStuckChecks(task, couldNotRequeue);
    }
  }

  // Triage automated bot comments (coverage/lint/bundle-size bots): rebut the non-actionable ones (post a
  // one-time explanation + mark the thread won't-fix) and fold any genuinely actionable one into feedback.
  const botActionable = await handleBotComments(task, options, logger);
  const reviewComments = botActionable.length > 0 ? [...comments, ...botActionable] : comments;

  const failedChecks = checks.failures;
  const conflict = progress.mergeStatus.toLowerCase() === 'conflicts';
  if (!conflict && reviewComments.length === 0 && failedChecks.length === 0) {
    // Nothing to fix. If a build/policy is still running, wait for it; otherwise just await review/merge.
    updateFixTask(task.id, {
      status: 'pr-open',
      lastAction: checks.inProgress ? 'build/policy in progress; waiting' : 'awaiting review/merge',
      lastError: null
    });
    return;
  }

  if (task.iterations >= fixMaxIterations()) {
    updateFixTask(task.id, {
      status: 'failed',
      lastAction: 'max feedback rounds reached; left for a human',
      lastError: 'too many feedback rounds'
    });
    return;
  }

  const finding = getAuditFindingById(task.findingId);
  if (finding === undefined) {
    updateFixTask(task.id, { status: 'failed', lastError: 'finding no longer in the audit store' });
    return;
  }

  const feedbackParts: string[] = [
    `You can use the Azure DevOps tools (the "azure-devops" MCP server) to inspect pull request !${String(task.prId)} directly - read its failing build/check logs, pipeline runs, and review threads, diagnose the root cause, then fix ALL of the issues below. Do everything a developer would do to make the PR green. Where a failing build's actual error log is included below, fix the ROOT CAUSE of that error (do not just silence it); use the Azure DevOps tools to pull more of the log if you need additional context.`
  ];
  if (conflict) {
    feedbackParts.push(
      '- The PR has a MERGE CONFLICT with the target branch. Your branch was just re-created from the latest default branch, so re-apply the fix cleanly against current code.'
    );
  }
  for (const failure of failedChecks) {
    feedbackParts.push(`- Failing check/build to fix:\n${failure}`);
  }
  for (const comment of reviewComments) {
    feedbackParts.push(`- Reviewer comment to address: ${comment}`);
  }

  const blockerSummary = [
    conflict ? 'merge conflict' : '',
    failedChecks.length > 0 ? `${String(failedChecks.length)} failing check(s)` : '',
    reviewComments.length > 0 ? `${String(reviewComments.length)} review comment(s)` : ''
  ]
    .filter((part) => part !== '')
    .join(', ');
  updateFixTask(task.id, {
    status: 'addressing',
    lastAction: `addressing ${blockerSummary}`
  });
  try {
    await generateAndPush(task, finding, options, logger, feedbackParts.join('\n'), true);
    updateFixTask(task.id, {
      status: 'pr-open',
      iterations: task.iterations + 1,
      lastAction: 'pushed an update to the PR',
      lastError: null
    });
    logger.info(
      `Code Autopilot: pushed an update to PR !${String(task.prId)} (iteration ${String(task.iterations + 1)}).`
    );
  } catch (error) {
    updateFixTask(task.id, {
      status: 'failed',
      lastError: describeError(error),
      lastAction: 'failed to address feedback'
    });
  }
}
