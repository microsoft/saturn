import { describe, expect, it } from '@jest/globals';
import { buildDiffPayload, limitComments, parseReviewResult, type ReviewComment } from './review';

describe('parseReviewResult', () => {
  it('parses a fenced json review surrounded by prose', () => {
    const raw = [
      'Here is my review of the change.',
      '```json',
      '{"summary":"Looks mostly good","hasFindings":true,"comments":[' +
        '{"filePath":"/apps/a.ts","line":12,"severity":"major","category":"security","title":"Null deref","body":"Guard x before use."}]}',
      '```',
      'Done.'
    ].join('\n');

    expect(parseReviewResult(raw)).toEqual({
      summary: 'Looks mostly good',
      hasFindings: true,
      comments: [
        { filePath: '/apps/a.ts', line: 12, severity: 'major', category: 'security', title: 'Null deref', body: 'Guard x before use.' }
      ]
    });
  });

  it('parses a no-findings review', () => {
    const raw = '```json\n{"summary":"Clean","hasFindings":false,"comments":[]}\n```';
    expect(parseReviewResult(raw)).toEqual({ summary: 'Clean', hasFindings: false, comments: [] });
  });

  it('returns undefined for non-JSON output', () => {
    expect(parseReviewResult('I could not complete the review.')).toBeUndefined();
  });

  it('returns undefined when the JSON does not match the schema', () => {
    const raw = '```json\n{"summary":"x","hasFindings":true,"comments":[{"filePath":"/a","line":-1}]}\n```';
    expect(parseReviewResult(raw)).toBeUndefined();
  });
});

describe('buildDiffPayload', () => {
  it('renders added lines with + markers and notes per-file truncation', () => {
    const payload = buildDiffPayload(
      [{ path: '/a.ts', changeType: 'add', content: 'one\ntwo\nthree', baseContent: '' }],
      { maxTotalBytes: 10_000, maxFileLines: 2 }
    );

    expect(payload.includedFileCount).toBe(1);
    expect(payload.truncated).toBe(false);
    expect(payload.text).toContain('1 | + one');
    expect(payload.text).toContain('file truncated at 2 lines');
  });

  it('marks only added lines with + and keeps existing lines as unmarked context', () => {
    const payload = buildDiffPayload(
      [{ path: '/a.ts', changeType: 'edit', baseContent: 'line1\nline2\nline3', content: 'line1\nline2\nNEW\nline3' }],
      { maxTotalBytes: 10_000, maxFileLines: 1000 }
    );

    // The added line is marked "+" and anchored to its post-change line number (3); existing lines are not.
    expect(payload.text).toContain('3 | + NEW');
    expect(payload.text).not.toContain('+ line1');
    expect(payload.text).toContain('line1');
  });

  it('shows removed lines as context with a - marker and no new-file number', () => {
    const payload = buildDiffPayload([{ path: '/a.ts', changeType: 'edit', baseContent: 'a\nb\nc', content: 'a\nc' }], {
      maxTotalBytes: 10_000,
      maxFileLines: 1000
    });

    expect(payload.text).toContain('| - b');
  });

  it('drops files and flags truncation when the byte budget is exhausted', () => {
    const payload = buildDiffPayload(
      [
        { path: '/a.ts', changeType: 'edit', content: 'a'.repeat(200), baseContent: '' },
        { path: '/b.ts', changeType: 'edit', content: 'b'.repeat(200), baseContent: '' }
      ],
      { maxTotalBytes: 120, maxFileLines: 1000 }
    );

    expect(payload.includedFileCount).toBe(1);
    expect(payload.truncated).toBe(true);
  });
});

describe('limitComments', () => {
  it('keeps the highest-severity comments when over the cap', () => {
    const comments: ReviewComment[] = [
      { filePath: '/a', line: 1, severity: 'nit', category: 'design', title: 'n', body: 'b' },
      { filePath: '/b', line: 2, severity: 'blocking', category: 'security', title: 'x', body: 'b' },
      { filePath: '/c', line: 3, severity: 'minor', category: 'correctness', title: 'm', body: 'b' }
    ];

    const limited = limitComments(comments, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map((comment) => comment.severity)).toContain('blocking');
    expect(limited.map((comment) => comment.severity)).not.toContain('nit');
  });

  it('returns the input unchanged when within the cap', () => {
    const comments: ReviewComment[] = [{ filePath: '/a', line: 1, severity: 'major', category: 'correctness', title: 't', body: 'b' }];
    expect(limitComments(comments, 10)).toBe(comments);
  });
});
