#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { buildCommentDeepLink, buildPullRequestWebUrl, DASHBOARD_PORT, isFeedbackEnabled } from './config';
import { createSaturnService, type SaturnService, type SaturnServiceConfig } from './saturnService';
import { readAllFeedback, recordFeedback } from './saturnStore';
import { consoleLogger, runCommand } from './util';

const PORT = DASHBOARD_PORT;

const feedbackSubmissionSchema = z.object({
  prId: z.number(),
  commentId: z.number(),
  rating: z.enum(['up', 'down', 'none']),
  message: z.string().max(5000)
});

// Open Server-Sent Events connections (one per viewing dashboard); state is pushed to all of them.
const sseClients = new Set<ServerResponse>();

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

/** Read a request body as a string, capped to guard against oversized payloads. */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
      if (body.length > 1_000_000) {
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
    reasoningEffort: process.env.SATURN_EFFORT ?? 'high',
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
<title>Saturn - PR Review Agent</title>
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
  * { box-sizing: border-box; }
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
  .btn:disabled { opacity:.4; cursor:default; transform:none; }
  :focus-visible { outline:none; box-shadow: var(--ring); }
  main { padding:26px 28px 80px; max-width:1080px; margin:0 auto; }
  .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:14px; margin-bottom:26px; }
  .stat { background: linear-gradient(180deg, var(--panel-2), var(--panel)); border:1px solid var(--border-soft); border-radius:var(--radius); padding:14px 18px; }
  .stat .k { font-size:11.5px; letter-spacing:.4px; text-transform:uppercase; color:var(--muted-2); margin-bottom:6px; }
  .stat .v { font-size:22px; font-weight:700; letter-spacing:.3px; }
  .section-head { display:flex; align-items:baseline; gap:10px; margin:8px 0 14px; }
  .count-chip { font-size:12px; color:var(--muted-2); background:var(--panel-2); border:1px solid var(--border-soft); padding:2px 9px; border-radius:999px; }
  .pr { background:var(--panel); border:1px solid var(--border-soft); border-radius:var(--radius); margin-bottom:12px; overflow:hidden; transition: border-color .15s, box-shadow .15s; }
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
  @media (max-width: 620px) { header { padding:12px 16px; gap:10px; } main { padding:18px 14px 70px; } .pr-meta { display:none; } }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="mark">S</span><h1>SATURN</h1></div>
  <span id="status" class="status off"><span class="dot"></span><span id="statusText">stopped</span></span>
  <span id="phase" class="phase"></span>
  <div class="spacer"></div>
  <button id="startBtn" class="btn">Start</button>
  <button id="stopBtn" class="btn danger">Stop</button>
</header>
<main>
  <div class="stats">
    <div class="stat"><div class="k">Total reviews</div><div class="v" id="total">0</div></div>
    <div class="stat"><div class="k">Reviewed PRs</div><div class="v" id="reviewedCount">0</div></div>
    <div class="stat"><div class="k">Currently reviewing</div><div class="v" id="current">-</div></div>
    <div class="stat"><div class="k">Last scan</div><div class="v" id="lastScan">-</div></div>
  </div>
  <div class="section-head"><h2>Reviewed pull requests</h2><span id="prCount" class="count-chip"></span></div>
  <div id="reviews"></div>
  <div id="sentinel" class="sentinel"></div>
  <div id="loader" class="loader" style="display:none"><span class="spinner"></span> Loading&hellip;</div>
  <div id="endNote" class="end-note" style="display:none"></div>
  <div id="fbSection" style="display:none">
    <div class="section-head" style="margin-top:26px"><h2>Recent feedback</h2></div>
    <div id="feedback"></div>
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

  var post = function (p) { fetch(p, { method: 'POST' }).then(function () { return fetch('/api/state'); }).then(function (r) { return r.json(); }).then(applyState).catch(function () {}); };
  document.getElementById('startBtn').onclick = function () { post('/api/start'); };
  document.getElementById('stopBtn').onclick = function () { post('/api/stop'); };

  function renderComment(c) {
    var sc = sevClass(c.severity);
    var open = c.deepLink ? ' &middot; <a href="' + esc(c.deepLink) + '" target="_blank" rel="noopener">open comment</a>' : '';
    return '<div class="comment ' + sc + '"><div class="loc"><span class="chip ' + sc + '">' + esc(c.severity) + '</span>'
      + '<span class="path">' + esc(c.filePath) + ':' + c.line + '</span>' + open + '</div>'
      + '<div class="c-title">' + esc(c.title) + '</div><div class="c-body">' + esc(c.body) + '</div></div>';
  }
  function renderIteration(it) {
    var comments = (it.comments || []).map(renderComment).join('');
    var detail = it.detail ? '<div class="iter-detail">' + esc(it.detail) + '</div>' : '';
    var fallback = it.status === 'error' ? '' : '<div class="muted" style="font-size:12.5px">No blocking issues found.</div>';
    return '<div class="iter"><div class="iter-head"><span class="pill ' + statusClass(it.status) + '">' + esc(statusLabel(it.status)) + '</span>'
      + '<span>Iteration #' + it.iterationId + '</span><span>&middot;</span><span>' + it.commentsPosted + ' comment(s)</span><span>&middot;</span>'
      + '<span title="' + esc(fmtAbs(it.reviewedAt)) + '">' + esc(fmtRel(it.reviewedAt)) + '</span></div>'
      + detail + (comments || fallback) + '</div>';
  }
  function cardHtml(r) {
    var iterations = (r.iterations || []).slice().sort(function (a, b) { return b.iterationId - a.iterationId; });
    var latest = iterations[0] || {};
    var bodyId = 'pr-body-' + r.pullRequestId;
    var isOpen = !!expanded[r.pullRequestId];
    var iterHtml = iterations.map(renderIteration).join('');
    return '<div class="pr' + (isOpen ? ' open' : '') + '" data-id="' + r.pullRequestId + '">'
      + '<button class="pr-head" aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-controls="' + bodyId + '">'
      + '<span class="chevron">&#8250;</span><span class="pr-id">#' + r.pullRequestId + '</span>'
      + '<span class="pr-title">' + esc(r.title) + '</span>'
      + '<span class="pr-sub"><span class="pr-meta">' + esc(r.author) + ' &middot; ' + iterations.length + ' iter &middot; ' + esc(fmtRel(latest.reviewedAt)) + '</span>'
      + '<span class="pill ' + statusClass(latest.status) + '">' + esc(statusLabel(latest.status)) + '</span></span></button>'
      + '<div class="pr-body" id="' + bodyId + '" role="region"><div class="pr-body-inner"><div class="pr-body-pad">'
      + '<div class="iter-head" style="margin-bottom:12px"><a href="' + esc(r.webUrl) + '" target="_blank" rel="noopener">Open PR #' + r.pullRequestId + ' in Azure DevOps &#8599;</a></div>'
      + iterHtml + '</div></div></div></div>';
  }
  function appendReviews(items) {
    var rv = document.getElementById('reviews');
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      if (loadedIds[r.pullRequestId]) { continue; }
      loadedIds[r.pullRequestId] = true;
      loaded.push(r);
      html += cardHtml(r);
    }
    rv.insertAdjacentHTML('beforeend', html);
  }
  function loadMore() {
    if (loading || reachedEnd) { return; }
    loading = true;
    document.getElementById('loader').style.display = 'flex';
    var q = '/api/reviews?limit=' + LIMIT + (nextCursor ? '&cursor=' + encodeURIComponent(nextCursor) : '');
    fetch(q).then(function (r) { return r.json(); }).then(function (p) {
      var items = p.items || [];
      if (!loaded.length && !items.length) { document.getElementById('reviews').innerHTML = '<div class="empty">No pull requests reviewed yet. Saturn will list them here as it reviews.</div>'; }
      if (!loaded.length && items.length && Object.keys(expanded).length === 0) { expanded[items[0].pullRequestId] = true; }
      appendReviews(items);
      nextCursor = p.nextCursor || null;
      reachedEnd = !nextCursor;
      document.getElementById('prCount').textContent = (p.total || 0) + ' total';
      loading = false;
      document.getElementById('loader').style.display = 'none';
      var en = document.getElementById('endNote');
      if (reachedEnd && loaded.length) { en.style.display = 'block'; en.textContent = 'All ' + loaded.length + ' reviewed PR(s).'; } else { en.style.display = 'none'; }
      maybeLoadMore();
    }).catch(function () { loading = false; document.getElementById('loader').style.display = 'none'; });
  }
  function maybeLoadMore() {
    var s = document.getElementById('sentinel');
    if (!reachedEnd && !loading && s.getBoundingClientRect().top < window.innerHeight + 320) { loadMore(); }
  }
  function refreshFromTop() {
    loaded = []; loadedIds = {}; nextCursor = null; reachedEnd = false; loading = false;
    document.getElementById('reviews').innerHTML = '';
    document.getElementById('endNote').style.display = 'none';
    hideNewPill();
    loadMore();
  }
  document.getElementById('reviews').addEventListener('click', function (e) {
    var head = e.target.closest ? e.target.closest('.pr-head') : null;
    if (!head || e.target.closest('a')) { return; }
    var pr = head.parentNode; var id = pr.getAttribute('data-id');
    var willOpen = !pr.classList.contains('open');
    pr.classList.toggle('open', willOpen);
    head.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) { expanded[id] = true; } else { delete expanded[id]; }
  });
  var newPill = document.getElementById('newPill');
  function showNewPill() { newPill.classList.add('show'); }
  function hideNewPill() { newPill.classList.remove('show'); }
  newPill.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }); refreshFromTop(); };

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
  function applyState(s) {
    var badge = document.getElementById('status');
    badge.className = 'status ' + (s.running ? 'on' : 'off');
    document.getElementById('statusText').textContent = s.running ? 'running' : 'stopped';
    document.getElementById('phase').textContent = s.phase || '';
    document.getElementById('total').textContent = s.totalReviewed;
    document.getElementById('reviewedCount').textContent = s.reviewedPullRequestCount;
    var ls = document.getElementById('lastScan'); ls.textContent = fmtRel(s.lastScanAt); ls.title = fmtAbs(s.lastScanAt);
    var cur = document.getElementById('current');
    cur.innerHTML = s.currentPullRequest ? '<a href="' + esc(s.currentPullRequest.webUrl) + '" target="_blank" rel="noopener">#' + s.currentPullRequest.id + '</a>' : '-';
    if (isOwnerClient) {
      document.getElementById('startBtn').disabled = !!s.running;
      document.getElementById('stopBtn').disabled = !s.running;
    }
    var sig = s.totalReviewed + ':' + s.reviewedPullRequestCount;
    if (!firstStateApplied) { firstStateApplied = true; lastSig = sig; return; }
    if (sig !== lastSig) {
      lastSig = sig;
      if (window.scrollY < 240) { refreshFromTop(); } else { showNewPill(); }
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
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) { if (entries[0] && entries[0].isIntersecting) { loadMore(); } }, { rootMargin: '320px' });
    io.observe(document.getElementById('sentinel'));
  } else {
    window.addEventListener('scroll', maybeLoadMore);
  }
  // Identify the viewer: Start/Stop are owner-only (hidden here and enforced server-side).
  fetch('/api/whoami').then(function (r) { return r.json(); }).then(function (w) {
    isOwnerClient = !!w.isOwner;
    if (!isOwnerClient) {
      var sb = document.getElementById('startBtn'); if (sb) { sb.style.display = 'none'; }
      var pb = document.getElementById('stopBtn'); if (pb) { pb.style.display = 'none'; }
    }
  }).catch(function () {});
  loadMore();
  loadFeedback();
  connectEvents();
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

async function handleRequest(service: SaturnService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];
  const method = req.method ?? 'GET';

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
  if (method === 'GET' && url.startsWith('/api/reviews')) {
    const parsed = new URL(url, 'http://localhost');
    const cursor = parsed.searchParams.get('cursor') ?? undefined;
    const limit = Number.parseInt(parsed.searchParams.get('limit') ?? '12', 10);
    sendJson(res, 200, service.getReviewsCursor(cursor, Number.isNaN(limit) ? 12 : limit));
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
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function main(): void {
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
  server.listen(PORT, () => {
    consoleLogger.info(`Saturn dashboard running at http://localhost:${String(PORT)}`);
    consoleLogger.info('Open it to start/stop the agent and watch reviews live.');
  });
}

main();
