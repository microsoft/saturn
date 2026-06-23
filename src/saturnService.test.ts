// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, expect, it } from '@jest/globals';

import { classifyBugTriage } from './saturnService';

const NO_MAPPING = { fixed: [], wontfix: [], needsinfo: [] };

describe('classifyBugTriage', () => {
  it('treats a done-ish state without a won-t-fix reason as fixed', () => {
    expect(classifyBugTriage('Resolved', 'Fixed', NO_MAPPING)).toBe('fixed');
    expect(classifyBugTriage('Closed', 'Fixed', NO_MAPPING)).toBe('fixed');
    expect(classifyBugTriage('Done', '', NO_MAPPING)).toBe('fixed');
  });

  it('respects a won-t-fix closure even when the state is done-ish', () => {
    expect(classifyBugTriage('Resolved', 'As Designed', NO_MAPPING)).toBe('wontfix');
    expect(classifyBugTriage('Closed', 'Duplicate', NO_MAPPING)).toBe('wontfix');
    expect(classifyBugTriage('Closed', "Won't Fix", NO_MAPPING)).toBe('wontfix');
    expect(classifyBugTriage('Removed', '', NO_MAPPING)).toBe('wontfix');
  });

  it('detects needs-more-info from either the state or the reason, ahead of other categories', () => {
    expect(classifyBugTriage('Need More Info', '', NO_MAPPING)).toBe('needsinfo');
    expect(classifyBugTriage('Active', 'Needs Info', NO_MAPPING)).toBe('needsinfo');
  });

  it('treats in-progress states as active', () => {
    expect(classifyBugTriage('Active', '', NO_MAPPING)).toBe('active');
    expect(classifyBugTriage('New', '', NO_MAPPING)).toBe('active');
    expect(classifyBugTriage('Committed', 'Approved', NO_MAPPING)).toBe('active');
  });

  it('honors team-configured state mappings over the built-in heuristics', () => {
    expect(classifyBugTriage('Mitigated', '', { fixed: ['mitigated'], wontfix: [], needsinfo: [] })).toBe('fixed');
    expect(classifyBugTriage('Parked', '', { fixed: [], wontfix: ['parked'], needsinfo: [] })).toBe('wontfix');
    expect(classifyBugTriage('Triaging', '', { fixed: [], wontfix: [], needsinfo: ['triaging'] })).toBe('needsinfo');
    // A configured term wins even against a built-in won't-fix reason.
    expect(classifyBugTriage('Closed', 'Duplicate', { fixed: ['closed'], wontfix: [], needsinfo: [] })).toBe('fixed');
  });
});
