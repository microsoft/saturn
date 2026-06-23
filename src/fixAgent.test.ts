// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, expect, it } from '@jest/globals';

import { packageOf, phaseForFiles, promotedPhase } from './fixAgent';

describe('fix phase classification', () => {
  it('groups package-rooted paths by their second path segment', () => {
    expect(packageOf('packages/foo/src/a.ts')).toBe('packages/foo');
    expect(packageOf('apps/bar/x.ts')).toBe('apps/bar');
    expect(packageOf('tools/saturn/src/y.ts')).toBe('tools/saturn');
    expect(packageOf('common/lib/z.ts')).toBe('common/lib');
    expect(packageOf('README.md')).toBe('README.md');
  });

  it('classifies the fix phase from the footprint', () => {
    // Phase 1: a single file (duplicates collapse).
    expect(phaseForFiles(['packages/foo/src/a.ts'])).toBe(1);
    expect(phaseForFiles(['packages/foo/src/a.ts', 'packages/foo/src/a.ts'])).toBe(1);
    // Phase 2: multiple files within one package.
    expect(phaseForFiles(['packages/foo/src/a.ts', 'packages/foo/src/b.ts'])).toBe(2);
    // Phase 3: files across multiple packages.
    expect(phaseForFiles(['packages/foo/src/a.ts', 'packages/bar/src/b.ts'])).toBe(3);
  });

  it('promotes one phase per failed attempt, capped at the configured max', () => {
    // With a phase-3 cap a bug walks 1 -> 2 -> 3 across failed attempts.
    expect(promotedPhase(1, 3)).toBe(2);
    expect(promotedPhase(2, 3)).toBe(3);
    expect(promotedPhase(3, 3)).toBe(3);
    // The cap is never exceeded.
    expect(promotedPhase(1, 2)).toBe(2);
    expect(promotedPhase(2, 2)).toBe(2);
    expect(promotedPhase(1, 1)).toBe(1);
  });
});
