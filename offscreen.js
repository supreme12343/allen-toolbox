/*
 * ALLEN Toolbox — offscreen worker.
 * Long-running work lives here because the MV3 service worker can be shut down at any time:
 *   • holds captured PDF bytes, reads their titles/text with pdf.js
 *   • downloads HLS recordings (parallel segments, AES-128 decryption, audio extraction)
 * Results leave as blob: URLs that the background hands to chrome.downloads.
 */
import * as pdfjs from './lib/pdf.min.mjs';
import { parseM3U8, assertDownloadable, ivFor, masterOptions, playlistHosts, selectOutput } from './shared/hls.js';
import { TsAudioDemuxer } from './shared/tsaudio.js';
import { meaningful, fromContentDisposition, dispositionFilename, linesFrom, deriveName, safeBase, safeFilename } from './shared/names.js';
import { PdfError, PDF_REOPEN, validatePdfResponse, validatePdfBytes, canUseCapturedPdf, allowsCapturedFallback, isViewerStream } from './shared/pdf.js';
import { DownloadError, MAX_DOWNLOAD_BYTES, checkAbort, withResponse, readBody, fetchBytes, fetchBuffer, fetchText, downloadFile, entityOf, contentLength, waitRetry } from './shared/download.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

async function toBackground(msg, confirm = false) {
  const tries = confirm ? 8 : 1;
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await chrome.runtime.sendMessage(msg); } catch (err) { r = null; }
    if (!confirm || r?.ok) return r;
    if (i + 1 < tries) await waitRetry(150);
  }
  return null;
}
// Surface anything unexpected in the background worker's console (offscreen pages have no easy-to-find console).
const logUp = (text) => toBackground({ type: 'off:log', text: String(text).slice(0, 500) });
self.addEventListener('error', (e) => logUp('error: ' + e.message));
self.addEventListener('unhandledrejection', (e) => logUp('unhandled rejection: ' + (e.reason && e.reason.message || e.reason)));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  if (sender.tab) {
    if (!['pdf-chunk', 'pdf-cancel'].includes(msg.type)) return;
    const prefix = sender.tab.id + ':' + (sender.frameId || 0) + ':' + (sender.documentId ? sender.documentId + ':' : '');
    if (typeof msg.scope !== 'string' || !msg.scope.startsWith(prefix)) return;
  }
  handle(msg).then(sendResponse, (e) => sendResponse({ error: (e && e.message) || String(e), code: e && e.code, diag: e && e.diag }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'ping': return { ok: true };
    case 'pdf-chunk': return pdfChunk(msg);
    case 'pdf-cancel': {
      const key = msg.scope + '\n' + msg.uploadId;
      cancelledUploads.add(key); pdfUploads.delete(key);
      while (cancelledUploads.size > 100) cancelledUploads.delete(cancelledUploads.values().next().value);
      return { ok: true };
    }
    case 'pdf-release': releasePdfs(msg.scopes || []); return { ok: true };
    case 'pdf-prepare': return pdfPrepare(msg);
    case 'pdf-text': return { text: await pdfText(msg.url, msg) };
    case 'hls-info': return hlsInfo(msg);
    case 'hls-preview': return hlsPreview(msg);
    case 'job-start': startJob(msg); return { ok: true };
    case 'job-status': return { jobs: [...jobs.values()].map((j) => ({ id: j.id, state: j.state, result: j.state === 'ready' ? j.result : undefined })) };
    case 'job-ack': { const j = jobs.get(msg.jobId); if (j?.state === 'ready') { j.acknowledged = true; jobs.delete(j.id); } return { ok: true }; }
    case 'job-cancel': { const j = jobs.get(msg.jobId); if (j) { j.cancelled = true; j.abort.abort(); } return { ok: true }; }
    case 'revoke': try { URL.revokeObjectURL(msg.blobUrl); } catch (e) {} return { ok: true };
    default: throw new Error('Unknown message: ' + msg.type);
  }
}

/* ====================================================================== *
 * Shared fetch helpers
 * ====================================================================== */
function requestContext(context) {
  return {
    acquire(url, signal) {
      checkAbort(signal);
      const requestId = 'r' + crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const cancel = () => {
          toBackground({ type: 'off:request-release', requestId }, true);
          reject(signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError'));
        };
        signal.addEventListener('abort', cancel, { once: true });
        chrome.runtime.sendMessage({ type: 'off:request-acquire', requestId, url, context }).then((r) => {
          signal.removeEventListener('abort', cancel);
          if (signal.aborted) { toBackground({ type: 'off:request-release', requestId }, true); return; }
          if (!r || r.error || r.requestId !== requestId) {
            toBackground({ type: 'off:request-release', requestId }, true);
            reject(new DownloadError(r?.code || 'DOWNLOAD_CONTEXT', r?.error || 'The download request context was not confirmed. Retry Download.', { retryable: !r?.error })); return;
          }
          resolve(requestId);
        }, (err) => {
          signal.removeEventListener('abort', cancel);
          toBackground({ type: 'off:request-release', requestId }, true);
          reject(new DownloadError('DOWNLOAD_CONTEXT', 'The browser worker restarted before confirming this request. Retry Download.',
            { retryable: /Receiving end does not exist|message port closed/i.test(err.message) }));
        });
      });
    },
    release(requestId) { return toBackground({ type: 'off:request-release', requestId }, true); },
  };
}

/* ====================================================================== *
 * PDF
 * ====================================================================== */
const pdfs = new Map();   // scope + url -> complete, validated PDF bytes
const pdfUploads = new Map();
const cancelledUploads = new Set();
const releasedScopes = new Set();
const pdfFetches = new Map();
const MAX_PDFS = 4;
const MAX_PDF_BYTES = 128 * 1024 * 1024;
const MAX_PDF_CACHE_BYTES = 256 * 1024 * 1024;
const PDF_CHUNK = 6 * 1024 * 1024;
const pdfKey = (url, scope = '') => scope + '\n' + url;
const stalePdf = () => new PdfError('PDF_STALE', 'This PDF belongs to an earlier viewer or page. ' + PDF_REOPEN);

function pdfEntry(url, scope = '') {
  const key = pdfKey(url, scope);
  const e = { url, scope, bytes: null, cd: '', info: null, validated: false };
  pdfs.delete(key); pdfs.set(key, e);
  trimPdfCache();
  return e;
}

function trimPdfCache() {
  let bytes = [...pdfs.values()].reduce((n, e) => n + (e.bytes?.byteLength || 0), 0);
  while (pdfs.size > MAX_PDFS || bytes > MAX_PDF_CACHE_BYTES) {
    const key = pdfs.keys().next().value, e = pdfs.get(key);
    bytes -= e.bytes?.byteLength || 0; pdfs.delete(key);
    toBackground({ type: 'off:pdf-evicted', url: e.url, scope: e.scope, captureId: e.captureId });
  }
}

function releasePdfs(scopes) {
  for (const scope of scopes) {
    releasedScopes.add(scope);
    for (const [key, e] of pdfs) if (e.scope === scope) pdfs.delete(key);
    for (const [key, u] of pdfUploads) if (u.scope === scope) pdfUploads.delete(key);
    for (const ctl of pdfFetches.get(scope) || []) ctl.abort();
  }
  while (releasedScopes.size > 500) releasedScopes.delete(releasedScopes.values().next().value);
}

const b64ToU8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function pdfChunk(m) {
  const key = m.scope + '\n' + m.uploadId;
  if (!m.scope || !m.uploadId || releasedScopes.has(m.scope) || cancelledUploads.has(key)) throw stalePdf();
  if (!Number.isSafeInteger(m.size) || m.size <= 0 || m.total !== Math.ceil(m.size / PDF_CHUNK) || !Number.isInteger(m.index) || m.index < 0 || m.index >= m.total) {
    throw new PdfError('PDF_CAPTURE', 'Invalid PDF upload');
  }
  if (m.size > MAX_PDF_BYTES) throw new PdfError('PDF_SIZE', 'This PDF exceeds the 128 MiB in-memory PDF limit. Use the viewer\'s own save action.');
  const existing = pdfs.get(pdfKey(m.url, m.scope));
  if (existing && (existing.capturedAt > m.capturedAt || (existing.capturedAt === m.capturedAt && (existing.captureOrder || 0) > (m.captureOrder || 0)))) throw stalePdf();
  for (const [id, u] of pdfUploads) if (Date.now() - u.at > 60000) pdfUploads.delete(id);
  if (m.index === 0) {
    if ([...pdfUploads.values()].reduce((n, u) => n + u.size, 0) + m.size > MAX_PDF_CACHE_BYTES) throw new PdfError('PDF_SIZE', 'Too many large PDFs are loading at once. Wait for the current PDF, then retry.');
    pdfUploads.set(key, { scope: m.scope, url: m.url, size: m.size, total: m.total, parts: [], at: Date.now() });
    while (pdfUploads.size > 8) pdfUploads.delete(pdfUploads.keys().next().value);
  }
  const upload = pdfUploads.get(key);
  if (!upload || upload.url !== m.url || upload.size !== m.size || upload.total !== m.total || upload.parts.length !== m.index) throw new PdfError('PDF_CAPTURE', 'Interrupted PDF upload. ' + PDF_REOPEN);
  const part = b64ToU8(m.b64);
  if (part.length !== Math.min(PDF_CHUNK, m.size - m.index * PDF_CHUNK)) throw new PdfError('PDF_CAPTURE', 'Incomplete PDF upload. ' + PDF_REOPEN);
  upload.parts.push(part); upload.at = Date.now();
  if (upload.parts.length === upload.total) {
    pdfUploads.delete(key);
    const out = new Uint8Array(m.size);
    let off = 0;
    for (const p of upload.parts) { out.set(p, off); off += p.length; }
    validatePdfBytes(out, m.response || {});
    const e = pdfEntry(m.url, m.scope);
    Object.assign(e, { bytes: out, cd: m.cd || '', info: null, infoPromise: null, validated: true,
      captureId: m.captureId, capturedAt: m.capturedAt, captureOrder: m.captureOrder, source: 'capture' });
    trimPdfCache();
    const publish = (info) => {
      if (!releasedScopes.has(m.scope) && pdfs.get(pdfKey(m.url, m.scope)) === e) {
        toBackground({ type: 'off:pdf-info', url: m.url, scope: m.scope, captureId: m.captureId, capturedAt: m.capturedAt, info, size: out.length });
      }
    };
    if (m.analyse) {
      analysePdf(m.url, { preferText: m.preferText, scope: m.scope, entry: e }).then(publish).catch(() => {});
    } else publish(null);
  }
  return { ok: true };
}

async function pdfBytes(url, { scope = '', fresh = false, captureId, capturedAt, cacheOnly = false, fallbackCode, fallbackMessage } = {}) {
  if (releasedScopes.has(scope)) throw stalePdf();
  const cached = pdfs.get(pdfKey(url, scope));
  if (cacheOnly) {
    if (canUseCapturedPdf(cached, { scope, captureId, capturedAt })) return cached;
    throw new PdfError(fallbackCode || 'PDF_CAPTURE', fallbackMessage || 'The viewer has not supplied a complete current PDF copy. ' + PDF_REOPEN);
  }
  if (!fresh && cached && cached.bytes && cached.validated && (!captureId || captureId === cached.captureId)) return cached;
  if (!/^https?:/i.test(url)) throw new PdfError('PDF_BLOB_GONE', 'The viewer has not supplied a complete PDF copy yet. ' + PDF_REOPEN);
  const ctl = new AbortController();
  if (!pdfFetches.has(scope)) pdfFetches.set(scope, new Set());
  pdfFetches.get(scope).add(ctl);
  try {
    const { r, buf } = await withResponse(url, { signal: ctl.signal, tries: isViewerStream(url) ? 1 : 3 }, async (r, signal) => {
      const meta = { status: r.status, range: r.headers.get('content-range') || '', length: r.headers.get('content-length') || '', encoding: r.headers.get('content-encoding') || '',
        diag: { url, status: r.status, headers: { 'content-type': r.headers.get('content-type') || '', 'content-range': r.headers.get('content-range') || '' } } };
      validatePdfResponse(meta);
      if (contentLength(r) > MAX_PDF_BYTES) throw new PdfError('PDF_SIZE', 'This PDF exceeds the 128 MiB in-memory PDF limit. Use the viewer\'s own save action.');
      const out = await readBody(r, { signal, maxBytes: MAX_PDF_BYTES });
      const buf = new Uint8Array(await out.blob.arrayBuffer());
      validatePdfBytes(buf, meta);
      return { r, buf };
    });
    if (releasedScopes.has(scope)) throw stalePdf();
    const e = pdfEntry(url, scope);
    Object.assign(e, { bytes: buf, cd: r.headers.get('content-disposition') || '', info: null, infoPromise: null,
      validated: true, captureId, capturedAt, source: 'network' });
    trimPdfCache();
    return e;
  } catch (err) {
    if (releasedScopes.has(scope)) throw stalePdf();
    if (err instanceof PdfError) throw err;
    const code = { DOWNLOAD_ACCESS: 'PDF_ACCESS', DOWNLOAD_HTTP: 'PDF_HTTP', DOWNLOAD_REDIRECT: 'PDF_REDIRECT', DOWNLOAD_TIMEOUT: 'PDF_NETWORK', DOWNLOAD_NETWORK: 'PDF_NETWORK', DOWNLOAD_TOO_LARGE: 'PDF_SIZE' }[err.code] || 'PDF_FETCH';
    throw new PdfError(code, err.message + ' ' + PDF_REOPEN, err.diag);
  } finally {
    const active = pdfFetches.get(scope);
    if (active) { active.delete(ctl); if (!active.size) pdfFetches.delete(scope); }
  }
}

async function withDoc(url, fn, opts = {}) {
  const e = opts.entry || await pdfBytes(url, opts);
  const doc = await pdfjs.getDocument({
    data: e.bytes.slice(), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
  }).promise;
  try { return await fn(doc, e); } finally { try { await doc.destroy(); } catch (err) {} }
}

async function analysePdf(url, { preferText = false, scope = '', entry } = {}) {
  const e = entry || await pdfBytes(url, { scope });
  if (e.info && e.info.tried) return e.info;
  if (e.infoPromise) return e.infoPromise;
  e.infoPromise = readPdfInfo(url, e, preferText);
  return e.infoPromise;
}

async function readPdfInfo(url, e, preferText) {
  const out = { title: null, src: 'none', pages: 0, tried: true, valid: false };
  try {
    await withDoc(url, async (doc, ent) => {
      out.pages = doc.numPages || 0;
      if (!out.pages) throw new Error('The PDF contains no readable pages');
      const cd = fromContentDisposition(ent.cd);
      if (cd) { out.title = cd; out.src = 'content-disposition'; }

      if (!out.title && !preferText) {
        try {
          const md = await doc.getMetadata();
          const info = (md && md.info) || {};
          if (meaningful(info.Title)) { out.title = String(info.Title).trim(); out.src = 'pdf-metadata'; }
          else if (meaningful(info.Subject) && /\s/.test(String(info.Subject).trim())) { out.title = String(info.Subject).trim(); out.src = 'pdf-subject'; }
          else if (md && md.metadata) {
            const x = md.metadata.get('dc:title');
            if (meaningful(x)) { out.title = String(x).trim(); out.src = 'xmp-title'; }
          }
        } catch (err) { /* fall through to text */ }
      }

      if (!out.title) {
        const lines = [];
        for (let i = 1; i <= Math.min(2, doc.numPages || 1) && lines.length < 40; i++) {
          const page = await doc.getPage(i);
          lines.push(...linesFrom(await page.getTextContent()));
          try { page.cleanup(); } catch (err) {}
        }
        const t = deriveName(lines);
        if (t) { out.title = t; out.src = 'pdf-text'; }
      }
      out.valid = true;
    }, { entry: e });
  } catch (err) {
    // A complete encrypted PDF can still be opened in Chrome's password-prompting viewer.
    if (err.name === 'PasswordException') out.valid = true;
    else { out.error = 'The PDF could not be read completely. ' + PDF_REOPEN; out.code = 'PDF_INVALID'; }
  }
  e.info = out;
  return out;
}

async function pdfPrepare({ url, name, preferText, open, ...opts }) {
  let e, captured = false;
  try { e = await pdfBytes(url, opts); }
  catch (err) {
    // A capture may finish while the authorized fresh request is failing.
    const cached = pdfs.get(pdfKey(url, opts.scope));
    if (!opts.allowCaptured || !canUseCapturedPdf(cached, opts) || releasedScopes.has(opts.scope) || !allowsCapturedFallback(err.code)) throw err;
    e = cached; captured = true;
  }
  captured ||= !!opts.cacheOnly;
  const info = await analysePdf(url, { preferText, scope: opts.scope, entry: e });
  if (!info.valid) throw new PdfError(info.code || 'PDF_INVALID', info.error || 'The PDF is incomplete. ' + PDF_REOPEN);
  if (releasedScopes.has(opts.scope)) throw stalePdf();
  const base = safeBase(name, { strict: false }) || safeBase(info.title) || 'document';
  const blobUrl = URL.createObjectURL(new Blob([e.bytes], { type: 'application/pdf' }));
  if (open) setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (err) {} }, 15 * 60e3);
  return { blobUrl, filename: base + '.pdf', title: info.title, src: info.src, size: e.bytes.length, info, captured,
    cached: pdfs.get(pdfKey(url, opts.scope)) === e,
    message: captured ? 'Used the complete PDF already received by this viewer; its stream link could not be reused.' : '' };
}

async function pdfText(url, opts = {}) {
  let out = '';
  await withDoc(url, async (doc) => {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      out += linesFrom(await page.getTextContent()).join('\n') + '\n\n';
      try { page.cleanup(); } catch (e) {}
    }
  }, opts);
  return out.trim();
}

/* ====================================================================== *
 * HLS
 * ====================================================================== */
const fmtDur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

const mediaPreviews = new Map();
const mediaPlaylists = new Map();
const mediaKey = (context, url) => {
  const source = new URL(url); source.hash = '';
  return (context?.scope || context?.tabId || '') + '\n' + source.href;
};

async function hlsInfo(msg) {
  const { text, url: finalUrl } = await fetchText(msg.url, { context: requestContext(msg.context) });
  const pl = parseM3U8(text, finalUrl);
  if (pl.master) {
    const options = masterOptions(pl);
    if (!options.length) throw new Error('The playlist lists no playable streams');
    return { kind: 'master', options, hosts: playlistHosts(pl, finalUrl) };
  }
  assertDownloadable(pl);
  const key = mediaKey(msg.context, msg.url);
  mediaPlaylists.delete(key); mediaPlaylists.set(key, { pl, url: finalUrl, at: Date.now() });
  while (mediaPlaylists.size > 20) mediaPlaylists.delete(mediaPlaylists.keys().next().value);
  const hosts = playlistHosts(pl, finalUrl);
  const encrypted = pl.segments.some((s) => s.key);
  return {
    kind: 'media', hosts,
    options: [{
      id: 's0', type: 'video', url: finalUrl, muxed: true, audioUrl: null,
      hosts,
      label: ['Single stream', fmtDur(pl.duration), pl.segments.length + ' segments', encrypted ? 'AES-128' : ''].filter(Boolean).join(' · '),
    }],
  };
}

async function hlsPreview(msg) {
  const output = selectOutput(msg.option, msg.mode);
  if (output.url !== msg.url) throw new Error('The selected stream does not match this recording preview');
  const cached = mediaPlaylists.get(mediaKey(msg.context, output.url));
  const { pl, url } = cached && Date.now() - cached.at < 60000 ? cached :
    await resolveMediaPlaylist(output.url, { context: requestContext(msg.context) });
  assertDownloadable(pl);
  const previewId = crypto.randomUUID();
  mediaPreviews.set(previewId, { pl, at: Date.now(), key: mediaKey(msg.context, output.url) });
  while (mediaPreviews.size > 20) mediaPreviews.delete(mediaPreviews.keys().next().value);
  return { previewId, hosts: playlistHosts(pl, url), playlistHosts: [new URL(url).origin], ...output,
    segments: pl.segments.length, duration: pl.duration };
}

/* ---- jobs ---- */
const jobs = new Map();
const startedJobs = new Set();

function startJob(msg) {
  if (!msg.jobId || !['http', 'hls'].includes(msg.kind)) throw new Error('Invalid download job');
  if (startedJobs.has(msg.jobId)) return;
  startedJobs.add(msg.jobId);
  while (startedJobs.size > 100) startedJobs.delete(startedJobs.values().next().value);
  const job = { id: msg.jobId, abort: new AbortController(), state: 'running', cancelled: false };
  jobs.set(job.id, job);
  job.promise = (async () => {
    let result;
    try {
      result = await (msg.kind === 'http' ? runHttp : runHls)(msg, job);
      checkAbort(job.abort.signal);
      job.state = 'ready'; job.result = result;
      const ack = await toBackground({ type: 'off:job', jobId: job.id, state: 'ready', ...result }, true);
      job.acknowledged ||= !!ack?.ok;
    } catch (err) {
      job.abort.abort(err);
      if (result?.blobUrl) URL.revokeObjectURL(result.blobUrl);
      job.state = job.cancelled ? 'cancelled' : 'error';
      await toBackground({ type: 'off:job', jobId: job.id, state: job.state,
        message: job.cancelled ? 'Cancelled' : (err?.message || String(err)), diag: err?.diag }, true);
    } finally {
      // A lost ready ACK may mean Chrome already owns the blob. Retain it for startup recovery.
      if (job.state !== 'ready' || job.acknowledged) jobs.delete(job.id);
    }
  })();
}

async function resolveMediaPlaylist(url, opts) {
  const { text, url: finalUrl } = await fetchText(url, opts);
  const pl = parseM3U8(text, finalUrl);
  if (pl.master) throw new Error('Choose a media quality from the master playlist; nested master downloads are not supported');
  assertDownloadable(pl);
  return { pl, url: finalUrl };
}

function sniff(u8) {
  if (u8[0] === 0x47) return 'ts';
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return 'raw-audio';        // ID3 → mp3/aac
  if (u8[0] === 0xff && (u8[1] & 0xf0) === 0xf0) return 'raw-audio';                 // ADTS / MPEG audio
  if (String.fromCharCode(...u8.slice(4, 8)) === 'ftyp' || String.fromCharCode(...u8.slice(4, 8)) === 'moof' ||
      String.fromCharCode(...u8.slice(4, 8)) === 'styp' || String.fromCharCode(...u8.slice(4, 8)) === 'moov') return 'fmp4';
  return 'unknown';
}

async function runHls(msg, job) {
  const { signal } = job.abort;
  const report = throttle((p) => { if (!signal.aborted && job.state === 'running') toBackground({ type: 'off:job', jobId: job.id, state: 'running', ...p }); }, 250);
  report({ phase: 'Reading playlist...', done: 0, total: 0, bytes: 0 });
  const output = selectOutput(msg.option, msg.mode);
  if (output.url !== msg.url) throw new Error('The selected stream does not match this download');
  const opts = { signal, context: requestContext(msg.context) };

  const preview = mediaPreviews.get(msg.previewId);
  mediaPreviews.delete(msg.previewId);
  const pl = preview && preview.key === mediaKey(msg.context, msg.url) && Date.now() - preview.at < 60000 ? preview.pl : (await resolveMediaPlaylist(msg.url, opts)).pl;
  assertDownloadable(pl);
  const segs = pl.segments;
  const total = segs.length + (pl.map ? 1 : 0);

  // AES-128 keys, fetched once per URI
  const keys = new Map();
  const getKey = async (uri) => {
    if (!keys.has(uri)) {
      keys.set(uri, (async () => {
        const raw = await fetchBuffer(uri, { ...opts, maxBytes: 1024, binary: true });
        if (raw.byteLength !== 16) throw new Error('Unexpected decryption key size (' + raw.byteLength + ' bytes)');
        return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      })());
    }
    return keys.get(uri);
  };

  let done = 0, bytes = 0;
  const bump = (n) => {
    checkAbort(signal);
    if (bytes + n > MAX_DOWNLOAD_BYTES) throw new DownloadError('DOWNLOAD_TOO_LARGE', 'This recording exceeds the 1 GiB in-memory file limit. Choose a smaller quality or use the site\'s own download.');
    done++; bytes += n; report({ phase: 'Downloading', done, total, bytes });
  };
  const rangeSources = new Map(), rangeQueues = new Map();
  const mediaBytes = (url, range) => {
    if (!range) return fetchBuffer(url, { ...opts, binary: true });
    const previous = rangeQueues.get(url) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      checkAbort(signal);
      const known = rangeSources.get(url);
      if (known?.full) {
        if (range.end > known.total) throw new Error('The HLS byte range extends beyond its complete media file');
        return known.full.slice(range.offset, range.end).arrayBuffer();
      }
      const res = await fetchBytes(url, { ...opts, range, binary: true, sliceFull: true,
        onResponse: (r, cr) => {
          const entity = entityOf(r), total = cr?.total ?? contentLength(r);
          if (known && (known.total !== total || known.etag !== entity.etag || known.modified !== entity.modified)) {
            throw new DownloadError('DOWNLOAD_CHANGED', 'The HLS media changed between byte ranges. No partial recording was saved.');
          }
        } });
      rangeSources.set(url, { ...entityOf(res.response), total: res.total, full: res.full });
      return res.bytes;
    });
    rangeQueues.set(url, pending);
    return pending.finally(() => { if (rangeQueues.get(url) === pending) rangeQueues.delete(url); });
  };

  const load = async (url, range, key, seq) => {
    let buf = await mediaBytes(url, range);
    if (key) {
      buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(key, seq) }, await getKey(key.uri), buf)
        .catch(() => { throw new Error('Decryption failed; the key or IV does not match this stream'); });
    }
    if (!buf.byteLength) throw new Error('The recording contains an empty media segment');
    bump(buf.byteLength);
    return new Blob([buf]);
  };

  let init = null;
  if (pl.map) init = await load(pl.map.url, pl.map.range, pl.map.key, 0);

  const parts = new Array(segs.length);
  let next = 0;
  const conc = Math.min(Number.isInteger(msg.concurrency) ? Math.max(1, Math.min(16, msg.concurrency)) : 8, segs.length);
  const workers = Array.from({ length: conc }, async () => {
    for (;;) {
      checkAbort(signal);
      const i = next++;
      if (i >= segs.length) return;
      const s = segs[i];
      parts[i] = await load(s.url, s.range, s.key, s.seq);
    }
  });
  try { await Promise.all(workers); }
  catch (err) { job.abort.abort(err); await Promise.allSettled(workers); throw err; }
  checkAbort(signal);

  const head = new Uint8Array(await parts[0].slice(0, 16).arrayBuffer());
  const kind = sniff(head);
  if (kind === 'fmp4' && !init) throw new Error('This fragmented MP4 recording is missing EXT-X-MAP initialization data; it cannot be saved safely.');
  if (init && (kind !== 'fmp4' || sniff(new Uint8Array(await init.slice(0, 16).arrayBuffer())) !== 'fmp4')) throw new Error('The HLS initialization map does not match a fragmented MP4 recording');
  if (kind === 'unknown') throw new Error('This recording uses an unsupported media container; no invalid video was saved.');
  for (const part of parts) if (sniff(new Uint8Array(await part.slice(0, 16).arrayBuffer())) !== kind) throw new Error('This recording changes media containers; safe joining is not supported');
  report({ phase: 'Assembling file...', done: total, total, bytes });

  let rawExt = 'aac';
  if (kind === 'raw-audio') {
    let offset = 0;
    if (head[0] === 0x49) {
      if (head.slice(6, 10).some((n) => n & 0x80)) throw new Error('Invalid packed-audio ID3 header');
      offset = 10 + head.slice(6, 10).reduce((n, x) => n * 128 + x, 0) + (head[5] & 0x10 ? 10 : 0);
    }
    const frame = new Uint8Array(await parts[0].slice(offset, offset + 2).arrayBuffer());
    if (frame[0] !== 0xff || (frame[1] & 0xf0) !== 0xf0) throw new Error('The packed-audio stream is missing a readable AAC or MPEG audio frame');
    if (frame[1] & 0x06) rawExt = 'mp3';
  }

  let blob, ext;
  if (output.mode === 'audio') {
    if (kind === 'ts') {
      const dm = new TsAudioDemuxer();
      for (const p of parts) { checkAbort(signal); dm.push(new Uint8Array(await p.arrayBuffer())); }
      if (!dm.chunks.length) throw new Error('No audio track found in this stream');
      ext = dm.ext; blob = new Blob(dm.chunks, { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/aac' });
    } else if (kind === 'raw-audio') {
      ext = rawExt; blob = new Blob(parts, { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/aac' });
    } else if (kind === 'fmp4') {
      if (!output.audioOnly) throw new Error('Audio cannot be extracted from a muxed or unverified MP4 without an MP4 demuxer. Choose a listed separate Audio rendition or download the video.');
      blob = new Blob([init, ...parts], { type: 'audio/mp4' }); ext = 'm4a';
    } else throw new Error('Cannot extract audio from this stream format');
  } else if (kind === 'ts') { blob = new Blob(parts, { type: 'video/mp2t' }); ext = 'ts'; }
  else if (kind === 'fmp4') { blob = new Blob([init, ...parts], { type: 'video/mp4' }); ext = 'mp4'; }
  else if (kind === 'raw-audio') { ext = rawExt; blob = new Blob(parts, { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/aac' }); }
  else throw new Error('Cannot save this recording format safely');

  checkAbort(signal);
  const base = safeBase(msg.name, { strict: false }) || 'recording';
  return { blobUrl: URL.createObjectURL(blob), filename: base + '.' + ext, size: blob.size,
    done: total, total, bytes: blob.size, outputRole: kind === 'raw-audio' ? 'audio' : output.outputRole, notice: output.notice };
}

/* ---- plain files (mp4 / webm / mp3 …): streamed with progress, so errors are visible ---- */
const CT_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/webm': 'weba', 'audio/flac': 'flac',
  'application/pdf': 'pdf',
};

async function runHttp(msg, job) {
  const { signal } = job.abort;
  const t0 = Date.now();
  const report = throttle((p) => { if (!signal.aborted && job.state === 'running') toBackground({ type: 'off:job', jobId: job.id, state: 'running', unit: 'bytes', ...p }); }, 300);
  report({ phase: 'Connecting...', done: 0, total: 0, bytes: 0 });
  const out = await downloadFile(msg.url, { signal, context: requestContext(msg.context), concurrency: msg.concurrency,
    onProgress: ({ bytes, total }) => report({ phase: 'Downloading', done: bytes, total, bytes, speed: bytes / Math.max(0.5, (Date.now() - t0) / 1000) }) });
  checkAbort(signal);
  const ct = (out.response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const blob = new Blob([out.blob], { type: ct || 'video/mp4' });
  const cdName = dispositionFilename(out.response.headers.get('content-disposition'));
  let urlExt = '';
  try { urlExt = (/\.([a-z0-9]{2,4})$/i.exec(new URL(msg.url).pathname) || [])[1] || ''; } catch (e) {}
  const cdExt = cdName && (/\.([a-z0-9]{2,4})$/i.exec(cdName) || [])[1];
  const supported = new Set([...Object.values(CT_EXT), 'ts', 'ogg', 'oga', 'opus', 'bin']);
  const suggested = (cdExt || urlExt || '').toLowerCase();
  const ext = CT_EXT[ct] || (supported.has(suggested) ? suggested : 'mp4');
  const base = safeBase(msg.name, { strict: false }) || safeBase(cdName, { strict: false }) || 'recording';
  // GM_download keeps the exact name the script asked for (extension included)
  const exact = msg.exactName ? safeFilename(msg.name) : '';
  checkAbort(signal);
  return { blobUrl: URL.createObjectURL(blob), filename: exact || base + '.' + ext, size: blob.size,
    done: blob.size, total: blob.size, bytes: blob.size, unit: 'bytes', outputRole: /^audio\//.test(ct) ? 'audio' : 'video', notice: '' };
}

function throttle(fn, ms) {
  let last = 0;
  return (a) => { const n = Date.now(); if (n - last >= ms || a.phase !== 'Downloading') { last = n; fn(a); } };
}
