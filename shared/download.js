const MB = 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 1024 * MB;
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_HTTP_RANGE_PARTS = 1024;

export class DownloadError extends Error {
  constructor(code, message, { retryable = false, diag, retryAfter = 0 } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.diag = diag;
    this.retryAfter = retryAfter;
  }
}

export function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError');
}

function bounded(promise, signal, timeout, abort) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); };
    const cancelled = () => { stop(); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', cancelled, { once: true });
    if (timeout > 0) timer = setTimeout(() => {
      const err = new DownloadError('DOWNLOAD_TIMEOUT', 'The download connection timed out. Retry Download; reopen the lecture if its link expired.', { retryable: true });
      stop(); reject(err); abort?.(err);
    }, timeout);
    Promise.resolve(promise).then((value) => { stop(); resolve(value); }, (err) => { stop(); reject(err); });
  });
}

export function waitRetry(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim());
  if (!m) return null;
  const start = Number(m[1]), end = Number(m[2]), total = Number(m[3]);
  return [start, end, total].every(Number.isSafeInteger) && start >= 0 && end >= start && total > end ? { start, end, total } : null;
}

export const identityBody = (r) => !r.headers.get('content-encoding') || /^identity$/i.test(r.headers.get('content-encoding').trim());
export function contentLength(r) {
  if (!identityBody(r)) return null;
  const value = r.headers.get('content-length');
  return /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export function entityOf(r) {
  return { etag: r.headers.get('etag') || '', modified: r.headers.get('last-modified') || '' };
}

function sameEntity(r, entity) {
  const current = entityOf(r);
  if (current.etag !== entity.etag || current.modified !== entity.modified) {
    throw new DownloadError('DOWNLOAD_CHANGED', 'The media changed during the download. A fresh complete copy is required.');
  }
}

const rangeError = () => new DownloadError('DOWNLOAD_RANGE', 'The server returned an invalid or inconsistent byte range. Retry Download; no partial file was saved.');
const rangeValidator = ({ etag, modified }) => {
  if (/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) return etag;
  const asctime = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ( [1-9]|[12]\d|3[01]) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(modified);
  const timestamp = Date.parse(asctime ? modified + ' GMT' : modified);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp), normalized = date.toUTCString();
  if (modified === normalized) return modified;
  // HTTP dates also permit RFC 850 and asctime. Compare parsed fields so
  // Date.parse cannot silently normalize an invalid calendar date or time.
  const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(modified);
  if (rfc850 && Number(rfc850[4]) === date.getUTCFullYear() % 100 &&
      normalized === `${rfc850[1].slice(0, 3)}, ${rfc850[2]} ${rfc850[3]} ${String(date.getUTCFullYear()).padStart(4, '0')} ${rfc850[5]} GMT`) return modified;
  return asctime && normalized === `${asctime[1]}, ${asctime[3].trim().padStart(2, '0')} ${asctime[2]} ${asctime[5]} ${asctime[4]} GMT` ? modified : '';
};
const unvalidatedRange = () => new DownloadError('DOWNLOAD_RANGE', 'The server only supplied part of the media without a usable ETag or Last-Modified validator. A complete response is required; no partial file was saved.');
const rangeLimit = () => new DownloadError('DOWNLOAD_RANGE_LIMIT', 'The server split the file into too many tiny byte ranges. Reopen the lecture or use the site\'s download; no partial file was saved.');
const incomplete = () => new DownloadError('DOWNLOAD_PARTIAL', 'The connection stopped before the complete file arrived. Retry Download.', { retryable: true });
const tooLarge = (limit = MAX_DOWNLOAD_BYTES) => new DownloadError('DOWNLOAD_TOO_LARGE', limit === MAX_DOWNLOAD_BYTES ?
  'This file exceeds the 1 GiB in-memory file limit. Choose a smaller quality or use the site\'s own download; this extension does not stream directly to disk.' :
  'The response exceeds its ' + (limit >= MB ? (limit / MB) + ' MiB' : limit + ' byte') + ' safety limit. No partial file was saved.');

function binaryResponse(r) {
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (/json|html|^text\//.test(ct)) throw new DownloadError('DOWNLOAD_NOT_MEDIA', 'The server returned a page or text instead of media. Reopen the lecture and retry Download.');
}

/** A lease covers the complete fetch/body sequence, including failures and retries. */
export async function withResponse(url, opts, consume) {
  const { signal, context, fetch: request = globalThis.fetch, connectTimeout = 20000 } = opts || {};
  const tries = Math.max(1, Math.min(4, opts?.tries ?? 3));
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    checkAbort(signal);
    const ctl = new AbortController();
    const cancelled = () => ctl.abort(signal.reason);
    signal?.addEventListener('abort', cancelled, { once: true });
    let lease, r;
    try {
      if (context) lease = await context.acquire(url, ctl.signal);
      checkAbort(ctl.signal);
      const headers = { ...(opts?.headers || {}) };
      if (opts?.range) headers.Range = 'bytes=' + opts.range.offset + '-' + (opts.range.end - 1);
      r = await bounded(request(url, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'manual', headers, signal: ctl.signal }),
        ctl.signal, connectTimeout, (err) => ctl.abort(err));
      if (r.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(r.status)) {
        throw new DownloadError('DOWNLOAD_REDIRECT', 'The media link redirected. Reopen the lecture so the current final URL is captured; request credentials were not forwarded.');
      }
      if (!r.ok) {
        const denied = r.status === 401 || r.status === 403;
        const retryAfter = Math.min(5000, Math.max(0, Number(r.headers.get('retry-after')) * 1000 || 0));
        // Server response bodies can echo cookies/tokens. Never put them in errors or diagnostics.
        throw new DownloadError(denied ? 'DOWNLOAD_ACCESS' : 'DOWNLOAD_HTTP',
          (denied ? 'Access denied' : 'Download failed') + ' (HTTP ' + r.status + '). Reopen the lecture and retry Download.',
          { retryable: TRANSIENT.has(r.status), retryAfter, diag: { url, status: r.status, headers: {} } });
      }
      return await consume(r, ctl.signal, attempt);
    } catch (err) {
      if (signal?.aborted) { checkAbort(signal); }
      last = err;
      if (err?.name === 'TypeError' || err?.name === 'NetworkError') {
        last = new DownloadError('DOWNLOAD_NETWORK', 'The media connection failed. Retry Download; reopen the lecture if its link expired.', { retryable: true });
        if (err.partial) last.partial = err.partial;
      }
    } finally {
      signal?.removeEventListener('abort', cancelled);
      ctl.abort();
      try { if (r?.body && !r.body.locked) r.body.cancel().catch(() => {}); } catch (err) {}
      if (lease != null) await context.release(lease);
    }
    if (!last?.retryable || attempt + 1 >= tries) throw last;
    await waitRetry(Math.max(last.retryAfter || 0, opts?.retryDelay ?? 400 * (attempt + 1) ** 2), signal);
  }
  throw last;
}

/** Reject body failures, but retain validated leading bytes for the HTTP resume path. */
export async function readBody(r, { signal, onBytes = () => {}, idleTimeout = 20000, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  const parts = []; let chunks = [], pending = 0, len = 0;
  const reader = r.body?.getReader();
  try {
    if (!reader) {
      const buf = await bounded(r.arrayBuffer(), signal, idleTimeout);
      if (buf.byteLength > maxBytes) throw tooLarge(maxBytes);
      len = buf.byteLength; parts.push(new Blob([buf])); onBytes(len);
    } else for (;;) {
      checkAbort(signal);
      const { done, value } = await bounded(reader.read(), signal, idleTimeout);
      if (done) break;
      if (len + value.byteLength > maxBytes) throw tooLarge(maxBytes);
      chunks.push(value); len += value.byteLength; pending += value.byteLength; onBytes(value.byteLength);
      if (pending >= 16 * MB) { parts.push(new Blob(chunks)); chunks = []; pending = 0; }
    }
    if (chunks.length) parts.push(new Blob(chunks));
    return { blob: new Blob(parts), len };
  } catch (err) {
    try { reader?.cancel().catch(() => {}); } catch (e) {}
    if (err.code !== 'DOWNLOAD_TOO_LARGE') {
      if (chunks.length) parts.push(new Blob(chunks));
      err.partial = { blob: new Blob(parts), len };
    }
    throw err;
  } finally { try { reader?.releaseLock(); } catch (err) {} }
}

export function validateRange(r, range, total, entity) {
  const cr = parseContentRange(r.headers.get('content-range'));
  if (r.status !== 206 || !identityBody(r) || !cr || cr.start !== range.offset || cr.end !== range.end - 1 ||
      (total != null && cr.total !== total) || (contentLength(r) != null && contentLength(r) !== range.end - range.offset)) throw rangeError();
  if (entity) sameEntity(r, entity);
  return cr;
}

export async function fetchBytes(url, opts = {}) {
  let range = opts.range, total = opts.total, entity = opts.entity;
  const parts = [], maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  if (range && (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.end) || range.offset < 0 || range.end <= range.offset)) throw rangeError();
  if (range && range.end - range.offset > maxBytes) throw tooLarge(maxBytes);
  for (;;) {
    const validator = entity && rangeValidator(entity);
    const requestOpts = range ? { ...opts, range, headers: { ...opts.headers, ...(validator ? { 'If-Range': validator } : {}) } } : opts;
    const result = await withResponse(url, requestOpts, async (r, signal) => {
      if (opts.binary) binaryResponse(r);
      let full = false, cr;
      if (range) {
        if (r.status === 200 && opts.sliceFull && identityBody(r) && !r.headers.get('content-range') && contentLength(r) != null) {
          full = true;
          if (total != null && contentLength(r) !== total) throw rangeError();
          if (entity) sameEntity(r, entity);
        } else {
          cr = parseContentRange(r.headers.get('content-range'));
          if (!cr || cr.end >= range.end) throw rangeError();
          validateRange(r, { offset: range.offset, end: cr.end + 1 }, total, entity);
        }
      } else if (r.status === 206 || r.headers.get('content-range')) {
        cr = parseContentRange(r.headers.get('content-range'));
        if (r.status !== 206 || !cr || !identityBody(r) || cr.start !== 0 || cr.end + 1 !== cr.total) throw rangeError();
      }
      const expected = cr ? cr.end - cr.start + 1 : contentLength(r);
      if (expected != null && expected > maxBytes) throw tooLarge(maxBytes);
      opts.onResponse?.(r, cr);
      const out = await readBody(r, { ...opts, signal });
      if (expected != null && out.len !== expected) throw incomplete();
      if (full && range.end > out.len) throw rangeError();
      return { blob: full ? out.blob.slice(range.offset, range.end) : out.blob,
        response: r, full: full ? out.blob : null, total: cr?.total ?? contentLength(r) };
    });
    parts.push(result.blob);
    if (!range || range.offset + result.blob.size === range.end) {
      const blob = new Blob(parts);
      return { bytes: await blob.arrayBuffer(), response: result.response, full: result.full, total: result.total };
    }
    entity ||= entityOf(result.response); total = result.total;
    if (!rangeValidator(entity)) throw unvalidatedRange();
    if (parts.length >= MAX_HTTP_RANGE_PARTS) throw rangeLimit();
    range = { ...range, offset: range.offset + result.blob.size };
  }
}

export const fetchBuffer = async (url, opts) => (await fetchBytes(url, opts)).bytes;
export async function fetchText(url, opts = {}) {
  const out = await fetchBytes(url, { maxBytes: 4 * MB, ...opts });
  return { text: new TextDecoder().decode(out.bytes), url: out.response.url || url };
}

/** Start with one full GET, not a HEAD/range probe that spends a single-use token. */
export async function downloadFile(url, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const progress = (bytes, total) => opts.onProgress?.({ bytes, total: total || 0 });
  let zeroBased = false;
  // Discard old pieces before one clean restart. Only range responses need an
  // explicit byte-zero request; ordinary-body failures keep a plain GET retry.
  for (let fresh = false; ; fresh = true) {
    const initialOpts = fresh ? { ...opts, range: null, headers: {
      ...Object.fromEntries(Object.entries(opts.headers || {}).filter(([k]) => !/^(range|if-range|if-none-match|if-modified-since)$/i.test(k))),
      ...(zeroBased ? { Range: 'bytes=0-' } : {}),
    } } : opts;
    let first;
    try {
      first = await withResponse(url, initialOpts, async (r, signal) => {
        binaryResponse(r);
        const hasRange = r.status === 206 || !!r.headers.get('content-range');
        const cr = hasRange ? parseContentRange(r.headers.get('content-range')) : null;
        if (!fresh) zeroBased = hasRange && identityBody(r);
        if (hasRange && (r.status !== 206 || !cr || !identityBody(r) || cr.start !== 0)) throw rangeError();
        const total = cr?.total ?? contentLength(r), expected = cr ? cr.end + 1 : total;
        if (total != null && total > maxBytes) throw tooLarge(maxBytes);
        if (cr && contentLength(r) != null && contentLength(r) !== expected) throw rangeError();
        let loaded = 0; progress(0, total);
        let out, err;
        try { out = await readBody(r, { ...opts, signal, maxBytes, onBytes: (n) => { loaded += n; progress(loaded, total); } }); }
        catch (e) {
          if (!e.partial || signal.aborted || e.code === 'DOWNLOAD_TOO_LARGE') throw e;
          if (!(e.retryable || e.name === 'TypeError' || e.name === 'NetworkError')) throw e;
          out = e.partial; err = e;
        }
        if (expected != null && out.len > expected) throw rangeError();
        if (expected != null && out.len < expected) err ||= incomplete();
        const entity = entityOf(r), validator = rangeValidator(entity);
        const resumable = total && out.len && out.len < total && identityBody(r) && validator &&
          (cr || /\bbytes\b/i.test(r.headers.get('accept-ranges') || ''));
        if (fresh && err && !resumable) throw err;
        return { ...out, response: r, total, cr, err, entity, validator, resumable };
      });
    } catch (err) {
      if (!fresh && err.code === 'DOWNLOAD_RANGE') continue;
      throw err;
    }
    checkAbort(opts.signal);
    if (!first.err && (first.total == null || first.len === first.total)) {
      if (!first.len) throw new DownloadError('DOWNLOAD_EMPTY', 'The server sent an empty file');
      return first;
    }
    const { entity, validator } = first;
    if (!first.resumable) {
      if (!fresh) { first = null; continue; }
      throw first.err || (!validator && first.cr ? unvalidatedRange() : rangeError());
    }

    const ctl = new AbortController(), cancel = () => ctl.abort(opts.signal.reason);
    opts.signal?.addEventListener('abort', cancel, { once: true });
    const total = first.total, start = first.len;
    const wanted = Number.isInteger(opts.concurrency) ? Math.max(1, Math.min(16, opts.concurrency)) : 8;
    const piece = Math.min(8 * MB, Math.max(MB, Math.ceil((total - start) / (wanted * 3))));
    const intervals = [];
    for (let offset = start; offset < total; offset += piece) intervals.push({ offset, end: Math.min(total, offset + piece) });
    const parts = new Array(intervals.length), loaded = new Array(intervals.length).fill(0);
    let next = 0;
    const workers = Array.from({ length: Math.min(wanted, intervals.length) }, async () => {
      for (;;) {
        checkAbort(ctl.signal);
        const i = next++;
        if (i >= intervals.length) return;
        const interval = intervals[i], chunks = [];
        let offset = interval.offset;
        // Some media servers cap each response below the requested end. Fetch the remainder,
        // but only join contiguous, complete spans from the same validated file.
        while (offset < interval.end) {
          if (chunks.length >= MAX_HTTP_RANGE_PARTS) throw rangeLimit();
          const range = { offset, end: interval.end };
          const out = await withResponse(url, { ...opts, signal: ctl.signal, range, headers: { ...opts.headers, 'If-Range': validator } }, async (r, signal) => {
            binaryResponse(r);
            const cr = parseContentRange(r.headers.get('content-range'));
            if (!cr || cr.end >= range.end) throw rangeError();
            validateRange(r, { offset, end: cr.end + 1 }, total, entity);
            loaded[i] = offset - interval.offset;
            let body;
            try {
              body = await readBody(r, { ...opts, signal, maxBytes: cr.end - cr.start + 1, onBytes: (n) => {
                loaded[i] += n;
                if (!ctl.signal.aborted) progress(Math.min(total, start + loaded.reduce((s, x) => s + x, 0)), total);
              } });
            } catch (error) { if (error.code === 'DOWNLOAD_TOO_LARGE') throw rangeError(); throw error; }
            if (body.len !== cr.end - cr.start + 1) throw incomplete();
            return body;
          });
          chunks.push(out.blob); offset += out.len;
        }
        parts[i] = new Blob(chunks);
      }
    });
    try {
      await Promise.all(workers);
      checkAbort(opts.signal);
      if (parts.includes(undefined)) throw incomplete();
      const blob = new Blob([first.blob, ...parts]);
      if (blob.size !== total) throw incomplete();
      return { blob, len: blob.size, response: first.response };
    } catch (err) {
      ctl.abort(err);
      await Promise.allSettled(workers);
      checkAbort(opts.signal);
      if (!fresh && (err.code === 'DOWNLOAD_RANGE' || err.code === 'DOWNLOAD_CHANGED')) { first = null; parts.length = 0; continue; }
      throw err;
    } finally { opts.signal?.removeEventListener('abort', cancel); }
  }
}
