/*
 * ALLEN Toolbox — background service worker.
 * Keeps the per-tab list of detected documents/media, routes popup actions to the offscreen
 * worker, sets the Referer/Origin the CDN expects, triggers downloads, and registers plugins.
 * The worker may be stopped at any moment, so all state is mirrored into chrome.storage.session.
 */
import { DEFAULTS, FEATURES, effectiveConfig, isAllenSite, siteKey, siteFixesEnabled } from './shared/features.js';
import { safeBase } from './shared/names.js';
import { isViewerStream, viewerStreamKey, pdfRouteHref, PdfError, PDF_REOPEN } from './shared/pdf.js';
import { selectOutput } from './shared/hls.js';
import { DownloadError } from './shared/download.js';
import { initUpdates } from './shared/updates.js';
import { initGM } from './gm/gm-bg.js';

const ALLEN_MATCH = '*://*.allenoverseas.com/*';

/* ====================================================================== *
 * State
 * ====================================================================== */
let config = { ...DEFAULTS };
const tabs = new Map();    // tabId -> { items: {id: item}, title }
const jobs = new Map();    // jobId -> job
let fileOperations = 0;
const downloadBlobs = new Map();   // downloadId (or pending save key) -> persisted blob/save ownership
const infoCache = new Map();       // item scope + playlist url -> { at, data }
const previewCache = new Map();
const reqHeaders = new Map();      // scope + exact URL -> the player's request context
const networkRequests = new Map(); // requestId -> request-start document/route context
const documentRequests = new Map(); // tabId -> pending main-frame response (before navigation commits)
const generationId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
let requestRulesClean = false, ruleCleanup;

async function cleanRequestRules() {
  if (requestRulesClean) return;
  if (!ruleCleanup) ruleCleanup = (async () => {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1, 2] });
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules.filter((r) => (r.id >= 1000 && r.id <= 5900) || (r.id >= 6000 && r.id < 20000)).map((r) => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    requestRulesClean = true;
  })().finally(() => { ruleCleanup = null; });
  return ruleCleanup;
}

const ready = (async () => {
  const [local, session] = await Promise.all([chrome.storage.local.get('cfg'), chrome.storage.session.get(null)]);
  config = { ...DEFAULTS, ...(local.cfg || {}) };
  for (const [k, v] of Object.entries(session)) {
    if (k.startsWith('tab:')) tabs.set(+k.slice(4), v);
    else if (k === 'jobs') for (const j of v) jobs.set(j.id, j);
    else if (k === 'rh') for (const [u, h] of v) reqHeaders.set(u, h);
    else if (k === 'downloadBlobs') for (const [id, record] of v) downloadBlobs.set(id, record);
  }
  // Also remove the old global rules. Active requests have already sent their headers.
  await cleanRequestRules().catch(() => {});
  await recoverDownloads();
})();

const persistTab = (tabId) => chrome.storage.session.set({ ['tab:' + tabId]: tabs.get(tabId) }).catch(() => {});
const jobSnapshot = () => [...jobs.values()].filter((j, i, all) => !terminalJob(j.state) || i >= all.length - 30);
const persistJobs = () => chrome.storage.session.set({ jobs: jobSnapshot() }).catch(() => {});
const persistDownloads = () => chrome.storage.session.set({ jobs: jobSnapshot(), downloadBlobs: [...downloadBlobs.entries()] });
const terminalJob = (state) => ['done', 'error', 'cancelled'].includes(state);

function tabState(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { items: {}, children: [], title: '', generation: generationId(), frames: {}, resetAt: 0 });
  const st = tabs.get(tabId);
  if (!st.generation) st.generation = generationId();
  if (!st.frames) st.frames = {};
  return st;
}

function visibleItems(st) {
  const hide = new Set(st.children || []);
  return Object.values(st.items).filter((it) => !hide.has(it.url));
}

function updateBadge(tabId) {
  const n = visibleItems(tabState(tabId)).length;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6df6' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

function releasePdfScopes(st) {
  const scopes = [...new Set([...Object.values(st.frames || {}).map((f) => f.scope), ...Object.values(st.items).map((it) => it.scope)].filter(Boolean))];
  if (scopes.length) chrome.runtime.sendMessage({ target: 'offscreen', type: 'pdf-release', scopes }).catch(() => {});
}

function clearTab(tabId, { pageHref, documentId, resetAt = Date.now(), notify = false, sourceFrameId } = {}) {
  if (typeof gm !== 'undefined') gm.clearTabMenus(tabId);
  const old = tabState(tabId);
  releasePdfScopes(old);
  const frames = documentId ? { 0: { documentId, pageHref, routeAt: resetAt } } : {};
  tabs.set(tabId, { items: {}, children: [], title: old.title, frames, generation: generationId(), resetAt });
  persistTab(tabId); updateBadge(tabId);
  if (notify) chrome.tabs.sendMessage(tabId, { type: 'capture-reset', generation: tabState(tabId).generation, sourceFrameId }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) releasePdfScopes(tabs.get(tabId));
  documentRequests.delete(tabId);
  tabs.delete(tabId); chrome.storage.session.remove('tab:' + tabId).catch(() => {});
});
chrome.webNavigation.onCommitted.addListener((d) => {
  ready.then(() => {
    if (d.frameId === 0 && d.transitionType !== 'auto_subframe') {
      clearTab(d.tabId, { pageHref: d.url, documentId: d.documentId, resetAt: Math.floor(d.timeStamp || Date.now()) });
      const request = documentRequests.get(d.tabId);
      documentRequests.delete(d.tabId);
      if (request?.kind === 'pdf') adoptMainPdf(d, request);
    } else if (d.frameId !== 0) {
      const st = tabState(d.tabId), old = st.frames[d.frameId];
      if (old && old.scope) chrome.runtime.sendMessage({ target: 'offscreen', type: 'pdf-release', scopes: [old.scope] }).catch(() => {});
      for (const it of Object.values(st.items)) if (it.frameId === d.frameId) delete st.items[it.id];
      st.frames[d.frameId] = { documentId: d.documentId, pageHref: d.url, routeAt: Math.floor(d.timeStamp || Date.now()) };
      persistTab(d.tabId); updateBadge(d.tabId);
    }
  });
});

/* ====================================================================== *
 * Detection
 * ====================================================================== */
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const SEGMENT = /\.(ts|m4s|cmf[va]|mts)(\?|#|$)|[\/_-](seg|chunk|frag(ment)?)[-_]?\d+/i;

function classify(url, ct) {
  ct = (ct || '').toLowerCase();
  if (isViewerStream(url) || /application\/pdf/.test(ct) || /\.pdf(\?|#|$)/i.test(url)) return 'pdf';
  if (/mpegurl/.test(ct) || /\.m3u8(\?|#|$)/i.test(url)) return 'hls';
  if (/dash\+xml/.test(ct) || /\.mpd(\?|#|$)/i.test(url)) return 'dash';
  if (/mp2t|iso\.segment/.test(ct) || SEGMENT.test(url)) return null;
  if (/^(video|audio)\//.test(ct) || /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(url)) return 'media';
  return null;
}

const normRef = (r) => { try { return new URL(r).href; } catch (e) { return ''; } };

function addItems(tabId, frameId, referer, list, title, context = {}) {
  referer = normRef(referer);
  const st = tabState(tabId);
  if (title) st.title = title;
  let changed = false;
  for (const it of list) {
    if (isViewerStream(it.url)) it.kind = 'pdf';
    if (!it.url || (it.kind === 'pdf' ? !config.pdfDetect : !config.mediaDetect)) continue;
    if (!/^(https?:|blob:)/i.test(it.url)) continue;
    const at = Number(it.capturedAt) || Date.now(), order = Number(it.captureOrder) || 0;
    const cutoff = context.initial ? Math.min(st.resetAt || 0, context.routeAt || st.resetAt || 0) : st.resetAt || 0;
    if (at < cutoff) continue;
    const id = it.kind + ':' + fnv(it.url + (it.kind === 'pdf' ? '\n' + (context.scope || frameId + ':' + (context.documentId || '')) : ''));
    if (isViewerStream(it.url)) {
      const key = viewerStreamKey(it.url);
      const obsolete = Object.values(st.items).filter((p) => p.id !== id && p.kind === 'pdf' && p.scope === context.scope && viewerStreamKey(p.url) === key);
      if (obsolete.some((p) => p.ts > at || (p.ts === at && (p.captureOrder || 0) > order))) continue;
      for (const p of obsolete) { delete st.items[p.id]; changed = true; }
    }
    const cur = st.items[id];
    const adoptingCapture = cur && it.kind === 'pdf' && it.captureId && !cur.captureId;
    // Browser request clocks can be later than the page hook for the same fetch. Keep the
    // renderer's capture identity/time intact so its completed blob remains a valid fallback.
    if (cur && (cur.ts > at || (cur.ts === at && (cur.captureOrder || 0) > order)) && !adoptingCapture) continue;
    if (cur && !it.captureId && cur.captureId) {
      if (it.size && !cur.size) { cur.size = it.size; changed = true; }
      if (it.ct && !cur.ct) { cur.ct = it.ct; changed = true; }
      continue;
    }
    const refreshed = cur && it.captureId && cur.captureId !== it.captureId;
    const item = st.items[id] = {
      ...cur, id, kind: it.kind, url: it.url, tabId, frameId, referer: referer || '', ts: at,
      scope: context.scope || '', documentId: context.documentId || '', pageHref: context.pageHref || referer || '',
      routeId: context.routeId || '', routeAt: context.routeAt || 0,
      captureId: it.captureId || (cur && cur.captureId) || '', captureOrder: order,
      size: it.size || (cur && cur.size) || 0, ct: it.ct || (cur && cur.ct) || '',
      uploaded: !!it.uploaded || (!refreshed && !!(cur && cur.uploaded)), stream: isViewerStream(it.url),
      captureError: it.captureError || (!refreshed && cur?.captureError) || '',
    };
    if (it.headers) item.headers = Object.fromEntries(Object.entries(it.headers).filter(([k, v]) => /^(authorization|accept|accept-language)$|^x-/i.test(k) && typeof v === 'string'));
    changed = true;
  }
  if (changed) { persistTab(tabId); updateBadge(tabId); }
}

function registerRoute(tabId, sender, msg) {
  let st = tabState(tabId);
  const frameId = sender.frameId || 0, ctx = { ...msg.context, pageHref: pdfRouteHref(msg.context && msg.context.pageHref) };
  const old = st.frames[frameId];
  const stale = () => ({ stale: true, generation: st.generation });
  if (!ctx.routeId || !ctx.pageHref) return stale();
  if (old && old.documentId && sender.documentId && old.documentId !== sender.documentId) return stale();
  // Renderer Date.now() can precede onCommitted's browser timestamp for the same new document.
  const initialDocument = !!(msg.initial && old && old.documentId && old.documentId === sender.documentId &&
    (!old.routeId || old.initial) && pdfRouteHref(old.pageHref) === ctx.pageHref);
  if (old && old.routeAt > ctx.routeAt && !initialDocument) return stale();
  if (frameId !== 0 && ctx.routeAt < (st.resetAt || 0) && !initialDocument) return stale();
  if (frameId !== 0 && msg.generation && msg.generation !== st.generation && !msg.initial && !msg.reset) return stale();
  if (old && old.routeId === ctx.routeId && old.scope) return { scope: old.scope, generation: st.generation };
  if (frameId === 0 && old && old.routeId && !msg.reset && (!msg.initial || old.pageHref !== ctx.pageHref)) {
    clearTab(tabId, { resetAt: ctx.routeAt, notify: true, sourceFrameId: 0 });
    st = tabState(tabId);
  } else if (old && old.scope) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'pdf-release', scopes: [old.scope] }).catch(() => {});
    for (const it of Object.values(st.items)) if (it.frameId === frameId) delete st.items[it.id];
  }
  const documentId = sender.documentId || ctx.pageId || '';
  const scope = tabId + ':' + frameId + ':' + documentId + ':' + ctx.routeId + ':' + st.generation;
  st.frames[frameId] = { ...ctx, documentId, scope, initial: !!msg.initial };
  persistTab(tabId); updateBadge(tabId);
  return { scope, generation: st.generation };
}

function contentContext(tabId, sender, ctx) {
  const st = tabState(tabId), frame = st.frames[sender.frameId || 0];
  return frame && ctx && ctx.generation === st.generation && ctx.scope === frame.scope && ctx.routeId === frame.routeId &&
    (!sender.documentId || !frame.documentId || sender.documentId === frame.documentId) ? frame : null;
}

function networkContext(d, record) {
  const st = tabState(d.tabId), at = record ? record.at : Math.floor(d.timeStamp || Date.now());
  if (at < (st.resetAt || 0) || (record && record.generation && record.generation !== st.generation)) return null;
  let frame = st.frames[d.frameId];
  if (frame && ((frame.documentId && d.documentId && frame.documentId !== d.documentId) || at < frame.routeAt)) return null;
  if (!frame || !frame.scope) {
    const routeId = 'network:' + (d.documentId || generationId());
    frame = st.frames[d.frameId] = {
      ...frame, documentId: d.documentId || '', pageHref: pdfRouteHref(d.documentUrl || (frame && frame.pageHref) || d.initiator || ''), routeId,
      routeAt: frame && frame.routeAt || st.resetAt || 0, initial: true,
      scope: d.tabId + ':' + d.frameId + ':' + routeId + ':' + st.generation,
    };
  }
  return frame;
}

function adoptMainPdf(d, request) {
  try {
    const source = new URL(request.url), current = new URL(d.url); source.hash = ''; current.hash = '';
    if (source.href !== current.href || (request.documentId && d.documentId && request.documentId !== d.documentId)) return;
  } catch (err) { return; }
  const at = Math.floor(d.timeStamp || Date.now());
  const ctx = networkContext({ ...d, documentUrl: d.url, timeStamp: at }, null);
  if (!ctx) return;
  if (request.headers) {
    const headers = { ...request.headers, __scope: ctx.scope, __documentId: d.documentId || '', __at: at };
    reqHeaders.set(request.url, headers); reqHeaders.set(ctx.scope + '\n' + request.url, headers);
    chrome.storage.session.set({ rh: [...reqHeaders.entries()].slice(-80) }).catch(() => {});
  }
  // The new PDF's response arrives before onCommitted clears the old page's captures.
  addItems(d.tabId, 0, request.headers?.referer || ctx.pageHref, [{ kind: 'pdf', url: request.url, ct: request.ct,
    size: request.size, capturedAt: at, via: 'response' }], '', ctx);
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  const record = { at: Math.floor(d.timeStamp || Date.now()), generation: tabs.get(d.tabId)?.generation };
  networkRequests.set(d.requestId, record);
  if (d.type === 'main_frame') {
    Object.assign(record, { url: d.url, documentId: d.documentId || '' });
    documentRequests.set(d.tabId, record);
  }
  while (networkRequests.size > 300) networkRequests.delete(networkRequests.keys().next().value);
  if (!isViewerStream(d.url)) return;
  ready.then(() => {
    const ctx = networkContext(d, record);
    if (ctx) addItems(d.tabId, d.frameId, ctx.pageHref, [{ kind: 'pdf', url: d.url, capturedAt: record.at, via: 'request' }], '', ctx);
  });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'main_frame', 'sub_frame', 'object'] });

// What the page's own player sent. The extension's download later reproduces this request as closely
// as the browser allows, because servers may check Cookie, Referer, Origin, Authorization, X- headers
// or the Sec-Fetch-* metadata that tells a <video> element apart from a script.
const REPLAY_EXACT = new Set(['cookie', 'authorization', 'referer', 'origin', 'user-agent', 'accept', 'accept-language']);
const replayable = (n) => REPLAY_EXACT.has(n) || n.startsWith('x-') || n.startsWith('sec-fetch-') || n.startsWith('sec-ch-');
const extSent = new Map();     // url -> header names the extension's own request carried (diagnostics only)
let rhTimer = null;
chrome.webRequest.onSendHeaders.addListener((d) => {
  const hs = d.requestHeaders || [];
  if (d.tabId < 0) {                                       // the extension's own fetch
    extSent.set(d.url, hs.map((h) => h.name.toLowerCase()));
    while (extSent.size > 40) extSent.delete(extSent.keys().next().value);
    return;
  }
  const keep = {};
  for (const h of hs) { const n = h.name.toLowerCase(); if (replayable(n)) keep[n] = h.value; }
  // Whether a request turns out to be a video is only known from its response, so remember them all
  // (a small in-memory ring buffer) and look the right one up at download time.
  keep.__type = d.type;
  const record = networkRequests.get(d.requestId);
  keep.__tabId = d.tabId; keep.__frameId = d.frameId; keep.__documentId = d.documentId || '';
  keep.__at = record ? record.at : Math.floor(d.timeStamp || Date.now());
  if (d.type === 'main_frame' && record) record.headers = keep;
  ready.then(() => {
    const ctx = networkContext(d, record);
    if (!ctx) return;
    keep.__scope = ctx.scope;
    const old = reqHeaders.get(d.url);
    if (!old || old.__at <= keep.__at) { reqHeaders.delete(d.url); reqHeaders.set(d.url, keep); }
    const key = ctx.scope + '\n' + d.url;
    if (!reqHeaders.get(key) || reqHeaders.get(key).__at <= keep.__at) { reqHeaders.delete(key); reqHeaders.set(key, keep); }
    while (reqHeaders.size > 300) reqHeaders.delete(reqHeaders.keys().next().value);
    clearTimeout(rhTimer);
    rhTimer = setTimeout(() => chrome.storage.session.set({ rh: [...reqHeaders.entries()].slice(-80) }).catch(() => {}), 1500);
  });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'main_frame', 'sub_frame', 'object'] }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return;
  const record = networkRequests.get(d.requestId);
  const h = (n) => ((d.responseHeaders || []).find((x) => x.name.toLowerCase() === n) || {}).value || '';
  const ct = h('content-type'), kind = classify(d.url, ct);
  const range = /\/(\d+)$/.exec(h('content-range'));
  const size = range ? +range[1] : +h('content-length') || 0;
  if (d.type === 'main_frame' && record) Object.assign(record, { kind, ct, size, url: d.url });
  ready.then(() => {
    const ctx = networkContext(d, record);
    if (!ctx) return;
    if (!kind) return;
    if (kind === 'media' && size && size < 200 * 1024) return;       // skip tiny segments/clips
    addItems(d.tabId, d.frameId, ctx.pageHref || d.documentUrl || d.initiator || '', [{ kind, url: d.url, ct, size, capturedAt: record ? record.at : Math.floor(d.timeStamp || Date.now()), via: 'response' }], '', ctx);
  });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'main_frame', 'sub_frame', 'object'] }, ['responseHeaders']);

/* ====================================================================== *
 * Offscreen + request headers + downloads
 * ====================================================================== */
let creating = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS', 'WORKERS'],
      justification: 'Download recordings, read PDFs and build files for saving',
    }).finally(() => { creating = null; });
  }
  await creating;
}

// The offscreen page loads pdf.js before it starts listening, so a message sent right after
// createDocument() can arrive too early. Retry until the worker answers.
async function sendOffscreen(msg) {
  let err;
  for (let i = 0; i < 40; i++) {
    try { return await chrome.runtime.sendMessage(msg); }
    catch (e) {
      err = e;
      if (!/Receiving end does not exist|message port closed/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw err;
}

async function offscreen(type, payload) {
  await ensureOffscreen();
  const r = await sendOffscreen({ target: 'offscreen', type, ...payload });
  if (r && r.error) { const e = new Error(r.error); e.code = r.code; e.diag = r.diag; throw e; }
  return r;
}

// A copy-paste report for "why was I refused?". Secrets (cookies, tokens, signed query values) are never included.
function buildDiag(it, d, stage) {
  const ver = chrome.runtime.getManifest().version;
  const safeUrl = (u) => { try { const x = new URL(u); return x.origin + '/ (path and query hidden)'; } catch (e) { return '(URL hidden)'; } };
  const refOrigin = (v) => { try { return new URL(v).origin; } catch (e) { return '(hidden)'; } };
  const show = (k, v) => k === 'referer' || k === 'origin' ? refOrigin(v) : '<' + String(v || '').length + ' chars hidden>';
  const cap = capturedHeaders(it, it.url);
  const ext = extSent.get(it.url);
  const L = ['ALLEN Toolbox ' + ver + ' diagnostics', 'Stage: ' + (stage || 'download'), 'Item: ' + it.kind + ' ' + safeUrl(it.url)];
  if (d) {
    L.push('Server answered: HTTP ' + (Number(d.status) || 0));
    for (const [k, v] of Object.entries(d.headers || {})) L.push('  response ' + k.replace(/[^a-z0-9-]/gi, '') + ': <value hidden>');
  }
  L.push('', "Player's own request (what the page sent):");
  if (Object.keys(cap).length) {
    for (const [k, v] of Object.entries(cap)) if (!k.startsWith('__')) L.push('  ' + k + ': ' + show(k, v));
    if (!('origin' in cap)) L.push('  (no origin header — like a <video> element)');
    L.push('  request type: ' + (cap.__type || '?'));
  } else L.push('  NOT CAPTURED — the extension never saw the player fetch this exact URL, so it could not copy it.');
  L.push('', "Extension's request carried: " + (ext ? ext.join(', ') : '(not observed)'));
  L.push('Item referer: ' + (it.referer ? refOrigin(it.referer) : '(none)'));
  return L.join('\n');
}

// Kept as the GM dependency's URL normalizer, never as a global header rule.
const setReferer = (referer) => normRef(referer);
const requestQueues = new Map();
const requestLeases = new Map();
const releasedRequests = new Set();
let requestRuleSeq = 6000;

function capturedHeaders(it, url) {
  const valid = (h) => h && h.__tabId === it.tabId && h.__frameId === it.frameId &&
    (!h.__documentId || !it.documentId || h.__documentId === it.documentId) && h.__at >= (it.routeAt || 0) &&
    (!h.__scope || !it.scope || h.__scope === it.scope);
  const scoped = reqHeaders.get(it.scope + '\n' + url), recent = reqHeaders.get(url);
  return valid(recent) && (!valid(scoped) || recent.__at >= scoped.__at) ? recent : valid(scoped) ? scoped : {};
}

async function acquireRequest({ url: href, context: it, requestId, pdf = false, requestHeaders, method = 'get' }) {
  const url = new URL(href); url.hash = '';
  if (!/^https?:$/.test(url.protocol)) throw new DownloadError('DOWNLOAD_URL', 'Only HTTP(S) download requests are supported');
  if (!(await chrome.permissions.contains({ origins: [url.origin + '/*'] }))) {
    throw new DownloadError('DOWNLOAD_PERMISSION', 'Allow host access to ' + url.hostname + ' before downloading this recording or PDF.');
  }
  try { await cleanRequestRules(); }
  catch (err) { throw new DownloadError('DOWNLOAD_CONTEXT', 'Obsolete download request rules could not be cleared. Retry Download after reopening the extension.'); }
  for (const [id, lease] of requestLeases) if (lease.cleanupFailed) await releaseRequest(id);
  if (releasedRequests.has(requestId)) throw new DownloadError('DOWNLOAD_CANCELLED', 'Cancelled');
  if (!requestId || requestLeases.has(requestId)) throw new DownloadError('DOWNLOAD_CONTEXT', 'Invalid or duplicate download request');
  const key = url.href, previous = requestQueues.get(key) || Promise.resolve();
  let unlock;
  const done = new Promise((r) => { unlock = r; });
  const queued = previous.catch(() => {}).then(() => done);
  const lease = { key, queued, unlock, released: false, ruleIds: [] };
  requestQueues.set(key, queued); requestLeases.set(requestId, lease);
  await previous.catch(() => {});
  try {
    if (lease.released) throw new DownloadError('DOWNLOAD_CANCELLED', 'Cancelled');
    if ([...requestLeases.values()].some((entry) => entry.key === key && entry.cleanupFailed)) {
      throw new DownloadError('DOWNLOAD_CONTEXT', 'The previous request context could not be cleared. Retry Download.');
    }
    let operations;
    if (requestHeaders !== undefined) {
      if (!Array.isArray(requestHeaders) || requestHeaders.length > 100 || requestHeaders.some((h) =>
        !h || typeof h.header !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(h.header) || h.operation !== 'set' || typeof h.value !== 'string' || /[\r\n]/.test(h.value))) {
        throw new DownloadError('DOWNLOAD_CONTEXT', 'Invalid extension request headers');
      }
      operations = requestHeaders;
    } else {
      const captured = capturedHeaders(it, key);
      const context = Object.fromEntries(Object.entries(captured).filter(([k, v]) => !k.startsWith('__') && replayable(k) && typeof v === 'string' && !/[\r\n]/.test(v)));
      // Never inherit auth from the master URL, a different resource, tab, frame or route.
      if (!Object.keys(captured).length && key === it.url) {
        for (const [k, v] of Object.entries(it.headers || {})) if (/^(authorization|accept|accept-language)$|^x-/i.test(k) && typeof v === 'string') context[k.toLowerCase()] = v;
      }
      const ref = context.referer || (/^https?:/i.test(it.pageHref) ? it.pageHref : '') ||
        (/^https?:/i.test(it.referer) ? it.referer : '');
      if (ref && /^https?:/i.test(ref)) {
        context.referer = ref;
        if (!Object.keys(captured).length) context.origin = new URL(ref).origin;
      }
      operations = Object.entries(context).map(([header, value]) => ({ header, operation: 'set', value }));
      if (!('origin' in context)) operations.push({ header: 'origin', operation: 'remove' });
      if (!('referer' in context)) operations.push({ header: 'referer', operation: 'remove' });
      if (!('authorization' in context)) operations.push({ header: 'authorization', operation: 'remove' });
      for (const header of pdf ? ['range', 'if-range', 'if-none-match', 'if-modified-since'] : ['if-none-match', 'if-modified-since']) operations.push({ header, operation: 'remove' });
    }
    const used = new Set([...requestLeases.values()].flatMap((entry) => entry.ruleIds));
    while (used.has(requestRuleSeq) || used.has(requestRuleSeq + 1)) { requestRuleSeq += 2; if (requestRuleSeq >= 20000) requestRuleSeq = 6000; }
    const ruleId = requestRuleSeq++, guardId = requestRuleSeq++;
    if (requestRuleSeq >= 20000) requestRuleSeq = 6000;
    lease.ruleIds = [ruleId, guardId];
    const regexFilter = '^' + url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    const condition = { tabIds: [-1], initiatorDomains: [chrome.runtime.id], regexFilter, isUrlFilterCaseSensitive: true,
      requestMethods: [['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put'].includes(String(method).toLowerCase()) ? String(method).toLowerCase() : 'other'],
      resourceTypes: ['xmlhttprequest', 'other'] };
    try {
      lease.install = chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId, guardId], addRules: [...(operations.length ? [{ id: ruleId, priority: 100,
          action: { type: 'modifyHeaders', requestHeaders: operations },
          condition,
        }] : []), {
          id: guardId, priority: 99, action: { type: 'allow' }, condition,
        }],
      });
      await lease.install;
    } catch (err) {
      throw new DownloadError('DOWNLOAD_CONTEXT', 'The captured request context could not be applied. Reopen the viewer and retry Download.');
    }
    if (lease.released) throw new DownloadError('DOWNLOAD_CANCELLED', 'Cancelled');
    return { requestId };
  } catch (err) { await releaseRequest(requestId); throw err; }
}

async function releaseRequest(requestId) {
  releasedRequests.add(requestId);
  while (releasedRequests.size > 500) releasedRequests.delete(releasedRequests.values().next().value);
  const lease = requestLeases.get(requestId);
  if (!lease) return { ok: true };
  lease.released = true;
  if (!lease.removing) lease.removing = (async () => {
    if (lease.install) await lease.install.catch(() => {});
    try { if (lease.ruleIds.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: lease.ruleIds }); }
    catch (err) {
      lease.cleanupFailed = true; lease.unlock();
      throw new DownloadError('DOWNLOAD_CONTEXT', 'The browser could not clear this request context. Retry Download after reopening the extension.');
    }
    requestLeases.delete(requestId); lease.unlock();
    lease.queued.then(() => { if (requestQueues.get(lease.key) === lease.queued) requestQueues.delete(lease.key); });
    return { ok: true };
  })().finally(() => { lease.removing = null; });
  return lease.removing;
}

async function withPdfContext(it, fn) {
  const opts = { scope: it.scope, fresh: isViewerStream(it.url), allowCaptured: !!it.captureId, captureId: it.captureId, capturedAt: it.ts };
  if (!/^https?:/i.test(it.url)) return fn(opts);
  const requestId = 'pdf:' + generationId();
  try { await acquireRequest({ url: it.url, context: it, requestId, pdf: true }); }
  catch (err) {
    const code = err.code === 'DOWNLOAD_PERMISSION' ? 'PDF_PERMISSION' : 'PDF_CONTEXT';
    const error = new PdfError(code, err.message + ' ' + PDF_REOPEN);
    if (!opts.allowCaptured || !currentPdf(it)) throw error;
    return fn({ ...opts, cacheOnly: true, fallbackCode: code, fallbackMessage: error.message });
  }
  try { return await fn(opts); } finally { await releaseRequest(requestId); }
}

const revokeBlob = (blobUrl) => chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl }).catch(() => {});

async function saveBlob(blobUrl, filename, jobId = '') {
  if (updates.isApplying?.()) throw new Error('The Windows updater is applying an update. Retry after the extension reloads.');
  const pending = 'pending:' + generationId(), record = { blobUrl, filename, jobId, createdAt: Date.now() };
  let acceptedId;
  downloadBlobs.set(pending, record);
  try {
    await persistDownloads();
    const id = await chrome.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: 'uniquify' });
    acceptedId = id;
    if (downloadBlobs.has(pending)) { downloadBlobs.delete(pending); downloadBlobs.set(id, record); }
    const j = jobs.get(jobId);
    if (j && !terminalJob(j.state)) { j.downloadId = id; j.state = 'saving'; j.phase = 'Saving file'; }
    await persistDownloads();
    if (j?.cancelRequested) await chrome.downloads.cancel(id).catch(() => {});
    // onChanged can fire before download() resolves or before the ownership record is stored.
    const [download] = await chrome.downloads.search({ id });
    if (download) await finishDownload(download);
    return id;
  } catch (err) {
    // Once Chrome owns a download, only a terminal browser event may release its blob.
    if (acceptedId != null) { console.warn('[AO] save queued; tracking will retry on the browser event:', err.message); return acceptedId; }
    if (downloadBlobs.has(pending)) { downloadBlobs.delete(pending); await persistDownloads().catch(() => {}); revokeBlob(blobUrl); }
    throw err;
  }
}

async function finishDownload(download) {
  if (!['complete', 'interrupted'].includes(download.state)) return;
  const record = downloadBlobs.get(download.id);
  if (!record) return;
  const j = jobs.get(record.jobId);
  if (j && !terminalJob(j.state)) {
    j.state = download.state === 'complete' ? 'done' : j.cancelRequested ? 'cancelled' : 'error';
    j.phase = j.state === 'done' ? 'Saved' : j.state === 'cancelled' ? 'Cancelled' : 'Save interrupted';
    j.message = j.state === 'error' ? 'Chrome interrupted the save (' + (download.error || 'UNKNOWN') + '). Retry Download; reopen the lecture if the link expired.' : j.state === 'cancelled' ? 'Cancelled' : (j.notice || '');
    j.finishedAt = Date.now(); j.downloadId = download.id;
    if (download.state === 'complete') j.done = j.total || j.done;
  }
  downloadBlobs.delete(download.id);
  await persistDownloads().catch((err) => console.warn('[AO] terminal save state persistence failed:', err.message));
  revokeBlob(record.blobUrl);
  if (j) gm.onJobUpdate({ type: 'off:job', jobId: j.id, state: j.state, message: j.message, filename: j.filename }, j);
}

chrome.downloads.onCreated.addListener((download) => {
  ready.then(async () => {
    const pending = [...downloadBlobs.entries()].find(([id, record]) => typeof id === 'string' && record.blobUrl === download.url);
    if (!pending) return;
    const [key, record] = pending;
    downloadBlobs.delete(key); downloadBlobs.set(download.id, record);
    const j = jobs.get(record.jobId);
    if (j && !terminalJob(j.state)) { j.downloadId = download.id; j.state = 'saving'; }
    await persistDownloads();
    if (j?.cancelRequested) await chrome.downloads.cancel(download.id).catch(() => {});
    const [current] = await chrome.downloads.search({ id: download.id });
    if (current) await finishDownload(current);
  }).catch((err) => console.warn('[AO] download tracking failed:', err.message));
});

chrome.downloads.onChanged.addListener((d) => {
  if (!d.state || d.state.current === 'in_progress') return;
  ready.then(async () => {
    const [download] = await chrome.downloads.search({ id: d.id }).catch(() => []);
    await finishDownload(download && ['complete', 'interrupted'].includes(download.state) ? download :
      { id: d.id, state: d.state.current, error: d.error?.current || download?.error });
  }).catch((err) => console.warn('[AO] download completion tracking failed:', err.message));
});

async function recoverDownloads() {
  for (const [id, record] of [...downloadBlobs]) {
    let list;
    try { list = await chrome.downloads.search(typeof id === 'number' ? { id } : { url: record.blobUrl }); }
    catch (err) { continue; }
    const download = list.find((d) => d.url === record.blobUrl || d.id === id);
    if (download) {
      if (typeof id !== 'number') { downloadBlobs.delete(id); downloadBlobs.set(download.id, record); }
      const j = jobs.get(record.jobId);
      if (j && !terminalJob(j.state)) { j.state = 'saving'; j.downloadId = download.id; }
      if (j?.cancelRequested && download.state === 'in_progress') await chrome.downloads.cancel(download.id).catch(() => {});
      const [current] = await chrome.downloads.search({ id: download.id });
      await finishDownload(current || download);
    } else {
      const j = jobs.get(record.jobId);
      if (j && !terminalJob(j.state)) {
        j.state = 'saving'; j.phase = 'Save status unavailable';
        j.message = 'Chrome no longer reports this save. Check browser Downloads before retrying; completion has not been confirmed.';
      }
      // Missing/erased history is not proof that an in-progress browser save stopped.
    }
  }
  let active = [];
  try {
    if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
      active = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'job-status' }))?.jobs || [];
    }
  } catch (err) {}
  for (const a of active) {
    if (a.state === 'ready' && a.result) {
      await jobUpdate({ ...a.result, jobId: a.id, state: 'ready' });
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'job-ack', jobId: a.id }).catch(() => {});
    } else if (jobs.get(a.id)?.state === 'cancelled') toCancelWorker(a.id);
  }
  for (const j of jobs.values()) if (j.state === 'running' && !active.some((a) => a.id === j.id)) {
    j.state = 'error'; j.finishedAt = Date.now(); j.message = 'The download worker stopped before saving. Retry Download; no completed file was confirmed.';
  }
  await persistDownloads();
}

/* ====================================================================== *
 * Config + plugins
 * ====================================================================== */
async function setConfig(patch) {
  const safe = {};
  const switches = new Set(FEATURES.map((feature) => feature.id));
  for (const [key, value] of Object.entries(patch || {})) {
    if (switches.has(key) || /^plugin:[\w-]+$/.test(key)) {
      if (typeof value === 'boolean') safe[key] = value;
    } else if (key === 'concurrency') {
      if (Number.isInteger(value) && value >= 2 && value <= 16) safe[key] = value;
    } else if (key === 'enabledSites' || key === 'disabledSites') {
      if (Array.isArray(value)) safe[key] = [...new Set(value.map(siteKey).filter(Boolean))].slice(0, 200);
    }
  }
  config = { ...config, ...safe };
  await chrome.storage.local.set({ cfg: config });
  await broadcastConfig();
  if (Object.keys(safe).some((k) => k.startsWith('plugin:'))) await syncPlugins();
  if ('enabledSites' in safe) await syncPageScripts();
}

async function resetConfig() {
  config = { ...DEFAULTS };
  await chrome.storage.local.set({ cfg: config });
  await broadcastConfig();
  await syncPlugins();
  await syncPageScripts();
}

async function broadcastConfig() {
  const list = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  await Promise.all(list.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'cfg', cfg: effectiveConfig(config, tab.url) }).catch(() => {})));
}

let pageScriptSync = Promise.resolve();
function syncPageScripts() {
  pageScriptSync = pageScriptSync.catch(() => {}).then(async () => {
    const ids = ['ao-sites-main', 'ao-sites-bridge'];
    const existing = (await chrome.scripting.getRegisteredContentScripts()).filter((script) => ids.includes(script.id));
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((script) => script.id) });
    const matches = [];
    for (const origin of Array.isArray(config.enabledSites) ? config.enabledSites : []) {
      if (!siteKey(origin) || isAllenSite(origin)) continue;
      if (await chrome.permissions.contains({ origins: [origin + '/*'] })) matches.push(origin + '/*');
    }
    if (matches.length) await chrome.scripting.registerContentScripts([
      { id: ids[0], matches, js: ['content/main.js'], world: 'MAIN', runAt: 'document_start', allFrames: true, matchOriginAsFallback: true },
      { id: ids[1], matches, js: ['content/content.js'], world: 'ISOLATED', runAt: 'document_start', allFrames: true, matchOriginAsFallback: true },
    ]);
  });
  return pageScriptSync;
}

async function setSiteFixes(tabId, enabled) {
  const tab = await chrome.tabs.get(tabId), origin = siteKey(tab.url);
  if (!origin) throw new Error('Page fixes work on normal HTTP or HTTPS websites, not browser-internal pages.');
  if (enabled && !(await chrome.permissions.contains({ origins: [origin + '/*'] }))) {
    throw new Error('Allow access to this website before enabling its page fixes.');
  }
  const disabledSites = (Array.isArray(config.disabledSites) ? config.disabledSites : []).filter((value) => value !== origin);
  const enabledSites = Array.isArray(config.enabledSites) ? [...config.enabledSites] : [];
  if (!enabled) disabledSites.push(origin);
  if (enabled && !isAllenSite(origin) && !enabledSites.includes(origin)) enabledSites.push(origin);
  await setConfig({ disabledSites, enabledSites });
  if (enabled) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/content.js'], world: 'ISOLATED' });
  }
  return { config, siteEnabled: siteFixesEnabled(config, tab.url) };
}

async function runTool(tabId, tool, value) {
  const tab = await chrome.tabs.get(tabId);
  if (!siteKey(tab.url)) throw new Error('This tool cannot modify browser-internal pages or the built-in PDF viewer. Open the original website instead.');
  if (tool === 'speed') {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error('Choose a playback speed between 0.25x and 4x.');
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (speed) => {
        let n = 0;
        for (const media of document.querySelectorAll('video, audio')) {
          try { media.playbackRate = speed; media.defaultPlaybackRate = speed; n++; } catch {}
        }
        return n;
      }, args: [rate],
    });
    return { n: results.reduce((total, frame) => total + (frame.result || 0), 0) };
  }
  if (!['overlays', 'restore-overlays', 'reading', 'text', 'links', 'print', 'fullscreen', 'scan'].includes(tool)) throw new Error('Unknown page tool.');
  const message = { type: 'tool:' + tool };
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); }
  catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message)) throw error;
    try {
      // activeTab is sufficient for an explicitly requested utility on the current page.
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/content.js'], world: 'ISOLATED' });
      return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (cause) { throw new Error('The page is not accessible. Reload it, reopen the toolbox, and allow this site if needed. ' + cause.message); }
  }
}

async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error('Return to the source website and open the toolbar popup to capture that tab.');
  if (!siteKey(tab.url)) throw new Error('Screenshots are available for normal websites.');
  return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
}

ready.then(syncPageScripts).catch((error) => console.warn('[AO] site registration:', error.message));
chrome.permissions.onAdded.addListener(() => ready.then(syncPageScripts).catch(() => {}));
chrome.permissions.onRemoved.addListener(() => ready.then(async () => { await syncPageScripts(); await broadcastConfig(); }).catch(() => {}));

async function pluginList() {
  try {
    const r = await fetch(chrome.runtime.getURL('plugins/plugins.json'));
    const list = await r.json();
    return list.filter((p) => p && p.id && (p.file || p.css)).map((p) => ({
      id: p.id, name: p.name || p.id, description: p.description || '', file: p.file || null, css: p.css || null,
      world: p.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN', runAt: p.runAt || 'document_start',
      matches: p.matches && p.matches.length ? p.matches : [ALLEN_MATCH],
      allFrames: p.allFrames !== false,
      enabled: config['plugin:' + p.id] !== undefined ? !!config['plugin:' + p.id] : p.enabled !== false,
    }));
  } catch (e) { return []; }
}

// Registers every enabled plugin as a content script so new ones need no manifest edits.
async function syncPlugins() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const old = existing.filter((s) => s.id.startsWith('ao-plugin-')).map((s) => s.id);
    if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old });
    const scripts = (await pluginList()).filter((p) => p.enabled).map((p) => ({
      id: 'ao-plugin-' + p.id, matches: p.matches, ...(p.file ? { js: [p.file] } : {}), ...(p.css ? { css: [p.css] } : {}),
      runAt: p.runAt, world: p.world, allFrames: p.allFrames, matchOriginAsFallback: true, persistAcrossSessions: true,
    }));
    if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
  } catch (e) { console.error('[AO] plugin registration failed:', e.message); }
}

chrome.runtime.onInstalled.addListener(() => ready.then(() => { syncPlugins(); gm.syncAll(); }));
chrome.runtime.onStartup.addListener(() => ready.then(() => { syncPlugins(); gm.syncAll(); }));

/* ====================================================================== *
 * Message handling
 * ====================================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  ready.then(() => handle(msg, sender)).then(sendResponse, (e) => sendResponse({ error: (e && e.message) || String(e), code: e && e.code, diag: e && e.diagText }));
  return true;
});

function findItem(tabId, id) {
  const it = tabState(tabId).items[id];
  if (!it) throw new Error('That item is no longer available — reopen the page');
  return it;
}

function requireOffscreen(sender) {
  if (sender.tab || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html')) {
    throw new Error('Only the extension download worker may send this message');
  }
}

async function handle(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;
  const downloadTabId = sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')) ? sender.tab.id : msg.tabId;
  switch (msg.type) {
    /* ---- from content scripts ---- */
    case 'get-config': return effectiveConfig(config, sender.tab && sender.tab.url || sender.url);
    case 'found': {
      const ctx = contentContext(tabId, sender, msg.context);
      if (ctx) addItems(tabId, sender.frameId, /^https?:/i.test(ctx.pageHref) ? ctx.pageHref : sender.url || (sender.tab && sender.tab.url) || '', msg.items, msg.title, ctx);
      return { ok: !!ctx };
    }
    case 'title': tabState(tabId).title = msg.title; return { ok: true };
    case 'route': return registerRoute(tabId, sender, msg);
    case 'ensure-offscreen': await offscreen('ping'); return { ok: true };

    /* ---- from the offscreen worker ---- */
    case 'off:pdf-info': requireOffscreen(sender); return pdfInfo(msg);
    case 'off:pdf-evicted': requireOffscreen(sender); return pdfEvicted(msg);
    case 'off:job': requireOffscreen(sender); return jobUpdate(msg);
    case 'off:request-acquire': requireOffscreen(sender); return acquireRequest(msg);
    case 'off:request-release': requireOffscreen(sender); return releaseRequest(msg.requestId);
    case 'off:log': console.warn('[offscreen]', msg.text); return { ok: true };

    /* ---- from the popup ---- */
    case 'state': return popupState(msg.tabId);
    case 'set-config': await setConfig(msg.patch); return config;
    case 'set-site-fixes': return setSiteFixes(msg.tabId, !!msg.enabled);
    case 'reset-config': await resetConfig(); return config;
    case 'plugins': return pluginList();
    case 'clear': clearTab(msg.tabId, { notify: true }); return { ok: true };
    case 'pdf-save': return pdfSave({ ...msg, tabId: downloadTabId });
    case 'pdf-open': return pdfOpen({ ...msg, tabId: downloadTabId });
    case 'pdf-text': {
      const it = latestPdfItem(downloadTabId, msg.id);
      try { return await withPdfContext(it, (opts) => offscreen('pdf-text', { url: it.url, ...opts })); }
      catch (e) { e.diagText = buildDiag(it, e.diag, 'PDF text'); throw e; }
    }
    case 'hls-info': return hlsInfo({ ...msg, tabId: downloadTabId });
    case 'hls-preview': return hlsPreview({ ...msg, tabId: downloadTabId });
    case 'job-start': return jobStart({ ...msg, tabId: downloadTabId });
    case 'job-cancel': {
      const j = jobs.get(msg.jobId);
      if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')) && j && j.tabId !== downloadTabId) throw new Error('A page cannot cancel another tab\'s download');
      return jobCancel(msg);
    }
    case 'us:list': return gm.listScripts();
    case 'us:save': return gm.saveScript(msg);
    case 'us:delete': await gm.removeScript(msg.id); return { ok: true };
    case 'us:toggle': return gm.toggleScript(msg.id, msg.enabled);
    case 'us:get': return gm.getCode(msg.id);
    case 'us:fetch': {
      if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Only the extension editor may import script source');
      return gm.fetchSource(msg.url);
    }
    case 'us:scan-bundles': return gm.scanBundles();
    case 'us:bundle-export': return gm.exportBundle();
    case 'us:menu': return gm.menuList(msg.tabId);
    case 'us:menu-run': return gm.runMenu(msg.tabId, msg.scriptId, msg.frameId, msg.cmdId);
    case 'updates:get':
    case 'updates:configure':
    case 'updates:check':
    case 'updates:install':
    case 'updates:download': {
      if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('popup/popup.html')) {
        throw new Error('Only the extension update controls may send this message');
      }
      if (msg.type === 'updates:configure') return updates.configure(msg);
      if (msg.type === 'updates:check') return updates.check({ force: true });
      if (msg.type === 'updates:install') return updates.install();
      if (msg.type === 'updates:download') return updates.download();
      return updates.status();
    }
    case 'tool': return runTool(msg.tabId, msg.tool, msg.value);
    case 'capture-tab': return captureTab(msg.tabId);
    default: throw new Error('Unknown message: ' + msg.type);
  }
}

/* ---- PDFs ---- */
function pdfInfo({ url, scope, captureId, capturedAt, info, size, available }) {
  for (const [tabId, st] of tabs) {
    for (const it of Object.values(st.items)) {
      if (it.kind !== 'pdf' || it.url !== url || it.scope !== scope || (captureId && it.captureId && captureId !== it.captureId) || (capturedAt && capturedAt < it.ts)) continue;
      if (info && info.error) { it.pdfError = info.error; it.uploaded = false; }
      else {
        if (info && info.title) { it.title = info.title; it.titleSrc = info.src; }
        if (info && info.pages) it.pages = info.pages;
        if (size) it.size = size;
        it.uploaded = available !== false;
        delete it.pdfError;
        delete it.captureError;
      }
      persistTab(tabId);
    }
  }
  return { ok: true };
}

function pdfEvicted({ url, scope, captureId }) {
  for (const [tabId, st] of tabs) for (const it of Object.values(st.items)) {
    if (it.kind === 'pdf' && it.url === url && it.scope === scope && (!captureId || it.captureId === captureId)) {
      it.uploaded = false; persistTab(tabId);
    }
  }
  return { ok: true };
}

function latestPdfItem(tabId, id) {
  const it = tabState(tabId).items[id];
  if (!it) throw new PdfError('PDF_STALE', 'That PDF capture is no longer current. ' + PDF_REOPEN);
  if (it.kind !== 'pdf') throw new Error('That item is not a PDF');
  return it;
}

function currentPdf(it) {
  const st = tabs.get(it.tabId), cur = st && st.items[it.id];
  if (!cur || cur.scope !== it.scope || cur.captureId !== it.captureId) return false;
  return latestPdfItem(it.tabId, it.id).id === it.id;
}

async function pdfNavigationFallback(it) {
  if (!currentPdf(it)) throw new PdfError('PDF_STALE', 'The viewer changed while the PDF was loading. ' + PDF_REOPEN);
  await chrome.tabs.create({ url: it.url });
  return { fallback: true, message: 'Opened the captured stream URL; no download has been confirmed. The browser tab may still require the ALLEN viewer\'s authentication.' };
}

async function pdfPrepare(msg, open) {
  const it = latestPdfItem(msg.tabId, msg.id);
  try {
    const r = await withPdfContext(it, (opts) => offscreen('pdf-prepare', { url: it.url, name: msg.name, preferText: !!config.pdfPreferText, open: !!open, ...opts }));
    if (!currentPdf(it)) {
      if (r && r.blobUrl) chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl: r.blobUrl }).catch(() => {});
      throw new PdfError('PDF_STALE', 'The viewer changed while the PDF was loading. ' + PDF_REOPEN);
    }
    pdfInfo({ url: it.url, scope: it.scope, captureId: it.captureId, info: r.info, size: r.size, available: r.cached });
    return r;
  } catch (e) {
    if (e.code === 'PDF_NETWORK' && isViewerStream(it.url)) return pdfNavigationFallback(it);
    e.diagText = buildDiag(it, e.diag, 'PDF');
    throw e;
  }
}
async function pdfSave(msg) {
  if (updates.isApplying?.()) throw new Error('The Windows updater is applying an update. Retry after the extension reloads.');
  fileOperations++;
  try {
    const r = await pdfPrepare(msg, false);
    if (r.fallback) return r;
    const downloadId = await saveBlob(r.blobUrl, r.filename);
    const [download] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
    if (download?.state === 'interrupted') throw new Error('Chrome interrupted the PDF save (' + (download.error || 'UNKNOWN') + '). Retry Save PDF.');
    return { filename: r.filename, captured: r.captured, message: r.message, downloadId,
      queued: download?.state !== 'complete', state: download?.state === 'complete' ? 'done' : 'saving' };
  } finally { fileOperations--; }
}
async function pdfOpen(msg) {
  const r = await pdfPrepare(msg, true);
  if (r.fallback) return r;
  try { await chrome.tabs.create({ url: r.blobUrl }); }
  catch (e) { chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl: r.blobUrl }).catch(() => {}); throw e; }
  return { filename: r.filename, captured: r.captured, message: r.message };
}

/* ---- HLS ---- */
const itemCacheKey = (it) => it.tabId + ':' + it.frameId + ':' + it.scope + '\n' + it.url;
const previewKey = (it, quality, mode) => itemCacheKey(it) + '\n' + quality + '\n' + mode;

async function hlsInfo(msg) {
  const it = findItem(msg.tabId, msg.id);
  if (it.kind !== 'hls') throw new Error('That item is not an HLS recording');
  const key = itemCacheKey(it), hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60e3 && !msg.refresh) return hit.data;
  let data;
  try { data = await offscreen('hls-info', { url: it.url, context: it }); }
  catch (e) { e.diagText = buildDiag(it, e.diag, 'playlist'); throw e; }
  infoCache.delete(key); infoCache.set(key, { at: Date.now(), data });
  while (infoCache.size > 30) infoCache.delete(infoCache.keys().next().value);
  if (data.kind === 'master') {
    // the individual quality playlists belong to this recording — don't list them again
    const st = tabState(msg.tabId);
    st.children = [...new Set([...(st.children || []), ...data.options.map((o) => o.url), ...data.options.map((o) => o.audioUrl).filter(Boolean)])];
    persistTab(msg.tabId); updateBadge(msg.tabId);
  }
  return data;
}

async function hlsPreview(msg) {
  const it = findItem(msg.tabId, msg.id), info = await hlsInfo(msg);
  const option = info.options.find((o) => o.id === msg.quality);
  if (!option) throw new Error('That quality is no longer available. Refresh the recording and choose a listed quality.');
  const output = selectOutput(option, msg.mode);
  let data;
  try { data = await offscreen('hls-preview', { url: output.url, option, mode: output.mode, context: it }); }
  catch (err) { err.diagText = buildDiag(it, err.diag, 'download preview'); throw err; }
  if (tabState(it.tabId).items[it.id]?.scope !== it.scope) throw new Error('The recording changed. Reopen it and choose a current quality.');
  data = { ...data, ...output, quality: option.id, audioUrl: option.audioUrl || null };
  const key = previewKey(it, option.id, output.mode);
  previewCache.delete(key); previewCache.set(key, { at: Date.now(), data, option });
  while (previewCache.size > 20) previewCache.delete(previewCache.keys().next().value);
  return data;
}

async function jobStart(msg) {
  if (updates.isApplying?.()) throw new Error('The Windows updater is applying an update. Retry after the extension reloads.');
  const it = findItem(msg.tabId, msg.id);
  const kind = msg.kind || (it.kind === 'media' ? 'http' : 'hls');
  if (kind !== 'http' && kind !== 'hls') throw new Error('Unsupported download kind');
  if ((kind === 'http' && it.kind !== 'media') || (kind === 'hls' && it.kind !== 'hls')) throw new Error('Choose a current detected recording');
  if (!['audio', 'video'].includes(msg.mode) || (kind === 'http' && msg.mode !== 'video')) throw new Error('Unsupported download mode');
  let output = { url: it.url, mode: 'video', outputRole: /^audio\//i.test(it.ct) ? 'audio' : 'video', notice: '' }, option, preview;
  if (kind === 'hls') {
    const info = await hlsInfo(msg);
    option = info.options.find((o) => o.id === msg.quality);
    if (!option) throw new Error('Choose a listed quality; arbitrary stream URLs cannot be downloaded.');
    output = selectOutput(option, msg.mode);
    const key = previewKey(it, option.id, output.mode), cached = previewCache.get(key);
    preview = cached && cached.data.url === output.url && Date.now() - cached.at < 60000 ? cached.data : await hlsPreview({ ...msg, mode: output.mode });
    const origins = preview.hosts.map((host) => new URL(host).origin + '/*');
    if (!(await chrome.permissions.contains({ origins }))) throw new DownloadError('DOWNLOAD_PERMISSION', 'Allow all the recording hosts shown in the download preview, then retry Download.');
    previewCache.delete(key);
  } else {
    const url = new URL(it.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error('This media link must be reopened as a current HTTP(S) recording');
    if (!(await chrome.permissions.contains({ origins: [url.origin + '/*'] }))) throw new DownloadError('DOWNLOAD_PERMISSION', 'Allow host access to ' + url.hostname + ' before downloading.');
  }
  if (updates.isApplying?.()) throw new Error('The Windows updater is applying an update. Retry after the extension reloads.');
  const job = {
    id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    tabId: msg.tabId, itemId: msg.id, mode: output.mode, kind, state: 'running', phase: 'Starting...',
    done: 0, total: 0, bytes: 0, message: '', filename: '', startedAt: Date.now(),
    outputRole: output.outputRole, notice: output.notice,
  };
  jobs.set(job.id, job);
  try {
    await persistDownloads();
    await offscreen('job-start', { jobId: job.id, kind, url: output.url, mode: output.mode, name: msg.name, option,
      previewId: preview?.previewId, context: it, concurrency: config.concurrency });
  } catch (err) {
    if (job.state === 'saving' || job.state === 'done') return { jobId: job.id, outputRole: job.outputRole, notice: job.notice };
    if (job.state === 'running') { job.state = 'error'; job.message = err.message; job.finishedAt = Date.now(); await persistJobs(); toCancelWorker(job.id); }
    throw err;
  }
  return { jobId: job.id, outputRole: job.outputRole, notice: job.notice };
}

const toCancelWorker = (jobId) => chrome.runtime.sendMessage({ target: 'offscreen', type: 'job-cancel', jobId }).catch(() => {});

async function jobCancel({ jobId }) {
  const j = jobs.get(jobId);
  if (!j || terminalJob(j.state)) return { ok: true };
  j.cancelRequested = true;
  if (j.state === 'saving') {
    j.phase = 'Cancelling save'; await persistJobs();
    if (j.downloadId != null) {
      try { await chrome.downloads.cancel(j.downloadId); }
      catch (err) {
        const [download] = await chrome.downloads.search({ id: j.downloadId }).catch(() => []);
        if (!download || !['complete', 'interrupted'].includes(download.state)) throw err;
        await finishDownload(download); return { ok: true };
      }
      const [download] = await chrome.downloads.search({ id: j.downloadId });
      if (download) await finishDownload(download);
    }
  } else {
    j.state = 'cancelled'; j.phase = 'Cancelled'; j.message = 'Cancelled'; j.finishedAt = Date.now();
    await persistJobs(); await offscreen('job-cancel', { jobId });
    gm.onJobUpdate({ jobId, state: 'cancelled', message: 'Cancelled' }, j);
  }
  return { ok: true };
}

async function jobUpdate(m) {
  const j = jobs.get(m.jobId);
  if (!j || terminalJob(j.state) || j.state === 'saving') {
    if (m.blobUrl && ![...downloadBlobs.values()].some((r) => r.blobUrl === m.blobUrl)) revokeBlob(m.blobUrl);
    return { ok: true };
  }
  if (!['running', 'ready', 'error', 'cancelled'].includes(m.state)) return { ok: true };
  j.state = m.state === 'ready' ? 'saving' : m.state;
  if (m.phase) j.phase = m.phase;
  if (m.done !== undefined) { j.done = m.done; j.total = m.total; j.bytes = m.bytes; }
  if (m.speed !== undefined) j.speed = m.speed;
  if (m.unit) j.unit = m.unit;
  if (m.message) j.message = m.message;
  if (m.outputRole) j.outputRole = m.outputRole;
  if (m.notice) j.notice = m.notice;
  if (m.state === 'error' && m.diag) {
    const st = tabs.get(j.tabId), it = st && st.items[j.itemId];
    if (it) j.diag = buildDiag(it, m.diag, 'download');
  }
  if (m.state === 'ready') {
    j.filename = m.filename; j.bytes = m.size || j.bytes; j.phase = 'Saving file';
    try { await saveBlob(m.blobUrl, m.filename, j.id); }
    catch (e) { if (!terminalJob(j.state)) { j.state = 'error'; j.message = 'Chrome could not queue the save. ' + e.message + ' Retry Download.'; j.finishedAt = Date.now(); } }
  }
  if (m.state === 'error' || m.state === 'cancelled') j.finishedAt = Date.now();
  await persistJobs();
  if (m.state !== 'ready') gm.onJobUpdate({ ...m, state: j.state }, j);
  else if (j.state === 'error') gm.onJobUpdate({ ...m, state: 'error', message: j.message }, j);
  return { ok: true };
}

/* ---- helpers the userscript manager uses ---- */
function listItems(tabId) {
  return visibleItems(tabState(tabId)).map((it) => ({ id: it.id, kind: it.kind, title: it.title || '', size: it.size || 0, url: it.url, uploaded: !!it.uploaded }));
}

async function saveItem(tabId, id, opts) {
  const it = findItem(tabId, id);
  if (it.kind === 'pdf') { const r = await pdfSave({ tabId, id, name: opts.name }); return r.fallback ? { ...r, started: false } : { started: true, filename: r.filename }; }
  if (it.kind === 'media') { const r = await jobStart({ tabId, id, kind: 'http', mode: 'video', name: opts.name }); return { started: true, jobId: r.jobId }; }
  if (it.kind === 'hls') {
    const info = await hlsInfo({ tabId, id });
    const pick = opts.quality == null ? info.options[0] : info.options.find((o) => o.id === opts.quality);
    if (!pick) throw new Error('Choose a listed recording quality');
    const r = await jobStart({ tabId, id, kind: 'hls', quality: pick.id, mode: opts.mode === 'audio' ? 'audio' : (pick.type === 'audio' ? 'audio' : 'video'), name: opts.name });
    return { started: true, jobId: r.jobId };
  }
  throw new Error('This kind of item cannot be saved yet (' + it.kind + ')');
}

async function startHttpJob({ url, name, exactName, referer, tabId }) {
  if (updates.isApplying?.()) throw new Error('The Windows updater is applying an update. Retry after the extension reloads.');
  const source = new URL(url);
  if (!/^https?:$/.test(source.protocol)) throw new Error('Only HTTP(S) files can be downloaded');
  if (!(await chrome.permissions.contains({ origins: [source.origin + '/*'] }))) throw new DownloadError('DOWNLOAD_PERMISSION', 'Allow host access to ' + source.hostname + ' before downloading.');
  const frame = tabs.get(tabId)?.frames?.[0] || {};
  const context = { ...frame, url: source.href, tabId, frameId: 0, referer: normRef(referer) };
  if (updates.isApplying?.()) throw new Error('The Windows updater is applying an update. Retry after the extension reloads.');
  const job = {
    id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), tabId, itemId: 'gm', mode: 'video', kind: 'http',
    state: 'running', phase: 'Starting…', done: 0, total: 0, bytes: 0, message: '', filename: '', startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  try { await persistDownloads(); await offscreen('job-start', { jobId: job.id, kind: 'http', url: source.href, mode: 'video', name, context, exactName: !!exactName, concurrency: config.concurrency }); }
  catch (err) {
    if (job.state === 'saving' || job.state === 'done') return job.id;
    if (job.state === 'running') { job.state = 'error'; job.message = err.message; job.finishedAt = Date.now(); await persistJobs(); toCancelWorker(job.id); }
    throw err;
  }
  return job.id;
}

const gm = initGM({ ready, offscreen, saveBlob, setReferer, listItems, saveItem, startHttpJob, acquireRequest, releaseRequest });
const updates = initUpdates({ acquireRequest, releaseRequest, busy: async () => {
  await ready;
  const downloading = await chrome.downloads.search({ state: 'in_progress' }).then((items) => items.length > 0).catch(() => true);
  if (fileOperations) return true;
  if ([...jobs.values()].some((job) => !terminalJob(job.state))) return true;
  if ([...requestLeases.values()].some((lease) => !lease.closed)) return true;
  return downloading || downloadBlobs.size > 0;
} });

/* ---- popup state ---- */
async function popupState(tabId) {
  const st = tabState(tabId);
  let tab = {};
  try { tab = await chrome.tabs.get(tabId); } catch (e) {}
  const items = visibleItems(st).sort((a, b) => b.ts - a.ts).map((it) => ({
    ...it, jobs: [...jobs.values()].filter((j) => j.tabId === tabId && j.itemId === it.id).slice(-1),
  }));
  const allSites = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  return { tabId, url: tab.url || '', title: st.title || tab.title || '', items, allSites, config, siteEnabled: siteFixesEnabled(config, tab.url), updates: await updates.status() };
}

/* ====================================================================== *
 * Keyboard shortcuts
 * ====================================================================== */
chrome.commands.onCommand.addListener(async (command) => {
  await ready;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const toast = (text) => chrome.tabs.sendMessage(tab.id, { type: 'toast', text }, { frameId: 0 }).catch(() => {});
  if (command === 'remove-overlays') return runTool(tab.id, 'overlays').catch((error) => toast(error.message));
  const pdfs = Object.values(tabState(tab.id).items).filter((i) => i.kind === 'pdf').sort((a, b) => (b.ts - a.ts) || ((b.captureOrder || 0) - (a.captureOrder || 0)));
  if (!pdfs.length) return toast('No PDF detected on this page yet');
  try {
    if (command === 'save-pdf') { const r = await pdfSave({ tabId: tab.id, id: pdfs[0].id }); toast(r.fallback ? r.message : (r.queued ? 'Queued ' : 'Saved ') + r.filename); }
    if (command === 'open-pdf') { const r = await pdfOpen({ tabId: tab.id, id: pdfs[0].id }); if (r.fallback || r.captured) toast(r.message); }
  } catch (e) { toast('Failed: ' + e.message); }
});
