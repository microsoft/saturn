// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, expect, it } from '@jest/globals';
import { extractAssistantText, extractJson, parseReplyMeta } from './designAgent';

function jsonl(events: readonly unknown[]): string {
    return events.map((event) => JSON.stringify(event)).join('\n');
}

describe('designAgent parsers', () => {
    describe('extractJson', () => {
        it('extracts a fenced json block', () => {
            expect(extractJson('prose\n```json\n{"a":1}\n```\nmore')).toBe('{"a":1}');
        });
        it('extracts a bare object spanning the first { to the last }', () => {
            expect(extractJson('noise {"a": {"b": 2}} tail')).toBe('{"a": {"b": 2}}');
        });
        it('returns undefined when there is no object', () => {
            expect(extractJson('no json here')).toBeUndefined();
        });
    });

    describe('parseReplyMeta', () => {
        it('splits the reply from the [[META]] section', () => {
            const result = parseReplyMeta('Hello there\n[[META]]{"complete":true}');
            expect(result.reply).toBe('Hello there');
            expect(result.meta).toBe('{"complete":true}');
        });
        it('treats the whole text as the reply when there is no marker', () => {
            const result = parseReplyMeta('Just a reply');
            expect(result.reply).toBe('Just a reply');
            expect(result.meta).toBe('');
        });
    });

    describe('extractAssistantText (JSONL CoT parser)', () => {
        it('returns the message carrying [[META]] even when earlier narration exists', () => {
            const out = jsonl([
                { type: 'assistant.message', data: { content: 'Let me research the codebase first.' } },
                { type: 'tool.execution_start', data: { toolName: 'view' } },
                { type: 'assistant.message', data: { content: 'Here is the design.\n[[META]]{"complete":true}' } }
            ]);
            const text = extractAssistantText(out);
            expect(text).toContain('[[META]]');
            expect(text).toContain('Here is the design.');
            expect(text).not.toContain('research the codebase');
        });

        it('returns the last assistant message when none carries [[META]]', () => {
            const out = jsonl([
                { type: 'assistant.message', data: { content: 'narration' } },
                { type: 'assistant.message', data: { content: 'final answer' } }
            ]);
            expect(extractAssistantText(out)).toBe('final answer');
        });

        it('falls back to the raw output for plain-text (non-JSON) mode', () => {
            expect(extractAssistantText('just plain text')).toBe('just plain text');
        });
    });
});
