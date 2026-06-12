import { z } from 'zod';
import {
  AZURE_DEVOPS_CONFIG,
  BOT_REVIEW_MARKER,
  buildFeedbackUrl,
  buildPullRequestWebUrl,
  buildRepositoryApiUrl,
  isFeedbackEnabled
} from './config';
import type { ChangedFile, PullRequestSummary, ReviewComment } from './review';
import { describeError, runCommand, type RunCommandResult } from './util';

const API_VERSION = '7.1';
const ITERATION_CHANGE_PAGE_SIZE = 2000;

const pullRequestListSchema = z.object({
  value: z.array(
    z
      .object({
        pullRequestId: z.number(),
        title: z.string().optional(),
        status: z.string().optional(),
        isDraft: z.boolean().optional(),
        sourceRefName: z.string().optional(),
        targetRefName: z.string().optional(),
        createdBy: z.object({ displayName: z.string().optional() }).optional(),
        creationDate: z.string().optional()
      })
      .loose()
  )
});

const threadsSchema = z.object({
  value: z.array(
    z
      .object({
        comments: z.array(z.object({ content: z.string().optional() }).loose()).optional()
      })
      .loose()
  )
});

const iterationsSchema = z.object({
  value: z.array(
    z
      .object({
        id: z.number(),
        createdDate: z.string().optional(),
        commonRefCommit: z.object({ commitId: z.string().optional() }).loose().optional()
      })
      .loose()
  )
});

const threadResponseSchema = z.object({ id: z.number() }).loose();

const iterationChangesSchema = z.object({
  changeEntries: z
    .array(
      z
        .object({
          changeType: z.string().nullish(),
          item: z
            .object({
              path: z.string().nullish(),
              objectId: z.string().nullish(),
              gitObjectType: z.string().nullish(),
              isFolder: z.boolean().nullish()
            })
            .loose()
            .optional()
        })
        .loose()
    )
    .optional(),
  nextSkip: z.number().optional()
});

function parseCredentialLines(output: string): Map<string, string> {
  const credentials = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex > 0) {
      credentials.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
    }
  }

  return credentials;
}

function azureDevOpsCredentialHosts(): readonly string[] {
  return [`${AZURE_DEVOPS_CONFIG.organization}.visualstudio.com`, AZURE_DEVOPS_CONFIG.host];
}

// Azure DevOps credentials from the Git credential helper are short-lived (often ~1h). Cache the header
// per repo root only for this TTL, and force a refresh on a 401/403 (see azureDevOpsFetch), so an
// expired token does not turn every request into a failure for the rest of the process's lifetime.
const AUTH_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedAuthHeader {
  readonly header: string;
  readonly fetchedAtMs: number;
}

const cachedAuthHeaderByRepoRoot = new Map<string, CachedAuthHeader>();

// The well-known Azure DevOps resource (application) id; `az account get-access-token --resource <id>`
// mints a bearer token scoped to it.
const AZURE_DEVOPS_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

const azureCliTokenSchema = z.object({ accessToken: z.string() });

// Repo roots where the Azure CLI has successfully provided a token. Once the Git credential helper has
// proven unreliable for a repo (a 401 only the CLI could recover from), prefer the CLI there so steady
// state does not 401 once per cache-TTL window.
const preferAzureCliByRepoRoot = new Set<string>();

/**
 * Mint a fresh Azure DevOps bearer token from the Azure CLI. Unlike replaying Git's credential helper -
 * which frequently hands back the same already-expired token - the Azure CLI silently refreshes its own
 * token, so this reliably recovers after a 401. Returns undefined when the CLI is missing or not logged in.
 */
function buildAzureCliBearerHeader(): string | undefined {
  let result: RunCommandResult;
  try {
    result = runCommand(
      'az',
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE_ID, '--output', 'json'],
      // az is a .cmd shim on Windows, so it must be launched through the shell. Every argument is a fixed
      // constant (no interpolation), so there is no command-injection surface here.
      { timeoutMs: 30_000, shell: process.platform === 'win32' }
    );
  } catch {
    return undefined;
  }

  if (result.status !== 0) {
    return undefined;
  }

  try {
    const parsed = azureCliTokenSchema.safeParse(JSON.parse(result.stdout));
    if (parsed.success && parsed.data.accessToken !== '') {
      return `Bearer ${parsed.data.accessToken}`;
    }
  } catch {
    /* malformed CLI output */
  }

  return undefined;
}

/**
 * Resolve an Azure DevOps auth header. The primary source is Git's credential helper (the same mechanism
 * `git pull` uses, so no PAT or Azure CLI login is required for the happy path). The result is cached per
 * repo root for a short TTL. On a `forceRefresh` (done automatically on a 401/403) the Azure CLI is tried
 * first to mint a genuinely fresh token, because re-running the Git helper usually just replays the same
 * expired credential and cannot recover; the CLI is also used as a fallback when Git has no usable credential.
 */
export function getAzureDevOpsAuthHeader(repoRoot: string, forceRefresh = false): string {
  const cached = cachedAuthHeaderByRepoRoot.get(repoRoot);
  if (!forceRefresh && cached !== undefined && Date.now() - cached.fetchedAtMs < AUTH_CACHE_TTL_MS) {
    return cached.header;
  }

  // After a 401 (or once the CLI has proven more reliable for this repo), mint a fresh token from the
  // Azure CLI first - re-running the Git credential helper would just replay the rejected token.
  if (forceRefresh || preferAzureCliByRepoRoot.has(repoRoot)) {
    const azHeader = buildAzureCliBearerHeader();
    if (azHeader !== undefined) {
      preferAzureCliByRepoRoot.add(repoRoot);
      cachedAuthHeaderByRepoRoot.set(repoRoot, { header: azHeader, fetchedAtMs: Date.now() });
      return azHeader;
    }
  }

  // Never let the credential helper block on an interactive prompt - this runs headless.
  const nonInteractiveEnv: NodeJS.ProcessEnv = { ...process.env };
  nonInteractiveEnv['GIT_TERMINAL_PROMPT'] = '0';
  nonInteractiveEnv['GCM_INTERACTIVE'] = 'never';

  for (const host of azureDevOpsCredentialHosts()) {
    let result: RunCommandResult;
    try {
      result = runCommand('git', ['-c', 'credential.interactive=false', '-C', repoRoot, 'credential', 'fill'], {
        input: `protocol=https\nhost=${host}\n\n`,
        env: nonInteractiveEnv,
        timeoutMs: 20_000
      });
    } catch {
      continue;
    }

    if (result.status !== 0) {
      continue;
    }

    const credentials = parseCredentialLines(result.stdout);
    const username = credentials.get('username');
    const password = credentials.get('password');
    if (username !== undefined && password !== undefined && username !== '' && password !== '') {
      const header = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      cachedAuthHeaderByRepoRoot.set(repoRoot, { header, fetchedAtMs: Date.now() });
      return header;
    }
  }

  // Final fallback: the Azure CLI (covers a host where Git has no usable credential at all).
  const fallbackAzHeader = buildAzureCliBearerHeader();
  if (fallbackAzHeader !== undefined) {
    preferAzureCliByRepoRoot.add(repoRoot);
    cachedAuthHeaderByRepoRoot.set(repoRoot, { header: fallbackAzHeader, fetchedAtMs: Date.now() });
    return fallbackAzHeader;
  }

  throw new Error(
    'Could not obtain Azure DevOps credentials from Git or the Azure CLI. Ensure you can clone office-bohemia over HTTPS, or run `az login`.'
  );
}

// Azure DevOps occasionally drops a pooled keep-alive socket during a long review, so the next request
// (often the POST that publishes comments) fails at the connection level with undici "fetch failed".
// Retrying with a short backoff transparently reconnects. Only connection-level errors are retried;
// HTTP error responses are surfaced immediately.
const MAX_FETCH_ATTEMPTS = 3;

function delayMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function azureDevOpsFetch(
  repoRoot: string,
  relativePath: string,
  method: string,
  body: string | undefined,
  accept: string
): Promise<Response> {
  const url = buildRepositoryApiUrl(relativePath);
  let lastConnectionError: unknown;
  let authRefreshed = false;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: getAzureDevOpsAuthHeader(repoRoot),
          'Content-Type': 'application/json',
          Accept: accept
        },
        body
      });
    } catch (error) {
      // Connection-level failure: the request never reached the server, so a retry will not duplicate it.
      lastConnectionError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        await delayMs(400 * attempt);
        continue;
      }

      throw new Error(
        `Azure DevOps ${method} ${relativePath} could not connect after ${String(MAX_FETCH_ATTEMPTS)} attempt(s): ${describeError(error)}`
      );
    }

    // The cached Git credential may have expired (Azure DevOps tokens are short-lived), which turns
    // every request into a 401. Drop the cached header, fetch a fresh credential, and retry once before
    // surfacing the error. The retry below does not consume the connection-retry budget.
    if ((response.status === 401 || response.status === 403) && !authRefreshed) {
      authRefreshed = true;
      await response.text();
      getAzureDevOpsAuthHeader(repoRoot, true);
      attempt -= 1;
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Azure DevOps ${method} ${relativePath} failed (${String(response.status)}): ${errorText.slice(0, 500)}`
      );
    }

    return response;
  }

  // The loop always returns or throws above; this satisfies the type checker.
  throw new Error(`Azure DevOps ${method} ${relativePath} could not connect: ${describeError(lastConnectionError)}`);
}

async function azureDevOpsGetJson(repoRoot: string, relativePath: string): Promise<unknown> {
  const response = await azureDevOpsFetch(repoRoot, relativePath, 'GET', undefined, 'application/json');
  const data: unknown = await response.json();
  return data;
}

async function azureDevOpsGetText(repoRoot: string, relativePath: string): Promise<string> {
  const response = await azureDevOpsFetch(repoRoot, relativePath, 'GET', undefined, 'text/plain');
  return await response.text();
}

async function azureDevOpsPostJson(repoRoot: string, relativePath: string, body: unknown): Promise<unknown> {
  const response = await azureDevOpsFetch(repoRoot, relativePath, 'POST', JSON.stringify(body), 'application/json');
  const data: unknown = await response.json();
  return data;
}

async function azureDevOpsPatchJson(repoRoot: string, relativePath: string, body: unknown): Promise<unknown> {
  const response = await azureDevOpsFetch(repoRoot, relativePath, 'PATCH', JSON.stringify(body), 'application/json');
  const data: unknown = await response.json();
  return data;
}

function refNameToBranch(refName: string | undefined): string {
  return refName?.replace(/^refs\/heads\//, '') ?? '';
}

/** List active pull requests for office-bohemia. Draft PRs are included here and filtered by the caller. */
export async function listActivePullRequests(repoRoot: string, top: number): Promise<readonly PullRequestSummary[]> {
  const raw = await azureDevOpsGetJson(
    repoRoot,
    `/pullRequests?searchCriteria.status=active&$top=${String(top)}&api-version=${API_VERSION}`
  );
  const parsed = pullRequestListSchema.parse(raw);
  return parsed.value.map((pullRequest) => ({
    pullRequestId: pullRequest.pullRequestId,
    title: pullRequest.title ?? '(untitled)',
    isDraft: pullRequest.isDraft ?? false,
    sourceBranch: refNameToBranch(pullRequest.sourceRefName),
    targetBranch: refNameToBranch(pullRequest.targetRefName),
    authorName: pullRequest.createdBy?.displayName ?? 'unknown',
    webUrl: buildPullRequestWebUrl(pullRequest.pullRequestId),
    createdAt: pullRequest.creationDate
  }));
}

const singlePullRequestSchema = z
  .object({
    pullRequestId: z.number(),
    title: z.string().optional(),
    status: z.string().optional(),
    isDraft: z.boolean().optional(),
    sourceRefName: z.string().optional(),
    targetRefName: z.string().optional(),
    createdBy: z.object({ displayName: z.string().optional() }).optional(),
    creationDate: z.string().optional()
  })
  .loose();

/**
 * Fetch a single pull request by id regardless of status (active, completed, or abandoned). Returns
 * `undefined` when the PR does not exist. Used by `--pr <id>` so a specific PR can be reviewed even
 * when it is not in the active top-N list.
 */
export async function getPullRequestById(
  repoRoot: string,
  pullRequestId: number
): Promise<PullRequestSummary | undefined> {
  let raw: unknown;
  try {
    raw = await azureDevOpsGetJson(repoRoot, `/pullRequests/${String(pullRequestId)}?api-version=${API_VERSION}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('(404)')) {
      return undefined;
    }

    throw error;
  }

  const pullRequest = singlePullRequestSchema.parse(raw);
  return {
    pullRequestId: pullRequest.pullRequestId,
    title: pullRequest.title ?? '(untitled)',
    isDraft: pullRequest.isDraft ?? false,
    sourceBranch: refNameToBranch(pullRequest.sourceRefName),
    targetBranch: refNameToBranch(pullRequest.targetRefName),
    authorName: pullRequest.createdBy?.displayName ?? 'unknown',
    webUrl: buildPullRequestWebUrl(pullRequest.pullRequestId),
    createdAt: pullRequest.creationDate
  };
}

/** Return true when the bot has already left its marker on a pull request's threads. */
export async function pullRequestHasBotReview(repoRoot: string, pullRequestId: number): Promise<boolean> {
  const raw = await azureDevOpsGetJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads?api-version=${API_VERSION}`
  );
  const parsed = threadsSchema.parse(raw);
  return parsed.value.some((thread) =>
    (thread.comments ?? []).some((comment) => (comment.content ?? '').includes(BOT_REVIEW_MARKER))
  );
}

const threadCommentsSchema = z.object({
  value: z.array(
    z
      .object({
        id: z.number().optional(),
        status: z.union([z.string(), z.number()]).optional(),
        threadContext: z
          .object({
            filePath: z.string().optional(),
            rightFileStart: z.object({ line: z.number().optional() }).loose().optional()
          })
          .loose()
          .nullable()
          .optional(),
        comments: z.array(z.object({ content: z.string().optional() }).loose()).optional()
      })
      .loose()
  )
});

/** An existing comment thread on a pull request, with its id, status, file/line anchor and joined text. */
export interface ExistingThreadComment {
  readonly threadId: number | undefined;
  readonly status: string | undefined;
  readonly filePath: string;
  readonly line: number | undefined;
  readonly content: string;
}

/** Fetch the existing comment threads on a pull request so the caller can avoid posting duplicates. */
export async function getExistingThreadComments(
  repoRoot: string,
  pullRequestId: number
): Promise<readonly ExistingThreadComment[]> {
  const raw = await azureDevOpsGetJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads?api-version=${API_VERSION}`
  );
  const parsed = threadCommentsSchema.parse(raw);
  return parsed.value.map((thread) => ({
    threadId: thread.id,
    status: thread.status === undefined ? undefined : String(thread.status),
    filePath: thread.threadContext?.filePath ?? '',
    line: thread.threadContext?.rightFileStart?.line,
    content: (thread.comments ?? []).map((comment) => comment.content ?? '').join('\n')
  }));
}

interface IterationInfo {
  readonly id: number;
  readonly baseCommit: string | undefined;
  readonly createdAt: string | undefined;
}

async function getLatestIteration(repoRoot: string, pullRequestId: number): Promise<IterationInfo | undefined> {
  const raw = await azureDevOpsGetJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/iterations?api-version=${API_VERSION}`
  );
  const parsed = iterationsSchema.parse(raw);
  let latest: IterationInfo | undefined;
  for (const iteration of parsed.value) {
    if (latest === undefined || iteration.id > latest.id) {
      latest = { id: iteration.id, baseCommit: iteration.commonRefCommit?.commitId, createdAt: iteration.createdDate };
    }
  }

  return latest;
}

/** The id of a pull request's latest iteration (its newest pushed commit set), or undefined if none. */
export async function getLatestIterationId(repoRoot: string, pullRequestId: number): Promise<number | undefined> {
  return (await getLatestIteration(repoRoot, pullRequestId))?.id;
}

/** A pull request's changed files together with the iteration id and merge-base commit to diff against. */
export interface ChangedFileSet {
  readonly iterationId: number | undefined;
  readonly baseCommit: string | undefined;
  readonly iterationCreatedAt: string | undefined;
  readonly files: readonly ChangedFile[];
}

/** List the files changed in a pull request's latest iteration (folders excluded), plus the merge base. */
export async function getChangedFiles(repoRoot: string, pullRequestId: number): Promise<ChangedFileSet> {
  const iteration = await getLatestIteration(repoRoot, pullRequestId);
  if (iteration === undefined) {
    return { iterationId: undefined, baseCommit: undefined, iterationCreatedAt: undefined, files: [] };
  }

  const changedFiles: ChangedFile[] = [];
  let skip = 0;
  for (;;) {
    const raw = await azureDevOpsGetJson(
      repoRoot,
      `/pullRequests/${String(pullRequestId)}/iterations/${String(iteration.id)}/changes` +
        `?$top=${String(ITERATION_CHANGE_PAGE_SIZE)}&$skip=${String(skip)}&api-version=${API_VERSION}`
    );
    const parsed = iterationChangesSchema.parse(raw);
    const entries = parsed.changeEntries ?? [];
    for (const entry of entries) {
      const item = entry.item;
      // ADO can return a change entry with a null/empty path (e.g. on reverts/merges, an item that
      // carries only an object id) - skip those rather than letting them through as a file.
      if (item?.path === undefined || item.path === null || item.path === '' || item.isFolder === true) {
        continue;
      }

      if ((item.gitObjectType ?? 'blob') !== 'blob') {
        continue;
      }

      changedFiles.push({
        path: item.path,
        changeType: entry.changeType ?? 'edit',
        objectId: item.objectId ?? ''
      });
    }

    if (parsed.nextSkip === undefined || parsed.nextSkip <= skip || entries.length === 0) {
      break;
    }

    skip = parsed.nextSkip;
  }

  return {
    iterationId: iteration.id,
    baseCommit: iteration.baseCommit,
    iterationCreatedAt: iteration.createdAt,
    files: changedFiles
  };
}

/** Fetch the text content of a Git blob by object id. */
export async function getBlobText(repoRoot: string, objectId: string): Promise<string> {
  return await azureDevOpsGetText(repoRoot, `/blobs/${objectId}?$format=text&api-version=${API_VERSION}`);
}

/**
 * Fetch a file's text at a specific commit (the PR's merge base) so the caller can diff it against the
 * new content. Returns '' when the file does not exist at that commit (e.g. a newly added file), so the
 * whole new file is treated as added.
 */
export async function getFileTextAtCommit(repoRoot: string, filePath: string, commitId: string): Promise<string> {
  try {
    return await azureDevOpsGetText(
      repoRoot,
      `/items?path=${encodeURIComponent(filePath)}` +
        `&versionDescriptor.versionType=commit&versionDescriptor.version=${commitId}` +
        `&$format=text&api-version=${API_VERSION}`
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('(404)')) {
      return '';
    }

    throw error;
  }
}

// Azure DevOps comment-thread statuses. Active threads count as unresolved and can gate PR completion;
// posting a non-actionable finding as Resolved keeps it visible without adding to that open-thread count.
const THREAD_STATUS_ACTIVE = 1;
const THREAD_STATUS_RESOLVED = 2;

/**
 * Post a single inline (file + line anchored) review comment; returns the new thread id. By default the
 * thread is posted Active; pass `resolved` for a non-actionable finding so it is posted already-resolved.
 */
export async function postInlineComment(
  repoRoot: string,
  pullRequestId: number,
  comment: ReviewComment,
  resolved = false
): Promise<number> {
  const response = await azureDevOpsPostJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads?api-version=${API_VERSION}`,
    {
      comments: [{ parentCommentId: 0, content: comment.body, commentType: 1 }],
      status: resolved ? THREAD_STATUS_RESOLVED : THREAD_STATUS_ACTIVE,
      threadContext: {
        filePath: comment.filePath,
        rightFileStart: { line: comment.line, offset: 1 },
        rightFileEnd: { line: comment.line, offset: 1 }
      }
    }
  );
  const threadId = threadResponseSchema.parse(response).id;

  // When feedback is enabled, add the comment-specific feedback link (carrying the PR id and this thread id,
  // known only after creation) in a follow-up edit of the root comment. Off by default until authenticated
  // attribution is in place. Best-effort: a failure here must not fail the review.
  if (isFeedbackEnabled()) {
    try {
      const feedbackUrl = buildFeedbackUrl(pullRequestId, threadId);
      await azureDevOpsPatchJson(
        repoRoot,
        `/pullRequests/${String(pullRequestId)}/threads/${String(threadId)}/comments/1?api-version=${API_VERSION}`,
        { content: `${comment.body}\n\n[Share feedback on this review](${feedbackUrl})` }
      );
    } catch {
      /* leave the comment without the feedback link */
    }
  }

  return threadId;
}

/** Post the lead, non-anchored summary comment (carrying the disclaimer and marker); returns its id. */
export async function postSummaryComment(repoRoot: string, pullRequestId: number, content: string): Promise<number> {
  const response = await azureDevOpsPostJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads?api-version=${API_VERSION}`,
    {
      comments: [{ parentCommentId: 0, content, commentType: 1 }],
      status: 1
    }
  );
  return threadResponseSchema.parse(response).id;
}

/**
 * Re-open an existing comment thread (set it Active) and post a reply on it. Used when a prior Saturn
 * comment still applies on a newer iteration: rather than opening a duplicate thread, Saturn reactivates
 * the original thread and replies explaining why it is still open.
 */
export async function reactivateThreadAndReply(
  repoRoot: string,
  pullRequestId: number,
  threadId: number,
  replyContent: string
): Promise<void> {
  // status 1 = Active. Re-opens a thread the author resolved/closed but did not actually fix.
  await azureDevOpsPatchJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads/${String(threadId)}?api-version=${API_VERSION}`,
    { status: 1 }
  );
  await azureDevOpsPostJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads/${String(threadId)}/comments?api-version=${API_VERSION}`,
    { parentCommentId: 1, content: replyContent, commentType: 1 }
  );
}
