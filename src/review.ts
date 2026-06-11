import { z } from 'zod';

/** A single active pull request the bot may review. */
export interface PullRequestSummary {
  readonly pullRequestId: number;
  readonly title: string;
  readonly isDraft: boolean;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly authorName: string;
  readonly webUrl: string;
  /** ISO-8601 creation timestamp from Azure DevOps; used to bound the older-PR backfill to recent PRs. */
  readonly createdAt?: string;
}

/** A file changed by a pull request iteration. */
export interface ChangedFile {
  readonly path: string;
  readonly changeType: string;
  readonly objectId: string;
}

/** A changed file with its post-change content and merge-base content, ready to diff for the reviewer. */
export interface DiffFileInput {
  readonly path: string;
  readonly changeType: string;
  readonly content: string;
  /** The file's content at the PR merge base, or '' for a newly added file (the whole file is "added"). */
  readonly baseContent: string;
}

/** Options that bound how much diff context is sent to the model. */
export interface DiffPayloadOptions {
  readonly maxTotalBytes: number;
  readonly maxFileLines: number;
}

/** The bounded, line-numbered diff context plus bookkeeping about truncation. */
export interface DiffPayload {
  readonly text: string;
  readonly includedFileCount: number;
  readonly truncated: boolean;
}

/** Severity levels the model may assign to a finding. */
export type ReviewSeverity = 'blocking' | 'major' | 'minor' | 'nit';

/**
 * Whether a finding of this severity requires the author to act. blocking/major do (their thread is posted
 * Active); minor/nit do not, so they are posted already-resolved to keep the PR's open-thread count clean.
 */
export function severityRequiresAuthorAction(severity: ReviewSeverity): boolean {
  return severity === 'blocking' || severity === 'major';
}

/** A single inline review finding anchored to a file and new-file line. */
export interface ReviewComment {
  readonly filePath: string;
  readonly line: number;
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly body: string;
}

/** The structured result the model returns for one pull request. */
export interface ReviewResult {
  readonly summary: string;
  readonly hasFindings: boolean;
  readonly comments: readonly ReviewComment[];
}

// Matches ANSI escape sequences (CSI ...) so CLI stdout can be cleaned before JSON extraction.
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

// Matches fenced code blocks (optionally tagged ```json) so the final JSON block can be isolated.
const FENCED_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/g;

const reviewSeveritySchema = z.enum(['blocking', 'major', 'minor', 'nit']);

const reviewCommentSchema = z.object({
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  severity: reviewSeveritySchema,
  title: z.string().min(1),
  body: z.string().min(1)
});

const reviewResultSchema = z.object({
  summary: z.string(),
  hasFindings: z.boolean(),
  comments: z.array(reviewCommentSchema)
});

// Bound the LCS table so a pathologically large file cannot blow up memory/CPU; above this the changed
// middle region is rendered coarsely (all removed, then all added), which is still correct.
const MAX_LCS_CELLS = 4_000_000;

type DiffOpKind = 'equal' | 'add' | 'remove';
interface DiffOp {
  readonly kind: DiffOpKind;
  readonly text: string;
}

// One rendered diff line: the new-file line number (absent for removed lines), a marker, and the text.
interface RenderedDiffLine {
  readonly newLineNumber: number | undefined;
  readonly marker: '+' | '-' | ' ';
  readonly text: string;
}

function lcsDiffOps(base: readonly string[], next: readonly string[]): DiffOp[] {
  const baseLength = base.length;
  const nextLength = next.length;
  if (baseLength === 0) {
    return next.map((text): DiffOp => ({ kind: 'add', text }));
  }
  if (nextLength === 0) {
    return base.map((text): DiffOp => ({ kind: 'remove', text }));
  }
  if (baseLength * nextLength > MAX_LCS_CELLS) {
    return [
      ...base.map((text): DiffOp => ({ kind: 'remove', text })),
      ...next.map((text): DiffOp => ({ kind: 'add', text }))
    ];
  }

  const dp: number[][] = Array.from({ length: baseLength + 1 }, () => new Array<number>(nextLength + 1).fill(0));
  for (let i = baseLength - 1; i >= 0; i -= 1) {
    for (let j = nextLength - 1; j >= 0; j -= 1) {
      dp[i][j] = base[i] === next[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < baseLength && j < nextLength) {
    if (base[i] === next[j]) {
      ops.push({ kind: 'equal', text: next[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'remove', text: base[i] });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: next[j] });
      j += 1;
    }
  }
  while (i < baseLength) {
    ops.push({ kind: 'remove', text: base[i] });
    i += 1;
  }
  while (j < nextLength) {
    ops.push({ kind: 'add', text: next[j] });
    j += 1;
  }

  return ops;
}

/**
 * Produce a line-by-line diff of `baseContent` -> `nextContent` with 1-based new-file line numbers on
 * the kept/added lines (so comments can anchor to real post-change lines). Common head/tail are trimmed
 * before the LCS so the table stays small for typical small changes.
 */
function diffLines(baseContent: string, nextContent: string): RenderedDiffLine[] {
  const baseLines = baseContent === '' ? [] : baseContent.split('\n');
  const nextLines = nextContent.split('\n');

  let prefix = 0;
  while (prefix < baseLines.length && prefix < nextLines.length && baseLines[prefix] === nextLines[prefix]) {
    prefix += 1;
  }
  let baseEnd = baseLines.length;
  let nextEnd = nextLines.length;
  while (baseEnd > prefix && nextEnd > prefix && baseLines[baseEnd - 1] === nextLines[nextEnd - 1]) {
    baseEnd -= 1;
    nextEnd -= 1;
  }

  const rendered: RenderedDiffLine[] = [];
  let newLineNumber = 0;
  for (let index = 0; index < prefix; index += 1) {
    newLineNumber += 1;
    rendered.push({ newLineNumber, marker: ' ', text: nextLines[index] });
  }

  for (const op of lcsDiffOps(baseLines.slice(prefix, baseEnd), nextLines.slice(prefix, nextEnd))) {
    if (op.kind === 'remove') {
      rendered.push({ newLineNumber: undefined, marker: '-', text: op.text });
    } else {
      newLineNumber += 1;
      rendered.push({ newLineNumber, marker: op.kind === 'add' ? '+' : ' ', text: op.text });
    }
  }

  for (let index = nextEnd; index < nextLines.length; index += 1) {
    newLineNumber += 1;
    rendered.push({ newLineNumber, marker: ' ', text: nextLines[index] });
  }

  return rendered;
}

function formatDiffLine(line: RenderedDiffLine, numberWidth: number): string {
  const numberColumn = (line.newLineNumber === undefined ? '' : String(line.newLineNumber)).padStart(numberWidth, ' ');
  return `${numberColumn} | ${line.marker} ${line.text}`;
}

function buildFileSection(file: DiffFileInput, maxFileLines: number): string {
  // Render the FULL touched file (every line, with diff markers) - not just the changed hunks - so the
  // reviewer can also catch high-severity correctness bugs and security/privacy issues in pre-existing
  // code in these files. The "+"/"-"/" " markers tell it which lines this PR actually changed.
  const allDiffLines = diffLines(file.baseContent, file.content);

  const truncated = allDiffLines.length > maxFileLines;
  const visibleLines = truncated ? allDiffLines.slice(0, maxFileLines) : allDiffLines;
  const widestNumber = visibleLines.reduce((widest, line) => Math.max(widest, line.newLineNumber ?? 0), 0);
  const numberWidth = Math.max(String(widestNumber).length, 1);
  const body = visibleLines.map((line) => formatDiffLine(line, numberWidth)).join('\n');
  const truncationNote = truncated
    ? `\n... (file truncated at ${String(maxFileLines)} lines; open the full file from the repository as needed)`
    : '';
  return `### ${file.path} (${file.changeType})\n\`\`\`diff\n${body}${truncationNote}\n\`\`\``;
}

/**
 * Build a bounded, line-numbered representation of the changed files. Line numbers are 1-based and
 * correspond to the post-change file, so the model can anchor inline comments to real lines. The
 * payload is capped by total bytes (to stay within command-line limits) and per-file line count.
 */
export function buildDiffPayload(files: readonly DiffFileInput[], options: DiffPayloadOptions): DiffPayload {
  const sections: string[] = [];
  let totalBytes = 0;
  let includedFileCount = 0;
  let truncated = false;

  for (const file of files) {
    const section = buildFileSection(file, options.maxFileLines);
    const sectionBytes = Buffer.byteLength(section, 'utf8');
    if (includedFileCount > 0 && totalBytes + sectionBytes > options.maxTotalBytes) {
      truncated = true;
      break;
    }

    sections.push(section);
    totalBytes += sectionBytes;
    includedFileCount += 1;
  }

  if (includedFileCount < files.length) {
    truncated = true;
  }

  return { text: sections.join('\n\n'), includedFileCount, truncated };
}

/** Inputs needed to construct the reviewer prompt for a single pull request. */
export interface BuildReviewPromptOptions {
  readonly pullRequest: PullRequestSummary;
  readonly diffPayload: DiffPayload;
  readonly changedFiles: readonly ChangedFile[];
  readonly maxComments: number;
}

/**
 * Construct the full reviewer prompt. The prompt fully specifies the JSON output contract so the
 * orchestrator can parse the response deterministically and post inline comments.
 */
export function buildReviewPrompt(options: BuildReviewPromptOptions): string {
  const { pullRequest, diffPayload, changedFiles, maxComments } = options;
  const changedPathList = changedFiles.map((file) => `- ${file.path} (${file.changeType})`).join('\n');
  const truncationNote = diffPayload.truncated
    ? 'NOTE: The inlined changed-file content below is truncated. Open the full files from the repository as needed.\n'
    : '';

  return [
    'You are Saturn, a principal engineer performing a rigorous code review for the Microsoft Loop',
    '(office-bohemia) monorepo. Review the change holistically across these lenses: CORRECTNESS, DESIGN &',
    'MAINTAINABILITY, API DESIGN, SECURITY, and PRIVACY.',
    '',
    'You are running INSIDE the full office-bohemia repository at the current working directory with the full GitHub',
    'Copilot toolset. USE WHATEVER READ-ONLY TOOLS YOU NEED to gain complete context before judging the change:',
    'open/view files, grep/rg/glob search, lsp navigation, MCP servers, and read-only shell or git commands (for',
    'example `git log`, `git blame`, `git show`, `git diff`, `rg`, `cat`, `ls`). Open the changed files in full, follow',
    'their imports and type definitions, find callers and existing tests, and read nearby code and conventions.',
    'Repository guidance in AGENTS.md, .github/copilot-instructions.md, and local docs/instructions is authoritative.',
    'STRICTLY READ-ONLY: never modify, create, or delete files; never write; never commit, push, stage, or change git,',
    'branch, or pull-request state; never run package managers or build/deploy commands. You are reviewing only.',
    '',
    'Review focus: the changes this pull request introduces - the lines it adds or modifies.',
    'For each changed file you are given its FULL post-change content with a diff marker after each line\'s "|":',
    '  "+" = a line ADDED or MODIFIED by this PR,',
    '  "-" = a line REMOVED by this PR (context only - never anchor a comment to it),',
    '  " " (space) = an UNCHANGED, pre-existing line (shown so you have the whole file for context).',
    'By DEFAULT comment ONLY on "+" lines. You may ALSO comment on an unchanged (" ") line in these files when EITHER:',
    '  (1) a "+" change in this PR makes that existing code incorrect, unsafe, or broken (for example a new call passes a',
    '      bad argument into existing code, or a changed signature/contract breaks an existing caller) - anchor to the',
    '      "+" line and explain the link; OR',
    '  (2) the existing code contains a HIGH-SEVERITY correctness bug, or ANY security or privacy issue - report it even',
    '      though this PR did not change that line, anchoring the comment to the line number shown for it.',
    'Do NOT raise low/medium-severity, style, design, or maintainability nits on unchanged pre-existing code - for those,',
    'comment only on "+" lines.',
    '',
    `Pull request #${String(pullRequest.pullRequestId)}: ${pullRequest.title}`,
    `Author: ${pullRequest.authorName}`,
    `Source -> target: ${pullRequest.sourceBranch} -> ${pullRequest.targetBranch}`,
    '',
    'Changed files:',
    changedPathList,
    '',
    'REVIEW RIGOROUSLY FOR:',
    'CORRECTNESS:',
    '- Logic errors, wrong conditions, off-by-one, bad edge/boundary/empty/null handling, unhandled error paths.',
    '- Async/concurrency bugs: unawaited promises, races, missing cleanup, effects that should not be effects.',
    '- Broken invariants, incorrect state updates, wrong types, mismatched units, and regressions in existing behavior.',
    'DESIGN & MAINTAINABILITY:',
    '- Wrong or leaky abstractions, needless complexity, duplication, dead code, or fighting existing repo patterns.',
    '- Missing or inadequate tests for risky/new logic; tests that do not actually assert the behavior they claim.',
    '- Violations of the repo conventions in AGENTS.md / CLAUDE.md / .github instructions (read them and apply them).',
    'TEST COVERAGE (assess ONLY the change delta, never pre-existing code):',
    '- If this PR adds or changes production logic (new functions, branches, error/edge paths) without adequate tests',
    '  covering those NEW/CHANGED paths, raise it - major when the logic is risky or non-trivial, minor otherwise.',
    '  Count tests added or updated in THIS PR as coverage, and anchor the comment to the new/changed code that lacks it.',
    '- Do NOT request tests for code this PR did not touch, for pure no-behavior-change refactors, or for changes that',
    '  are inherently not unit-testable (config, generated code, trivial wiring/exports); skip coverage there.',
    'API DESIGN:',
    '- Breaking changes to a public/package API or contract; missing backward compatibility; unsafe schema changes.',
    '- Confusing or inconsistent signatures, many positional optional params (prefer an options object), leaky types.',
    'SECURITY:',
    '- Injection (SQL/command/HTML/template), XSS, SSRF, path traversal, unsafe deserialization, prototype pollution.',
    '- AuthN/AuthZ gaps, missing permission checks, IDOR, privilege escalation, trusting client-supplied identity.',
    '- Secrets/credentials/tokens in code, logs, URLs, or telemetry; weak or misused crypto; insecure randomness.',
    '- Unvalidated/untrusted input crossing a trust boundary; unsafe HTML (`dangerouslySetInnerHTML`), `eval`.',
    '- Unsafe URL/redirect handling, CORS/cookie/CSRF mistakes, and dependency/supply-chain risks.',
    'PRIVACY:',
    '- PII or customer content (document text, names, emails, file contents, IDs) logged, sent to telemetry, or',
    '  included in errors, analytics, URLs, or third-party calls without clear need or consent.',
    '- Over-collection or over-retention of user data; new data flows that widen who can see user content.',
    '- Leaking user/tenant data across boundaries; missing redaction; sensitive data in plaintext or caches.',
    'Also flag correctness bugs that CREATE a security or privacy problem.',
    '',
    'QUALITY BAR (critical):',
    '- Comment ONLY on genuine, material, correct findings. Prefer ZERO comments over any low-value or wrong one.',
    '- Scope: comment only on "+" lines, EXCEPT a high-severity correctness bug or ANY security/privacy issue in a touched',
    '  file (raise those even on unchanged lines). Never raise low/medium-severity or style/design nits on unchanged code.',
    '- Before raising any issue, VERIFY it against the actual repository code (read the relevant files). Do not guess;',
    '  a wrong or low-value comment is far worse than no comment.',
    '- NO style/formatting/naming nits, no restating the code, no speculative "consider..." suggestions, nothing the',
    '  linters/formatters already enforce. Every comment must be a material issue a careful human reviewer would',
    '  also raise across the lenses above; when unsure whether something matters, leave it out.',
    `- Hard cap: at most ${String(maxComments)} comments, each anchored to a specific changed line.`,
    '',
    truncationNote,
    'Unified diff of the changed files (the number before each "|" is the post-change file line - anchor comments to it):',
    diffPayload.text,
    '',
    'Respond with ONLY a single fenced ```json code block (no prose before or after) matching exactly this shape:',
    '```json',
    '{',
    '  "summary": "1-3 sentence overall assessment of the change",',
    '  "hasFindings": true,',
    '  "comments": [',
    '    {',
    '      "filePath": "/exact/repo-root-relative/path/from/the/list/above",',
    '      "line": 123,',
    '      "severity": "blocking | major | minor | nit",',
    '      "title": "short headline",',
    '      "body": "the actionable explanation and the suggested fix"',
    '    }',
    '  ]',
    '}',
    '```',
    'If there are no material issues, set "hasFindings" to false and "comments" to [].'
  ].join('\n');
}

function extractJsonCandidate(text: string): string | undefined {
  const fencedBlocks: string[] = [];
  FENCED_CODE_BLOCK_PATTERN.lastIndex = 0;
  for (let match = FENCED_CODE_BLOCK_PATTERN.exec(text); match !== null; match = FENCED_CODE_BLOCK_PATTERN.exec(text)) {
    const inner = match[1].trim();
    if (inner.startsWith('{')) {
      fencedBlocks.push(inner);
    }
  }

  if (fencedBlocks.length > 0) {
    return fencedBlocks[fencedBlocks.length - 1];
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return undefined;
}

/**
 * Parse the model's raw stdout into a {@link ReviewResult}. Returns `undefined` when no valid JSON
 * review can be recovered, so the caller can safely skip posting rather than emit garbage.
 */
export function parseReviewResult(rawOutput: string): ReviewResult | undefined {
  const cleaned = rawOutput.replace(ANSI_ESCAPE_PATTERN, '');
  const candidate = extractJsonCandidate(cleaned);
  if (candidate === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }

  const validation = reviewResultSchema.safeParse(parsed);
  if (!validation.success) {
    return undefined;
  }

  return {
    summary: validation.data.summary,
    hasFindings: validation.data.hasFindings,
    comments: validation.data.comments
  };
}

/** Clamp the model's findings to the configured cap, dropping the lowest-severity comments first. */
export function limitComments(comments: readonly ReviewComment[], maxComments: number): readonly ReviewComment[] {
  if (comments.length <= maxComments) {
    return comments;
  }

  const severityRank: Record<ReviewSeverity, number> = { blocking: 0, major: 1, minor: 2, nit: 3 };
  const ranked = [...comments].sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
  return ranked.slice(0, maxComments);
}

const verificationResultSchema = z.object({
  approved: z.boolean(),
  keepIndices: z.array(z.number().int().nonnegative()),
  reason: z.string()
});

/** Saturn's pre-post verification verdict: which proposed comments survive the quality gate. */
export interface VerificationResult {
  readonly approved: boolean;
  readonly keepIndices: readonly number[];
  readonly reason: string;
}

/**
 * Build the verification prompt. A second model pass re-checks the proposed comments against the real
 * code and keeps only the high-quality, correct, material security/privacy/correctness findings.
 */
export function buildVerificationPrompt(pullRequest: PullRequestSummary, comments: readonly ReviewComment[]): string {
  const numbered = comments
    .map(
      (comment, index) =>
        `[${String(index)}] (${comment.severity}) ${comment.filePath}:${String(comment.line)}\n    ${comment.title}\n    ${comment.body}`
    )
    .join('\n\n');

  return [
    "You are Saturn's strict verification gate. A first reviewer proposed the comments below on a pull request.",
    'Only high-quality, correct, material comments may be posted. You have read-only repository tools - USE THEM to',
    'verify each claim against the actual code before deciding.',
    '',
    `Pull request #${String(pullRequest.pullRequestId)}: ${pullRequest.title}`,
    '',
    'Proposed comments:',
    numbered,
    '',
    'Keep a comment ONLY if it is: correct (verified against the code), material (a real correctness, design, API,',
    'security, or privacy issue a careful human reviewer would also raise), specific, non-duplicative, and actionable.',
    'Drop anything wrong, speculative, a style/naming nit, low-value, or already enforced by linters. Better to drop a',
    'borderline comment than to',
    'post a weak one. Be conservative.',
    'For a comment on pre-existing code this PR did NOT change, KEEP it ONLY if it (a) explains how a change in THIS PR',
    'breaks that existing code, or (b) is a high-severity correctness bug or a security/privacy issue in a touched file.',
    'Otherwise DROP it (low/medium-severity or style/design nits on unchanged code are out of scope).',
    '',
    'Respond with ONLY a single fenced ```json code block:',
    '```json',
    '{ "approved": true, "keepIndices": [0, 2], "reason": "short justification" }',
    '```',
    'Set "approved" to false and "keepIndices" to [] if none meet the bar.'
  ].join('\n');
}

/** Parse the verification verdict; returns `undefined` when no valid JSON verdict can be recovered. */
export function parseVerificationResult(rawOutput: string): VerificationResult | undefined {
  const cleaned = rawOutput.replace(ANSI_ESCAPE_PATTERN, '');
  const candidate = extractJsonCandidate(cleaned);
  if (candidate === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }

  const validation = verificationResultSchema.safeParse(parsed);
  if (!validation.success) {
    return undefined;
  }

  return {
    approved: validation.data.approved,
    keepIndices: validation.data.keepIndices,
    reason: validation.data.reason
  };
}
