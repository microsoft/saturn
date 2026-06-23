// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type AuditFindingCandidate,
  closeAuditDb,
  countAuditFindings,
  dismissAuditFinding,
  findExistingBugForLocation,
  getAuditFindingById,
  queryAuditFindings,
  queryAuditPackageCounts,
  queryAuditStatusCounts,
  queryAuditSummary,
  queryFindingsForBugPoll,
  recoverAuditFinding,
  recordBugState,
  recordScannedFiles,
  scannedFileHashes,
  setAuditFindingBug,
  setAuditFindingStatus,
  touchFindingsForFiles,
  upsertAuditFindings
} from './auditStore';

function makeCandidate(overrides: Partial<AuditFindingCandidate> = {}): AuditFindingCandidate {
  return {
    filePath: 'packages/foo/src/a.ts',
    line: 1,
    severity: 'major',
    category: 'security',
    title: 'Issue',
    body: 'Body',
    confidence: 0.9,
    ...overrides
  };
}

describe('auditStore (sqlite)', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'saturn-audit-'));
    process.env.SATURN_AUDIT_DIR = directory;
    closeAuditDb();
  });

  afterEach(() => {
    closeAuditDb();
    delete process.env.SATURN_AUDIT_DIR;
    rmSync(directory, { recursive: true, force: true });
  });

  it('inserts new findings and refreshes existing ones by stable id', () => {
    const first = upsertAuditFindings([makeCandidate()], '2026-01-01T00:00:00Z', 1);
    expect(first).toEqual({ added: 1, refreshed: 0 });

    const second = upsertAuditFindings([makeCandidate({ body: 'Updated body' })], '2026-01-02T00:00:00Z', 2);
    expect(second).toEqual({ added: 0, refreshed: 1 });

    expect(countAuditFindings().total).toBe(1);
    const stored = queryAuditFindings({}, 50, 0).findings[0];
    expect(stored.body).toBe('Updated body');
    expect(stored.firstSeenAt).toBe('2026-01-01T00:00:00Z');
    expect(stored.lastSeenAt).toBe('2026-01-02T00:00:00Z');
  });

  it('paginates and filters by category and package', () => {
    const candidates: AuditFindingCandidate[] = [];
    for (let index = 0; index < 5; index += 1) {
      candidates.push(
        makeCandidate({
          title: `sec ${String(index)}`,
          severity: index % 2 === 0 ? 'major' : 'minor',
          category: 'security',
          filePath: `packages/foo/src/${String(index)}.ts`
        })
      );
    }
    candidates.push(makeCandidate({ title: 'priv', category: 'privacy', filePath: 'packages/bar/src/x.ts' }));
    upsertAuditFindings(candidates, '2026-01-01T00:00:00Z', 1);

    const firstPage = queryAuditFindings({ status: 'open' }, 3, 0);
    expect(firstPage.total).toBe(6);
    expect(firstPage.findings.length).toBe(3);

    const secondPage = queryAuditFindings({ status: 'open' }, 3, 3);
    expect(secondPage.findings.length).toBe(3);

    expect(queryAuditFindings({ status: 'open', category: 'security' }, 50, 0).total).toBe(5);
    expect(queryAuditFindings({ status: 'open', pkg: 'bar' }, 50, 0).total).toBe(1);
  });

  it('aggregates the summary by severity, category, and package', () => {
    upsertAuditFindings(
      [
        makeCandidate({ title: 'a', severity: 'major', category: 'security', filePath: 'packages/foo/src/a.ts' }),
        makeCandidate({ title: 'b', severity: 'minor', category: 'security', filePath: 'packages/foo/src/b.ts' }),
        makeCandidate({ title: 'c', severity: 'minor', category: 'privacy', filePath: 'packages/bar/src/c.ts' })
      ],
      '2026-01-01T00:00:00Z',
      1
    );

    const summary = queryAuditSummary({ status: 'open' });
    expect(summary.total).toBe(3);
    expect(summary.sev.minor).toBe(2);
    expect(summary.sev.major).toBe(1);
    expect(summary.byCategory.find((entry) => entry.category === 'security')?.count).toBe(2);
    expect(summary.bySeverity.find((entry) => entry.severity === 'minor')?.count).toBe(2);
    expect(summary.packages).toContain('packages/foo');
    expect(summary.packages).toContain('packages/bar');
  });

  it('scopes the by-severity breakdown to a selected category', () => {
    upsertAuditFindings(
      [
        makeCandidate({ title: 'a', severity: 'major', category: 'security', filePath: 'packages/foo/src/a.ts' }),
        makeCandidate({ title: 'b', severity: 'minor', category: 'privacy', filePath: 'packages/foo/src/b.ts' })
      ],
      '2026-01-01T00:00:00Z',
      1
    );

    const summary = queryAuditSummary({ status: 'open', category: 'security' });
    expect(summary.bySeverity.find((entry) => entry.severity === 'major')?.count).toBe(1);
    expect(summary.bySeverity.find((entry) => entry.severity === 'minor')?.count).toBe(0);
  });

  it('records a filed bug and reuses it for a duplicate at the same file + category + line', () => {
    upsertAuditFindings([makeCandidate({ line: 10 })], '2026-01-01T00:00:00Z', 1);
    const id = queryAuditFindings({}, 50, 0).findings[0].id;

    setAuditFindingBug(id, { bugId: 123, bugUrl: 'https://bug/123' });
    expect(getAuditFindingById(id)?.adoBugId).toBe(123);
    expect(countAuditFindings().withBug).toBe(1);

    const duplicate = findExistingBugForLocation('packages/foo/src/a.ts', 'security', 10, 'other-id');
    expect(duplicate?.bugId).toBe(123);
  });

  it('dismisses a finding so it drops out of the open scope but stays under the dismissed filter', () => {
    upsertAuditFindings([makeCandidate()], '2026-01-01T00:00:00Z', 1);
    const id = queryAuditFindings({}, 50, 0).findings[0].id;

    setAuditFindingStatus(id, 'dismissed');
    expect(countAuditFindings().open).toBe(0);
    expect(queryAuditFindings({ status: 'open' }, 50, 0).total).toBe(0);
    expect(queryAuditFindings({ status: 'dismissed' }, 50, 0).total).toBe(1);
  });

  it('records dismiss attribution (reason + alias) and clears it on recover', () => {
    upsertAuditFindings([makeCandidate()], '2026-01-01T00:00:00Z', 1);
    const id = queryAuditFindings({}, 50, 0).findings[0].id;

    const dismissed = dismissAuditFinding(id, 'false positive - validated upstream', 'alias@contoso.com');
    expect(dismissed?.status).toBe('dismissed');
    expect(dismissed?.dismissReason).toBe('false positive - validated upstream');
    expect(dismissed?.dismissedBy).toBe('alias@contoso.com');
    // Attribution survives a round-trip through SQLite (new columns persisted + read back).
    expect(getAuditFindingById(id)?.dismissReason).toBe('false positive - validated upstream');
    expect(getAuditFindingById(id)?.dismissedBy).toBe('alias@contoso.com');

    const recovered = recoverAuditFinding(id);
    expect(recovered?.status).toBe('open');
    expect(recovered?.dismissReason).toBeUndefined();
    expect(recovered?.dismissedBy).toBeUndefined();
  });

  it('aggregates status counts and top open packages for the dashboard', () => {
    upsertAuditFindings(
      [
        makeCandidate({ title: 'a', filePath: 'packages/foo/src/a.ts' }),
        makeCandidate({ title: 'b', filePath: 'packages/foo/src/b.ts' }),
        makeCandidate({ title: 'c', filePath: 'packages/bar/src/c.ts' })
      ],
      '2026-01-01T00:00:00Z',
      1
    );
    const barId = queryAuditFindings({ pkg: 'bar' }, 50, 0).findings[0].id;
    dismissAuditFinding(barId, 'not a real issue', 'me@contoso.com');

    const counts = queryAuditStatusCounts();
    expect(counts.total).toBe(3);
    expect(counts.open).toBe(2);
    expect(counts.dismissed).toBe(1);
    expect(counts.resolved).toBe(0);

    // Only open findings count toward package hotspots, so the dismissed packages/bar drops out.
    const pkgs = queryAuditPackageCounts(10);
    expect(pkgs[0]).toEqual({ package: 'packages/foo', count: 2 });
    expect(pkgs.find((entry) => entry.package === 'packages/bar')).toBeUndefined();
  });

  it('records and reads back scanned-file content hashes for incremental sweeps', () => {
    recordScannedFiles(
      [
        { filePath: 'packages/foo/src/a.ts', contentHash: 'hash-a' },
        { filePath: 'packages/foo/src/b.ts', contentHash: 'hash-b' }
      ],
      1
    );
    const hashes = scannedFileHashes(['packages/foo/src/a.ts', 'packages/foo/src/b.ts', 'packages/foo/src/c.ts']);
    expect(hashes.get('packages/foo/src/a.ts')).toBe('hash-a');
    expect(hashes.get('packages/foo/src/b.ts')).toBe('hash-b');
    expect(hashes.has('packages/foo/src/c.ts')).toBe(false);
  });

  it('touches open findings of unchanged files so reconcile keeps them', () => {
    upsertAuditFindings([makeCandidate()], '2026-01-01T00:00:00Z', 1);
    touchFindingsForFiles(['packages/foo/src/a.ts'], 5);
    expect(queryAuditFindings({}, 50, 0).findings[0].lastSeenSweep).toBe(5);
  });

  it('records bug state + fix verification and round-trips through SQLite', () => {
    upsertAuditFindings([makeCandidate()], '2026-01-01T00:00:00Z', 1);
    const id = queryAuditFindings({}, 50, 0).findings[0].id;
    setAuditFindingBug(id, { bugId: 321, bugUrl: 'https://bug/321' });

    const updated = recordBugState(id, {
      bugState: 'Resolved',
      bugStateReason: 'Fixed',
      bugStateCheckedAt: '2026-02-01T00:00:00Z',
      fixVerification: 'still-present'
    });
    expect(updated?.bugState).toBe('Resolved');
    expect(updated?.fixVerification).toBe('still-present');

    const reread = getAuditFindingById(id);
    expect(reread?.bugStateReason).toBe('Fixed');
    expect(reread?.bugStateCheckedAt).toBe('2026-02-01T00:00:00Z');
    expect(reread?.fixVerification).toBe('still-present');
  });

  it('selects only filed-bug findings whose state is stale (cooldown) for polling', () => {
    upsertAuditFindings(
      [
        makeCandidate({ title: 'bugged', filePath: 'packages/foo/src/bugged.ts' }),
        makeCandidate({ title: 'plain', filePath: 'packages/foo/src/plain.ts' })
      ],
      '2026-01-01T00:00:00Z',
      1
    );
    const page = queryAuditFindings({}, 50, 0).findings;
    const bugged = page.find((finding) => finding.title === 'bugged');
    const plain = page.find((finding) => finding.title === 'plain');
    expect(bugged).toBeDefined();
    expect(plain).toBeDefined();
    if (bugged === undefined || plain === undefined) {
      return;
    }
    setAuditFindingBug(bugged.id, { bugId: 11, bugUrl: 'https://bug/11' });

    // Never-polled filed-bug finding is due; the finding without a bug is excluded.
    const due = queryFindingsForBugPoll('2026-02-01T00:00:00Z', 10);
    expect(due.map((finding) => finding.id)).toEqual([bugged.id]);

    // After a recent check it is no longer due until the cooldown cutoff passes.
    recordBugState(bugged.id, { bugState: 'Active', bugStateReason: '', bugStateCheckedAt: '2026-02-01T12:00:00Z' });
    expect(queryFindingsForBugPoll('2026-02-01T06:00:00Z', 10)).toEqual([]);
    expect(queryFindingsForBugPoll('2026-02-02T00:00:00Z', 10).map((finding) => finding.id)).toEqual([bugged.id]);
  });

  it('hides won-t-fix findings from the open filter and surfaces them under the wontfix filter', () => {
    upsertAuditFindings([makeCandidate()], '2026-01-01T00:00:00Z', 1);
    const id = queryAuditFindings({}, 50, 0).findings[0].id;
    setAuditFindingBug(id, { bugId: 77, bugUrl: 'https://bug/77' });
    recordBugState(id, {
      bugState: 'Closed',
      bugStateReason: 'Duplicate',
      bugStateCheckedAt: '2026-02-01T00:00:00Z',
      bugTriage: 'wontfix'
    });

    // Still status='open', but excluded from the Open view and counted under wontfix instead.
    expect(queryAuditFindings({ status: 'open' }, 50, 0).total).toBe(0);
    expect(queryAuditFindings({ status: 'wontfix' }, 50, 0).total).toBe(1);
    const counts = queryAuditStatusCounts();
    expect(counts.open).toBe(0);
    expect(counts.wontfix).toBe(1);
  });
});
