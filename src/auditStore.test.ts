// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, expect, it } from '@jest/globals';
import { auditFindingId } from './auditStore';

describe('auditFindingId', () => {
  it('is stable for identical inputs', () => {
    const first = auditFindingId('packages/foo/src/a.ts', 'SQL injection in query', 'security');
    const second = auditFindingId('packages/foo/src/a.ts', 'SQL injection in query', 'security');
    expect(first).toBe(second);
  });

  it('normalizes path separators, leading slashes, and case', () => {
    const posix = auditFindingId('packages/foo/src/a.ts', 'Leaks PII', 'privacy');
    const windows = auditFindingId('\\packages\\Foo\\src\\A.ts', 'Leaks PII', 'privacy');
    expect(windows).toBe(posix);
  });

  it('normalizes title whitespace and case so minor rewordings share an id', () => {
    const plain = auditFindingId('packages/foo/src/a.ts', 'Hardcoded secret', 'security');
    const spaced = auditFindingId('packages/foo/src/a.ts', '  HARDCODED   secret ', 'security');
    expect(spaced).toBe(plain);
  });

  it('differs when the category differs', () => {
    const security = auditFindingId('packages/foo/src/a.ts', 'Same title', 'security');
    const privacy = auditFindingId('packages/foo/src/a.ts', 'Same title', 'privacy');
    expect(security).not.toBe(privacy);
  });

  it('differs when the title differs', () => {
    const one = auditFindingId('packages/foo/src/a.ts', 'Issue one', 'security');
    const two = auditFindingId('packages/foo/src/a.ts', 'Issue two', 'security');
    expect(one).not.toBe(two);
  });
});
