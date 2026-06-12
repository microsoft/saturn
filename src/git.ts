import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AZURE_DEVOPS_CONFIG } from "./config";
import { describeError, runCommandAsync, type Logger } from "./util";

function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  // Never let git block on an interactive credential or host prompt - this runs headless.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GCM_INTERACTIVE"] = "never";
  return env;
}

/** Default location for the bot's own dedicated clone of office-bohemia (co-located under the Saturn deploy root). */
export function defaultManagedCloneDir(): string {
  const override = process.env.SATURN_CLONE_DIR;
  if (override !== undefined && override.trim() !== "") {
    return override;
  }

  const base =
    process.platform === "win32"
      ? path.join("C:\\", "saturn", "repo")
      : path.join(os.homedir(), "saturn", "repo");
  return path.join(base, AZURE_DEVOPS_CONFIG.repositoryName);
}

function repoCloneUrl(): string {
  const override = process.env.SATURN_CLONE_URL ?? process.env.SATURN_REPO_URL;
  if (override !== undefined && override.trim() !== "") {
    return override.trim();
  }

  const { host, organization, project, repositoryName } = AZURE_DEVOPS_CONFIG;
  return `https://${host}/${organization}/${project}/_git/${repositoryName}`;
}

/**
 * Refresh a checkout's view of master before reviewing, so the agent reasons against current code.
 * Always fetches `origin/master`, and additionally fast-forwards the current branch when possible. It
 * never creates a merge commit and never disturbs a feature branch beyond a safe fast-forward.
 */
export async function updateRepoFromMaster(
  repoRoot: string,
  logger: Logger,
): Promise<void> {
  const env = nonInteractiveGitEnv();
  const branch = AZURE_DEVOPS_CONFIG.defaultBranch;
  const fetchResult = await runCommandAsync(
    "git",
    ["-C", repoRoot, "fetch", "origin", branch],
    {
      env,
      timeoutMs: 300_000,
    },
  );
  if (fetchResult.status !== 0) {
    const reason = fetchResult.stderr.trim();
    logger.warn(
      `Could not fetch origin/${branch} (${reason === "" ? "unknown error" : reason}); continuing.`,
    );
    return;
  }

  logger.info(`Updated origin/${branch} for review context.`);

  const pullResult = await runCommandAsync(
    "git",
    ["-C", repoRoot, "pull", "--ff-only", "origin", branch],
    {
      env,
      timeoutMs: 300_000,
    },
  );
  if (pullResult.status === 0) {
    logger.info(`Fast-forwarded the current branch to origin/${branch}.`);
  } else {
    logger.info(
      `Current branch was not fast-forwarded (feature branch or diverged); using fetched origin/${branch}.`,
    );
  }
}

/**
 * Ensure a dedicated clone of office-bohemia exists at `cloneDir` and return its path. Running against
 * a dedicated clone (default `C:\saturn\repo\office-bohemia`) lets the bot run from anywhere without
 * touching your working repo. The clone's view of master is only refreshed when `updateMaster` is true,
 * so steady-state review cycles reuse the existing checkout instead of fetching every run.
 */
export async function ensureManagedClone(
  cloneDir: string | undefined,
  logger: Logger,
  updateMaster: boolean,
): Promise<string> {
  const targetDir = cloneDir ?? defaultManagedCloneDir();
  const env = nonInteractiveGitEnv();

  if (!existsSync(path.join(targetDir, ".git"))) {
    logger.info(
      `Cloning ${AZURE_DEVOPS_CONFIG.repositoryName} into ${targetDir} (first run can take several minutes)...`,
    );
    mkdirSync(path.dirname(targetDir), { recursive: true });
    const cloneResult = await runCommandAsync(
      "git",
      ["clone", repoCloneUrl(), targetDir],
      {
        env,
        timeoutMs: 1_800_000,
      },
    );
    if (cloneResult.status !== 0) {
      throw new Error(
        `Failed to clone office-bohemia into ${targetDir}: ${cloneResult.stderr.trim() || "unknown error"}`,
      );
    }

    logger.info("Clone complete.");
    // A fresh clone already reflects current master, so no extra fetch is needed.
    return targetDir;
  }

  if (updateMaster) {
    logger.info(
      `Using managed clone at ${targetDir}; refreshing ${AZURE_DEVOPS_CONFIG.defaultBranch}.`,
    );
    // The bot never commits in this clone, so forcing it back onto the default branch before updating is safe.
    await runCommandAsync(
      "git",
      ["-C", targetDir, "checkout", AZURE_DEVOPS_CONFIG.defaultBranch],
      {
        env,
        timeoutMs: 120_000,
      },
    );
    await updateRepoFromMaster(targetDir, logger);
  } else {
    logger.info(
      `Using managed clone at ${targetDir} (reusing existing checkout; pass --update to refresh master).`,
    );
  }

  return targetDir;
}

/** Install dependencies in the clone (best-effort) so the agent can resolve types and imports. */
export async function installRepoDependencies(
  repoRoot: string,
  logger: Logger,
): Promise<void> {
  logger.info(
    "Installing dependencies (corepack yarn install) for richer review context - this can take a while...",
  );
  const result =
    process.platform === "win32"
      ? await runCommandAsync(
          "cmd.exe",
          ["/c", "corepack", "yarn", "install"],
          { cwd: repoRoot, timeoutMs: 1_800_000 },
        )
      : await runCommandAsync("sh", ["-c", "corepack yarn install"], {
          cwd: repoRoot,
          timeoutMs: 1_800_000,
        });
  if (result.status === 0) {
    logger.info("Dependencies installed.");
  } else {
    logger.warn(
      `Dependency install exited with code ${String(result.status)}; continuing without fresh node_modules.`,
    );
  }
}

/**
 * Kick off `corepack yarn install` in the clone in the BACKGROUND and return immediately, so the
 * review loop never blocks on it. node_modules simply becomes available for subsequent reviews once
 * the install finishes. No-ops if the clone does not exist yet.
 */
export function installRepoDependenciesInBackground(
  repoRoot: string,
  logger: Logger,
): void {
  if (!existsSync(path.join(repoRoot, ".git"))) {
    return;
  }

  logger.info(
    "Saturn: starting background dependency install (corepack yarn install); reviews continue meanwhile...",
  );
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", "corepack", "yarn", "install"], {
          cwd: repoRoot,
          stdio: "ignore",
          windowsHide: true,
        })
      : spawn("sh", ["-c", "corepack yarn install"], {
          cwd: repoRoot,
          stdio: "ignore",
        });

  child.on("exit", (code) => {
    if (code === 0) {
      logger.info("Saturn: background dependency install complete.");
    } else {
      logger.warn(
        `Saturn: background dependency install exited with code ${String(code ?? -1)}.`,
      );
    }
  });
  child.on("error", (error) => {
    logger.warn(
      `Saturn: background dependency install failed to start: ${describeError(error)}`,
    );
  });

  // Do not let this background child keep the process alive on its own.
  child.unref();
}
