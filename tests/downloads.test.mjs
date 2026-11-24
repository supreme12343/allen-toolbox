import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as download from '../shared/download.js';
import * as pdf from '../shared/pdf.js';
import * as names from '../shared/names.js';
import * as hls from '../shared/hls.js';
import * as features from '../shared/features.js';

const root = new URL('../', import.meta.url);
const bytes = (s) => new TextEncoder().encode(s);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => structuredClone(value);
const response = (body, headers = {}, status = 200) => new Response(body, { status, headers: { 'content-type': 'video/mp4', ...headers } });
const event = () => ({ listeners: [], addListener(fn, ...args) { this.listeners.push({ fn, args }); }, emit(value) { for (const { fn } of this.listeners) fn(value); } });
const item = (extra = {}) => ({ id: 'media:fixture', kind: 'media', url: 'https://media.test/lecture.mp4?token=fixture',
  tabId: 1, frameId: 0, documentId: 'document-a', scope: 'scope-a', routeAt: 10, ts: 20,
  pageHref: 'https://www.allenoverseas.com/lecture', referer: 'https://www.allenoverseas.com/lecture', ...extra });
const job = (id = 'job-a', extra = {}) => ({ id, tabId: 1, itemId: 'media:fixture', state: 'running', mode: 'video',
  kind: 'http', phase: 'Downloading', done: 10, total: 10, bytes: 10, filename: '', ...extra });

function brokenResponse(chunk, headers, { hang = false, error = new TypeError('connection dropped') } = {}) {
  let reads = 0, cancelled = false;
  const reader = {
    async read() { if (reads++ === 0 && chunk?.length) return { done: false, value: chunk }; if (hang) return new Promise(() => {}); throw error; },
    async cancel() { cancelled = true; }, releaseLock() {},
  };
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'video/mp4', ...headers }),
    body: { getReader: () => reader, async cancel() { cancelled = true; } }, get cancelled() { return cancelled; } };
}

async function backgroundHarness(options = {}) {
  const source = (await readFile(new URL('background.js', root), 'utf8')).replace(/^import .*;\r?$/gm, '');
  const session = plain(options.session || {}), local = { cfg: {} }, messages = [], gmEvents = [], rules = new Map();
  for (const rule of options.rules || []) rules.set(rule.id, rule);
  const dnrUpdates = [], downloads = new Map((options.downloads || []).map((d) => [d.id, plain(d)]));
  let nextId = 1, ruleQueries = 0;
  const events = { created: event(), changed: event(), before: event(), sent: event(), received: event() };
  const state = { session, messages, gmEvents, downloads, rules, dnrUpdates, events, cancels: [], saves: [] };
  const storage = (data) => ({
    async get(key) { if (key == null) return plain(data); if (typeof key === 'string') return { [key]: plain(data[key]) }; return plain(data); },
    async set(value) {
      if (options.failRunningPersistence && value.jobs?.some((j) => j.state === 'running')) throw new Error('Session storage unavailable');
      Object.assign(data, plain(value));
    }, async remove(key) { delete data[key]; },
  });
  const chrome = {
    runtime: { id: 'abcdefghijklmnopqrstuvwxabcdefgh', getURL: (path) => 'chrome-extension://abcdefghijklmnopqrstuvwxabcdefgh/' + path,
      getManifest: () => ({ version: 'test' }), onMessage: event(), onInstalled: event(), onStartup: event(),
      async getContexts() { return options.noOffscreen ? [] : [{}]; },
      async sendMessage(msg) {
        messages.push(plain(msg));
        if (options.offscreen) return options.offscreen(msg, state);
        if (msg.type === 'job-status') return { jobs: options.activeJobs || [] };
        return { ok: true };
      } },
    storage: { local: storage(local), session: storage(session) },
    permissions: { async contains(value) { return options.permission ? options.permission(value) : options.permission !== false; }, onAdded: event(), onRemoved: event() },
    declarativeNetRequest: { async getSessionRules() {
      if (++ruleQueries <= (options.failRuleQueries || 0)) throw new Error('rule query unavailable');
      return [...rules.values()];
    }, async updateSessionRules(change) {
      dnrUpdates.push(plain(change));
      if (change.addRules && options.failContext) throw new Error('DNR rejected');
      if (!change.addRules && options.failRemoval && change.removeRuleIds?.some((id) => rules.has(id))) throw new Error('rule removal unavailable');
      for (const id of change.removeRuleIds || []) rules.delete(id);
      for (const rule of change.addRules || []) rules.set(rule.id, plain(rule));
    } },
    downloads: { onCreated: events.created, onChanged: events.changed,
      async download(value) {
        state.saves.push(plain(value));
        if (options.download) return options.download(value, state);
        const id = nextId++, d = { id, url: value.url, filename: value.filename, state: 'in_progress' };
        downloads.set(id, d);
        if (options.onCreated) events.created.emit(plain(d));
        if (options.completeBeforeResolve) { d.state = 'complete'; events.changed.emit({ id, state: { current: 'complete' } }); }
        return id;
      },
      async search(query) { if (options.search) return options.search(query, state); return [...downloads.values()].filter((d) => query.id != null ? d.id === query.id : d.url === query.url).map(plain); },
      async cancel(id) { state.cancels.push(id); if (options.cancel) return options.cancel(id, state); const d = downloads.get(id); if (d) { d.state = 'interrupted'; d.error = 'USER_CANCELED'; events.changed.emit({ id, state: { current: 'interrupted' } }); } },
    },
    offscreen: { async createDocument() {} },
    tabs: { onRemoved: event(), async get() { return { url: 'https://www.allenoverseas.com/lecture' }; }, async query() { return []; },
      async sendMessage() {}, async create(value) { messages.push({ type: 'created-tab', ...value }); return { id: 5 }; } },
    webNavigation: { onCommitted: event() }, webRequest: { onBeforeRequest: events.before, onSendHeaders: events.sent, onHeadersReceived: events.received },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
    scripting: { async getRegisteredContentScripts() { return []; }, async registerContentScripts() {}, async unregisterContentScripts() {} },
    commands: { onCommand: event() },
  };
  const context = vm.createContext({ ...features, ...pdf, DownloadError: download.DownloadError, selectOutput: hls.selectOutput,
    safeBase: names.safeBase, chrome, URL, setTimeout, clearTimeout, console: { warn() {}, error() {} },
    initGM: () => ({ onJobUpdate(m, j) { gmEvents.push({ m: plain(m), j: plain(j) }); }, clearTabMenus() {}, syncAll() {} }),
    initUpdates: () => ({ async status() { return {}; }, async configure() { return {}; }, async check() { return {}; }, async download() { return {}; } }) });
  new vm.Script(source + '\n globalThis.api = { ready, jobs, tabs, reqHeaders, downloadBlobs, requestQueues, acquireRequest, releaseRequest, saveBlob, jobUpdate, jobCancel, withPdfContext, pdfSave, buildDiag, handle, hlsInfo, hlsPreview, jobStart };', { filename: 'background.js' }).runInContext(context);
  state.api = context.api; state.chrome = chrome;
  await state.api.ready;
  return state;
}

async function offscreenHarness(fetch) {
  const source = (await readFile(new URL('offscreen.js', root), 'utf8')).replace(/^import .*;\r?$/gm, '');
  const messages = [], blobs = new Map(), revoked = [], listener = event();
  class ObjectURL extends URL {}
  ObjectURL.createObjectURL = (blob) => { const url = 'blob:fixture-' + blobs.size; blobs.set(url, blob); return url; };
  ObjectURL.revokeObjectURL = (url) => { revoked.push(url); blobs.delete(url); };
  const chrome = { runtime: { id: 'fixture', getURL: (p) => 'chrome-extension://fixture/' + p, onMessage: listener,
    async sendMessage(msg) { messages.push(plain(msg)); return msg.type === 'off:request-acquire' ? { requestId: msg.requestId } : { ok: true }; } } };
  const wrapped = Object.fromEntries(['withResponse', 'fetchBytes', 'fetchBuffer', 'fetchText', 'downloadFile'].map((name) => [name, (url, opts, consume) => download[name](url, { ...opts, fetch, retryDelay: 0 }, consume)]));
  const context = vm.createContext({ ...download, ...wrapped, ...names, ...pdf, ...hls,
    pdfjs: { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({ numPages: 1, async getMetadata() { return { info: { Title: 'Physics DPP' } }; },
      async getPage() { return { async getTextContent() { return { items: [] }; }, cleanup() {} }; }, async destroy() {} }) }; } },
    TsAudioDemuxer: class {}, chrome, self: { addEventListener() {} }, crypto: globalThis.crypto, URL: ObjectURL,
    Blob, Uint8Array, TextDecoder, AbortController, DOMException, setTimeout, clearTimeout, atob, console });
  new vm.Script(source + '\n globalThis.api = { pdfs, releasedScopes, pdfPrepare, pdfChunk, handle, runHttp };', { filename: 'offscreen.js' }).runInContext(context);
  return { api: context.api, messages, blobs, revoked, listener };
}

test('transient HTTP statuses and network failures retry, but auth and permanent statuses do not', async (t) => {
  let calls = 0;
  const result = await download.fetchBuffer('https://fixture.test/file', { retryDelay: 0, fetch: async () => {
    calls++; if (calls === 1) throw new TypeError('network'); return calls === 2 ? response(null, {}, 503) : response(bytes('complete'), { 'content-length': '8' });
  } });
  assert.equal(new TextDecoder().decode(result), 'complete'); assert.equal(calls, 3);
  for (const status of [400, 401, 403, 404, 410, 416]) await t.test('HTTP ' + status, async () => {
    let n = 0;
    await assert.rejects(download.fetchBuffer('https://fixture.test/file', { retryDelay: 0, fetch: async () => { n++; return response(null, {}, status); } }), (e) => e.diag.status === status);
    assert.equal(n, 1);
  });
  for (const status of [408, 425, 429, 500, 502, 503, 504]) await t.test('retry HTTP ' + status, async () => {
    let n = 0;
    await download.fetchBuffer('https://fixture.test/file', { retryDelay: 0, fetch: async () => ++n === 1 ? response(null, {}, status) : response(bytes('ok')) });
    assert.equal(n, 2);
  });
});

test('retry includes failed or truncated bodies and never returns their partial bytes', async () => {
  let calls = 0;
  const result = await download.fetchBuffer('https://fixture.test/file', { retryDelay: 0, fetch: async () => {
    calls++; return calls === 1 ? brokenResponse(bytes('bad'), { 'content-length': '8' }) : response(bytes('complete'), { 'content-length': '8' });
  } });
  assert.equal(new TextDecoder().decode(result), 'complete'); assert.equal(calls, 2);
  await assert.rejects(download.fetchBuffer('https://fixture.test/file', { tries: 2, retryDelay: 0, fetch: async () => response(bytes('short'), { 'content-length': '100' }) }), { code: 'DOWNLOAD_PARTIAL' });
});

test('connect and idle deadlines abort the fetch and release request leases', async () => {
  const leases = [], releases = []; let signal;
  const context = { async acquire() { leases.push('lease'); return 'lease'; }, async release(id) { releases.push(id); } };
  await assert.rejects(download.fetchBuffer('https://fixture.test/file', { tries: 1, connectTimeout: 8, context,
    fetch: (url, opts) => { signal = opts.signal; return new Promise(() => {}); } }), { code: 'DOWNLOAD_TIMEOUT' });
  assert.equal(signal.aborted, true); assert.deepEqual(releases, leases);
  const stalled = brokenResponse(bytes('a'), {}, { hang: true });
  await assert.rejects(download.fetchBuffer('https://fixture.test/file', { tries: 1, idleTimeout: 8, context, fetch: async () => stalled }), { code: 'DOWNLOAD_TIMEOUT' });
  assert.equal(stalled.cancelled, true); assert.equal(releases.length, 2);
});

test('cancellation aborts body reads and backoff without retrying or retaining a lease', async () => {
  const ctl = new AbortController(); let calls = 0, releases = 0;
  await assert.rejects(download.fetchBuffer('https://fixture.test/file', { signal: ctl.signal, fetch: async () => { calls++; return response(bytes('abc')); },
    context: { async acquire() { return 'lease'; }, async release() { releases++; } }, onBytes() { ctl.abort(); } }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(releases, 1);
  const delayCtl = new AbortController(), waiting = download.waitRetry(10000, delayCtl.signal);
  delayCtl.abort(); await assert.rejects(waiting, { name: 'AbortError' });
});

test('redirects do not forward captured credentials or expose response bodies', async () => {
  let opts, calls = 0;
  await assert.rejects(download.fetchBuffer('https://fixture.test/file', { fetch: async (url, value) => { calls++; opts = value; return response(null, { location: 'https://other.test/token' }, 302); } }), { code: 'DOWNLOAD_REDIRECT' });
  assert.equal(opts.redirect, 'manual'); assert.equal(calls, 1);
  const err = await download.fetchBuffer('https://fixture.test/file', { fetch: async () => response('SECRET_ECHO', { 'x-error': 'SECRET_ECHO' }, 403) }).catch((e) => e);
  assert.equal(JSON.stringify(err).includes('SECRET_ECHO'), false); assert.equal(err.message.includes('SECRET_ECHO'), false);
});

test('content ranges are anchored, finite, ordered and have a known valid total', () => {
  assert.deepEqual(download.parseContentRange('bytes 0-9/10'), { start: 0, end: 9, total: 10 });
  for (const value of ['bytes 0-9/*', 'bytes 4-3/10', 'bytes 0-10/10', 'bytes 1-2/0', 'prefix bytes 0-9/10', 'bytes 0-9/10 suffix', 'bytes 0-1/9007199254740993']) assert.equal(download.parseContentRange(value), null, value);
});

test('direct downloads use one complete GET, not a disposable HEAD or range probe', async () => {
  const requests = [];
  const out = await download.downloadFile('https://fixture.test/stream?token=fixture', { fetch: async (url, opts) => {
    requests.push(opts); return response(bytes('complete'), { 'content-length': '8', 'accept-ranges': 'bytes' });
  } });
  assert.equal(await out.blob.text(), 'complete'); assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].headers.Range, undefined);
});

test('invalid opening 206 responses cause a clean full refetch, never partial success', async (t) => {
  for (const range of [null, 'bytes 1-3/10', 'bytes 0-3/*', 'bytes 0-10/10', 'bytes 0-3/0']) await t.test(String(range), async () => {
    let calls = 0;
    const out = await download.downloadFile('https://fixture.test/file', { retryDelay: 0, fetch: async () => {
      calls++; return calls === 1 ? response(bytes('BAD'), { 'content-length': '3', ...(range ? { 'content-range': range } : {}) }, 206) : response(bytes('0123456789'), { 'content-length': '10' });
    } });
    assert.equal(await out.blob.text(), '0123456789'); assert.equal(calls, 2);
  });
  await assert.rejects(download.downloadFile('https://fixture.test/file', { tries: 1, fetch: async () => response(bytes('bad'), {}, 206) }), { code: 'DOWNLOAD_RANGE' });
});

test('validated leading bytes resume with exact intervals, total and If-Range across workers', async () => {
  const all = new Uint8Array(3 * 1024 * 1024 + 7).map((v, i) => i % 251), progress = [], requests = [];
  const out = await download.downloadFile('https://fixture.test/file', { concurrency: 3, retryDelay: 0, onProgress: (p) => progress.push(p), fetch: async (url, opts) => {
    requests.push(opts);
    if (!opts.headers.Range) return brokenResponse(all.slice(0, 7), { 'content-length': String(all.length), 'accept-ranges': 'bytes', etag: '"version-a"' });
    assert.equal(opts.headers['If-Range'], '"version-a"');
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range), start = +m[1], end = +m[2];
    return response(all.slice(start, end + 1), { 'content-range': `bytes ${start}-${end}/${all.length}`, 'content-length': String(end - start + 1), etag: '"version-a"' }, 206);
  } });
  assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), all);
  assert.ok(requests.length >= 4); assert.ok(progress.every((p) => p.bytes <= all.length));
});

test('capped contiguous 206 responses fetch every remainder instead of rejecting a valid prefix', async (t) => {
  for (const headers of [{ etag: '"version-a"' }, { etag: 'W/"version-a"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }]) await t.test(JSON.stringify(headers), async () => {
    const all = bytes('abcdefghijkl'), requests = [], progress = [];
    const out = await download.downloadFile('https://fixture.test/file', { concurrency: 2, onProgress: (p) => progress.push(p), fetch: async (url, opts) => {
      requests.push(opts);
      const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range || ''), start = m ? +m[1] : 0, end = Math.min(m ? +m[2] : all.length - 1, start + 3);
      if (m) assert.equal(opts.headers['If-Range'], headers.etag.startsWith('W/') ? headers['last-modified'] : headers.etag);
      return response(all.slice(start, end + 1), { ...headers, 'content-range': `bytes ${start}-${end}/${all.length}`, 'content-length': String(end - start + 1) }, 206);
    } });
    assert.equal(await out.blob.text(), 'abcdefghijkl');
    assert.deepEqual(requests.map((r) => r.headers.Range), [undefined, 'bytes=4-11', 'bytes=8-11']);
    assert.ok(progress.every((p, i) => p.bytes <= all.length && (!i || p.bytes >= progress[i - 1].bytes)));
  });
});

test('a clean zero-based retry can resume another valid prefix instead of requiring a whole-file response', async () => {
  const all = bytes('abcdefghijkl'), requests = [];
  const out = await download.downloadFile('https://fixture.test/file', { tries: 1, fetch: async (url, opts) => {
    requests.push(opts.headers.Range);
    if (!opts.headers.Range) return response(all.slice(4, 8), { etag: '"v"', 'content-range': 'bytes 4-7/12' }, 206);
    const m = /^bytes=(\d+)-(\d*)$/.exec(opts.headers.Range), start = +m[1], end = Math.min(m[2] ? +m[2] : 11, start + 3);
    return response(all.slice(start, end + 1), { etag: '"v"', 'content-range': `bytes ${start}-${end}/12` }, 206);
  } });
  assert.equal(await out.blob.text(), 'abcdefghijkl');
  assert.deepEqual(requests, [undefined, 'bytes=0-', 'bytes=4-11', 'bytes=8-11']);
});

test('a changed range restarts from zero and joins only the new entity even when the retry is capped', async () => {
  const fresh = bytes('NEW_COMPLETE'); let opening = true, changed = false;
  const out = await download.downloadFile('https://fixture.test/file', { tries: 1, fetch: async (url, opts) => {
    if (!opts.headers.Range || opts.headers.Range === 'bytes=0-') {
      if (opening) { opening = false; return response(bytes('old!'), { etag: '"old"', 'content-range': 'bytes 0-3/12' }, 206); }
      assert.equal(opts.headers.Range, 'bytes=0-');
      return response(fresh.slice(0, 4), { etag: '"new"', 'content-range': 'bytes 0-3/12' }, 206);
    }
    if (!changed) { changed = true; return response(bytes('xxxx'), { etag: '"new"', 'content-range': 'bytes 4-7/12' }, 206); }
    assert.equal(opts.headers['If-Range'], '"new"');
    const m = /^bytes=(\d+)-(\d+)$/.exec(opts.headers.Range), start = +m[1], end = Math.min(+m[2], start + 3);
    return response(fresh.slice(start, end + 1), { etag: '"new"', 'content-range': `bytes ${start}-${end}/12` }, 206);
  } });
  assert.equal(await out.blob.text(), 'NEW_COMPLETE');
});

test('an explicit complete range recovers a default prefix without joining unvalidated bytes', async () => {
  const requests = [], all = bytes('abcdefghijkl');
  const out = await download.downloadFile('https://fixture.test/file', { fetch: async (url, opts) => {
    requests.push(opts.headers.Range);
    if (!opts.headers.Range) return response(all.slice(0, 4), { 'content-range': 'bytes 0-3/12' }, 206);
    assert.equal(opts.headers.Range, 'bytes=0-');
    assert.equal(opts.headers['If-Range'], undefined);
    return response(all, { 'content-range': 'bytes 0-11/12' }, 206);
  } });
  assert.equal(await out.blob.text(), 'abcdefghijkl'); assert.deepEqual(requests, [undefined, 'bytes=0-']);
});

test('range recovery is bounded when every clean retry still changes the entity', async () => {
  let requests = 0, openings = 0;
  await assert.rejects(download.downloadFile('https://fixture.test/file', { tries: 1, fetch: async (url, opts) => {
    requests++;
    if (!opts.headers.Range || opts.headers.Range === 'bytes=0-') {
      openings++; return response(bytes('abcd'), { etag: '"a"', 'content-range': 'bytes 0-3/12' }, 206);
    }
    return response(bytes('efgh'), { etag: '"b"', 'content-range': 'bytes 4-7/12' }, 206);
  } }), { code: 'DOWNLOAD_CHANGED' });
  assert.equal(openings, 2); assert.equal(requests, 4);
});

test('ordinary and encoded failures retain a plain GET retry for servers that reject ranges', async (t) => {
  for (const failure of ['ordinary-body', 'unknown-total', 'encoded-body', 'encoded-range']) await t.test(failure, async () => {
    const requests = [];
    const out = await download.downloadFile('https://fixture.test/file', { tries: 1, fetch: async (url, opts) => {
      requests.push(opts.headers.Range);
      if (opts.headers.Range) return response(null, {}, 416);
      if (requests.length > 1) return response(bytes('NEW_COMPLETE'), { 'content-length': '12' });
      if (failure === 'encoded-range') return response(bytes('data'), { 'content-range': 'bytes 0-3/12', 'content-encoding': 'gzip' }, 206);
      return brokenResponse(bytes('data'), { ...(failure === 'ordinary-body' ? { 'content-length': '12' } : {}),
        ...(failure === 'encoded-body' ? { 'content-encoding': 'gzip', 'content-length': '2' } : {}) });
    } });
    assert.equal(await out.blob.text(), 'NEW_COMPLETE'); assert.deepEqual(requests, [undefined, undefined]);
  });
});

test('capped ranges retain all bytes and release the real same-URL background leases across workers', async () => {
  const bg = await backgroundHarness(), it = item(), all = new Uint8Array(3 * 1024 * 1024 + 7).map((v, i) => i % 251);
  let nextId = 0, held = 0, peak = 0, calls = 0;
  const context = {
    async acquire(url) {
      const id = 'capped:' + nextId++;
      await bg.api.acquireRequest({ url, context: it, requestId: id });
      peak = Math.max(peak, ++held); return id;
    },
    async release(id) { held--; await bg.api.releaseRequest(id); },
  };
  const out = await download.downloadFile(it.url, { context, concurrency: 3, fetch: async (url, opts) => {
    calls++; await tick();
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range || ''), start = m ? +m[1] : 0, end = Math.min(m ? +m[2] : 6, start + 128 * 1024 - 1);
    return response(all.slice(start, end + 1), { etag: '"v"', 'content-range': `bytes ${start}-${end}/${all.length}`, 'content-length': String(end - start + 1) }, 206);
  } });
  assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), all);
  assert.ok(calls > 20); assert.equal(peak, 1); assert.equal(held, 0); assert.equal(bg.rules.size, 0);
});

test('capped responses still reject truncated bodies and partial files without a usable validator', async () => {
  let calls = 0;
  await assert.rejects(download.downloadFile('https://fixture.test/file', { tries: 2, retryDelay: 0, fetch: async (url, opts) => {
    calls++;
    if (!opts.headers.Range) return response(bytes('abcd'), { etag: '"v"', 'content-range': 'bytes 0-3/12' }, 206);
    if (opts.headers.Range.startsWith('bytes=4-')) return response(bytes('efgh'), { etag: '"v"', 'content-range': 'bytes 4-7/12' }, 206);
    return response(bytes('ij'), { etag: '"v"', 'content-range': 'bytes 8-11/12' }, 206);
  } }), { code: 'DOWNLOAD_PARTIAL' });
  assert.equal(calls, 4);
  for (const headers of [{}, { etag: 'W/"v"' }]) {
    const requests = [];
    await assert.rejects(download.downloadFile('https://fixture.test/file', { fetch: async (url, opts) => {
      requests.push(opts.headers.Range);
      return response(bytes('abcd'), { ...headers, 'content-range': 'bytes 0-3/12' }, 206);
    } }), (e) => e.code === 'DOWNLOAD_RANGE' && /usable ETag or Last-Modified/.test(e.message));
    assert.deepEqual(requests, [undefined, 'bytes=0-']);
  }
});

test('a later capped span with no progress, wrong offsets or changed identity discards every old piece', async (t) => {
  for (const failure of ['start', 'total', 'etag', 'length', 'encoding', 'no-progress']) await t.test(failure, async () => {
    let fulls = 0;
    const out = await download.downloadFile('https://fixture.test/file', { tries: 1, fetch: async (url, opts) => {
      if (!opts.headers.Range || opts.headers.Range === 'bytes=0-') return ++fulls === 1 ? response(bytes('old!'), { etag: '"a"', 'content-range': 'bytes 0-3/12' }, 206) : response(bytes('NEW_COMPLETE'), { 'content-length': '12' });
      if (opts.headers.Range.startsWith('bytes=4-')) return response(bytes('old!'), { etag: '"a"', 'content-range': 'bytes 4-7/12' }, 206);
      return response(bytes('bad!'), { etag: failure === 'etag' ? '"b"' : '"a"',
        'content-range': `bytes ${failure === 'start' ? 7 : 8}-${failure === 'no-progress' ? 7 : 11}/${failure === 'total' ? 13 : 12}`,
        ...(failure === 'length' ? { 'content-length': '3' } : {}), ...(failure === 'encoding' ? { 'content-encoding': 'gzip' } : {}) }, 206);
    } });
    assert.equal(await out.blob.text(), 'NEW_COMPLETE'); assert.equal(fulls, 2);
  });
});

test('cancellation between capped spans prevents fetching or saving the remainder', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(download.downloadFile('https://fixture.test/file', { signal: controller.signal,
    onProgress: (p) => { if (p.bytes >= 8) controller.abort(); }, fetch: async (url, opts) => {
      calls++;
      const start = opts.headers.Range ? 4 : 0;
      return response(bytes('abcd'), { etag: '"v"', 'content-range': `bytes ${start}-${start + 3}/12` }, 206);
    } }), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('pathological tiny ranges have a finite request and Blob-part budget', async () => {
  let calls = 0;
  await assert.rejects(download.downloadFile('https://fixture.test/file', { fetch: async (url, opts) => {
    calls++;
    const m = /bytes=(\d+)-/.exec(opts.headers.Range || ''), offset = m ? +m[1] : 0;
    return response(bytes('x'), { etag: '"v"', 'content-range': `bytes ${offset}-${offset}/2048` }, 206);
  } }), { code: 'DOWNLOAD_RANGE_LIMIT' });
  assert.equal(calls, 1025);
});

test('invalid persisted concurrency cannot concatenate undefined into a size-matching corrupt file', async () => {
  const all = bytes('abcdefghijk');
  const out = await download.downloadFile('https://fixture.test/file', { concurrency: 'not-a-number', fetch: async (url, opts) => {
    if (!opts.headers.Range) return response(all.slice(0, 2), { 'content-range': 'bytes 0-1/11', etag: '"v"' }, 206);
    return response(all.slice(2), { 'content-range': 'bytes 2-10/11', etag: '"v"' }, 206);
  } });
  assert.equal(await out.blob.text(), 'abcdefghijk');
});

test('ignored ranges, changed validators and inconsistent totals discard all pieces before full refetch', async (t) => {
  for (const failure of ['ignored', 'start', 'end', 'total', 'etag', 'modified']) await t.test(failure, async () => {
    let initial = true, fulls = 0;
    const out = await download.downloadFile('https://fixture.test/file', { tries: 1, concurrency: 2, fetch: async (url, opts) => {
      if (!opts.headers.Range || opts.headers.Range === 'bytes=0-') {
        fulls++;
        if (initial) { initial = false; return response(bytes('old!'), { 'content-range': 'bytes 0-3/12', 'content-length': '4', etag: '"a"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }, 206); }
        return response(bytes('NEW_COMPLETE'), { 'content-length': '12', etag: '"b"' });
      }
      if (failure === 'ignored') return response(bytes('DO_NOT_JOIN!'), { 'content-length': '12' });
      const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range), a = +m[1], z = +m[2];
      return response(bytes('XXXXXXXX'), { 'content-range': `bytes ${failure === 'start' ? a + 1 : a}-${failure === 'end' ? z - 1 : z}/${failure === 'total' ? 13 : 12}`,
        etag: failure === 'etag' ? '"b"' : '"a"', 'last-modified': failure === 'modified' ? 'Tue, 02 Jan 2024 00:00:00 GMT' : 'Mon, 01 Jan 2024 00:00:00 GMT' }, 206);
    } });
    assert.equal(await out.blob.text(), 'NEW_COMPLETE'); assert.equal(fulls, 2);
  });
});

test('parallel range failure aborts peers and waits for their cleanup before rejecting', async () => {
  const all = 3 * 1024 * 1024; let peerSignal, peerStarted;
  const started = new Promise((resolve) => { peerStarted = resolve; });
  await assert.rejects(download.downloadFile('https://fixture.test/file', { tries: 1, concurrency: 2, fetch: async (url, opts) => {
    if (!opts.headers.Range) return response(bytes('a'), { 'content-range': `bytes 0-0/${all}`, etag: '"v"' }, 206);
    if (opts.headers.Range.startsWith('bytes=1-')) { await started; return response(null, {}, 403); }
    peerSignal = opts.signal; peerStarted(); return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
  } }), { code: 'DOWNLOAD_ACCESS' });
  assert.equal(peerSignal.aborted, true);
});

test('clean EOF shorter than Content-Length never creates a completed file', async () => {
  let calls = 0;
  await assert.rejects(download.downloadFile('https://fixture.test/file', { tries: 2, retryDelay: 0, fetch: async () => { calls++; return response(bytes('short'), { 'content-length': '100' }); } }), { code: 'DOWNLOAD_PARTIAL' });
  assert.equal(calls, 3);
});

test('decoded content ignores wire Content-Length and refuses encoded byte ranges', async () => {
  const out = await download.downloadFile('https://fixture.test/file', { fetch: async () => response(bytes('decoded'), { 'content-encoding': 'gzip', 'content-length': '2' }) });
  assert.equal(await out.blob.text(), 'decoded');
  await assert.rejects(download.fetchBuffer('https://fixture.test/file', { range: { offset: 0, end: 4 }, tries: 1,
    fetch: async () => response(bytes('data'), { 'content-range': 'bytes 0-3/4', 'content-encoding': 'gzip' }, 206) }), { code: 'DOWNLOAD_RANGE' });
});

test('HLS ranges validate exact 206 spans or slice a known complete 200 safely', async () => {
  const options = { range: { offset: 2, end: 5 }, sliceFull: true, tries: 1 };
  const result = await download.fetchBuffer('https://fixture.test/file', { ...options, fetch: async () => response(bytes('01234567'), { 'content-length': '8' }) });
  assert.equal(new TextDecoder().decode(result), '234');
  for (const headers of [{}, { 'content-length': '7' }, { 'content-range': 'bytes 1-3/8' }]) {
    await assert.rejects(download.fetchBuffer('https://fixture.test/file', { ...options, fetch: async () => response(bytes('01234567'), headers) }), (e) => ['DOWNLOAD_RANGE', 'DOWNLOAD_PARTIAL'].includes(e.code));
  }
  await assert.rejects(download.fetchBuffer('https://fixture.test/file', { ...options, fetch: async () => response(bytes('234'), { 'content-range': 'bytes 2-5/8' }, 206) }), { code: 'DOWNLOAD_RANGE' });
});

test('capped HLS ranges enforce byte limits, cancellation and a finite request budget', async (t) => {
  await t.test('byte limit before any request', async () => {
    let calls = 0;
    await assert.rejects(download.fetchBuffer('https://fixture.test/file', { range: { offset: 0, end: 8 }, maxBytes: 4,
      fetch: async () => { calls++; return response(bytes('data'), { etag: '"v"', 'content-range': 'bytes 0-3/8' }, 206); } }), { code: 'DOWNLOAD_TOO_LARGE' });
    assert.equal(calls, 0);
  });
  await t.test('cancel before consuming the next span', async () => {
    const controller = new AbortController(); let calls = 0, releases = 0;
    await assert.rejects(download.fetchBuffer('https://fixture.test/file', { range: { offset: 0, end: 8 }, signal: controller.signal,
      context: { async acquire() { return 'lease'; }, async release() { releases++; } },
      onResponse: () => { if (calls === 2) controller.abort(); }, fetch: async (url, opts) => {
        const start = calls++ * 4;
        return response(bytes('data'), { etag: '"v"', 'content-range': `bytes ${start}-${start + 3}/8` }, 206);
      } }), { name: 'AbortError' });
    assert.equal(calls, 2); assert.equal(releases, 2);
  });
  await t.test('tiny spans cannot issue requests indefinitely', async () => {
    let calls = 0;
    await assert.rejects(download.fetchBuffer('https://fixture.test/file', { range: { offset: 0, end: 2048 }, fetch: async (url, opts) => {
      calls++; const offset = Number(/^bytes=(\d+)-/.exec(opts.headers.Range)[1]);
      return response(bytes('x'), { etag: '"v"', 'content-range': `bytes ${offset}-${offset}/2048` }, 206);
    } }), { code: 'DOWNLOAD_RANGE_LIMIT' });
    assert.equal(calls, 1024);
  });
});

test('invalid validators cannot authorize joining capped HTTP or HLS ranges', async (t) => {
  for (const headers of [{ etag: 'null' }, { etag: 'not-an-etag' }, { etag: '"a", "b"' },
    { 'last-modified': 'unknown' }, { 'last-modified': '2024-01-01' }, { 'last-modified': 'Sat, 31 Feb 2024 00:00:00 GMT' },
    { etag: 'W/"v"', 'last-modified': 'unknown' }]) await t.test(JSON.stringify(headers), async () => {
    let calls = 0;
    const fetch = async (url, opts) => {
      calls++; const offset = Number(/^bytes=(\d+)-/.exec(opts.headers.Range || 'bytes=0-')[1]);
      return response(bytes('data'), { ...headers, 'content-range': `bytes ${offset}-${offset + 3}/8` }, 206);
    };
    await assert.rejects(download.fetchBuffer('https://fixture.test/file', { range: { offset: 0, end: 8 }, fetch }), { code: 'DOWNLOAD_RANGE' });
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(download.downloadFile('https://fixture.test/file', { fetch }), { code: 'DOWNLOAD_RANGE' });
    assert.equal(calls, 2);
  });
});

test('valid canonical and legacy HTTP-date validators remain usable for capped ranges', async (t) => {
  for (const modified of ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) await t.test(modified, async () => {
    let calls = 0;
    const result = await download.fetchBuffer('https://fixture.test/file', { range: { offset: 0, end: 8 }, fetch: async (url, opts) => {
      if (calls++) assert.equal(opts.headers['If-Range'], modified);
      const offset = Number(/^bytes=(\d+)-/.exec(opts.headers.Range)[1]);
      return response(bytes('data'), { etag: 'W/"v"', 'last-modified': modified, 'content-range': `bytes ${offset}-${offset + 3}/8` }, 206);
    } });
    assert.equal(new TextDecoder().decode(result), 'datadata'); assert.equal(calls, 2);
  });
});

test('file caps reject before saving and name decoding tolerates literal or malformed percent signs', async () => {
  await assert.rejects(download.downloadFile('https://fixture.test/file', { maxBytes: 4, fetch: async () => response(bytes('12345'), { 'content-length': '5' }) }), { code: 'DOWNLOAD_TOO_LARGE' });
  assert.equal(names.dispositionFilename('attachment; filename="100%.webm"'), '100%.webm');
  assert.equal(names.dispositionFilename("attachment; filename*=UTF-8''Physics%20DPP%20100%25.webm"), 'Physics DPP 100%.webm');
  assert.equal(names.dispositionFilename("attachment; filename*=UTF-8''bad%GG.mp4"), 'bad%GG.mp4');
  for (const ext of ['pdf', 'ts', 'mp4', 'm4v', 'm4a', 'aac', 'mp3', 'webm', 'weba', 'mov', 'mkv', 'ogg', 'oga', 'opus', 'wav', 'flac', 'bin']) assert.equal(names.safeBase('Lecture.' + ext, { strict: false }), 'Lecture');
  assert.equal(names.safeBase('Lecture.mp4.webm', { strict: false }), 'Lecture');
  assert.equal(names.safeBase('CON.txt', { strict: false }), '_CON.txt');
  assert.equal(names.safeFilename('NUL.webm'), '_NUL.webm');
  assert.equal(names.safeFilename('COM1 .mp4'), '_COM1 .mp4');
  assert.equal(names.safeBase('x'.repeat(119) + '.tail', { strict: false }), 'x'.repeat(119));
  assert.equal(names.safeFilename('x'.repeat(179) + '.tail'), 'x'.repeat(179));
  assert.equal(names.safeBase('\u6587\u6863.pdf', { strict: false }), '\u6587\u6863');
});

test('scoped header leases isolate exact URLs and tab/frame/route credentials', async () => {
  const bg = await backgroundHarness(), a = item(), b = item({ tabId: 2, scope: 'scope-b' });
  const header = (it, token) => ({ __tabId: it.tabId, __frameId: 0, __documentId: it.documentId, __scope: it.scope, __at: 20, authorization: token, cookie: token, 'x-token': token });
  bg.api.reqHeaders.set(a.scope + '\n' + a.url, header(a, 'SECRET_A'));
  bg.api.reqHeaders.set(b.scope + '\n' + b.url, header(b, 'SECRET_B'));
  bg.api.reqHeaders.set(a.url, header(b, 'SECRET_B'));
  await bg.api.acquireRequest({ context: a, url: a.url, requestId: 'first' });
  const first = [...bg.rules.values()].find((r) => r.action.type === 'modifyHeaders');
  assert.ok(first.action.requestHeaders.some((h) => h.value === 'SECRET_A'));
  assert.equal(first.action.requestHeaders.some((h) => h.value === 'SECRET_B'), false);
  assert.deepEqual(first.condition.initiatorDomains, [bg.chrome.runtime.id]);
  assert.deepEqual(first.condition.tabIds, [-1]); assert.deepEqual(first.condition.requestMethods, ['get']);
  const re = new RegExp(first.condition.regexFilter);
  assert.equal(re.test(a.url), true); assert.equal(re.test(a.url + '&other=1'), false);
  assert.equal(re.test('https://other.test/lecture.mp4?token=fixture'), false);
  await bg.api.acquireRequest({ context: { ...a, headers: { authorization: 'PARENT_ONLY' } }, url: 'https://media.test/other.ts', requestId: 'other' });
  const other = [...bg.rules.values()].filter((r) => r.action.type === 'modifyHeaders').find((r) => r.id !== first.id);
  assert.equal(other.action.requestHeaders.some((h) => ['SECRET_A', 'SECRET_B', 'PARENT_ONLY'].includes(h.value)), false);
  assert.equal(other.condition.requestDomains, undefined);
  await bg.api.releaseRequest('other'); await bg.api.releaseRequest('first');
  assert.equal(bg.rules.size, 0);
});

test('GM leases are exact, method-scoped and cleared before a plain extension fetch', async () => {
  const bg = await backgroundHarness(), url = 'https://media.test/api?request=one';
  await bg.api.acquireRequest({ url, requestId: 'gm:first', method: 'POST', requestHeaders: [{ header: 'cookie', operation: 'set', value: 'fixture=one' }] });
  const applied = [...bg.rules.values()].find((rule) => rule.action.type === 'modifyHeaders');
  assert.deepEqual(applied.condition.requestMethods, ['post']);
  assert.deepEqual(applied.condition.initiatorDomains, [bg.chrome.runtime.id]);
  assert.equal(new RegExp(applied.condition.regexFilter).test(url), true);
  assert.equal(new RegExp(applied.condition.regexFilter).test(url + '&other=two'), false);
  let ready = false;
  const next = bg.api.acquireRequest({ url, requestId: 'gm:plain', requestHeaders: [] }).then(() => { ready = true; });
  await tick(); assert.equal(ready, false);
  await bg.api.releaseRequest('gm:first'); await next;
  assert.equal([...bg.rules.values()].some((rule) => rule.action.type === 'modifyHeaders'), false);
  await bg.api.releaseRequest('gm:plain'); assert.equal(bg.rules.size, 0);
});

test('update settings, checks and downloads reject content-script impersonation', async () => {
  const bg = await backgroundHarness();
  for (const type of ['updates:get', 'updates:configure', 'updates:check', 'updates:download']) {
    await assert.rejects(bg.api.handle({ type, repository: 'https://github.com/evil/toolbox', automatic: true },
      { id: bg.chrome.runtime.id, url: 'https://www.allenoverseas.com/lecture', tab: { id: 1 } }), /Only the extension update controls/);
    await assert.rejects(bg.api.handle({ type }, { id: 'another-extension', url: bg.chrome.runtime.getURL('popup/popup.html') }), /Only the extension update controls/);
    assert.deepEqual(plain(await bg.api.handle({ type }, { id: bg.chrome.runtime.id, url: bg.chrome.runtime.getURL('popup/popup.html') + '?dashboard=1', tab: { id: 5 } })), {});
  }
});

test('startup clears legacy GM rules and invalid headers cannot install a new lease', async () => {
  const bg = await backgroundHarness({ rules: [{ id: 1000 }, { id: 5900 }, { id: 5901 }] });
  await assert.rejects(bg.api.acquireRequest({ url: 'https://media.test/api', requestId: 'gm:invalid',
    requestHeaders: [{ header: 'cookie', operation: 'set', value: 'bad\r\nheader' }] }), { code: 'DOWNLOAD_CONTEXT' });
  assert.deepEqual([...bg.rules.keys()], [5901]);
});

test('same-URL jobs queue without overwrite, including cancellation of the queued tail', async () => {
  const bg = await backgroundHarness(), it = item();
  await bg.api.acquireRequest({ context: it, url: it.url, requestId: 'active' });
  const second = bg.api.acquireRequest({ context: it, url: it.url, requestId: 'cancelled' });
  const rejected = assert.rejects(second, { code: 'DOWNLOAD_CANCELLED' });
  await tick(); await bg.api.releaseRequest('cancelled');
  let thirdStarted = false;
  const third = bg.api.acquireRequest({ context: it, url: it.url, requestId: 'third' }).then((r) => { thirdStarted = true; return r; });
  await tick(); assert.equal(thirdStarted, false); assert.equal(bg.rules.size, 2);
  await bg.api.releaseRequest('active'); await rejected; await third;
  assert.equal(thirdStarted, true); await bg.api.releaseRequest('third'); assert.equal(bg.rules.size, 0);
});

test('cancellation during permission lookup cannot leave a late credential rule', async () => {
  let permit;
  const bg = await backgroundHarness({ permission: () => new Promise((resolve) => { permit = resolve; }) });
  const pending = bg.api.acquireRequest({ context: item(), url: item().url, requestId: 'early-cancel' });
  await bg.api.releaseRequest('early-cancel'); permit(true);
  await assert.rejects(pending, { code: 'DOWNLOAD_CANCELLED' }); assert.equal(bg.rules.size, 0);
});

test('failed startup rule queries never leave global rules or permit overlapping stale contexts', async () => {
  const bg = await backgroundHarness({ failRuleQueries: 1, rules: [{ id: 1 }, { id: 2 }, { id: 6018 }] });
  assert.equal(bg.rules.has(1), false); assert.equal(bg.rules.has(2), false);
  await bg.api.acquireRequest({ context: item(), url: item().url, requestId: 'after-query-retry' });
  assert.equal(bg.rules.has(6018), false); await bg.api.releaseRequest('after-query-retry');
});

test('failed rule removal is retried before a new request can acquire a conflicting context', async () => {
  const options = {}, bg = await backgroundHarness(options);
  await bg.api.acquireRequest({ context: item(), url: item().url, requestId: 'old' });
  options.failRemoval = true;
  await assert.rejects(bg.api.releaseRequest('old'), { code: 'DOWNLOAD_CONTEXT' });
  await assert.rejects(bg.api.acquireRequest({ context: item(), url: item().url, requestId: 'blocked' }), { code: 'DOWNLOAD_CONTEXT' });
  assert.equal(bg.rules.size, 2);
  options.failRemoval = false;
  await bg.api.acquireRequest({ context: item(), url: item().url, requestId: 'new' });
  assert.equal(bg.rules.size, 2); await bg.api.releaseRequest('new'); assert.equal(bg.rules.size, 0);
});

test('download tracking persists saving until Chrome complete and ignores late worker updates', async () => {
  const bg = await backgroundHarness(); bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:complete', filename: 'lecture.mp4', size: 10 });
  const j = bg.api.jobs.get('job-a');
  assert.equal(j.state, 'saving'); assert.equal(j.finishedAt, undefined);
  assert.equal(bg.session.downloadBlobs.length, 1); assert.equal(bg.gmEvents.some((e) => e.m.state === 'done'), false);
  await bg.api.jobUpdate({ jobId: j.id, state: 'running', done: 1, total: 10, bytes: 1 });
  await bg.api.jobUpdate({ jobId: j.id, state: 'error', message: 'late failure' });
  assert.equal(j.state, 'saving'); assert.equal(j.bytes, 10);
  bg.downloads.get(j.downloadId).state = 'complete'; bg.events.changed.emit({ id: j.downloadId, state: { current: 'complete' } });
  await tick(); await tick();
  assert.equal(j.state, 'done'); assert.ok(j.finishedAt); assert.equal(bg.session.downloadBlobs.length, 0);
  assert.ok(bg.messages.some((m) => m.type === 'revoke' && m.blobUrl === 'blob:complete'));
  await bg.api.jobUpdate({ jobId: j.id, state: 'running', done: 2 }); assert.equal(j.state, 'done');
});

test('Chrome interruptions produce a visible terminal error with retry guidance', async () => {
  const bg = await backgroundHarness(); bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:interrupted', filename: 'lecture.mp4', size: 10 });
  const j = bg.api.jobs.get('job-a'), d = bg.downloads.get(j.downloadId); d.state = 'interrupted'; d.error = 'FILE_NO_SPACE';
  bg.events.changed.emit({ id: d.id, state: { current: 'interrupted' } }); await tick(); await tick();
  assert.equal(j.state, 'error'); assert.match(j.message, /FILE_NO_SPACE/); assert.match(j.message, /Retry Download/);
  assert.equal(bg.api.downloadBlobs.size, 0);
  await bg.api.jobUpdate({ jobId: j.id, state: 'running' }); assert.equal(j.state, 'error');
});

test('terminal browser events remain authoritative when downloads.search fails', async () => {
  const bg = await backgroundHarness({ search: async () => { throw new Error('search unavailable'); } });
  bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:search-failed', filename: 'lecture.mp4', size: 10 });
  assert.equal(bg.api.jobs.get('job-a').state, 'saving'); assert.equal(bg.messages.some((m) => m.type === 'revoke'), false);
  bg.events.changed.emit({ id: 1, state: { current: 'complete' } }); await tick(); await tick();
  assert.equal(bg.api.jobs.get('job-a').state, 'done'); assert.equal(bg.api.downloadBlobs.size, 0);
});

test('saving can be cancelled through Chrome, including cancellation before ID acceptance', async () => {
  const bg = await backgroundHarness(); bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:cancel', filename: 'lecture.mp4', size: 10 });
  await bg.api.jobCancel({ jobId: 'job-a' });
  assert.equal(bg.api.jobs.get('job-a').state, 'cancelled'); assert.deepEqual(bg.cancels, [1]);
  let accept;
  const waiting = await backgroundHarness({ download: async (value, state) => {
    const id = await new Promise((resolve) => { accept = resolve; });
    state.downloads.set(id, { id, url: value.url, state: 'in_progress' }); return id;
  } });
  waiting.api.jobs.set('job-a', job());
  const saving = waiting.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:pending-cancel', filename: 'lecture.mp4', size: 10 });
  await tick(); await waiting.api.jobCancel({ jobId: 'job-a' }); accept(42); await saving;
  assert.deepEqual(waiting.cancels, [42]); assert.equal(waiting.api.jobs.get('job-a').state, 'cancelled');
});

test('cancelling a save that completed concurrently reports its actual completion', async () => {
  const bg = await backgroundHarness({ cancel: async () => { throw new Error('download is already complete'); } });
  bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:cancel-race', filename: 'lecture.mp4', size: 10 });
  bg.downloads.get(1).state = 'complete'; await bg.api.jobCancel({ jobId: 'job-a' });
  assert.equal(bg.api.jobs.get('job-a').state, 'done'); assert.equal(bg.api.downloadBlobs.size, 0);
});

test('completion before downloads.download resolves is reconciled by search', async () => {
  const bg = await backgroundHarness({ completeBeforeResolve: true }); bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:race', filename: 'lecture.mp4', size: 10 });
  assert.equal(bg.api.jobs.get('job-a').state, 'done'); assert.equal(bg.api.downloadBlobs.size, 0);
  assert.equal(bg.messages.filter((m) => m.type === 'revoke').length, 1);
});

test('onCreated adopts pending save ownership before acceptance and cleans terminal blobs once', async () => {
  const bg = await backgroundHarness({ onCreated: true, completeBeforeResolve: true }); bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:created-race', filename: 'lecture.mp4', size: 10 });
  await tick(); assert.equal(bg.api.jobs.get('job-a').state, 'done'); assert.equal(bg.api.downloadBlobs.size, 0);
  assert.equal(bg.messages.filter((m) => m.type === 'revoke').length, 1);
});

test('worker restart recovers complete/interrupted downloads and removes abandoned legacy rules', async (t) => {
  for (const state of ['complete', 'interrupted']) await t.test(state, async () => {
    const record = { jobId: 'job-a', blobUrl: 'blob:restart', filename: 'lecture.mp4' };
    const bg = await backgroundHarness({ session: { jobs: [job('job-a', { state: 'saving', downloadId: 7 })], downloadBlobs: [[7, record]] },
      downloads: [{ id: 7, url: record.blobUrl, state, error: 'NETWORK_FAILED' }], rules: [{ id: 1 }, { id: 2 }, { id: 6001 }, { id: 1000 }] });
    assert.equal(bg.api.jobs.get('job-a').state, state === 'complete' ? 'done' : 'error');
    assert.equal(bg.session.downloadBlobs.length, 0); assert.deepEqual([...bg.rules.keys()], []);
    assert.equal(bg.saves.length, 0); assert.ok(bg.messages.some((m) => m.type === 'revoke'));
  });
});

test('restart adopts pending browser saves and keeps active offscreen jobs, not lost jobs', async () => {
  const bg = await backgroundHarness({ session: { jobs: [job('job-a', { state: 'saving' })],
    downloadBlobs: [['pending:fixture', { jobId: 'job-a', blobUrl: 'blob:pending-restart' }]] },
    downloads: [{ id: 8, url: 'blob:pending-restart', state: 'in_progress' }] });
  assert.equal(bg.api.jobs.get('job-a').state, 'saving'); assert.equal(bg.api.jobs.get('job-a').downloadId, 8);
  assert.equal(bg.api.downloadBlobs.has(8), true); assert.equal(bg.messages.some((m) => m.type === 'revoke'), false);
  const active = await backgroundHarness({ session: { jobs: [job()] }, activeJobs: [{ id: 'job-a', state: 'running' }] });
  assert.equal(active.api.jobs.get('job-a').state, 'running');
  const gone = await backgroundHarness({ session: { jobs: [job()] }, noOffscreen: true });
  assert.equal(gone.api.jobs.get('job-a').state, 'error'); assert.match(gone.api.jobs.get('job-a').message, /Retry Download/);
});

test('restart recovers an assembled offscreen result whose ready acknowledgement was lost', async () => {
  const result = { blobUrl: 'blob:ready-recovery', filename: 'lecture.mp4', size: 10, outputRole: 'video', notice: '' };
  const bg = await backgroundHarness({ session: { jobs: [job()] }, activeJobs: [{ id: 'job-a', state: 'ready', result }] });
  assert.equal(bg.api.jobs.get('job-a').state, 'saving'); assert.equal(bg.saves.length, 1);
  assert.equal(bg.saves[0].url, result.blobUrl); assert.ok(bg.messages.some((m) => m.type === 'job-ack' && m.jobId === 'job-a'));
  assert.equal(bg.messages.some((m) => m.type === 'revoke'), false);
});

test('missing browser history on restart is not permission to revoke a possibly active blob', async () => {
  const bg = await backgroundHarness({ session: { jobs: [job('job-a', { state: 'saving', downloadId: 9 })],
    downloadBlobs: [[9, { jobId: 'job-a', blobUrl: 'blob:missing-history' }]] } });
  assert.equal(bg.api.jobs.get('job-a').state, 'saving'); assert.match(bg.api.jobs.get('job-a').message, /Check browser Downloads/);
  assert.equal(bg.api.downloadBlobs.has(9), true); assert.equal(bg.messages.some((m) => m.type === 'revoke'), false);
});

test('failed browser acceptance revokes unsaved blobs and cannot be overwritten by late progress', async () => {
  const bg = await backgroundHarness({ download: async () => { throw new Error('invalid filename'); } }); bg.api.jobs.set('job-a', job());
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'ready', blobUrl: 'blob:rejected', filename: 'lecture.mp4', size: 10 });
  assert.equal(bg.api.jobs.get('job-a').state, 'error'); assert.match(bg.api.jobs.get('job-a').message, /Retry Download/);
  assert.equal(bg.api.downloadBlobs.size, 0); assert.ok(bg.messages.some((m) => m.type === 'revoke'));
  await bg.api.jobUpdate({ jobId: 'job-a', state: 'running' }); assert.equal(bg.api.jobs.get('job-a').state, 'error');
});

const pdfUrl = 'https://media.test/stream?token=fixture';
const completePdf = bytes('%PDF-1.7\nfixture\nstartxref\n9\n%%EOF\n');
const capture = (extra = {}) => ({ url: pdfUrl, scope: 'scope-a', source: 'capture', validated: true, bytes: completePdf,
  captureId: 'capture-a', capturedAt: 20, info: { valid: true, tried: true, title: 'Physics DPP', src: 'pdf-metadata' }, ...extra });
const pdfOptions = { url: pdfUrl, scope: 'scope-a', captureId: 'capture-a', capturedAt: 20, fresh: true, allowCaptured: true };

test('validated exact captured PDFs remain available on access/network/context/permission failure', async () => {
  const off = await offscreenHarness(async () => response(null, {}, 403));
  off.api.pdfs.set('scope-a\n' + pdfUrl, capture());
  const saved = await off.api.pdfPrepare(pdfOptions);
  assert.equal(saved.captured, true); assert.equal(saved.filename, 'Physics DPP.pdf'); assert.equal(saved.size, completePdf.length);
  let calls = 0;
  const cached = await offscreenHarness(async () => { calls++; throw new TypeError('network'); });
  cached.api.pdfs.set('scope-a\n' + pdfUrl, capture());
  const result = await cached.api.pdfPrepare({ ...pdfOptions, cacheOnly: true, fallbackCode: 'PDF_PERMISSION', name: '\u6587\u6863' });
  assert.equal(calls, 0); assert.equal(result.captured, true); assert.equal(result.filename, '\u6587\u6863.pdf');
  await assert.rejects(cached.api.pdfPrepare({ ...pdfOptions, scope: 'other', cacheOnly: true, fallbackCode: 'PDF_PERMISSION', fallbackMessage: 'permission needed' }), { code: 'PDF_PERMISSION' });
});

test('PDF fallback re-reads a capture completed during the failing fresh request', async () => {
  let off;
  off = await offscreenHarness(async () => { off.api.pdfs.set('scope-a\n' + pdfUrl, capture()); return response(null, {}, 403); });
  const result = await off.api.pdfPrepare(pdfOptions); assert.equal(result.captured, true);
});

test('offscreen accepts PDF chunks only from their scoped content frame, not privileged controls', async () => {
  const off = await offscreenHarness(async () => { throw new Error('no network expected'); });
  const listener = off.listener.listeners[0].fn, scope = '1:0:document-a:route-a:generation-a';
  const msg = { target: 'offscreen', type: 'pdf-chunk', scope, url: pdfUrl, captureId: 'capture-a', capturedAt: 20,
    uploadId: 'upload-a', size: completePdf.length, total: 1, index: 0, b64: btoa(String.fromCharCode(...completePdf)), response: { status: 200 } };
  const sender = { id: 'fixture', tab: { id: 1 }, frameId: 0, documentId: 'document-a' };
  const result = await new Promise((resolve) => assert.equal(listener(msg, sender, resolve), true));
  assert.equal(result.ok, true); assert.equal(off.api.pdfs.get(scope + '\n' + pdfUrl).validated, true);
  assert.equal(listener(msg, { ...sender, frameId: 1 }, () => {}), undefined);
  assert.equal(listener(msg, { ...sender, documentId: 'other-document' }, () => {}), undefined);
  assert.equal(listener({ target: 'offscreen', type: 'job-start' }, sender, () => {}), undefined);
});

test('PDF cache never crosses capture identity, route scope or timestamp, nor accepts partial bytes', async () => {
  for (const stale of [{ scope: 'other' }, { captureId: 'new-capture' }, { capturedAt: 21 }]) {
    const off = await offscreenHarness(async () => response(null, {}, 403));
    off.api.pdfs.set('scope-a\n' + pdfUrl, capture());
    await assert.rejects(off.api.pdfPrepare({ ...pdfOptions, ...stale }), { code: 'PDF_ACCESS' });
  }
  assert.equal(pdf.canUseCapturedPdf(capture({ validated: false }), pdfOptions), false);
  const off = await offscreenHarness(async () => response(null, {}, 403));
  off.api.pdfs.set('scope-a\n' + pdfUrl, capture()); await off.api.handle({ type: 'pdf-release', scopes: ['scope-a'] });
  await assert.rejects(off.api.pdfPrepare(pdfOptions), { code: 'PDF_STALE' });
  assert.throws(() => pdf.validatePdfBytes(bytes('%PDF-1.7\npartial'), { status: 200 }), { code: 'PDF_PARTIAL' });
  assert.throws(() => pdf.validatePdfBytes(completePdf, { status: 206, range: 'bytes 1-9/10' }), { code: 'PDF_PARTIAL' });
  assert.throws(() => pdf.validatePdfBytes(completePdf, { status: 200, length: completePdf.length + 1 }), { code: 'PDF_PARTIAL' });
  assert.equal(pdf.validatePdfBytes(completePdf, { status: 200, encoding: 'gzip', length: 1 }), completePdf);
});

test('background offers cache-only PDF fallback before host permission or DNR failures', async () => {
  for (const options of [{ permission: false }, { failContext: true }]) {
    const bg = await backgroundHarness(options), it = item({ id: 'pdf:fixture', kind: 'pdf', url: pdfUrl, captureId: 'capture-a' });
    bg.api.tabs.set(1, { items: { [it.id]: it }, frames: {}, children: [], generation: 'gen' });
    const opts = await bg.api.withPdfContext(it, async (o) => plain(o));
    assert.equal(opts.cacheOnly, true); assert.equal(opts.captureId, 'capture-a'); assert.equal(bg.rules.size, 0);
    bg.api.tabs.get(1).items[it.id] = { ...it, scope: 'new-route' };
    await assert.rejects(bg.api.withPdfContext(it, async () => ({})), (e) => ['PDF_PERMISSION', 'PDF_CONTEXT'].includes(e.code));
  }
});

test('PDF saves report queued until browser completion, without claiming navigation fallback is a download', async () => {
  for (const completeBeforeResolve of [false, true]) {
    const bg = await backgroundHarness({ completeBeforeResolve, offscreen: async (msg) => msg.type === 'pdf-prepare' ?
      { blobUrl: 'blob:pdf', filename: 'Physics DPP.pdf', info: { valid: true }, size: completePdf.length } : { ok: true } });
    const it = item({ id: 'pdf:fixture', kind: 'pdf', url: pdfUrl, captureId: 'capture-a' });
    bg.api.tabs.set(1, { items: { [it.id]: it }, frames: {}, children: [], generation: 'gen' });
    const result = await bg.api.pdfSave({ tabId: 1, id: it.id });
    assert.equal(result.queued, !completeBeforeResolve); assert.equal(result.state, completeBeforeResolve ? 'done' : 'saving'); assert.equal(result.downloadId, 1);
  }
});

test('download request and completion messages reject content-script impersonation and diagnostics omit secrets', async () => {
  const bg = await backgroundHarness(), it = item({ url: 'https://media.test/SECRET_PATH?token=SECRET_QUERY' });
  await assert.rejects(bg.api.handle({ type: 'off:request-acquire', url: it.url, context: it, requestId: 'forged' }, { id: bg.chrome.runtime.id, tab: { id: 1 }, url: it.pageHref }), /Only the extension/);
  await assert.rejects(bg.api.handle({ type: 'us:fetch', url: it.url }, { id: bg.chrome.runtime.id, tab: { id: 1 }, url: it.pageHref }), /Only the extension editor/);
  const hdr = { __tabId: 1, __frameId: 0, __scope: it.scope, __at: 20, authorization: 'SECRET_AUTH', 'x-token': 'SECRET_X' };
  bg.api.reqHeaders.set(it.scope + '\n' + it.url, hdr);
  const diag = bg.api.buildDiag(it, { status: 403, statusText: 'SECRET_STATUS', headers: { 'x-error': 'SECRET_HEADER' }, body: 'SECRET_BODY' }, 'download');
  assert.equal(/SECRET_/.test(diag), false);
  assert.ok(bg.events.before.listeners[0].args[0].types.includes('main_frame'));
});

test('a main-frame PDF and its exact headers survive navigation commit without adopting the previous page', async () => {
  const bg = await backgroundHarness();
  bg.api.tabs.set(1, { items: {}, frames: { 0: { documentId: 'old-document', scope: 'old-scope', routeAt: 1, pageHref: 'https://www.allenoverseas.com/old' } },
    children: [], generation: 'old-generation', resetAt: 1 });
  const d = { tabId: 1, frameId: 0, documentId: 'new-document', type: 'main_frame', requestId: 'main-pdf', url: 'https://media.test/document?fixture', timeStamp: 20 };
  bg.events.before.emit(d);
  bg.events.sent.emit({ ...d, requestHeaders: [{ name: 'Cookie', value: 'CURRENT_PDF_ONLY' }, { name: 'Referer', value: 'https://www.allenoverseas.com/lecture' }] });
  bg.events.received.emit({ ...d, responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }, { name: 'Content-Length', value: '100' }] });
  bg.chrome.webNavigation.onCommitted.emit({ ...d, timeStamp: 23, transitionType: 'link' }); await tick();
  const [pdfItem] = Object.values(bg.api.tabs.get(1).items);
  assert.equal(pdfItem.kind, 'pdf'); assert.equal(pdfItem.url, d.url); assert.equal(pdfItem.documentId, 'new-document');
  assert.equal(pdfItem.scope.includes('old-scope'), false); assert.equal(pdfItem.captureId, '');
  await bg.api.acquireRequest({ context: pdfItem, url: pdfItem.url, requestId: 'pdf-refetch', pdf: true });
  const rule = [...bg.rules.values()].find((r) => r.action.type === 'modifyHeaders');
  assert.ok(rule.action.requestHeaders.some((h) => h.header === 'cookie' && h.value === 'CURRENT_PDF_ONLY'));
  await bg.api.releaseRequest('pdf-refetch');
});

test('job-start ignores caller URLs and resolves only a selected cached quality or detected direct resource', async () => {
  const option = { id: 'v0', type: 'video', url: 'https://video.test/quality.m3u8', muxed: false, audioUrl: 'https://audio.test/track.m3u8', label: 'video only' };
  const bg = await backgroundHarness({ offscreen: async (msg) => {
    if (msg.type === 'hls-info') return { kind: 'master', options: [option], hosts: ['https://video.test', 'https://audio.test'] };
    if (msg.type === 'hls-preview') return { previewId: 'preview-fixture', hosts: [new URL(msg.url).origin] };
    return { ok: true };
  } });
  const it = item({ id: 'hls:fixture', kind: 'hls', url: 'https://media.test/master.m3u8' });
  bg.api.tabs.set(1, { items: { [it.id]: it }, frames: {}, children: [], generation: 'gen' });
  await bg.api.jobStart({ tabId: 1, id: it.id, quality: 'v0', mode: 'audio', url: 'https://unrelated.test/evil' });
  const start = bg.messages.find((m) => m.type === 'job-start');
  assert.equal(start.url, option.audioUrl); assert.equal(start.option.id, 'v0');
  assert.equal(bg.api.jobs.get(start.jobId).outputRole, 'audio');
  await assert.rejects(bg.api.jobStart({ tabId: 1, id: it.id, quality: 'unknown', mode: 'video', url: option.url }), /listed quality/);
  const direct = item(); bg.api.tabs.get(1).items[direct.id] = direct;
  await bg.api.jobStart({ tabId: 1, id: direct.id, kind: 'http', mode: 'video', url: 'https://unrelated.test/evil' });
  assert.equal(bg.messages.filter((m) => m.type === 'job-start').at(-1).url, direct.url);
});

test('job-start refuses to fetch when its initial session persistence fails', async () => {
  const bg = await backgroundHarness({ failRunningPersistence: true }), it = item();
  bg.api.tabs.set(1, { items: { [it.id]: it }, frames: {}, children: [], generation: 'gen' });
  await assert.rejects(bg.api.jobStart({ tabId: 1, id: it.id, kind: 'http', mode: 'video' }), /Session storage unavailable/);
  assert.equal(bg.messages.some((m) => m.type === 'job-start'), false); assert.equal(bg.saves.length, 0);
  assert.equal([...bg.api.jobs.values()][0].state, 'error');
});

test('a late job-start transport error cannot regress a save already accepted by Chrome', async () => {
  const bg = await backgroundHarness({ offscreen: async (msg, state) => {
    if (msg.type === 'job-start') {
      await state.api.jobUpdate({ jobId: msg.jobId, state: 'ready', blobUrl: 'blob:late-start-error', filename: 'lecture.mp4', size: 10 });
      throw new Error('unexpected transport failure');
    }
    return { ok: true };
  } });
  const it = item(); bg.api.tabs.set(1, { items: { [it.id]: it }, frames: {}, children: [], generation: 'gen' });
  const started = await bg.api.jobStart({ tabId: 1, id: it.id, kind: 'http', mode: 'video' });
  assert.equal(bg.api.jobs.get(started.jobId).state, 'saving'); assert.equal(bg.api.downloadBlobs.size, 1);
  assert.equal(bg.messages.some((m) => m.type === 'job-cancel' || m.type === 'revoke'), false);
});

test('page download messages bind to their actual tab while trusted extension UI may select a tab', async () => {
  const bg = await backgroundHarness(), a = item(), b = item({ tabId: 2, scope: 'scope-b', url: 'https://other.test/lecture.mp4' });
  for (const it of [a, b]) bg.api.tabs.set(it.tabId, { items: { [it.id]: it }, frames: {}, children: [], generation: 'gen' });
  await bg.api.handle({ type: 'job-start', tabId: 2, id: a.id, kind: 'http', mode: 'video' }, { id: bg.chrome.runtime.id, tab: { id: 1 }, url: a.pageHref });
  assert.equal(bg.messages.filter((m) => m.type === 'job-start').at(-1).url, a.url);
  const started = await bg.api.handle({ type: 'job-start', tabId: 2, id: b.id, kind: 'http', mode: 'video' },
    { id: bg.chrome.runtime.id, tab: { id: 99 }, url: bg.chrome.runtime.getURL('popup/popup.html') });
  assert.equal(bg.messages.filter((m) => m.type === 'job-start').at(-1).url, b.url);
  await assert.rejects(bg.api.handle({ type: 'job-cancel', jobId: started.jobId }, { id: bg.chrome.runtime.id, tab: { id: 1 }, url: a.pageHref }), /another tab/);
});
