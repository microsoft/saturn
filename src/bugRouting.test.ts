// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stub config so importing bugRouting does not require the live SATURN_* environment, and so the env
// fallback/type-route inputs are deterministic for these tests.
jest.mock('./config', () => ({
  bugAreaPath: () => '',
  bugIterationPath: () => '',
  bugTypeRoutes: () => []
}));

import { buildBugRoutes, resolveOwnership } from './bugRouting';

describe('ownership-based bug routing', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'saturn-routing-'));
    mkdirSync(path.join(root, 'packages', 'foo', 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages', 'foo', 'ownership.json'),
      JSON.stringify({ owners: ['alice@example.com', 'bob@example.com'], areaPath: 'Project\\Team\\Foo' })
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the nearest ownership.json walking up from a file', () => {
    const ownership = resolveOwnership(root, 'packages/foo/src/deep/a.ts');
    expect(ownership?.areaPath).toBe('Project\\Team\\Foo');
    expect(ownership?.owners[0]).toBe('alice@example.com');
    expect(ownership?.packagePath).toBe('packages/foo');
  });

  it('returns undefined when no ownership.json is on the path', () => {
    expect(resolveOwnership(root, 'packages/bar/src/a.ts')).toBeUndefined();
  });

  it('builds the package-owner route as the default first candidate', () => {
    const routes = buildBugRoutes(root, 'packages/foo/src/a.ts', 'security');
    expect(routes).toHaveLength(1);
    expect(routes[0].source).toBe('ownership');
    expect(routes[0].areaPath).toBe('Project\\Team\\Foo');
    expect(routes[0].assignedTo).toBe('alice@example.com');
  });

  it('returns no routes when nothing can be resolved (no ownership, no fallback)', () => {
    expect(buildBugRoutes(root, 'packages/bar/src/a.ts', 'privacy')).toHaveLength(0);
  });
});
