// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/* eslint-disable no-console -- a CLI helper that reports progress and actionable failures directly. */
// Registers (or lists) the Azure DevOps service hooks that wake Saturn's Code Autopilot the moment a PR is
// updated or a build completes, instead of waiting for the next poll. The dashboard already exposes the
// receiver at POST /api/hooks/ado (guarded by SATURN_WEBHOOK_SECRET); this script points ADO at it.
//
// Usage (from the repo root):
//   node scripts/registerAdoServiceHook.cjs --url https://<public-host>/api/hooks/ado [options]
//   node scripts/registerAdoServiceHook.cjs --list
//
// Options:
//   --url <url>        Public URL of the dashboard's receiver (e.g. the devtunnel URL + /api/hooks/ado).
//   --events <list>    Comma-separated: pr,build (default: both).
//   --secret <value>   Shared secret; defaults to SATURN_WEBHOOK_SECRET (sent as the x-saturn-secret header).
//   --org/--project/--repo  Override the coordinates (otherwise read from .env / env vars).
//   --list             List existing webhook subscriptions for this org and exit.
//   --dry-run          Print what would be created without calling ADO.
//
// Auth: uses SATURN_ADO_PAT (Basic) when set, else `az account get-access-token` (the same path the agent
// uses). Registering subscriptions needs project-level "Edit subscriptions" permission.
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const packageRoot = path.resolve(__dirname, '..');
const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

// --- .env loading (mirrors how the deployed agent picks up its config) -----------------------------------
function loadEnvFile(file) {
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trim().startsWith('#')) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = { events: 'pr,build', list: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') {
      args.list = true;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      i += 1;
      args[key] = value;
    }
  }
  return args;
}

// Parse org/project/repo out of an ADO repo URL (.../_git/<repo>), supporting dev.azure.com and *.visualstudio.com.
function parseRepoUrl(raw) {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/').filter(Boolean);
    const gitIndex = parts.indexOf('_git');
    if (gitIndex < 1) {
      return undefined;
    }
    const repositoryName = decodeURIComponent(parts[gitIndex + 1] ?? '');
    const before = parts.slice(0, gitIndex).filter((p) => p.toLowerCase() !== 'defaultcollection');
    let organization;
    let project;
    if (u.hostname.endsWith('.visualstudio.com')) {
      organization = u.hostname.slice(0, -'.visualstudio.com'.length);
      project = before[0];
    } else {
      organization = before[0];
      project = before[1];
    }
    if (!organization || !project || !repositoryName) {
      return undefined;
    }
    return { organization, project, repositoryName };
  } catch {
    return undefined;
  }
}

function resolveCoordinates(args) {
  const parsed = (process.env.SATURN_REPO_URL ?? '').trim() ? parseRepoUrl(process.env.SATURN_REPO_URL.trim()) : undefined;
  const organization = args.org ?? parsed?.organization ?? process.env.SATURN_ADO_ORG;
  const project = args.project ?? parsed?.project ?? process.env.SATURN_ADO_PROJECT;
  const repository = args.repo ?? process.env.SATURN_ADO_REPO_ID ?? parsed?.repositoryName ?? process.env.SATURN_ADO_REPO_NAME;
  if (!organization || !project || !repository) {
    throw new Error(
      'Could not resolve org/project/repo. Set SATURN_REPO_URL (or SATURN_ADO_ORG/PROJECT/REPO_NAME) in .env, or pass --org/--project/--repo.'
    );
  }
  return { organization, project, repository };
}

function resolveAuthHeader() {
  const pat = (process.env.SATURN_ADO_PAT ?? '').trim();
  if (pat !== '') {
    return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }
  try {
    const out = execFileSync(
      'az',
      ['account', 'get-access-token', '--resource', ADO_RESOURCE_ID, '--output', 'json'],
      { encoding: 'utf8', shell: process.platform === 'win32' }
    );
    const token = JSON.parse(out).accessToken;
    if (typeof token === 'string' && token !== '') {
      return `Bearer ${token}`;
    }
  } catch {
    /* fall through to the error below */
  }
  throw new Error('No Azure DevOps credential. Set SATURN_ADO_PAT, or run `az login` so `az account get-access-token` works.');
}

function requestJson(method, urlString, authHeader, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(data === '' ? {} : JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${status} ${method} ${url.pathname}: ${data.slice(0, 600)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

function subscriptionBody(eventType, ids, url, secret) {
  const consumerInputs = { url, httpHeaders: `x-saturn-secret: ${secret}` };
  if (eventType === 'git.pullrequest.updated') {
    return {
      publisherId: 'tfs',
      eventType,
      resourceVersion: '1.0',
      consumerId: 'webHooks',
      consumerActionId: 'httpRequest',
      publisherInputs: { projectId: ids.projectId, repository: ids.repositoryId },
      consumerInputs
    };
  }
  // build.complete
  return {
    publisherId: 'tfs',
    eventType,
    resourceVersion: '1.0',
    consumerId: 'webHooks',
    consumerActionId: 'httpRequest',
    publisherInputs: { projectId: ids.projectId, definitionId: '', buildStatus: '' },
    consumerInputs
  };
}

async function main() {
  loadEnvFile(path.join(packageRoot, '.env'));
  const args = parseArgs(process.argv.slice(2));
  const { organization, project, repository } = resolveCoordinates(args);
  const authHeader = resolveAuthHeader();
  const base = `https://dev.azure.com/${encodeURIComponent(organization)}`;

  if (args.list) {
    const existing = await requestJson('GET', `${base}/_apis/hooks/subscriptions?api-version=7.1`, authHeader);
    const hooks = (existing.value ?? []).filter((s) => s.consumerId === 'webHooks');
    console.log(`Found ${hooks.length} webhook subscription(s) in ${organization}:`);
    for (const s of hooks) {
      console.log(`  - ${s.eventType}  ->  ${s.consumerInputs?.url ?? '(no url)'}  [${s.id}]`);
    }
    return;
  }

  const url = (args.url ?? process.env.SATURN_WEBHOOK_URL ?? '').trim();
  const secret = (args.secret ?? process.env.SATURN_WEBHOOK_SECRET ?? '').trim();
  if (url === '') {
    throw new Error('Missing --url (the public URL of the dashboard receiver, e.g. https://<host>/api/hooks/ado).');
  }
  if (secret === '') {
    throw new Error('Missing secret. Set SATURN_WEBHOOK_SECRET (or pass --secret); it must match the dashboard.');
  }

  const wanted = new Set(
    String(args.events)
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
  const eventTypes = [];
  if (wanted.has('pr')) {
    eventTypes.push('git.pullrequest.updated');
  }
  if (wanted.has('build')) {
    eventTypes.push('build.complete');
  }
  if (eventTypes.length === 0) {
    throw new Error('No events selected. Use --events pr,build (at least one of pr|build).');
  }

  // Resolve the project + repository GUIDs (publisherInputs require the project GUID).
  const projectInfo = await requestJson(
    'GET',
    `${base}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`,
    authHeader
  );
  const repoInfo = await requestJson(
    'GET',
    `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}?api-version=7.1`,
    authHeader
  );
  const ids = { projectId: projectInfo.id, repositoryId: repoInfo.id };
  console.log(`Project "${project}" = ${ids.projectId}`);
  console.log(`Repository "${repository}" = ${ids.repositoryId}`);

  // Skip events that already have a subscription pointing at this exact URL (so re-running is safe).
  const existing = await requestJson('GET', `${base}/_apis/hooks/subscriptions?api-version=7.1`, authHeader);
  const already = new Set(
    (existing.value ?? [])
      .filter((s) => s.consumerId === 'webHooks' && s.consumerInputs?.url === url)
      .map((s) => s.eventType)
  );

  for (const eventType of eventTypes) {
    if (already.has(eventType)) {
      console.log(`= already registered: ${eventType} -> ${url}`);
      continue;
    }
    const body = subscriptionBody(eventType, ids, url, secret);
    if (args.dryRun) {
      console.log(`[dry-run] would create ${eventType} -> ${url}`);
      continue;
    }
    const created = await requestJson(
      'POST',
      `${base}/_apis/hooks/subscriptions?api-version=7.1`,
      authHeader,
      body
    );
    console.log(`+ created ${eventType} -> ${url}  [${created.id}]`);
  }
  console.log('\nDone. The dashboard must be reachable at the URL above (keep the tunnel up) for hooks to fire.');
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
