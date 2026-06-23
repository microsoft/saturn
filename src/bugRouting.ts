// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { type AreaOwnerEntry, readAreaOwners } from './areaOwners';
import { bugAreaPath, bugIterationPath, bugTypeRoutes } from './config';

/** Ownership of a package, read from its `ownership.json` (owner emails + ADO area path). */
export interface Ownership {
  readonly owners: readonly string[];
  readonly areaPath: string;
  readonly adoTenant?: string;
  readonly distributionEmail?: string;
  /** Repo-relative directory where the ownership.json was found (the package root). */
  readonly packagePath: string;
}

/** One candidate ADO route a bug can be filed under, surfaced as an alternative in the dashboard. */
export interface BugRoute {
  /** Human label for the dropdown (e.g. "packages/foo owners"). */
  readonly label: string;
  readonly areaPath: string;
  readonly iterationPath?: string;
  /** Suggested assignee (package owner email/UPN), dropped automatically if ADO rejects the identity. */
  readonly assignedTo?: string;
  /** Where this route came from, for transparency in the UI. */
  readonly source: 'ownership' | 'type' | 'fallback';
  readonly owners?: readonly string[];
  readonly distributionEmail?: string;
}

const ownershipSchema = z.object({
  owners: z.array(z.string()).catch([]),
  areaPath: z.string().catch(''),
  adoTenant: z.string().optional(),
  distributionEmail: z.string().optional()
});

function readOwnershipFile(absolutePath: string): Omit<Ownership, 'packagePath'> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = ownershipSchema.safeParse(raw);
  if (!parsed.success || parsed.data.areaPath.trim() === '') {
    return undefined;
  }
  return {
    owners: parsed.data.owners,
    areaPath: parsed.data.areaPath.trim(),
    adoTenant: parsed.data.adoTenant,
    distributionEmail: parsed.data.distributionEmail
  };
}

/**
 * Resolve the nearest `ownership.json` for a repo-relative file path by walking up the directory tree
 * (package root, then ancestors, then the repo root). Returns the owning team's emails + ADO area path,
 * or undefined when no ownership.json is found.
 */
export function resolveOwnership(repoRoot: string, filePath: string): Ownership | undefined {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter((segment) => segment !== '');
  // Drop the filename; the remaining segments are the directory chain to walk up.
  segments.pop();

  while (segments.length > 0) {
    const dirRelative = segments.join('/');
    const candidate = path.join(repoRoot, dirRelative, 'ownership.json');
    if (existsSync(candidate)) {
      const ownership = readOwnershipFile(candidate);
      if (ownership !== undefined) {
        return { ...ownership, packagePath: dirRelative };
      }
    }
    segments.pop();
  }

  const rootCandidate = path.join(repoRoot, 'ownership.json');
  if (existsSync(rootCandidate)) {
    const ownership = readOwnershipFile(rootCandidate);
    if (ownership !== undefined) {
      return { ...ownership, packagePath: '' };
    }
  }
  return undefined;
}

function iterationFor(): string | undefined {
  const override = bugIterationPath();
  return override !== '' ? override : undefined;
}

// True when a finding's file lives under a curated vertical key (a repo path prefix).
function fileMatchesVerticalKey(filePath: string, key: string): boolean {
  const file = filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  return normalizedKey !== '' && (file === normalizedKey || file.startsWith(`${normalizedKey}/`));
}

// Keyword hints that map a finding category to a likely owning team, matched against each package's
// ownership.json area path + distribution email so type routes can be discovered without env config.
const CATEGORY_TEAM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  accessibility: ['a11y', 'accessib'],
  security: ['security'],
  privacy: ['privacy', 'gdpr', 'compliance'],
  telemetry: ['telemetry', 'diagnostic'],
  performance: ['perf'],
  dependency: ['dependenc', 'supplychain', 'supply-chain']
};
const DISCOVERY_ROOTS: readonly string[] = ['packages', 'apps', 'tools'];
const DISCOVERY_CACHE_MS = 6 * 60 * 60 * 1000;

interface DiscoveredRoute {
  readonly areaPath: string;
  readonly label: string;
}

let cachedDiscovery:
  | { readonly value: ReadonlyMap<string, readonly DiscoveredRoute[]>; readonly at: number }
  | undefined;

// Scan every package's ownership.json once and bucket area paths by the categories their area-path /
// distribution-email keywords suggest (e.g. an "a11y" team -> accessibility). Cached for a few hours.
function scanOwnershipForTypeRoutes(repoRoot: string): ReadonlyMap<string, readonly DiscoveredRoute[]> {
  const byCategory = new Map<string, DiscoveredRoute[]>();
  const seenByCategory = new Map<string, Set<string>>();
  for (const root of DISCOVERY_ROOTS) {
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
      const ownershipPath = path.join(repoRoot, root, entry.name, 'ownership.json');
      const ownership = existsSync(ownershipPath) ? readOwnershipFile(ownershipPath) : undefined;
      if (ownership === undefined) {
        continue;
      }
      const haystack = `${ownership.areaPath} ${ownership.distributionEmail ?? ''}`.toLowerCase();
      for (const category of Object.keys(CATEGORY_TEAM_SYNONYMS)) {
        const synonyms = CATEGORY_TEAM_SYNONYMS[category] ?? [];
        if (!synonyms.some((synonym) => haystack.includes(synonym))) {
          continue;
        }
        const seen = seenByCategory.get(category) ?? new Set<string>();
        const key = ownership.areaPath.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        seenByCategory.set(category, seen);
        const list = byCategory.get(category) ?? [];
        list.push({ areaPath: ownership.areaPath, label: `${root}/${entry.name} (${category} team)` });
        byCategory.set(category, list);
      }
    }
  }
  return byCategory;
}

function discoveredTypeRoutes(repoRoot: string, category: string): readonly DiscoveredRoute[] {
  if (cachedDiscovery === undefined || Date.now() - cachedDiscovery.at >= DISCOVERY_CACHE_MS) {
    cachedDiscovery = { value: scanOwnershipForTypeRoutes(repoRoot), at: Date.now() };
  }
  return cachedDiscovery.value.get(category.toLowerCase()) ?? [];
}

/**
 * Build the ordered list of candidate routes for a finding, newest-preferred first:
 *   1. the file's package owners (from ownership.json) - the default used for auto-filing,
 *   2. any per-type override (e.g. accessibility -> a11y team) configured via SATURN_BUG_TYPE_ROUTES,
 *   3. the optional env fallback area path.
 * De-duplicated by area path. The first entry is the route used when auto-filing or when the user does
 * not pick an alternative.
 */
export function buildBugRoutes(repoRoot: string, filePath: string, category: string): readonly BugRoute[] {
  const routes: BugRoute[] = [];
  const iterationPath = iterationFor();
  const curated = readAreaOwners().entries;

  // Curated vertical overrides win: when the file lives under a saved path prefix, route there first so the
  // operator can correct a wrong auto-derived package -> team mapping.
  for (const entry of curated) {
    if (entry.kind === 'vertical' && fileMatchesVerticalKey(filePath, entry.key)) {
      routes.push({
        label: entry.label ?? `${entry.key} (override)`,
        areaPath: entry.areaPath,
        iterationPath,
        assignedTo: entry.assignedTo,
        source: 'ownership'
      });
    }
  }

  const ownership = resolveOwnership(repoRoot, filePath);
  if (ownership !== undefined) {
    routes.push({
      label: `${ownership.packagePath === '' ? 'repo' : ownership.packagePath} owners`,
      areaPath: ownership.areaPath,
      iterationPath,
      assignedTo: ownership.owners[0],
      source: 'ownership',
      owners: ownership.owners,
      distributionEmail: ownership.distributionEmail
    });
  }

  // Curated horizontal owners for this category (e.g. security -> a security DL), offered as alternatives.
  for (const entry of curated) {
    if (entry.kind === 'horizontal' && entry.key.toLowerCase() === category.toLowerCase()) {
      routes.push({
        label: entry.label ?? `${entry.key} team`,
        areaPath: entry.areaPath,
        iterationPath,
        assignedTo: entry.assignedTo,
        source: 'type'
      });
    }
  }

  for (const typeRoute of bugTypeRoutes()) {
    if (typeRoute.category.toLowerCase() === category.toLowerCase() && typeRoute.areaPath.trim() !== '') {
      routes.push({
        label: typeRoute.label,
        areaPath: typeRoute.areaPath.trim(),
        iterationPath,
        assignedTo: typeRoute.assignedTo,
        source: 'type'
      });
    }
  }

  // Auto-discovered type routes (e.g. accessibility -> an a11y team) from ownership.json keywords.
  for (const discovered of discoveredTypeRoutes(repoRoot, category)) {
    routes.push({ label: discovered.label, areaPath: discovered.areaPath, iterationPath, source: 'type' });
  }

  const fallback = bugAreaPath();
  if (fallback !== '') {
    routes.push({ label: 'Configured fallback', areaPath: fallback, iterationPath, source: 'fallback' });
  }

  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = route.areaPath.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Auto-derived horizontal area-owner suggestions (category -> team) from ownership.json keywords, used to
 * prepopulate the dashboard's area-owners editor so curation starts from a sensible baseline rather than a
 * blank table.
 */
export function defaultHorizontalAreaOwners(repoRoot: string): readonly AreaOwnerEntry[] {
  const byCategory = scanOwnershipForTypeRoutes(repoRoot);
  const entries: AreaOwnerEntry[] = [];
  for (const [category, discovered] of byCategory) {
    for (const route of discovered) {
      entries.push({ kind: 'horizontal', key: category, areaPath: route.areaPath, label: route.label });
    }
  }
  return entries;
}
