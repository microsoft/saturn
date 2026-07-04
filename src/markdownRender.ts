// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import type { ChatMessage } from './chatStore';

// A small, dependency-free, XSS-safe Markdown -> HTML renderer for design-doc artifacts and chat transcripts.
// Safety model: EVERYTHING is HTML-escaped first, and we only ever emit a fixed set of known-safe tags - no
// raw HTML from the (LLM-generated, semi-trusted) markdown is ever passed through. Fenced ```mermaid blocks
// are emitted as <pre class="mermaid"> so the client (or a standalone doc) can render them with mermaid.js.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render inline markdown (code spans, links, bold, italic) on a single line. Code spans are protected first
// so their contents are never re-processed; everything is escaped, and link URLs are scheme-whitelisted.
function renderInline(text: string): string {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      let out = escapeHtml(part);
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
        return /^(https?:\/\/|\/|#)/i.test(url)
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : match;
      });
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return out;
    })
    .join('');
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Render a markdown string to a SAFE HTML fragment (no <html>/<body> wrapper). Handles headings, fenced code
 * (incl. mermaid), lists, blockquotes, tables, horizontal rules, and paragraphs with inline formatting.
 */
export function renderMarkdownToSafeHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  const paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${paragraph.map(renderInline).join(' ')}</p>`);
      paragraph.length = 0;
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Fenced code block (``` or ```lang).
    const fence = /^```\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const lang = (fence[1] ?? '').toLowerCase();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // skip closing fence
      if (lang === 'mermaid') {
        html.push(`<pre class="mermaid">${escapeHtml(body.join('\n'))}</pre>`);
      } else {
        html.push(`<pre class="code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      }
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = (heading[1] ?? '#').length;
      html.push(`<h${String(level)}>${renderInline((heading[2] ?? '').trim())}</h${String(level)}>`);
      index += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      html.push('<hr/>');
      index += 1;
      continue;
    }

    // Table (a | row | followed by a |---|---| separator).
    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? '')) {
      flushParagraph();
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? '')) {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const bodyRows = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`);
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${quote.map(renderInline).join('<br/>')}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push(`<li>${renderInline((lines[index] ?? '').replace(/^\s*[-*+]\s+/, ''))}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push(`<li>${renderInline((lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''))}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blank line ends a paragraph.
    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return html.join('\n');
}

const DOC_STYLES = `
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1b1f2a;
    max-width: 900px; margin: 32px auto; padding: 0 24px; }
  h1,h2,h3,h4 { line-height: 1.25; margin-top: 1.4em; }
  h1 { border-bottom: 2px solid #e2e6ef; padding-bottom: .3em; }
  h2 { border-bottom: 1px solid #eef1f6; padding-bottom: .2em; }
  code { background: #f2f4f8; padding: 2px 5px; border-radius: 4px; font-family: 'Cascadia Code', Consolas, monospace; font-size: .92em; }
  pre.code { background: #0d1430; color: #e6e9f0; padding: 14px; border-radius: 8px; overflow: auto; }
  pre.code code { background: none; color: inherit; padding: 0; }
  pre.mermaid { background: #f8fafc; border: 1px solid #e2e6ef; border-radius: 8px; padding: 14px; text-align: center; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #dbe0ea; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f2f4f8; }
  blockquote { border-left: 4px solid #c6cede; margin: 1em 0; padding: .3em 1em; color: #55607a; background: #f7f9fc; }
  a { color: #2952e3; }
  .msg { margin: 14px 0; padding: 12px 16px; border-radius: 10px; }
  .msg.user { background: #eef2ff; }
  .msg.assistant { background: #f5f7fb; }
  .msg .role { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #6b7590; margin-bottom: 6px; }
`;

/**
 * Wrap a rendered markdown body in a complete, standalone HTML document. `mermaidScript` is the <script> that
 * loads mermaid (a same-origin src tag for an inline browser view, or an inlined bundle for offline downloads);
 * pass '' to omit diagram rendering.
 */
export function buildHtmlDocument(title: string, bodyHtml: string, mermaidScript: string): string {
  const mermaidInit =
    mermaidScript === ''
      ? ''
      : `${mermaidScript}\n<script>try{mermaid.initialize({startOnLoad:true,securityLevel:'strict',theme:'default'});}catch(e){}</script>`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${DOC_STYLES}</style>`,
    '</head><body>',
    bodyHtml,
    mermaidInit,
    '</body></html>'
  ].join('\n');
}

/** Build a standalone HTML transcript of a conversation (user + assistant messages, markdown-rendered). */
export function buildTranscriptDocument(title: string, messages: readonly ChatMessage[], mermaidScript: string): string {
  const body = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const role = message.role === 'user' ? 'User' : 'Saturn';
      return `<div class="msg ${escapeHtml(message.role)}"><div class="role">${escapeHtml(role)}</div>${renderMarkdownToSafeHtml(message.content)}</div>`;
    })
    .join('\n');
  return buildHtmlDocument(title, `<h1>${escapeHtml(title)}</h1>\n${body}`, mermaidScript);
}
