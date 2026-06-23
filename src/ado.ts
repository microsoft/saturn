// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { z } from 'zod';
import {
  AZURE_DEVOPS_CONFIG,
  BOT_REVIEW_MARKER,
  buildFeedbackUrl,
  buildProjectApiUrl,
  buildPullRequestWebUrl,
  buildRepositoryApiUrl,
  buildWorkItemWebUrl,
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
        createdBy: z.object({ displayName: z.string().optional(), uniqueName: z.string().optional() }).optional(),
        reviewers: z
          .array(z.object({ displayName: z.string().optional(), uniqueName: z.string().optional() }).loose())
          .optional(),
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
    'Could not obtain Azure DevOps credentials from Git or the Azure CLI. Ensure you can clone the target repo over HTTPS, or run `az login`.'
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

async function azureDevOpsFetchUrl(
  repoRoot: string,
  url: string,
  label: string,
  method: string,
  body: string | undefined,
  accept: string,
  contentType: string
): Promise<Response> {
  let lastConnectionError: unknown;
  let authRefreshed = false;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: getAzureDevOpsAuthHeader(repoRoot),
          'Content-Type': contentType,
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
        `Azure DevOps ${method} ${label} could not connect after ${String(MAX_FETCH_ATTEMPTS)} attempt(s): ${describeError(error)}`
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
        `Azure DevOps ${method} ${label} failed (${String(response.status)}): ${errorText.slice(0, 500)}`
      );
    }

    return response;
  }

  // The loop always returns or throws above; this satisfies the type checker.
  throw new Error(`Azure DevOps ${method} ${label} could not connect: ${describeError(lastConnectionError)}`);
}

async function azureDevOpsFetch(
  repoRoot: string,
  relativePath: string,
  method: string,
  body: string | undefined,
  accept: string
): Promise<Response> {
  return azureDevOpsFetchUrl(
    repoRoot,
    buildRepositoryApiUrl(relativePath),
    relativePath,
    method,
    body,
    accept,
    'application/json'
  );
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

// Work item tracking uses a project-scoped URL and the JSON-Patch media type, distinct from the Git APIs.
async function azureDevOpsPostJsonPatch(
  repoRoot: string,
  url: string,
  label: string,
  patch: unknown
): Promise<unknown> {
  const response = await azureDevOpsFetchUrl(
    repoRoot,
    url,
    label,
    'POST',
    JSON.stringify(patch),
    'application/json',
    'application/json-patch+json'
  );
  const data: unknown = await response.json();
  return data;
}

const createdWorkItemSchema = z.object({ id: z.number() }).loose();

/** Fields needed to file an ADO Bug for an audit finding. */
export interface CreateBugInput {
  readonly title: string;
  /** HTML body placed in the Bug's Description + Repro Steps fields (HTML renders rich, not raw markdown). */
  readonly reproStepsHtml: string;
  readonly areaPath: string;
  /** Optional ADO iteration path. When empty, ADO defaults the bug to the project's root iteration. */
  readonly iterationPath?: string;
  /** Optional assignee (package owner email/UPN). Dropped automatically if ADO rejects the identity. */
  readonly assignedTo?: string;
  /** ADO severity field value, e.g. "2 - High". */
  readonly severity: string;
  readonly tags: readonly string[];
}

/** The created Bug's id and browser URL. */
export interface CreatedBug {
  readonly id: number;
  readonly url: string;
}

/** Which routing/optional fields to include in a bug patch, so a create retry can drop them one at a time. */
interface BugPatchFields {
  readonly includeAreaPath: boolean;
  readonly includeIteration: boolean;
  readonly includeAssignee: boolean;
}

// Build the JSON-Patch document for a new Bug. The fields object controls which routing/optional fields are
// included, so the create retry can independently drop a rejected area path, iteration, or assignee.
function buildBugPatch(input: CreateBugInput, fields: BugPatchFields): readonly unknown[] {
  const patch: unknown[] = [{ op: 'add', path: '/fields/System.Title', value: input.title }];
  if (fields.includeAreaPath && input.areaPath.trim() !== '') {
    patch.push({ op: 'add', path: '/fields/System.AreaPath', value: input.areaPath });
  }
  // Populate both the Description and Repro Steps (HTML) so the details show whichever field the Bug
  // template surfaces. Both are rich-text fields, so the HTML renders instead of showing raw markup.
  patch.push(
    { op: 'add', path: '/fields/System.Description', value: input.reproStepsHtml },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: input.reproStepsHtml },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: input.severity },
    { op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') }
  );
  if (fields.includeIteration && input.iterationPath !== undefined && input.iterationPath.trim() !== '') {
    patch.push({ op: 'add', path: '/fields/System.IterationPath', value: input.iterationPath });
  }
  if (fields.includeAssignee && input.assignedTo !== undefined && input.assignedTo.trim() !== '') {
    patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: input.assignedTo });
  }
  return patch;
}

// ADO rejects an area path that is not a real node in the project's area tree (TF401347 /
// WorkItemFieldInvalidTreeNameException). Detecting this lets us walk up to the nearest valid parent area.
function isInvalidAreaPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /areapath|tf401347|invalid tree name|invalidtreename/i.test(message);
}

// The area path and each of its ancestors, most specific first, down to the project-root segment - e.g.
// `Project\TeamA\AreaB\Leaf` -> [`...\Leaf`, `Project\TeamA\AreaB`, `Project\TeamA`, `Project`].
// Walking this lets a stale/renamed leaf area fall back to the nearest valid ancestor team. Tolerates
// forward slashes and stray separators; returns [] for an empty path.
function areaPathAncestors(areaPath: string): readonly string[] {
  const segments = areaPath
    .replace(/\//g, '\\')
    .split('\\')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  const ancestors: string[] = [];
  for (let end = segments.length; end >= 1; end -= 1) {
    ancestors.push(segments.slice(0, end).join('\\'));
  }
  return ancestors;
}

// Parse the create-bug response into the new bug's id + web URL, or throw if the id is missing.
function createdBugFrom(data: unknown): CreatedBug {
  const parsed = createdWorkItemSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Azure DevOps create bug: response did not include a work item id.');
  }
  return { id: parsed.data.id, url: buildWorkItemWebUrl(parsed.data.id) };
}

/**
 * File a new ADO Bug via the Work Item Tracking API (JSON-Patch). Sets title, area path (which routes the
 * bug to the owning team), description + repro steps, severity, tags, and optionally an iteration + assignee.
 *
 * Robust fallback so a bug always lands while preserving as much routing/attribution as possible:
 *  - if ADO rejects the *area path* (TF401347, a stale/renamed team area) it walks up to the parent area
 *    (`Area\A\B\C` -> `Area\A\B` -> `Area\A` -> `Area`) and retries, so the bug routes to the nearest valid
 *    ancestor team instead of being dumped in the project default;
 *  - if ADO rejects an *optional field* (a bad iteration or an AssignedTo identity) it drops the iteration
 *    first (keeping the assignee) and only drops the assignee as a last resort, so the package owner stays
 *    on the bug whenever ADO will accept them.
 * Returns the new id + web URL.
 */
export async function createBugWorkItem(repoRoot: string, input: CreateBugInput): Promise<CreatedBug> {
  // The work item type goes in the URL as `$Bug`; the project base differs from the Git repo base.
  const url = `${buildProjectApiUrl('/wit/workitems/$Bug')}?api-version=${API_VERSION}`;
  const hasIteration = input.iterationPath !== undefined && input.iterationPath.trim() !== '';
  const hasAssignee = input.assignedTo !== undefined && input.assignedTo.trim() !== '';

  const post = (patch: readonly unknown[], label: string): Promise<unknown> =>
    azureDevOpsPostJsonPatch(repoRoot, url, label, patch);

  // Try one area path, progressively dropping optional fields (iteration first, then assignee) if ADO
  // rejects them - but rethrow an invalid-area-path error immediately so the caller can walk to the parent
  // area instead of needlessly stripping the assignee.
  const tryArea = async (areaPath: string, includeAreaPath: boolean): Promise<unknown> => {
    const candidate: CreateBugInput = { ...input, areaPath };
    const attempts: BugPatchFields[] = [
      { includeAreaPath, includeIteration: hasIteration, includeAssignee: hasAssignee }
    ];
    if (hasIteration && hasAssignee) {
      attempts.push({ includeAreaPath, includeIteration: false, includeAssignee: true });
    }
    if (hasIteration || hasAssignee) {
      attempts.push({ includeAreaPath, includeIteration: false, includeAssignee: false });
    }
    let lastError: unknown;
    for (let index = 0; index < attempts.length; index += 1) {
      try {
        return await post(buildBugPatch(candidate, attempts[index]), index === 0 ? 'create bug' : 'create bug (retry)');
      } catch (error) {
        lastError = error;
        if (isInvalidAreaPathError(error)) {
          throw error; // the area path is the problem - let the caller walk up to the parent area
        }
        // otherwise an optional field was rejected: drop one more (iteration, then assignee) and retry
      }
    }
    throw lastError;
  };

  let data: unknown;
  let created = false;
  let lastError: unknown;
  for (const areaPath of areaPathAncestors(input.areaPath)) {
    try {
      data = await tryArea(areaPath, true);
      created = true;
      break;
    } catch (error) {
      lastError = error;
      if (isInvalidAreaPathError(error)) {
        continue; // stale leaf area - walk up to the parent area and retry
      }
      throw error;
    }
  }

  // No area candidate was accepted (or none was provided): file with no area path so the bug still lands in
  // the project default area, keeping the assignee wherever ADO will accept it.
  if (!created) {
    try {
      data = await tryArea(input.areaPath, false);
    } catch (error) {
      throw lastError ?? error;
    }
  }

  return createdBugFrom(data);
}

/** Post a comment on an existing work item (used to note when an audit finding appears fixed). */
export async function addWorkItemComment(repoRoot: string, workItemId: number, text: string): Promise<void> {
  const url = `${buildProjectApiUrl(`/wit/workItems/${String(workItemId)}/comments`)}?api-version=7.1-preview.4`;
  await azureDevOpsFetchUrl(
    repoRoot,
    url,
    'work item comment',
    'POST',
    JSON.stringify({ text }),
    'application/json',
    'application/json'
  );
}

interface IterationNode {
  readonly name: string;
  readonly attributes?: { readonly startDate?: string; readonly finishDate?: string };
  readonly children?: readonly IterationNode[];
}

const iterationNodeSchema: z.ZodType<IterationNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    attributes: z.object({ startDate: z.string().optional(), finishDate: z.string().optional() }).optional(),
    children: z.array(iterationNodeSchema).optional()
  })
);

interface IterationCandidate {
  readonly path: string;
  readonly start: number;
  readonly finish: number;
  readonly depth: number;
}

// Flatten the iteration tree into dated candidates (path = name-chain), so we can pick the active sprint.
function collectIterations(
  node: IterationNode,
  ancestry: readonly string[],
  depth: number,
  out: IterationCandidate[]
): void {
  const names = [...ancestry, node.name];
  const start = node.attributes?.startDate !== undefined ? Date.parse(node.attributes.startDate) : Number.NaN;
  if (!Number.isNaN(start)) {
    const finish = node.attributes?.finishDate !== undefined ? Date.parse(node.attributes.finishDate) : Number.NaN;
    out.push({ path: names.join('\\'), start, finish, depth });
  }
  for (const child of node.children ?? []) {
    collectIterations(child, names, depth + 1, out);
  }
}

// The current sprint (deepest node whose dates span now); if no sprint is active right now, the most
// recently started one; failing that, undefined so ADO uses its default. Never an arbitrary/oldest node.
export function pickCurrentIteration(root: IterationNode): string | undefined {
  const candidates: IterationCandidate[] = [];
  collectIterations(root, [], 0, candidates);
  const now = Date.now();
  const spanning = candidates
    .filter((candidate) => !Number.isNaN(candidate.finish) && now >= candidate.start && now <= candidate.finish)
    .sort((first, second) => second.depth - first.depth);
  if (spanning.length > 0) {
    return spanning[0].path;
  }
  const started = candidates
    .filter((candidate) => candidate.start <= now)
    .sort((first, second) => second.start - first.start || second.depth - first.depth);
  return started.length > 0 ? started[0].path : undefined;
}

let cachedIteration: { readonly value: string | undefined; readonly at: number } | undefined;
const ITERATION_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * Best-effort current iteration path for the project (the sprint whose dates span today), so audit bugs can
 * land in the active sprint rather than the backlog root. Cached for a few hours; returns undefined on any
 * failure (the caller then omits the iteration and ADO assigns its default).
 */
export async function resolveCurrentIterationPath(repoRoot: string): Promise<string | undefined> {
  if (cachedIteration !== undefined && Date.now() - cachedIteration.at < ITERATION_CACHE_MS) {
    return cachedIteration.value;
  }
  let value: string | undefined;
  // 1. Prefer the project's default team's CURRENT sprint (the canonical current iteration, via
  //    $timeframe=current - a small, reliable response). Walking the iteration classification tree is a
  //    fragile fallback: large projects have hundreds of inconsistently-dated nodes and the deep query can
  //    fail, which would leave the iteration unset and let ADO drop the bug into an ancient default sprint.
  try {
    const teamId = await projectDefaultTeamId(repoRoot);
    if (teamId !== undefined) {
      value = await teamCurrentIteration(repoRoot, teamId);
    }
  } catch {
    value = undefined;
  }
  // 2. Fallback (projects without team iterations configured): walk the classification tree and pick the
  //    sprint spanning today, else the most recently started one.
  if (value === undefined) {
    try {
      const url = `${buildProjectApiUrl('/wit/classificationnodes/iterations')}?$depth=10&api-version=${API_VERSION}`;
      const response = await azureDevOpsFetchUrl(
        repoRoot,
        url,
        'iterations',
        'GET',
        undefined,
        'application/json',
        'application/json'
      );
      const parsed = iterationNodeSchema.safeParse(await response.json());
      if (parsed.success) {
        value = pickCurrentIteration(parsed.data);
      }
    } catch {
      value = undefined;
    }
  }
  cachedIteration = { value, at: Date.now() };
  return value;
}

const projectTeamsSchema = z.object({
  value: z.array(z.object({ id: z.string(), name: z.string() })).catch([])
});
const teamIterationsSchema = z.object({
  value: z
    .array(
      z.object({
        path: z.string().optional(),
        attributes: z
          .object({
            startDate: z.string().optional(),
            finishDate: z.string().optional(),
            timeFrame: z.string().optional()
          })
          .optional()
      })
    )
    .catch([])
});
const teamFieldValuesSchema = z.object({
  defaultValue: z.string().optional(),
  values: z.array(z.object({ value: z.string(), includeChildren: z.boolean().optional() })).catch([])
});

interface TeamAreaEntry {
  readonly areaPath: string;
  readonly includeChildren: boolean;
  readonly teamId: string;
}

let cachedTeams:
  | { readonly value: readonly { readonly id: string; readonly name: string }[]; readonly at: number }
  | undefined;
const teamIterationCache = new Map<string, string | undefined>();
const areaIterationCache = new Map<string, string | undefined>();
const teamFieldCache = new Map<string, readonly TeamAreaEntry[]>();
let cachedTeamAreas: { readonly value: readonly TeamAreaEntry[]; readonly at: number } | undefined;

// True when now falls within an iteration's [startDate, finishDate] window.
function iterationSpansNow(attributes?: { readonly startDate?: string; readonly finishDate?: string }): boolean {
  const start = attributes?.startDate !== undefined ? Date.parse(attributes.startDate) : Number.NaN;
  const finish = attributes?.finishDate !== undefined ? Date.parse(attributes.finishDate) : Number.NaN;
  const now = Date.now();
  return !Number.isNaN(start) && !Number.isNaN(finish) && now >= start && now <= finish;
}

async function listProjectTeams(repoRoot: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
  if (cachedTeams !== undefined && Date.now() - cachedTeams.at < ITERATION_CACHE_MS) {
    return cachedTeams.value;
  }
  let value: readonly { readonly id: string; readonly name: string }[] = [];
  try {
    const { host, organization, project } = AZURE_DEVOPS_CONFIG;
    const url = `https://${host}/${organization}/_apis/projects/${encodeURIComponent(project)}/teams?api-version=${API_VERSION}`;
    const response = await azureDevOpsFetchUrl(
      repoRoot,
      url,
      'teams',
      'GET',
      undefined,
      'application/json',
      'application/json'
    );
    const parsed = projectTeamsSchema.safeParse(await response.json());
    if (parsed.success) {
      value = parsed.data.value;
    }
  } catch {
    value = [];
  }
  cachedTeams = { value, at: Date.now() };
  return value;
}

const projectDefaultTeamSchema = z.object({ defaultTeam: z.object({ id: z.string() }).optional() }).loose();

let cachedDefaultTeamId: { readonly value: string | undefined; readonly at: number } | undefined;

// The project's default team id, used to resolve the project's current sprint via the team-iterations API
// ($timeframe=current) - far more reliable than walking the whole iteration classification tree. Cached.
async function projectDefaultTeamId(repoRoot: string): Promise<string | undefined> {
  if (cachedDefaultTeamId !== undefined && Date.now() - cachedDefaultTeamId.at < ITERATION_CACHE_MS) {
    return cachedDefaultTeamId.value;
  }
  let value: string | undefined;
  try {
    const { host, organization, project } = AZURE_DEVOPS_CONFIG;
    const url = `https://${host}/${organization}/_apis/projects/${encodeURIComponent(project)}?api-version=${API_VERSION}`;
    const response = await azureDevOpsFetchUrl(
      repoRoot,
      url,
      'project default team',
      'GET',
      undefined,
      'application/json',
      'application/json'
    );
    const parsed = projectDefaultTeamSchema.safeParse(await response.json());
    value = parsed.success ? parsed.data.defaultTeam?.id : undefined;
  } catch {
    value = undefined;
  }
  cachedDefaultTeamId = { value, at: Date.now() };
  return value;
}

async function teamCurrentIteration(repoRoot: string, teamId: string): Promise<string | undefined> {
  const cached = teamIterationCache.get(teamId);
  if (cached !== undefined || teamIterationCache.has(teamId)) {
    return cached;
  }
  let value: string | undefined;
  try {
    const { host, organization, project } = AZURE_DEVOPS_CONFIG;
    const url = `https://${host}/${organization}/${encodeURIComponent(project)}/${encodeURIComponent(teamId)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=${API_VERSION}`;
    const response = await azureDevOpsFetchUrl(
      repoRoot,
      url,
      'team iteration',
      'GET',
      undefined,
      'application/json',
      'application/json'
    );
    const parsed = teamIterationsSchema.safeParse(await response.json());
    const iterations = parsed.success ? parsed.data.value : [];
    // `$timeframe=current` should pre-filter to the active sprint, but if the org/api-version ignores it the
    // endpoint returns every iteration oldest-first - so never blindly take value[0] (that lands bugs in an
    // ancient sprint). Pick the one ADO marks current, else one whose dates span today; if none is genuinely
    // current, leave undefined so the caller falls back to the project's current sprint.
    const current =
      iterations.find((iteration) => iteration.attributes?.timeFrame?.toLowerCase() === 'current') ??
      iterations.find((iteration) => iterationSpansNow(iteration.attributes));
    value = current?.path;
  } catch {
    value = undefined;
  }
  teamIterationCache.set(teamId, value);
  return value;
}

function normalizeAreaPath(areaPath: string): string {
  return areaPath.replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '').trim().toLowerCase();
}

// A team's configured area paths (System.AreaPath team field values) - the precise ADO mapping of which team
// owns which area path. Cached per team.
async function teamFieldValues(repoRoot: string, teamId: string): Promise<readonly TeamAreaEntry[]> {
  const cached = teamFieldCache.get(teamId);
  if (cached !== undefined) {
    return cached;
  }
  let value: readonly TeamAreaEntry[] = [];
  try {
    const { host, organization, project } = AZURE_DEVOPS_CONFIG;
    const url = `https://${host}/${organization}/${encodeURIComponent(project)}/${encodeURIComponent(teamId)}/_apis/work/teamsettings/teamfieldvalues?api-version=${API_VERSION}`;
    const response = await azureDevOpsFetchUrl(
      repoRoot,
      url,
      'team field values',
      'GET',
      undefined,
      'application/json',
      'application/json'
    );
    const parsed = teamFieldValuesSchema.safeParse(await response.json());
    if (parsed.success) {
      value = parsed.data.values.map((entry) => ({
        areaPath: normalizeAreaPath(entry.value),
        includeChildren: entry.includeChildren ?? true,
        teamId
      }));
    }
  } catch {
    value = [];
  }
  teamFieldCache.set(teamId, value);
  return value;
}

// Flatten every project team's configured area paths into one area-path -> team list. Cached project-wide.
async function teamAreaMap(repoRoot: string): Promise<readonly TeamAreaEntry[]> {
  if (cachedTeamAreas !== undefined && Date.now() - cachedTeamAreas.at < ITERATION_CACHE_MS) {
    return cachedTeamAreas.value;
  }
  const teams = await listProjectTeams(repoRoot);
  const perTeam = await Promise.all(teams.map((team) => teamFieldValues(repoRoot, team.id)));
  const value = perTeam.flat();
  cachedTeamAreas = { value, at: Date.now() };
  return value;
}

// Fallback heuristic: a team whose name lines up with a segment of the area path. Used only when the precise
// teamfieldvalues mapping yields no owning team.
async function resolveTeamIterationByName(repoRoot: string, areaPath: string): Promise<string | undefined> {
  const teams = await listProjectTeams(repoRoot);
  const areaTokens = areaPath
    .toLowerCase()
    .split('\\')
    .map((segment) => segment.replace(/[^a-z0-9]/g, ''))
    .filter((segment) => segment.length >= 4);
  const candidates = teams.filter((team) => {
    const name = team.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      name.length >= 4 && areaTokens.some((token) => token === name || token.includes(name) || name.includes(token))
    );
  });
  for (const team of candidates.slice(0, 3)) {
    const iteration = await teamCurrentIteration(repoRoot, team.id);
    if (iteration !== undefined) {
      return iteration;
    }
  }
  return undefined;
}

/**
 * Current iteration for the team that owns an area path. Precise path: match the team whose configured area
 * path (teamfieldvalues) is the longest prefix of the finding's area path - honoring includeChildren - then
 * read that team's current iteration. Falls back to a team-name heuristic, then undefined so the caller can
 * use the project iteration / ADO default. Cached per area path.
 */
export async function resolveTeamIterationPath(repoRoot: string, areaPath: string): Promise<string | undefined> {
  const cacheKey = areaPath.toLowerCase();
  if (areaIterationCache.has(cacheKey)) {
    return areaIterationCache.get(cacheKey);
  }
  let value: string | undefined;
  try {
    const target = normalizeAreaPath(areaPath);
    const areaMap = await teamAreaMap(repoRoot);
    let best: { readonly teamId: string; readonly length: number } | undefined;
    for (const entry of areaMap) {
      const owns = entry.includeChildren
        ? target === entry.areaPath || target.startsWith(`${entry.areaPath}\\`)
        : target === entry.areaPath;
      if (owns && (best === undefined || entry.areaPath.length > best.length)) {
        best = { teamId: entry.teamId, length: entry.areaPath.length };
      }
    }
    if (best !== undefined) {
      value = await teamCurrentIteration(repoRoot, best.teamId);
    }
    if (value === undefined) {
      value = await resolveTeamIterationByName(repoRoot, areaPath);
    }
  } catch {
    value = undefined;
  }
  areaIterationCache.set(cacheKey, value);
  return value;
}

/** Resolve (close) a work item by setting its ADO state to "Resolved" (used by audit auto-close). */
export async function resolveWorkItem(repoRoot: string, workItemId: number): Promise<void> {
  const url = `${buildProjectApiUrl(`/wit/workitems/${String(workItemId)}`)}?api-version=${API_VERSION}`;
  const response = await azureDevOpsFetchUrl(
    repoRoot,
    url,
    'resolve bug',
    'PATCH',
    JSON.stringify([{ op: 'add', path: '/fields/System.State', value: 'Resolved' }]),
    'application/json',
    'application/json-patch+json'
  );
  await response.text();
}

/** Set a work item's state back to an active state (used to reopen a bug marked fixed that Saturn still detects). */
export async function reactivateWorkItem(repoRoot: string, workItemId: number, state: string): Promise<void> {
  const url = `${buildProjectApiUrl(`/wit/workitems/${String(workItemId)}`)}?api-version=${API_VERSION}`;
  const response = await azureDevOpsFetchUrl(
    repoRoot,
    url,
    'reactivate bug',
    'PATCH',
    JSON.stringify([{ op: 'add', path: '/fields/System.State', value: state }]),
    'application/json',
    'application/json-patch+json'
  );
  await response.text();
}

const workItemStateSchema = z
  .object({
    fields: z.object({ 'System.State': z.string().optional(), 'System.Reason': z.string().optional() }).loose()
  })
  .loose();

/**
 * Read a work item's current State + Reason. Used to reconcile audit findings against how a human triaged
 * the linked bug (resolved/fixed, won't-fix, or needs-more-info). Returns undefined if the response is
 * unparseable.
 */
export async function getWorkItemState(
  repoRoot: string,
  workItemId: number
): Promise<{ state: string; reason: string } | undefined> {
  const url = `${buildProjectApiUrl(`/wit/workitems/${String(workItemId)}`)}?fields=System.State,System.Reason&api-version=${API_VERSION}`;
  const response = await azureDevOpsFetchUrl(
    repoRoot,
    url,
    'read work item state',
    'GET',
    undefined,
    'application/json',
    'application/json'
  );
  const data: unknown = await response.json();
  const parsed = workItemStateSchema.safeParse(data);
  if (!parsed.success) {
    return undefined;
  }
  return {
    state: parsed.data.fields['System.State'] ?? '',
    reason: parsed.data.fields['System.Reason'] ?? ''
  };
}

function refNameToBranch(refName: string | undefined): string {
  return refName?.replace(/^refs\/heads\//, '') ?? '';
}

/** List active pull requests for the target repo. Draft PRs are included here and filtered by the caller. */
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
    authorUniqueName: pullRequest.createdBy?.uniqueName,
    reviewers: (pullRequest.reviewers ?? []).map((reviewer) => ({
      displayName: reviewer.displayName ?? '',
      uniqueName: reviewer.uniqueName
    })),
    webUrl: buildPullRequestWebUrl(pullRequest.pullRequestId),
    createdAt: pullRequest.creationDate
  }));
}

const singlePullRequestSchema = z
  .object({
    pullRequestId: z.number(),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    isDraft: z.boolean().optional(),
    sourceRefName: z.string().optional(),
    targetRefName: z.string().optional(),
    createdBy: z.object({ displayName: z.string().optional(), uniqueName: z.string().optional() }).optional(),
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
    authorUniqueName: pullRequest.createdBy?.uniqueName,
    webUrl: buildPullRequestWebUrl(pullRequest.pullRequestId),
    createdAt: pullRequest.creationDate
  };
}

/** Inputs for opening a pull request from a fix branch. */
export interface CreatePullRequestInput {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
  readonly workItemId?: number;
  readonly isDraft?: boolean;
}

const createdPullRequestSchema = z.object({ pullRequestId: z.number() }).loose();

/** Open a pull request from `sourceBranch` into `targetBranch`, optionally linking a work item (the bug). */
export async function createPullRequest(
  repoRoot: string,
  input: CreatePullRequestInput
): Promise<{ id: number; url: string }> {
  const url = `${buildRepositoryApiUrl('/pullrequests')}?api-version=${API_VERSION}`;
  const body: Record<string, unknown> = {
    sourceRefName: `refs/heads/${input.sourceBranch}`,
    targetRefName: `refs/heads/${input.targetBranch}`,
    title: input.title,
    description: input.description,
    isDraft: input.isDraft ?? false
  };
  if (input.workItemId !== undefined) {
    body.workItemRefs = [{ id: String(input.workItemId) }];
  }
  const response = await azureDevOpsFetchUrl(
    repoRoot,
    url,
    'create pull request',
    'POST',
    JSON.stringify(body),
    'application/json',
    'application/json'
  );
  const data: unknown = await response.json();
  const parsed = createdPullRequestSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Azure DevOps create pull request returned an unexpected response shape.');
  }
  return { id: parsed.data.pullRequestId, url: buildPullRequestWebUrl(parsed.data.pullRequestId) };
}

const pullRequestProgressSchema = z
  .object({
    status: z.string().optional(),
    mergeStatus: z.string().optional(),
    isDraft: z.boolean().optional(),
    sourceRefName: z.string().optional(),
    targetRefName: z.string().optional(),
    repository: z
      .object({ project: z.object({ id: z.string().optional() }).loose().optional() })
      .loose()
      .optional()
  })
  .loose();

/** A pull request's lifecycle + mergeability, used by Code Autopilot's monitor loop. */
export interface PullRequestProgress {
  /** 'active' | 'completed' (merged) | 'abandoned' | other. */
  readonly status: string;
  /** 'succeeded' | 'conflicts' | 'queued' | 'rejectedByPolicy' | '' (unknown). */
  readonly mergeStatus: string;
  readonly isDraft: boolean;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  /** The ADO project GUID (needed to query policy evaluations / build-validation results). */
  readonly projectId: string;
}

/** Read a PR's lifecycle status + merge status. Returns undefined when the PR no longer exists. */
export async function getPullRequestProgress(
  repoRoot: string,
  pullRequestId: number
): Promise<PullRequestProgress | undefined> {
  let raw: unknown;
  try {
    raw = await azureDevOpsGetJson(repoRoot, `/pullRequests/${String(pullRequestId)}?api-version=${API_VERSION}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('(404)')) {
      return undefined;
    }
    throw error;
  }
  const parsed = pullRequestProgressSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return {
    status: parsed.data.status ?? 'active',
    mergeStatus: parsed.data.mergeStatus ?? '',
    isDraft: parsed.data.isDraft ?? false,
    sourceBranch: refNameToBranch(parsed.data.sourceRefName),
    targetBranch: refNameToBranch(parsed.data.targetRefName),
    projectId: parsed.data.repository?.project?.id ?? ''
  };
}

const pullRequestThreadsSchema = z
  .object({
    value: z
      .array(
        z
          .object({
            status: z.string().optional(),
            isDeleted: z.boolean().optional(),
            comments: z
              .array(
                z
                  .object({
                    content: z.string().optional(),
                    commentType: z.string().optional(),
                    author: z.object({ displayName: z.string().optional() }).loose().optional()
                  })
                  .loose()
              )
              .optional()
          })
          .loose()
      )
      .optional()
  })
  .loose();

/** A PR comment thread, narrowed to the fields the fix agent's feedback extraction needs. */
export interface PullRequestThreadLike {
  readonly status?: string;
  readonly isDeleted?: boolean;
  readonly comments?: readonly { readonly content?: string; readonly commentType?: string }[];
}

/**
 * From a PR's threads, return the actionable human/review comment texts. Excludes resolved/closed/deleted
 * threads and non-actionable comments: ADO 'system' notes AND automated status reports. Build/coverage/lint/
 * bundle-size bots (e.g. office-fluid) post their reports as ordinary PR comments that carry NO real 'text'
 * commentType, so requiring commentType 'text' keeps genuine reviewer feedback while dropping those reports -
 * otherwise the agent wastes feedback rounds (and eventually gives up) trying to "fix" a coverage/lint summary.
 */
export function extractActiveReviewComments(threads: readonly PullRequestThreadLike[]): string[] {
  const open: string[] = [];
  for (const thread of threads) {
    if (thread.isDeleted === true) {
      continue;
    }
    const status = (thread.status ?? '').toLowerCase();
    if (status !== 'active' && status !== 'pending' && status !== '') {
      continue;
    }
    for (const comment of thread.comments ?? []) {
      const type = (comment.commentType ?? '').toLowerCase();
      const content = (comment.content ?? '').trim();
      if (type !== 'text' || content === '') {
        continue;
      }
      open.push(content);
    }
  }
  return open;
}

/**
 * The text of unresolved (active/pending) human review comments on a PR - the actionable feedback the fix
 * agent must address. System threads (status changes, build links), automated status/report comments
 * (build/coverage/lint/bundle-size bots), and empty comments are skipped.
 */
export async function getActivePullRequestComments(
  repoRoot: string,
  pullRequestId: number
): Promise<readonly string[]> {
  const raw = await azureDevOpsGetJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads?api-version=${API_VERSION}`
  );
  const parsed = pullRequestThreadsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.value === undefined) {
    return [];
  }
  return extractActiveReviewComments(parsed.data.value);
}

/** A PR thread narrowed for bot-comment handling (carries the thread id so the agent can reply + resolve it). */
export interface BotCommentThreadLike {
  readonly id?: number;
  readonly status?: string | number;
  readonly isDeleted?: boolean;
  readonly comments?: readonly { readonly content?: string; readonly commentType?: string }[];
}

/** An automated (bot) comment thread the agent may rebut: its thread id and the bot's text. */
export interface BotCommentThread {
  readonly threadId: number;
  readonly content: string;
}

/** Hidden marker the agent stamps on its bot-rebuttal replies, so a thread is never rebutted twice. */
export const SATURN_BOT_REBUTTAL_MARKER = '<!-- saturn-bot-rebuttal -->';

/**
 * From a PR's threads, return the UNRESOLVED automated/bot comment threads (with their ids). A "bot thread"
 * is an active/pending thread whose comments are all automation-posted - none is a genuine human 'text'
 * comment or an ADO 'system' note (build/coverage/lint/bundle-size bots post with an empty commentType).
 * Threads the agent already rebutted (they carry SATURN_BOT_REBUTTAL_MARKER) are excluded.
 */
export function extractBotCommentThreads(threads: readonly BotCommentThreadLike[]): BotCommentThread[] {
  const result: BotCommentThread[] = [];
  for (const thread of threads) {
    if (thread.isDeleted === true || thread.id === undefined) {
      continue;
    }
    const status = String(thread.status ?? '').toLowerCase();
    if (status !== 'active' && status !== 'pending' && status !== '') {
      continue;
    }
    const comments = thread.comments ?? [];
    if (comments.some((comment) => (comment.content ?? '').includes(SATURN_BOT_REBUTTAL_MARKER))) {
      continue;
    }
    // A genuine human ('text') or ADO ('system') comment means this is NOT a pure bot thread - leave it to
    // the normal review-comment path (extractActiveReviewComments).
    const hasHumanOrSystem = comments.some((comment) => {
      const type = (comment.commentType ?? '').toLowerCase();
      return type === 'text' || type === 'system';
    });
    if (hasHumanOrSystem) {
      continue;
    }
    const content = comments
      .map((comment) => (comment.content ?? '').trim())
      .filter((text) => text !== '')
      .join('\n');
    if (content === '') {
      continue;
    }
    result.push({ threadId: thread.id, content });
  }
  return result;
}

const botCommentThreadsSchema = z
  .object({
    value: z
      .array(
        z
          .object({
            id: z.number().optional(),
            status: z.union([z.string(), z.number()]).optional(),
            isDeleted: z.boolean().optional(),
            comments: z
              .array(z.object({ content: z.string().optional(), commentType: z.string().optional() }).loose())
              .optional()
          })
          .loose()
      )
      .optional()
  })
  .loose();

/** Fetch the PR's unresolved automated/bot comment threads (see extractBotCommentThreads). */
export async function getActiveBotCommentThreads(
  repoRoot: string,
  pullRequestId: number
): Promise<readonly BotCommentThread[]> {
  const raw = await azureDevOpsGetJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads?api-version=${API_VERSION}`
  );
  const parsed = botCommentThreadsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.value === undefined) {
    return [];
  }
  return extractBotCommentThreads(parsed.data.value);
}

const policyEvaluationsSchema = z
  .object({
    value: z
      .array(
        z
          .object({
            evaluationId: z.string().optional(),
            status: z.string().optional(),
            configuration: z
              .object({
                type: z.object({ displayName: z.string().optional() }).loose().optional(),
                settings: z.object({ displayName: z.string().optional() }).loose().optional()
              })
              .loose()
              .optional(),
            context: z.object({ buildId: z.number().optional(), isExpired: z.boolean().optional() }).loose().optional()
          })
          .loose()
      )
      .optional()
  })
  .loose();

const pullRequestStatusesSchema = z
  .object({
    value: z
      .array(
        z
          .object({
            state: z.string().optional(),
            description: z.string().optional(),
            targetUrl: z.string().optional(),
            context: z.object({ name: z.string().optional(), genre: z.string().optional() }).loose().optional()
          })
          .loose()
      )
      .optional()
  })
  .loose();

const BUILD_ID_FROM_URL = /(?:buildid=|\/builds\/)(\d+)/i;

/** A PR's check state, distilled for Code Autopilot's monitor loop. */
export interface PullRequestChecks {
  /** Genuine failures that need a CODE fix (rejected build validations + failed CI statuses), with logs. */
  readonly failures: readonly string[];
  /** EXPIRED build-validation policies that can be re-queued (the PR "Re-queue" button), with their names. */
  readonly requeueable: readonly { readonly evaluationId: string; readonly name: string }[];
  /** True while a required build/policy is still queued or running (so the agent waits instead of re-pushing). */
  readonly inProgress: boolean;
}

/** Parse an Azure DevOps build id out of a status/target URL (e.g. `.../_build/results?buildId=123`). */
function parseBuildIdFromUrl(url: string | undefined): number | undefined {
  if (url === undefined) {
    return undefined;
  }
  const match = BUILD_ID_FROM_URL.exec(url);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const id = Number.parseInt(match[1], 10);
  return Number.isNaN(id) ? undefined : id;
}

/**
 * Inspect a PR's branch-policy evaluations + CI statuses and distill them into: genuine failures (needing a
 * code fix, with build error logs attached), EXPIRED checks that just need re-queuing (no code change), and
 * whether anything is still running. This is what lets Code Autopilot fix red builds, re-queue stale ones,
 * and wait for in-flight ones - like a developer would. Best-effort: every query is guarded so a partial
 * signal still gets through.
 */
export async function getPullRequestChecks(
  repoRoot: string,
  pullRequestId: number,
  projectId: string
): Promise<PullRequestChecks> {
  const failures: string[] = [];
  const requeueable: { evaluationId: string; name: string }[] = [];
  let inProgress = false;

  // 1) Branch-policy evaluations (build validation, compliance gates, ...).
  if (projectId !== '') {
    try {
      const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${String(pullRequestId)}`;
      const url = `${buildProjectApiUrl('/policy/evaluations')}?artifactId=${encodeURIComponent(artifactId)}&api-version=${API_VERSION}`;
      const response = await azureDevOpsFetchUrl(
        repoRoot,
        url,
        'read PR policy evaluations',
        'GET',
        undefined,
        'application/json',
        'application/json'
      );
      const parsed = policyEvaluationsSchema.safeParse(await response.json());
      for (const evaluation of parsed.data?.value ?? []) {
        const status = (evaluation.status ?? '').toLowerCase();
        if (status === 'running' || status === 'queued') {
          inProgress = true;
        }
        // An EXPIRED build result just needs to be re-run - re-queue it, no code change.
        if (evaluation.context?.isExpired === true && evaluation.evaluationId !== undefined) {
          const expiredKind = evaluation.configuration?.type?.displayName ?? 'Policy';
          const expiredName = evaluation.configuration?.settings?.displayName ?? expiredKind;
          requeueable.push({ evaluationId: evaluation.evaluationId, name: expiredName });
          continue;
        }
        if (status !== 'rejected') {
          continue;
        }
        const kind = evaluation.configuration?.type?.displayName ?? 'Policy';
        const name = evaluation.configuration?.settings?.displayName ?? '';
        let line = name !== '' ? `${kind} check failed: ${name}` : `${kind} check failed`;
        // For a failed build-validation policy, pull the build's actual error logs so the agent fixes the
        // root cause instead of just knowing a check is red.
        const buildId = evaluation.context?.buildId;
        if (buildId !== undefined) {
          const details = await getBuildFailureDetails(repoRoot, buildId);
          if (details !== '') {
            line += `\n${details}`;
          }
        }
        failures.push(line);
      }
    } catch {
      /* best-effort: policy evaluations unavailable this round */
    }
  }

  // 2) PR statuses posted by CI/build pipelines.
  try {
    const raw = await azureDevOpsGetJson(
      repoRoot,
      `/pullRequests/${String(pullRequestId)}/statuses?api-version=${API_VERSION}`
    );
    const parsed = pullRequestStatusesSchema.safeParse(raw);
    for (const status of parsed.data?.value ?? []) {
      const state = (status.state ?? '').toLowerCase();
      if (state === 'pending' || state === 'notset') {
        inProgress = true;
        continue;
      }
      if (state !== 'failed' && state !== 'error') {
        continue;
      }
      const name = status.context?.name ?? 'check';
      const description = (status.description ?? '').trim();
      let line = description !== '' ? `CI status "${name}" ${state}: ${description}` : `CI status "${name}" ${state}`;
      // Fall back to the build id embedded in the status target URL when the policy didn't expose one.
      const buildId = parseBuildIdFromUrl(status.targetUrl);
      if (buildId !== undefined) {
        const details = await getBuildFailureDetails(repoRoot, buildId);
        if (details !== '') {
          line += `\n${details}`;
        }
      }
      failures.push(line);
    }
  } catch {
    /* best-effort: PR statuses unavailable this round */
  }

  return { failures: [...new Set(failures)], requeueable, inProgress };
}

/**
 * Re-queue a policy evaluation (the API behind the PR "Re-queue" button) - used to re-run an EXPIRED build
 * validation with no code change. Best-effort: returns true on success, false when the PATCH fails.
 */
export async function requeuePolicyEvaluation(repoRoot: string, evaluationId: string): Promise<boolean> {
  try {
    const url = `${buildProjectApiUrl(`/policy/evaluations/${evaluationId}`)}?api-version=${API_VERSION}`;
    const response = await azureDevOpsFetchUrl(
      repoRoot,
      url,
      're-queue policy evaluation',
      'PATCH',
      undefined,
      'application/json',
      'application/json'
    );
    await response.text();
    return true;
  } catch {
    return false;
  }
}

const buildTimelineSchema = z
  .object({
    records: z
      .array(
        z
          .object({
            type: z.string().optional(),
            name: z.string().optional(),
            result: z.string().optional(),
            log: z.object({ id: z.number().optional() }).loose().optional(),
            issues: z
              .array(z.object({ type: z.string().optional(), message: z.string().optional() }).loose())
              .optional()
          })
          .loose()
      )
      .optional()
  })
  .loose();

const MAX_BUILD_LOG_CHARS = 2500;
const MAX_BUILD_ERROR_ISSUES = 10;
const MAX_BUILD_FAILED_TASK_LOGS = 2;

/**
 * Root-cause detail for a FAILED build: the failing timeline records' error issues (compiler / test / lint
 * errors) plus a tail of the first failing task's log. This is what lets Code Autopilot fix the ACTUAL error
 * instead of just knowing "a build failed". Best-effort + bounded; returns a readable multi-line string, or
 * '' when nothing useful is found.
 */
async function getBuildFailureDetails(repoRoot: string, buildId: number): Promise<string> {
  let timelineRaw: unknown;
  try {
    const url = `${buildProjectApiUrl(`/build/builds/${String(buildId)}/timeline`)}?api-version=${API_VERSION}`;
    const response = await azureDevOpsFetchUrl(
      repoRoot,
      url,
      'read build timeline',
      'GET',
      undefined,
      'application/json',
      'application/json'
    );
    timelineRaw = await response.json();
  } catch {
    return '';
  }
  const records = buildTimelineSchema.safeParse(timelineRaw).data?.records ?? [];
  const failedRecords = records.filter((record) => (record.result ?? '').toLowerCase() === 'failed');

  // Compiler / test / lint errors surfaced as timeline "issues" - usually the exact root cause.
  const errorLines: string[] = [];
  for (const record of failedRecords) {
    for (const issue of record.issues ?? []) {
      if ((issue.type ?? '').toLowerCase() !== 'error') {
        continue;
      }
      const message = (issue.message ?? '').trim();
      if (message === '') {
        continue;
      }
      const where = (record.name ?? '').trim();
      errorLines.push(where !== '' ? `[${where}] ${message}` : message);
      if (errorLines.length >= MAX_BUILD_ERROR_ISSUES) {
        break;
      }
    }
    if (errorLines.length >= MAX_BUILD_ERROR_ISSUES) {
      break;
    }
  }

  // Tails of up to a couple of failing tasks' logs (the real error when issues[] is empty, e.g. a crashed
  // step; also covers multi-stage builds where several stages fail).
  const failedTasksWithLogs = failedRecords
    .filter((record) => (record.type ?? '').toLowerCase() === 'task' && record.log?.id !== undefined)
    .slice(0, MAX_BUILD_FAILED_TASK_LOGS);
  const logTails: string[] = [];
  for (const record of failedTasksWithLogs) {
    const logId = record.log?.id;
    if (logId === undefined) {
      continue;
    }
    try {
      const logUrl = `${buildProjectApiUrl(`/build/builds/${String(buildId)}/logs/${String(logId)}`)}?api-version=${API_VERSION}`;
      const logResponse = await azureDevOpsFetchUrl(
        repoRoot,
        logUrl,
        'read build log',
        'GET',
        undefined,
        'text/plain',
        'application/json'
      );
      const logText = await logResponse.text();
      const tail = logText.length > MAX_BUILD_LOG_CHARS ? `...${logText.slice(-MAX_BUILD_LOG_CHARS)}` : logText;
      const where = (record.name ?? '').trim();
      if (tail.trim() !== '') {
        logTails.push(where !== '' ? `[${where}]\n${tail.trim()}` : tail.trim());
      }
    } catch {
      /* best-effort: build log unavailable */
    }
  }

  const parts: string[] = [];
  if (errorLines.length > 0) {
    parts.push(`build #${String(buildId)} errors:\n${errorLines.map((errorLine) => `    ${errorLine}`).join('\n')}`);
  }
  if (logTails.length > 0) {
    parts.push(`build #${String(buildId)} log tail:\n${logTails.join('\n---\n')}`);
  }
  return parts.join('\n');
}

/** Fetch a pull request's description (the author's stated intent), or undefined when it has none. */
export async function getPullRequestDescription(repoRoot: string, pullRequestId: number): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = await azureDevOpsGetJson(repoRoot, `/pullRequests/${String(pullRequestId)}?api-version=${API_VERSION}`);
  } catch {
    return undefined;
  }
  const parsed = singlePullRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const description = parsed.data.description;
  return description !== undefined && description.trim() !== '' ? description.trim() : undefined;
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
  /** True when this is one of Saturn's own threads (its content carries the bot review marker or iteration tag). */
  readonly isSaturn: boolean;
  /** True when a non-Saturn author has replied on a Saturn thread (the author engaged - do not auto-reactivate). */
  readonly hasHumanReply: boolean;
  /** The concatenated text of the author's (non-Saturn) replies on a Saturn thread, for reply classification. */
  readonly humanReplyText: string;
  /** True when the most recent comment on a Saturn thread is the author's (so it is Saturn's turn to respond). */
  readonly lastCommentIsHuman: boolean;
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
  return parsed.value.map((thread) => {
    const comments = thread.comments ?? [];
    const content = comments.map((comment) => comment.content ?? '').join('\n');
    // A comment is Saturn's when it carries the review marker (lead comment) or an iteration tag (reply).
    const isSaturnComment = (text: string): boolean =>
      text.includes(BOT_REVIEW_MARKER) || text.includes('saturn-iter:');
    const isSaturn = comments.some((comment) => isSaturnComment(comment.content ?? ''));
    const hasHumanReply =
      isSaturn && comments.some((comment) => (comment.content ?? '') !== '' && !isSaturnComment(comment.content ?? ''));
    const humanReplyText = comments
      .filter((comment) => (comment.content ?? '') !== '' && !isSaturnComment(comment.content ?? ''))
      .map((comment) => comment.content ?? '')
      .join('\n')
      .trim();
    const lastComment = comments.at(-1);
    const lastCommentIsHuman =
      isSaturn &&
      lastComment !== undefined &&
      (lastComment.content ?? '') !== '' &&
      !isSaturnComment(lastComment.content ?? '');
    return {
      threadId: thread.id,
      status: thread.status === undefined ? undefined : String(thread.status),
      filePath: thread.threadContext?.filePath ?? '',
      line: thread.threadContext?.rightFileStart?.line,
      content,
      isSaturn,
      hasHumanReply,
      humanReplyText,
      lastCommentIsHuman
    };
  });
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
const THREAD_STATUS_WONTFIX = 3;

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

/** Post a plain reply comment on an existing thread WITHOUT changing its status (e.g. answering an author's question). */
export async function postThreadReply(
  repoRoot: string,
  pullRequestId: number,
  threadId: number,
  content: string
): Promise<void> {
  await azureDevOpsPostJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads/${String(threadId)}/comments?api-version=${API_VERSION}`,
    { parentCommentId: 1, content, commentType: 1 }
  );
}

/**
 * Set an existing thread's status (e.g. 2 = Fixed when a later iteration addresses the finding) and,
 * optionally, post a short closing reply. Used to auto-resolve Saturn's own threads once the issue no
 * longer appears in the diff.
 */
export async function setThreadStatus(
  repoRoot: string,
  pullRequestId: number,
  threadId: number,
  status: number,
  replyContent?: string
): Promise<void> {
  await azureDevOpsPatchJson(
    repoRoot,
    `/pullRequests/${String(pullRequestId)}/threads/${String(threadId)}?api-version=${API_VERSION}`,
    { status }
  );
  if (replyContent !== undefined && replyContent !== '') {
    await azureDevOpsPostJson(
      repoRoot,
      `/pullRequests/${String(pullRequestId)}/threads/${String(threadId)}/comments?api-version=${API_VERSION}`,
      { parentCommentId: 1, content: replyContent, commentType: 1 }
    );
  }
}

/**
 * Rebut a non-actionable automated/bot comment: post a one-time explanation reply and mark the thread
 * "won't fix" (status 3) so it stops gating the PR and the bot's owner sees why the agent isn't acting.
 */
export async function markThreadWontFix(
  repoRoot: string,
  pullRequestId: number,
  threadId: number,
  replyContent: string
): Promise<void> {
  await setThreadStatus(repoRoot, pullRequestId, threadId, THREAD_STATUS_WONTFIX, replyContent);
}
