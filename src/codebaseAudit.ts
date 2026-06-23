// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditFindingCandidate,
  type AuditLocation,
  type AuditSeverity,
  auditFindingId,
  findingsForFiles,
  readAuditProgress,
  recordScannedFiles,
  scannedFileHashes,
  touchFindingsForFiles,
  upsertAuditFindings,
  writeAuditProgress
} from './auditStore';
import { REPO_DESCRIPTION } from './config';
import { runCopilotReview } from './copilot';
import { describeError, numberLines, runCommand, type Logger } from './util';

// Strips ANSI control sequences from CLI stdout before JSON extraction.
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// Matches fenced ```json ... ``` blocks so the model's JSON answer can be recovered from prose.
const FENCED_CODE_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/g;

// Directory names never worth auditing (dependencies, build output, VCS, generated artifacts).
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'lib',
  'out',
  'build',
  'bin',
  'obj',
  'coverage',
  'temp',
  '.next',
  '.turbo',
  '.cache',
  'generated',
  '__generated__'
]);

// Top-level repo folders the sweep walks (authored source lives here; everything else is skipped).
const AUDIT_ROOT_FOLDERS: readonly string[] = ['packages', 'apps', 'tools', 'common', 'scripts'];

// File extensions the sweep considers source worth auditing.
const AUDIT_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.cs']);

// Skip declaration files, minified bundles, and source maps - no actionable security/privacy surface.
const EXCLUDED_FILE_PATTERN = /(\.d\.ts|\.min\.[cm]?js|\.map)$/i;

// Cap any single file embedded in a prompt so one huge file cannot blow the model's context budget.
const MAX_AUDITABLE_FILE_BYTES = 200_000;

// Security/privacy-sensitive path hints; matching files are audited first within each sweep so the
// highest-risk code surfaces findings earliest. Kept broad on purpose - it only affects ordering.
const HIGH_RISK_PATH_PATTERN =
  /(auth|login|logout|token|secret|credential|password|crypt|cipher|signature|network|http|fetch|request|serializ|deserializ|sql|query|exec|spawn|eval|sanitiz|escape|cors|cookie|session|oauth|sso|permission|privacy|telemetry|pii)/i;

function riskRank(filePath: string): number {
  return HIGH_RISK_PATH_PATTERN.test(filePath) ? 0 : 1;
}

const auditSeveritySchema = z.enum(['blocking', 'major', 'minor', 'nit']).catch('major');
const auditCategorySchema = z.enum(AUDIT_CATEGORIES).catch('security');
const auditLocationSchema = z.object({
  filePath: z.string(),
  line: z.number().int().nonnegative().catch(1),
  endLine: z.number().int().nonnegative().optional()
});

const auditGenerationFindingSchema = z.object({
  filePath: z.string(),
  line: z.number().int().nonnegative().catch(1),
  endLine: z.number().int().nonnegative().optional(),
  severity: auditSeveritySchema,
  category: auditCategorySchema,
  title: z.string(),
  body: z.string(),
  detail: z.string().optional(),
  confidence: z.number().min(0).max(1).optional().catch(0.6),
  relatedLocations: z.array(auditLocationSchema).optional()
});

const auditGenerationSchema = z.object({
  findings: z.array(auditGenerationFindingSchema).catch([])
});

const auditVerifyDecisionSchema = z.object({
  index: z.number().int().nonnegative(),
  // Tolerate a malformed verdict by treating it as "drop" - the quality gate must never keep on doubt.
  keep: z.boolean().catch(false),
  confidence: z.number().min(0).max(1).optional().catch(0.5)
});

const auditVerifyResultSchema = z.object({
  decisions: z.array(auditVerifyDecisionSchema).catch([])
});

interface ProposedFinding {
  readonly filePath: string;
  readonly line: number;
  readonly endLine?: number;
  readonly severity: AuditSeverity;
  readonly category: AuditCategory;
  readonly title: string;
  readonly body: string;
  readonly detail?: string;
  readonly confidence: number;
  readonly relatedLocations?: readonly AuditLocation[];
}

/** Recursively collect repo-relative source-file paths under one folder, skipping excluded dirs/files. */
function collectFilesUnder(repoRoot: string, relativeDir: string, into: string[]): void {
  const absoluteDir = path.join(repoRoot, relativeDir);
  let entries: readonly {
    readonly name: string;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  }[];
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      collectFilesUnder(repoRoot, path.join(relativeDir, entry.name), into);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!AUDIT_FILE_EXTENSIONS.has(extension) || EXCLUDED_FILE_PATTERN.test(entry.name)) {
      continue;
    }

    into.push(path.join(relativeDir, entry.name).replace(/\\/g, '/'));
  }
}

/**
 * Enumerate the source files the audit sweep should examine, as repo-relative POSIX paths. Security- and
 * privacy-sensitive paths are ordered first so the highest-risk code surfaces findings earliest; ties break
 * alphabetically. The ordering is deterministic so the resume cursor stays stable across batches.
 */
export function enumerateAuditFiles(repoRoot: string): readonly string[] {
  const collected: string[] = [];
  for (const folder of AUDIT_ROOT_FOLDERS) {
    collectFilesUnder(repoRoot, folder, collected);
  }
  return collected.sort((left, right) => {
    const byRisk = riskRank(left) - riskRank(right);
    return byRisk !== 0 ? byRisk : left.localeCompare(right);
  });
}

function extractJsonObject(rawOutput: string): string | undefined {
  const cleaned = rawOutput.replace(ANSI_ESCAPE_PATTERN, '');
  const fencedBlocks: string[] = [];
  FENCED_CODE_BLOCK_PATTERN.lastIndex = 0;
  for (
    let match = FENCED_CODE_BLOCK_PATTERN.exec(cleaned);
    match !== null;
    match = FENCED_CODE_BLOCK_PATTERN.exec(cleaned)
  ) {
    const inner = match[1].trim();
    if (inner.startsWith('{')) {
      fencedBlocks.push(inner);
    }
  }
  if (fencedBlocks.length > 0) {
    return fencedBlocks[fencedBlocks.length - 1];
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return undefined;
}

interface LoadedFile {
  readonly filePath: string;
  readonly numberedContent: string;
}

function loadBatchFiles(repoRoot: string, batch: readonly string[], maxFileLines: number): readonly LoadedFile[] {
  const loaded: LoadedFile[] = [];
  for (const filePath of batch) {
    const absolutePath = path.join(repoRoot, filePath);
    let size = 0;
    try {
      size = statSync(absolutePath).size;
    } catch {
      continue;
    }
    if (size > MAX_AUDITABLE_FILE_BYTES) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const truncated = lines.length > maxFileLines;
    const body = truncated ? lines.slice(0, maxFileLines).join('\n') : content;
    const numbered = numberLines(body) + (truncated ? `\n... (truncated at ${String(maxFileLines)} lines)` : '');
    loaded.push({ filePath, numberedContent: numbered });
  }
  return loaded;
}

// Matches `... from '<spec>'` and `import('<spec>')` / `require('<spec>')`, so the auditor can list the
// in-repo files a batch imports as targeted cross-file context for the model to read.
const IMPORT_SPECIFIER_PATTERN = /(?:from\s*['"]|(?:import|require)\(\s*['"])([^'"]+)['"]/g;
const MODULE_FILE_SUFFIXES: readonly string[] = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js'
];

function resolveModuleFile(repoRoot: string, relativeBase: string): string | undefined {
  for (const suffix of MODULE_FILE_SUFFIXES) {
    const candidate = `${relativeBase}${suffix}`;
    if (existsSync(path.join(repoRoot, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

const WORKSPACE_PACKAGE_ROOTS: readonly string[] = ['packages', 'apps', 'tools', 'common'];
const packageNameSchema = z.object({ name: z.string().optional() });
const PACKAGE_MAP_CACHE_MS = 6 * 60 * 60 * 1000;
let cachedPackageMap: { readonly value: ReadonlyMap<string, string>; readonly at: number } | undefined;

// Build a workspace package-name -> directory map (e.g. "@myorg/my-package" -> "packages/my-package") from
// every package.json, so cross-package imports can be resolved to their source. Cached for a few hours.
function buildPackageMap(repoRoot: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const root of WORKSPACE_PACKAGE_ROOTS) {
    let entries: readonly { readonly name: string; readonly isDirectory: () => boolean }[];
    try {
      entries = readdirSync(path.join(repoRoot, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = `${root}/${entry.name}`;
      try {
        const parsed = packageNameSchema.safeParse(
          JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'))
        );
        if (parsed.success && parsed.data.name !== undefined && parsed.data.name !== '') {
          map.set(parsed.data.name, dir);
        }
      } catch {
        /* not a package directory */
      }
    }
  }
  return map;
}

function packageMap(repoRoot: string): ReadonlyMap<string, string> {
  if (cachedPackageMap === undefined || Date.now() - cachedPackageMap.at >= PACKAGE_MAP_CACHE_MS) {
    cachedPackageMap = { value: buildPackageMap(repoRoot), at: Date.now() };
  }
  return cachedPackageMap.value;
}

// Resolve a workspace package import (e.g. "@myorg/my-package" or "@myorg/my-package/sub/path") to a source
// file in the repo, so the model gets the imported API's source as cross-package context.
function resolveWorkspaceModule(
  repoRoot: string,
  packages: ReadonlyMap<string, string>,
  specifier: string
): string | undefined {
  const parts = specifier.split('/');
  const scoped = specifier.startsWith('@');
  const packageName = scoped ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = (scoped ? parts.slice(2) : parts.slice(1)).join('/');
  const dir = packages.get(packageName);
  if (dir === undefined) {
    return undefined;
  }
  if (subpath !== '') {
    return resolveModuleFile(repoRoot, `${dir}/${subpath}`) ?? resolveModuleFile(repoRoot, `${dir}/src/${subpath}`);
  }
  return resolveModuleFile(repoRoot, `${dir}/src/index`) ?? resolveModuleFile(repoRoot, `${dir}/index`);
}

// Source files alongside a batch file (same directory) - relevant context the file may not import.
function siblingFiles(
  repoRoot: string,
  baseDir: string,
  batchSet: ReadonlySet<string>,
  cap: number
): readonly string[] {
  let entries: readonly { readonly name: string; readonly isFile: () => boolean }[];
  try {
    entries = readdirSync(path.join(repoRoot, baseDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (!AUDIT_FILE_EXTENSIONS.has(extension) || EXCLUDED_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    const relative = `${baseDir}/${entry.name}`;
    if (batchSet.has(relative.toLowerCase())) {
      continue;
    }
    result.push(relative);
    if (result.length >= cap) {
      break;
    }
  }
  return result;
}

// Collect the in-repo files most relevant to a batch (a lightweight, deterministic stand-in for a semantic
// index): the files it imports - relative AND workspace-package - plus same-directory siblings, pointing the
// model at the cross-file context most worth reading.
function relatedFilesForBatch(repoRoot: string, batch: readonly string[]): readonly string[] {
  const batchSet = new Set(batch.map((filePath) => filePath.toLowerCase()));
  const packages = packageMap(repoRoot);
  const related = new Set<string>();
  for (const filePath of batch) {
    const baseDir = path.posix.dirname(filePath.replace(/\\/g, '/'));
    for (const sibling of siblingFiles(repoRoot, baseDir, batchSet, 4)) {
      related.add(sibling);
    }
    let content: string;
    try {
      content = readFileSync(path.join(repoRoot, filePath), 'utf8');
    } catch {
      continue;
    }
    IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
    for (
      let match = IMPORT_SPECIFIER_PATTERN.exec(content);
      match !== null;
      match = IMPORT_SPECIFIER_PATTERN.exec(content)
    ) {
      const specifier = match[1];
      const resolved = specifier.startsWith('.')
        ? resolveModuleFile(repoRoot, path.posix.normalize(path.posix.join(baseDir, specifier)))
        : resolveWorkspaceModule(repoRoot, packages, specifier);
      if (resolved !== undefined && !batchSet.has(resolved.toLowerCase())) {
        related.add(resolved.replace(/\\/g, '/'));
      }
    }
  }
  return [...related].slice(0, 35);
}

function buildAuditGenerationPrompt(files: readonly LoadedFile[], relatedFiles: readonly string[]): string {
  const header = [
    `You are a meticulous code auditor reviewing source files from ${REPO_DESCRIPTION}.`,
    '',
    'Find material issues in these categories (use the exact lowercase key for "category"):',
    '- security: injection (SQL/command/path), broken authn/authz, SSRF, insecure deserialization, XSS,',
    '  weak/misused crypto, unsafe redirects, missing input validation at trust boundaries, unsafe eval.',
    '- privacy: logging personal data / user content, over-broad collection, leaking identifiers into',
    '  telemetry/logs/URLs, missing data classification, retaining PII.',
    '- secrets: hardcoded keys/tokens/passwords/connection strings, or secrets written to logs.',
    '- telemetry: PII or user content in telemetry events, over-broad event fields, missing classification.',
    '- telemetry-gap: a PRODUCTION code path that matters for diagnosing a live-site incident yet emits NO',
    '  telemetry/log/metric AND has none nearby - e.g. a swallowed catch, an unlogged error/timeout/retry/',
    '  fallback branch, or a silent data-loss/corruption path. Report ONLY when ALL hold: (1) it runs in',
    '  production (not tests, build scripts, or dev-only tooling), (2) failure there is silent so on-call',
    '  would have no signal to detect or root-cause it, and (3) nothing already logs/measures it on or near',
    '  that path. Do NOT flag expected/validated control flow (input validation, 404s, user cancellation),',
    '  generic "add a log here" nits, or paths that already emit a comparable event/metric. Prefer a few',
    '  high-value gaps over many; severity reflects how blind the gap leaves incident response (rarely blocking).',
    '- correctness: null/undefined hazards, race conditions, unhandled promise rejections, off-by-one.',
    '- resilience: missing timeouts/retries/cancellation on network calls, swallowed errors.',
    '- performance: N+1 patterns, unbounded loops over large data, sync I/O on hot paths, missing memoization.',
    '- accessibility: missing roles/labels/alt text, non-semantic interactive elements, focus traps.',
    '- dependency: known-vulnerable or unpinned/untrusted dependencies, license incompatibility.',
    '- api-compat: a breaking change to a public package surface without a major version bump.',
    '- dead-code: clearly unused exports or unreferenced code.',
    '- config: permissive CORS, disabled TLS verification, world-readable or over-permissive resources.',
    '',
    'Be precise and skeptical: only report an issue when you can name the concrete impact AND point to the',
    'specific line. If you are not confident it is real and material, OMIT it.',
    '',
    'You have read-only tools - USE THEM. Before reporting an issue, read the surrounding code needed to',
    'confirm it: the function and its callers, imported helpers, the data source and the affected sink, and',
    'any validation in between. Reading more files is encouraged; prefer a few high-confidence findings over',
    'many speculative ones. If the issue genuinely spans multiple files, list the extra ones in',
    'relatedLocations (each with an exact repo-relative path and line).',
    '',
    'Respond with ONLY a JSON object in this exact shape (no prose outside the JSON):',
    '```json',
    '{',
    '  "findings": [',
    '    {',
    '      "filePath": "<one of the exact file paths shown below>",',
    '      "line": <1-based start line>,',
    '      "endLine": <1-based end line; include ONLY when the issue spans a block of lines>,',
    '      "severity": "blocking | major | minor | nit",',
    '      "category": "security | privacy | secrets | telemetry | telemetry-gap | correctness | resilience | performance | accessibility | dependency | api-compat | dead-code | config",',
    '      "title": "short headline",',
    '      "body": "one or two sentences: the concrete issue and the suggested fix",',
    '      "detail": "an in-depth explanation a developer can act on: the exact mechanism (how the bad input reaches the sink / how the bug triggers), why it matters (impact), and a concrete remediation - reference specific identifiers and lines. A few sentences to a short paragraph.",',
    '      "confidence": <0..1>,',
    '      "relatedLocations": [ { "filePath": "<exact repo-relative path>", "line": <1-based line>, "endLine": <optional end line> } ]',
    '    }',
    '  ]',
    '}',
    '```',
    'relatedLocations is optional - include it only when the issue truly spans more than one location.',
    'If there are no material issues in these files, return {"findings": []}.',
    '',
    'Files to audit:'
  ].join('\n');

  const fileBlocks = files
    .map((file) => [`----- FILE: ${file.filePath} -----`, file.numberedContent].join('\n'))
    .join('\n\n');

  const relatedBlock =
    relatedFiles.length > 0
      ? `\n\nRelated in-repo files (imported by, or sitting alongside, the files above) - read them with your tools if they help confirm an issue:\n${relatedFiles.map((file) => `- ${file}`).join('\n')}`
      : '';

  return `${header}\n\n${fileBlocks}${relatedBlock}\n`;
}

function buildAuditVerifyPrompt(files: readonly LoadedFile[], candidates: readonly ProposedFinding[]): string {
  const header = [
    'You are the QUALITY GATE for a code audit. Below are candidate findings and the source files they',
    'reference. For EACH candidate, decide keep=true ONLY if it is a REAL, material, correctly located issue',
    'in its stated category - not a false positive, not a non-issue, not already mitigated, and not',
    'mislabeled. Reject anything speculative, stylistic, or unverifiable. Be strict: when in doubt, drop.',
    '',
    'You have read-only tools - USE THEM to re-read the referenced file and any related code (callers,',
    'helpers, validation) needed to confirm the issue actually reproduces before you keep it.',
    '',
    'Respond with ONLY this JSON (no prose outside the JSON):',
    '```json',
    '{ "decisions": [ { "index": <candidate index>, "keep": true | false, "confidence": <0..1> } ] }',
    '```',
    '',
    'Candidate findings:'
  ].join('\n');

  const candidateBlock = candidates
    .map((candidate, index) =>
      [
        `[${String(index)}] ${candidate.category}/${candidate.severity} - ${candidate.filePath}:${String(candidate.line)}`,
        `    title: ${candidate.title}`,
        `    body: ${candidate.body}`
      ].join('\n')
    )
    .join('\n\n');

  const fileBlocks = files
    .map((file) => [`----- FILE: ${file.filePath} -----`, file.numberedContent].join('\n'))
    .join('\n\n');

  return `${header}\n\n${candidateBlock}\n\nReferenced files:\n\n${fileBlocks}\n`;
}

/** Options for one model-driven verification pass over a batch's candidate findings. */
interface VerifyPassOptions {
  readonly cliPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly files: readonly LoadedFile[];
  readonly candidates: readonly ProposedFinding[];
  readonly logger: Logger;
}

/** Run a single verification pass; returns keep/confidence keyed by candidate index. */
async function runVerifyPass(
  options: VerifyPassOptions
): Promise<ReadonlyMap<number, { readonly keep: boolean; readonly confidence: number }>> {
  const decisions = new Map<number, { keep: boolean; confidence: number }>();
  const prompt = buildAuditVerifyPrompt(options.files, options.candidates);
  const result = await runCopilotReview({
    cliPath: options.cliPath,
    prompt,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs
  });

  const candidate = extractJsonObject(result.stdout);
  if (candidate === undefined) {
    return decisions;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    return decisions;
  }

  const parsed = auditVerifyResultSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return decisions;
  }

  for (const decision of parsed.data.decisions) {
    decisions.set(decision.index, { keep: decision.keep, confidence: decision.confidence ?? 0.5 });
  }
  return decisions;
}

/** Options for auditing a single batch of files (generation + double verification). */
export interface AuditBatchOptions {
  readonly repoRoot: string;
  readonly cliPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly batchTimeoutMs: number;
  readonly maxFileLines: number;
  readonly batch: readonly string[];
  readonly logger: Logger;
}

/** The result of auditing one batch: how many findings were proposed vs. survived the double check. */
export interface AuditBatchResult {
  readonly proposed: number;
  readonly kept: readonly AuditFindingCandidate[];
}

// Best-effort: the ISO time the file first appears in git history ("in codebase since"). Returns undefined
// on shallow clones or non-git paths. Bounded by the file's own commit count, not the whole repo history.
function fileIntroducedAtIso(repoRoot: string, filePath: string): string | undefined {
  const result = runCommand('git', ['-C', repoRoot, 'log', '--format=%aI', '--follow', '--', filePath]);
  if (result.status !== 0) {
    return undefined;
  }
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

const dedupResultSchema = z.object({
  decisions: z.array(z.object({ candidate: z.number().int().nonnegative(), match: z.string().catch('new') })).catch([])
});

function normalizeAuditPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

interface DedupExisting {
  readonly id: string;
  readonly filePath: string;
  readonly category: string;
  readonly line: number;
  readonly title: string;
}

function buildDedupPrompt(existing: readonly DedupExisting[], candidates: readonly AuditFindingCandidate[]): string {
  const existingBlock =
    existing.length > 0
      ? existing
          .map(
            (finding, index) =>
              `[E${String(index)}] ${finding.filePath} | ${finding.category} | L${String(finding.line)} | ${finding.title}`
          )
          .join('\n')
      : '(none)';
  const candidateBlock = candidates
    .map(
      (candidate, index) =>
        `[C${String(index)}] ${candidate.filePath} | ${candidate.category} | L${String(candidate.line)} | ${candidate.title} | ${candidate.body.slice(0, 200)}`
    )
    .join('\n');
  return [
    'You are de-duplicating code-audit findings. Two findings are DUPLICATES only when they describe the',
    'SAME underlying issue in the SAME file and the SAME category - the title, wording, and line number may',
    'differ. Judge by MEANING, not by text overlap. Be conservative: if you are not confident they are the',
    'same issue, treat the new finding as new.',
    '',
    'EXISTING findings (already stored):',
    existingBlock,
    '',
    'NEW findings (this run):',
    candidateBlock,
    '',
    'For EACH new finding Ci output its match:',
    '- "E<k>" if it is the same issue as existing finding E<k>,',
    '- "C<j>" (with j < i) if it is the same issue as an earlier new finding C<j>,',
    '- "new" otherwise.',
    'A match MUST be the same file AND the same category.',
    '',
    'Respond with ONLY this JSON (no prose outside the JSON):',
    '```json',
    '{ "decisions": [ { "candidate": 0, "match": "new | E0 | C0" } ] }',
    '```'
  ].join('\n');
}

async function runDedupPass(
  options: AuditBatchOptions,
  existing: readonly DedupExisting[],
  candidates: readonly AuditFindingCandidate[]
): Promise<ReadonlyMap<number, string>> {
  const decisions = new Map<number, string>();
  const result = await runCopilotReview({
    cliPath: options.cliPath,
    prompt: buildDedupPrompt(existing, candidates),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: options.repoRoot,
    timeoutMs: options.batchTimeoutMs
  });
  const candidateJson = extractJsonObject(result.stdout);
  if (candidateJson === undefined) {
    return decisions;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidateJson);
  } catch {
    return decisions;
  }
  const parsed = dedupResultSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return decisions;
  }
  for (const decision of parsed.data.decisions) {
    decisions.set(decision.candidate, decision.match);
  }
  return decisions;
}

/**
 * Semantically de-duplicate kept candidates against already-stored findings (and earlier candidates in the
 * same batch). When the model judges a candidate to be the SAME underlying issue as an existing finding
 * (regardless of how the title is worded), the candidate is tagged with that finding's id so upsert merges
 * into it - which collapses duplicates and makes a dismissal stick across re-wordings. Falls back to no
 * matching (each candidate keeps its own identity) on any failure.
 */
async function resolveSemanticDuplicates(
  options: AuditBatchOptions,
  kept: readonly AuditFindingCandidate[]
): Promise<readonly AuditFindingCandidate[]> {
  if (kept.length === 0) {
    return kept;
  }
  const existing: readonly DedupExisting[] = findingsForFiles(kept.map((candidate) => candidate.filePath))
    .slice(0, 60)
    .map((finding) => ({
      id: finding.id,
      filePath: finding.filePath,
      category: finding.category,
      line: finding.line,
      title: finding.title
    }));
  // Nothing to dedup against and only one candidate -> no possible duplicate.
  if (existing.length === 0 && kept.length < 2) {
    return kept;
  }

  let decisions: ReadonlyMap<number, string>;
  try {
    decisions = await runDedupPass(options, existing, kept);
  } catch (error) {
    options.logger.warn(`Saturn audit: dedup pass failed: ${describeError(error)}`);
    return kept;
  }

  const canonicalIds = new Map<number, string>();
  const result: AuditFindingCandidate[] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const candidate = kept[index];
    const ownId = auditFindingId(candidate.filePath, candidate.title, candidate.category);
    let canonical = ownId;
    const match = (decisions.get(index) ?? '').trim().toUpperCase();
    if (match.startsWith('E')) {
      const targetIndex = Number.parseInt(match.slice(1), 10);
      const target = Number.isNaN(targetIndex) ? undefined : existing[targetIndex];
      if (
        target !== undefined &&
        normalizeAuditPath(target.filePath) === normalizeAuditPath(candidate.filePath) &&
        target.category === candidate.category
      ) {
        canonical = target.id;
      }
    } else if (match.startsWith('C')) {
      const earlierIndex = Number.parseInt(match.slice(1), 10);
      const earlier = !Number.isNaN(earlierIndex) && earlierIndex < index ? kept[earlierIndex] : undefined;
      const earlierId = canonicalIds.get(earlierIndex);
      if (
        earlier !== undefined &&
        earlierId !== undefined &&
        normalizeAuditPath(earlier.filePath) === normalizeAuditPath(candidate.filePath) &&
        earlier.category === candidate.category
      ) {
        canonical = earlierId;
      }
    }
    canonicalIds.set(index, canonical);
    result.push(canonical === ownId ? candidate : { ...candidate, matchId: canonical });
  }
  return result;
}

/**
 * Audit one batch of files: one generation pass proposes candidate security/privacy findings, then TWO
 * independent verification passes re-check them; a candidate is kept only if BOTH passes keep it (the
 * double quality check). Surviving confidence is the lower of the two passes' confidence (skeptical).
 */
export async function runAuditBatch(options: AuditBatchOptions): Promise<AuditBatchResult> {
  const files = loadBatchFiles(options.repoRoot, options.batch, options.maxFileLines);
  if (files.length === 0) {
    return { proposed: 0, kept: [] };
  }

  const allowedPaths = new Set(files.map((file) => file.filePath));
  const relatedFiles = relatedFilesForBatch(
    options.repoRoot,
    files.map((file) => file.filePath)
  );
  const generationResult = await runCopilotReview({
    cliPath: options.cliPath,
    prompt: buildAuditGenerationPrompt(files, relatedFiles),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: options.repoRoot,
    timeoutMs: options.batchTimeoutMs
  });

  const generationCandidate = extractJsonObject(generationResult.stdout);
  if (generationCandidate === undefined) {
    return { proposed: 0, kept: [] };
  }

  let generationJson: unknown;
  try {
    generationJson = JSON.parse(generationCandidate);
  } catch {
    return { proposed: 0, kept: [] };
  }

  const generationParsed = auditGenerationSchema.safeParse(generationJson);
  if (!generationParsed.success) {
    return { proposed: 0, kept: [] };
  }

  // Keep only findings that reference a file we actually sent (drops hallucinated paths).
  const proposed: ProposedFinding[] = generationParsed.data.findings
    .filter((finding) => allowedPaths.has(finding.filePath))
    .map((finding) => ({
      filePath: finding.filePath,
      line: finding.line,
      endLine: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      body: finding.body,
      detail: finding.detail,
      confidence: finding.confidence ?? 0.6,
      relatedLocations: finding.relatedLocations
    }));

  if (proposed.length === 0) {
    return { proposed: 0, kept: [] };
  }

  // Double quality check: two independent verification passes; keep only what BOTH passes approve.
  const verifyOptions: VerifyPassOptions = {
    cliPath: options.cliPath,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    cwd: options.repoRoot,
    timeoutMs: options.batchTimeoutMs,
    files,
    candidates: proposed,
    logger: options.logger
  };
  const firstPass = await runVerifyPass(verifyOptions);
  const secondPass = await runVerifyPass(verifyOptions);

  const kept: AuditFindingCandidate[] = [];
  const introducedCache = new Map<string, string | undefined>();
  for (let index = 0; index < proposed.length; index += 1) {
    const first = firstPass.get(index);
    const second = secondPass.get(index);
    // A candidate survives only if BOTH passes explicitly kept it.
    if (first?.keep !== true || second?.keep !== true) {
      continue;
    }
    const finding = proposed[index];
    if (!introducedCache.has(finding.filePath)) {
      introducedCache.set(finding.filePath, fileIntroducedAtIso(options.repoRoot, finding.filePath));
    }
    kept.push({
      filePath: finding.filePath,
      line: finding.line,
      endLine: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      body: finding.body,
      detail: finding.detail,
      confidence: Math.min(first.confidence, second.confidence),
      relatedLocations: finding.relatedLocations,
      introducedAt: introducedCache.get(finding.filePath)
    });
  }

  // Collapse semantic duplicates (re-worded re-detections of an existing issue) before storing.
  const deduped = await resolveSemanticDuplicates(options, kept);
  return { proposed: proposed.length, kept: deduped };
}

/** Options driving one resumable sweep step (one batch). */
export interface AuditSweepStepOptions {
  readonly repoRoot: string;
  readonly cliPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly batchTimeoutMs: number;
  readonly batchFileCount: number;
  readonly batchTokenBudget: number;
  readonly maxFileLines: number;
  readonly logger: Logger;
}

/** The outcome of one sweep step, so the service loop can decide whether to continue or idle. */
export interface AuditSweepStepResult {
  readonly sweepNumber: number;
  readonly totalFiles: number;
  readonly filesScanned: number;
  readonly batchFiles: readonly string[];
  readonly added: number;
  readonly refreshed: number;
  readonly proposed: number;
  /** True when this step finished the last batch of the current sweep (or there was nothing left to do). */
  readonly sweepComplete: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Process the next batch of the current sweep (resuming from the persisted cursor), audit it, merge any
 * findings, and advance the cursor. When no sweep cursor exists yet, a fresh sweep is started at file 0.
 * Returns `sweepComplete: true` once the last batch is done so the caller can idle until the next day.
 */
// Cache the enumerated file list for the duration of a sweep (keyed by sweep number), so each batch does
// not re-walk the entire repo. Re-enumerated automatically when the sweep number changes.
let cachedEnumeration: { readonly sweepNumber: number; readonly files: readonly string[] } | undefined;

function enumerateForSweep(repoRoot: string, sweepNumber: number): readonly string[] {
  if (cachedEnumeration?.sweepNumber === sweepNumber) {
    return cachedEnumeration.files;
  }
  const files = enumerateAuditFiles(repoRoot);
  cachedEnumeration = { sweepNumber, files };
  return files;
}

// sha1 of a file's raw bytes, used by incremental sweeps to skip files unchanged since their last scan.
function fileContentHash(repoRoot: string, filePath: string): string | undefined {
  try {
    return createHash('sha1')
      .update(readFileSync(path.join(repoRoot, filePath)))
      .digest('hex');
  } catch {
    return undefined;
  }
}

// Walk at most this many files per step so an incremental sweep (where most files are skipped) advances
// quickly; the scanned set is still bounded by the file count + token budget below.
const INCREMENTAL_WALK_LIMIT = 200;

// Rough token estimate for a file as the model sees it (truncated to maxFileLines, line-numbered): ~4 chars
// per token, capped by the line limit, with a margin for the line-number prefixes. Used only to pack a batch
// within the per-call token budget, so an approximation is fine.
function estimateFileTokens(repoRoot: string, filePath: string, maxFileLines: number): number {
  let size = 0;
  try {
    size = statSync(path.join(repoRoot, filePath)).size;
  } catch {
    return 0;
  }
  const cappedChars = Math.min(size, maxFileLines * 80) * 1.15;
  return Math.ceil(cappedChars / 4);
}

export async function runAuditSweepStep(options: AuditSweepStepOptions): Promise<AuditSweepStepResult> {
  const existing = readAuditProgress();
  // Enumerate once per sweep (cached) instead of re-walking the whole repo on every batch.
  const files = enumerateForSweep(options.repoRoot, existing?.sweepNumber ?? 1);
  const progress = existing ?? {
    sweepNumber: 1,
    sweepStartedAt: nowIso(),
    nextFileIndex: 0,
    totalFiles: files.length,
    filesScanned: 0,
    completedSweeps: 0
  };

  // The current sweep is already fully scanned: report completion without doing work. The service loop
  // idles and calls startNewAuditSweep when the daily cadence is due.
  if (progress.nextFileIndex >= files.length) {
    return {
      sweepNumber: progress.sweepNumber,
      totalFiles: files.length,
      filesScanned: progress.filesScanned,
      batchFiles: [],
      added: 0,
      refreshed: 0,
      proposed: 0,
      sweepComplete: true
    };
  }

  // Build the batch by walking forward from the cursor. Files unchanged since their last scan are skipped
  // (incremental sweep) at no token cost; changed/new files are packed for scanning until either the per-call
  // file cap OR the token budget is reached, so each LLM call stays within the model's working capacity. On
  // the first sweep the hash table is empty, so nothing is skipped and files are packed up to the budget.
  const maxScanFiles = Math.max(1, options.batchFileCount);
  const window = files.slice(
    progress.nextFileIndex,
    progress.nextFileIndex + Math.max(maxScanFiles, INCREMENTAL_WALK_LIMIT)
  );
  const priorDigests = scannedFileHashes(window);
  const digestByPath = new Map<string, string>();
  const toScan: string[] = [];
  const unchanged: string[] = [];
  let scanTokens = 0;
  let walked = 0;
  for (const filePath of window) {
    if (toScan.length >= maxScanFiles) {
      break;
    }
    const digest = fileContentHash(options.repoRoot, filePath);
    if (digest === undefined) {
      // Unreadable/binary here - loadBatchFiles drops it; it still counts as a scan slot.
      toScan.push(filePath);
      walked += 1;
      continue;
    }
    digestByPath.set(filePath, digest);
    if (priorDigests.get(normalizeAuditPath(filePath)) === digest) {
      unchanged.push(filePath);
      walked += 1;
      continue;
    }
    const fileTokens = estimateFileTokens(options.repoRoot, filePath, options.maxFileLines);
    // Always include at least one file; otherwise stop before exceeding the per-call token budget.
    if (toScan.length >= 1 && scanTokens + fileTokens > options.batchTokenBudget) {
      break;
    }
    toScan.push(filePath);
    scanTokens += fileTokens;
    walked += 1;
  }
  const batch = window.slice(0, walked);
  if (unchanged.length > 0) {
    touchFindingsForFiles(unchanged, progress.sweepNumber);
  }

  let added = 0;
  let refreshed = 0;
  let proposed = 0;
  let scanSucceeded = true;
  if (toScan.length > 0) {
    try {
      const batchResult = await runAuditBatch({
        repoRoot: options.repoRoot,
        cliPath: options.cliPath,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        batchTimeoutMs: options.batchTimeoutMs,
        maxFileLines: options.maxFileLines,
        batch: toScan,
        logger: options.logger
      });
      proposed = batchResult.proposed;
      if (batchResult.kept.length > 0) {
        const merged = upsertAuditFindings(batchResult.kept, nowIso(), progress.sweepNumber);
        added = merged.added;
        refreshed = merged.refreshed;
      }
    } catch (error) {
      scanSucceeded = false;
      options.logger.warn(`Saturn audit: batch failed: ${describeError(error)}`);
    }
  }

  // Record the current hash of each unchanged file, and of each scanned file only when the scan succeeded
  // (so a failed scan is retried next sweep rather than silently skipped).
  const scannedRecords: { readonly filePath: string; readonly contentHash: string }[] = [];
  for (const filePath of unchanged) {
    const digest = digestByPath.get(filePath);
    if (digest !== undefined) {
      scannedRecords.push({ filePath, contentHash: digest });
    }
  }
  if (scanSucceeded) {
    for (const filePath of toScan) {
      const digest = digestByPath.get(filePath);
      if (digest !== undefined) {
        scannedRecords.push({ filePath, contentHash: digest });
      }
    }
  }
  if (scannedRecords.length > 0) {
    recordScannedFiles(scannedRecords, progress.sweepNumber);
  }

  const newIndex = progress.nextFileIndex + batch.length;
  const sweepComplete = newIndex >= files.length;
  const filesScanned = progress.filesScanned + batch.length;
  writeAuditProgress({
    sweepNumber: progress.sweepNumber,
    sweepStartedAt: progress.sweepStartedAt,
    nextFileIndex: newIndex,
    totalFiles: files.length,
    filesScanned,
    completedSweeps: sweepComplete ? progress.completedSweeps + 1 : progress.completedSweeps,
    lastBatchAt: nowIso()
  });

  return {
    sweepNumber: progress.sweepNumber,
    totalFiles: files.length,
    filesScanned,
    batchFiles: batch,
    added,
    refreshed,
    proposed,
    sweepComplete
  };
}

/** Start a fresh sweep from file 0, incrementing the sweep number. Call after the daily idle elapses. */
export function startNewAuditSweep(repoRoot: string): void {
  const files = enumerateAuditFiles(repoRoot);
  const previous = readAuditProgress();
  writeAuditProgress({
    sweepNumber: (previous?.sweepNumber ?? 0) + 1,
    sweepStartedAt: nowIso(),
    nextFileIndex: 0,
    totalFiles: files.length,
    filesScanned: 0,
    completedSweeps: previous?.completedSweeps ?? 0,
    lastBatchAt: previous?.lastBatchAt
  });
}
