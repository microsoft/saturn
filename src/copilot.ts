// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AZURE_DEVOPS_CONFIG, backupModel, modelFailureThreshold, primaryModel } from './config';
import { isRecord, runCommand, runCommandAsync, type RunCommandResult } from './util';

// --- Model fallback manager (in-memory, resets on restart) -----------------------------------------------
// Tracks consecutive failures on the primary model. After `modelFailureThreshold()` failures, all agents
// switch to the backup model until the process restarts. Success resets the counter.

let consecutiveModelFailures = 0;
let usingBackup = false;

/** Get the effective model to use, considering failure state. */
export function getEffectiveModel(requestedModel: string): string {
  if (usingBackup) {
    return backupModel();
  }
  // If the requested model matches the primary, it's subject to fallback; otherwise use as-is.
  return requestedModel === primaryModel() ? requestedModel : requestedModel;
}

/** Record a model failure. After threshold consecutive failures, switch to backup. */
export function recordModelFailure(): void {
  consecutiveModelFailures += 1;
  if (consecutiveModelFailures >= modelFailureThreshold() && !usingBackup) {
    usingBackup = true;
    console.warn(
      `[Saturn] Primary model failed ${String(consecutiveModelFailures)} times consecutively. ` +
      `Switching to backup model (${backupModel()}) until restart.`
    );
  }
}

/** Record a model success. Resets the failure counter (but does NOT switch back from backup). */
export function recordModelSuccess(): void {
  consecutiveModelFailures = 0;
}

/** Check whether the agents are currently using the backup model. */
export function isUsingBackupModel(): boolean {
  return usingBackup;
}

/** Get current failure count (for diagnostics/dashboard). */
export function getConsecutiveModelFailures(): number {
  return consecutiveModelFailures;
}

/** Snapshot of the model-fallback state for the dashboard's header badge. */
export function getModelStatus(): {
  readonly usingBackup: boolean;
  readonly consecutiveFailures: number;
  readonly activeModel: string;
  readonly primaryModel: string;
  readonly backupModel: string;
} {
  return {
    usingBackup,
    consecutiveFailures: consecutiveModelFailures,
    activeModel: usingBackup ? backupModel() : primaryModel(),
    primaryModel: primaryModel(),
    backupModel: backupModel()
  };
}

const ADO_MCP_SERVER_NAME = 'azure-devops';

// The reviewer may read and search the entire repo with ANY tool, but must never change anything. We
// auto-approve all tools (so the headless run never blocks on a permission prompt) and then deny every
// path that could modify files or git/branch/PR state. Denying a tool that does not exist in a given
// CLI build is a harmless no-op, so this list is deliberately broad across naming variants.
const DENIED_MUTATING_TOOLS: readonly string[] = [
  // Built-in mutating tools (across Copilot CLI / SDK naming variants).
  'write',
  'write_bash',
  'edit',
  'apply_patch',
  'create',
  'delete',
  'move',
  'rename',
  'commit',
  'publish',
  'deploy',
  // git commands that change files, history, branches, or remotes (read-only git is still allowed).
  'shell(git push)',
  'shell(git commit)',
  'shell(git reset)',
  'shell(git checkout)',
  'shell(git switch)',
  'shell(git restore)',
  'shell(git merge)',
  'shell(git rebase)',
  'shell(git apply)',
  'shell(git am)',
  'shell(git cherry-pick)',
  'shell(git revert)',
  'shell(git stash)',
  'shell(git rm)',
  'shell(git mv)',
  'shell(git clean)',
  'shell(git tag)',
  'shell(git branch)',
  'shell(git remote)',
  'shell(git config)',
  'shell(git update-ref)',
  'shell(git worktree)',
  'shell(git gc)',
  // gh can comment, merge, push, and edit PRs - block it entirely (the bot posts via REST itself).
  'shell(gh)',
  // Destructive or write-capable filesystem and package commands.
  'shell(rm)',
  'shell(rmdir)',
  'shell(del)',
  'shell(erase)',
  'shell(mv)',
  'shell(move)',
  'shell(ren)',
  'shell(rename)',
  'shell(chmod)',
  'shell(chown)',
  'shell(attrib)',
  'shell(npm)',
  'shell(yarn)',
  'shell(pnpm)',
  'shell(npx)'
];

// Code Autopilot EDITS files, so the file-write tools (write/edit/create/apply_patch) are ALLOWED. But
// Saturn - not the model - owns every git, PR, package-manager, and destructive operation, so those stay
// denied. The model only changes file contents inside its isolated fix clone.
const FIX_DENIED_TOOLS: readonly string[] = [
  'write_bash',
  'delete',
  'move',
  'rename',
  'commit',
  'publish',
  'deploy',
  'shell(git push)',
  'shell(git commit)',
  'shell(git reset)',
  'shell(git checkout)',
  'shell(git switch)',
  'shell(git restore)',
  'shell(git merge)',
  'shell(git rebase)',
  'shell(git apply)',
  'shell(git am)',
  'shell(git cherry-pick)',
  'shell(git revert)',
  'shell(git stash)',
  'shell(git rm)',
  'shell(git mv)',
  'shell(git clean)',
  'shell(git tag)',
  'shell(git branch)',
  'shell(git remote)',
  'shell(git config)',
  'shell(git update-ref)',
  'shell(git worktree)',
  'shell(git gc)',
  'shell(gh)',
  'shell(rm)',
  'shell(rmdir)',
  'shell(del)',
  'shell(erase)',
  'shell(chmod)',
  'shell(chown)',
  'shell(attrib)',
  'shell(npm)',
  'shell(yarn)',
  'shell(pnpm)',
  'shell(npx)'
];

function fileExists(candidate: string): boolean {
  return candidate !== '' && existsSync(candidate) && statSync(candidate).isFile();
}

// Launcher file names to look for, most-preferred first, per platform. On Windows the CLI ships
// `copilot.ps1` / `copilot.bat`; on POSIX it is an extensionless `copilot` shim.
function copilotBinaryNames(): readonly string[] {
  return process.platform === 'win32'
    ? ['copilot.ps1', 'copilot.bat', 'copilot.cmd', 'copilot.exe']
    : ['copilot', 'copilot.exe'];
}

function copilotSearchDirectories(): readonly string[] {
  const home = os.homedir();
  const directories: string[] = [];

  const versionedRoot = path.join(home, '.copilot-cli');
  if (existsSync(versionedRoot)) {
    const versions = readdirSync(versionedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }));
    for (const version of versions) {
      directories.push(path.join(versionedRoot, version));
    }
  }

  const appDataRoot = process.env.APPDATA;
  const globalStorageRoots = [
    appDataRoot !== undefined ? path.join(appDataRoot, 'Code', 'User', 'globalStorage') : undefined,
    path.join(home, '.config', 'Code', 'User', 'globalStorage'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
    path.join(home, '.vscode-remote', 'data', 'User', 'globalStorage'),
    path.join(home, '.vscode-server', 'data', 'User', 'globalStorage')
  ];
  for (const root of globalStorageRoots) {
    if (root !== undefined) {
      directories.push(path.join(root, 'github.copilot-chat', 'copilotCli'));
    }
  }

  return directories;
}

function resolveFromKnownLocations(): string | undefined {
  const configured = process.env.COPILOT_CLI_PATH ?? process.env.GITHUB_COPILOT_CLI_PATH;
  if (configured !== undefined && fileExists(configured)) {
    return configured;
  }

  for (const directory of copilotSearchDirectories()) {
    for (const binaryName of copilotBinaryNames()) {
      const candidate = path.join(directory, binaryName);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function resolveNpmGlobalCopilotEntry(): string | undefined {
  const rootResult =
    process.platform === 'win32'
      ? runCommand('cmd.exe', ['/c', 'npm', 'root', '-g'], { timeoutMs: 30_000 })
      : runCommand('npm', ['root', '-g'], { timeoutMs: 30_000 });
  if (rootResult.status !== 0) {
    return undefined;
  }

  const globalRoot = rootResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (globalRoot === undefined) {
    return undefined;
  }

  const packageDir = path.join(globalRoot, '@github', 'copilot');
  if (!fileExists(path.join(packageDir, 'package.json'))) {
    return undefined;
  }

  let binRelative: string | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const binValue = isRecord(parsed) ? parsed['bin'] : undefined;
    if (typeof binValue === 'string') {
      binRelative = binValue;
    } else if (isRecord(binValue) && typeof binValue['copilot'] === 'string') {
      binRelative = binValue['copilot'];
    }
  } catch {
    return undefined;
  }

  if (binRelative === undefined) {
    return undefined;
  }

  const entryPath = path.join(packageDir, binRelative);
  return fileExists(entryPath) ? entryPath : undefined;
}

/** Locate the GitHub Copilot CLI launcher, or return `undefined` if it cannot be found. */
export function resolveCopilotCli(): string | undefined {
  // Prefer the real npm-global JS entry so we can run it directly via `node` - this avoids the
  // PowerShell/.cmd shims, which mis-parse a multi-line `--prompt` argument on Windows.
  const npmGlobalEntry = resolveNpmGlobalCopilotEntry();
  if (npmGlobalEntry !== undefined) {
    return npmGlobalEntry;
  }

  const known = resolveFromKnownLocations();
  if (known !== undefined) {
    return known;
  }

  const finder =
    process.platform === 'win32' ? runCommand('where', ['copilot']) : runCommand('sh', ['-c', 'command -v copilot']);
  if (finder.status !== 0) {
    return undefined;
  }

  const lines = finder.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (process.platform === 'win32') {
    return lines.find((line) => /\.(ps1|bat|cmd|exe)$/i.test(line)) ?? lines[0];
  }

  return lines[0];
}

function resolveCopilotHome(copilotHome: string | undefined): string {
  return copilotHome ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
}

/**
 * Ensure the Azure DevOps MCP server is registered in the Copilot CLI's `mcp-config.json`, adding it
 * non-destructively if absent (existing servers and the user's login are preserved). Returns the
 * server name to pass to `--allow-tool`, or `undefined` if the config could not be read/written.
 */
export function ensureAdoMcpServer(copilotHome: string | undefined): string | undefined {
  const home = resolveCopilotHome(copilotHome);
  const configPath = path.join(home, 'mcp-config.json');

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
      if (isRecord(parsed)) {
        config = parsed;
      }
    } catch {
      return undefined;
    }
  }

  const existingServers = config['mcpServers'];
  const servers: Record<string, unknown> = isRecord(existingServers) ? existingServers : {};
  if (!isRecord(servers[ADO_MCP_SERVER_NAME])) {
    servers[ADO_MCP_SERVER_NAME] = {
      type: 'local',
      command: 'npx',
      args: ['-y', '@azure-devops/mcp', AZURE_DEVOPS_CONFIG.organization],
      tools: ['*']
    };
    config['mcpServers'] = servers;
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    } catch {
      return undefined;
    }
  }

  return ADO_MCP_SERVER_NAME;
}

/** Options for a single headless Copilot review invocation. */
export interface RunCopilotReviewOptions {
  readonly cliPath: string;
  readonly prompt: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly allowMcpServerName?: string;
  /** When 'json', run the CLI with --output-format json --stream on (JSONL event stream for live CoT). */
  readonly outputFormat?: 'text' | 'json';
  /** Called with each raw CLI output chunk as it arrives, for live progress / chain-of-thought streaming. */
  readonly onProgress?: (chunk: string) => void;
}

// Choose how to spawn the launcher: PowerShell scripts go through `powershell -File` (so multi-line
// prompt args are passed safely without shell quoting), .cmd/.bat need a shell, and a plain
// executable is spawned directly.
function buildInvocation(
  cliPath: string,
  args: readonly string[]
): { readonly command: string; readonly args: readonly string[]; readonly shell: boolean } {
  if (/\.[cm]?js$/i.test(cliPath)) {
    // Run the CLI's JS entry directly via node - the most robust way to pass a multi-line prompt arg.
    return { command: 'node', args: [cliPath, ...args], shell: false };
  }

  if (/\.ps1$/i.test(cliPath)) {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cliPath, ...args],
      shell: false
    };
  }

  if (/\.(cmd|bat)$/i.test(cliPath)) {
    return { command: cliPath, args, shell: true };
  }

  return { command: cliPath, args, shell: false };
}

/**
 * Run the Copilot CLI headlessly (`--prompt`) for one pull request and return the raw process result.
 * The model's structured JSON answer is parsed from stdout by the caller. Runs asynchronously so the
 * (often multi-minute) review never blocks the Node event loop / the always-on dashboard.
 */
export async function runCopilotReview(options: RunCopilotReviewOptions): Promise<RunCommandResult> {
  return runCopilotWithDeniedTools(options, DENIED_MUTATING_TOOLS);
}

/**
 * Run the Copilot CLI headlessly with file-editing ALLOWED (used by Code Autopilot). The model may read,
 * search, and modify files in its working directory, but git, gh, package-manager, and destructive shell
 * commands stay denied - Saturn (not the model) owns all git/PR operations.
 */
export async function runCopilotEdit(options: RunCopilotReviewOptions): Promise<RunCommandResult> {
  return runCopilotWithDeniedTools(options, FIX_DENIED_TOOLS);
}

async function runCopilotWithDeniedTools(
  options: RunCopilotReviewOptions,
  deniedTools: readonly string[]
): Promise<RunCommandResult> {
  // Windows caps a process command line at ~32K chars, and a full-file review prompt can exceed that
  // (ENAMETOOLONG on spawn). Write the prompt to a temp file in the working directory (inside the
  // agent's allowed workspace) and pass only a short pointer on the command line; the agent reads the
  // file with its read-only tools. The file is removed in `finally`.
  const promptFileName = `.saturn-prompt-${randomBytes(6).toString('hex')}.md`;
  const promptFilePath = path.join(options.cwd, promptFileName);
  writeFileSync(promptFilePath, options.prompt, 'utf8');

  const pointerPrompt = [
    `Your complete instructions for this task are in the file "${promptFileName}" at the root of the current`,
    'repository (your current working directory). Read that file NOW with your file-read tool, then follow its',
    'instructions EXACTLY and respond ONLY in the format it specifies. Do not ask any questions.'
  ].join('\n');

  // Apply the model fallback: if we've hit too many consecutive failures on the primary model, use the backup.
  let effectiveModel = getEffectiveModel(options.model);
  // Some models (e.g. the opus-4.5 backup) reject the --effort flag entirely; when one does we retry without it.
  let includeEffort = true;

  const runWithModel = async (model: string, withEffort: boolean): Promise<RunCommandResult> => {
    const baseArgs = ['--prompt', pointerPrompt, '--model', model];
    if (withEffort) {
      baseArgs.push('--effort', options.reasoningEffort);
    }
    baseArgs.push('--allow-all-tools');
    for (const deniedTool of deniedTools) {
      baseArgs.push(`--deny-tool=${deniedTool}`);
    }

    if (options.allowMcpServerName !== undefined) {
      baseArgs.push(`--allow-tool=${options.allowMcpServerName}`);
    }
    if (options.outputFormat === 'json') {
      // JSONL event stream: emits MCP/tool/turn events + assistant message deltas live (for the CoT UI).
      baseArgs.push('--output-format', 'json', '--stream', 'on');
    }

    const invocation = buildInvocation(options.cliPath, baseArgs);
    const onProgress = options.onProgress;
    return runCommandAsync(invocation.command, invocation.args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      shell: invocation.shell,
      ...(onProgress !== undefined ? { onOutput: (chunk: string) => { onProgress(chunk); } } : {})
    });
  };

  // A non-zero run whose output mentions `needle` (used to detect the CLI's model/effort capability errors).
  const mentions = (run: RunCommandResult, needle: string): boolean =>
    run.status !== 0 && (run.stderr.includes(needle) || run.stdout.includes(needle));

  try {
    let result = await runWithModel(effectiveModel, includeEffort);

    // 1) Primary model not available -> switch to the backup model immediately and retry ONCE.
    if (mentions(result, 'not available') && !usingBackup) {
      console.warn(
        `[Saturn] Model "${effectiveModel}" not available. Switching to backup model (${backupModel()}) and retrying.`
      );
      usingBackup = true;
      consecutiveModelFailures = modelFailureThreshold(); // Mark as if threshold hit
      effectiveModel = backupModel();
      result = await runWithModel(effectiveModel, includeEffort);
    }

    // 2) The effective model rejects reasoning-effort configuration -> retry the SAME model without --effort.
    //    The opus-4.5 backup has a fixed reasoning level and errors when --effort is passed.
    if (mentions(result, 'does not support reasoning effort')) {
      console.warn(`[Saturn] Model "${effectiveModel}" does not support --effort; retrying without it.`);
      includeEffort = false;
      result = await runWithModel(effectiveModel, includeEffort);
    }

    // Track model success/failure for fallback logic.
    if (result.status === 0) {
      recordModelSuccess();
    } else {
      recordModelFailure();
    }

    return result;
  } finally {
    try {
      unlinkSync(promptFilePath);
    } catch {
      /* best-effort cleanup of the temp prompt file */
    }
  }
}
