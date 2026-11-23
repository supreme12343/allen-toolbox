export const PDF_REOPEN = 'Reopen the PDF in the ALLEN viewer, wait until it loads, then try again.';

export class PdfError extends Error {
  constructor(code, message, diag) {
    super(message);
    this.code = code;
    this.diag = diag;
  }
}

export function canUseCapturedPdf(entry, { scope, captureId, capturedAt } = {}) {
  return !!(entry && entry.source === 'capture' && entry.validated && entry.bytes?.byteLength &&
    scope && entry.scope === scope && captureId && entry.captureId === captureId &&
    (capturedAt == null || entry.capturedAt === capturedAt));
}

export function allowsCapturedFallback(code) {
  return ['PDF_PERMISSION', 'PDF_CONTEXT', 'PDF_ACCESS', 'PDF_HTTP', 'PDF_NOT_PDF', 'PDF_NETWORK', 'PDF_REDIRECT', 'PDF_PARTIAL', 'PDF_FETCH'].includes(code);
}

export function isViewerStream(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && /\/stream\/?$/i.test(u.pathname) &&
      [...u.searchParams.keys()].some((k) => k.toLowerCase() === 'token');
  } catch (e) { return false; }
}

export function viewerStreamKey(url) {
  if (!isViewerStream(url)) return '';
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (k.toLowerCase() === 'token') u.searchParams.delete(k);
  u.hash = '';
  u.searchParams.sort();
  return u.href;
}

export function pdfRouteHref(href) {
  try {
    const u = new URL(href), hash = u.hash.slice(1);
    const fields = [...new URLSearchParams(hash)];
    if (!hash || (fields.length && fields.every(([k, v]) =>
      /^(page|zoom|search|phrase|nameddest|pagemode|view|viewrect|highlight|toolbar|navpanes|scrollbar|statusbar|messages)$/i.test(k) &&
      (k.toLowerCase() !== 'page' || /^[1-9]\d*$/.test(v))))) u.hash = '';
    return u.href;
  } catch (e) { return String(href || ''); }
}

export function validatePdfResponse(meta, size) {
  const status = Number(meta.status);
  if (status < 200 || status >= 300 || !Number.isFinite(status)) {
    const denied = status === 401 || status === 403;
    throw new PdfError(denied ? 'PDF_ACCESS' : 'PDF_HTTP',
      (denied ? 'PDF access denied' : 'The PDF link may have expired') + ' (HTTP ' + status + '). ' + PDF_REOPEN, meta.diag);
  }
  const partial = () => new PdfError('PDF_PARTIAL', 'The server returned an incomplete PDF, not the whole document. ' + PDF_REOPEN, meta.diag);
  if (status === 206 || meta.range) {
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(meta.range || '').trim());
    if (!m || +m[1] !== 0 || +m[2] + 1 !== +m[3] || !Number.isSafeInteger(+m[3]) || +m[3] <= 0 ||
      (meta.encoding && !/^identity$/i.test(meta.encoding)) || (size != null && size !== +m[3])) throw partial();
  }
  // Fetch decodes compressed bodies, so their wire Content-Length is not the PDF byte length.
  if (size != null && (!meta.encoding || /^identity$/i.test(meta.encoding))) {
    const length = String(meta.length == null ? '' : meta.length).trim();
    if (/^\d+$/.test(length) && size !== Number(length)) throw partial();
  }
}

export function validatePdfBytes(bytes, meta) {
  validatePdfResponse(meta, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw new PdfError('PDF_NOT_PDF', 'The viewer link returned a non-PDF response; the login or token may have expired. ' + PDF_REOPEN, meta.diag);
  }
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
  const end = /startxref\s+(\d+)\s+%%EOF[\s\x00]*$/.exec(tail);
  if (!end || Number(end[1]) >= bytes.length) {
    throw new PdfError('PDF_PARTIAL', 'The PDF is missing its complete end-of-file data. ' + PDF_REOPEN, meta.diag);
  }
  return bytes;
}
