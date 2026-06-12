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
  :root { color-scheme: dark; }
  body { margin:0; font-family: 'Segoe UI', system-ui, sans-serif; background:#0b1020; color:#e6e9f0; }
  header { display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid #232a44; background:#0f1530; position:sticky; top:0; }
  h1 { font-size:20px; margin:0; letter-spacing:2px; } h2 { font-size:16px; color:#c7cdfa; }
  .badge { padding:4px 12px; border-radius:999px; font-size:12px; font-weight:700; }
  .on { background:#10331f; color:#5ee08a; } .off { background:#33121a; color:#ff7a8a; }
  .spacer { flex:1; }
  button { background:#2952e3; color:#fff; border:0; border-radius:8px; padding:8px 18px; font-size:14px; cursor:pointer; }
  button.stop { background:#b3263b; } button:disabled { opacity:.45; cursor:default; }
  main { padding:24px; max-width:1040px; margin:0 auto; }
  .stats { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
  .stat { background:#121a36; border:1px solid #232a44; border-radius:10px; padding:12px 18px; min-width:150px; }
  .stat .k { font-size:12px; color:#8b93b5; } .stat .v { font-size:18px; font-weight:600; }
  .card { background:#121a36; border:1px solid #232a44; border-radius:10px; padding:16px; margin-bottom:14px; }
  .card h3 { margin:0 0 6px; font-size:15px; }
  a { color:#7aa2ff; text-decoration:none; } a:hover { text-decoration:underline; }
  .meta { font-size:12px; color:#8b93b5; }
  .comment { border-left:3px solid #2952e3; padding:6px 10px; margin:8px 0; background:#0d1430; border-radius:0 6px 6px 0; }
  .comment .loc { font-size:12px; color:#8b93b5; } .sev { font-weight:700; font-size:11px; color:#ffb454; }
  .st-error { color:#ff7a8a; font-weight:700; } .st-reviewed { color:#5ee08a; font-weight:700; }
  .st-no-findings { color:#5ee08a; font-weight:700; }
  .empty { color:#8b93b5; }
  .iter { border-top:1px dashed #232a44; margin-top:10px; padding-top:8px; }
  .iter:first-of-type { border-top:0; margin-top:6px; }
  .pager { display:flex; align-items:center; gap:12px; justify-content:center; margin:18px 0 8px; }
  .pager button { background:#1b2547; }
  .pager .meta { color:#8b93b5; }
</style>
</head>
<body>
<header>
  <h1>SATURN</h1>
  <span id="status" class="badge off">stopped</span>
  <span id="phase" class="meta"></span>
  <div class="spacer"></div>
  <button id="startBtn">Start</button>
  <button id="stopBtn" class="stop">Stop</button>
</header>
<main>
  <div class="stats">
    <div class="stat"><div class="k">Total reviews</div><div class="v" id="total">0</div></div>
    <div class="stat"><div class="k">Reviewed PRs</div><div class="v" id="reviewedCount">0</div></div>
    <div class="stat"><div class="k">Currently reviewing</div><div class="v" id="current">-</div></div>
    <div class="stat"><div class="k">Last scan</div><div class="v" id="lastScan">-</div></div>
  </div>
  <h2>Reviewed pull requests</h2>
  <div id="reviews"><p class="empty">No reviews yet.</p></div>
  <div class="pager">
    <button id="prevBtn">Prev</button>
    <span id="pageInfo" class="meta">Page 1</span>
    <button id="nextBtn">Next</button>
  </div>
  <h2>Recent feedback</h2>
  <div id="feedback"><p class="empty">No feedback yet.</p></div>
</main>
<script>
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); };
  function fmt(t) { return t ? new Date(t).toLocaleString() : '-'; }
  var PAGE_SIZE = 20;
  var currentPage = 1;
  var lastSummarySignature = null;
  var isOwnerClient = false;
  function post(p) { fetch(p, { method: 'POST' }).then(function () { return fetch('/api/state'); }).then(function (r) { return r.json(); }).then(applyState).catch(function () {}); }
  document.getElementById('startBtn').onclick = function () { post('/api/start'); };
  document.getElementById('stopBtn').onclick = function () { post('/api/stop'); };
  document.getElementById('prevBtn').onclick = function () { if (currentPage > 1) { currentPage -= 1; loadReviews(); } };
  document.getElementById('nextBtn').onclick = function () { currentPage += 1; loadReviews(); };

  function renderComment(c) {
    return '<div class="comment"><div class="loc"><span class="sev">' + esc(c.severity) + '</span> '
      + esc(c.filePath) + ':' + c.line + ' &middot; <a href="' + esc(c.deepLink) + '" target="_blank">open comment</a></div>'
      + '<div><b>' + esc(c.title) + '</b></div><div>' + esc(c.body) + '</div></div>';
  }
  function renderIteration(it) {
    var comments = (it.comments || []).map(renderComment).join('');
    var detail = it.detail ? '<div class="meta">' + esc(it.detail) + '</div>' : '';
    var fallback = it.status === 'error' ? '' : '<div class="empty">No blocking issues found.</div>';
    return '<div class="iter"><div class="meta">Iteration #' + it.iterationId + ' &middot; <span class="st-' + esc(it.status) + '">'
      + esc(it.status) + '</span> &middot; ' + it.commentsPosted + ' comment(s) &middot; ' + fmt(it.reviewedAt) + '</div>'
      + detail + (comments || fallback) + '</div>';
  }
  function renderReviews(payload) {
    var rv = document.getElementById('reviews');
    var reviews = payload.reviews || [];
    if (!reviews.length) {
      rv.innerHTML = '<p class="empty">No reviews on this page.</p>';
    } else {
      rv.innerHTML = reviews.map(function (r) {
        var iterations = (r.iterations || []).slice().sort(function (a, b) { return b.iterationId - a.iterationId; });
        var latest = iterations[0] || {};
        var iterHtml = iterations.map(renderIteration).join('');
        return '<div class="card"><h3><a href="' + esc(r.webUrl) + '" target="_blank">#' + r.pullRequestId + ' &mdash; '
          + esc(r.title) + '</a></h3><div class="meta">' + esc(r.author) + ' &middot; ' + iterations.length
          + ' iteration(s) &middot; last reviewed ' + fmt(latest.reviewedAt) + '</div>' + iterHtml + '</div>';
      }).join('');
    }
    var totalPages = Math.max(1, Math.ceil((payload.total || 0) / (payload.pageSize || PAGE_SIZE)));
    document.getElementById('pageInfo').textContent = 'Page ' + payload.page + ' of ' + totalPages + ' \u00b7 ' + (payload.total || 0) + ' PR(s)';
    document.getElementById('prevBtn').disabled = payload.page <= 1;
    document.getElementById('nextBtn').disabled = payload.page >= totalPages;
  }
  function loadReviews() {
    fetch('/api/reviews?page=' + currentPage + '&pageSize=' + PAGE_SIZE).then(function (r) { return r.json(); }).then(function (p) {
      var totalPages = Math.max(1, Math.ceil((p.total || 0) / (p.pageSize || PAGE_SIZE)));
      if (p.page > totalPages) { currentPage = totalPages; loadReviews(); return; }
      renderReviews(p);
    }).catch(function () { /* ignore */ });
  }
  function renderFeedback(items) {
    var fb = document.getElementById('feedback');
    if (!items || !items.length) { fb.innerHTML = '<p class="empty">No feedback yet.</p>'; return; }
    fb.innerHTML = items.map(function (f) {
      var label = f.rating === 'up' ? ' &middot; Helpful' : (f.rating === 'down' ? ' &middot; Not helpful' : '');
      return '<div class="card"><div class="meta">' + esc(f.submittedBy) + label + ' &middot; ' + fmt(f.submittedAt)
        + ' &middot; <a href="' + esc(f.prUrl) + '" target="_blank">PR #' + f.pullRequestId + '</a>'
        + ' &middot; <a href="' + esc(f.commentDeepLink) + '" target="_blank">view comment</a></div>'
        + (f.message ? '<div>' + esc(f.message) + '</div>' : '') + '</div>';
    }).join('');
  }
  function loadFeedback() {
    fetch('/api/feedback').then(function (r) { return r.json(); }).then(function (p) { renderFeedback(p.feedback || []); }).catch(function () { /* ignore */ });
  }
  function applyState(s) {
    var badge = document.getElementById('status');
    badge.textContent = s.running ? 'running' : 'stopped';
    badge.className = 'badge ' + (s.running ? 'on' : 'off');
    document.getElementById('phase').textContent = s.phase || '';
    document.getElementById('total').textContent = s.totalReviewed;
    document.getElementById('reviewedCount').textContent = s.reviewedPullRequestCount;
    document.getElementById('lastScan').textContent = fmt(s.lastScanAt);
    var cur = document.getElementById('current');
    cur.innerHTML = s.currentPullRequest ? '<a href="' + esc(s.currentPullRequest.webUrl) + '" target="_blank">#' + s.currentPullRequest.id + '</a>' : '-';
    if (isOwnerClient) {
      document.getElementById('startBtn').disabled = !!s.running;
      document.getElementById('stopBtn').disabled = !s.running;
    }
    // When the store changed (a new review/iteration or new feedback), refresh the lists so it stays live.
    var summarySignature = s.totalReviewed + ':' + s.reviewedPullRequestCount;
    if (summarySignature !== lastSummarySignature) { lastSummarySignature = summarySignature; loadReviews(); loadFeedback(); }
  }
  function connectEvents() {
    if (typeof EventSource !== 'undefined') {
      var es = new EventSource('/api/events');
      es.onmessage = function (e) { try { applyState(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
      // EventSource reconnects automatically on transient errors.
    } else {
      setInterval(function () { fetch('/api/state').then(function (r) { return r.json(); }).then(applyState).catch(function () {}); }, 2500);
    }
  }
  // Identify the viewer: Start/Stop are owner-only (hidden here and enforced server-side).
  fetch('/api/whoami').then(function (r) { return r.json(); }).then(function (w) {
    isOwnerClient = !!w.isOwner;
    if (!isOwnerClient) {
      var sb = document.getElementById('startBtn'); if (sb) { sb.style.display = 'none'; }
      var pb = document.getElementById('stopBtn'); if (pb) { pb.style.display = 'none'; }
    }
  }).catch(function () {});
  loadReviews();
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
    const page = Number.parseInt(parsed.searchParams.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(parsed.searchParams.get('pageSize') ?? '20', 10);
    sendJson(res, 200, service.getReviewsPage(Number.isNaN(page) ? 1 : page, Number.isNaN(pageSize) ? 20 : pageSize));
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
