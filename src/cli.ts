import type { SaturnOptions } from "./runSaturn";
import { runCommand } from "./util";

const DEFAULT_MODEL = "claude-opus-4.8";
const DEFAULT_REASONING_EFFORT = "high";
const BOOLEAN_FLAG_NAMES = new Set([
  "post",
  "list-only",
  "with-ado-mcp",
  "force",
  "update",
  "managed-clone",
  "no-managed-clone",
  "install-deps",
]);

/** Help text printed for `--help`. */
export const CLI_HELP_TEXT: string = `saturn - automated reviewer for active office-bohemia pull requests

USAGE
  saturn [options]

By default the bot runs in DRY-RUN mode and posts nothing. Pass --post to publish comments.

OPTIONS
  --post                 Actually post comments (default: dry-run, prints only).
  --list-only            List the active non-draft PRs and exit (no model calls).
  --pr <id>              Review only this pull request id.
  --max-reviews <n>      Max PRs to actually review per run (default: 25).
  --scan-limit <n>       Max active PRs to fetch and scan (default: 100).
  --max-comments <n>     Max inline comments per PR (default: 10).
  --max-files <n>        Max changed files to send to the model per PR (default: 20).
  --max-file-lines <n>   Max lines per file included in the prompt (default: 1500).
  --max-prompt-bytes <n> Max diff-context bytes per PR (default: 24000 on Windows, else 200000).
  --model <name>         Copilot model to use (default: ${DEFAULT_MODEL}).
  --effort <level>       Reasoning effort: low | medium | high | xhigh (default: ${DEFAULT_REASONING_EFFORT}).
  --on-behalf-of <name>  Name shown in the bot disclaimer (default: git user.email).
  --with-ado-mcp         Register and allow the Azure DevOps MCP server for extra context.
  --force                Re-review PRs even if the bot already commented.
  --update               Refresh the managed clone's master (git fetch + ff-only) before reviewing (default: reuse existing checkout).
  --timeout-ms <n>       Per-PR model timeout in ms (default: 900000).
  --repo-root <path>     office-bohemia checkout to use (default: current git repo root).
  --managed-clone        Use a dedicated clone (auto-on when run outside the repo).
  --no-managed-clone     Always use the current directory's repo instead of a managed clone.
  --clone-dir <path>     Managed clone location (default: C:\\saturn\\repo\\office-bohemia on Windows).
  --install-deps         Run "corepack yarn install" in the clone for richer type context.
  -h, --help             Show this help.`;

function gitOutput(
  repoRoot: string | undefined,
  args: readonly string[],
): string | undefined {
  const baseArgs =
    repoRoot === undefined ? [...args] : ["-C", repoRoot, ...args];
  const result = runCommand("git", baseArgs);
  if (result.status !== 0) {
    return undefined;
  }

  const value = result.stdout.trim();
  return value === "" ? undefined : value;
}

function resolveDefaultRepoRoot(): string {
  return (
    gitOutput(undefined, ["rev-parse", "--show-toplevel"]) ?? process.cwd()
  );
}

function resolveDefaultOnBehalfOf(): string {
  return (
    gitOutput(undefined, ["config", "user.email"]) ?? "the repository owner"
  );
}

function isInsideOfficeBohemiaRepo(directory: string): boolean {
  if (gitOutput(directory, ["rev-parse", "--show-toplevel"]) === undefined) {
    return false;
  }

  const originUrl = gitOutput(directory, ["remote", "get-url", "origin"]);
  return originUrl?.includes("office-bohemia") === true;
}

function resolveDefaultMaxPromptBytes(): number {
  return process.platform === "win32" ? 24_000 : 200_000;
}

function readIntFlag(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = values.get(name);
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value for --${name}: "${raw}"`);
  }

  return parsed;
}

/**
 * Parse process arguments into {@link SaturnOptions}. Returns `undefined` to signal that help
 * was requested (the caller prints {@link CLI_HELP_TEXT}).
 */
export function parseCliOptions(
  argv: readonly string[],
): SaturnOptions | undefined {
  const booleanFlags = new Set<string>();
  const valueFlags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      return undefined;
    }

    if (!token.startsWith("--")) {
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      valueFlags.set(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }

    const name = token.slice(2);
    if (BOOLEAN_FLAG_NAMES.has(name)) {
      booleanFlags.add(name);
      continue;
    }

    const next = argv.at(index + 1);
    if (next !== undefined && !next.startsWith("--")) {
      valueFlags.set(name, next);
      index += 1;
    } else {
      booleanFlags.add(name);
    }
  }

  const repoRoot = valueFlags.get("repo-root") ?? resolveDefaultRepoRoot();
  const specificPullRequestId = valueFlags.has("pr")
    ? readIntFlag(valueFlags, "pr", 0)
    : undefined;
  const managedClone =
    booleanFlags.has("managed-clone") ||
    (!booleanFlags.has("no-managed-clone") &&
      !isInsideOfficeBohemiaRepo(repoRoot));

  return {
    repoRoot,
    post: booleanFlags.has("post"),
    listOnly: booleanFlags.has("list-only"),
    maxReviews: readIntFlag(valueFlags, "max-reviews", 25),
    scanLimit: readIntFlag(valueFlags, "scan-limit", 100),
    maxComments: readIntFlag(valueFlags, "max-comments", 10),
    maxFiles: readIntFlag(valueFlags, "max-files", 20),
    maxFileLines: readIntFlag(valueFlags, "max-file-lines", 1500),
    maxPromptBytes: readIntFlag(
      valueFlags,
      "max-prompt-bytes",
      resolveDefaultMaxPromptBytes(),
    ),
    model: valueFlags.get("model") ?? DEFAULT_MODEL,
    reasoningEffort: valueFlags.get("effort") ?? DEFAULT_REASONING_EFFORT,
    onBehalfOf: valueFlags.get("on-behalf-of") ?? resolveDefaultOnBehalfOf(),
    withAdoMcp: booleanFlags.has("with-ado-mcp"),
    force: booleanFlags.has("force"),
    updateMaster: booleanFlags.has("update"),
    managedClone,
    cloneDir: valueFlags.get("clone-dir"),
    installDeps: booleanFlags.has("install-deps"),
    specificPullRequestId,
    reviewTimeoutMs: readIntFlag(valueFlags, "timeout-ms", 900_000),
  };
}
