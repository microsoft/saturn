/** Azure DevOps coordinates for the repository Saturn reviews. */
export interface AzureDevOpsConfig {
  readonly host: string;
  readonly organization: string;
  readonly project: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
}

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value : fallback;
}

/**
 * Azure DevOps identity for the repository Saturn reviews. Every field is overridable via an environment
 * variable so the same agent can target any Azure DevOps repository; the defaults point at office-bohemia.
 *
 *   SATURN_ADO_HOST       REST host (default `dev.azure.com`)
 *   SATURN_ADO_ORG        organization (default `office`)
 *   SATURN_ADO_PROJECT    project (default `OC`)
 *   SATURN_ADO_REPO_ID    repository GUID (default office-bohemia's)
 *   SATURN_ADO_REPO_NAME  repository name (default `office-bohemia`)
 */
export const AZURE_DEVOPS_CONFIG: AzureDevOpsConfig = {
  host: envOrDefault("SATURN_ADO_HOST", "dev.azure.com"),
  organization: envOrDefault("SATURN_ADO_ORG", "office"),
  project: envOrDefault("SATURN_ADO_PROJECT", "OC"),
  repositoryId: envOrDefault(
    "SATURN_ADO_REPO_ID",
    "74031860-e0cd-45a1-913f-10bbf3f82555",
  ),
  repositoryName: envOrDefault("SATURN_ADO_REPO_NAME", "office-bohemia"),
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
