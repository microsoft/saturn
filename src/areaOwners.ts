// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

/**
 * A curated owner mapping the dashboard lets viewers edit, so bug routing is not left to keyword guessing.
 * Two kinds of "area":
 *   - `vertical`   - a code slice: `key` is a repo path prefix (e.g. `packages/foo`); when a finding's file
 *                    lives under it, the bug routes to `areaPath` instead of the auto-derived package owner.
 *   - `horizontal` - a cross-cutting category: `key` is an audit category (e.g. `security`); findings of that
 *                    category offer `areaPath` as a routing option (so e.g. a security DL can be reached).
 */
export type AreaOwnerKind = 'vertical' | 'horizontal';

export interface AreaOwnerEntry {
  readonly kind: AreaOwnerKind;
  /** Vertical: a repo path prefix to match. Horizontal: an audit category name. */
  readonly key: string;
  /** The owning team's ADO area path the bug routes to. */
  readonly areaPath: string;
  /** Human label for the route dropdown (defaults to the key when omitted). */
  readonly label?: string;
  /** Optional default assignee (email/UPN); dropped automatically if ADO rejects the identity. */
  readonly assignedTo?: string;
}

export interface AreaOwnersConfig {
  readonly entries: readonly AreaOwnerEntry[];
}

const areaOwnerEntrySchema = z.object({
  kind: z.enum(['vertical', 'horizontal']),
  key: z.string(),
  areaPath: z.string(),
  label: z.string().optional(),
  assignedTo: z.string().optional()
});

const areaOwnersConfigSchema = z.object({
  entries: z.array(areaOwnerEntrySchema).catch([])
});

// Cap the curated list so a malformed or hostile POST can't write an unbounded file.
const MAX_AREA_OWNER_ENTRIES = 1000;

function auditDir(): string {
  return path.join(os.homedir(), '.saturn', 'audit');
}

function areaOwnersFilePath(): string {
  return path.join(auditDir(), 'areaOwners.json');
}

/** Read the curated area-owner entries. Returns an empty config when the store is absent or unreadable. */
export function readAreaOwners(): AreaOwnersConfig {
  const filePath = areaOwnersFilePath();
  if (!existsSync(filePath)) {
    return { entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { entries: [] };
  }
  const result = areaOwnersConfigSchema.safeParse(parsed);
  return result.success ? { entries: result.data.entries } : { entries: [] };
}

// Keep only well-formed entries (non-empty key + areaPath), trim whitespace, and bound the count.
function sanitizeEntries(entries: readonly AreaOwnerEntry[]): readonly AreaOwnerEntry[] {
  const cleaned: AreaOwnerEntry[] = [];
  for (const entry of entries) {
    const key = entry.key.trim();
    const areaPath = entry.areaPath.trim();
    if (key === '' || areaPath === '') {
      continue;
    }
    const label = entry.label?.trim();
    const assignedTo = entry.assignedTo?.trim();
    cleaned.push({
      kind: entry.kind,
      key,
      areaPath,
      label: label !== undefined && label !== '' ? label : undefined,
      assignedTo: assignedTo !== undefined && assignedTo !== '' ? assignedTo : undefined
    });
    if (cleaned.length >= MAX_AREA_OWNER_ENTRIES) {
      break;
    }
  }
  return cleaned;
}

/** Persist the curated area-owner entries (sanitized and bounded). Returns what was written. */
export function writeAreaOwners(entries: readonly AreaOwnerEntry[]): AreaOwnersConfig {
  const cleaned = sanitizeEntries(entries);
  mkdirSync(auditDir(), { recursive: true });
  writeFileSync(areaOwnersFilePath(), `${JSON.stringify({ entries: cleaned }, null, 2)}\n`, 'utf8');
  return { entries: cleaned };
}

/** Parse an untrusted request body into area-owner entries (drops anything malformed). */
export function areaOwnerEntriesFromBody(body: unknown): readonly AreaOwnerEntry[] {
  const parsed = z.object({ entries: z.array(areaOwnerEntrySchema).catch([]) }).safeParse(body);
  return parsed.success ? parsed.data.entries : [];
}
