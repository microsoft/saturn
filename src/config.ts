import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = ENV_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
 *   3. `<entry-script dir>/.env` - so a deployed bundle finds its `.env` even when the launcher does not
 *      set a working directory.
 */
function loadEnvFile(): void {
  const candidatePaths: string[] = [];
  const explicitPath = process.env.SATURN_ENV_FILE;
  if (explicitPath !== undefined && explicitPath.trim() !== "") {
    candidatePaths.push(explicitPath.trim());
  }
  candidatePaths.push(join(process.cwd(), ".env"));
  const entryScript = process.argv.at(1);
  if (entryScript !== undefined && entryScript !== "") {
    candidatePaths.push(join(dirname(entryScript), ".env"));
  }
  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }
    const parsed = parseEnvFile(readFileSync(candidatePath, "utf8"));
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
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Saturn configuration error: ${name} is not set. Copy .env.example to .env and fill in the Azure DevOps coordinates of the repository to review.`,
    );
  }
  return value.trim();
}

/** Read an optional configuration value from the environment, falling back to a default. */
function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * Parse an Azure DevOps repository URL into its coordinates. Supports both the modern and legacy forms:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com[/{collection}]/{project}/_git/{repo}
 * Returns undefined if the string is not a recognizable repo URL.
 */
export function parseRepoUrl(
  rawUrl: string,
):
  | { organization: string; project: string; repositoryName: string }
  | undefined {
  const parsed = URL.parse(rawUrl);
  if (parsed === null) {
    return undefined;
  }
  const segments = parsed.pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => segment !== "");
  const gitIndex = segments.indexOf("_git");
  if (gitIndex < 1 || gitIndex + 1 >= segments.length) {
    return undefined;
  }
  const repositoryName = segments[gitIndex + 1];
  const project = segments[gitIndex - 1];
  const hostname = parsed.hostname.toLowerCase();
  const organization = hostname.endsWith(".visualstudio.com")
    ? hostname.slice(0, hostname.length - ".visualstudio.com".length)
    : segments[0];
  if (organization === "" || project === "" || repositoryName === "") {
    return undefined;
  }
  return { organization, project, repositoryName };
}

// SATURN_REPO_URL is the simplest way to point Saturn at a repo: just the repo's URL, parsed into
// org/project/repo. The individual SATURN_ADO_* variables remain supported as overrides/fallback.
const repoUrl = (process.env.SATURN_REPO_URL ?? "").trim();
const parsedRepo = repoUrl !== "" ? parseRepoUrl(repoUrl) : undefined;
if (repoUrl !== "" && parsedRepo === undefined) {
  throw new Error(
    `Saturn configuration error: SATURN_REPO_URL ("${repoUrl}") is not a recognizable Azure DevOps repo URL (expected .../_git/<repo>).`,
  );
}
const adoOrganization =
  parsedRepo?.organization ?? requireEnv("SATURN_ADO_ORG");
const adoProject = parsedRepo?.project ?? requireEnv("SATURN_ADO_PROJECT");
const adoRepositoryName =
  parsedRepo?.repositoryName ?? requireEnv("SATURN_ADO_REPO_NAME");

/**
 * Azure DevOps identity for the repository Saturn reviews. Simplest setup: SATURN_REPO_URL (the repo's URL)
 * plus SATURN_ADO_DEFAULT_BRANCH. The individual SATURN_ADO_* vars are still honored as overrides.
 */
export const AZURE_DEVOPS_CONFIG: AzureDevOpsConfig = {
  host: envOrDefault("SATURN_ADO_HOST", "dev.azure.com"),
  organization: adoOrganization,
  project: adoProject,
  repositoryName: adoRepositoryName,
  // The REST API accepts the repo name in place of the GUID, so the GUID is optional (override via SATURN_ADO_REPO_ID).
  repositoryId: envOrDefault("SATURN_ADO_REPO_ID", adoRepositoryName),
  defaultBranch: envOrDefault("SATURN_ADO_DEFAULT_BRANCH", "master"),
};

/** Build an absolute Azure DevOps Git REST URL for a repository-relative API path. */
export function buildRepositoryApiUrl(relativePath: string): string {
  const { host, organization, project, repositoryId } = AZURE_DEVOPS_CONFIG;
  const normalized = relativePath.startsWith("/")
    ? relativePath
    : `/${relativePath}`;
  return `https://${host}/${organization}/${project}/_apis/git/repositories/${repositoryId}${normalized}`;
}

/** Build the browser URL for a pull request, used in logs and summary comments. */
export function buildPullRequestWebUrl(pullRequestId: number): string {
  const { organization, project, repositoryName } = AZURE_DEVOPS_CONFIG;
  return `https://${organization}.visualstudio.com/${project}/_git/${repositoryName}/pullrequest/${String(pullRequestId)}`;
}

/** Build a deep link that opens a specific comment thread inside a pull request. */
export function buildCommentDeepLink(
  pullRequestId: number,
  threadId: number,
): string {
  return `${buildPullRequestWebUrl(pullRequestId)}?discussionId=${String(threadId)}`;
}

/** The agent's public-facing name, shown in its comments, the dashboard, and logs. */
export const BOT_NAME = "Saturn";

/**
 * Hidden marker embedded in Saturn's lead summary comment. Detecting it on a PR's threads is how
 * Saturn avoids reviewing the same PR twice. Bump the version suffix to trigger a fresh review wave.
 */
export const BOT_REVIEW_MARKER = "<!-- saturn-review:v1 -->";

/** Default port the Saturn dashboard (which also serves the feedback page) listens on. */
export const DASHBOARD_PORT = 6789;

/**
 * Base URL of the Saturn feedback page. Set SATURN_FEEDBACK_URL to a corpnet-hosted dashboard (e.g.
 * https://saturn.<corp>/feedback) so other reviewers can reach it; otherwise defaults to the local dashboard.
 */
export function buildFeedbackBaseUrl(): string {
  const configured = process.env.SATURN_FEEDBACK_URL;
  if (configured !== undefined && configured.trim() !== "") {
    return configured.trim();
  }

  return `http://localhost:${String(DASHBOARD_PORT)}/feedback`;
}

/**
 * Build the per-comment feedback URL, carrying the PR id and comment (thread) id so the feedback page can
 * record what the feedback is about and the dashboard can deep-link back to the exact comment in the PR.
 */
export function buildFeedbackUrl(
  pullRequestId: number,
  commentId: number,
): string {
  const base = buildFeedbackBaseUrl();
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}prId=${String(pullRequestId)}&commentId=${String(commentId)}`;
}

/**
 * Whether feedback collection is enabled. Off by default until authenticated user attribution is in place, so
 * Saturn's comments carry no feedback link and the feedback page/endpoint are disabled. Enable with
 * SATURN_ENABLE_FEEDBACK=true.
 */
export function isFeedbackEnabled(): boolean {
  return (
    (process.env.SATURN_ENABLE_FEEDBACK ?? "").trim().toLowerCase() === "true"
  );
}

/**
 * Pull request authors (display names) who have opted out of Saturn reviews; Saturn skips any PR created by a
 * matching author. Populate via SATURN_OPT_OUT_AUTHORS (comma-separated display names).
 */
const DEFAULT_OPT_OUT_AUTHORS: readonly string[] = [];

export const OPT_OUT_AUTHORS: readonly string[] = [
  ...DEFAULT_OPT_OUT_AUTHORS,
  ...(process.env.SATURN_OPT_OUT_AUTHORS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== ""),
];

/** True when the given PR author (display name) has opted out of Saturn reviews. */
export function isOptedOutAuthor(authorName: string): boolean {
  const normalized = authorName.trim().toLowerCase();
  return OPT_OUT_AUTHORS.some((entry) => entry.toLowerCase() === normalized);
}

/** Build the attribution/disclaimer line shown at the top of each Saturn comment. */
export function buildBotDisclaimer(onBehalfOf: string): string {
  return (
    `**Automated review by Saturn on behalf of ${onBehalfOf}.** ` +
    "Saturn is an automated code reviewer (correctness, design, API, security, and privacy) - this is a " +
    "best-effort review, not a sign-off or approval. Please verify before merging."
  );
}

/**
 * Wrap a single inline review comment with Saturn's attribution/disclaimer header and the hidden
 * review marker, so every posted comment is self-describing and carries the idempotency marker.
 */
export function buildCommentWithDisclaimer(
  commentBody: string,
  onBehalfOf: string,
): string {
  return `${buildBotDisclaimer(onBehalfOf)}\n\n${commentBody}\n\n${BOT_REVIEW_MARKER}`;
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
