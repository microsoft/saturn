#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  buildCommentDeepLink,
  buildPullRequestWebUrl,
  buildSourceFileUrl,
  DASHBOARD_PORT,
  defaultReasoningEffort,
  getReviewAllowlist,
  isFeedbackEnabled,
  isSaturnConfigured,
  parseRepoUrl,
  setReviewAllowlist,
  webhookSecret,
  writeSaturnConfig
} from './config';
import { isKnownProvider, listModels, listProviders, modelCapabilities } from './llmProvider';
import { getModelStatus } from './copilot';
import { createSaturnService, type SaturnService, type SaturnServiceConfig } from './saturnService';
import { areaOwnerEntriesFromBody } from './areaOwners';
import type { AuditFinding, AuditFindingFilter } from './auditStore';
import { fixTaskStatusCounts, getFixScopePaths, listFixTasks, setFixScopePaths, signalFixWake } from './fixStore';
import { readAllFeedback, recordFeedback } from './saturnStore';
import { buildAuditSarifLog, buildSarifLog } from './sarif';
import { consoleLogger, isRecord, runCommand } from './util';
import {
  createConversation,
  getArtifact,
  getConversation,
  latestArtifact,
  listConversations,
  listFeatureBuilds,
  listMessages,
  updateConversation
} from './chatStore';
import { approveAndBuild, generateTitleAsync, handleChatTurn } from './chatService';
import { buildHtmlDocument, buildTranscriptDocument, escapeHtml, renderMarkdownToSafeHtml } from './markdownRender';

const PORT = DASHBOARD_PORT;

const feedbackSubmissionSchema = z.object({
  prId: z.number(),
  commentId: z.number(),
  rating: z.enum(['up', 'down', 'none']),
  message: z.string().max(5000)
});

// Open Server-Sent Events connections (one per viewing dashboard); state is pushed to all of them.
const sseClients = new Set<ServerResponse>();

// Short-lived cache for the Dashboard tab bundle. The tab polls every ~5s per viewer; caching the recompute
// for a few seconds means N concurrent viewers cost one server-side computation, not N, without noticeably
// staling the data.
const DASHBOARD_CACHE_TTL_MS = 4000;
let dashboardCache: { at: number; data: ReturnType<SaturnService['getDashboardData']> } | undefined;
function getCachedDashboardData(service: SaturnService): ReturnType<SaturnService['getDashboardData']> {
  const now = Date.now();
  if (dashboardCache !== undefined && now - dashboardCache.at < DASHBOARD_CACHE_TTL_MS) {
    return dashboardCache.data;
  }
  const data = service.getDashboardData();
  dashboardCache = { at: now, data };
  return data;
}

function resolveOnBehalfOf(): string {
  const result = runCommand('git', ['config', 'user.email']);
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? 'the repository owner' : value;
}

// The Saturn owner (admin): the only identity allowed to start/stop the agent. Other viewers can open the
// dashboard and submit feedback, but cannot control the loop. Set SATURN_OWNER when hosted behind an auth
// proxy; otherwise it defaults to the machine's git identity (i.e. you, on this machine).
const OWNER_IDENTITY =
  (process.env.SATURN_OWNER ?? '').trim() !== '' ? (process.env.SATURN_OWNER ?? '').trim() : resolveOnBehalfOf();

/**
 * True when the request's socket is loopback. NOTE: a reverse proxy or tunnel running on this machine also
 * forwards from loopback, so this alone does NOT prove the owner - see isDirectLocalRequest.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * True only for a request made *directly* to the dashboard from this machine - never one relayed through a
 * reverse proxy or tunnel (e.g. devtunnel), even though those also forward from loopback. A relay either
 * carries a non-local Host or adds x-forwarded-* headers, so we require all of: a loopback socket, no
 * forwarding headers, and a localhost Host header. This is what keeps owner control localhost-only.
 */
function isDirectLocalRequest(req: IncomingMessage): boolean {
  if (!isLoopbackRequest(req)) {
    return false;
  }
  if (
    req.headers['x-forwarded-for'] !== undefined ||
    req.headers['x-forwarded-host'] !== undefined ||
    req.headers['x-forwarded-proto'] !== undefined
  ) {
    return false;
  }
  const host = (req.headers.host ?? '').toLowerCase();
  return host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]') || host === '::1';
}

/**
 * The identity we can *trust* for this request, or undefined when we cannot prove who the viewer is - in which
 * case we must never attribute their feedback to a name nor let them control the loop. Trusted only via:
 *   1. an auth proxy that injects the signed-in identity (Azure AD / Easy Auth `x-ms-client-principal-name`), or
 *   2. a direct request from this machine (the owner at the keyboard), never a tunnel/proxy relay.
 * A viewer over a tunnel has neither, so they are anonymous (undefined). Client-supplied identity is never trusted.
 */
function resolveTrustedIdentity(req: IncomingMessage): string | undefined {
  const principal = req.headers['x-ms-client-principal-name'];
  if (typeof principal === 'string' && principal.trim() !== '') {
    return principal.trim();
  }
  if (isDirectLocalRequest(req)) {
    return OWNER_IDENTITY;
  }

  return undefined;
}

/**
 * True only for the owner: an auth-proxy identity matching SATURN_OWNER, or a direct local request from this
 * machine. Tunnel/proxy viewers are never the owner, so they cannot start/stop the loop.
 */
function isOwner(req: IncomingMessage): boolean {
  return resolveTrustedIdentity(req)?.toLowerCase() === OWNER_IDENTITY.toLowerCase();
}

/** Constant-time comparison for the webhook shared secret (avoids leaking length/contents via timing). */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read a request body as a string, capped to guard against oversized payloads. */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
      if (body.length > 4_000_000) {
        req.destroy();
      }
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', () => {
      resolve('');
    });
  });
}

/** Per-PR model timeout in ms. Defaults to 15 minutes; full-file reviews of large/complex PRs need it. */
function resolveTimeoutMs(): number {
  const raw = Number.parseInt(process.env.SATURN_TIMEOUT_MS ?? '', 10);
  return Number.isNaN(raw) || raw <= 0 ? 900_000 : raw;
}

function buildConfig(): SaturnServiceConfig {
  return {
    model: process.env.SATURN_MODEL ?? 'claude-opus-4.8',
    reasoningEffort: defaultReasoningEffort(),
    maxComments: 10,
    maxReviews: 10,
    scanLimit: 100,
    onBehalfOf: resolveOnBehalfOf(),
    installDeps: process.env.SATURN_INSTALL_DEPS !== '0',
    scanIntervalMs: 5 * 60 * 1000,
    reviewTimeoutMs: resolveTimeoutMs(),
    backfillScanLimit: 500,
    backfillWindowDays: 14
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Saturn - Autonomous Engineering Agent</title>
<script>
  (function () {
    try {
      var saved = localStorage.getItem('saturn-theme');
      var theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', theme);
    } catch (e) { document.documentElement.setAttribute('data-theme', 'dark'); }
  })();
</script>
<style>
  :root {
    color-scheme: dark;
    --bg: #070b18;
    --panel: #0e1530;
    --panel-2: #121b3b;
    --panel-3: #16204a;
    --border: #243154;
    --border-soft: #1b2645;
    --text: #e9ecf7;
    --muted: #9aa3c4;
    --muted-2: #6c759c;
    --accent: #5b7cfa;
    --accent-2: #7b93ff;
    --accent-press: #4763e6;
    --ok: #46d19e;
    --err: #ff6b81;
    --warn: #ffb454;
    --radius: 14px;
    --radius-sm: 10px;
    --shadow: 0 12px 34px rgba(0,0,0,.38);
    --ring: 0 0 0 3px rgba(91,124,250,.35);
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg: #f4f6fc;
    --panel: #ffffff;
    --panel-2: #f7f9ff;
    --panel-3: #eef1fb;
    --border: #d3d9ec;
    --border-soft: #e4e8f5;
    --text: #1a2138;
    --muted: #55608a;
    --muted-2: #7b85ab;
    --accent: #3a5bd9;
    --accent-2: #3552c8;
    --accent-press: #2c46ad;
    --ok: #1a9e6e;
    --err: #d63a55;
    --warn: #b5781a;
    --shadow: 0 10px 28px rgba(31,45,90,.14);
    --ring: 0 0 0 3px rgba(58,91,217,.3);
  }
  [data-theme="light"] body { background: radial-gradient(1100px 560px at 82% -8%, #e6ecff 0%, rgba(244,246,252,0) 58%), radial-gradient(820px 460px at -5% -5%, #eef1fb 0%, rgba(244,246,252,0) 55%), var(--bg); }
  [data-theme="light"] header { background: rgba(255,255,255,.74); }
  [data-theme="light"] .pr-head:hover { background: rgba(0,0,0,.03); }
  * { box-sizing: border-box; }
  html { scrollbar-gutter: stable; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    color: var(--text);
    background:
      radial-gradient(1100px 560px at 82% -8%, #1a244e 0%, rgba(7,11,24,0) 58%),
      radial-gradient(820px 460px at -5% -5%, #15203f 0%, rgba(7,11,24,0) 55%),
      var(--bg);
    background-attachment: fixed;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 16px;
    padding: 14px 28px;
    background: rgba(10,15,33,.72);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--border-soft);
  }
  .brand { display:flex; align-items:center; gap:10px; }
  .brand .mark { width:30px; height:30px; border-radius:9px; background: linear-gradient(135deg, var(--accent), #9b6bff); box-shadow:0 6px 18px rgba(91,124,250,.45); display:grid; place-items:center; font-weight:800; color:#fff; font-size:15px; }
  h1 { font-size:18px; margin:0; letter-spacing:4px; font-weight:700; }
  h2 { font-size:14px; letter-spacing:.5px; text-transform:uppercase; color:var(--muted); margin:0; font-weight:700; }
  .status { display:flex; align-items:center; gap:8px; padding:6px 12px; border-radius:999px; font-size:12.5px; font-weight:700; border:1px solid transparent; }
  .status .dot { width:8px; height:8px; border-radius:50%; }
  .status.on { background:rgba(70,209,158,.12); color:var(--ok); border-color:rgba(70,209,158,.3); }
  .status.on .dot { background:var(--ok); animation: pulse 1.8s infinite; }
  .status.off { background:rgba(255,107,129,.1); color:var(--err); border-color:rgba(255,107,129,.28); }
  .status.off .dot { background:var(--err); }
  @keyframes pulse { 0%{ box-shadow:0 0 0 0 rgba(70,209,158,.6);} 70%{ box-shadow:0 0 0 7px rgba(70,209,158,0);} 100%{ box-shadow:0 0 0 0 rgba(70,209,158,0);} }
  .phase { font-size:12.5px; color:var(--muted); text-transform:capitalize; }
  .spacer { flex:1; }
  button { font:inherit; cursor:pointer; border:0; border-radius:10px; }
  .btn { padding:9px 18px; font-size:13.5px; font-weight:600; color:#fff; background:var(--accent); transition: background .15s, transform .05s; }
  .btn:hover { background:var(--accent-press); }
  .btn:active { transform: translateY(1px); }
  .btn.danger { background:#b3263b; }
  .btn.danger:hover { background:#cc2c44; }
  .btn.ghost { background:var(--panel-3); color:var(--text); border:1px solid var(--border); }
  .btn.ghost:hover { background:var(--border-soft); }
  .btn.sm { padding:6px 12px; font-size:12.5px; }
  .btn:disabled { opacity:.4; cursor:default; transform:none; }
  :focus-visible { outline:none; box-shadow: var(--ring); }
  main { padding:26px 28px 80px; max-width:1720px; margin:0 auto; box-sizing:border-box; }
  .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:14px; margin-bottom:26px; }
  .stat { background: linear-gradient(180deg, var(--panel-2), var(--panel)); border:1px solid var(--border-soft); border-radius:var(--radius); padding:14px 18px; }
  .stat .k { font-size:11.5px; letter-spacing:.4px; text-transform:uppercase; color:var(--muted-2); margin-bottom:6px; }
  .stat .v { font-size:22px; font-weight:700; letter-spacing:.3px; }
  .section-head { display:flex; align-items:baseline; gap:10px; margin:8px 0 14px; }
  .count-chip { font-size:12px; color:var(--muted-2); background:var(--panel-2); border:1px solid var(--border-soft); padding:2px 9px; border-radius:999px; }
  .pr { background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); margin-bottom:12px; overflow:hidden; transition: border-color .15s, box-shadow .15s; }
  #prTop, #prBot { margin:0; padding:0; }
  .pr:hover { border-color:var(--border); }
  .pr.open { border-color: rgba(91,124,250,.5); box-shadow: var(--shadow); }
  .pr-head { width:100%; display:flex; align-items:center; gap:12px; padding:14px 16px; background:transparent; color:inherit; text-align:left; }
  .pr-head:hover { background: rgba(255,255,255,.02); }
  .chevron { color:var(--muted-2); font-size:18px; line-height:1; transition: transform .25s ease; flex:none; width:14px; text-align:center; }
  .pr.open .chevron { transform: rotate(90deg); color:var(--accent-2); }
  .pr-id { font-variant-numeric: tabular-nums; color:var(--muted); font-weight:700; font-size:13px; flex:none; }
  .pr-title { font-weight:600; font-size:14.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1 1 auto; min-width:0; }
  .pr-sub { display:flex; align-items:center; gap:10px; flex:none; }
  .pr-meta { font-size:12px; color:var(--muted-2); white-space:nowrap; }
  .pill { font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; letter-spacing:.3px; white-space:nowrap; border:1px solid transparent; }
  .pill.ok { background:rgba(70,209,158,.13); color:var(--ok); border-color:rgba(70,209,158,.28); }
  .pill.err { background:rgba(255,107,129,.13); color:var(--err); border-color:rgba(255,107,129,.28); }
  .pill.neutral { background:var(--panel-3); color:var(--muted); border-color:var(--border-soft); }
  .pr-body { display:grid; grid-template-rows: 0fr; transition: grid-template-rows .28s ease; }
  .pr.open .pr-body { grid-template-rows: 1fr; }
  .pr-body-inner { overflow:hidden; }
  .pr-body-pad { padding:2px 16px 16px 42px; }
  .iter { border-top:1px solid var(--border-soft); padding-top:12px; margin-top:12px; }
  .iter:first-child { border-top:0; padding-top:0; margin-top:0; }
  .iter-head { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); margin-bottom:8px; flex-wrap:wrap; }
  .iter-detail { font-size:12.5px; color:var(--muted); margin:6px 0 8px; line-height:1.5; }
  .comment { border:1px solid var(--border-soft); border-left:3px solid var(--accent); background:var(--panel-2); border-radius:0 var(--radius-sm) var(--radius-sm) 0; padding:10px 12px; margin:8px 0; }
  .comment.sev-block { border-left-color:#ff5d73; } .comment.sev-major { border-left-color:var(--warn); }
  .comment.sev-minor { border-left-color:var(--accent); } .comment.sev-nit { border-left-color:#6c759c; } .comment.sev-info { border-left-color:#4a87c9; }
  .comment .loc { display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--muted-2); margin-bottom:5px; flex-wrap:wrap; }
  .comment .loc-meta { flex:1 1 auto; min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .comment .loc-actions { flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; align-self:flex-start; }
  /* True windowing (see renderAuditWindow): only the rows near the viewport are mounted; #auditTop / #auditBot
     reserve the exact measured height of the rows above / below. Audit cards use bottom-margin only so sibling
     margins never collapse - each row's reserved height is exactly offsetHeight + 8px, which keeps the spacer
     math exact and the scroll smooth in both directions no matter how many findings are loaded. */
  #auditList > .comment { margin:0 0 8px 0; }
  #auditTop, #auditBot { margin:0; padding:0; }
  .chip { font-size:10px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; padding:2px 7px; border-radius:6px; }
  .chip.sev-block { background:rgba(255,93,115,.16); color:#ff8497; } .chip.sev-major { background:rgba(255,180,84,.16); color:var(--warn); }
  .chip.sev-minor { background:rgba(91,124,250,.16); color:var(--accent-2); } .chip.sev-nit { background:rgba(108,117,156,.18); color:var(--muted); } .chip.sev-info { background:rgba(74,135,201,.16); color:#8ec1ef; }
  .comment .path { font-variant-numeric: tabular-nums; }
  .comment .c-title { font-weight:600; font-size:13.5px; margin-bottom:2px; }
  .comment .c-body { font-size:13px; color:#cfd5ee; line-height:1.5; white-space:pre-wrap; }
  .muted { color:var(--muted-2); }
  .empty { text-align:center; padding:34px 16px; border:1px dashed var(--border); border-radius:var(--radius); background: rgba(255,255,255,.015); color:var(--muted-2); }
  .sentinel { height:1px; }
  .loader { display:flex; align-items:center; justify-content:center; gap:10px; padding:18px; color:var(--muted-2); font-size:13px; }
  .spinner { width:16px; height:16px; border-radius:50%; border:2px solid var(--border); border-top-color:var(--accent); animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .end-note { text-align:center; color:var(--muted-2); font-size:12px; padding:14px; }
  .new-pill { position:fixed; left:50%; bottom:26px; transform: translateX(-50%) translateY(20px); opacity:0; pointer-events:none; transition: opacity .2s, transform .2s; background:var(--accent); color:#fff; font-size:13px; font-weight:600; padding:9px 16px; border-radius:999px; box-shadow:var(--shadow); z-index:30; }
  .new-pill.show { opacity:1; transform: translateX(-50%) translateY(0); pointer-events:auto; }
  .fb { background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); padding:12px 16px; margin-bottom:10px; }
  .fb .meta { font-size:12px; color:var(--muted-2); }
  .health { display:flex; flex-wrap:wrap; gap:10px 22px; align-items:center; background: linear-gradient(180deg, var(--panel-2), var(--panel)); border:1px solid var(--border-soft); border-radius:var(--radius); padding:12px 16px; margin-bottom:14px; }
  .health .group { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  .health .glabel { font-size:11px; text-transform:uppercase; letter-spacing:.4px; color:var(--muted-2); }
  .metric { font-size:12.5px; color:var(--muted); display:inline-flex; align-items:center; gap:5px; }
  .metric b { color:var(--text); font-variant-numeric:tabular-nums; }
  .metric .swatch { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .agent { background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); margin-bottom:14px; padding:0 14px; }
  .agent > summary { cursor:pointer; padding:11px 2px; font-size:12.5px; color:var(--muted); list-style:none; }
  .agent > summary::-webkit-details-marker { display:none; }
  .agent > summary::before { content:'\\25B8'; margin-right:8px; color:var(--muted-2); }
  .agent[open] > summary::before { content:'\\25BE'; }
  .agent-body { padding:0 0 12px; font-size:12.5px; color:var(--muted); display:flex; flex-direction:column; gap:7px; }
  .agent-cfg { display:flex; flex-wrap:wrap; gap:6px 16px; }
  .scan-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; border-top:1px solid var(--border-soft); padding-top:6px; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:16px; }
  .f-input { background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:9px; padding:7px 10px; font:inherit; font-size:13px; }
  .f-input::placeholder { color:var(--muted-2); }
  .f-range { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .chip-btn { background:var(--panel-3); color:var(--muted); border:1px solid var(--border-soft); border-radius:999px; padding:6px 11px; font-size:12px; cursor:pointer; }
  .chip-btn:hover, .chip-btn.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .meta-row { display:flex; flex-wrap:wrap; gap:6px 12px; font-size:11.5px; color:var(--muted-2); margin:2px 0 12px; }
  .meta-row .tag { background:var(--panel-3); border:1px solid var(--border-soft); border-radius:6px; padding:2px 8px; }
  .meta-row .tag.warn { color:var(--warn); border-color:rgba(255,180,84,.3); }
  .cat { font-size:10px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; padding:2px 7px; border-radius:6px; background:var(--panel-3); color:var(--muted); border:1px solid var(--border-soft); }
  .cat.ok { background:rgba(70,209,158,.14); color:var(--ok); border-color:rgba(70,209,158,.3); }
  .cat.warn { background:rgba(255,180,84,.16); color:var(--warn); border-color:rgba(255,180,84,.3); }
  .cat.security, .cat.privacy { background:rgba(255,93,115,.14); color:#ff8497; border-color:rgba(255,93,115,.32); }
  .sevmini { display:inline-flex; gap:4px; }
  .sevdot { font-size:10px; font-weight:800; min-width:18px; text-align:center; padding:1px 5px; border-radius:5px; }
  .sevdot.sev-block { background:rgba(255,93,115,.16); color:#ff8497; } .sevdot.sev-major { background:rgba(255,180,84,.16); color:var(--warn); }
  .sevdot.sev-minor { background:rgba(91,124,250,.16); color:var(--accent-2); } .sevdot.sev-nit { background:rgba(108,117,156,.18); color:var(--muted); }
  .spark { display:inline-flex; align-items:flex-end; gap:2px; height:22px; }
  .spark .sb { width:5px; background:var(--accent); border-radius:2px 2px 0 0; opacity:.85; }
  .res { font-size:10px; font-weight:700; padding:1px 6px; border-radius:6px; }
  .res:empty { padding:0; }
  .res.ok { background:rgba(70,209,158,.14); color:var(--ok); } .res.warn { background:rgba(255,180,84,.16); color:var(--warn); }
  @media (max-width: 620px) { header { padding:12px 16px; gap:10px; } main { padding:18px 14px 70px; } .pr-meta { display:none; } }
  .tabs { display:flex; gap:6px; margin-bottom:18px; border-bottom:1px solid var(--border-soft); }
  .tab-btn { background:none; border:none; color:var(--muted); font:inherit; font-weight:700; font-size:14px; padding:9px 14px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tab-btn:hover { color:var(--text); }
  .tab-btn.active { color:var(--text); border-bottom-color:var(--accent); }
  .audit-controls { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:4px 0 16px; }
  .switch { display:inline-flex; align-items:center; gap:6px; color:var(--muted); font-size:13px; font-weight:600; cursor:pointer; }
  .muted-note { color:var(--warn); font-size:12px; }
  .bug-link { font-size:11.5px; font-weight:700; color:var(--ok); text-decoration:none; }
  .bug-link:hover { text-decoration:underline; }
  .finding-meta { font-size:11px; color:var(--muted); margin-top:5px; }
  .audit-charts { display:flex; flex-direction:column; gap:14px; margin:2px 0 18px; }
  .kpi-row { display:flex; flex-wrap:wrap; gap:10px; }
  .kpi { flex:1 1 120px; min-width:108px; background:var(--panel-2); border:1px solid var(--border); border-radius:11px; padding:10px 13px; cursor:pointer; transition:border-color .12s; }
  .kpi:hover { border-color:var(--accent); }
  .kpi.active { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
  .kpi .k { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; }
  .kpi .v { font-size:22px; font-weight:800; margin-top:2px; }
  .kpi.sev-block .v { color:#ff8497; } .kpi.sev-major .v { color:var(--warn); } .kpi.sev-minor .v { color:var(--accent-2); } .kpi.sev-nit .v { color:var(--muted); }
  .charts-2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:720px) { .charts-2 { grid-template-columns:1fr; } }
  .chart-card { background:var(--panel-2); border:1px solid var(--border); border-radius:11px; padding:12px 14px; }
  .chart-card h4 { margin:0 0 10px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; font-weight:700; }
  .bar-row { display:grid; grid-template-columns:100px 1fr 34px; align-items:center; gap:8px; padding:3px 0; cursor:pointer; }
  .bar-row .bl { font-size:12px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-transform:capitalize; }
  .bar-row .bt { background:var(--panel-3); border-radius:6px; height:11px; overflow:hidden; }
  .bar-row .bf { display:block; height:100%; border-radius:6px; background:var(--accent); transition:width .2s; }
  .bar-row .bf.sev-block { background:#ff5d73; } .bar-row .bf.sev-major { background:var(--warn); } .bar-row .bf.sev-minor { background:var(--accent); } .bar-row .bf.sev-nit { background:#6c759c; }
  .bar-row .bv { font-size:12px; font-weight:700; text-align:right; color:var(--muted); }
  .bar-row:hover .bl, .bar-row.active .bl { color:var(--accent-2); }
  .bar-row.active .bl { font-weight:700; }
  .bar-row.ro { cursor:default; }
  .bar-row.ro:hover .bl { color:var(--text); }
  .dash-head { display:flex; align-items:baseline; gap:12px; margin:8px 0 12px; flex-wrap:wrap; }
  .dash-head h2 { margin:0; }
  .dash-sub { color:var(--muted-2); font-size:12.5px; }
  .dash-body { display:flex; flex-direction:column; gap:14px; }
  .docs-body { display:flex; flex-direction:column; gap:10px; max-width:920px; }
  .doc-acc { border:1px solid var(--border); border-radius:10px; background:var(--panel); overflow:hidden; }
  .doc-acc > summary { cursor:pointer; padding:12px 16px; font-weight:600; font-size:14px; color:var(--text); list-style:none; }
  .doc-acc > summary::-webkit-details-marker { display:none; }
  .doc-acc > summary::before { content:'▸'; display:inline-block; width:14px; color:var(--muted-2); }
  .doc-acc[open] > summary::before { content:'▾'; }
  .doc-acc[open] > summary { border-bottom:1px solid var(--border); }
  .doc-md { padding:6px 20px 18px; font-size:13.5px; line-height:1.6; color:var(--text); }
  .doc-md h1 { font-size:20px; margin:14px 0 8px; }
  .doc-md h2 { font-size:16px; margin:18px 0 6px; }
  .doc-md h3 { font-size:14px; margin:14px 0 6px; }
  .doc-md p { margin:8px 0; }
  .doc-md ul, .doc-md ol { margin:8px 0; padding-left:22px; }
  .doc-md li { margin:3px 0; }
  .doc-md code { background:rgba(127,127,127,.16); padding:1px 5px; border-radius:4px; font-size:12px; }
  .doc-md pre { background:rgba(127,127,127,.14); padding:12px 14px; border-radius:8px; overflow:auto; }
  .doc-md pre code { background:none; padding:0; }
  .doc-md a { color:var(--accent); }
  .doc-md table { border-collapse:collapse; margin:10px 0; width:100%; }
  .doc-md th, .doc-md td { border:1px solid var(--border); padding:6px 10px; text-align:left; font-size:12.5px; }
  .doc-md blockquote { border-left:3px solid var(--border); margin:8px 0; padding:2px 12px; color:var(--muted-2); }
  .doc-md hr { border:none; border-top:1px solid var(--border); margin:14px 0; }
  .cc { position:relative; height:214px; overflow:auto; }
  .cc.cc-wide { height:196px; }
  .kpi.ro { cursor:default; }
  .kpi.ro:hover { border-color:var(--border); }
  .chart-card.wide { }
  .donut-wrap { display:flex; align-items:center; gap:18px; flex-wrap:wrap; justify-content:center; }
  .donut { flex:0 0 auto; }
  .donut-num { fill:var(--text); font-size:26px; font-weight:800; }
  .donut-lbl { fill:var(--muted); font-size:9px; text-transform:uppercase; letter-spacing:.5px; }
  .legend { display:flex; flex-direction:column; gap:6px; min-width:120px; flex:1 1 130px; }
  .lg-row { display:flex; align-items:center; gap:8px; font-size:12px; }
  .lg-dot { width:10px; height:10px; border-radius:3px; flex:0 0 auto; }
  .lg-lbl { color:var(--muted); flex:1 1 auto; text-transform:capitalize; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .lg-val { color:var(--text); font-weight:700; font-variant-numeric:tabular-nums; }
  .prog { padding:6px 2px 2px; }
  .prog-top { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; }
  .prog-pct { font-size:28px; font-weight:800; color:var(--text); font-variant-numeric:tabular-nums; }
  .prog-sub { font-size:12px; color:var(--muted); }
  .prog-track { position:relative; height:10px; background:var(--panel-3); border-radius:999px; }
  .prog-fill { position:absolute; left:0; top:0; height:100%; border-radius:999px; background:linear-gradient(90deg, var(--accent), var(--accent-2)); transition:width .35s ease; }
  .prog-thumb { position:absolute; top:50%; width:16px; height:16px; border-radius:50%; background:#fff; border:3px solid var(--accent-2); transform:translate(-50%,-50%); box-shadow:0 1px 5px rgba(0,0,0,.45); transition:left .35s ease; }
  .lnchart { display:block; width:100%; height:auto; }
  .ln-area { stroke:none; }
  .ln-line { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .ln-dot { fill:var(--accent-2); }
  .ln-grid { stroke:var(--border-soft); stroke-width:1; }
  .ln-axis { fill:var(--muted-2); font-size:9px; }
  .live-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--ok); margin-left:6px; animation:pulse 1.7s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(70,209,158,.5);} 70%{box-shadow:0 0 0 6px rgba(70,209,158,0);} 100%{box-shadow:0 0 0 0 rgba(70,209,158,0);} }
  .tp { display:flex; flex-direction:column; gap:2px; }
  .tp-row { display:flex; justify-content:space-between; font-size:13px; color:var(--muted); padding:7px 0; border-bottom:1px solid var(--border-soft); }
  .tp-row:last-child { border-bottom:0; }
  .tp-row b { color:var(--text); font-variant-numeric:tabular-nums; }
  .detail-toggle { background:none; border:0; color:var(--accent-2); font-size:12px; cursor:pointer; padding:5px 0 2px; font-weight:600; }
  .detail-body { font-size:12.5px; color:#cfd5ee; line-height:1.55; white-space:pre-wrap; margin-top:4px; padding:9px 11px; background:var(--panel-3); border-radius:8px; border:1px solid var(--border-soft); }
  .copy-btn { background:none; border:0; color:var(--muted); cursor:pointer; font-size:14px; padding:3px 7px; border-radius:6px; }
  .copy-btn:hover { color:var(--text); background:var(--panel-3); }
  .route-picker { display:inline-flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .modal-overlay { position:fixed; inset:0; background:rgba(4,7,18,.62); display:flex; align-items:flex-start; justify-content:center; padding:48px 16px; z-index:60; overflow:auto; }
  .modal-card { background:var(--panel-2); border:1px solid var(--border); border-radius:14px; box-shadow:var(--shadow); width:100%; max-width:720px; padding:20px 22px; }
  .modal-card h3 { margin:0 0 4px; font-size:16px; }
  .modal-sub { color:var(--muted); font-size:12.5px; margin:0 0 14px; line-height:1.5; }
  .modal-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:18px; flex-wrap:wrap; }
  .modal-msg { font-size:13px; margin-top:12px; }
  .modal-msg.err { color:var(--err); } .modal-msg.ok { color:var(--ok); }
  .ao-table { width:100%; border-collapse:collapse; font-size:12.5px; }
  .ao-table th { text-align:left; color:var(--muted); font-weight:600; padding:5px 6px; border-bottom:1px solid var(--border); white-space:nowrap; }
  .ao-table td { padding:5px 6px; vertical-align:top; }
  .ao-table .f-input { width:100%; box-sizing:border-box; }
  .ao-del { color:var(--muted); cursor:pointer; background:none; border:0; font-size:16px; line-height:1; padding:4px 6px; }
  .ao-del:hover { color:var(--err); }
  .chat-shell { display:flex; height: calc(100vh - 196px); min-height:480px; border:1px solid var(--line,#232a44); border-radius:12px; overflow:hidden; }
  .chat-sidebar { flex:0 0 auto; display:flex; flex-direction:column; padding:12px; border-right:1px solid var(--line,#232a44); overflow:hidden; box-sizing:border-box; }
  .chat-newbtn { width:100%; }
  .chat-conv-list { margin-top:12px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:2px; }
  .chat-conv { display:flex; align-items:center; gap:6px; padding:9px 10px; border-radius:8px; cursor:pointer; font-size:13px; }
  .chat-conv:hover { background:rgba(127,127,127,.10); }
  .chat-conv.active { background:rgba(41,82,227,.16); }
  .chat-conv .title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chat-conv .del { border:0; background:none; color:var(--muted,#8b93b5); cursor:pointer; font-size:16px; line-height:1; padding:0 4px; opacity:0; border-radius:4px; }
  .chat-conv:hover .del { opacity:.75; } .chat-conv .del:hover { opacity:1; color:var(--err,#ff7a8a); }
  .chat-col { flex:1 1 auto; display:flex; flex-direction:column; min-width:320px; }
  .chat-head { padding:12px 18px; border-bottom:1px solid var(--line,#232a44); font-weight:600; font-size:15px; }
  .chat-thread { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
  /* Center the conversation in a readable column so wide screens use the space gracefully instead of stretching
     message lines edge to edge (the thread itself still fills the pane; only the message column is capped). */
  .chat-thread > .chat-msg { width:100%; max-width:860px; margin-left:auto; margin-right:auto; }
  .chat-welcome { margin:auto; text-align:center; max-width:440px; color:var(--muted,#8b93b5); }
  .chat-welcome h3 { margin:0 0 8px; color:inherit; font-size:18px; }
  .chat-welcome p { margin:0; font-size:14px; line-height:1.6; }
  .chat-msg { display:flex; }
  .chat-msg.user { justify-content:flex-end; }
  .chat-bubble { max-width:80%; padding:11px 15px; border-radius:16px; white-space:pre-wrap; word-wrap:break-word; overflow-wrap:anywhere; font-size:14.5px; line-height:1.55; }
  .chat-msg.user .chat-bubble { background:linear-gradient(135deg,#3168ff,#2545d6); color:#fff; border-bottom-right-radius:5px; }
  .chat-msg.assistant .chat-bubble { background:rgba(127,127,127,.14); border-bottom-left-radius:5px; }
  .chat-typing { display:flex; align-items:center; gap:10px; color:var(--muted,#8b93b5); }
  .dots { display:inline-flex; gap:4px; } .dots span { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.5; animation:cdot 1.2s infinite ease-in-out; }
  .dots span:nth-child(2){ animation-delay:.18s; } .dots span:nth-child(3){ animation-delay:.36s; }
  @keyframes cdot { 0%,60%,100%{ transform:translateY(0); opacity:.35; } 30%{ transform:translateY(-4px); opacity:1; } }
  .caret { display:inline-block; width:8px; height:15px; margin-left:2px; background:currentColor; vertical-align:text-bottom; animation:cblink 1s steps(2) infinite; opacity:.7; }
  @keyframes cblink { 0%,100%{opacity:0;} 50%{opacity:.8;} }
  .chat-live { display:flex; flex-direction:column; gap:8px; max-width:82%; }
  .cot { border:1px solid var(--line,#232a44); border-radius:10px; background:rgba(127,127,127,.06); font-size:12.5px; overflow:hidden; }
  .cot-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; cursor:pointer; color:var(--muted,#8b93b5); }
  .cot-title { font-weight:600; }
  .cot-toggle { font-size:11px; opacity:.7; }
  .cot-body { max-height:210px; overflow-y:auto; padding:8px 12px; border-top:1px solid var(--line,#232a44); font-family:'Cascadia Code',Consolas,monospace; }
  .cot-line { white-space:pre-wrap; word-break:break-word; opacity:.85; padding:1px 0; }
  .chat-plan { border:1px solid var(--line,#232a44); border-radius:10px; background:rgba(41,82,227,.06); padding:10px 12px; font-size:13px; width:100%; }
  .chat-plan-head { font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted,#8b93b5); margin-bottom:6px; }
  .chat-plan-item { padding:2px 0; color:var(--muted,#8b93b5); line-height:1.45; }
  .chat-plan-item.done { color:var(--text,#e7ebf7); }
  .chat-md > :first-child { margin-top:0; } .chat-md > :last-child { margin-bottom:0; }
  .chat-md p { margin:0 0 8px; }
  .chat-md ul,.chat-md ol { margin:6px 0; padding-left:22px; }
  .chat-md li { margin:2px 0; }
  .chat-md code { background:rgba(0,0,0,.28); padding:1px 5px; border-radius:4px; font-size:.92em; }
  .chat-md pre.code { background:#0b1020; color:#e6e9f0; padding:10px; border-radius:8px; overflow:auto; }
  .chat-md pre.code code { background:none; padding:0; }
  .chat-md h1,.chat-md h2,.chat-md h3 { font-size:15px; margin:8px 0 4px; line-height:1.3; }
  .chat-md a { color:#9db8ff; }
  .chat-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:1000; }
  .chat-modal { background:var(--bg,#0b1020); border:1px solid var(--line,#232a44); border-radius:12px; padding:20px; width:min(420px,92vw); box-shadow:0 16px 48px rgba(0,0,0,.5); }
  .chat-modal h3 { margin:0 0 12px; font-size:16px; }
  .chat-modal-msg { margin:0 0 18px; color:var(--muted,#8b93b5); font-size:14px; line-height:1.55; }
  .chat-modal-input { width:100%; box-sizing:border-box; background:var(--input-bg,#0d1430); color:inherit; border:1px solid var(--line,#232a44); border-radius:8px; padding:10px 12px; font:inherit; margin-bottom:18px; }
  .chat-modal-input:focus { outline:none; border-color:#3168ff; }
  .chat-modal-actions { display:flex; justify-content:flex-end; gap:8px; }
  .chat-docbar { display:flex; align-items:center; gap:10px; padding:10px 16px; border-top:1px solid var(--line,#232a44); background:rgba(41,82,227,.06); }
  .chat-composer { display:flex; gap:10px; padding:14px 16px; border-top:1px solid var(--line,#232a44); align-items:flex-end; }
  .chat-input { flex:1; resize:none; max-height:160px; background:var(--input-bg,#0d1430); color:inherit; border:1px solid var(--line,#232a44); border-radius:10px; padding:11px 12px; font:inherit; box-sizing:border-box; }
  .chat-input:focus { outline:none; border-color:#3168ff; }
  .chat-splitter { flex:0 0 6px; cursor:col-resize; background:transparent; transition:background .15s; }
  .chat-splitter:hover { background:rgba(41,82,227,.35); }
  /* Responsive chat layout. Wide screens: sidebar + thread + design-doc panel side by side (resizable). Below
     this width there isn't room for three usable columns, so the design-doc panel becomes a full-shell overlay
     (it keeps its own close button) instead of squeezing the conversation thread into a sliver; the drag
     splitters - a pointer-only, wide-screen affordance - are hidden. */
  @media (max-width:1240px) {
    .chat-shell { position:relative; }
    .chat-doc { position:absolute; inset:0; width:auto !important; z-index:30; background:var(--bg,#0b1020); box-shadow:0 0 48px rgba(0,0,0,.55); }
    .chat-splitter { display:none; }
  }
  @media (max-width:640px) { .chat-sidebar { display:none; } }
  .chat-doc { flex:0 0 auto; display:flex; flex-direction:column; border-left:1px solid var(--line,#232a44); overflow:hidden; box-sizing:border-box; }
  .chat-doc-top { display:flex; align-items:center; gap:10px; padding:11px 14px; border-bottom:1px solid var(--line,#232a44); }
  .chat-doc-title2 { font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chat-x { border:0; background:none; color:var(--muted,#8b93b5); cursor:pointer; font-size:20px; line-height:1; padding:0 4px; }
  .chat-x:hover { color:inherit; }
  .chat-doc-actions2 { display:flex; gap:6px; flex-wrap:wrap; padding:8px 14px; border-bottom:1px solid var(--line,#232a44); }
  .chat-doc-build2 { display:flex; gap:6px; flex-wrap:wrap; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line,#232a44); }
  .chat-doc-scroll { flex:1; overflow-y:auto; padding:16px; }
  .cbody { font-size:14px; line-height:1.65; } .cbody h1 { font-size:20px; } .cbody h2 { font-size:17px; } .cbody h1,.cbody h2,.cbody h3 { line-height:1.25; }
  .cbody pre.mermaid { background:#fff; border:1px solid var(--line,#232a44); border-radius:8px; padding:12px; text-align:center; overflow:auto; }
  .cbody pre.code { background:#0d1430; color:#e6e9f0; padding:12px; border-radius:8px; overflow:auto; }
  .cbody code { background:rgba(127,127,127,.16); padding:1px 5px; border-radius:4px; }
  .cbody table { border-collapse:collapse; width:100%; margin:10px 0; } .cbody th,.cbody td { border:1px solid var(--line,#232a44); padding:6px 9px; font-size:13px; text-align:left; }
  .cbody blockquote { border-left:3px solid var(--line,#232a44); margin:8px 0; padding:4px 12px; color:var(--muted,#8b93b5); }
  .chat-empty { color:var(--muted,#8b93b5); font-size:13px; padding:10px; }
  .feas { font-size:11px; padding:2px 8px; border-radius:10px; text-transform:uppercase; letter-spacing:.5px; white-space:nowrap; }
  .feas.possible { background:rgba(94,224,138,.2); color:#3fae63; } .feas.conditional { background:rgba(240,190,80,.22); color:#c69a24; } .feas.not-possible { background:rgba(255,122,138,.2); color:#e0596b; }
  .fx-table { border-collapse:collapse; width:100%; } .fx-table th,.fx-table td { border:1px solid var(--line,#232a44); padding:6px 8px; font-size:13px; text-align:left; }
</style>
<script src="/vendor/chart.umd.min.js"></script>
<script src="/vendor/react.min.js"></script>
<script src="/vendor/react-dom.min.js"></script>
</head>
<body>
<header>
  <div class="brand"><span class="mark">S</span><h1>SATURN</h1></div>
  <span id="status" class="status off"><span class="dot"></span><span id="statusText">stopped</span></span>
  <span id="phase" class="phase"></span>
  <span id="modelBadge" class="phase" style="display:none"></span>
  <div class="spacer"></div>
  <button id="themeBtn" class="btn ghost" type="button" title="Toggle light/dark" aria-label="Toggle theme">&#9790;</button>
  <button id="startBtn" class="btn">Start</button>
  <button id="stopBtn" class="btn danger">Stop</button>
</header>
<main>
  <div class="tabs" role="tablist">
    <button id="tabBtnDash" class="tab-btn active" type="button" role="tab">Dashboard</button>
    <button id="tabBtnPr" class="tab-btn" type="button" role="tab">PR review</button>
    <button id="tabBtnAudit" class="tab-btn" type="button" role="tab">Codebase audit</button>
    <button id="tabBtnFix" class="tab-btn" type="button" role="tab">Code Autopilot</button>
    <button id="tabBtnDocs" class="tab-btn" type="button" role="tab">Documentation</button>
    <button id="tabBtnChat" class="tab-btn" type="button" role="tab">Builder Autopilot</button>
  </div>
  <div id="tab-chat" style="display:none">
    <div id="chat-root"></div>
  </div>
  <div id="tab-dash">
    <div class="dash-head"><h2>Codebase audit</h2><span class="dash-sub">Security, privacy &amp; reliability findings across the whole codebase</span></div>
    <div id="dashAudit" class="dash-body"></div>
    <div class="dash-head" style="margin-top:24px"><h2>PR review</h2><span class="dash-sub">Automated pull-request review activity &amp; findings</span></div>
    <div id="dashReview" class="dash-body"></div>
  </div>
  <div id="tab-pr" style="display:none">
  <div class="stats">
    <div class="stat"><div class="k">Total reviews</div><div class="v" id="total">0</div></div>
    <div class="stat"><div class="k">Reviewed PRs</div><div class="v" id="reviewedCount">0</div></div>
    <div class="stat"><div class="k">Currently reviewing</div><div class="v" id="current">-</div></div>
    <div class="stat"><div class="k">Last scan</div><div class="v" id="lastScan">-</div></div>
  </div>
  <div id="health" class="health"></div>
  <details id="agentBox" class="agent"><summary>Agent details</summary><div id="agentBody" class="agent-body"></div></details>
  <details id="insightsBox" class="agent" style="display:none"><summary>Patterns &amp; hotspots</summary><div id="insightsBody" class="agent-body"></div></details>
  <div id="reviewScopeBox" style="display:none;margin:10px 0">
    <label for="reviewScopeInput" class="dash-sub">Review allowlist - aliases / emails (comma or newline separated). Empty = review every non-opted-out PR. Otherwise Saturn only reviews a PR whose author or a reviewer matches an entry.</label>
    <textarea id="reviewScopeInput" rows="2" class="f-input" style="width:100%;box-sizing:border-box;margin-top:6px" placeholder="alias1, alias2@contoso.com"></textarea>
    <div class="meta-row" style="margin-top:6px"><button id="reviewScopeSave" class="btn sm" type="button">Save allowlist</button><span id="reviewScopeStatus" class="muted-note"></span></div>
  </div>
  <div class="section-head"><h2>Reviewed pull requests</h2><span id="prCount" class="count-chip"></span></div>
  <div id="filters" class="filters">
    <input id="fSearch" class="f-input" type="search" placeholder="Search id, title, author" />
    <select id="fStatus" class="f-input" aria-label="Status filter">
      <option value="">All statuses</option>
      <option value="has-findings">Has findings</option>
      <option value="reviewed">Reviewed</option>
      <option value="no-findings">Clean</option>
      <option value="error">Errors</option>
    </select>
    <select id="fCategory" class="f-input" aria-label="Aspect filter">
      <option value="">All aspects</option>
      <option value="security">Security</option>
      <option value="privacy">Privacy</option>
      <option value="correctness">Correctness</option>
      <option value="design">Design</option>
      <option value="api">API</option>
      <option value="testing">Testing</option>
    </select>
    <input id="fAuthor" class="f-input" type="text" placeholder="Author" />
    <span class="f-range">
      <button class="chip-btn" type="button" data-range="1">24h</button>
      <button class="chip-btn" type="button" data-range="7">7d</button>
      <button class="chip-btn" type="button" data-range="30">30d</button>
      <input id="fFrom" class="f-input" type="date" aria-label="From date" />
      <input id="fTo" class="f-input" type="date" aria-label="To date" />
    </span>
    <button id="fClear" class="btn ghost sm" type="button">Clear</button>
  </div>
  <div id="reviews"></div>
  <div id="sentinel" class="sentinel"></div>
  <div id="loader" class="loader" style="display:none"><span class="spinner"></span> Loading&hellip;</div>
  <div id="endNote" class="end-note" style="display:none"></div>
  <div id="fbSection" style="display:none">
    <div class="section-head" style="margin-top:26px"><h2>Recent feedback</h2></div>
    <div id="feedback"></div>
  </div>
  </div>
  <div id="tab-audit" style="display:none">
    <div class="stats">
      <div class="stat"><div class="k">Audit status</div><div class="v" id="aStatus">stopped</div></div>
      <div class="stat"><div class="k">Open findings</div><div class="v" id="aOpen">0</div></div>
      <div class="stat"><div class="k">Bugs filed</div><div class="v" id="aBugs">0</div></div>
      <div class="stat"><div class="k">Sweep progress</div><div class="v" id="aProgress">-</div></div>
    </div>
    <div class="audit-controls">
      <button id="aStartBtn" class="btn">Start audit</button>
      <button id="aStopBtn" class="btn danger">Stop audit</button>
      <label class="switch" title="When on, bugs are filed automatically for new findings"><input type="checkbox" id="aAuto" /> Auto-create bugs</label>
      <a id="aSearch" class="btn ghost sm" href="#" target="_blank" rel="noopener">ADO search &#8599;</a>
      <a id="aSarif" class="btn ghost sm" href="/api/audit/sarif">SARIF &#8675;</a>
      <button id="aAreaOwners" class="btn ghost sm" type="button" title="Edit which team owns which area (vertical) or category (horizontal)">Area owners</button>
      <span id="aBugCfg" class="muted-note"></span>
    </div>
    <div id="aCharts" class="audit-charts"></div>
    <div class="section-head"><h2>Audit findings</h2><span id="aCount" class="count-chip"></span></div>
    <div class="filters">
      <select id="aType" class="f-input" aria-label="Type filter">
        <option value="">All types</option>
        <option value="security">Security</option>
        <option value="privacy">Privacy</option>
        <option value="secrets">Secrets</option>
        <option value="telemetry">Telemetry / PII</option>
        <option value="telemetry-gap">Telemetry gap</option>
        <option value="correctness">Correctness</option>
        <option value="resilience">Resilience</option>
        <option value="performance">Performance</option>
        <option value="accessibility">Accessibility</option>
        <option value="dependency">Dependency</option>
        <option value="api-compat">API compatibility</option>
        <option value="dead-code">Dead code</option>
        <option value="config">Config / IaC</option>
      </select>
      <select id="aSev" class="f-input" aria-label="Severity filter">
        <option value="">All severities</option>
        <option value="blocking">Blocking</option>
        <option value="major">Major</option>
        <option value="minor">Minor</option>
        <option value="nit">Nit</option>
      </select>
      <select id="aState" class="f-input" aria-label="Status filter">
        <option value="open">Open</option>
        <option value="">All</option>
        <option value="wontfix">Won't fix</option>
        <option value="resolved">Resolved</option>
        <option value="dismissed">Dismissed</option>
      </select>
      <input id="aPkg" class="f-input" type="search" placeholder="Package (e.g. my-package)" aria-label="Package filter" list="aPkgList" />
      <datalist id="aPkgList"></datalist>
      <input id="aPath" class="f-input" type="search" placeholder="Path (e.g. packages/my-package/src)" aria-label="Path filter" />
    </div>
    <div id="auditList"></div>
    <div id="auditSentinel" style="height:1px"></div>
    <div id="auditEmpty" class="end-note" style="display:none">No findings match. Start the audit to begin sweeping the codebase.</div>
  </div>
  <div id="tab-fix" style="display:none">
    <div class="dash-head"><h2>Code Autopilot</h2><span class="dash-sub">Pull requests Code Autopilot has opened from assigned bugs</span></div>
    <div style="margin:10px 0">
      <label for="fixScopeInput" class="dash-sub">Scope - packages / repo paths (comma or newline separated). Empty = all bugs. Code Autopilot only fixes bugs touching at least one of these (the fix may still change other files).</label>
      <textarea id="fixScopeInput" rows="2" class="f-input" style="width:100%;box-sizing:border-box;margin-top:6px" placeholder="packages/component-ux, packages/attribution-ux, apps/loop-app/src"></textarea>
      <div class="meta-row" style="margin-top:6px"><input id="fixPkgPick" class="f-input" type="search" list="fixPkgList" placeholder="Pick a package to add&hellip;" style="max-width:320px" aria-label="Add a package to the scope" /><datalist id="fixPkgList"></datalist><button id="fixPkgAdd" class="btn ghost sm" type="button">Add to scope</button></div>
      <div class="meta-row" style="margin-top:6px"><button id="fixScopeSave" class="btn sm" type="button">Save scope</button><span id="fixScopeStatus" class="muted-note"></span></div>
    </div>
    <div id="fixStats" class="meta-row"></div>
    <div id="fixList"><div class="muted-note">Loading&hellip;</div></div>
    <div id="fixEmpty" class="end-note" style="display:none">Code Autopilot hasn't opened any PRs yet. Run it standalone with the <code>saturn-autopilot</code> command.</div>
  </div>
  <div id="tab-docs" style="display:none">
    <div class="dash-head"><h2>Documentation</h2><span class="dash-sub">Overview, README, and design docs for Saturn</span></div>
    <div id="docsBody" class="docs-body">Loading documentation&hellip;</div>
  </div>
</main>
<button id="newPill" class="new-pill" type="button">New reviews &uarr;</button>
<script>
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); };
  var fmtAbs = function (t) { return t ? new Date(t).toLocaleString() : '-'; };
  var fmtRel = function (t) {
    if (!t) { return '-'; }
    var ms = new Date(t).getTime(); if (isNaN(ms)) { return '-'; }
    var s = Math.floor((Date.now() - ms) / 1000);
    if (s < 45) { return 'just now'; }
    var m = Math.floor(s / 60); if (m < 60) { return m + 'm ago'; }
    var h = Math.floor(m / 60); if (h < 24) { return h + 'h ago'; }
    var d = Math.floor(h / 24); if (d < 30) { return d + 'd ago'; }
    return new Date(t).toLocaleDateString();
  };
  var fmtDur = function (ms) {
    if (ms == null || isNaN(ms)) { return ''; }
    var s = Math.round(ms / 1000);
    if (s < 60) { return s + 's'; }
    var m = Math.floor(s / 60);
    if (m < 60) { var rs = s % 60; return m + 'm' + (rs ? ' ' + rs + 's' : ''); }
    var h = Math.floor(m / 60);
    if (h < 24) { var rm = m % 60; return h + 'h' + (rm ? ' ' + rm + 'm' : ''); }
    var dd = Math.floor(h / 24); var rh = h % 24;
    return dd + 'd' + (rh ? ' ' + rh + 'h' : '');
  };
  var sevClass = function (s) {
    var k = String(s || '').toLowerCase();
    if (k.indexOf('block') >= 0) { return 'sev-block'; }
    if (k.indexOf('major') >= 0 || k.indexOf('high') >= 0) { return 'sev-major'; }
    if (k.indexOf('minor') >= 0 || k.indexOf('medium') >= 0) { return 'sev-minor'; }
    if (k.indexOf('nit') >= 0 || k.indexOf('low') >= 0) { return 'sev-nit'; }
    return 'sev-info';
  };
  var statusClass = function (s) { return (s === 'reviewed' || s === 'no-findings') ? 'ok' : (s === 'error' ? 'err' : 'neutral'); };
  var statusLabel = function (s) { return s === 'no-findings' ? 'clean' : String(s || ''); };
  var num = function (v) { return typeof v === 'number' && !isNaN(v) ? v : 0; };

  var loaded = [];
  var loadedIds = {};
  var nextCursor = null;
  var loading = false;
  var reachedEnd = false;
  var expanded = {};
  var lastSig = null;
  var firstStateApplied = false;
  var isOwnerClient = false;
  var LIMIT = 12;
  var curStartedAt = null;
  var filters = { search: '', status: '', category: '', author: '', fromMs: null, toMs: null };
  var resCache = {};

  var post = function (p) { fetch(p, { method: 'POST' }).then(function () { return fetch('/api/state'); }).then(function (r) { return r.json(); }).then(applyState).catch(function () {}); };
  document.getElementById('startBtn').onclick = function () { post('/api/start'); };
  document.getElementById('stopBtn').onclick = function () { post('/api/stop'); };

  function hasActiveFilters() { return !!(filters.search || filters.status || filters.category || filters.author || filters.fromMs || filters.toMs); }
  function reviewsUrl() {
    var q = 'limit=' + LIMIT + (nextCursor ? '&cursor=' + encodeURIComponent(nextCursor) : '');
    if (filters.search) { q += '&search=' + encodeURIComponent(filters.search); }
    if (filters.status) { q += '&status=' + encodeURIComponent(filters.status); }
    if (filters.category) { q += '&category=' + encodeURIComponent(filters.category); }
    if (filters.author) { q += '&author=' + encodeURIComponent(filters.author); }
    if (filters.fromMs) { q += '&from=' + filters.fromMs; }
    if (filters.toMs) { q += '&to=' + filters.toMs; }
    return '/api/reviews?' + q;
  }

  function renderComment(c) {
    var sc = sevClass(c.severity);
    var cat = c.category ? '<span class="cat ' + esc(c.category) + '">' + esc(c.category) + '</span>' : '';
    var conf = (c.confidence != null) ? '<span class="cat" title="verification confidence">conf ' + Math.round(c.confidence * 100) + '%</span>' : '';
    var open = c.deepLink ? ' &middot; <a href="' + esc(c.deepLink) + '" target="_blank" rel="noopener">open comment</a>' : '';
    var res = c.threadId ? '<span class="res" data-thread="' + c.threadId + '"></span>' : '';
    return '<div class="comment ' + sc + '"><div class="loc"><span class="chip ' + sc + '">' + esc(c.severity) + '</span>' + cat + conf + res
      + '<span class="path">' + esc(c.filePath) + ':' + c.line + '</span>' + open + '</div>'
      + '<div class="c-title">' + esc(c.title) + '</div><div class="c-body">' + esc(c.body) + '</div></div>';
  }
  function iterMeta(it) {
    var parts = [];
    if (it.model) { parts.push('<span class="tag">' + esc(it.model) + (it.reasoningEffort ? ' &middot; ' + esc(it.reasoningEffort) : '') + '</span>'); }
    if (it.durationMs != null) { parts.push('<span class="tag">took ' + esc(fmtDur(it.durationMs)) + '</span>'); }
    if (it.iterationCreatedAt && it.reviewedAt) {
      var lat = Date.parse(it.reviewedAt) - Date.parse(it.iterationCreatedAt);
      if (!isNaN(lat) && lat >= 0) { parts.push('<span class="tag">' + esc(fmtDur(lat)) + ' to review</span>'); }
    }
    if (it.filesReviewed != null) {
      var partial = it.diffTruncated || (it.filesChanged != null && it.filesChanged > it.filesReviewed);
      parts.push('<span class="tag' + (partial ? ' warn' : '') + '">' + it.filesReviewed + (it.filesChanged != null ? '/' + it.filesChanged : '') + ' files' + (partial ? ' (truncated)' : '') + '</span>');
    }
    if (it.candidatesProposed != null) { parts.push('<span class="tag">verified ' + num(it.candidatesKept) + '/' + it.candidatesProposed + '</span>'); }
    return parts.length ? '<div class="meta-row">' + parts.join('') + '</div>' : '';
  }
  function renderDropped(d) {
    var cat = d.category ? '<span class="cat">' + esc(d.category) + '</span>' : '';
    var conf = (d.confidence != null) ? '<span class="cat">conf ' + Math.round(d.confidence * 100) + '%</span>' : '';
    return '<div class="comment" style="opacity:.7"><div class="loc"><span class="chip sev-nit">dropped</span>' + cat + conf
      + '<span class="path">' + esc(d.filePath) + ':' + d.line + '</span></div>'
      + '<div class="c-title">' + esc(d.title) + '</div><div class="c-body">' + esc(d.reason) + '</div></div>';
  }
  function renderDroppedSection(it) {
    var list = it.droppedFindings || [];
    if (!list.length) { return ''; }
    return '<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:12.5px">Dropped by gate (' + list.length + ') &middot; owner-only</summary>'
      + list.map(renderDropped).join('') + '</details>';
  }
  function renderIteration(it) {
    var comments = (it.comments || []).map(renderComment).join('');
    var detail = it.detail ? '<div class="iter-detail">' + esc(it.detail) + '</div>' : '';
    var fallback = it.status === 'error' ? '' : '<div class="muted" style="font-size:12.5px">No blocking issues found.</div>';
    return '<div class="iter"><div class="iter-head"><span class="pill ' + statusClass(it.status) + '">' + esc(statusLabel(it.status)) + '</span>'
      + '<span>Iteration #' + it.iterationId + '</span><span>&middot;</span><span>' + it.commentsPosted + ' comment(s)</span><span>&middot;</span>'
      + '<span title="' + esc(fmtAbs(it.reviewedAt)) + '">' + esc(fmtRel(it.reviewedAt)) + '</span></div>'
      + iterMeta(it) + detail + (comments || fallback) + renderDroppedSection(it) + '</div>';
  }
  function sevMiniHtml(counts) {
    var order = [['blocking', 'sev-block'], ['major', 'sev-major'], ['minor', 'sev-minor'], ['nit', 'sev-nit']];
    var html = '';
    for (var i = 0; i < order.length; i++) {
      var n = counts[order[i][0]] || 0;
      if (n) { html += '<span class="sevdot ' + order[i][1] + '" title="' + order[i][0] + ': ' + n + '">' + n + '</span>'; }
    }
    return html ? '<span class="sevmini">' + html + '</span>' : '';
  }
  function cardHtml(r) {
    var iterations = (r.iterations || []).slice().sort(function (a, b) { return b.iterationId - a.iterationId; });
    var latest = iterations[0] || {};
    var bodyId = 'pr-body-' + r.pullRequestId;
    var isOpen = !!expanded[r.pullRequestId];
    var iterHtml = iterations.map(renderIteration).join('');
    var catSet = {};
    var sevCounts = {};
    iterations.forEach(function (it) { (it.comments || []).forEach(function (c) { if (c.category) { catSet[c.category] = 1; } }); });
    (latest.comments || []).forEach(function (c) { sevCounts[c.severity] = (sevCounts[c.severity] || 0) + 1; });
    var catChips = Object.keys(catSet).map(function (k) { return '<span class="cat ' + esc(k) + '">' + esc(k) + '</span>'; }).join('');
    return '<div class="pr' + (isOpen ? ' open' : '') + '" data-id="' + r.pullRequestId + '">'
      + '<button class="pr-head" aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-controls="' + bodyId + '">'
      + '<span class="chevron">&#8250;</span><span class="pr-id">#' + r.pullRequestId + '</span>'
      + '<span class="pr-title">' + esc(r.title) + '</span>'
      + '<span class="pr-sub">' + sevMiniHtml(sevCounts) + catChips + '<span class="pr-meta">' + esc(r.author) + ' &middot; ' + iterations.length + ' iter &middot; ' + esc(fmtRel(latest.reviewedAt)) + '</span>'
      + '<span class="pill ' + statusClass(latest.status) + '">' + esc(statusLabel(latest.status)) + '</span></span></button>'
      + '<div class="pr-body" id="' + bodyId + '" role="region"><div class="pr-body-inner"><div class="pr-body-pad">'
      + '<div class="iter-head" style="margin-bottom:12px"><a href="' + esc(r.webUrl) + '" target="_blank" rel="noopener">Open PR #' + r.pullRequestId + ' in Azure DevOps &#8599;</a></div>'
      + iterHtml + '</div></div></div></div>';
  }
  function mergeReviews(items) {
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      if (loadedIds[r.pullRequestId]) { continue; }
      loadedIds[r.pullRequestId] = true;
      loaded.push(r);
    }
  }
  // Shared list-windowing engine: mounts only the rows overlapping the viewport (+ overscan) and reserves the
  // rest with top/bottom spacer divs, so the DOM stays bounded while infinite-scrolling. Continuous scrolling
  // measures each row before it leaves the window, so spacer heights are exact and the scroll never jumps. Both
  // the Codebase-audit and PR-review lists are instances of this (see auditWindow / reviewWindow below).
  function makeListWindow(cfg) {
    var rowH = [];
    var winStart = 0, winEnd = 0;
    var raf = 0;
    function container() { return document.getElementById(cfg.containerId); }
    function topEl() { return document.getElementById(cfg.topId); }
    function botEl() { return document.getElementById(cfg.botId); }
    function ensureScaffold() {
      var c = container();
      if (c && !document.getElementById(cfg.topId)) {
        c.innerHTML = '<div id="' + cfg.topId + '"></div><div id="' + cfg.botId + '"></div>';
      }
      return c;
    }
    function rowHeight(i) { return rowH[i] || cfg.estHeight; }
    function sumH(a, b) { var s = 0; for (var i = a; i < b; i++) { s += rowHeight(i); } return s; }
    // Cache each mounted row's real height (incl its bottom margin); skip 0 (tab hidden) so the cache is not
    // polluted before the tab is first shown.
    function measure() {
      var c = container();
      if (!c) { return; }
      var cards = c.querySelectorAll(':scope > ' + cfg.rowSelector);
      for (var k = 0; k < cards.length; k++) { var h = cards[k].offsetHeight; if (h > 0) { rowH[winStart + k] = h + cfg.rowGap; } }
    }
    function spacers() {
      var t = topEl(), b = botEl();
      var n = cfg.getData().length;
      if (t) { t.style.height = sumH(0, winStart) + 'px'; }
      if (b) { b.style.height = sumH(winEnd, n) + 'px'; }
    }
    function render(force) {
      var c = ensureScaffold();
      if (!c) { return; }
      var t = topEl(), b = botEl();
      var data = cfg.getData();
      var N = data.length;
      var node, nx;
      if (N === 0) {
        node = t.nextSibling;
        while (node && node !== b) { nx = node.nextSibling; c.removeChild(node); node = nx; }
        t.style.height = '0px'; b.style.height = '0px';
        winStart = 0; winEnd = 0;
        if (cfg.emptyHtml) { t.insertAdjacentHTML('afterend', cfg.emptyHtml()); }
        return;
      }
      var docTop = c.getBoundingClientRect().top + window.scrollY;
      var rawTop = window.scrollY - docTop;
      var viewTop = rawTop < 0 ? 0 : rawTop;
      var viewBot = rawTop + window.innerHeight;
      var start = 0, acc = 0;
      while (start < N && acc + rowHeight(start) <= viewTop) { acc += rowHeight(start); start++; }
      start = Math.max(0, start - cfg.overscan);
      var end = start, accEnd = sumH(0, start);
      while (end < N && accEnd < viewBot) { accEnd += rowHeight(end); end++; }
      end = Math.min(N, end + cfg.overscan);
      if (!force && start === winStart && end === winEnd) { return; }
      winStart = start; winEnd = end;
      var html = '';
      for (var i = start; i < end; i++) { html += cfg.renderRow(data[i]); }
      node = t.nextSibling;
      while (node && node !== b) { nx = node.nextSibling; c.removeChild(node); node = nx; }
      t.insertAdjacentHTML('afterend', html);
      t.style.height = sumH(0, start) + 'px';
      b.style.height = sumH(end, N) + 'px';
      if (cfg.afterRender) { cfg.afterRender(c); }
      measure();
    }
    function onScroll() {
      if (raf) { return; }
      raf = requestAnimationFrame(function () {
        raf = 0;
        var tab = document.getElementById(cfg.tabId);
        if (tab && tab.style.display === 'none') { return; }
        render(false);
      });
    }
    function reset() { rowH = []; winStart = 0; winEnd = 0; }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return { render: render, measure: measure, spacers: spacers, reset: reset };
  }
  var auditWindow = makeListWindow({
    containerId: 'auditList', topId: 'auditTop', botId: 'auditBot', rowSelector: '.comment',
    rowGap: 8, estHeight: 190, overscan: 6, tabId: 'tab-audit',
    getData: function () { return auditFindings; },
    renderRow: function (f) { return renderFinding(f); },
    afterRender: function () { wireAuditButtons(); }
  });
  var reviewWindow = makeListWindow({
    containerId: 'reviews', topId: 'prTop', botId: 'prBot', rowSelector: '.pr',
    rowGap: 12, estHeight: 70, overscan: 4, tabId: 'tab-pr',
    getData: function () { return loaded; },
    renderRow: function (r) { return cardHtml(r); },
    afterRender: function (c) { var open = c.querySelectorAll(':scope > .pr.open'); for (var openIndex = 0; openIndex < open.length; openIndex++) { loadResolution(open[openIndex], open[openIndex].getAttribute('data-id')); } },
    emptyHtml: function () { return '<div class="empty">' + (hasActiveFilters() ? 'No pull requests match these filters.' : 'No pull requests reviewed yet. Saturn will list them here as it reviews.') + '</div>'; }
  });
  // Thin wrappers so the existing call sites keep working against the shared engine.
  function renderReviewWindow(force) { reviewWindow.render(force); }
  function measureReviewWindow() { reviewWindow.measure(); }
  function updatePrSpacers() { reviewWindow.spacers(); }
  function renderAuditWindow(force) { auditWindow.render(force); }
  function measureAuditWindow() { auditWindow.measure(); }
  // Reset render (filter change / tab open): clear measured heights + window and lay out from the top.
  function renderAuditList() { auditWindow.reset(); auditWindow.render(true); updateAuditMeta(); }
  function loadMore() {
    if (loading || reachedEnd) { return; }
    loading = true;
    document.getElementById('loader').style.display = 'flex';
    fetch(reviewsUrl()).then(function (r) { return r.json(); }).then(function (p) {
      var items = p.items || [];
      if (!loaded.length && items.length && Object.keys(expanded).length === 0) { expanded[items[0].pullRequestId] = true; }
      mergeReviews(items);
      renderReviewWindow(true);
      nextCursor = p.nextCursor || null;
      reachedEnd = !nextCursor;
      document.getElementById('prCount').textContent = (p.total || 0) + (hasActiveFilters() ? ' match' : ' total');
      loading = false;
      document.getElementById('loader').style.display = 'none';
      var en = document.getElementById('endNote');
      if (reachedEnd && loaded.length) { en.style.display = 'block'; en.textContent = 'All ' + loaded.length + ' PR(s)' + (hasActiveFilters() ? ' matching the filters.' : '.'); } else { en.style.display = 'none'; }
      maybeLoadMore();
    }).catch(function () { loading = false; document.getElementById('loader').style.display = 'none'; });
  }
  function maybeLoadMore() {
    var s = document.getElementById('sentinel');
    if (!reachedEnd && !loading && s.getBoundingClientRect().top < window.innerHeight + 320) { loadMore(); }
  }
  function refreshFromTop() {
    loaded = []; loadedIds = {}; nextCursor = null; reachedEnd = false; loading = false;
    reviewWindow.reset();
    document.getElementById('reviews').innerHTML = '';
    document.getElementById('endNote').style.display = 'none';
    hideNewPill();
    loadMore();
  }

  function readFilterInputs() {
    filters.search = document.getElementById('fSearch').value.trim();
    filters.status = document.getElementById('fStatus').value;
    filters.category = document.getElementById('fCategory').value;
    filters.author = document.getElementById('fAuthor').value.trim();
    var from = document.getElementById('fFrom').value;
    var to = document.getElementById('fTo').value;
    filters.fromMs = from ? new Date(from + 'T00:00:00').getTime() : null;
    filters.toMs = to ? new Date(to + 'T23:59:59').getTime() : null;
  }
  function applyFilters() { readFilterInputs(); refreshFromTop(); }
  function clearRangeChips() { var c = document.querySelectorAll('.chip-btn[data-range]'); for (var i = 0; i < c.length; i++) { c[i].classList.remove('active'); } }
  var filterDebounce = null;
  function debouncedApply() { if (filterDebounce) { clearTimeout(filterDebounce); } filterDebounce = setTimeout(applyFilters, 320); }
  document.getElementById('fSearch').addEventListener('input', debouncedApply);
  document.getElementById('fAuthor').addEventListener('input', debouncedApply);
  document.getElementById('fStatus').addEventListener('change', applyFilters);
  document.getElementById('fCategory').addEventListener('change', applyFilters);
  document.getElementById('fFrom').addEventListener('change', function () { clearRangeChips(); applyFilters(); });
  document.getElementById('fTo').addEventListener('change', function () { clearRangeChips(); applyFilters(); });
  var rangeChips = document.querySelectorAll('.chip-btn[data-range]');
  for (var ri = 0; ri < rangeChips.length; ri++) {
    rangeChips[ri].addEventListener('click', function (e) {
      var chip = e.currentTarget;
      var wasActive = chip.classList.contains('active');
      var days = parseInt(chip.getAttribute('data-range'), 10);
      clearRangeChips();
      document.getElementById('fTo').value = '';
      if (wasActive) {
        document.getElementById('fFrom').value = '';
      } else {
        chip.classList.add('active');
        document.getElementById('fFrom').value = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      }
      applyFilters();
    });
  }
  document.getElementById('fClear').onclick = function () {
    document.getElementById('fSearch').value = ''; document.getElementById('fStatus').value = ''; document.getElementById('fCategory').value = '';
    document.getElementById('fAuthor').value = ''; document.getElementById('fFrom').value = ''; document.getElementById('fTo').value = '';
    clearRangeChips();
    filters = { search: '', status: '', category: '', author: '', fromMs: null, toMs: null };
    refreshFromTop();
  };

  function resInfo(status) {
    var s = String(status).toLowerCase();
    if (s === 'fixed' || s === '2') { return { label: 'fixed', cls: 'ok' }; }
    if (s === 'closed' || s === '4') { return { label: 'closed', cls: 'ok' }; }
    if (s === 'wontfix' || s === '3') { return { label: "won't fix", cls: 'ok' }; }
    if (s === 'bydesign' || s === '5') { return { label: 'by design', cls: 'ok' }; }
    if (s === 'pending' || s === '6') { return { label: 'pending', cls: 'warn' }; }
    if (s === 'active' || s === '1') { return { label: 'active', cls: 'warn' }; }
    return { label: s, cls: '' };
  }
  function applyResolution(spans, map) {
    for (var i = 0; i < spans.length; i++) {
      var tid = spans[i].getAttribute('data-thread');
      if (map[tid] !== undefined) { var info = resInfo(map[tid]); spans[i].className = 'res ' + info.cls; spans[i].textContent = info.label; spans[i].title = 'ADO thread: ' + info.label; }
    }
  }
  // Cache thread statuses per PR so windowing can re-apply them when a card recycles back in (no re-fetch).
  function loadResolution(pr, id) {
    if (!pr) { return; }
    var spans = pr.querySelectorAll('.res[data-thread]');
    if (!spans.length) { return; }
    if (resCache[id]) { applyResolution(spans, resCache[id]); return; }
    fetch('/api/pr-threads?prId=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (p) {
      var map = {}; (p.threads || []).forEach(function (t) { map[t.threadId] = t.status; });
      resCache[id] = map;
      applyResolution(spans, map);
    }).catch(function () {});
  }
  document.getElementById('reviews').addEventListener('click', function (e) {
    var head = e.target.closest ? e.target.closest('.pr-head') : null;
    if (!head || e.target.closest('a')) { return; }
    var pr = head.parentNode; var id = pr.getAttribute('data-id');
    var willOpen = !pr.classList.contains('open');
    pr.classList.toggle('open', willOpen);
    head.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) { expanded[id] = true; try { history.replaceState(null, '', '#pr-' + id); } catch (err) {} loadResolution(pr, id); } else { delete expanded[id]; }
    setTimeout(function () { measureReviewWindow(); updatePrSpacers(); }, 320);
  });
  var newPill = document.getElementById('newPill');
  function showNewPill() { newPill.classList.add('show'); }
  function hideNewPill() { newPill.classList.remove('show'); }
  newPill.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }); refreshFromTop(); };

  function pct(n, d) { return d > 0 ? Math.round((100 * n) / d) : 0; }
  function metric(label, value, color) {
    return '<span class="metric">' + (color ? '<span class="swatch" style="background:' + color + '"></span>' : '') + esc(label) + ' <b>' + value + '</b></span>';
  }
  function sparklineHtml(daily) {
    if (!daily || !daily.length) { return ''; }
    var max = 1;
    for (var i = 0; i < daily.length; i++) { if (daily[i].count > max) { max = daily[i].count; } }
    return '<span class="spark">' + daily.map(function (d) {
      var barHeight = Math.max(2, Math.round((20 * d.count) / max));
      return '<span class="sb" style="height:' + barHeight + 'px" title="' + esc(d.day) + ': ' + d.count + '"></span>';
    }).join('') + '</span>';
  }
  function renderHealth(s) {
    var el = document.getElementById('health');
    if (!s || !s.total) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    var sev = s.bySeverity || {}; var cat = s.byCategory || {}; var eb = s.errorBreakdown || {};
    var errKeys = Object.keys(eb);
    var errHtml = errKeys.length
      ? '<div class="group"><span class="glabel">Error causes</span>' + errKeys.map(function (k) { return metric(k, eb[k], k === 'timeout' ? 'var(--err)' : ''); }).join('') + '</div>'
      : '';
    el.innerHTML =
      '<div class="group"><span class="glabel">Health</span>' + metric('reviewed', num(s.reviewed), 'var(--ok)')
        + metric('clean', num(s.noFindings), 'var(--accent)') + metric('errors', num(s.error), 'var(--err)')
        + '<span class="metric">error rate <b>' + pct(num(s.error), num(s.total)) + '%</b></span></div>'
      + '<div class="group"><span class="glabel">Findings</span>' + metric('blocking', num(sev.blocking)) + metric('major', num(sev.major))
        + metric('minor', num(sev.minor)) + metric('nit', num(sev.nit)) + '</div>'
      + '<div class="group"><span class="glabel">Aspects</span>' + metric('security', num(cat.security), '#ff8497') + metric('privacy', num(cat.privacy), '#ff8497')
        + metric('correctness', num(cat.correctness)) + metric('design', num(cat.design)) + metric('api', num(cat.api)) + metric('testing', num(cat.testing)) + '</div>'
      + errHtml
      + '<div class="group"><span class="glabel">Throughput</span>' + metric('24h', num(s.reviewedToday)) + metric('7d', num(s.reviewedWeek))
        + (s.avgDurationMs ? '<span class="metric">avg <b>' + esc(fmtDur(s.avgDurationMs)) + '</b></span>' : '') + sparklineHtml(s.daily) + '</div>';
  }
  function renderInsights(s) {
    var box = document.getElementById('insightsBox'); var body = document.getElementById('insightsBody');
    if (!box || !body) { return; }
    var titles = s && s.topTitles ? s.topTitles : []; var files = s && s.topFiles ? s.topFiles : [];
    if (!titles.length && !files.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    var t = titles.map(function (x) { return '<div class="scan-row"><span class="tag">x' + x.count + '</span><span>' + esc(x.title) + '</span></div>'; }).join('');
    var f = files.map(function (x) { return '<div class="scan-row"><span class="tag">x' + x.count + '</span><span class="path">' + esc(x.path) + '</span></div>'; }).join('');
    body.innerHTML = '<div class="glabel">Recurring findings</div>' + (t || '<div class="muted">None yet.</div>')
      + '<div class="glabel" style="margin-top:10px">File hotspots</div>' + (f || '<div class="muted">None yet.</div>');
  }
  function loadStats() { fetch('/api/stats').then(function (r) { return r.json(); }).then(function (s) { renderHealth(s); renderInsights(s); }).catch(function () {}); }
  function renderAgent(s) {
    var body = document.getElementById('agentBody'); if (!body) { return; }
    var c = s.config || {};
    var repo = (c.organization || '') + '/' + (c.project || '') + '/' + (c.repositoryName || '');
    var cfg = '<div class="agent-cfg"><span>model <b style="color:var(--text)">' + esc(c.model || '-') + '</b></span>'
      + '<span>effort ' + esc(c.reasoningEffort || '-') + '</span>'
      + '<span>repo <b style="color:var(--text)">' + esc(repo) + '</b></span>'
      + '<span>branch ' + esc(c.defaultBranch || '-') + '</span>'
      + (c.commit ? '<span>build ' + esc(String(c.commit).slice(0, 8)) + '</span>' : '')
      + '<span>scan every ' + Math.round(num(c.scanIntervalMs) / 60000) + 'm</span>'
      + '<span>cap ' + num(c.maxReviews) + ' reviews / ' + num(c.maxComments) + ' comments</span>'
      + '<span>uptime ' + (s.startedAt ? esc(fmtRel(s.startedAt)) : '-') + '</span></div>';
    var up = s.upNext || [];
    var upHtml = up.length
      ? '<div class="scan-row"><span class="glabel">Up next</span><span>' + up.slice(0, 8).map(function (p) { return '#' + p.id; }).join(', ') + '</span></div>'
      : '';
    var scans = (s.recentScans || []).map(function (r) {
      return '<div class="scan-row"><span>' + esc(fmtRel(r.at)) + '</span><span>' + esc(r.kind) + '</span><span>scanned ' + num(r.scanned)
        + '</span><span>reviewed ' + num(r.reviewed) + '</span>' + (r.skipped ? '<span>skipped ' + num(r.skipped) + '</span>' : '')
        + (r.errors ? '<span style="color:var(--err)">errors ' + num(r.errors) + '</span>' : '') + '</div>';
    }).join('');
    body.innerHTML = cfg + upHtml + (scans || '<div class="scan-row" style="border:0;padding:0">No scans yet this session.</div>');
  }

  function renderFeedback(items) {
    var sec = document.getElementById('fbSection');
    var fb = document.getElementById('feedback');
    if (!items || !items.length) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    fb.innerHTML = items.map(function (f) {
      var label = f.rating === 'up' ? ' &middot; Helpful' : (f.rating === 'down' ? ' &middot; Not helpful' : '');
      return '<div class="fb"><div class="meta">' + esc(f.submittedBy) + label + ' &middot; ' + esc(fmtRel(f.submittedAt))
        + ' &middot; <a href="' + esc(f.prUrl) + '" target="_blank" rel="noopener">PR #' + f.pullRequestId + '</a>'
        + ' &middot; <a href="' + esc(f.commentDeepLink) + '" target="_blank" rel="noopener">view comment</a></div>'
        + (f.message ? '<div style="margin-top:4px">' + esc(f.message) + '</div>' : '') + '</div>';
    }).join('');
  }
  function loadFeedback() {
    fetch('/api/feedback').then(function (r) { return r.json(); }).then(function (p) { renderFeedback(p.feedback || []); }).catch(function () {});
  }
  function tickTimer() {
    var el = document.getElementById('curElapsed');
    if (el && curStartedAt) {
      var ms = Date.now() - new Date(curStartedAt).getTime();
      if (!isNaN(ms) && ms >= 0) { el.textContent = fmtDur(ms); }
    }
  }
  function applyState(s) {
    var badge = document.getElementById('status');
    badge.className = 'status ' + (s.running ? 'on' : 'off');
    document.getElementById('statusText').textContent = s.running ? 'running' : 'stopped';
    document.getElementById('phase').textContent = s.phase || '';
    document.getElementById('total').textContent = s.totalReviewed;
    document.getElementById('reviewedCount').textContent = s.reviewedPullRequestCount;
    var ls = document.getElementById('lastScan'); ls.textContent = fmtRel(s.lastScanAt); ls.title = fmtAbs(s.lastScanAt);
    var cur = document.getElementById('current');
    curStartedAt = s.currentPullRequestStartedAt || null;
    cur.innerHTML = s.currentPullRequest
      ? '<a href="' + esc(s.currentPullRequest.webUrl) + '" target="_blank" rel="noopener">#' + s.currentPullRequest.id + '</a> <span id="curElapsed" class="muted" style="font-size:13px"></span>'
      : '-';
    tickTimer();
    renderAgent(s);
    if (isOwnerClient) {
      document.getElementById('startBtn').disabled = !!s.running;
      document.getElementById('stopBtn').disabled = !s.running;
    }
    var sig = s.totalReviewed + ':' + s.reviewedPullRequestCount;
    if (!firstStateApplied) { firstStateApplied = true; lastSig = sig; return; }
    if (sig !== lastSig) {
      lastSig = sig;
      loadStats();
      if (!hasActiveFilters() && window.scrollY < 240) { refreshFromTop(); } else { showNewPill(); }
      loadFeedback();
    }
  }
  function connectEvents() {
    if (typeof EventSource !== 'undefined') {
      var es = new EventSource('/api/events');
      es.onmessage = function (e) { try { applyState(JSON.parse(e.data)); } catch (err) {} };
    } else {
      setInterval(function () { fetch('/api/state').then(function (r) { return r.json(); }).then(applyState).catch(function () {}); }, 2500);
    }
  }

  var themeBtn = document.getElementById('themeBtn');
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function paintThemeBtn() { themeBtn.innerHTML = currentTheme() === 'light' ? '&#9728;' : '&#9790;'; }
  paintThemeBtn();
  themeBtn.onclick = function () {
    var next = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('saturn-theme', next); } catch (err) {}
    paintThemeBtn();
  };

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) { if (entries[0] && entries[0].isIntersecting) { loadMore(); } }, { rootMargin: '320px' });
    io.observe(document.getElementById('sentinel'));
    var aio = new IntersectionObserver(function (entries) {
      if (entries[0] && entries[0].isIntersecting && document.getElementById('tab-audit').style.display !== 'none') { auditLoadMore(); }
    }, { rootMargin: '320px' });
    var asent = document.getElementById('auditSentinel'); if (asent) { aio.observe(asent); }
  } else {
    window.addEventListener('scroll', maybeLoadMore);
  }
  // ---- Codebase audit tab ----
  var auditFindings = [];
  var auditFilter = { type: '', sev: '', state: 'open', pkg: '', path: '' };
  var AUDIT_PAGE = 50;
  var auditCursor = null;
  var auditTotal = 0;
  var auditLoadingPage = false;
  var auditSummarySig = null;
  var auditDetailOpen = {};
  var auditPollTimer = null;
  var apost = function (p, body) {
    return fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); });
  };
  function applyAuditState(s) {
    if (!s) { return; }
    var st = document.getElementById('aStatus'); if (st) { st.textContent = s.running ? (s.phase || 'running') : 'stopped'; }
    document.getElementById('aOpen').textContent = num(s.openCount);
    document.getElementById('aBugs').textContent = num(s.bugsFiled);
    document.getElementById('aProgress').textContent = s.totalFiles ? (Math.round(num(s.filesScanned) / num(s.totalFiles) * 100) + '% \\u00b7 ' + num(s.filesScanned) + ' / ' + num(s.totalFiles) + ' (sweep ' + num(s.sweepNumber) + ')') : (s.running ? 'starting\\u2026' : '-');
    var sw = document.getElementById('aSearch'); if (sw && s.searchUrl) { sw.href = s.searchUrl; }
    var auto = document.getElementById('aAuto'); if (auto) { auto.checked = !!s.autoCreate; auto.disabled = !isOwnerClient; }
    var cfg = document.getElementById('aBugCfg'); if (cfg) { cfg.textContent = 'Bugs route to the owning team automatically (from each package\u2019s ownership.json).'; }
    var sb = document.getElementById('aStartBtn'); if (sb) { sb.disabled = !isOwnerClient || !!s.running; }
    var pb = document.getElementById('aStopBtn'); if (pb) { pb.disabled = !isOwnerClient || !s.running; }
  }
  function locLabel(p, line, endLine) {
    return esc(p) + ':' + esc(line) + (endLine && endLine > line ? '-' + esc(endLine) : '');
  }
  // ---- Modal dialog infra (lives outside the audit list, so list refreshes never wipe an open dialog) ----
  function closeModal() {
    var ov = document.getElementById('saturnModal');
    if (ov && ov.parentNode) { ov.parentNode.removeChild(ov); }
  }
  function openModal(buildBody) {
    closeModal();
    var ov = document.createElement('div'); ov.id = 'saturnModal'; ov.className = 'modal-overlay';
    var card = document.createElement('div'); card.className = 'modal-card';
    ov.appendChild(card);
    ov.addEventListener('click', function (e) { if (e.target === ov) { closeModal(); } });
    document.body.appendChild(ov);
    buildBody(card);
    return card;
  }
  function mkBtn(label, cls) { var b = document.createElement('button'); b.type = 'button'; b.className = cls || 'btn sm'; b.textContent = label; return b; }
  // Success panel after a bug is filed - stays open until the user closes it (no auto-dismiss / reload wipe).
  function showBugCreated(card, finding) {
    card.innerHTML = '';
    var h = document.createElement('h3'); h.textContent = 'Bug filed'; card.appendChild(h);
    var sub = document.createElement('p'); sub.className = 'modal-sub';
    if (finding && finding.adoBugUrl) {
      sub.innerHTML = 'Created <a href="' + esc(finding.adoBugUrl) + '" target="_blank" rel="noopener">bug #' + esc(finding.adoBugId) + '</a>'
        + (finding.adoAreaPath ? ' under <b>' + esc(finding.adoAreaPath) + '</b>' : '')
        + (finding.adoAssignedTo ? ', assigned to ' + esc(finding.adoAssignedTo) : '') + '.';
    } else { sub.textContent = 'Bug filed.'; }
    card.appendChild(sub);
    var actions = document.createElement('div'); actions.className = 'modal-actions';
    if (finding && finding.adoBugUrl) {
      var open = document.createElement('a'); open.className = 'btn sm'; open.href = finding.adoBugUrl; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open bug \\u2197';
      actions.appendChild(open);
    }
    var close = mkBtn('Close', 'btn ghost sm'); actions.appendChild(close); card.appendChild(actions);
    close.onclick = function () { closeModal(); };
  }
  // Merge the filed-bug fields into the loaded finding and re-render so the row flips from "Create bug" to
  // "Open bug #N" immediately, without waiting for (or requiring) a full refresh.
  function applyCreatedBug(finding) {
    if (!finding) { return; }
    for (var i = 0; i < auditFindings.length; i++) {
      if (auditFindings[i].id === finding.id) {
        auditFindings[i].adoBugId = finding.adoBugId;
        auditFindings[i].adoBugUrl = finding.adoBugUrl;
        auditFindings[i].adoAreaPath = finding.adoAreaPath;
        auditFindings[i].adoAssignedTo = finding.adoAssignedTo;
        break;
      }
    }
    renderAuditWindow(true);
    fetch('/api/audit/state').then(function (r) { return r.json(); }).then(applyAuditState).catch(function () {});
  }
  // Editor for the curated area -> owning-team map (open to every viewer). Vertical = path prefix override;
  // horizontal = category routing option. Prepopulated from saved entries, else auto-derived suggestions.
  function openAreaOwnersDialog() {
    fetch('/api/audit/area-owners').then(function (r) { return r.json(); }).then(function (d) {
      var saved = (d && d.entries) || [];
      var defaults = (d && d.defaults) || [];
      var rows = saved.length ? saved.slice() : defaults.slice();
      openModal(function (card) {
        var h = document.createElement('h3'); h.textContent = 'Area owners'; card.appendChild(h);
        var sub = document.createElement('p'); sub.className = 'modal-sub';
        sub.innerHTML = 'Map an area to the team that owns its bugs. <b>Vertical</b> = a code path prefix (e.g. <code>packages/foo</code>) that overrides the auto-derived package owner. <b>Horizontal</b> = a finding category (e.g. <code>security</code>) offered as a routing option. Rows left blank fall back to the current auto-derived owners.';
        card.appendChild(sub);
        var table = document.createElement('table'); table.className = 'ao-table';
        table.innerHTML = '<thead><tr><th>Kind</th><th>Key (path or category)</th><th>ADO area path</th><th>Assignee (optional)</th><th></th></tr></thead>';
        var tbody = document.createElement('tbody'); table.appendChild(tbody); card.appendChild(table);
        function addRow(entry) {
          entry = entry || { kind: 'vertical', key: '', areaPath: '', assignedTo: '' };
          var tr = document.createElement('tr');
          var kindSel = document.createElement('select'); kindSel.className = 'f-input ao-kind';
          kindSel.innerHTML = '<option value="vertical">vertical</option><option value="horizontal">horizontal</option>';
          kindSel.value = entry.kind === 'horizontal' ? 'horizontal' : 'vertical';
          var keyIn = document.createElement('input'); keyIn.className = 'f-input ao-key'; keyIn.type = 'text'; keyIn.value = entry.key || '';
          var areaIn = document.createElement('input'); areaIn.className = 'f-input ao-area'; areaIn.type = 'text'; areaIn.value = entry.areaPath || '';
          var asgIn = document.createElement('input'); asgIn.className = 'f-input ao-asg'; asgIn.type = 'text'; asgIn.value = entry.assignedTo || '';
          var del = mkBtn('\\u00d7', 'ao-del'); del.title = 'Remove'; del.onclick = function () { if (tr.parentNode) { tr.parentNode.removeChild(tr); } };
          var cells = [kindSel, keyIn, areaIn, asgIn, del];
          for (var c = 0; c < cells.length; c++) { var td = document.createElement('td'); td.appendChild(cells[c]); tr.appendChild(td); }
          tbody.appendChild(tr);
        }
        for (var i = 0; i < rows.length; i++) { addRow(rows[i]); }
        if (!rows.length) { addRow(); }
        var addBtn = mkBtn('+ Add area', 'btn ghost sm'); addBtn.style.marginTop = '10px'; card.appendChild(addBtn);
        addBtn.onclick = function () { addRow(); };
        var msg = document.createElement('div'); msg.className = 'modal-msg'; card.appendChild(msg);
        var actions = document.createElement('div'); actions.className = 'modal-actions';
        var save = mkBtn('Save', 'btn sm'); var cancel = mkBtn('Cancel', 'btn ghost sm');
        actions.appendChild(cancel); actions.appendChild(save); card.appendChild(actions);
        cancel.onclick = function () { closeModal(); };
        save.onclick = function () {
          var entries = []; var trs = tbody.querySelectorAll('tr');
          for (var j = 0; j < trs.length; j++) {
            var tr = trs[j];
            var key = tr.querySelector('.ao-key').value.trim();
            var area = tr.querySelector('.ao-area').value.trim();
            if (!key || !area) { continue; }
            var asg = tr.querySelector('.ao-asg').value.trim();
            entries.push({ kind: tr.querySelector('.ao-kind').value, key: key, areaPath: area, assignedTo: asg || undefined });
          }
          save.disabled = true; cancel.disabled = true; save.textContent = 'Saving\\u2026'; msg.className = 'modal-msg'; msg.textContent = '';
          apost('/api/audit/area-owners', { entries: entries }).then(function (resp) {
            if (resp && resp.ok) { msg.className = 'modal-msg ok'; msg.textContent = 'Saved ' + ((resp.entries && resp.entries.length) || 0) + ' area owner(s).'; save.textContent = 'Saved'; setTimeout(closeModal, 900); }
            else { save.disabled = false; cancel.disabled = false; save.textContent = 'Save'; msg.className = 'modal-msg err'; msg.textContent = (resp && resp.error) || 'Save failed'; }
          }).catch(function () { save.disabled = false; cancel.disabled = false; save.textContent = 'Save'; msg.className = 'modal-msg err'; msg.textContent = 'Save failed'; });
        };
      });
    }).catch(function () { alert('Could not load area owners.'); });
  }
  function renderFinding(f) {
    var sc = sevClass(f.severity);
    var conf = (f.confidence != null) ? '<span class="cat" title="confidence after double check">conf ' + Math.round(f.confidence * 100) + '%</span>' : '';
    var actions = '';
    if (f.adoBugUrl) { actions = '<a class="bug-link" href="' + esc(f.adoBugUrl) + '" target="_blank" rel="noopener" title="open and edit this bug in ADO">Open bug #' + esc(f.adoBugId) + ' &#8599;</a>'; }
    else if (f.status !== 'dismissed') { actions = '<button class="btn sm" data-create="' + esc(f.id) + '">Create bug</button>'; }
    var dismiss = (f.status === 'open' && !f.adoBugUrl) ? '<button class="btn ghost sm" data-dismiss="' + esc(f.id) + '">Dismiss</button>' : '';
    var recover = (f.status === 'dismissed' || f.status === 'resolved') ? '<button class="btn ghost sm" data-recover="' + esc(f.id) + '">Recover</button>' : '';
    var tag = (f.status === 'dismissed') ? '<span class="cat">dismissed</span>' : (f.status === 'resolved' ? '<span class="cat" title="not detected in the latest sweep">resolved</span>' : '');
    var bugStatus = '';
    if (f.bugState) {
      var bsCls = 'cat', bsText = 'bug ' + esc(f.bugState);
      if (f.fixVerification === 'confirmed') { bsCls = 'cat ok'; bsText = 'fix confirmed'; }
      else if (f.fixVerification === 'still-present') { bsCls = 'cat warn'; bsText = 'still detected'; }
      else if (f.bugTriage === 'wontfix') { bsText = "won't fix"; }
      else if (f.bugTriage === 'needsinfo') { bsText = 'needs info'; }
      var bsTitle = 'ADO bug state: ' + esc(f.bugState) + (f.bugStateReason ? ' (' + esc(f.bugStateReason) + ')' : '') + (f.bugStateCheckedAt ? ' - checked ' + esc(fmtRel(f.bugStateCheckedAt)) : '');
      bugStatus = '<span class="' + bsCls + '" title="' + bsTitle + '">' + bsText + '</span>';
    }
    var pathLink = f.sourceUrl
      ? '<a class="path" href="' + esc(f.sourceUrl) + '" target="_blank" rel="noopener">' + locLabel(f.filePath, f.line, f.endLine) + '</a>'
      : '<span class="path">' + locLabel(f.filePath, f.line, f.endLine) + '</span>';
    var related = '';
    if (f.relatedLocations && f.relatedLocations.length) {
      var links = [];
      for (var i = 0; i < f.relatedLocations.length; i++) {
        var loc = f.relatedLocations[i];
        links.push(loc.sourceUrl
          ? '<a href="' + esc(loc.sourceUrl) + '" target="_blank" rel="noopener">' + locLabel(loc.filePath, loc.line, loc.endLine) + '</a>'
          : locLabel(loc.filePath, loc.line, loc.endLine));
      }
      related = '<div class="finding-meta">also affects:<br>' + links.join('<br>') + '</div>';
    }
    var meta = [];
    if (f.package) { meta.push(esc(f.package)); }
    if (f.introducedAt) { meta.push('in codebase ' + esc(fmtRel(f.introducedAt))); }
    if (f.firstSeenAt) { meta.push('first flagged ' + esc(fmtRel(f.firstSeenAt))); }
    if (f.adoAreaPath) { meta.push('filed under ' + esc(f.adoAreaPath) + (f.adoAssignedTo ? ' (' + esc(f.adoAssignedTo) + ')' : '')); }
    var metaLine = meta.length ? '<div class="finding-meta">' + meta.join(' &#183; ') + '</div>' : '';
    var dismissInfo = '';
    if (f.status === 'dismissed' && (f.dismissedBy || f.dismissReason)) {
      dismissInfo = '<div class="finding-meta">dismissed' + (f.dismissedBy ? ' by ' + esc(f.dismissedBy) : '') + (f.dismissReason ? ': ' + esc(f.dismissReason) : '') + '</div>';
    }
    var copy = '<button class="copy-btn" data-copy="' + esc(f.id) + '" title="Copy as markdown to share">\u29c9</button>';
    var detail = '';
    if (f.detail) {
      var dOpen = !!auditDetailOpen[f.id];
      detail = '<button class="detail-toggle" data-detail="' + esc(f.id) + '">' + (dOpen ? 'Less detail \u25b4' : 'More detail \u25be') + '</button>'
        + '<div class="detail-body" id="dt-' + esc(f.id) + '" style="display:' + (dOpen ? '' : 'none') + '">' + esc(f.detail) + '</div>';
    }
    return '<div class="comment ' + sc + '"><div class="loc">'
      + '<div class="loc-meta"><span class="chip ' + sc + '">' + esc(f.severity) + '</span>'
      + '<span class="cat">' + esc(f.category) + '</span>' + conf + tag + bugStatus
      + pathLink + '</div>'
      + '<div class="loc-actions">' + actions + dismiss + recover + copy + '</div></div>'
      + '<div class="c-title">' + esc(f.title) + '</div><div class="c-body">' + esc(f.body) + '</div>' + detail + related + metaLine + dismissInfo + '</div>';
  }
  function showRoutePicker(btn, id, routes) {
    btn.disabled = false; btn.textContent = 'Create bug';
    if (!routes.length) { alert('No ADO route could be resolved for this finding (no ownership.json on the path).'); return; }
    openModal(function (card) {
      var h = document.createElement('h3'); h.textContent = 'File a bug'; card.appendChild(h);
      var sub = document.createElement('p'); sub.className = 'modal-sub';
      sub.textContent = 'Choose the owning team / route. The bug is filed in ADO with the finding\\u2019s full details and assigned to the route\\u2019s default owner.';
      card.appendChild(sub);
      var sel = document.createElement('select'); sel.className = 'f-input'; sel.style.width = '100%';
      for (var i = 0; i < routes.length; i++) {
        var r = routes[i]; var opt = document.createElement('option'); opt.value = String(i);
        opt.textContent = r.label + ' \\u2014 ' + r.areaPath + (r.assignedTo ? ' (' + r.assignedTo + ')' : '');
        sel.appendChild(opt);
      }
      card.appendChild(sel);
      var msg = document.createElement('div'); msg.className = 'modal-msg'; card.appendChild(msg);
      var actions = document.createElement('div'); actions.className = 'modal-actions';
      var file = mkBtn('File bug', 'btn sm'); var cancel = mkBtn('Cancel', 'btn ghost sm');
      actions.appendChild(cancel); actions.appendChild(file); card.appendChild(actions);
      cancel.onclick = function () { closeModal(); };
      file.onclick = function () {
        file.disabled = true; cancel.disabled = true; file.textContent = 'Filing\\u2026'; msg.className = 'modal-msg'; msg.textContent = '';
        apost('/api/audit/create-bug', { id: id, routeIndex: parseInt(sel.value, 10) }).then(function (resp) {
          if (resp && resp.ok) { applyCreatedBug(resp.finding); showBugCreated(card, resp.finding); }
          else { file.disabled = false; cancel.disabled = false; file.textContent = 'File bug'; msg.className = 'modal-msg err'; msg.textContent = (resp && resp.error) || 'Bug creation failed'; }
        }).catch(function () { file.disabled = false; cancel.disabled = false; file.textContent = 'File bug'; msg.className = 'modal-msg err'; msg.textContent = 'Bug creation failed'; });
      };
    });
  }
  function showDismissModal(id) {
    openModal(function (card) {
      var h = document.createElement('h3'); h.textContent = 'Dismiss finding'; card.appendChild(h);
      var sub = document.createElement('p'); sub.className = 'modal-sub';
      sub.textContent = 'Say why this is being dismissed and who you are (so you can be contacted until sign-in is added). It moves to the Dismissed filter and is hidden from future sweeps; you can recover it later.';
      card.appendChild(sub);
      var reason = document.createElement('textarea'); reason.className = 'f-input'; reason.rows = 3; reason.style.width = '100%';
      reason.placeholder = 'Dismiss reason (e.g. false positive \\u2014 input is validated upstream)';
      card.appendChild(reason);
      var alias = document.createElement('input'); alias.className = 'f-input'; alias.type = 'text'; alias.style.width = '100%'; alias.style.marginTop = '8px';
      alias.placeholder = 'Your alias (so you can be contacted)';
      try { alias.value = localStorage.getItem('saturn_alias') || ''; } catch (e) {}
      card.appendChild(alias);
      var msg = document.createElement('div'); msg.className = 'modal-msg'; card.appendChild(msg);
      var actions = document.createElement('div'); actions.className = 'modal-actions';
      var ok = mkBtn('Dismiss', 'btn sm'); var cancel = mkBtn('Cancel', 'btn ghost sm');
      actions.appendChild(cancel); actions.appendChild(ok); card.appendChild(actions);
      cancel.onclick = function () { closeModal(); };
      ok.onclick = function () {
        var r = (reason.value || '').trim(); var a = (alias.value || '').trim();
        if (!r || !a) { msg.className = 'modal-msg err'; msg.textContent = 'Please enter a reason and your alias.'; return; }
        try { localStorage.setItem('saturn_alias', a); } catch (e) {}
        ok.disabled = true; cancel.disabled = true; ok.textContent = 'Dismissing\\u2026'; msg.className = 'modal-msg'; msg.textContent = '';
        apost('/api/audit/dismiss', { id: id, reason: r, alias: a }).then(function (resp) {
          if (resp && resp.ok) { closeModal(); refreshAudit(); }
          else { ok.disabled = false; cancel.disabled = false; ok.textContent = 'Dismiss'; msg.className = 'modal-msg err'; msg.textContent = (resp && resp.error) || 'Dismiss failed'; }
        }).catch(function () { ok.disabled = false; cancel.disabled = false; ok.textContent = 'Dismiss'; msg.className = 'modal-msg err'; msg.textContent = 'Dismiss failed'; });
      };
    });
  }
  function updateAuditMeta() {
    document.getElementById('aCount').textContent = auditTotal ? (auditFindings.length + ' of ' + auditTotal) : '';
    var empty = document.getElementById('auditEmpty');
    if (empty) { empty.style.display = (auditTotal === 0) ? '' : 'none'; }
    var sentinel = document.getElementById('auditSentinel');
    if (sentinel) { sentinel.style.display = auditCursor ? '' : 'none'; }
  }
  // Wire the action buttons inside the audit list. Idempotent - safe to re-run after appending more findings.
  function wireAuditButtons() {
    var el = document.getElementById('auditList');
    var creates = el.querySelectorAll('[data-create]');
    for (var i = 0; i < creates.length; i++) {
      (function (btn) {
        btn.onclick = function () {
          var id = btn.getAttribute('data-create');
          btn.disabled = true; btn.textContent = 'Routes\\u2026';
          fetch('/api/audit/routes?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
            showRoutePicker(btn, id, (d && d.routes) || []);
          }).catch(function () { btn.disabled = false; btn.textContent = 'Create bug'; });
        };
      })(creates[i]);
    }
    var dis = el.querySelectorAll('[data-dismiss]');
    for (var j = 0; j < dis.length; j++) {
      (function (btn) { btn.onclick = function () { showDismissModal(btn.getAttribute('data-dismiss')); }; })(dis[j]);
    }
    var recs = el.querySelectorAll('[data-recover]');
    for (var k = 0; k < recs.length; k++) {
      (function (btn) { btn.onclick = function () { apost('/api/audit/recover', { id: btn.getAttribute('data-recover') }).then(function () { refreshAudit(); }).catch(function () {}); }; })(recs[k]);
    }
    var copies = el.querySelectorAll('[data-copy]');
    for (var ci = 0; ci < copies.length; ci++) {
      (function (btn) { btn.onclick = function () { copyFinding(btn.getAttribute('data-copy'), btn); }; })(copies[ci]);
    }
    var dts = el.querySelectorAll('[data-detail]');
    for (var di = 0; di < dts.length; di++) {
      (function (btn) {
        btn.onclick = function () {
          var fid = btn.getAttribute('data-detail');
          var box = document.getElementById('dt-' + fid);
          if (!box) { return; }
          var willOpen = box.style.display === 'none';
          box.style.display = willOpen ? '' : 'none';
          auditDetailOpen[fid] = willOpen;
          btn.innerHTML = willOpen ? 'Less detail \\u25b4' : 'More detail \\u25be';
          measureAuditWindow();
        };
      })(dts[di]);
    }
  }
  // (Audit + PR-review list windowing is provided by the shared makeListWindow engine defined above.)
  function populatePackageList(packages) {
    var dl = document.getElementById('aPkgList');
    if (!dl) { return; }
    var list = packages || []; var opts = '';
    for (var i = 0; i < list.length; i++) { opts += '<option value="' + esc(list[i]) + '"></option>'; }
    dl.innerHTML = opts;
  }
  function auditQS() {
    var p = [];
    if (auditFilter.state) { p.push('status=' + encodeURIComponent(auditFilter.state)); }
    if (auditFilter.pkg) { p.push('pkg=' + encodeURIComponent(auditFilter.pkg)); }
    if (auditFilter.path) { p.push('path=' + encodeURIComponent(auditFilter.path)); }
    if (auditFilter.type) { p.push('type=' + encodeURIComponent(auditFilter.type)); }
    if (auditFilter.sev) { p.push('sev=' + encodeURIComponent(auditFilter.sev)); }
    return p.join('&');
  }
  function loadAuditSummary() {
    fetch('/api/audit/summary?' + auditQS()).then(function (r) { return r.json(); }).then(function (s) {
      if (!s) { return; }
      auditSummarySig = JSON.stringify(s);
      populatePackageList(s.packages);
      renderAuditCharts(s);
    }).catch(function () {});
  }
  // Load one server-side page; reset=true replaces the list (filter change), else appends (infinite scroll).
  function loadAuditPage(reset) {
    if (auditLoadingPage) { return; }
    if (!reset && !auditCursor) { return; }
    auditLoadingPage = true;
    var cursor = reset ? '0' : auditCursor;
    fetch('/api/audit/findings?' + auditQS() + '&limit=' + AUDIT_PAGE + '&cursor=' + encodeURIComponent(cursor))
      .then(function (r) { return r.json(); }).then(function (d) {
        auditLoadingPage = false;
        if (!d) { return; }
        auditTotal = d.total || 0;
        auditCursor = d.nextCursor || null;
        var page = d.findings || [];
        if (reset) { auditFindings = page; renderAuditList(); }
        else { auditFindings = auditFindings.concat(page); renderAuditWindow(true); updateAuditMeta(); }
      }).catch(function () { auditLoadingPage = false; });
  }
  var SEV_ORDER = ['blocking', 'major', 'minor', 'nit'];
  var SEV_LABEL = { blocking: 'Blocking', major: 'Major', minor: 'Minor', nit: 'Nit' };
  var SEV_CLS = { blocking: 'sev-block', major: 'sev-major', minor: 'sev-minor', nit: 'sev-nit' };
  function countBy(arr, keyFn) { var m = {}; for (var i = 0; i < arr.length; i++) { var k = keyFn(arr[i]); m[k] = (m[k] || 0) + 1; } return m; }
  function barRow(label, cls, count, max, dataAttr, val, active) {
    var pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return '<div class="bar-row' + (active ? ' active' : '') + '" ' + dataAttr + '="' + esc(val) + '">'
      + '<span class="bl" title="' + esc(label) + '">' + esc(label) + '</span>'
      + '<span class="bt"><span class="bf ' + cls + '" style="width:' + pct + '%"></span></span>'
      + '<span class="bv">' + count + '</span></div>';
  }
  function renderAuditCharts(summary) {
    var host = document.getElementById('aCharts');
    if (!host || !summary) { return; }
    var sevMap = summary.sev || {};
    var cards = '<div class="kpi' + (auditFilter.sev ? '' : ' active') + '" data-sev=""><div class="k">Total</div><div class="v">' + (summary.total || 0) + '</div></div>';
    for (var i = 0; i < SEV_ORDER.length; i++) {
      var s = SEV_ORDER[i];
      cards += '<div class="kpi ' + SEV_CLS[s] + (auditFilter.sev === s ? ' active' : '') + '" data-sev="' + s + '"><div class="k">' + SEV_LABEL[s] + '</div><div class="v">' + (sevMap[s] || 0) + '</div></div>';
    }
    var cat = summary.byCategory || [];
    var catMax = 0; for (var c = 0; c < cat.length; c++) { if (cat[c].count > catMax) { catMax = cat[c].count; } }
    var leftBars = '';
    for (var c2 = 0; c2 < cat.length; c2++) { leftBars += barRow(cat[c2].category, 'cat', cat[c2].count, catMax, 'data-cat', cat[c2].category, auditFilter.type === cat[c2].category); }
    if (!cat.length) { leftBars = '<div class="muted" style="font-size:12px">No findings in scope.</div>'; }
    var bs = summary.bySeverity || [];
    var sevMax = 0; for (var si = 0; si < bs.length; si++) { if (bs[si].count > sevMax) { sevMax = bs[si].count; } }
    var rightBars = '';
    for (var si2 = 0; si2 < bs.length; si2++) { rightBars += barRow(SEV_LABEL[bs[si2].severity] || bs[si2].severity, SEV_CLS[bs[si2].severity], bs[si2].count, sevMax, 'data-sev2', bs[si2].severity, auditFilter.sev === bs[si2].severity); }
    var rightTitle = auditFilter.type ? (esc(auditFilter.type) + ' \u00b7 by severity') : 'By severity';
    host.innerHTML = '<div class="kpi-row">' + cards + '</div>'
      + '<div class="charts-2">'
      + '<div class="chart-card"><h4>By category' + (auditFilter.sev ? ' (' + esc(SEV_LABEL[auditFilter.sev]) + ')' : '') + '</h4>' + leftBars + '</div>'
      + '<div class="chart-card"><h4>' + rightTitle + '</h4>' + rightBars + '</div>'
      + '</div>';
    var kpis = host.querySelectorAll('.kpi');
    for (var ki = 0; ki < kpis.length; ki++) { (function (el) { el.onclick = function () { setAuditFilter('sev', el.getAttribute('data-sev')); }; })(kpis[ki]); }
    var catRows = host.querySelectorAll('[data-cat]');
    for (var cr = 0; cr < catRows.length; cr++) { (function (el) { el.onclick = function () { setAuditFilter('type', el.getAttribute('data-cat')); }; })(catRows[cr]); }
    var sevRows = host.querySelectorAll('[data-sev2]');
    for (var sr = 0; sr < sevRows.length; sr++) { (function (el) { el.onclick = function () { setAuditFilter('sev', el.getAttribute('data-sev2')); }; })(sevRows[sr]); }
  }
  function setAuditFilter(key, value) {
    auditFilter[key] = (value && auditFilter[key] === value) ? '' : (value || '');
    var dd = document.getElementById(key === 'sev' ? 'aSev' : 'aType');
    if (dd) { dd.value = auditFilter[key]; }
    applyAuditFilters();
  }
  function applyAuditFilters() { loadAuditSummary(); loadAuditPage(true); }
  function auditLoadMore() { if (auditCursor && !auditLoadingPage) { loadAuditPage(false); } }
  function buildFindingMarkdown(f) {
    var loc = f.filePath + ':' + f.line + (f.endLine && f.endLine > f.line ? '-' + f.endLine : '');
    var lines = [];
    lines.push('### ' + (f.title || 'Finding'));
    lines.push('');
    lines.push('- **Severity:** ' + f.severity + ' | **Category:** ' + f.category + (f.confidence != null ? ' | **Confidence:** ' + Math.round(f.confidence * 100) + '%' : ''));
    lines.push('- **Location:** ' + (f.sourceUrl ? '[' + loc + '](' + f.sourceUrl + ')' : '\`' + loc + '\`'));
    if (f.relatedLocations && f.relatedLocations.length) {
      var rl = [];
      for (var i = 0; i < f.relatedLocations.length; i++) { var l = f.relatedLocations[i]; var ll = l.filePath + ':' + l.line + (l.endLine && l.endLine > l.line ? '-' + l.endLine : ''); rl.push(l.sourceUrl ? '[' + ll + '](' + l.sourceUrl + ')' : '\`' + ll + '\`'); }
      lines.push('- **Also affects:** ' + rl.join(', '));
    }
    if (f.adoBugUrl) { lines.push('- **ADO bug:** [#' + f.adoBugId + '](' + f.adoBugUrl + ')'); }
    lines.push('');
    lines.push(f.body || '');
    if (f.detail) { lines.push(''); lines.push('**In depth:** ' + f.detail); }
    return lines.join('\\n');
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  function copyFinding(id, btn) {
    var f = null;
    for (var i = 0; i < auditFindings.length; i++) { if (auditFindings[i].id === id) { f = auditFindings[i]; break; } }
    if (!f) { return; }
    var md = buildFindingMarkdown(f);
    var done = function () { btn.innerHTML = '\u2713'; setTimeout(function () { btn.innerHTML = '\u29c9'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(md).then(done).catch(function () { fallbackCopy(md); done(); }); }
    else { fallbackCopy(md); done(); }
  }
  function refreshAudit() {
    fetch('/api/audit/state').then(function (r) { return r.json(); }).then(applyAuditState).catch(function () {});
    fetch('/api/audit/summary?' + auditQS()).then(function (r) { return r.json(); }).then(function (s) {
      if (!s) { return; }
      var sig = JSON.stringify(s);
      if (sig === auditSummarySig) { return; }
      auditSummarySig = sig;
      populatePackageList(s.packages);
      renderAuditCharts(s);
      // Refresh the list only when viewing the first page near the top, to avoid disrupting an active scroll.
      if (auditFindings.length <= AUDIT_PAGE && window.scrollY < 240) { loadAuditPage(true); }
    }).catch(function () {});
  }
  // ---- Dashboard tab (leadership overview): interactive Chart.js charts, with inline-SVG fallback ----
  var dashPollTimer = null;
  var dashScaffolded = false;
  var dashCharts = {};
  var chartDefaultsSet = false;
  function cssVar(name, fb) { try { var v = getComputedStyle(document.documentElement).getPropertyValue(name); return (v && v.trim()) || fb; } catch (e) { return fb; } }
  function ensureChartDefaults() {
    if (chartDefaultsSet || !window.Chart) { return; }
    Chart.defaults.color = cssVar('--muted', '#9aa3c4');
    Chart.defaults.font.family = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    Chart.defaults.font.size = 11;
    chartDefaultsSet = true;
  }
  // Create each chart once, then update its data in place on later polls (smooth, no flicker). Falls back to
  // inline SVG when Chart.js is unavailable (e.g. the CDN is blocked / offline).
  function upsertChart(cid, cfg, fallbackHtml) {
    var host = document.getElementById(cid);
    if (!host) { return; }
    if (!window.Chart) { host.innerHTML = fallbackHtml || ''; return; }
    var inst = dashCharts[cid];
    if (inst) { inst.data = cfg.data; inst.update('none'); return; }
    host.innerHTML = '<canvas></canvas>';
    dashCharts[cid] = new Chart(host.firstChild.getContext('2d'), cfg);
  }
  function doughnutCfg(labels, values, colors) {
    return { type: 'doughnut',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderColor: cssVar('--panel-2', '#141a2e'), borderWidth: 2, hoverOffset: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: { legend: { position: 'right', labels: { color: cssVar('--muted', '#9aa3c4'), boxWidth: 12, padding: 8, font: { size: 11 } } } } } };
  }
  function hbarCfg(labels, values, colors) {
    return { type: 'bar',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, maxBarThickness: 16 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, grid: { color: cssVar('--border-soft', 'rgba(255,255,255,.06)') }, ticks: { color: cssVar('--muted-2', '#6c759c'), precision: 0 } },
          y: { grid: { display: false }, ticks: { color: cssVar('--muted', '#9aa3c4'), font: { size: 11 }, autoSkip: false,
            callback: function (val) { var l = this.getLabelForValue(val); return l && l.length > 22 ? l.slice(0, 21) + '\u2026' : l; } } } } } };
  }
  function lineCfg(labels, values) {
    return { type: 'line',
      data: { labels: labels, datasets: [{ data: values, borderColor: cssVar('--accent', '#5b7cfa'), backgroundColor: 'rgba(91,124,250,.18)', fill: true, tension: 0.35, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: { x: { grid: { display: false }, ticks: { color: cssVar('--muted-2', '#6c759c'), maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } } },
          y: { beginAtZero: true, grid: { color: cssVar('--border-soft', 'rgba(255,255,255,.06)') }, ticks: { color: cssVar('--muted-2', '#6c759c'), precision: 0 } } } } };
  }
  function ensureDashScaffold() {
    if (dashScaffolded) { return; }
    var aud = document.getElementById('dashAudit'); var rev = document.getElementById('dashReview');
    if (!aud || !rev) { return; }
    aud.innerHTML = '<div class="chart-card" id="dashSweep"></div>'
      + '<div id="dashAuditKpis"></div>'
      + '<div class="charts-2"><div class="chart-card"><h4 id="hSev">Open findings by severity</h4><div class="cc" id="cSev"></div></div>'
      + '<div class="chart-card"><h4>Findings by category</h4><div class="cc" id="cCat"></div></div></div>'
      + '<div class="charts-2"><div class="chart-card"><h4 id="hStatus">Lifecycle status</h4><div class="cc" id="cStatus"></div></div>'
      + '<div class="chart-card"><h4>Top packages (open)</h4><div class="cc" id="cPkg"></div></div></div>';
    rev.innerHTML = '<div id="dashReviewKpis"></div>'
      + '<div class="chart-card"><h4 id="hDaily">Reviews per day (14d)</h4><div class="cc cc-wide" id="cDaily"></div></div>'
      + '<div class="charts-2"><div class="chart-card"><h4 id="hOutcome">Review outcomes</h4><div class="cc" id="cOutcome"></div></div>'
      + '<div class="chart-card"><h4>Findings by severity</h4><div class="cc" id="cRevSev"></div></div></div>'
      + '<div class="charts-2"><div class="chart-card"><h4>Findings by aspect</h4><div class="cc" id="cAspect"></div></div>'
      + '<div class="chart-card"><h4>Throughput</h4><div id="dashThroughput"></div></div></div>'
      + '<div class="charts-2"><div class="chart-card"><h4>Recurring findings</h4><div class="cc" id="cRecurring"></div></div>'
      + '<div class="chart-card"><h4>File hotspots</h4><div class="cc" id="cHotspot"></div></div></div>';
    dashScaffolded = true;
  }
  var SEV_COLOR = { blocking: '#ff5d73', major: '#ffb454', minor: '#5b7cfa', nit: '#6c759c' };
  var DASH_PALETTE = ['#5b7cfa', '#46d19e', '#ffb454', '#ff5d73', '#a78bfa', '#22d3ee', '#f472b6', '#84cc16', '#fb923c', '#38bdf8'];
  function dashColor(i) { return DASH_PALETTE[i % DASH_PALETTE.length]; }
  function donutSvg(segments, centerLabel, centerValue) {
    var total = 0; for (var i = 0; i < segments.length; i++) { total += num(segments[i].value); }
    var size = 142, stroke = 20, r = (size - stroke) / 2, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
    var arcs = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--panel-3)" stroke-width="' + stroke + '"></circle>';
    var off = 0;
    for (var j = 0; j < segments.length; j++) {
      var v = num(segments[j].value); if (v <= 0 || total <= 0) { continue; }
      var len = circ * (v / total);
      arcs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + segments[j].color + '" stroke-width="' + stroke
        + '" stroke-dasharray="' + len.toFixed(2) + ' ' + (circ - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2)
        + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"><title>' + esc(segments[j].label) + ': ' + v + '</title></circle>';
      off += len;
    }
    var center = '<text x="' + cx + '" y="' + (cy - 1) + '" text-anchor="middle" class="donut-num">' + (centerValue != null ? centerValue : total) + '</text>'
      + '<text x="' + cx + '" y="' + (cy + 15) + '" text-anchor="middle" class="donut-lbl">' + esc(centerLabel || 'total') + '</text>';
    var svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" class="donut">' + arcs + center + '</svg>';
    var legend = '<div class="legend">';
    for (var k = 0; k < segments.length; k++) {
      legend += '<div class="lg-row"><span class="lg-dot" style="background:' + segments[k].color + '"></span><span class="lg-lbl" title="' + esc(segments[k].label) + '">' + esc(segments[k].label) + '</span><span class="lg-val">' + num(segments[k].value) + '</span></div>';
    }
    legend += '</div>';
    return '<div class="donut-wrap">' + svg + legend + '</div>';
  }
  function progressBar(percent, sub) {
    var p = Math.max(0, Math.min(100, Math.round(percent)));
    return '<div class="prog"><div class="prog-top"><span class="prog-pct">' + p + '%</span><span class="prog-sub">' + (sub || '') + '</span></div>'
      + '<div class="prog-track"><span class="prog-fill" style="width:' + p + '%"></span><span class="prog-thumb" style="left:' + p + '%"></span></div></div>';
  }
  function lineAreaSvg(points) {
    if (!points || !points.length) { return '<div class="muted" style="font-size:12px">No data yet.</div>'; }
    var w = 540, h = 150, padL = 26, padR = 10, padT = 12, padB = 20, n = points.length;
    var max = 1; for (var i = 0; i < n; i++) { if (num(points[i].value) > max) { max = num(points[i].value); } }
    var iw = w - padL - padR, ih = h - padT - padB;
    var xAt = function (idx) { return padL + (n <= 1 ? iw / 2 : iw * idx / (n - 1)); };
    var yAt = function (val) { return padT + ih - ih * num(val) / max; };
    var d = '', dots = '';
    for (var j = 0; j < n; j++) {
      var x = xAt(j), y = yAt(points[j].value);
      d += (j === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.4" class="ln-dot"><title>' + esc(points[j].label) + ': ' + num(points[j].value) + '</title></circle>';
    }
    var area = d + 'L' + xAt(n - 1).toFixed(1) + ' ' + (padT + ih) + ' L' + xAt(0).toFixed(1) + ' ' + (padT + ih) + ' Z';
    var grid = '';
    for (var g = 0; g <= 2; g++) { var gv = max * g / 2, gy = yAt(gv); grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + gy.toFixed(1) + '" class="ln-grid"></line><text x="' + (padL - 4) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" class="ln-axis">' + Math.round(gv) + '</text>'; }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="lnchart" preserveAspectRatio="xMidYMid meet">' + grid
      + '<path d="' + area + '" class="ln-area" fill="rgba(91,124,250,.15)"></path><path d="' + d + '" class="ln-line"></path>' + dots + '</svg>';
  }
  function kpiCards(items) {
    var h = '<div class="kpi-row">';
    for (var i = 0; i < items.length; i++) { h += '<div class="kpi ro ' + (items[i].cls || '') + '"><div class="k">' + esc(items[i].k) + '</div><div class="v">' + esc(items[i].v) + '</div></div>'; }
    return h + '</div>';
  }
  function dashBars(rows, clsFn) {
    if (!rows || !rows.length) { return '<div class="muted" style="font-size:12px">No data.</div>'; }
    var max = 0; for (var i = 0; i < rows.length; i++) { if (num(rows[i].value) > max) { max = num(rows[i].value); } }
    var h = '';
    for (var j = 0; j < rows.length; j++) {
      var p = max > 0 ? Math.round(num(rows[j].value) / max * 100) : 0;
      var cls = clsFn ? clsFn(rows[j], j) : '';
      var style = 'width:' + p + '%' + (cls ? '' : ';background:' + dashColor(j));
      h += '<div class="bar-row ro"><span class="bl" title="' + esc(rows[j].label) + '">' + esc(rows[j].label) + '</span>'
        + '<span class="bt"><span class="bf ' + cls + '" style="' + style + '"></span></span><span class="bv">' + num(rows[j].value) + '</span></div>';
    }
    return h;
  }
  function chartCard(title, body, live) {
    return '<div class="chart-card"><h4>' + esc(title) + (live ? ' <span class="live-dot"></span>' : '') + '</h4>' + body + '</div>';
  }
  function throughputBlock(r) {
    return '<div class="tp">'
      + '<div class="tp-row"><span>Last 24h</span><b>' + num(r.reviewedToday) + '</b></div>'
      + '<div class="tp-row"><span>Last 7 days</span><b>' + num(r.reviewedWeek) + '</b></div>'
      + '<div class="tp-row"><span>Avg duration</span><b>' + (r.avgDurationMs ? esc(fmtDur(r.avgDurationMs)) : '-') + '</b></div>'
      + '<div class="tp-row"><span>With findings</span><b>' + num(r.reviewed) + '</b></div>'
      + '<div class="tp-row"><span>Clean rate</span><b>' + (num(r.total) > 0 ? Math.round(num(r.noFindings) / num(r.total) * 100) : 0) + '%</b></div>'
      + '</div>';
  }
  function renderDashAudit(a) {
    var st = a.state || {}, sum = a.summary || {}, sc = a.statusCounts || {}, pkgs = a.topPackages || [];
    var pct = num(st.totalFiles) > 0 ? num(st.filesScanned) / num(st.totalFiles) * 100 : (st.running ? 2 : 0);
    var sweepSub = num(st.totalFiles) > 0
      ? (num(st.filesScanned) + ' / ' + num(st.totalFiles) + ' files &middot; sweep ' + num(st.sweepNumber) + (num(st.completedSweeps) ? (' &middot; ' + num(st.completedSweeps) + ' completed') : ''))
      : (st.running ? 'starting&hellip;' : 'idle');
    var sweepEl = document.getElementById('dashSweep');
    if (sweepEl) { sweepEl.innerHTML = '<h4>Sweep progress' + (st.running ? ' <span class="live-dot"></span>' : '') + '</h4>' + progressBar(pct, sweepSub); }
    var kpiEl = document.getElementById('dashAuditKpis');
    if (kpiEl) { kpiEl.innerHTML = kpiCards([
      { k: 'Total findings', v: num(sc.total) }, { k: 'Open', v: num(sc.open) }, { k: 'Bugs filed', v: num(sc.withBug) },
      { k: 'Resolved', v: num(sc.resolved) }, { k: 'Dismissed', v: num(sc.dismissed) }
    ]); }
    var sev = sum.sev || {};
    var hSev = document.getElementById('hSev'); if (hSev) { hSev.textContent = 'Open findings by severity \u00b7 ' + num(sc.open); }
    upsertChart('cSev',
      doughnutCfg(SEV_ORDER.map(function (s) { return SEV_LABEL[s]; }), SEV_ORDER.map(function (s) { return num(sev[s]); }), SEV_ORDER.map(function (s) { return SEV_COLOR[s]; })),
      donutSvg(SEV_ORDER.map(function (s) { return { label: SEV_LABEL[s], value: num(sev[s]), color: SEV_COLOR[s] }; }), 'open', num(sc.open)));
    var cat = sum.byCategory || [];
    upsertChart('cCat',
      hbarCfg(cat.map(function (c) { return c.category; }), cat.map(function (c) { return c.count; }), cat.map(function (c, idx) { return dashColor(idx); })),
      dashBars(cat.map(function (c) { return { label: c.category, value: c.count }; })));
    var hStatus = document.getElementById('hStatus'); if (hStatus) { hStatus.textContent = 'Lifecycle status \u00b7 ' + num(sc.total); }
    upsertChart('cStatus',
      doughnutCfg(['Open', 'Resolved', 'Dismissed'], [num(sc.open), num(sc.resolved), num(sc.dismissed)], ['#5b7cfa', '#46d19e', '#6c759c']),
      donutSvg([{ label: 'Open', value: num(sc.open), color: '#5b7cfa' }, { label: 'Resolved', value: num(sc.resolved), color: '#46d19e' }, { label: 'Dismissed', value: num(sc.dismissed), color: '#6c759c' }], 'total', num(sc.total)));
    upsertChart('cPkg',
      hbarCfg(pkgs.map(function (p) { return p.package; }), pkgs.map(function (p) { return p.count; }), pkgs.map(function (p, idx) { return dashColor(idx); })),
      dashBars(pkgs.map(function (p) { return { label: p.package, value: p.count }; })));
  }
  function renderDashReview(r) {
    var sev = r.bySeverity || {}, cat = r.byCategory || {};
    var errRate = num(r.total) > 0 ? Math.round(num(r.error) / num(r.total) * 100) : 0;
    var kpiEl = document.getElementById('dashReviewKpis');
    if (kpiEl) { kpiEl.innerHTML = kpiCards([
      { k: 'Total reviews', v: num(r.total) }, { k: 'Findings', v: num(r.findingsTotal) }, { k: 'Clean', v: num(r.noFindings) },
      { k: 'Errors', v: num(r.error) }, { k: 'Error rate', v: errRate + '%' }
    ]); }
    var pts = (r.daily || []).map(function (d) { return { label: d.day, value: num(d.count) }; });
    var hDaily = document.getElementById('hDaily'); if (hDaily) { hDaily.innerHTML = 'Reviews per day (14d)' + (r.avgDurationMs ? ' &middot; avg ' + esc(fmtDur(r.avgDurationMs)) : ''); }
    upsertChart('cDaily',
      lineCfg(pts.map(function (p) { return String(p.label).slice(5); }), pts.map(function (p) { return p.value; })),
      lineAreaSvg(pts));
    var withFindings = num(r.reviewed);
    var hOutcome = document.getElementById('hOutcome'); if (hOutcome) { hOutcome.textContent = 'Review outcomes \u00b7 ' + num(r.total); }
    upsertChart('cOutcome',
      doughnutCfg(['Clean', 'With findings', 'Errors'], [num(r.noFindings), withFindings, num(r.error)], ['#46d19e', '#5b7cfa', '#ff5d73']),
      donutSvg([{ label: 'Clean', value: num(r.noFindings), color: '#46d19e' }, { label: 'With findings', value: withFindings, color: '#5b7cfa' }, { label: 'Errors', value: num(r.error), color: '#ff5d73' }], 'reviews', num(r.total)));
    upsertChart('cRevSev',
      hbarCfg(SEV_ORDER.map(function (s) { return SEV_LABEL[s]; }), SEV_ORDER.map(function (s) { return num(sev[s]); }), SEV_ORDER.map(function (s) { return SEV_COLOR[s]; })),
      dashBars(SEV_ORDER.map(function (s) { return { label: SEV_LABEL[s], value: num(sev[s]) }; }), function (row) { return SEV_CLS[String(row.label).toLowerCase()] || ''; }));
    var aspectKeys = ['security', 'privacy', 'correctness', 'design', 'api', 'testing'];
    upsertChart('cAspect',
      hbarCfg(aspectKeys, aspectKeys.map(function (k) { return num(cat[k]); }), aspectKeys.map(function (k, idx) { return dashColor(idx); })),
      dashBars(aspectKeys.map(function (k) { return { label: k, value: num(cat[k]) }; })));
    var thEl = document.getElementById('dashThroughput'); if (thEl) { thEl.innerHTML = throughputBlock(r); }
    var titleRows = (r.topTitles || []).slice(0, 6);
    upsertChart('cRecurring',
      hbarCfg(titleRows.map(function (t) { return t.title; }), titleRows.map(function (t) { return t.count; }), titleRows.map(function (t, idx) { return dashColor(idx); })),
      dashBars(titleRows.map(function (t) { return { label: t.title, value: t.count }; })));
    var fileRows = (r.topFiles || []).slice(0, 6);
    upsertChart('cHotspot',
      hbarCfg(fileRows.map(function (f) { return f.path; }), fileRows.map(function (f) { return f.count; }), fileRows.map(function (f, idx) { return dashColor(idx); })),
      dashBars(fileRows.map(function (f) { return { label: f.path, value: f.count }; })));
  }
  function renderDashboard(data) {
    if (!data) { return; }
    ensureChartDefaults();
    ensureDashScaffold();
    renderDashAudit(data.audit || {});
    renderDashReview(data.review || {});
  }
  var dashSig = null;
  function loadDashboard() {
    fetch('/api/dashboard').then(function (r) { return r.json(); }).then(function (data) {
      if (!data) { return; }
      // Skip the re-render entirely when nothing changed, so live polling doesn't re-animate the charts.
      var sig = JSON.stringify(data);
      if (sig === dashSig) { return; }
      dashSig = sig;
      renderDashboard(data);
    }).catch(function () {});
  }
  var docsLoaded = false;
  function loadDocs() {
    if (docsLoaded) { return; }
    docsLoaded = true;
    fetch('/api/docs').then(function (r) { return r.json(); }).then(function (d) {
      var body = document.getElementById('docsBody');
      if (!d.docs || !d.docs.length) { body.innerHTML = '<div class="muted-note">No documentation found.</div>'; return; }
      var html = '';
      for (var i = 0; i < d.docs.length; i++) {
        var doc = d.docs[i];
        html += '<details class="doc-acc"' + (i === 0 ? ' open' : '') + '><summary>' + esc(doc.title) + '</summary><div class="doc-md">' + doc.html + '</div></details>';
      }
      body.innerHTML = html;
    }).catch(function () {
      document.getElementById('docsBody').innerHTML = '<div class="muted-note">Could not load documentation.</div>';
    });
  }
  var fixPollTimer = null;
  function fixStatusClass(s) { if (s === 'merged') { return 'ok'; } if (s === 'failed' || s === 'abandoned') { return 'warn'; } return ''; }
  function renderFixTask(t) {
    var badge = '<span class="cat ' + fixStatusClass(t.status) + '">' + esc(t.status) + '</span>';
    var pr = t.prUrl ? '<a class="bug-link" href="' + esc(t.prUrl) + '" target="_blank" rel="noopener">PR !' + esc(t.prId) + ' \u2197</a>' : '';
    var bug = t.bugUrl ? '<a class="bug-link" href="' + esc(t.bugUrl) + '" target="_blank" rel="noopener">bug #' + esc(t.bugId) + ' \u2197</a>' : ('bug #' + esc(t.bugId));
    var meta = [];
    if (t.package) { meta.push(esc(t.package)); }
    if (t.branch) { meta.push(esc(t.branch)); }
    if (t.lastAction) { meta.push(esc(t.lastAction)); }
    if (t.updatedAt) { meta.push('updated ' + esc(fmtRel(t.updatedAt))); }
    var err = t.lastError ? '<div class="finding-meta" style="color:var(--err)">' + esc(t.lastError) + '</div>' : '';
    return '<div class="comment"><div class="loc"><div class="loc-meta">' + badge + '<span class="cat">phase ' + esc(t.phase) + '</span></div>'
      + '<div class="loc-actions">' + pr + bug + '</div></div>'
      + '<div class="c-title">' + esc(t.title) + '</div>'
      + (meta.length ? '<div class="finding-meta">' + meta.join(' \u00b7 ') + '</div>' : '') + err + '</div>';
  }
  function loadFixTasks() {
    fetch('/api/fix/tasks?limit=100').then(function (r) { return r.json(); }).then(function (d) {
      var c = d.counts || {};
      var openPrs = (c['pr-open'] || 0) + (c['addressing'] || 0);
      document.getElementById('fixStats').innerHTML = ''
        + '<span class="tag">Open PRs: ' + openPrs + '</span>'
        + '<span class="tag">Merged: ' + (c['merged'] || 0) + '</span>'
        + '<span class="tag warn">Needs attention: ' + ((c['failed'] || 0) + (c['abandoned'] || 0)) + '</span>'
        + '<span class="tag">Total: ' + (d.total || 0) + '</span>';
      var tasks = d.tasks || [];
      document.getElementById('fixEmpty').style.display = tasks.length ? 'none' : '';
      document.getElementById('fixList').innerHTML = tasks.map(renderFixTask).join('');
    }).catch(function () {
      document.getElementById('fixList').innerHTML = '<div class="muted-note">Could not load fix tasks.</div>';
    });
  }
  function loadFixScope() {
    fetch('/api/fix/scope').then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById('fixScopeInput').value = (d.paths || []).join(', ');
    }).catch(function () {});
  }
  function loadFixPackages() {
    fetch('/api/fix/packages').then(function (r) { return r.json(); }).then(function (d) {
      var dl = document.getElementById('fixPkgList');
      if (!dl) { return; }
      var list = (d && d.packages) || []; var opts = '';
      for (var i = 0; i < list.length; i++) { opts += '<option value="' + esc(list[i]) + '"></option>'; }
      dl.innerHTML = opts;
    }).catch(function () {});
  }
  function loadReviewAllowlist() {
    fetch('/api/review/allowlist').then(function (r) { return r.json(); }).then(function (d) {
      var el = document.getElementById('reviewScopeInput');
      if (el) { el.value = (d.entries || []).join(', '); }
    }).catch(function () {});
  }
  function loadModel() {
    fetch('/api/model').then(function (r) { return r.json(); }).then(function (m) {
      var el = document.getElementById('modelBadge');
      if (!el || !m) { return; }
      var effort = m.reasoningEffort ? ' \u00b7 ' + esc(m.reasoningEffort) : '';
      el.style.display = '';
      if (m.usingBackup) {
        el.textContent = '\u26a0 backup: ' + esc(m.activeModel) + effort;
        el.style.color = 'var(--err)';
        el.title = 'Primary model ' + esc(m.primaryModel) + ' failed ' + (m.consecutiveFailures || 0) + ' time(s); the in-process review + audit agents fell back to the backup until restart.';
      } else {
        el.textContent = esc(m.activeModel) + effort;
        el.style.color = '';
        el.title = 'Active model for the in-process review + audit agents. Backup on repeated failure: ' + esc(m.backupModel) + '.';
      }
    }).catch(function () {});
  }
  function showTab(which) {
    document.getElementById('tab-dash').style.display = which === 'dash' ? '' : 'none';
    document.getElementById('tab-pr').style.display = which === 'pr' ? '' : 'none';
    document.getElementById('tab-audit').style.display = which === 'audit' ? '' : 'none';
    document.getElementById('tab-fix').style.display = which === 'fix' ? '' : 'none';
    document.getElementById('tab-docs').style.display = which === 'docs' ? '' : 'none';
    document.getElementById('tab-chat').style.display = which === 'chat' ? '' : 'none';
    document.getElementById('tabBtnDash').classList.toggle('active', which === 'dash');
    document.getElementById('tabBtnPr').classList.toggle('active', which === 'pr');
    document.getElementById('tabBtnAudit').classList.toggle('active', which === 'audit');
    document.getElementById('tabBtnFix').classList.toggle('active', which === 'fix');
    document.getElementById('tabBtnDocs').classList.toggle('active', which === 'docs');
    document.getElementById('tabBtnChat').classList.toggle('active', which === 'chat');
    try { history.replaceState(null, '', location.pathname + '?tab=' + (which === 'audit' ? 'codebase-audit' : (which === 'dash' ? 'dashboard' : (which === 'docs' ? 'docs' : (which === 'fix' ? 'fix' : (which === 'chat' ? 'chat' : 'reviews'))))) + location.hash); } catch (e) {}
    if (which === 'dash') {
      loadDashboard();
      if (!dashPollTimer) { dashPollTimer = setInterval(function () { if (document.getElementById('tab-dash').style.display !== 'none') { loadDashboard(); } }, 5000); }
    }
    if (which === 'audit') {
      fetch('/api/audit/state').then(function (r) { return r.json(); }).then(applyAuditState).catch(function () {});
      loadAuditSummary();
      loadAuditPage(true);
      if (!auditPollTimer) { auditPollTimer = setInterval(function () { if (document.getElementById('tab-audit').style.display !== 'none') { refreshAudit(); } }, 4000); }
    }
    if (which === 'pr') {
      renderReviewWindow(true);
      loadReviewAllowlist();
    }
    if (which === 'fix') {
      loadFixScope();
      loadFixPackages();
      loadFixTasks();
      loadFeatureBuilds();
      if (!fixPollTimer) { fixPollTimer = setInterval(function () { if (document.getElementById('tab-fix').style.display !== 'none') { loadFixTasks(); loadFeatureBuilds(); } }, 8000); }
    }
    if (which === 'docs') {
      loadDocs();
    }
    if (which === 'chat') {
      mountChat();
    }
  }
  document.getElementById('tabBtnDash').onclick = function () { showTab('dash'); };
  document.getElementById('tabBtnPr').onclick = function () { showTab('pr'); };
  document.getElementById('tabBtnAudit').onclick = function () { showTab('audit'); };
  document.getElementById('tabBtnFix').onclick = function () { showTab('fix'); };
  document.getElementById('tabBtnChat').onclick = function () { showTab('chat'); };
  document.getElementById('fixScopeSave').onclick = function () {
    var raw = document.getElementById('fixScopeInput').value || '';
    var sep = new RegExp('[,;' + String.fromCharCode(10) + String.fromCharCode(13) + ']');
    var paths = raw.split(sep).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    var status = document.getElementById('fixScopeStatus');
    status.textContent = 'Saving...';
    apost('/api/fix/scope', { paths: paths }).then(function (resp) {
      if (resp && resp.ok) {
        document.getElementById('fixScopeInput').value = (resp.paths || []).join(', ');
        status.textContent = 'Saved (' + (resp.paths || []).length + ' entr' + ((resp.paths || []).length === 1 ? 'y' : 'ies') + ').';
      } else { status.textContent = (resp && resp.error) ? resp.error : 'Save failed.'; }
    }).catch(function () { status.textContent = 'Save failed (owner-only).'; });
  };
  var fixPkgAddBtn = document.getElementById('fixPkgAdd');
  if (fixPkgAddBtn) {
    fixPkgAddBtn.onclick = function () {
      var pick = document.getElementById('fixPkgPick');
      var val = ((pick && pick.value) || '').trim();
      if (!val) { return; }
      var ta = document.getElementById('fixScopeInput');
      var sep = new RegExp('[,;' + String.fromCharCode(10) + String.fromCharCode(13) + ']');
      var cur = (ta.value || '').split(sep).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
      var exists = false;
      for (var i = 0; i < cur.length; i++) { if (cur[i].toLowerCase() === val.toLowerCase()) { exists = true; break; } }
      if (!exists) { cur.push(val); }
      ta.value = cur.join(', ');
      if (pick) { pick.value = ''; }
    };
  }
  var reviewScopeSaveBtn = document.getElementById('reviewScopeSave');
  if (reviewScopeSaveBtn) {
    reviewScopeSaveBtn.onclick = function () {
      var raw = document.getElementById('reviewScopeInput').value || '';
      var sep = new RegExp('[,;' + String.fromCharCode(10) + String.fromCharCode(13) + ']');
      var entries = raw.split(sep).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
      var status = document.getElementById('reviewScopeStatus');
      status.textContent = 'Saving...';
      apost('/api/review/allowlist', { entries: entries }).then(function (resp) {
        if (resp && resp.ok) {
          document.getElementById('reviewScopeInput').value = (resp.entries || []).join(', ');
          var n = (resp.entries || []).length;
          status.textContent = n ? ('Saved (' + n + ' entr' + (n === 1 ? 'y' : 'ies') + '). Empty = review all.') : 'Saved. Empty allowlist = review every PR.';
        } else { status.textContent = (resp && resp.error) ? resp.error : 'Save failed.'; }
      }).catch(function () { status.textContent = 'Save failed (owner-only).'; });
    };
  }
  document.getElementById('tabBtnDocs').onclick = function () { showTab('docs'); };
  document.getElementById('aStartBtn').onclick = function () { apost('/api/audit/start').then(applyAuditState).then(function () { setTimeout(refreshAudit, 600); }).catch(function () {}); };
  document.getElementById('aStopBtn').onclick = function () { apost('/api/audit/stop').then(applyAuditState).catch(function () {}); };
  document.getElementById('aAuto').onchange = function () { apost('/api/audit/auto-create', { enabled: document.getElementById('aAuto').checked }).then(applyAuditState).catch(function () {}); };
  document.getElementById('aType').onchange = function () { auditFilter.type = this.value; applyAuditFilters(); };
  document.getElementById('aSev').onchange = function () { auditFilter.sev = this.value; applyAuditFilters(); };
  document.getElementById('aState').onchange = function () { auditFilter.state = this.value; applyAuditFilters(); };
  document.getElementById('aPkg').oninput = function () { auditFilter.pkg = this.value; applyAuditFilters(); };
  document.getElementById('aPath').oninput = function () { auditFilter.path = this.value; applyAuditFilters(); };
  var aoBtn = document.getElementById('aAreaOwners'); if (aoBtn) { aoBtn.onclick = openAreaOwnersDialog; }

  // Identify the viewer: Start/Stop are owner-only (hidden here and enforced server-side).
  fetch('/api/whoami').then(function (r) { return r.json(); }).then(function (w) {
    isOwnerClient = !!w.isOwner;
    if (!isOwnerClient) {
      var sb = document.getElementById('startBtn'); if (sb) { sb.style.display = 'none'; }
      var pb = document.getElementById('stopBtn'); if (pb) { pb.style.display = 'none'; }
    } else {
      var rb = document.getElementById('reviewScopeBox'); if (rb) { rb.style.display = ''; }
    }
    renderAuditList();
  }).catch(function () {});
  var hashMatch = /^#pr-(\\d+)$/.exec(window.location.hash);
  if (hashMatch) { expanded[hashMatch[1]] = true; }
  loadMore();
  loadStats();
  loadFeedback();
  connectEvents();
  loadModel();
  setInterval(loadModel, 15000);

  // ---- Chat tab (conversational design + feature building) ----
  var chatConvId = null;
  var chatArtifactKey = null;
  var chatMsgCount = -1;
  var chatPollTimer = null;
  var mermaidReady = false;

  function chatEsc(s) { var d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

  function ensureMermaid() {
    if (mermaidReady || !window.mermaid) { return; }
    try {
      var isLight = document.documentElement.getAttribute('data-theme') === 'light' || document.body.classList.contains('light');
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isLight ? 'default' : 'dark' });
      mermaidReady = true;
    } catch (e) {}
  }

  function renderMermaidIn(container) {
    if (!window.mermaid) { return; }
    ensureMermaid();
    var blocks = Array.prototype.slice.call(container.querySelectorAll('pre.mermaid'));
    if (!blocks.length) { return; }
    try { window.mermaid.run({ nodes: blocks, suppressErrors: true }); } catch (e) {}
  }

  function loadConversations() {
    fetch('/api/chat/conversations').then(function (r) { return r.json(); }).then(function (data) {
      var list = document.getElementById('chatConvList');
      if (!list) { return; }
      list.innerHTML = '';
      var convs = (data && data.conversations) || [];
      if (!convs.length) {
        var empty = document.createElement('div'); empty.className = 'chat-empty'; empty.textContent = 'No conversations yet.'; list.appendChild(empty);
      }
      convs.forEach(function (c) {
        var item = document.createElement('div');
        item.className = 'chat-conv' + (c.id === chatConvId ? ' active' : '');
        item.textContent = c.title || 'New chat';
        item.title = (c.mode === 'spec' ? '[spec] ' : '') + (c.title || '');
        item.onclick = function () { openConversation(c.id); };
        list.appendChild(item);
      });
    }).catch(function () {});
  }

  function createChat(mode, afterText) {
    apost('/api/chat/conversations', { mode: mode }).then(function (resp) {
      if (resp && resp.conversation) {
        chatConvId = resp.conversation.id;
        chatArtifactKey = null; chatMsgCount = -1;
        loadConversations();
        if (afterText) { doSend(afterText); } else { openConversation(resp.conversation.id); }
      }
    }).catch(function () {});
  }
  function newChat() { createChat('design', null); }
  function newSpecChat() { createChat('spec', null); }

  function openConversation(id) {
    chatConvId = id; chatArtifactKey = null; chatMsgCount = -1;
    loadConversations();
    fetch('/api/chat/conversation?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (data) {
      renderThread((data && data.messages) || []);
      renderArtifact((data && data.artifact) || null);
      var dl = document.getElementById('chatTranscriptBtn'); if (dl) { dl.style.display = ''; }
    }).catch(function () {});
    if (!chatPollTimer) {
      chatPollTimer = setInterval(function () {
        if (document.getElementById('tab-chat').style.display !== 'none' && chatConvId) { refreshConversation(); }
      }, 5000);
    }
  }

  function refreshConversation() {
    if (!chatConvId) { return; }
    fetch('/api/chat/conversation?id=' + encodeURIComponent(chatConvId)).then(function (r) { return r.json(); }).then(function (data) {
      var msgs = (data && data.messages) || [];
      if (msgs.length !== chatMsgCount) { renderThread(msgs); }
      if (data && data.artifact) { renderArtifact(data.artifact); }
    }).catch(function () {});
  }

  function renderThread(messages) {
    var thread = document.getElementById('chatThread');
    if (!thread) { return; }
    chatMsgCount = messages.length;
    thread.innerHTML = '';
    messages.filter(function (m) { return m.role !== 'system'; }).forEach(function (m) {
      var row = document.createElement('div'); row.className = 'chat-msg ' + (m.role === 'user' ? 'user' : 'assistant');
      var bubble = document.createElement('div'); bubble.className = 'chat-bubble';
      bubble.textContent = m.content;
      row.appendChild(bubble);
      thread.appendChild(row);
    });
    thread.scrollTop = thread.scrollHeight;
  }

  function renderArtifact(artifact) {
    var pane = document.getElementById('chatDoc');
    if (!pane) { return; }
    if (!artifact) {
      if (chatArtifactKey === null) { return; }
      chatArtifactKey = null;
      pane.innerHTML = '<div class="chat-empty">The design document will appear here once the agent drafts one.</div>';
      return;
    }
    var key = artifact.id + ':' + artifact.updatedAt + ':' + (artifact.status || '');
    if (key === chatArtifactKey) { return; }
    chatArtifactKey = key;
    pane.innerHTML = '';
    var head = document.createElement('div'); head.className = 'chat-doc-head';
    var h = document.createElement('div'); h.className = 'chat-doc-title'; h.textContent = artifact.title || 'Design document'; head.appendChild(h);
    if (artifact.feasibility) { var badge = document.createElement('span'); badge.className = 'feas ' + artifact.feasibility; badge.textContent = artifact.feasibility; head.appendChild(badge); }
    pane.appendChild(head);

    var actions = document.createElement('div'); actions.className = 'chat-doc-actions';
    function dlBtn(label, suffix) { var b = document.createElement('button'); b.className = 'btn sm ghost'; b.textContent = label; b.onclick = function () { window.open('/api/chat/artifact?id=' + encodeURIComponent(artifact.id) + suffix, '_blank'); }; return b; }
    actions.appendChild(dlBtn('Download .md', '&format=md&download=1'));
    actions.appendChild(dlBtn('Download .html', '&format=html&download=1'));
    actions.appendChild(dlBtn('Open HTML', '&format=html'));
    pane.appendChild(actions);

    var build = document.createElement('div'); build.className = 'chat-doc-build';
    if (artifact.feasibility === 'not-possible') {
      var no = document.createElement('div'); no.className = 'muted-note'; no.textContent = 'Marked not feasible - refine the request before building.'; build.appendChild(no);
    } else if (artifact.status === 'building' || artifact.status === 'approved') {
      var st0 = document.createElement('span'); st0.className = 'muted-note'; st0.textContent = 'Build in progress - see the Code Autopilot tab.'; build.appendChild(st0);
    } else if (artifact.status === 'built') {
      var st1 = document.createElement('span'); st1.className = 'muted-note'; st1.textContent = 'Built - a pull request was opened.'; build.appendChild(st1);
    } else {
      var opts = artifact.options || [];
      if (opts.length > 1) {
        var lbl = document.createElement('div'); lbl.className = 'muted-note'; lbl.style.width = '100%'; lbl.textContent = 'Choose an approach to build:'; build.appendChild(lbl);
        opts.forEach(function (o) { var ob = document.createElement('button'); ob.className = 'btn sm'; ob.textContent = (o.recommended ? '\u2605 ' : '') + o.label; ob.title = o.summary || ''; ob.onclick = function () { approveBuild(artifact.id, o.label, false); }; build.appendChild(ob); });
        var best = document.createElement('button'); best.className = 'btn sm ghost'; best.textContent = 'Build best option'; best.onclick = function () { approveBuild(artifact.id, null, true); }; build.appendChild(best);
      } else {
        var only = (opts[0] && opts[0].label) ? opts[0].label : null;
        var ap = document.createElement('button'); ap.className = 'btn sm'; ap.textContent = 'Approve & build'; ap.onclick = function () { approveBuild(artifact.id, only, false); }; build.appendChild(ap);
      }
    }
    pane.appendChild(build);

    var body = document.createElement('div'); body.className = 'chat-doc-body'; body.id = 'chatDocBody';
    body.textContent = 'Rendering...';
    pane.appendChild(body);
    fetch('/api/chat/artifact?id=' + encodeURIComponent(artifact.id) + '&format=fragment').then(function (r) { return r.text(); }).then(function (html) {
      body.innerHTML = html; renderMermaidIn(body);
    }).catch(function () { body.textContent = '(could not render the document)'; });
  }

  function approveBuild(artifactId, option, best) {
    var payload = { conversationId: chatConvId, artifactId: artifactId };
    if (option) { payload.selectedOption = option; }
    if (best) { payload.proceedWithBest = true; }
    apost('/api/chat/approve', payload).then(function () { chatArtifactKey = null; refreshConversation(); }).catch(function () {});
  }

  function sendChatMessage() {
    var input = document.getElementById('chatInput');
    if (!input) { return; }
    var text = (input.value || '').trim();
    if (!text) { return; }
    if (!chatConvId) { createChat('design', text); input.value = ''; return; }
    doSend(text);
  }

  function doSend(text) {
    var input = document.getElementById('chatInput');
    var sendBtn = document.getElementById('chatSend');
    var thread = document.getElementById('chatThread');
    if (thread) {
      if (chatMsgCount < 0) { thread.innerHTML = ''; chatMsgCount = 0; }
      var row = document.createElement('div'); row.className = 'chat-msg user'; var b = document.createElement('div'); b.className = 'chat-bubble'; b.textContent = text; row.appendChild(b); thread.appendChild(row);
      var tr = document.createElement('div'); tr.className = 'chat-msg assistant'; var tb = document.createElement('div'); tb.className = 'chat-bubble'; tb.textContent = 'Researching the codebase...'; tr.appendChild(tb); thread.appendChild(tr);
      thread.scrollTop = thread.scrollHeight;
    }
    if (input) { input.value = ''; input.disabled = true; }
    if (sendBtn) { sendBtn.disabled = true; }
    apost('/api/chat/message', { conversationId: chatConvId, message: text }).then(function (resp) {
      if (input) { input.disabled = false; }
      if (sendBtn) { sendBtn.disabled = false; }
      if (resp && resp.messages) { renderThread(resp.messages); }
      if (resp && resp.artifact) { renderArtifact(resp.artifact); }
      loadConversations();
      if (input) { input.focus(); }
    }).catch(function () {
      if (input) { input.disabled = false; }
      if (sendBtn) { sendBtn.disabled = false; }
    });
  }

  function downloadTranscript() { if (chatConvId) { window.open('/api/chat/transcript?id=' + encodeURIComponent(chatConvId) + '&format=html', '_blank'); } }

  function loadFeatureBuilds() {
    fetch('/api/chat/builds').then(function (r) { return r.json(); }).then(function (data) {
      var builds = (data && data.builds) || [];
      var host = document.getElementById('featureBuilds');
      if (!host) {
        var fix = document.getElementById('tab-fix');
        if (!fix) { return; }
        host = document.createElement('div'); host.id = 'featureBuilds'; host.style.margin = '12px 0';
        fix.insertBefore(host, fix.firstChild);
      }
      if (!builds.length) { host.innerHTML = ''; return; }
      var rows = builds.map(function (b) {
        var pr = b.prUrl ? ('<a href="' + chatEsc(b.prUrl) + '" target="_blank" rel="noopener">PR !' + chatEsc(String(b.prId)) + '</a>') : '';
        return '<tr><td>' + chatEsc(b.title) + '</td><td>' + chatEsc(b.status) + '</td><td>' + chatEsc(b.lastAction || '') + '</td><td>' + pr + '</td></tr>';
      }).join('');
      host.innerHTML = '<div class="section-head"><h2>Feature builds</h2><span class="count-chip">' + builds.length + '</span></div><table class="fx-table"><thead><tr><th>Feature</th><th>Status</th><th>Step</th><th>PR</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }).catch(function () {});
  }

  (function () {
    var nb = document.getElementById('chatNewBtn'); if (nb) { nb.onclick = newChat; }
    var nsb = document.getElementById('chatNewSpecBtn'); if (nsb) { nsb.onclick = newSpecChat; }
    var sb2 = document.getElementById('chatSend'); if (sb2) { sb2.onclick = sendChatMessage; }
    var tb2 = document.getElementById('chatTranscriptBtn'); if (tb2) { tb2.onclick = downloadTranscript; }
    var ci = document.getElementById('chatInput');
    if (ci) { ci.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } }; }
  })();

  // ---- React-based Chat tab: streaming, resizable panels, on-demand design-doc view ----
  var __chatMermaidReady = false;
  var __chatMermaidLoading = false;
  var __chatMermaidCbs = [];
  function chatMermaidInit() {
    if (__chatMermaidReady || !window.mermaid) { return; }
    try {
      var isLight = document.documentElement.getAttribute('data-theme') === 'light' || document.body.classList.contains('light');
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isLight ? 'default' : 'dark' });
      __chatMermaidReady = true;
    } catch (e) {}
  }
  // Lazy-load the (multi-MB) mermaid bundle only when a design doc is actually viewed, so the chat app and the
  // conversation list are not blocked on that download at page load. Runs cb once mermaid is ready.
  function chatEnsureMermaid(cb) {
    if (window.mermaid) { chatMermaidInit(); if (cb) { cb(); } return; }
    if (cb) { __chatMermaidCbs.push(cb); }
    if (__chatMermaidLoading) { return; }
    __chatMermaidLoading = true;
    var s = document.createElement('script');
    s.src = '/vendor/mermaid.min.js';
    s.onload = function () { chatMermaidInit(); var cbs = __chatMermaidCbs; __chatMermaidCbs = []; for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} } };
    s.onerror = function () { __chatMermaidLoading = false; };
    document.head.appendChild(s);
  }

  function currentTitle(convos, id) {
    if (!id) { return 'New conversation'; }
    for (var i = 0; i < convos.length; i++) { if (convos[i].id === id) { return convos[i].title || 'New chat'; } }
    return 'Conversation';
  }

  // Clipboard fallback for contexts where navigator.clipboard is unavailable (older or non-secure origins).
  function chatCopyFallback(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch (e) { return false; }
  }

  function ChatApp() {
    var React = window.React;
    var h = React.createElement;
    var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef, useCallback = React.useCallback;

    var s1 = useState([]); var convos = s1[0], setConvos = s1[1];
    var s2 = useState(null); var currentId = s2[0], setCurrentId = s2[1];
    var s3 = useState([]); var messages = s3[0], setMessages = s3[1];
    var s4 = useState(null); var artifact = s4[0], setArtifact = s4[1];
    var s5 = useState(false); var docOpen = s5[0], setDocOpen = s5[1];
    var s6 = useState(false); var streaming = s6[0], setStreaming = s6[1];
    var s7 = useState(''); var statusText = s7[0], setStatusText = s7[1];
    var s8 = useState(''); var streamReply = s8[0], setStreamReply = s8[1];
    var s9 = useState(260); var leftW = s9[0], setLeftW = s9[1];
    var s10 = useState(500); var rightW = s10[0], setRightW = s10[1];
    var s11 = useState(''); var docHtml = s11[0], setDocHtml = s11[1];
    var s12 = useState(''); var draft = s12[0], setDraft = s12[1];
    var s13 = useState([]); var cot = s13[0], setCot = s13[1];
    var s14 = useState(true); var cotOpen = s14[0], setCotOpen = s14[1];
    var s15 = useState(null); var dialog = s15[0], setDialog = s15[1];
    var s16 = useState(''); var renameValue = s16[0], setRenameValue = s16[1];
    var s17 = useState(false); var mdCopied = s17[0], setMdCopied = s17[1];
    var s18 = useState(false); var owner = s18[0], setOwner = s18[1];
    var s19 = useState([]); var plan = s19[0], setPlan = s19[1];

    var threadRef = useRef(null);
    var docBodyRef = useRef(null);
    var streamingRef = useRef(false);
    var srRef = useRef('');
    var cotRef = useRef(null);

    var loadConvos = useCallback(function () {
      fetch('/api/chat/conversations').then(function (r) { return r.json(); }).then(function (d) { setConvos((d && d.conversations) || []); }).catch(function () {});
    }, []);
    var refreshConversation = useCallback(function (id) {
      fetch('/api/chat/conversation?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
        setMessages(((d && d.messages) || []).filter(function (m) { return m.role !== 'system'; }));
        if (d && d.artifact) { setArtifact(d.artifact); }
      }).catch(function () {});
    }, []);

    useEffect(function () { loadConvos(); }, [loadConvos]);
    useEffect(function () { fetch('/api/whoami').then(function (r) { return r.json(); }).then(function (w) { setOwner(!!w.isOwner); }).catch(function () {}); }, []);
    useEffect(function () {
      if (!currentId) { setMessages([]); setArtifact(null); setDocOpen(false); return; }
      fetch('/api/chat/conversation?id=' + encodeURIComponent(currentId)).then(function (r) { return r.json(); }).then(function (d) {
        setMessages(((d && d.messages) || []).filter(function (m) { return m.role !== 'system'; }));
        setArtifact((d && d.artifact) || null);
      }).catch(function () {});
    }, [currentId]);
    useEffect(function () { var el = threadRef.current; if (el) { el.scrollTop = el.scrollHeight; } }, [messages, streamReply, statusText, streaming]);
    useEffect(function () { var el = cotRef.current; if (el) { el.scrollTop = el.scrollHeight; } }, [cot]);
    useEffect(function () {
      if (!docOpen || !artifact) { setDocHtml(''); return; }
      fetch('/api/chat/artifact?id=' + encodeURIComponent(artifact.id) + '&format=fragment').then(function (r) { return r.text(); }).then(function (html) { setDocHtml(html); }).catch(function () { setDocHtml('<div class="chat-empty">Could not render the document.</div>'); });
    }, [docOpen, artifact]);
    useEffect(function () {
      var el = docBodyRef.current;
      if (!el || !docHtml) { return; }
      chatEnsureMermaid(function () {
        var blocks = Array.prototype.slice.call(el.querySelectorAll('pre.mermaid'));
        if (blocks.length) { try { window.mermaid.run({ nodes: blocks, suppressErrors: true }); } catch (e) {} }
      });
    }, [docHtml]);
    // While a build is running, poll so the PR link + status appear without a manual refresh.
    useEffect(function () {
      if (!currentId || !artifact || (artifact.status !== 'building' && artifact.status !== 'approved')) { return; }
      var t = setInterval(function () { refreshConversation(currentId); }, 6000);
      return function () { clearInterval(t); };
    }, [currentId, artifact, refreshConversation]);

    var doStream = useCallback(function (convId, text) {
      setStreaming(true); streamingRef.current = true; setStatusText('Sending'); setStreamReply(''); srRef.current = '';
      setCot([]); setCotOpen(true); setPlan([]);
      var NL = String.fromCharCode(10);
      fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: convId, message: text }) }).then(function (resp) {
        if (!resp.body) { throw new Error('no stream'); }
        var reader = resp.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        function finish() {
          streamingRef.current = false; setStreaming(false); setStatusText('');
          var finalReply = srRef.current;
          if (finalReply) { setMessages(function (p) { return p.concat([{ role: 'assistant', content: finalReply }]); }); }
          setStreamReply(''); srRef.current = '';
          refreshConversation(convId); loadConvos();
        }
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { finish(); return; }
            buf += dec.decode(res.value, { stream: true });
            var frames = buf.split(NL + NL);
            buf = frames.pop();
            frames.forEach(function (frame) {
              var ev = 'message', dataStr = '';
              frame.split(NL).forEach(function (line) {
                if (line.indexOf('event:') === 0) { ev = line.slice(6).trim(); }
                else if (line.indexOf('data:') === 0) { dataStr += line.slice(5).trim(); }
              });
              if (!dataStr) { return; }
              var data; try { data = JSON.parse(dataStr); } catch (e) { return; }
              if (ev === 'status') { setStatusText(data.text || ''); }
              else if (ev === 'title') { if (data.title) { setConvos(function (p) { return p.map(function (c) { return c.id === convId ? Object.assign({}, c, { title: data.title }) : c; }); }); } }
              else if (ev === 'cot') { setCot(function (p) { var n = p.concat([data.text || '']); return n.length > 200 ? n.slice(n.length - 200) : n; }); }
              else if (ev === 'plan') { setPlan((data && data.items) || []); }
              else if (ev === 'delta') { setCotOpen(false); setStreamReply(function (p) { var nv = p + (data.text || ''); srRef.current = nv; return nv; }); }
              else if (ev === 'reset') { srRef.current = ''; setStreamReply(''); setCotOpen(true); }
              else if (ev === 'artifact') { if (data.artifact) { setArtifact(data.artifact); } }
              else if (ev === 'error') { srRef.current = srRef.current || ('Sorry - ' + (data.text || 'the agent failed.')); }
              else if (ev === 'done') { if (data.artifact) { setArtifact(data.artifact); } if (data.title) { setConvos(function (p) { return p.map(function (c) { return c.id === convId ? Object.assign({}, c, { title: data.title }) : c; }); }); } }
            });
            return pump();
          });
        }
        return pump();
      }).catch(function () {
        streamingRef.current = false; setStreaming(false); setStatusText('');
        setMessages(function (p) { return p.concat([{ role: 'assistant', content: '(failed to reach the agent - please try again)' }]); });
      });
    }, [refreshConversation, loadConvos]);

    var send = useCallback(function () {
      var text = (draft || '').trim();
      if (!text || streamingRef.current) { return; }
      setDraft('');
      setMessages(function (p) { return p.concat([{ role: 'user', content: text }]); });
      if (!currentId) {
        apost('/api/chat/conversations', {}).then(function (resp) {
          if (resp && resp.conversation) {
            var nc = resp.conversation;
            var prov = text.trim().split(' ').slice(0, 8).join(' ').slice(0, 60);
            setConvos(function (p) { return [Object.assign({}, nc, { title: prov || (nc.title || 'New chat') })].concat(p.filter(function (x) { return x.id !== nc.id; })); });
            setCurrentId(nc.id);
            doStream(nc.id, text);
          }
        }).catch(function () {});
      } else { doStream(currentId, text); }
    }, [draft, currentId, doStream, loadConvos]);

    var newChat = useCallback(function () {
      apost('/api/chat/conversations', {}).then(function (resp) { if (resp && resp.conversation) { loadConvos(); setCurrentId(resp.conversation.id); } }).catch(function () {});
    }, [loadConvos]);
    var openDialog = useCallback(function (mode, c, e) {
      e.stopPropagation();
      setDialog({ mode: mode, id: c.id, title: c.title || 'New chat' });
      if (mode === 'rename') { setRenameValue(c.title || ''); }
    }, []);
    var closeDialog = useCallback(function () { setDialog(null); }, []);
    var confirmDialog = useCallback(function () {
      if (!dialog) { return; }
      if (dialog.mode === 'rename') {
        var t = (renameValue || '').trim();
        if (t === '') { return; }
        var rid = dialog.id;
        apost('/api/chat/rename', { id: rid, title: t }).then(function () { setConvos(function (p) { return p.map(function (x) { return x.id === rid ? Object.assign({}, x, { title: t }) : x; }); }); }).catch(function () {});
      } else if (dialog.mode === 'delete') {
        var did = dialog.id;
        apost('/api/chat/delete', { id: did }).then(function () { loadConvos(); if (did === currentId) { setCurrentId(null); } }).catch(function () {});
      } else if (dialog.mode === 'build') {
        if (artifact) {
          var payload = { conversationId: currentId, artifactId: artifact.id };
          if (dialog.option) { payload.selectedOption = dialog.option; }
          if (dialog.best) { payload.proceedWithBest = true; }
          apost('/api/chat/approve', payload).then(function () { refreshConversation(currentId); }).catch(function () {});
        }
      }
      setDialog(null);
    }, [dialog, renameValue, loadConvos, currentId, artifact, refreshConversation]);
    // Building creates a branch and opens a pull request, so it must be a deliberate, confirmed approval -
    // never a stray click. Open a confirmation dialog first; the actual approve+build runs on confirm.
    var askBuild = useCallback(function (option, best) {
      if (!artifact) { return; }
      setDialog({ mode: 'build', option: option || null, best: !!best, title: artifact.title || 'this design' });
    }, [artifact]);
    // Copy the design doc's markdown (with the Saturn watermark the server appends) to the clipboard.
    var copyMarkdown = useCallback(function () {
      if (!artifact) { return; }
      fetch('/api/chat/artifact?id=' + encodeURIComponent(artifact.id) + '&format=md').then(function (r) { return r.text(); }).then(function (md) {
        function done() { setMdCopied(true); setTimeout(function () { setMdCopied(false); }, 1600); }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(md).then(done, function () { if (chatCopyFallback(md)) { done(); } });
        } else if (chatCopyFallback(md)) { done(); }
      }).catch(function () {});
    }, [artifact]);

    function startDrag(which, e) {
      e.preventDefault();
      var startX = e.clientX, startL = leftW, startR = rightW;
      function move(ev) {
        if (which === 'left') { setLeftW(Math.max(190, Math.min(460, startL + (ev.clientX - startX)))); }
        else { setRightW(Math.max(340, Math.min(900, startR - (ev.clientX - startX)))); }
      }
      function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    }

    function docBtn(label, suffix) { return h('button', { key: label, className: 'btn sm ghost', onClick: function () { window.open('/api/chat/artifact?id=' + encodeURIComponent(artifact.id) + suffix, '_blank'); } }, label); }
    function docPanel() {
      var build;
      if (artifact.feasibility === 'not-possible') { build = h('div', { className: 'muted-note' }, 'Marked not feasible - refine the request before building.'); }
      else if (artifact.status === 'building' || artifact.status === 'approved') { build = h('span', { className: 'muted-note' }, 'Build in progress - see the Code Autopilot tab.'); }
      else if (artifact.status === 'built') { build = h('span', { className: 'muted-note' }, 'Built - a pull request was opened.'); }
      else if (!owner) { build = h('span', { className: 'muted-note' }, 'Only the owner can approve & build this design.'); }
      else {
        var opts = artifact.options || [];
        if (opts.length > 1) {
          build = [h('span', { key: 'l', className: 'muted-note', style: { width: '100%' } }, 'Choose an approach to build:')]
            .concat(opts.map(function (o, i) { return h('button', { key: 'o' + i, className: 'btn sm', title: o.summary || '', onClick: function () { askBuild(o.label, false); } }, (o.recommended ? '\u2605 ' : '') + o.label); }))
            .concat([h('button', { key: 'best', className: 'btn sm ghost', onClick: function () { askBuild(null, true); } }, 'Build best option')]);
        } else {
          var only = (opts[0] && opts[0].label) ? opts[0].label : null;
          build = h('button', { className: 'btn sm', onClick: function () { askBuild(only, false); } }, 'Approve & build');
        }
      }
      return h('div', { className: 'chat-doc', key: 'doc', style: { width: rightW } },
        h('div', { className: 'chat-doc-top' },
          h('span', { className: 'chat-doc-title2' }, artifact.title || 'Design document'),
          artifact.feasibility ? h('span', { className: 'feas ' + artifact.feasibility }, artifact.feasibility) : null,
          h('button', { className: 'chat-x', title: 'Close', onClick: function () { setDocOpen(false); } }, '\u00d7')
        ),
        h('div', { className: 'chat-doc-actions2' }, h('button', { key: 'cpy', className: 'btn sm ghost', onClick: copyMarkdown }, mdCopied ? '\u2713 Copied' : 'Copy markdown'), docBtn('Download .html', '&format=html&download=1'), docBtn('Open HTML', '&format=html'),
          h('button', { key: 'tr', className: 'btn sm ghost', onClick: function () { window.open('/api/chat/transcript?id=' + encodeURIComponent(currentId) + '&format=html', '_blank'); } }, 'Transcript')),
        h('div', { className: 'chat-doc-build2' }, build),
        h('div', { className: 'chat-doc-scroll' }, h('div', { className: 'cbody', ref: docBodyRef, dangerouslySetInnerHTML: { __html: docHtml || 'Rendering...' } }))
      );
    }

    var sidebar = h('div', { key: 'sb', className: 'chat-sidebar', style: { width: leftW } },
      owner ? h('button', { className: 'btn chat-newbtn', onClick: newChat }, '+ New chat') : null,
      h('div', { className: 'chat-conv-list' },
        convos.length === 0 ? h('div', { className: 'chat-empty' }, 'No conversations yet.') :
        convos.map(function (c) {
          return h('div', { key: c.id, className: 'chat-conv' + (c.id === currentId ? ' active' : ''), onClick: function () { setCurrentId(c.id); setDocOpen(false); } },
            h('span', { className: 'title' }, c.title || 'New chat'),
            owner ? h('button', { className: 'del', title: 'Rename', onClick: function (e) { openDialog('rename', c, e); } }, '\u270e') : null,
            owner ? h('button', { className: 'del', title: 'Delete conversation', onClick: function (e) { openDialog('delete', c, e); } }, '\u00d7') : null);
        })
      )
    );

    var msgEls = messages.map(function (m, i) {
      var bubble = (m.role === 'assistant' && m.contentHtml)
        ? h('div', { className: 'chat-bubble chat-md', dangerouslySetInnerHTML: { __html: m.contentHtml } })
        : h('div', { className: 'chat-bubble' }, m.content);
      return h('div', { key: i, className: 'chat-msg ' + (m.role === 'user' ? 'user' : 'assistant') }, bubble);
    });
    var liveEl = null;
    if (streaming) {
      var cotHead = h('div', { className: 'cot-head', onClick: function () { setCotOpen(!cotOpen); } },
        h('span', { className: 'cot-title' }, streamReply ? 'Thought process' : (statusText || 'Thinking')),
        (!streamReply && cot.length === 0) ? h('span', { className: 'dots' }, h('span', null), h('span', null), h('span', null)) : h('span', { className: 'cot-toggle' }, cotOpen ? 'Hide' : 'Show'));
      var cotBody = (cotOpen && cot.length) ? h('div', { className: 'cot-body', ref: cotRef }, cot.map(function (l, i) { return h('div', { key: i, className: 'cot-line' }, l); })) : null;
      var live = h('div', { className: 'chat-live' }, h('div', { className: 'cot' }, cotHead, cotBody), streamReply ? h('div', { className: 'chat-bubble' }, streamReply, h('span', { className: 'caret' })) : null);
      liveEl = h('div', { key: 'live', className: 'chat-msg assistant' }, live);
    }
    var planThreadEl = (plan && plan.length) ? h('div', { key: 'plan', className: 'chat-msg assistant' },
      h('div', { className: 'chat-plan' },
        h('div', { className: 'chat-plan-head' }, 'Plan'),
        plan.map(function (it, i) { return h('div', { key: i, className: 'chat-plan-item' + (it.done ? ' done' : '') }, (it.done ? '\u2713 ' : '\u25cb ') + (it.text || '')); }))) : null;
    var thread = h('div', { className: 'chat-thread', ref: threadRef },
      (messages.length === 0 && !streaming) ? h('div', { key: 'w', className: 'chat-welcome' }, h('h3', null, 'Design & build with Saturn'), h('p', null, 'Describe what you want to design or build. Saturn researches the whole codebase, checks feasibility, proposes options, and can open a pull request - all reviewed by you.')) : null,
      msgEls, planThreadEl, liveEl);
    var docBar = (artifact && !docOpen) ? h('div', { className: 'chat-docbar' },
      h('button', { className: 'btn sm', onClick: function () { setDocOpen(true); } }, '\ud83d\udcc4 Open design document'),
      artifact.feasibility ? h('span', { className: 'feas ' + artifact.feasibility }, artifact.feasibility) : null,
      h('span', { className: 'muted-note' }, artifact.title || '')) : null;
    var composer = owner
      ? h('div', { className: 'chat-composer' },
        h('textarea', { className: 'chat-input', rows: 2, placeholder: 'Describe what you want to design or build...', value: draft, disabled: streaming,
          onChange: function (e) { setDraft(e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } }),
        h('button', { className: 'btn chat-send', onClick: send, disabled: streaming || !draft.trim() }, streaming ? 'Sending' : 'Send'))
      : h('div', { className: 'chat-composer' }, h('span', { className: 'muted', style: { fontSize: '13px' } }, '\ud83d\udd12 Read-only view \u2014 only the owner can design & build here.'));
    var mainCol = h('div', { key: 'main', className: 'chat-col' }, h('div', { className: 'chat-head' }, currentTitle(convos, currentId)), thread, docBar, composer);

    var children = [sidebar, h('div', { key: 'ls', className: 'chat-splitter', onMouseDown: function (e) { startDrag('left', e); } }), mainCol];
    if (docOpen && artifact) {
      children.push(h('div', { key: 'rs', className: 'chat-splitter', onMouseDown: function (e) { startDrag('right', e); } }));
      children.push(docPanel());
    }
    var modal = null;
    if (dialog) {
      var box;
      if (dialog.mode === 'rename') {
        box = h('div', { className: 'chat-modal', onMouseDown: function (e) { e.stopPropagation(); } },
          h('h3', null, 'Rename conversation'),
          h('input', { className: 'chat-modal-input', value: renameValue, autoFocus: true,
            onChange: function (e) { setRenameValue(e.target.value); },
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); confirmDialog(); } else if (e.key === 'Escape') { closeDialog(); } } }),
          h('div', { className: 'chat-modal-actions' },
            h('button', { className: 'btn ghost sm', onClick: closeDialog }, 'Cancel'),
            h('button', { className: 'btn sm', onClick: confirmDialog, disabled: !renameValue.trim() }, 'Save')));
      } else if (dialog.mode === 'build') {
        box = h('div', { className: 'chat-modal', onMouseDown: function (e) { e.stopPropagation(); } },
          h('h3', null, 'Approve design & build'),
          h('p', { className: 'chat-modal-msg' }, 'This approves ' + (dialog.title ? '\u201c' + dialog.title + '\u201d' : 'this design') + (dialog.option ? ' (approach: ' + dialog.option + ')' : (dialog.best ? ' (recommended approach)' : '')) + ' and starts a build that creates a branch and opens a pull request. Continue?'),
          h('div', { className: 'chat-modal-actions' },
            h('button', { className: 'btn ghost sm', onClick: closeDialog }, 'Cancel'),
            h('button', { className: 'btn sm', onClick: confirmDialog }, 'Approve & build')));
      } else {
        box = h('div', { className: 'chat-modal', onMouseDown: function (e) { e.stopPropagation(); } },
          h('h3', null, 'Delete conversation'),
          h('p', { className: 'chat-modal-msg' }, 'Delete \u201c' + (dialog.title || 'this conversation') + '\u201d? This cannot be undone.'),
          h('div', { className: 'chat-modal-actions' },
            h('button', { className: 'btn ghost sm', onClick: closeDialog }, 'Cancel'),
            h('button', { className: 'btn danger sm', onClick: confirmDialog }, 'Delete')));
      }
      modal = h('div', { className: 'chat-modal-overlay', onMouseDown: closeDialog }, box);
    }
    return h('div', null, h('div', { className: 'chat-shell' }, children), modal);
  }

  var __chatMounted = false;
  function mountChat() {
    if (__chatMounted) { return; }
    var root = document.getElementById('chat-root');
    if (!root) { return; }
    if (!window.React || !window.ReactDOM || !window.ReactDOM.createRoot) {
      root.innerHTML = '<div class="chat-empty" style="padding:24px">The Chat UI could not load (React unavailable). Please reload the page.</div>';
      return;
    }
    __chatMounted = true;
    try { window.ReactDOM.createRoot(root).render(window.React.createElement(ChatApp)); } catch (e) {}
  }

  (function () {
    var t = (new URLSearchParams(window.location.search).get('tab') || '').toLowerCase();
    showTab((t === 'codebase-audit' || t === 'audit') ? 'audit' : ((t === 'reviews' || t === 'pr') ? 'pr' : ((t === 'fix' || t === 'fix-agent') ? 'fix' : ((t === 'docs' || t === 'documentation') ? 'docs' : ((t === 'chat') ? 'chat' : 'dash')))));
  })();
  setInterval(tickTimer, 1000);
</script>
</body>
</html>`;

const FEEDBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Saturn - Share feedback</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family:'Segoe UI',system-ui,sans-serif; background:#0b1020; color:#e6e9f0; }
  main { max-width:640px; margin:40px auto; padding:0 24px; }
  h1 { font-size:20px; letter-spacing:2px; }
  .who { background:#121a36; border:1px solid #232a44; border-radius:8px; padding:10px 14px; margin:14px 0; font-size:14px; }
  .who b { color:#7aa2ff; }
  .ctx { font-size:13px; color:#8b93b5; margin-bottom:14px; }
  .rate button { background:#1b2547; color:#e6e9f0; border:1px solid #232a44; border-radius:8px; padding:8px 14px; margin-right:8px; cursor:pointer; }
  .rate button.sel { background:#2952e3; border-color:#2952e3; }
  textarea { width:100%; min-height:120px; background:#0d1430; color:#e6e9f0; border:1px solid #232a44; border-radius:8px; padding:10px; font:inherit; box-sizing:border-box; margin:12px 0; }
  button.submit { background:#2952e3; color:#fff; border:0; border-radius:8px; padding:10px 20px; font-size:14px; cursor:pointer; }
  button.submit:disabled { opacity:.45; cursor:default; }
  .ok { color:#5ee08a; margin-top:14px; } .err { color:#ff7a8a; margin-top:14px; }
  a { color:#7aa2ff; }
</style>
</head>
<body>
<main>
  <h1>SATURN FEEDBACK</h1>
  <div class="who" id="who">Checking sign-in...</div>
  <div class="ctx" id="ctx"></div>
  <div class="rate">
    <button id="up" type="button">Helpful</button>
    <button id="down" type="button">Not helpful</button>
  </div>
  <textarea id="msg" placeholder="What was good or wrong about this review comment? (optional)"></textarea>
  <div><button class="submit" id="send">Submit feedback</button></div>
  <div id="result"></div>
</main>
<script>
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); };
  var params = new URLSearchParams(window.location.search);
  var prId = params.get('prId'); var commentId = params.get('commentId');
  var rating = 'none';
  var known = false;
  document.getElementById('ctx').textContent = prId ? ('Feedback on PR #' + prId + ', comment ' + (commentId || '?')) : 'General feedback';
  fetch('/api/whoami').then(function (r) { return r.json(); }).then(function (w) {
    known = !!w.known;
    if (known) {
      document.getElementById('who').innerHTML = 'Signed in as <b>' + esc(w.user) + '</b>';
    } else {
      document.getElementById('who').textContent = 'Submitting anonymously. Open the signed-in (hosted) dashboard for attributed feedback.';
    }
  }).catch(function () { document.getElementById('who').textContent = 'Submitting anonymously.'; });
  function selectRating(r) {
    rating = r;
    document.getElementById('up').className = r === 'up' ? 'sel' : '';
    document.getElementById('down').className = r === 'down' ? 'sel' : '';
  }
  document.getElementById('up').onclick = function () { selectRating('up'); };
  document.getElementById('down').onclick = function () { selectRating('down'); };
  document.getElementById('send').onclick = function () {
    var btn = document.getElementById('send'); btn.disabled = true;
    fetch('/api/feedback', { method:'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prId: prId ? Number(prId) : 0, commentId: commentId ? Number(commentId) : 0, rating: rating, message: document.getElementById('msg').value }) })
      .then(function (r) { if (!r.ok) { throw new Error('bad status'); } return r.json(); })
      .then(function () { document.getElementById('result').innerHTML = '<div class="ok">Thanks - your feedback was recorded.</div>'; })
      .catch(function () { btn.disabled = false; document.getElementById('result').innerHTML = '<div class="err">Could not submit. Please try again.</div>'; });
  };
</script>
</body>
</html>`;

const FEEDBACK_DISABLED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Saturn - Feedback</title>
<style>:root{color-scheme:dark}body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:#0b1020;color:#e6e9f0}main{max-width:640px;margin:48px auto;padding:0 24px}h1{font-size:20px;letter-spacing:2px}p{color:#8b93b5;line-height:1.5}a{color:#7aa2ff}</style>
</head><body><main>
  <h1>SATURN FEEDBACK</h1>
  <p>Feedback isn't available yet. It will be enabled once signed-in (authenticated) attribution is in place.</p>
  <p><a href="/">Back to the dashboard</a></p>
</main></body></html>`;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Resolve + cache the Chart.js UMD bundle to serve from /vendor/: next to the deployed bundle (deploySaturn
// copies it there from the `chart.js` npm package) or from node_modules when running from source. Mirrors
// config.ts's argv-based resolution so it works for the ESM source and the CJS deploy bundle alike.
// Undefined => the client falls back to inline-SVG charts.
let vendoredChartJs: string | undefined;
let vendoredChartJsResolved = false;
function readVendoredChartJs(): string | undefined {
  if (vendoredChartJsResolved) {
    return vendoredChartJs;
  }
  vendoredChartJsResolved = true;
  const candidatePaths: string[] = [];
  const entryScript = process.argv.at(1);
  // 1) Deployed: copied next to the bundle by deploySaturn.
  if (entryScript !== undefined) {
    candidatePaths.push(join(dirname(entryScript), 'chart.umd.min.js'));
  }
  // 2) Dev / source: the chart.js npm package. Walk up from the entry dir + cwd so a hoisted monorepo
  //    node_modules is found, and accept either the pre-minified UMD or the plain UMD (older chart.js
  //    versions don't ship chart.umd.min.js).
  const searchSeeds: string[] = [];
  if (entryScript !== undefined) {
    searchSeeds.push(dirname(entryScript));
  }
  searchSeeds.push(process.cwd());
  for (const seed of searchSeeds) {
    let dir = seed;
    for (let depth = 0; depth < 8; depth += 1) {
      candidatePaths.push(join(dir, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'));
      candidatePaths.push(join(dir, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  for (const candidatePath of candidatePaths) {
    try {
      if (existsSync(candidatePath)) {
        vendoredChartJs = readFileSync(candidatePath, 'utf8');
        return vendoredChartJs;
      }
    } catch {
      /* unreadable candidate - try the next */
    }
  }
  return undefined;
}

// Resolve + cache the mermaid UMD bundle to serve from /vendor/mermaid.min.js (self-hosted, no CDN): next to
// the deployed bundle (copied by deploySaturn) or from node_modules when running from source.
let vendoredMermaid: string | undefined;
let vendoredMermaidResolved = false;
function readVendoredMermaid(): string | undefined {
  if (vendoredMermaidResolved) {
    return vendoredMermaid;
  }
  vendoredMermaidResolved = true;
  const candidatePaths: string[] = [];
  const entryScript = process.argv.at(1);
  if (entryScript !== undefined) {
    candidatePaths.push(join(dirname(entryScript), 'mermaid.min.js'));
  }
  const searchSeeds: string[] = [];
  if (entryScript !== undefined) {
    searchSeeds.push(dirname(entryScript));
  }
  searchSeeds.push(process.cwd());
  for (const seed of searchSeeds) {
    let dir = seed;
    for (let depth = 0; depth < 8; depth += 1) {
      candidatePaths.push(join(dir, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'));
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  for (const candidatePath of candidatePaths) {
    try {
      if (existsSync(candidatePath)) {
        vendoredMermaid = readFileSync(candidatePath, 'utf8');
        return vendoredMermaid;
      }
    } catch {
      /* unreadable candidate - try the next */
    }
  }
  return undefined;
}

// A <script> tag that renders mermaid in a standalone/downloaded HTML doc: the bundle inlined (so diagrams
// render offline) or a CDN fallback if the bundle isn't vendored. Cached; a literal </script> in the bundle
// is neutralized so it can't close the inline script tag early.
let cachedInlineMermaid: string | undefined;
function inlineMermaidScript(): string {
  if (cachedInlineMermaid !== undefined) {
    return cachedInlineMermaid;
  }
  const bundle = readVendoredMermaid();
  cachedInlineMermaid =
    bundle === undefined
      ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>'
      : `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`;
  return cachedInlineMermaid;
}

// Slugify a title into a safe download filename (letters/digits/dashes, bounded).
function artifactFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? 'design' : slug;
}

// Generic self-hosted vendored-asset reader (react, react-dom, ...): the deployed copy next to the bundle, or
// from node_modules when running from source. Cached per deploy file name.
const vendoredAssetCache = new Map<string, string | undefined>();
function readVendoredAsset(deployFileName: string, relParts: readonly string[]): string | undefined {
  if (vendoredAssetCache.has(deployFileName)) {
    return vendoredAssetCache.get(deployFileName);
  }
  const candidatePaths: string[] = [];
  const entryScript = process.argv.at(1);
  if (entryScript !== undefined) {
    candidatePaths.push(join(dirname(entryScript), deployFileName));
  }
  const seeds: string[] = [];
  if (entryScript !== undefined) {
    seeds.push(dirname(entryScript));
  }
  seeds.push(process.cwd());
  for (const seed of seeds) {
    let dir = seed;
    for (let depth = 0; depth < 8; depth += 1) {
      candidatePaths.push(join(dir, 'node_modules', ...relParts));
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  for (const candidatePath of candidatePaths) {
    try {
      if (existsSync(candidatePath)) {
        const content = readFileSync(candidatePath, 'utf8');
        vendoredAssetCache.set(deployFileName, content);
        return content;
      }
    } catch {
      /* unreadable candidate - try the next */
    }
  }
  vendoredAssetCache.set(deployFileName, undefined);
  return undefined;
}

function sseDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface SaturnDoc {
  readonly id: string;
  readonly title: string;
  readonly html: string;
}

let resolvedDocs: readonly SaturnDoc[] | undefined;

/** Escape HTML so untrusted markdown text can't inject markup when rendered into the Documentation tab. */
function escapeDocHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render inline markdown (already HTML-escaped): code spans, bold, italics, and links. */
function renderDocInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, (_match, code: string) => '<code>' + code + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_match, label: string, url: string) => '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>'
    );
}

/** Split a GitHub-flavoured markdown table row into trimmed cells. */
function splitDocTableRow(row: string): readonly string[] {
  let trimmed = row.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split('|').map((cell) => cell.trim());
}

/** A small, dependency-free markdown -> HTML renderer good enough for Saturn's docs. */
function renderDocMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | undefined;
  const closeList = (): void => {
    if (listType !== undefined) {
      out.push('</' + listType + '>');
      listType = undefined;
    }
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      closeList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(escapeDocHtml(lines[index]));
        index += 1;
      }
      index += 1;
      out.push('<pre><code>' + code.join('\n') + '</code></pre>');
      continue;
    }
    const isTableHeader =
      /^\s*\|.*\|\s*$/.test(line) &&
      index + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]) &&
      lines[index + 1].includes('-');
    if (isTableHeader) {
      closeList();
      const headers = splitDocTableRow(line);
      index += 2;
      let table =
        '<table><thead><tr>' +
        headers.map((cell) => '<th>' + renderDocInline(escapeDocHtml(cell)) + '</th>').join('') +
        '</tr></thead><tbody>';
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        const cells = splitDocTableRow(lines[index]);
        table +=
          '<tr>' + cells.map((cell) => '<td>' + renderDocInline(escapeDocHtml(cell)) + '</td>').join('') + '</tr>';
        index += 1;
      }
      out.push(table + '</tbody></table>');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push('<h' + level + '>' + renderDocInline(escapeDocHtml(heading[2].trim())) + '</h' + level + '>');
      index += 1;
      continue;
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      closeList();
      out.push('<hr />');
      index += 1;
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push('<blockquote>' + renderDocInline(escapeDocHtml(quote[1])) + '</blockquote>');
      index += 1;
      continue;
    }
    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push('<li>' + renderDocInline(escapeDocHtml(unordered[1])) + '</li>');
      index += 1;
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push('<li>' + renderDocInline(escapeDocHtml(ordered[1])) + '</li>');
      index += 1;
      continue;
    }
    if (line.trim() === '') {
      closeList();
      index += 1;
      continue;
    }
    closeList();
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !lines[index].startsWith('```') &&
      !/^#{1,6}\s/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !/^\s*\|.*\|\s*$/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    out.push('<p>' + renderDocInline(escapeDocHtml(paragraph.join(' '))) + '</p>');
  }
  closeList();
  return out.join('\n');
}

/** Derive a human title from a doc's first markdown heading, falling back to a provided default. */
function docTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      return heading[1];
    }
  }
  return fallback;
}

/** Locate the directory holding Saturn's docs (next to the deployed bundle, or by walking up in dev). */
function findDocsRoot(): string | undefined {
  const seeds: string[] = [];
  const entryScript = process.argv.at(1);
  if (entryScript !== undefined) {
    seeds.push(dirname(entryScript));
  }
  seeds.push(process.cwd());
  for (const seed of seeds) {
    let dir = seed;
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(dir, 'docs')) || existsSync(join(dir, 'README.md'))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}

/** Read + render docs for the Documentation tab: overview first, then README, then the rest of docs/. */
function readSaturnDocs(): readonly SaturnDoc[] {
  if (resolvedDocs !== undefined) {
    return resolvedDocs;
  }
  const docs: SaturnDoc[] = [];
  const root = findDocsRoot();
  const readText = (path: string): string | undefined => {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  };
  if (root !== undefined) {
    const docsDir = join(root, 'docs');
    const overview = readText(join(docsDir, 'overview.md'));
    if (overview !== undefined) {
      docs.push({ id: 'overview', title: docTitle(overview, 'Overview'), html: renderDocMarkdown(overview) });
    }
    const readme = readText(join(root, 'README.md'));
    if (readme !== undefined) {
      docs.push({ id: 'readme', title: docTitle(readme, 'README'), html: renderDocMarkdown(readme) });
    }
    try {
      if (existsSync(docsDir)) {
        const files = readdirSync(docsDir)
          .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'overview.md')
          .sort();
        for (const file of files) {
          const text = readText(join(docsDir, file));
          if (text !== undefined) {
            docs.push({ id: file.replace(/\.md$/, ''), title: docTitle(text, file), html: renderDocMarkdown(text) });
          }
        }
      }
    } catch {
      /* docs dir unreadable - serve what we have */
    }
  }
  resolvedDocs = docs;
  return resolvedDocs;
}

const auditFindingIdSchema = z.object({ id: z.string() });
const auditCreateBugSchema = z.object({ id: z.string(), routeIndex: z.number().int().nonnegative().optional() });
const auditAutoCreateSchema = z.object({ enabled: z.boolean() });
const auditDismissSchema = z.object({ id: z.string(), reason: z.string(), alias: z.string() });

/** Safely extract a finding id from a parsed request body (empty string when absent/malformed). */
function idFromBody(parsed: unknown): string {
  const result = auditFindingIdSchema.safeParse(parsed);
  return result.success ? result.data.id : '';
}

/** Safely extract a create-bug request (finding id + optional chosen routeIndex) from a parsed body. */
function createBugRequestFromBody(parsed: unknown): { readonly id: string; readonly routeIndex?: number } {
  const result = auditCreateBugSchema.safeParse(parsed);
  return result.success ? { id: result.data.id, routeIndex: result.data.routeIndex } : { id: '' };
}

/** Safely extract a dismiss request (finding id + reason + dismisser alias), trimmed + length-bounded. */
function dismissRequestFromBody(parsed: unknown): {
  readonly id: string;
  readonly reason: string;
  readonly alias: string;
} {
  const result = auditDismissSchema.safeParse(parsed);
  if (!result.success) {
    return { id: '', reason: '', alias: '' };
  }
  return {
    id: result.data.id,
    reason: result.data.reason.trim().slice(0, 1000),
    alias: result.data.alias.trim().slice(0, 120)
  };
}

/** Safely extract the auto-create boolean from a parsed request body (false when absent/malformed). */
function enabledFromBody(parsed: unknown): boolean {
  const result = auditAutoCreateSchema.safeParse(parsed);
  return result.success && result.data.enabled;
}

/** Derive a package identifier (e.g. "packages/foo") from a repo-relative file path, for filtering. */
function packageOfPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? '';
}

interface AuditQuery {
  readonly status: string;
  readonly pkg: string;
  readonly path: string;
  readonly type: string;
  readonly sev: string;
}

function readAuditQuery(url: string): AuditQuery {
  const params = new URL(url, 'http://localhost').searchParams;
  return {
    status: params.get('status') ?? '',
    pkg: (params.get('pkg') ?? '').toLowerCase(),
    path: (params.get('path') ?? '').toLowerCase(),
    type: params.get('type') ?? '',
    sev: params.get('sev') ?? ''
  };
}

// Map the dashboard query params to the store's finding filter (type -> category, sev -> severity). The
// store does the filtering / pagination / aggregation in SQL, so the server never scans every finding.
function auditFilter(query: AuditQuery): AuditFindingFilter {
  return { status: query.status, category: query.type, severity: query.sev, pkg: query.pkg, path: query.path };
}

// Enrich a finding with its package + deep links (a line range when the issue spans a block) for the client.
function enrichAuditFinding(finding: AuditFinding) {
  return {
    ...finding,
    package: packageOfPath(finding.filePath),
    sourceUrl: buildSourceFileUrl(finding.filePath, finding.line, finding.endLine),
    relatedLocations: (finding.relatedLocations ?? []).map((location) => ({
      ...location,
      sourceUrl: buildSourceFileUrl(location.filePath, location.line, location.endLine)
    }))
  };
}

async function handleRequest(service: SaturnService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];
  const method = req.method ?? 'GET';

  // --- Setup / installer: available before Saturn is configured, and for reconfiguring later at /setup. ---
  if (method === 'GET' && pathname === '/api/setup/state') {
    sendJson(res, 200, {
      configured: isSaturnConfigured(),
      providers: listProviders(),
      config: {
        repoUrl: process.env.SATURN_REPO_URL ?? '',
        defaultBranch: process.env.SATURN_ADO_DEFAULT_BRANCH ?? 'main',
        provider: process.env.SATURN_PROVIDER ?? 'copilot',
        model: process.env.SATURN_MODEL ?? '',
        effort: process.env.SATURN_REASONING_EFFORT ?? '',
        contextSize: process.env.SATURN_CONTEXT_SIZE ?? ''
      }
    });
    return;
  }
  if (method === 'GET' && pathname === '/api/setup/models') {
    const provider = new URL(url, 'http://localhost').searchParams.get('provider') ?? 'copilot';
    sendJson(res, 200, listModels(provider));
    return;
  }
  if (method === 'GET' && pathname === '/api/setup/capabilities') {
    const params = new URL(url, 'http://localhost').searchParams;
    sendJson(res, 200, modelCapabilities(params.get('provider') ?? 'copilot', params.get('model') ?? ''));
    return;
  }
  if (method === 'POST' && pathname === '/api/setup/save') {
    const raw = await readRequestBody(req);
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (isRecord(parsed)) {
        body = parsed;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    const repoUrl = typeof body['repoUrl'] === 'string' ? body['repoUrl'].trim() : '';
    if (repoUrl === '' || parseRepoUrl(repoUrl) === undefined) {
      sendJson(res, 400, {
        ok: false,
        error: 'Enter a valid Azure DevOps repo URL, e.g. https://dev.azure.com/org/project/_git/repo'
      });
      return;
    }
    const provider =
      typeof body['provider'] === 'string' && isKnownProvider(body['provider']) ? body['provider'] : 'copilot';
    const models = listModels(provider);
    const model =
      typeof body['model'] === 'string' && body['model'].trim() !== '' ? body['model'].trim() : models.defaultModel;
    const caps = modelCapabilities(provider, model);
    const effort =
      typeof body['effort'] === 'string' && caps.effortLevels.includes(body['effort'])
        ? body['effort']
        : caps.defaultEffort;
    const defaultBranch =
      typeof body['defaultBranch'] === 'string' && body['defaultBranch'].trim() !== ''
        ? body['defaultBranch'].trim()
        : 'main';
    const contextSize = typeof body['contextSize'] === 'string' ? body['contextSize'].trim() : '';
    try {
      writeSaturnConfig({
        SATURN_REPO_URL: repoUrl,
        SATURN_ADO_DEFAULT_BRANCH: defaultBranch,
        SATURN_PROVIDER: provider,
        SATURN_MODEL: model,
        SATURN_REASONING_EFFORT: effort,
        SATURN_CONTEXT_SIZE: contextSize
      });
    } catch {
      sendJson(res, 500, { ok: false, error: 'Could not save the configuration file.' });
      return;
    }
    sendJson(res, 200, { ok: true, restarting: true });
    scheduleRestart();
    return;
  }
  if (pathname === '/setup') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SETUP_HTML);
    return;
  }
  if (!isSaturnConfigured()) {
    // Setup mode: serve the installer for page loads; refuse non-setup APIs until a repo is configured.
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SETUP_HTML);
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 503, { error: 'Saturn is not configured yet. Open the dashboard to run setup.' });
      return;
    }
  }

  if (method === 'POST' && pathname === '/api/hooks/ado') {
    // Azure DevOps service-hook receiver: validates a shared secret (constant-time), then signals Code
    // Autopilot to run an iteration immediately so it reacts to a build failure / new comment without waiting
    // for the next poll. The payload is only a wake trigger - nothing in it is trusted or acted on.
    const secret = webhookSecret();
    if (secret.length === 0) {
      sendJson(res, 503, { error: 'webhook disabled: set SATURN_WEBHOOK_SECRET to enable' });
      return;
    }
    const headerSecret = req.headers['x-saturn-secret'];
    const querySecret = new URL(url, 'http://localhost').searchParams.get('secret');
    const provided = typeof headerSecret === 'string' ? headerSecret : (querySecret ?? '');
    if (!secretsMatch(provided, secret)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    signalFixWake();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && url === '/api/start') {
    if (!isOwner(req)) {
      sendJson(res, 403, { error: 'forbidden: start/stop is restricted to the Saturn owner' });
      return;
    }
    sendJson(res, 200, service.start());
    return;
  }
  if (method === 'POST' && url === '/api/stop') {
    if (!isOwner(req)) {
      sendJson(res, 403, { error: 'forbidden: start/stop is restricted to the Saturn owner' });
      return;
    }
    sendJson(res, 200, service.stop());
    return;
  }
  if (method === 'POST' && url === '/api/audit/start') {
    if (!isOwner(req)) {
      sendJson(res, 403, { error: 'forbidden: audit start/stop is restricted to the Saturn owner' });
      return;
    }
    sendJson(res, 200, service.startAudit());
    return;
  }
  if (method === 'POST' && url === '/api/audit/stop') {
    if (!isOwner(req)) {
      sendJson(res, 403, { error: 'forbidden: audit start/stop is restricted to the Saturn owner' });
      return;
    }
    sendJson(res, 200, service.stopAudit());
    return;
  }
  if (method === 'GET' && url === '/api/audit/state') {
    sendJson(res, 200, service.getAuditState());
    return;
  }
  if (method === 'GET' && url.startsWith('/api/audit/findings')) {
    // A server-side (SQL) filtered + paginated page of findings, so the client never holds the full set.
    // Each finding is enriched with its package + deep links. Read-only; mutating actions are gated.
    const params = new URL(url, 'http://localhost').searchParams;
    const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(params.get('cursor') ?? '0', 10) || 0, 0);
    const { findings, total } = service.getAuditFindingsPage(auditFilter(readAuditQuery(url)), limit, offset);
    const nextCursor = offset + limit < total ? String(offset + limit) : null;
    sendJson(res, 200, { findings: findings.map(enrichAuditFinding), total, nextCursor });
    return;
  }
  if (method === 'GET' && url.startsWith('/api/audit/summary')) {
    // Server-computed (SQL) aggregates for the overview charts, so the client doesn't fetch every finding.
    sendJson(res, 200, service.getAuditSummary(auditFilter(readAuditQuery(url))));
    return;
  }
  if (method === 'GET' && url === '/api/fix/scope') {
    // The package / path scope Code Autopilot is limited to (read-only so any viewer can see it).
    sendJson(res, 200, { paths: getFixScopePaths() });
    return;
  }
  if (method === 'POST' && url === '/api/fix/scope') {
    // Changing what the agent works on is owner-only (tunnel viewers can read it but not set it).
    if (!isOwner(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden: the Code Autopilot scope is owner-only' });
      return;
    }
    const raw = await readRequestBody(req);
    let paths: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      const rawPaths = isRecord(parsed) ? parsed['paths'] : undefined;
      if (Array.isArray(rawPaths)) {
        paths = rawPaths.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    sendJson(res, 200, { ok: true, paths: setFixScopePaths(paths) });
    return;
  }
  if (method === 'GET' && url === '/api/fix/packages') {
    // Repo packages that currently have findings - the source for the Code Autopilot scope package picker.
    sendJson(res, 200, { packages: service.getAuditSummary({ status: 'open' }).packages });
    return;
  }
  if (method === 'GET' && url.startsWith('/api/fix/tasks')) {
    // Read-only list of Code Autopilot's PRs (Code Autopilot writes fix.db from its own standalone process).
    const params = new URL(url, 'http://localhost').searchParams;
    const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '100', 10) || 100, 1), 500);
    const offset = Math.max(Number.parseInt(params.get('cursor') ?? '0', 10) || 0, 0);
    const page = listFixTasks(limit, offset);
    const nextCursor = offset + limit < page.total ? String(offset + limit) : null;
    sendJson(res, 200, { tasks: page.tasks, total: page.total, counts: fixTaskStatusCounts(), nextCursor });
    return;
  }
  if (method === 'GET' && url.startsWith('/api/audit/sarif')) {
    // SARIF 2.1.0 export of the codebase-audit findings for code-scanning ingestion.
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="saturn-audit.sarif"'
    });
    res.end(JSON.stringify(buildAuditSarifLog()));
    return;
  }
  if (method === 'GET' && url.startsWith('/api/audit/routes')) {
    // Candidate owning-team routes for a finding - read-only, needed so any viewer can file a bug.
    const parsed = new URL(url, 'http://localhost');
    const id = parsed.searchParams.get('id') ?? '';
    sendJson(res, 200, { routes: service.getBugRoutes(id) });
    return;
  }
  if (method === 'GET' && url === '/api/audit/area-owners') {
    // Curated area-owner mapping + auto-derived suggestions, read-only so any viewer can open the editor.
    sendJson(res, 200, service.getAreaOwners());
    return;
  }
  if (method === 'POST' && url === '/api/audit/area-owners') {
    // Editing area owners is open to every viewer (devtunnel users included), like filing a bug; the entries
    // are sanitized + bounded server-side. Start/stop + dismiss stay owner-only.
    const raw = await readRequestBody(req);
    let entries: ReturnType<typeof areaOwnerEntriesFromBody> = [];
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      entries = areaOwnerEntriesFromBody(parsed);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    sendJson(res, 200, { ok: true, ...service.saveAreaOwners(entries) });
    return;
  }
  if (method === 'POST' && url === '/api/audit/create-bug') {
    // Filing a bug is allowed for any viewer (a useful, attributable action); start/stop + dismiss are not.
    const raw = await readRequestBody(req);
    let request: { readonly id: string; readonly routeIndex?: number } = { id: '' };
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      request = createBugRequestFromBody(parsed);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    if (request.id === '') {
      sendJson(res, 400, { ok: false, error: 'missing finding id' });
      return;
    }
    try {
      const finding = await service.createBugForFinding(
        request.id,
        request.routeIndex,
        resolveTrustedIdentity(req) ?? 'a reviewer'
      );
      sendJson(res, 200, { ok: true, finding });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bug creation failed' });
    }
    return;
  }
  if (method === 'POST' && url === '/api/audit/dismiss') {
    // Dismissing is open to any viewer (like filing a bug), but must be attributed: the dismisser supplies a
    // reason + an alias (a stand-in until auth identifies the user) so the dismissed view shows who and why.
    const raw = await readRequestBody(req);
    let request = { id: '', reason: '', alias: '' };
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      request = dismissRequestFromBody(parsed);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    if (request.id === '') {
      sendJson(res, 400, { ok: false, error: 'missing finding id' });
      return;
    }
    if (request.reason === '' || request.alias === '') {
      sendJson(res, 400, { ok: false, error: 'a dismiss reason and your alias are required' });
      return;
    }
    const finding = service.dismissFinding(request.id, request.reason, request.alias);
    sendJson(res, finding === undefined ? 404 : 200, { ok: finding !== undefined, finding });
    return;
  }
  if (method === 'POST' && url === '/api/audit/recover') {
    // Recovery is open to any viewer too, so a finding dismissed in error can be brought back (it is the
    // inverse of the open dismiss action; start/stop + the auto-create switch stay owner-only).
    const raw = await readRequestBody(req);
    let id = '';
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      id = idFromBody(parsed);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    const finding = service.recoverFinding(id);
    sendJson(res, finding === undefined ? 404 : 200, { ok: finding !== undefined, finding });
    return;
  }
  if (method === 'POST' && url === '/api/audit/auto-create') {
    if (!isOwner(req)) {
      sendJson(res, 403, { error: 'forbidden: the auto-create switch is restricted to the Saturn owner' });
      return;
    }
    const raw = await readRequestBody(req);
    let enabled = false;
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      enabled = enabledFromBody(parsed);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    sendJson(res, 200, service.setAuditAutoCreate(enabled));
    return;
  }
  if (method === 'GET' && url === '/api/state') {
    sendJson(res, 200, service.getState());
    return;
  }
  if (method === 'GET' && url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(service.getState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }
  if (method === 'GET' && url.startsWith('/api/pr-threads')) {
    const parsed = new URL(url, 'http://localhost');
    const prId = Number.parseInt(parsed.searchParams.get('prId') ?? '', 10);
    if (Number.isNaN(prId)) {
      sendJson(res, 400, { error: 'invalid prId' });
      return;
    }
    sendJson(res, 200, { threads: await service.getThreadStatuses(prId) });
    return;
  }
  if (method === 'GET' && url === '/api/stats') {
    sendJson(res, 200, service.getReviewStats());
    return;
  }
  if (method === 'GET' && url === '/api/dashboard') {
    // One-call bundle for the leadership Dashboard tab: PR-review stats + audit aggregates + sweep state.
    // Served from a short-lived cache so concurrent viewers polling on the same tick share one recompute.
    sendJson(res, 200, getCachedDashboardData(service));
    return;
  }
  if (method === 'GET' && url === '/api/model') {
    // Active model + fallback state for the in-process review + audit agents (the standalone Code Autopilot
    // process tracks its own state). Drives the dashboard header badge.
    sendJson(res, 200, { ...getModelStatus(), reasoningEffort: defaultReasoningEffort() });
    return;
  }
  if (method === 'GET' && url === '/api/review/allowlist') {
    // The reviewer allowlist (read-only so any viewer can see who is in scope).
    sendJson(res, 200, { entries: getReviewAllowlist() });
    return;
  }
  if (method === 'POST' && url === '/api/review/allowlist') {
    // Changing who Saturn reviews is owner-only (tunnel viewers can read it but not set it).
    if (!isOwner(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden: the review allowlist is owner-only' });
      return;
    }
    const raw = await readRequestBody(req);
    let entries: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      const rawEntries = isRecord(parsed) ? parsed['entries'] : undefined;
      if (Array.isArray(rawEntries)) {
        entries = rawEntries.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid payload' });
      return;
    }
    sendJson(res, 200, { ok: true, entries: setReviewAllowlist(entries) });
    return;
  }
  if (method === 'GET' && url.startsWith('/api/sarif')) {
    // SARIF 2.1.0 export so a platform can surface Saturn's findings in its code-scanning / security tab.
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="saturn.sarif"'
    });
    res.end(JSON.stringify(buildSarifLog()));
    return;
  }
  if (method === 'GET' && url.startsWith('/api/reviews')) {
    const parsed = new URL(url, 'http://localhost');
    const cursor = parsed.searchParams.get('cursor') ?? undefined;
    const limit = Number.parseInt(parsed.searchParams.get('limit') ?? '12', 10);
    const fromRaw = Number.parseInt(parsed.searchParams.get('from') ?? '', 10);
    const toRaw = Number.parseInt(parsed.searchParams.get('to') ?? '', 10);
    const filters = {
      status: parsed.searchParams.get('status') ?? undefined,
      category: parsed.searchParams.get('category') ?? undefined,
      author: parsed.searchParams.get('author') ?? undefined,
      search: parsed.searchParams.get('search') ?? undefined,
      fromMs: Number.isNaN(fromRaw) ? undefined : fromRaw,
      toMs: Number.isNaN(toRaw) ? undefined : toRaw
    };
    const page = service.getReviewsCursor(cursor, Number.isNaN(limit) ? 12 : limit, filters);
    // Dropped findings are unverified and may quote code - owner-only. Strip them for non-owner viewers.
    if (isOwner(req)) {
      sendJson(res, 200, page);
    } else {
      sendJson(res, 200, {
        ...page,
        items: page.items.map((review) => ({
          ...review,
          iterations: review.iterations.map((iteration) => ({ ...iteration, droppedFindings: undefined }))
        }))
      });
    }
    return;
  }
  if (method === 'GET' && url === '/api/whoami') {
    const identity = resolveTrustedIdentity(req);
    sendJson(res, 200, { user: identity ?? '', known: identity !== undefined, isOwner: isOwner(req) });
    return;
  }
  if (method === 'GET' && url.startsWith('/api/feedback')) {
    const feedback = readAllFeedback().map((entry) => ({
      ...entry,
      prUrl: buildPullRequestWebUrl(entry.pullRequestId),
      commentDeepLink: buildCommentDeepLink(entry.pullRequestId, entry.commentId)
    }));
    sendJson(res, 200, { feedback });
    return;
  }
  if (method === 'POST' && url === '/api/feedback') {
    if (!isFeedbackEnabled()) {
      sendJson(res, 403, { ok: false, error: 'feedback is currently disabled' });
      return;
    }
    const raw = await readRequestBody(req);
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      const body = feedbackSubmissionSchema.parse(parsed);
      // Identity is server-determined only: a trusted auth-proxy/owner identity, else 'anonymous'. We never
      // accept a client-supplied name (that would let anyone submit feedback as someone else).
      const submittedBy = resolveTrustedIdentity(req) ?? 'anonymous';
      const stored = recordFeedback({
        pullRequestId: body.prId,
        commentId: body.commentId,
        submittedBy,
        rating: body.rating,
        message: body.message
      });
      sendJson(res, 200, { ok: true, id: stored.id });
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid feedback payload' });
    }
    return;
  }
  if (method === 'GET' && pathname === '/feedback') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(isFeedbackEnabled() ? FEEDBACK_HTML : FEEDBACK_DISABLED_HTML);
    return;
  }
  if (method === 'GET' && pathname === '/vendor/chart.umd.min.js') {
    // Self-hosted Chart.js (no external CDN). Falls back to a 404 -> the client renders inline-SVG charts.
    const chartJs = readVendoredChartJs();
    if (chartJs === undefined) {
      sendJson(res, 404, { error: 'chart.js not vendored; dashboard uses the inline-SVG fallback' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(chartJs);
    return;
  }
  if (method === 'GET' && pathname === '/vendor/mermaid.min.js') {
    // Self-hosted mermaid.js (no external CDN) for the Chat tab's design-doc diagrams.
    const mermaidJs = readVendoredMermaid();
    if (mermaidJs === undefined) {
      sendJson(res, 404, { error: 'mermaid not vendored' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(mermaidJs);
    return;
  }
  if (method === 'GET' && pathname === '/vendor/react.min.js') {
    const js = readVendoredAsset('react.min.js', ['react', 'umd', 'react.production.min.js']);
    if (js === undefined) {
      sendJson(res, 404, { error: 'react not vendored' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(js);
    return;
  }
  if (method === 'GET' && pathname === '/vendor/react-dom.min.js') {
    const js = readVendoredAsset('react-dom.min.js', ['react-dom', 'umd', 'react-dom.production.min.js']);
    if (js === undefined) {
      sendJson(res, 404, { error: 'react-dom not vendored' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(js);
    return;
  }
  if (method === 'GET' && pathname === '/api/chat/conversations') {
    // Chat is available to ALL viewers (no owner gate); the requester identity is recorded when known.
    sendJson(res, 200, { conversations: listConversations() });
    return;
  }
  if (method === 'POST' && pathname === '/api/chat/conversations') {
    if (!isOwner(req)) { sendJson(res, 403, { error: 'forbidden: Builder Autopilot is read-only for viewers' }); return; }
    const raw = await readRequestBody(req);
    let mode: 'design' | 'spec' = 'design';
    let title = '';
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (isRecord(parsed)) {
        if (parsed['mode'] === 'spec') {
          mode = 'spec';
        }
        if (typeof parsed['title'] === 'string') {
          title = parsed['title'];
        }
      }
    } catch {
      sendJson(res, 400, { error: 'invalid payload' });
      return;
    }
    const requester = resolveTrustedIdentity(req) ?? 'anonymous';
    const conversation = createConversation({ title: title === '' ? 'New chat' : title, mode, requester });
    sendJson(res, 200, { conversation });
    return;
  }
  if (method === 'GET' && pathname === '/api/chat/conversation') {
    const id = new URL(url, 'http://localhost').searchParams.get('id') ?? '';
    const conversation = getConversation(id);
    if (conversation === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const artifact = latestArtifact(id);
    // Assistant messages carry a server-rendered, XSS-safe HTML rendering so the client shows formatted text.
    const messages = listMessages(id).map((m) =>
      m.role === 'assistant' ? { ...m, contentHtml: renderMarkdownToSafeHtml(m.content) } : m
    );
    sendJson(res, 200, { conversation, messages, ...(artifact !== undefined ? { artifact } : {}) });
    return;
  }
  if (method === 'POST' && pathname === '/api/chat/message') {
    if (!isOwner(req)) { sendJson(res, 403, { error: 'forbidden: Builder Autopilot is read-only for viewers' }); return; }
    const raw = await readRequestBody(req);
    let conversationId = '';
    let message = '';
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (isRecord(parsed)) {
        conversationId = typeof parsed['conversationId'] === 'string' ? parsed['conversationId'] : '';
        message = typeof parsed['message'] === 'string' ? parsed['message'] : '';
      }
    } catch {
      sendJson(res, 400, { error: 'invalid payload' });
      return;
    }
    if (conversationId === '' || message.trim() === '') {
      sendJson(res, 400, { error: 'conversationId and message are required' });
      return;
    }
    const result = await handleChatTurn(conversationId, message.slice(0, 1_000_000));
    if (result === undefined) {
      sendJson(res, 404, { error: 'conversation not found' });
      return;
    }
    sendJson(res, 200, result);
    return;
  }
  if (method === 'POST' && pathname === '/api/chat/stream') {
    if (!isOwner(req)) { sendJson(res, 403, { error: 'forbidden: Builder Autopilot is read-only for viewers' }); return; }
    // Server-Sent-Events streaming of a chat turn: live status while the model researches, then the reply
    // text streamed in paced chunks, then a 'done' event carrying the (optional) design-doc artifact.
    const raw = await readRequestBody(req);
    let conversationId = '';
    let message = '';
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (isRecord(parsed)) {
        conversationId = typeof parsed['conversationId'] === 'string' ? parsed['conversationId'] : '';
        message = typeof parsed['message'] === 'string' ? parsed['message'] : '';
      }
    } catch {
      sendJson(res, 400, { error: 'invalid payload' });
      return;
    }
    if (conversationId === '' || message.trim() === '') {
      sendJson(res, 400, { error: 'conversationId and message are required' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    const send = (event: string, data: unknown): void => {
      if (!closed && !res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    // Title: when the conversation has no real title yet, show an instant provisional title (first few words),
    // persist it, then kick off a dedicated quick LLM call for a better one. Turns on an already-titled
    // conversation never change the title.
    const startConv = getConversation(conversationId);
    if (startConv !== undefined && (startConv.title === 'New chat' || startConv.title.trim() === '')) {
      const provisional = message.trim().split(/\s+/).slice(0, 7).join(' ').slice(0, 60);
      if (provisional !== '') {
        updateConversation(conversationId, { title: provisional });
        send('title', { title: provisional });
        generateTitleAsync(conversationId, message, provisional, (title) => {
          send('title', { title });
        });
      }
    }
    send('status', { text: 'Researching the codebase' });
    // The design agent runs the CLI with --output-format json --stream on, producing a JSONL event stream.
    // Reasoning + tool + MCP events become live chain-of-thought ('cot'); assistant message deltas become the
    // streamed reply ('delta'). Narration emitted before a tool call is moved to CoT and the reply is reset, so
    // only the model's final message is shown as the answer - mirroring VS Code Copilot's activity-then-answer.
    let jsonBuf = '';
    let reasoningLine = '';
    let replyAccum = '';
    let emittedReplyLen = 0;
    let metaSeen = false;
    let streamedReply = false;
    let lastActivity = Date.now();
    const seenMcp = new Set<string>();
    const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
    const cot = (text: string): void => {
      const t = text.trim();
      if (t !== '') {
        send('cot', { text: t.slice(0, 400) });
        lastActivity = Date.now();
      }
    };
    const flushReasoning = (): void => {
      if (reasoningLine.trim() !== '') {
        cot(reasoningLine);
      }
      reasoningLine = '';
    };
    // Emit reply text preceding [[META]] as 'delta'. Until the stream ends we hold back a short tail so a
    // partially-arrived "[[META]]" marker is never shown to the user.
    const pumpReply = (isFinal: boolean): void => {
      if (metaSeen) {
        return;
      }
      const metaIdx = replyAccum.indexOf('[[META]]');
      let upTo = metaIdx >= 0 ? metaIdx : replyAccum.length;
      if (metaIdx >= 0) {
        metaSeen = true;
      } else if (!isFinal) {
        upTo = Math.max(emittedReplyLen, replyAccum.length - 8);
      }
      if (upTo > emittedReplyLen) {
        const chunk = replyAccum.slice(emittedReplyLen, upTo);
        emittedReplyLen = upTo;
        if (chunk !== '') {
          send('delta', { text: chunk });
          streamedReply = true;
          lastActivity = Date.now();
        }
      }
    };
    const friendlyTool = (name: string, args: unknown): string => {
      const n = name.toLowerCase();
      const a = isRecord(args) ? args : {};
      const rawPath = asStr(a['path']) || asStr(a['filePath']) || asStr(a['file']) || asStr(a['query']);
      const norm = rawPath.split('\\').join('/');
      const base = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm;
      if (n.includes('view') || n.includes('read') || n.includes('cat')) { return base !== '' ? `Reading ${base}` : 'Reading files'; }
      if (n.includes('grep') || n.includes('search') || n.includes('find')) { return 'Searching the codebase'; }
      if (n.includes('list') || n.includes('dir') || n.includes('glob')) { return base !== '' ? `Listing ${base}` : 'Listing files'; }
      if (n.includes('bash') || n.includes('run') || n.includes('terminal') || n.includes('shell')) { return 'Running a command'; }
      if (n.includes('edit') || n.includes('write') || n.includes('create') || n.includes('replace')) { return base !== '' ? `Editing ${base}` : 'Editing files'; }
      if (n.includes('fetch') || n.includes('web')) { return 'Fetching a web page'; }
      return `Using ${name !== '' ? name : 'a tool'}`;
    };
    const handleEventLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed[0] !== '{') {
        return;
      }
      let evt: unknown;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!isRecord(evt)) {
        return;
      }
      const type = asStr(evt['type']);
      const data = isRecord(evt['data']) ? evt['data'] : {};
      if (type === 'session.mcp_server_status_changed') {
        const server = asStr(data['serverName']);
        if (server !== '' && asStr(data['status']) === 'connected' && !seenMcp.has(server)) {
          seenMcp.add(server);
          cot(`Connected to ${server}`);
        }
        return;
      }
      if (type === 'assistant.reasoning_delta') {
        reasoningLine += asStr(data['deltaContent']);
        let nlAt = reasoningLine.indexOf('\n');
        while (nlAt >= 0) {
          cot(reasoningLine.slice(0, nlAt));
          reasoningLine = reasoningLine.slice(nlAt + 1);
          nlAt = reasoningLine.indexOf('\n');
        }
        if (reasoningLine.length > 180) {
          const cut = reasoningLine.lastIndexOf(' ', 180);
          const at = cut > 40 ? cut : 180;
          cot(reasoningLine.slice(0, at));
          reasoningLine = reasoningLine.slice(at);
        }
        return;
      }
      if (type === 'assistant.reasoning') {
        flushReasoning();
        return;
      }
      if (type === 'tool.execution_start') {
        flushReasoning();
        if (replyAccum.trim() !== '') {
          const cutAt = replyAccum.indexOf('[[META]]');
          cot(replyAccum.slice(0, cutAt < 0 ? replyAccum.length : cutAt));
        }
        if (streamedReply || emittedReplyLen > 0) {
          send('reset', {});
        }
        replyAccum = '';
        emittedReplyLen = 0;
        metaSeen = false;
        streamedReply = false;
        cot(friendlyTool(asStr(data['toolName']), data['arguments']));
        return;
      }
      if (type === 'assistant.message_delta') {
        flushReasoning();
        replyAccum += asStr(data['deltaContent']);
        pumpReply(false);
        return;
      }
    };
    const onProgress = (chunk: string): void => {
      if (closed) {
        return;
      }
      jsonBuf += chunk;
      let nl = jsonBuf.indexOf('\n');
      while (nl >= 0) {
        handleEventLine(jsonBuf.slice(0, nl));
        jsonBuf = jsonBuf.slice(nl + 1);
        nl = jsonBuf.indexOf('\n');
      }
    };
    // Fallback status while the model researches silently (no output yet), so the panel is never blank.
    const labels = ['Reading the repository', 'Assessing feasibility', 'Weighing options', 'Drafting the response'];
    let labelIndex = 0;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity > 4000) {
        send('status', { text: labels[labelIndex % labels.length] });
        labelIndex += 1;
      }
    }, 3500);
    let result: Awaited<ReturnType<typeof handleChatTurn>>;
    try {
      result = await handleChatTurn(conversationId, message.slice(0, 1_000_000), onProgress, (items) => { send('plan', { items }); });
    } catch {
      clearInterval(heartbeat);
      send('error', { text: 'The agent failed to respond. Please try again.' });
      res.end();
      return;
    }
    clearInterval(heartbeat);
    if (result === undefined) {
      send('error', { text: 'Conversation not found.' });
      res.end();
      return;
    }
    // Process any leftover buffered event line, then flush remaining reasoning + the reply tail.
    if (jsonBuf.trim() !== '') {
      handleEventLine(jsonBuf);
      jsonBuf = '';
    }
    flushReasoning();
    pumpReply(true);
    // Fallback: if the model didn't use the sectioned format, stream the parsed reply now in paced chunks.
    if (!streamedReply) {
      const assistantMessage = [...result.messages].reverse().find((m) => m.role === 'assistant');
      const reply = assistantMessage !== undefined ? assistantMessage.content : '';
      const tokens = reply.match(/\S+\s*/g) ?? (reply === '' ? [] : [reply]);
      let buffer = '';
      for (let i = 0; i < tokens.length && !closed; i += 1) {
        buffer += tokens[i];
        if (buffer.length >= 14 || i === tokens.length - 1) {
          send('delta', { text: buffer });
          buffer = '';
          await sseDelay(22);
        }
      }
    }
    send('done', {
      conversationId,
      title: result.conversation.title,
      ...(result.artifact !== undefined ? { artifact: result.artifact } : {})
    });
    res.end();
    return;
  }
  if (method === 'POST' && pathname === '/api/chat/rename') {
    if (!isOwner(req)) { sendJson(res, 403, { error: 'forbidden: Builder Autopilot is read-only for viewers' }); return; }
    const raw = await readRequestBody(req);
    let id = '';
    let title = '';
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (isRecord(parsed)) {
        id = typeof parsed['id'] === 'string' ? parsed['id'] : '';
        title = typeof parsed['title'] === 'string' ? parsed['title'] : '';
      }
    } catch {
      sendJson(res, 400, { error: 'invalid payload' });
      return;
    }
    const conversation = updateConversation(id, { title });
    sendJson(res, conversation === undefined ? 404 : 200, { ok: conversation !== undefined, conversation });
    return;
  }
  if (method === 'POST' && pathname === '/api/chat/delete') {
    if (!isOwner(req)) { sendJson(res, 403, { error: 'forbidden: Builder Autopilot is read-only for viewers' }); return; }
    const raw = await readRequestBody(req);
    let id = '';
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (isRecord(parsed) && typeof parsed['id'] === 'string') {
        id = parsed['id'];
      }
    } catch {
      sendJson(res, 400, { error: 'invalid payload' });
      return;
    }
    const conversation = updateConversation(id, { status: 'archived' });
    sendJson(res, conversation === undefined ? 404 : 200, { ok: conversation !== undefined });
    return;
  }
  if (method === 'GET' && pathname === '/api/chat/artifact') {
    const params = new URL(url, 'http://localhost').searchParams;
    const artifact = getArtifact(params.get('id') ?? '');
    if (artifact === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const format = params.get('format') ?? 'fragment';
    const download = params.get('download') === '1';
    const fileName = artifactFileName(artifact.title);
    if (format === 'md') {
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        ...(download ? { 'Content-Disposition': `attachment; filename="${fileName}.md"` } : {})
      });
      res.end(artifact.markdown + '\n\n---\n\n_Created by Saturn_\n');
      return;
    }
    if (format === 'fragment') {
      // Safe HTML fragment for the in-dashboard preview pane (diagrams rendered by the page's mermaid).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderMarkdownToSafeHtml(artifact.markdown) + '<footer style="margin-top:32px;padding-top:12px;border-top:1px solid var(--line,#232a44);color:var(--muted,#8b93b5);font-size:12px;text-align:center;">Created by Saturn</footer>');
      return;
    }
    const mermaidScript = download ? inlineMermaidScript() : '<script src="/vendor/mermaid.min.js"></script>';
    const body = `<h1>${escapeHtml(artifact.title)}</h1>\n${renderMarkdownToSafeHtml(artifact.markdown)}`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      ...(download ? { 'Content-Disposition': `attachment; filename="${fileName}.html"` } : {})
    });
    res.end(buildHtmlDocument(artifact.title, body, mermaidScript));
    return;
  }
  if (method === 'GET' && pathname === '/api/chat/transcript') {
    const params = new URL(url, 'http://localhost').searchParams;
    const id = params.get('id') ?? '';
    const conversation = getConversation(id);
    if (conversation === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${artifactFileName(conversation.title)}-transcript.html"`
    });
    res.end(buildTranscriptDocument(conversation.title, listMessages(id), inlineMermaidScript()));
    return;
  }
  if (method === 'POST' && pathname === '/api/chat/approve') {
    if (!isOwner(req)) { sendJson(res, 403, { error: 'forbidden: Builder Autopilot is read-only for viewers' }); return; }
    const raw = await readRequestBody(req);
    let conversationId = '';
    let artifactId = '';
    let selectedOption: string | undefined;
    let proceedWithBest = false;
    try {
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
      if (isRecord(parsed)) {
        conversationId = typeof parsed['conversationId'] === 'string' ? parsed['conversationId'] : '';
        artifactId = typeof parsed['artifactId'] === 'string' ? parsed['artifactId'] : '';
        if (typeof parsed['selectedOption'] === 'string') {
          selectedOption = parsed['selectedOption'];
        }
        proceedWithBest = parsed['proceedWithBest'] === true;
      }
    } catch {
      sendJson(res, 400, { error: 'invalid payload' });
      return;
    }
    if (conversationId === '' || artifactId === '') {
      sendJson(res, 400, { error: 'conversationId and artifactId are required' });
      return;
    }
    const requester = resolveTrustedIdentity(req) ?? 'anonymous';
    const result = await approveAndBuild(conversationId, artifactId, {
      ...(selectedOption !== undefined ? { selectedOption } : {}),
      proceedWithBest,
      requester
    });
    sendJson(res, 200, result);
    return;
  }
  if (method === 'GET' && pathname === '/api/chat/builds') {
    // Feature builds (design -> PR) surfaced on the Code Autopilot tab, read-only for all viewers.
    sendJson(res, 200, { builds: listFeatureBuilds() });
    return;
  }
  if (method === 'GET' && pathname === '/api/docs') {
    sendJson(res, 200, { docs: readSaturnDocs() });
    return;
  }
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// Re-launch the dashboard so freshly-saved configuration (the repo coordinates are read once at startup) takes
// effect. Spawns a detached copy of this process and exits; the new process retries the port until released.
function scheduleRestart(): void {
  setTimeout(() => {
    try {
      const script = process.argv[1];
      if (script !== undefined) {
        const child = spawn(process.execPath, [script], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
          windowsHide: true
        });
        child.unref();
      }
    } catch {
      /* best-effort restart */
    }
    process.exit(0);
  }, 600);
}

// The first-run / reconfigure installer page (served at '/' when unconfigured, and always at '/setup').
const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Saturn - Setup</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Segoe UI',system-ui,sans-serif; background:#0b1020; color:#e6e9f0; }
  .wrap { max-width:640px; margin:44px auto; padding:0 24px; }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
  .mark { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#3168ff,#2545d6); display:flex; align-items:center; justify-content:center; font-weight:700; }
  h1 { font-size:22px; letter-spacing:2px; margin:0; }
  .sub { color:#8b93b5; font-size:14px; margin:6px 0 24px; }
  .card { background:#121a36; border:1px solid #232a44; border-radius:12px; padding:22px; }
  label { display:block; font-size:13px; color:#b7bfd8; margin:16px 0 6px; }
  label.first { margin-top:0; }
  input, select { width:100%; background:#0d1430; color:#e6e9f0; border:1px solid #2a3350; border-radius:8px; padding:10px 12px; font:inherit; }
  input:focus, select:focus { outline:none; border-color:#3168ff; }
  .hint { font-size:12px; color:#6b7590; margin-top:5px; }
  .row { display:flex; gap:12px; } .row > div { flex:1; }
  .actions { margin-top:24px; display:flex; align-items:center; gap:14px; }
  button.save { background:#2952e3; color:#fff; border:0; border-radius:8px; padding:11px 22px; font-size:14px; cursor:pointer; }
  button.save:disabled { opacity:.5; cursor:default; }
  .status { font-size:13px; } .status.err { color:#ff7a8a; } .status.ok { color:#5ee08a; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="mark">S</span><h1>SATURN</h1></div>
  <div class="sub">Setup - point Saturn at a repository and choose the model.</div>
  <div class="card">
    <label class="first" for="repoUrl">Azure DevOps repository URL</label>
    <input id="repoUrl" type="text" placeholder="https://dev.azure.com/org/project/_git/repo" />
    <div class="hint">The repository Saturn will review, audit, and build for.</div>
    <label for="branch">Default branch</label>
    <input id="branch" type="text" value="main" />
    <label for="provider">LLM provider</label>
    <select id="provider"></select>
    <label for="model">Model</label>
    <select id="model"></select>
    <input id="modelCustom" class="hidden" type="text" placeholder="custom model id" style="margin-top:8px" />
    <div class="row">
      <div>
        <label for="effort">Thinking effort</label>
        <select id="effort"></select>
      </div>
      <div>
        <label for="context">Context size</label>
        <select id="context"></select>
      </div>
    </div>
    <div class="actions">
      <button id="save" class="save" type="button">Save &amp; start</button>
      <span id="status" class="status"></span>
    </div>
  </div>
</div>
<script>
  var $ = function (id) { return document.getElementById(id); };
  var cfg = {};
  function opt(sel, value, label, selected) { var o = document.createElement('option'); o.value = value; o.textContent = label; if (selected) { o.selected = true; } sel.appendChild(o); }
  function j(url) { return fetch(url).then(function (r) { return r.json(); }); }
  function loadState() {
    j('/api/setup/state').then(function (s) {
      cfg = s.config || {};
      var p = $('provider'); p.innerHTML = '';
      (s.providers || []).forEach(function (pr) { opt(p, pr.id, pr.name, pr.id === (cfg.provider || 'copilot')); });
      if (cfg.repoUrl) { $('repoUrl').value = cfg.repoUrl; }
      if (cfg.defaultBranch) { $('branch').value = cfg.defaultBranch; }
      loadModels();
    });
  }
  function loadModels() {
    var provider = $('provider').value;
    j('/api/setup/models?provider=' + encodeURIComponent(provider)).then(function (m) {
      var sel = $('model'); sel.innerHTML = '';
      var current = cfg.model || m.defaultModel;
      (m.models || []).forEach(function (mo) { opt(sel, mo, mo, mo === current); });
      if (m.allowCustom) { opt(sel, '__custom__', 'Custom...', false); }
      if (current && (m.models || []).indexOf(current) < 0 && m.allowCustom) { sel.value = '__custom__'; $('modelCustom').value = current; }
      onModelChange();
    });
  }
  function currentModel() { return $('model').value === '__custom__' ? $('modelCustom').value.trim() : $('model').value; }
  function onModelChange() { $('modelCustom').className = $('model').value === '__custom__' ? '' : 'hidden'; loadCaps(); }
  function loadCaps() {
    var provider = $('provider').value; var model = currentModel();
    j('/api/setup/capabilities?provider=' + encodeURIComponent(provider) + '&model=' + encodeURIComponent(model)).then(function (c) {
      var eff = $('effort'); eff.innerHTML = ''; var curEff = cfg.effort || c.defaultEffort;
      (c.effortLevels || []).forEach(function (e) { opt(eff, e, e, e === curEff); });
      var ctx = $('context'); ctx.innerHTML = '';
      if (!c.contextSizes) { opt(ctx, '', 'Model default', true); ctx.disabled = true; }
      else {
        ctx.disabled = false;
        var curCtx = cfg.contextSize || (c.defaultContextSize != null ? String(c.defaultContextSize) : '');
        c.contextSizes.forEach(function (n) { opt(ctx, String(n), String(n) + ' tokens', String(n) === curCtx); });
      }
    });
  }
  function save() {
    var st = $('status'); st.className = 'status'; st.textContent = 'Saving...'; $('save').disabled = true;
    var payload = { repoUrl: $('repoUrl').value.trim(), defaultBranch: $('branch').value.trim(), provider: $('provider').value, model: currentModel(), effort: $('effort').value, contextSize: $('context').disabled ? '' : $('context').value };
    fetch('/api/setup/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { st.className = 'status err'; st.textContent = (res.d && res.d.error) || 'Save failed.'; $('save').disabled = false; return; }
        st.className = 'status ok'; st.textContent = 'Saved. Starting Saturn...'; pollReady(0);
      })
      .catch(function () { st.className = 'status err'; st.textContent = 'Save failed.'; $('save').disabled = false; });
  }
  function pollReady(n) {
    if (n > 45) { location.href = '/'; return; }
    setTimeout(function () {
      j('/api/setup/state').then(function (s) { if (s.configured) { location.href = '/'; } else { pollReady(n + 1); } }).catch(function () { pollReady(n + 1); });
    }, 1000);
  }
  $('provider').onchange = loadModels;
  $('model').onchange = onModelChange;
  $('save').onclick = save;
  loadState();
</script>
</body>
</html>`;

function main(): void {
  const configured = isSaturnConfigured();
  const service = createSaturnService(buildConfig(), consoleLogger);
  const server = createServer((req, res) => {
    handleRequest(service, req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error' });
      }
    });
  });
  // Push live state to every connected dashboard (Server-Sent Events) so the UI updates without polling.
  setInterval(() => {
    if (sseClients.size === 0) {
      return;
    }
    const payload = `data: ${JSON.stringify(service.getState())}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  }, 1000);
  // Retry the port briefly so a save-triggered restart can rebind once the previous process releases it.
  let listenAttempts = 0;
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && listenAttempts < 30) {
      listenAttempts += 1;
      setTimeout(() => server.listen(PORT), 500);
    } else {
      consoleLogger.error(`Saturn dashboard failed to bind port ${String(PORT)}: ${error.message}`);
    }
  });
  server.listen(PORT, () => {
    consoleLogger.info(`Saturn dashboard running at http://localhost:${String(PORT)}`);
    if (!configured) {
      consoleLogger.info('Saturn is NOT configured yet - open the dashboard to run the setup installer.');
    }
    consoleLogger.info('Open it to start/stop the agent and watch reviews live.');
  });
}

main();
