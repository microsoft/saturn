// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeFixDb,
  countActiveFixTasks,
  createFixTask,
  fixTaskStatusCounts,
  getFixTaskByFinding,
  listFixTasks,
  type NewFixTask,
  updateFixTask
} from './fixStore';

function newTask(overrides: Partial<NewFixTask> = {}): NewFixTask {
  const base: NewFixTask = {
    id: 'bug-1',
    findingId: 'finding-1',
    bugId: 1,
    title: 'Fix contrast',
    filePath: 'packages/foo/src/a.ts',
    package: 'packages/foo',
    phase: 1,
    branch: 'saturn/fix/1'
  };
  return { ...base, ...overrides };
}

describe('fixStore', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'saturn-fix-'));
    process.env.SATURN_FIX_DIR = directory;
    closeFixDb();
  });

  afterEach(() => {
    closeFixDb();
    delete process.env.SATURN_FIX_DIR;
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates a task in the selected state and reads it back by finding', () => {
    const task = createFixTask(newTask());
    expect(task.status).toBe('selected');
    expect(task.iterations).toBe(0);
    expect(getFixTaskByFinding('finding-1')?.id).toBe('bug-1');
    expect(getFixTaskByFinding('nope')).toBeUndefined();
  });

  it('counts all active tasks (not just open PRs) for the task cap', () => {
    createFixTask(newTask({ id: 'a', findingId: 'fa', bugId: 10 }));
    createFixTask(newTask({ id: 'b', findingId: 'fb', bugId: 11 }));
    // Both start as 'selected', so count is 2
    expect(countActiveFixTasks()).toBe(2);
    updateFixTask('a', { status: 'pr-open', prId: 100, prUrl: 'https://pr/100' });
    expect(countActiveFixTasks()).toBe(2);
    updateFixTask('b', { status: 'addressing' });
    expect(countActiveFixTasks()).toBe(2);
    updateFixTask('b', { status: 'merged', mergedAt: '2026-01-01T00:00:00Z' });
    expect(countActiveFixTasks()).toBe(1);
  });

  it('round-trips updates and reports status counts', () => {
    createFixTask(newTask({ id: 'x', findingId: 'fx', bugId: 20 }));
    const updated = updateFixTask('x', {
      status: 'pr-open',
      prId: 55,
      prUrl: 'https://pr/55',
      iterations: 1,
      lastAction: 'PR opened'
    });
    expect(updated?.prId).toBe(55);
    expect(updated?.prUrl).toBe('https://pr/55');
    expect(updated?.iterations).toBe(1);
    expect(updated?.lastAction).toBe('PR opened');
    expect(listFixTasks(10, 0).total).toBe(1);
    expect(fixTaskStatusCounts()['pr-open']).toBe(1);
  });
});
