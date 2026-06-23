// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, expect, it } from '@jest/globals';

import { extractActiveReviewComments, extractBotCommentThreads, pickCurrentIteration } from './ado';

describe('extractActiveReviewComments', () => {
  it('returns genuine reviewer comments on active threads', () => {
    const threads = [{ status: 'active', comments: [{ commentType: 'text', content: 'Please fix the null check.' }] }];
    expect(extractActiveReviewComments(threads)).toEqual(['Please fix the null check.']);
  });

  it('skips automated status comments that carry no real text commentType', () => {
    // Build / coverage / lint / bundle-size bots (e.g. office-fluid) post their reports as PR comments with
    // an empty commentType - those must NOT be treated as actionable feedback.
    const threads = [
      { status: 'active', comments: [{ commentType: '', content: '## Code coverage summary ...' }] },
      { status: 'active', comments: [{ content: '## Eslint Health Details ...' }] },
      { status: 'active', comments: [{ commentType: '', content: '<h2>Bundle Size Details</h2> ...' }] }
    ];
    expect(extractActiveReviewComments(threads)).toEqual([]);
  });

  it('skips system, resolved/closed, and deleted threads', () => {
    const threads = [
      { status: 'active', comments: [{ commentType: 'system', content: 'set auto-complete' }] },
      { status: 'closed', comments: [{ commentType: 'text', content: 'old resolved note' }] },
      { status: 'fixed', comments: [{ commentType: 'text', content: 'already fixed' }] },
      { status: 'active', isDeleted: true, comments: [{ commentType: 'text', content: 'deleted thread' }] }
    ];
    expect(extractActiveReviewComments(threads)).toEqual([]);
  });

  it('includes active and pending threads and drops empty content', () => {
    const threads = [
      { status: 'pending', comments: [{ commentType: 'text', content: 'pending feedback' }] },
      { status: 'active', comments: [{ commentType: 'text', content: '   ' }] },
      { status: '', comments: [{ commentType: 'text', content: 'unset-status feedback' }] }
    ];
    expect(extractActiveReviewComments(threads)).toEqual(['pending feedback', 'unset-status feedback']);
  });
});

describe('extractBotCommentThreads', () => {
  it('returns active automated bot threads with their ids', () => {
    const threads = [
      { id: 11, status: 'active', comments: [{ commentType: '', content: '## Code coverage summary ...' }] },
      { id: 12, status: 'active', comments: [{ content: '<h2>Bundle Size Details</h2>' }] }
    ];
    expect(extractBotCommentThreads(threads)).toEqual([
      { threadId: 11, content: '## Code coverage summary ...' },
      { threadId: 12, content: '<h2>Bundle Size Details</h2>' }
    ]);
  });

  it('excludes threads that have a genuine human (text) or system comment', () => {
    const threads = [
      { id: 21, status: 'active', comments: [{ commentType: 'text', content: 'Please fix this' }] },
      { id: 22, status: 'active', comments: [{ commentType: 'system', content: 'auto-complete set' }] },
      // bot report + a human reply -> handled by the review path, not the bot path.
      {
        id: 23,
        status: 'active',
        comments: [
          { commentType: '', content: 'coverage' },
          { commentType: 'text', content: 'is this real?' }
        ]
      }
    ];
    expect(extractBotCommentThreads(threads)).toEqual([]);
  });

  it('excludes resolved/closed/deleted threads and ones already rebutted', () => {
    const threads = [
      { id: 31, status: 'closed', comments: [{ commentType: '', content: 'coverage' }] },
      { id: 32, status: 'fixed', comments: [{ commentType: '', content: 'coverage' }] },
      { id: 33, status: 'active', isDeleted: true, comments: [{ commentType: '', content: 'coverage' }] },
      { id: 34, status: 'active', comments: [{ commentType: '', content: 'coverage <!-- saturn-bot-rebuttal -->' }] }
    ];
    expect(extractBotCommentThreads(threads)).toEqual([]);
  });

  it('skips threads with no id or only empty content', () => {
    const threads = [
      { status: 'active', comments: [{ commentType: '', content: 'coverage' }] },
      { id: 41, status: 'active', comments: [{ commentType: '', content: '   ' }] }
    ];
    expect(extractBotCommentThreads(threads)).toEqual([]);
  });
});

describe('pickCurrentIteration', () => {
  const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

  it('picks the deepest sprint whose dates span today (never an old node)', () => {
    const tree = {
      name: 'OC',
      children: [
        { name: 'CY20Q4', attributes: { startDate: iso(-2000), finishDate: iso(-1900) } },
        {
          name: 'CY26 Cycles',
          attributes: { startDate: iso(-120), finishDate: iso(240) },
          children: [{ name: 'CY26Q2 (Apr-Jun)', attributes: { startDate: iso(-30), finishDate: iso(11) } }]
        }
      ]
    };
    expect(pickCurrentIteration(tree)).toBe('OC\\CY26 Cycles\\CY26Q2 (Apr-Jun)');
  });

  it('falls back to the most recently started iteration when none spans today (never the oldest)', () => {
    const tree = {
      name: 'OC',
      children: [
        { name: 'CY20Q4', attributes: { startDate: iso(-2000), finishDate: iso(-1900) } },
        { name: 'CY25Q1', attributes: { startDate: iso(-300), finishDate: iso(-260) } }
      ]
    };
    expect(pickCurrentIteration(tree)).toBe('OC\\CY25Q1');
  });

  it('returns undefined when no iteration has a usable start date', () => {
    expect(pickCurrentIteration({ name: 'OC', children: [{ name: 'Undated' }] })).toBeUndefined();
  });
});
