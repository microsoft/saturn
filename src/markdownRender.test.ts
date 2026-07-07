// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { describe, expect, it } from '@jest/globals';
import type { ChatMessage } from './chatStore';
import {
    buildHtmlDocument,
    buildTranscriptDocument,
    escapeHtml,
    renderMarkdownToSafeHtml
} from './markdownRender';

describe('markdownRender', () => {
    it('escapes HTML so raw markup can never inject script', () => {
        const html = renderMarkdownToSafeHtml('Hello <script>alert(1)</script> & <b>x</b>');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&amp;');
    });

    it('renders bold, italic, and inline code', () => {
        const html = renderMarkdownToSafeHtml('This is **bold**, *italic*, and `code`.');
        expect(html).toContain('<strong>bold</strong>');
        expect(html).toContain('<em>italic</em>');
        expect(html).toContain('<code>code</code>');
    });

    it('links only safe URL schemes and drops javascript: links', () => {
        const safe = renderMarkdownToSafeHtml('[Docs](https://example.com/docs)');
        expect(safe).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">Docs</a>');

        const unsafe = renderMarkdownToSafeHtml('[Click](javascript:alert(1))');
        expect(unsafe).not.toContain('<a ');
        expect(unsafe.toLowerCase()).not.toContain('href="javascript');
    });

    it('emits mermaid fences as <pre class="mermaid"> and other code as <pre class="code">', () => {
        const mermaid = renderMarkdownToSafeHtml('```mermaid\ngraph TD; A-->B;\n```');
        expect(mermaid).toContain('<pre class="mermaid">');
        expect(mermaid).toContain('graph TD; A--&gt;B;');

        const code = renderMarkdownToSafeHtml('```ts\nconst x = 1;\n```');
        expect(code).toContain('<pre class="code"><code>');
        expect(code).toContain('const x = 1;');
    });

    it('renders headings, lists, tables, blockquotes, and horizontal rules', () => {
        expect(renderMarkdownToSafeHtml('# Title')).toContain('<h1>Title</h1>');
        expect(renderMarkdownToSafeHtml('- one\n- two')).toContain('<ul><li>one</li><li>two</li></ul>');
        expect(renderMarkdownToSafeHtml('1. a\n2. b')).toContain('<ol><li>a</li><li>b</li></ol>');
        expect(renderMarkdownToSafeHtml('> quoted')).toContain('<blockquote>quoted</blockquote>');
        expect(renderMarkdownToSafeHtml('---')).toContain('<hr/>');

        const table = renderMarkdownToSafeHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
        expect(table).toContain('<table>');
        expect(table).toContain('<th>A</th>');
        expect(table).toContain('<td>1</td>');
    });

    it('escapeHtml encodes the dangerous characters', () => {
        expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    });

    it('wraps a document with the Created by Saturn watermark and gates the mermaid script', () => {
        const withScript = buildHtmlDocument('Doc', '<p>hi</p>', '<script src="/vendor/mermaid.min.js"></script>');
        expect(withScript).toContain('<!doctype html>');
        expect(withScript).toContain('Created by Saturn');
        expect(withScript).toContain('mermaid.initialize');
        expect(withScript).toContain('<p>hi</p>');

        const noScript = buildHtmlDocument('Doc', '<p>hi</p>', '');
        expect(noScript).not.toContain('mermaid.initialize');
        expect(noScript).toContain('Created by Saturn');
    });

    it('builds a transcript with user and Saturn roles', () => {
        const now = new Date().toISOString();
        const messages: ChatMessage[] = [
            { id: 'm1', conversationId: 'c1', role: 'user', content: 'Add **dark** mode', createdAt: now },
            { id: 'm2', conversationId: 'c1', role: 'assistant', content: 'Here is a plan', createdAt: now },
            { id: 'm3', conversationId: 'c1', role: 'system', content: 'internal', createdAt: now }
        ];
        const html = buildTranscriptDocument('My chat', messages, '');
        expect(html).toContain('>User<');
        expect(html).toContain('>Saturn<');
        expect(html).toContain('<strong>dark</strong>');
        // System messages are excluded from the transcript.
        expect(html).not.toContain('internal');
    });
});
