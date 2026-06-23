// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AZURE_DEVOPS_CONFIG } from './config';
import { describeError, runCommandAsync, type Logger } from './util';

function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  // Never let git block on an interactive credential or host prompt - this runs headless.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GCM_INTERACTIVE'] = 'never';
  return env;
}

/** Default location for the bot's own dedicated clone of the target repo (co-located under the Saturn deploy root). */
export function defaultManagedCloneDir(): string {
  const override = process.env.SATURN_CLONE_DIR;
  if (override !== undefined && override.trim() !== '') {
    return override;
  }

  const base =
    process.platform === 'win32' ? path.join('C:\\', 'saturn', 'repo') : path.join(os.homedir(), 'saturn', 'repo');
  return path.join(base, AZURE_DEVOPS_CONFIG.repositoryName);
}

function repoCloneUrl(): string {
  const explicit = process.env.SATURN_CLONE_URL ?? process.env.SATURN_REPO_URL;
  if (explicit !== undefined && explicit.trim() !== '') {
    return explicit.trim();
  }
  const { host, organization, project, repositoryName } = AZURE_DEVOPS_CONFIG;
  return `https://${host}/${organization}/${project}/_git/${repositoryName}`;
}

/**
 * Refresh a checkout's view of master before reviewing, so the agent reasons against current code.
 * Always fetches `origin/master`, and additionally fast-forwards the current branch when possible. It
 * never creates a merge commit and never disturbs a feature branch beyond a safe fast-forward.
 */
export async function updateRepoFromMaster(repoRoot: string, logger: Logger): Promise<void> {
  const env = nonInteractiveGitEnv();
  const branch = AZURE_DEVOPS_CONFIG.defaultBranch;
  const fetchResult = await runCommandAsync('git', ['-C', repoRoot, 'fetch', 'origin', branch], {
    env,
    timeoutMs: 300_000
  });
  if (fetchResult.status !== 0) {
    const reason = fetchResult.stderr.trim();
    logger.warn(`Could not fetch origin/${branch} (${reason === '' ? 'unknown error' : reason}); continuing.`);
    return;
  }

  logger.info(`Updated origin/${branch} for review context.`);

  const pullResult = await runCommandAsync('git', ['-C', repoRoot, 'pull', '--ff-only', 'origin', branch], {
    env,
    timeoutMs: 300_000
  });
  if (pullResult.status === 0) {
    logger.info(`Fast-forwarded the current branch to origin/${branch}.`);
  } else {
    logger.info(`Current branch was not fast-forwarded (feature branch or diverged); using fetched origin/${branch}.`);
  }
}

/**
 * Ensure a dedicated clone of the target repo exists at `cloneDir` and return its path. Running against
 * a dedicated clone (default `C:\saturn\repo\<repo>`) lets the bot run from anywhere without
 * touching your working repo. The clone's view of master is only refreshed when `updateMaster` is true,
 * so steady-state review cycles reuse the existing checkout instead of fetching every run.
 */
export async function ensureManagedClone(
  cloneDir: string | undefined,
  logger: Logger,
  updateMaster: boolean
): Promise<string> {
  const targetDir = cloneDir ?? defaultManagedCloneDir();
  const env = nonInteractiveGitEnv();

  if (!existsSync(path.join(targetDir, '.git'))) {
    logger.info(
      `Cloning ${AZURE_DEVOPS_CONFIG.repositoryName} into ${targetDir} (first run can take several minutes)...`
    );
    mkdirSync(path.dirname(targetDir), { recursive: true });
    const cloneResult = await runCommandAsync('git', ['clone', repoCloneUrl(), targetDir], {
      env,
      timeoutMs: 1_800_000
    });
    if (cloneResult.status !== 0) {
      throw new Error(
        `Failed to clone ${AZURE_DEVOPS_CONFIG.repositoryName} into ${targetDir}: ${cloneResult.stderr.trim() || 'unknown error'}`
      );
    }

    logger.info('Clone complete.');
    // A fresh clone already reflects current master, so no extra fetch is needed.
    return targetDir;
  }

  if (updateMaster) {
    logger.info(`Using managed clone at ${targetDir}; refreshing ${AZURE_DEVOPS_CONFIG.defaultBranch}.`);
    // The bot never commits in this clone, so forcing it back onto the default branch before updating is safe.
    await runCommandAsync('git', ['-C', targetDir, 'checkout', AZURE_DEVOPS_CONFIG.defaultBranch], {
      env,
      timeoutMs: 120_000
    });
    await updateRepoFromMaster(targetDir, logger);
  } else {
    logger.info(`Using managed clone at ${targetDir} (reusing existing checkout; pass --update to refresh master).`);
  }

  return targetDir;
}

/** Install dependencies in the clone (best-effort) so the agent can resolve types and imports. */
export async function installRepoDependencies(repoRoot: string, logger: Logger): Promise<void> {
  logger.info('Installing dependencies (corepack yarn install) for richer review context - this can take a while...');
  const result =
    process.platform === 'win32'
      ? await runCommandAsync('cmd.exe', ['/c', 'corepack', 'yarn', 'install'], { cwd: repoRoot, timeoutMs: 1_800_000 })
      : await runCommandAsync('sh', ['-c', 'corepack yarn install'], { cwd: repoRoot, timeoutMs: 1_800_000 });
  if (result.status === 0) {
    logger.info('Dependencies installed.');
  } else {
    logger.warn(`Dependency install exited with code ${String(result.status)}; continuing without fresh node_modules.`);
  }
}

/**
 * Kick off `corepack yarn install` in the clone in the BACKGROUND and return immediately, so the
 * review loop never blocks on it. node_modules simply becomes available for subsequent reviews once
 * the install finishes. No-ops if the clone does not exist yet.
 */
export function installRepoDependenciesInBackground(repoRoot: string, logger: Logger): void {
  if (!existsSync(path.join(repoRoot, '.git'))) {
    return;
  }

  logger.info('Saturn: starting background dependency install (corepack yarn install); reviews continue meanwhile...');
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'corepack', 'yarn', 'install'], { cwd: repoRoot, stdio: 'ignore', windowsHide: true })
      : spawn('sh', ['-c', 'corepack yarn install'], { cwd: repoRoot, stdio: 'ignore' });

  child.on('exit', (code) => {
    if (code === 0) {
      logger.info('Saturn: background dependency install complete.');
    } else {
      logger.warn(`Saturn: background dependency install exited with code ${String(code ?? -1)}.`);
    }
  });
  child.on('error', (error) => {
    logger.warn(`Saturn: background dependency install failed to start: ${describeError(error)}`);
  });

  // Do not let this background child keep the process alive on its own.
  child.unref();
}

// --- Code Autopilot git operations (writes allowed; isolated to the fix clone) ---------------------------

/**
 * Default location for Code Autopilot's own clone, kept separate from the read-only review/audit clone so
 * the heavy editing Code Autopilot does never disturbs the other two agents. Override SATURN_FIX_CLONE_DIR.
 */
export function defaultFixCloneDir(): string {
  const override = process.env.SATURN_FIX_CLONE_DIR;
  if (override !== undefined && override.trim() !== '') {
    return override.trim();
  }
  const base =
    process.platform === 'win32'
      ? path.join('C:\\', 'saturn', 'fix-repo')
      : path.join(os.homedir(), 'saturn', 'fix-repo');
  return path.join(base, AZURE_DEVOPS_CONFIG.repositoryName);
}

/**
 * Ensure Code Autopilot's dedicated clone exists and its default branch is current. A fresh clone is
 * SHALLOW + single-branch, so even a very large repo clones quickly - the agent only ever needs the tip of
 * the default branch plus a feature branch off it, never deep history.
 */
export async function ensureFixClone(logger: Logger): Promise<string> {
  const targetDir = defaultFixCloneDir();
  const env = nonInteractiveGitEnv();
  if (existsSync(path.join(targetDir, '.git'))) {
    await runCommandAsync('git', ['-C', targetDir, 'checkout', AZURE_DEVOPS_CONFIG.defaultBranch], {
      env,
      timeoutMs: 120_000
    });
    await updateRepoFromMaster(targetDir, logger);
    return targetDir;
  }
  logger.info(`Code Autopilot: cloning ${AZURE_DEVOPS_CONFIG.repositoryName} (shallow) into ${targetDir}...`);
  mkdirSync(path.dirname(targetDir), { recursive: true });
  const result = await runCommandAsync(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      AZURE_DEVOPS_CONFIG.defaultBranch,
      repoCloneUrl(),
      targetDir
    ],
    { env, timeoutMs: 1_800_000 }
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to clone ${AZURE_DEVOPS_CONFIG.repositoryName} into ${targetDir}: ${result.stderr.trim() || 'unknown error'}`
    );
  }
  logger.info('Code Autopilot: clone complete.');
  return targetDir;
}

/** Discard working-tree changes + return the clone to a clean, up-to-date default branch. */
export async function resetFixCloneToDefault(repoRoot: string, logger: Logger): Promise<void> {
  const env = nonInteractiveGitEnv();
  const branch = AZURE_DEVOPS_CONFIG.defaultBranch;
  await runCommandAsync('git', ['-C', repoRoot, 'reset', '--hard'], { env, timeoutMs: 120_000 });
  await runCommandAsync('git', ['-C', repoRoot, 'clean', '-fd'], { env, timeoutMs: 120_000 });
  await runCommandAsync('git', ['-C', repoRoot, 'checkout', branch], { env, timeoutMs: 120_000 });
  await updateRepoFromMaster(repoRoot, logger);
}

/** Create (or reset) a fix branch off the latest origin/<default>, leaving the clone checked out on it. */
export async function createFixBranch(repoRoot: string, branch: string, logger: Logger): Promise<void> {
  const env = nonInteractiveGitEnv();
  const defaultBranch = AZURE_DEVOPS_CONFIG.defaultBranch;
  await resetFixCloneToDefault(repoRoot, logger);
  const fetchResult = await runCommandAsync('git', ['-C', repoRoot, 'fetch', '--depth', '1', 'origin', defaultBranch], {
    env,
    timeoutMs: 300_000
  });
  if (fetchResult.status !== 0) {
    throw new Error(`Could not fetch origin/${defaultBranch}: ${fetchResult.stderr.trim() || 'unknown error'}`);
  }
  const result = await runCommandAsync('git', ['-C', repoRoot, 'checkout', '-B', branch, `origin/${defaultBranch}`], {
    env,
    timeoutMs: 120_000
  });
  if (result.status !== 0) {
    throw new Error(`Could not create branch ${branch}: ${result.stderr.trim() || 'unknown error'}`);
  }
}

/** Stage everything + commit. Returns true if a commit was made, false when there was nothing to commit. */
export async function commitAllChanges(repoRoot: string, message: string, logger: Logger): Promise<boolean> {
  const env = nonInteractiveGitEnv();
  await runCommandAsync('git', ['-C', repoRoot, 'add', '-A'], { env, timeoutMs: 120_000 });
  const status = await runCommandAsync('git', ['-C', repoRoot, 'status', '--porcelain'], { env, timeoutMs: 60_000 });
  if (status.stdout.trim() === '') {
    logger.info('Code Autopilot: nothing to commit (the model made no file changes).');
    return false;
  }
  const commit = await runCommandAsync(
    'git',
    [
      '-C',
      repoRoot,
      '-c',
      'user.name=Code Autopilot',
      '-c',
      'user.email=saturn-fix@users.noreply.localhost',
      'commit',
      '-m',
      message
    ],
    { env, timeoutMs: 120_000 }
  );
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim() || 'unknown error'}`);
  }
  return true;
}

/** Push the branch to origin using an Azure DevOps auth header, so the headless push never prompts. */
export async function pushFixBranch(
  repoRoot: string,
  branch: string,
  authHeader: string,
  logger: Logger,
  force = false
): Promise<void> {
  const env = nonInteractiveGitEnv();
  const args = [
    '-c',
    `http.extraheader=Authorization: ${authHeader}`,
    '-C',
    repoRoot,
    'push',
    ...(force ? ['--force-with-lease'] : []),
    '-u',
    'origin',
    branch
  ];
  const result = await runCommandAsync('git', args, { env, timeoutMs: 300_000 });
  if (result.status !== 0) {
    throw new Error(`git push failed for ${branch}: ${result.stderr.trim() || 'unknown error'}`);
  }
  logger.info(`Code Autopilot: pushed ${branch}.`);
}

/** Delete a local fix branch after its PR merged/abandoned (checks out the default branch first). */
export async function deleteLocalFixBranch(repoRoot: string, branch: string, logger: Logger): Promise<void> {
  const env = nonInteractiveGitEnv();
  await runCommandAsync('git', ['-C', repoRoot, 'checkout', AZURE_DEVOPS_CONFIG.defaultBranch], {
    env,
    timeoutMs: 120_000
  });
  const result = await runCommandAsync('git', ['-C', repoRoot, 'branch', '-D', branch], { env, timeoutMs: 60_000 });
  if (result.status === 0) {
    logger.info(`Code Autopilot: cleaned up local branch ${branch}.`);
  }
}

/** Local branch names under `prefix` in the fix clone (e.g. all `saturn/fix/*` branches), for cleanup sweeps. */
export async function listLocalBranches(repoRoot: string, prefix: string): Promise<readonly string[]> {
  const env = nonInteractiveGitEnv();
  const result = await runCommandAsync(
    'git',
    ['-C', repoRoot, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}/`],
    { env, timeoutMs: 60_000 }
  );
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Repo-relative paths changed on the current branch vs origin/<default> (the fix's footprint). */
export async function changedFilesVsDefault(repoRoot: string): Promise<readonly string[]> {
  const env = nonInteractiveGitEnv();
  const defaultBranch = AZURE_DEVOPS_CONFIG.defaultBranch;
  const result = await runCommandAsync(
    'git',
    ['-C', repoRoot, 'diff', '--name-only', `origin/${defaultBranch}...HEAD`],
    { env, timeoutMs: 60_000 }
  );
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Repo-relative paths with uncommitted working-tree changes (what the model just edited, pre-commit). */
export async function workingTreeChanges(repoRoot: string): Promise<readonly string[]> {
  const env = nonInteractiveGitEnv();
  const result = await runCommandAsync('git', ['-C', repoRoot, 'status', '--porcelain'], { env, timeoutMs: 60_000 });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== '');
}

// Source files ESLint can check (skips JSON / markdown / snapshots etc).
const LINTABLE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * Run ESLint on the given changed files inside the fix clone (flat config auto-discovered from the repo
 * root). Best-effort + bounded; returns ok plus a trimmed error excerpt the model can act on. Used by the
 * optional pre-push validation so PRs start green.
 */
export async function lintChangedFilesInClone(
  repoRoot: string,
  files: readonly string[],
  logger: Logger
): Promise<{ readonly ok: boolean; readonly output: string }> {
  const lintable = files.filter((file) => LINTABLE_FILE.test(file));
  if (lintable.length === 0) {
    return { ok: true, output: '' };
  }
  const eslintBin = path.join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(eslintBin)) {
    logger.info('Code Autopilot: eslint not found in the fix clone; skipping local lint.');
    return { ok: true, output: '' };
  }
  const result = await runCommandAsync('node', [eslintBin, ...lintable], { cwd: repoRoot, timeoutMs: 300_000 });
  if (result.status === 0) {
    return { ok: true, output: '' };
  }
  const output = `${result.stdout}\n${result.stderr}`.trim().slice(-3000);
  return { ok: false, output };
}
