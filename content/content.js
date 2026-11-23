/*
 * ALLEN Toolbox — content script (isolated world).
 * Bridges the page-world script (main.js) and the extension: forwards settings to the page,
 * reports detected documents/media to the background, uploads captured PDF bytes for naming,
 * and runs the small on-page tools (overlay removal, toast, page text).
 */
(() => {
  'use strict';
  if (window.__aoContent) return;
  window.__aoContent = true;

  const IS_TOP = window.top === window;
  const rt = chrome.runtime;
  const MAX_CAPTURE_BYTES = 100 * 1024 * 1024;
  const send = (msg) => { try { return rt.sendMessage(msg).catch(() => null); } catch (e) { return Promise.resolve(null); } };
  const routeHref = (href) => {
    try {
      const u = new URL(href), hash = u.hash.slice(1), fields = [...new URLSearchParams(hash)];
      if (!hash || (fields.length && fields.every(([k, v]) =>
        /^(page|zoom|search|phrase|nameddest|pagemode|view|viewrect|highlight|toolbar|navpanes|scrollbar|statusbar|messages)$/i.test(k) &&
        (k.toLowerCase() !== 'page' || /^[1-9]\d*$/.test(v))))) u.hash = '';
      return u.href;
    } catch (e) { return href; }
  };

  let cfg = null;
  let currentRoute = null, knownGeneration = null;
  let routeReady = Promise.resolve(null);
  const blockedRoutes = new Set();
  const localPageId = 'isolated:' + Date.now().toString(36) + Math.random().toString(36).slice(2);

  /* ------------------------------------------------------------------ *
   * Config → page world
   * ------------------------------------------------------------------ */
  function pushCfg() {
    if (!cfg) return;
    try { document.dispatchEvent(new CustomEvent('ao:cfg', { detail: JSON.stringify(cfg) })); } catch (e) {}
  }
  document.addEventListener('ao:req', pushCfg);

  // Things the page reports before the settings arrive (the background worker may still be waking up)
  // are kept and replayed, because a single-use viewer link can only be captured once.
  const early = [];
  let earlyBytes = 0;
  const configReady = send({ type: 'get-config' }).then((c) => {
    if (!c) return;
    cfg = c; pushCfg();
    earlyBytes = 0;
    for (const d of early.splice(0)) onPageMessage(d);
    startDetection();
  });

  rt.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen') return;
    switch (msg.type) {
      case 'cfg': cfg = msg.cfg; pushCfg(); break;
      case 'capture-reset':
        if (!(IS_TOP && msg.sourceFrameId === 0)) resetCaptures(msg.generation);
        break;
      case 'toast': toast(msg.text); break;
      case 'tool:overlays': { const n = nukeOverlays(); toast('Overlays removed: ' + n); sendResponse({ n }); break; }
      case 'tool:restore-overlays': { const n = restoreOverlays(); toast('Overlays restored: ' + n); sendResponse({ n }); break; }
      case 'tool:text': sendResponse({ text: document.body ? document.body.innerText : '' }); break;
      case 'tool:links': {
        const seen = new Set(), links = [];
        for (const link of document.querySelectorAll('a[href]')) {
          try {
            const url = new URL(link.href, document.baseURI);
            if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) continue;
            seen.add(url.href);
            links.push({ url: url.href, title: (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
          } catch (e) {}
        }
        sendResponse({ links }); break;
      }
      case 'tool:reading': sendResponse(openReadingView()); break;
      case 'tool:scan':
        configReady.then(async () => {
          if (!cfg) throw new Error('The extension is still starting. Reopen the toolbox and try again.');
          const n = scanPage(true);
          await flush();
          sendResponse({ n });
        }).catch((error) => sendResponse({ error: error.message }));
        return true;
      case 'tool:print': window.print(); sendResponse({ ok: true }); break;
      case 'tool:fullscreen':
        (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
          .then(() => sendResponse({ ok: true }), () => sendResponse({ error: 'Fullscreen needs a click inside the webpage. Use the player fullscreen button or F11.' }));
        return true;
      default: break;
    }
  });

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */
  function toast(text) {
    if (!IS_TOP || !document.documentElement) return;
    try {
      const d = document.createElement('div');
      d.textContent = text;
      d.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;' +
        'background:#14171c;color:#fff;font:600 13px system-ui,sans-serif;padding:9px 15px;border-radius:10px;' +
        'border:1px solid #2b303a;box-shadow:0 10px 30px rgba(0,0,0,.45);pointer-events:none';
      document.documentElement.appendChild(d);
      setTimeout(() => d.remove(), 2200);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * Overlay removal (Alt+O / popup / Alt+Shift+O)
   * ------------------------------------------------------------------ */
  const removedOverlays = new Map(), overlayScroll = new Map();
  function nukeOverlays() {
    let n = 0;
    const vw = innerWidth, vh = innerHeight;
    document.querySelectorAll('body *').forEach((el) => {
      if (/^(VIDEO|AUDIO|CANVAS|IFRAME|EMBED|OBJECT|SCRIPT|STYLE|SVG|IMG)$/.test(el.tagName) || (el.id || '').startsWith('ao-')) return;
      let cs, r;
      try { cs = getComputedStyle(el); r = el.getBoundingClientRect(); } catch (e) { return; }
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
      if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') return;
      const z = parseInt(cs.zIndex, 10) || 0;
      const covers = r.width > vw * 0.55 && r.height > vh * 0.55;
      const txt = (el.textContent || '').trim().toLowerCase();
      const known = /overlay|backdrop|blocker|modal-mask|scrim/i.test(typeof el.className === 'string' ? el.className : '');
      const blockingText = txt.length < 600 && /right.?click.{0,30}(block|disable)|restrict|devtool|copy.{0,30}(block|disable)|screenshot.{0,30}(block|disable)/.test(txt);
      if (covers && ((z >= 900 && (known || (!txt && !el.childElementCount))) || blockingText)) {
        if (el.querySelector('video, audio, canvas, iframe, embed, object, form, input, textarea, select')) return;
        if (!removedOverlays.has(el)) removedOverlays.set(el, { display: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') });
        el.style.setProperty('display', 'none', 'important'); n++;
      }
    });
    if (n) for (const element of [document.body, document.documentElement]) {
      if (!element) continue;
      if (!overlayScroll.has(element)) overlayScroll.set(element, { value: element.style.getPropertyValue('overflow-y'), priority: element.style.getPropertyPriority('overflow-y') });
      element.style.setProperty('overflow-y', 'auto', 'important');
    }
    return n;
  }

  function restoreOverlays() {
    let n = 0;
    for (const [element, saved] of removedOverlays) {
      if (element.style.getPropertyValue('display') === 'none' && element.style.getPropertyPriority('display') === 'important') {
        if (saved.display) element.style.setProperty('display', saved.display, saved.priority);
        else element.style.removeProperty('display');
        if (element.isConnected) n++;
      }
    }
    removedOverlays.clear();
    for (const [element, saved] of overlayScroll) {
      if (element.style.getPropertyValue('overflow-y') !== 'auto' || element.style.getPropertyPriority('overflow-y') !== 'important') continue;
      if (saved.value) element.style.setProperty('overflow-y', saved.value, saved.priority); else element.style.removeProperty('overflow-y');
    }
    overlayScroll.clear();
    return n;
  }

  let readingHost = null;
  function openReadingView() {
    if (!IS_TOP) return { error: 'Open reading view from the main page.' };
    if (readingHost && readingHost.isConnected) return { ok: true };
    const candidates = [...document.querySelectorAll('article, main, [role="main"]')];
    const article = candidates.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0] || document.body;
    const text = article ? article.innerText.trim() : '';
    if (!text) return { error: 'This page has no readable text. For scanned PDFs, use the PDF viewer or its OCR tools.' };
    const previousFocus = document.activeElement;
    const host = document.createElement('div'); host.id = 'ao-reading-view';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{color-scheme:light}*{box-sizing:border-box}.reader{height:100%;overflow:auto;background:#f4f5f7;color:#252b35;font:18px/1.8 Georgia,serif}nav{position:sticky;top:0;display:flex;gap:8px;align-items:center;background:#fff;border-bottom:1px solid #d5dbe4;padding:12px 20px;font:14px system-ui}nav span{flex:1}button{font:inherit;background:#fff;color:#252b35;border:1px solid #96a2b3;border-radius:4px;padding:8px 12px;cursor:pointer}button:focus-visible{outline:3px solid #2d66b4;outline-offset:2px}article{max-width:760px;margin:0 auto;padding:28px 22px 80px}h1{font-size:1.6em;line-height:1.3}.text{white-space:pre-wrap;overflow-wrap:anywhere}';
    const reader = document.createElement('section'); reader.className = 'reader';
    reader.setAttribute('role', 'dialog'); reader.setAttribute('aria-modal', 'true'); reader.setAttribute('aria-label', 'Focus reading view');
    const nav = document.createElement('nav'), label = document.createElement('span'); label.textContent = 'Focus reading';
    const smaller = document.createElement('button'), larger = document.createElement('button'), close = document.createElement('button');
    smaller.textContent = 'A-'; smaller.setAttribute('aria-label', 'Smaller reading text');
    larger.textContent = 'A+'; larger.setAttribute('aria-label', 'Larger reading text'); close.textContent = 'Close';
    let size = 18;
    smaller.onclick = () => { size = Math.max(14, size - 2); reader.style.fontSize = size + 'px'; };
    larger.onclick = () => { size = Math.min(32, size + 2); reader.style.fontSize = size + 'px'; };
    const dismiss = () => { host.remove(); readingHost = null; window.removeEventListener('keydown', onKey, true); if (previousFocus && previousFocus.isConnected) previousFocus.focus(); };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); }
      if (event.key === 'Tab') {
        const focusables = [smaller, larger, close];
        const index = focusables.indexOf(shadow.activeElement);
        if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === focusables.length - 1)) {
          event.preventDefault(); focusables[event.shiftKey ? focusables.length - 1 : 0].focus();
        }
      }
    };
    close.onclick = dismiss;
    nav.append(label, smaller, larger, close);
    const content = document.createElement('article'), title = document.createElement('h1'), body = document.createElement('div');
    title.textContent = document.title; body.className = 'text'; body.textContent = text;
    content.append(title, body); reader.append(nav, content); shadow.append(style, reader);
    document.documentElement.appendChild(host); readingHost = host;
    window.addEventListener('keydown', onKey, true); close.focus();
    return { ok: true, words: text.split(/\s+/).filter(Boolean).length };
  }

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (/input|textarea|select/i.test((document.activeElement || {}).tagName || '') || document.activeElement?.isContentEditable) return;
    if (e.key.toLowerCase() === 'o') { e.preventDefault(); toast('Overlays removed: ' + nukeOverlays()); }
  }, true);

  /* ------------------------------------------------------------------ *
   * Detection → background
   * ------------------------------------------------------------------ */
  const SEGMENT = /\.(ts|m4s|cmf[va]|mts)(\?|#|$)|[\/_-](seg|chunk|frag(ment)?)[-_]?\d+/i;
  function classify(url) {
    if (!url || /^(blob|data):/.test(url)) return null;
    try {
      const u = new URL(url);
      if (/\/stream\/?$/i.test(u.pathname) && [...u.searchParams.keys()].some((k) => k.toLowerCase() === 'token')) return 'pdf';
    } catch (e) {}
    if (/\.pdf(\?|#|$)/i.test(url)) return 'pdf';
    if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    if (SEGMENT.test(url)) return null;
    if (/\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(url)) return 'media';
    return null;
  }
  function ctKind(ct) {
    if (/mpegurl/i.test(ct)) return 'hls';
    if (/dash\+xml/i.test(ct)) return 'dash';
    if (/application\/pdf/i.test(ct)) return 'pdf';
    if (/^(video|audio)\//i.test(ct) && !/mp2t|iso\.segment/i.test(ct)) return 'media';
    return null;
  }

  const sent = new Map();
  const latestCaptures = new Map();
  let queue = [];
  let flushTimer = null;

  function clearReports() {
    sent.clear(); latestCaptures.clear(); queue = [];
    clearTimeout(flushTimer); flushTimer = null;
    for (const u of uploading.values()) send({ target: 'offscreen', type: 'pdf-cancel', scope: u.scope, uploadId: u.uploadId });
    uploading.clear(); uploaded.clear();
  }

  function resetCaptures(generation) {
    if (currentRoute) {
      blockedRoutes.add(currentRoute.routeId);
      while (blockedRoutes.size > 100) blockedRoutes.delete(blockedRoutes.values().next().value);
    }
    clearReports(); currentRoute = null; knownGeneration = generation;
    try { document.dispatchEvent(new CustomEvent('ao:capture-reset')); } catch (e) {}
  }

  function setRoute(d) {
    if (!d.routeId || blockedRoutes.has(d.routeId)) return;
    if (currentRoute && currentRoute.routeId === d.routeId) return;
    clearReports();
    const ctx = { pageId: d.pageId, routeId: d.routeId, pageHref: routeHref(d.pageHref || location.href), routeAt: d.routeAt || Date.now() };
    currentRoute = ctx;
    routeReady = send({ type: 'route', context: ctx, initial: !!d.initial, reset: !!d.reset, generation: knownGeneration }).then((r) => {
      if (currentRoute !== ctx) return null;
      if (r && r.stale) { resetCaptures(r.generation); return null; }
      if (r && r.scope) knownGeneration = r.generation;
      return r;
    });
  }

  function ensureRoute() {
    if (!currentRoute) setRoute({ pageId: localPageId, routeId: localPageId + ':' + Date.now(), pageHref: routeHref(location.href), routeAt: Date.now(), initial: true });
    return currentRoute;
  }

  function rememberCapture(d) {
    const old = latestCaptures.get(d.url);
    const at = d.capturedAt || Date.now(), order = d.captureOrder || 0;
    if (old && (old.at > at || (old.at === at && old.order > order))) return false;
    latestCaptures.set(d.url, { at, order, captureId: d.captureId });
    return true;
  }

  function report(kind, url, extra) {
    if (!kind || !url) return;
    if (kind === 'pdf' && !(cfg && cfg.pdfDetect)) return;
    if (kind !== 'pdf' && !(cfg && cfg.mediaDetect)) return;
    ensureRoute();
    const key = kind + ' ' + url;
    if (sent.has(key) && !(extra && (extra.uploaded || extra.refresh || (extra.captureId && extra.captureId !== sent.get(key))))) return;
    sent.set(key, extra && extra.captureId);
    queue.push(Object.assign({ kind, url, capturedAt: Date.now() }, extra || {}));
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 250);
  }

  async function flush() {
    if (!queue.length) return;
    const items = queue; queue = [];
    const ctx = currentRoute, r = await routeReady;
    if (ctx !== currentRoute || !r || !r.scope) return;
    await send({ type: 'found', items, context: { ...ctx, generation: r.generation, scope: r.scope }, title: IS_TOP ? document.title : '' });
  }

  function scanPage(resources = false) {
    if (!cfg) return 0;
    let n = 0;
    for (const element of document.querySelectorAll('video, audio, video source, audio source, iframe[src], embed[src], object[data], a[href]')) {
      const url = element.currentSrc || element.src || element.data || element.href;
      let kind = classify(url);
      if (!kind && /^(IFRAME|EMBED|OBJECT)$/.test(element.tagName) && /application\/pdf/i.test(element.type || '')) kind = 'pdf';
      if (kind) { report(kind, url, { via: 'element', refresh: resources }); n++; }
    }
    if (resources) for (const entry of performance.getEntriesByType('resource')) {
      if (currentRoute && performance.timeOrigin + entry.startTime < currentRoute.routeAt) continue;
      const kind = classify(entry.name);
      if (kind) { report(kind, entry.name, { via: 'timing', refresh: true }); n++; }
    }
    return n;
  }

  function startDetection() {
    if (startDetection.done) return;
    startDetection.done = true;

    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (currentRoute && performance.timeOrigin + e.startTime < currentRoute.routeAt) continue;
          const k = classify(e.name);
          if (k) report(k, e.name, { size: e.encodedBodySize || 0, via: 'timing', capturedAt: Math.floor(performance.timeOrigin + e.startTime) });
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (e) {}

    scanPage();
    setInterval(scanPage, 2500);

    if (IS_TOP) {
      let lastTitle = document.title;
      setInterval(() => {
        if (document.title !== lastTitle) { lastTitle = document.title; send({ type: 'title', title: lastTitle }); }
      }, 2000);
    }
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__ao !== true) return;
    if (!['route', 'pdf-url', 'pdf', 'media-ct'].includes(d.kind)) return;
    if (d.kind === 'route') {
      if (typeof d.pageHref !== 'string' || typeof d.routeId !== 'string' || d.routeId.length > 512) return;
    } else if (typeof d.url !== 'string' || d.url.length > 65536 || !/^(https?:|blob:|data:)/i.test(d.url)) return;
    if (d.blob != null && (!(d.blob instanceof Blob) || d.blob.size > MAX_CAPTURE_BYTES)) {
      if (cfg && d.kind === 'pdf') report('pdf', d.url, { size: d.blob instanceof Blob ? d.blob.size : 0, captureError: 'Automatic captured copies are limited to 100 MB. Use direct PDF Save.' });
      return;
    }
    if (!cfg) {
      const size = d.blob instanceof Blob ? d.blob.size : 0;
      while (early.length && (early.length >= 200 || earlyBytes + size > 120 * 1024 * 1024)) {
        const old = early.shift(); earlyBytes -= old.blob instanceof Blob ? old.blob.size : 0;
      }
      early.push(d); earlyBytes += size; return;
    }
    onPageMessage(d);
  });

  function onPageMessage(d) {
    if (d.kind === 'route') { setRoute(d); return; }
    if (d.routeId) {
      if (blockedRoutes.has(d.routeId) || routeHref(d.pageHref) !== routeHref(location.href)) return;
      if (!currentRoute) setRoute({ ...d, initial: true });
      if (!currentRoute || d.routeId !== currentRoute.routeId) return;
    }
    if (d.kind === 'media-ct') report(ctKind(d.ct), d.url, { ct: d.ct, via: 'headers', capturedAt: d.capturedAt });
    else if (d.kind === 'pdf-url' && rememberCapture(d)) {
      report('pdf', d.url, { ...d, kind: 'pdf', refresh: true });
      flush();
    }
    else if (d.kind === 'pdf') handlePdf(d);
  }

  /* ------------------------------------------------------------------ *
   * PDF bytes → offscreen document (for naming + later saving)
   * ------------------------------------------------------------------ */
  const uploaded = new Map();
  const uploading = new Map();
  const blobToB64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  async function handlePdf(d) {
    if (!(cfg && cfg.pdfDetect) || !d.complete || !(d.blob instanceof Blob) || !rememberCapture(d) || uploaded.get(d.url) === d.captureId) return;
    if (uploading.size >= 2) { report('pdf', d.url, { size: d.blob.size, captureError: 'Two PDF captures are already being prepared. Use direct Save if this copy is not cached.' }); return; }
    const ctx = ensureRoute();
    const active = () => currentRoute === ctx && latestCaptures.get(d.url)?.captureId === d.captureId;
    uploaded.set(d.url, d.captureId);
    report('pdf', d.url, { size: d.blob.size, via: 'capture', captureId: d.captureId, captureOrder: d.captureOrder, capturedAt: d.capturedAt });
    flush();
    let scope = '', complete = false;
    const uploadId = d.captureId;
    try {
      const r = await routeReady;
      if (!active() || !r || !r.scope) return;
      scope = r.scope;
      uploading.set(uploadId, { scope, uploadId });
      const ensured = await send({ type: 'ensure-offscreen' });
      if (!ensured || ensured.error) throw new Error(ensured && ensured.error || 'PDF worker unavailable');
      const CH = 6 * 1024 * 1024;
      const total = Math.max(1, Math.ceil(d.blob.size / CH));
      for (let i = 0; i < total; i++) {
        if (!active()) return;
        const b64 = await blobToB64(d.blob.slice(i * CH, (i + 1) * CH));
        if (!active()) return;
        const r = await rt.sendMessage({
          target: 'offscreen', type: 'pdf-chunk', url: d.url, scope, uploadId, captureId: d.captureId,
          capturedAt: d.capturedAt, captureOrder: d.captureOrder, cd: d.cd, index: i, total, b64, size: d.blob.size, response: d.response,
          analyse: !!cfg.pdfPrefetch, preferText: !!cfg.pdfPreferText,
        });
        if (!r || r.error) throw new Error(r && r.error || 'The PDF worker did not acknowledge the captured data.');
      }
      if (!active()) return;
      complete = true;
      report('pdf', d.url, { size: d.blob.size, uploaded: true, captureId: d.captureId, captureOrder: d.captureOrder, capturedAt: d.capturedAt });
      flush();
    } catch (e) {
      if (active()) report('pdf', d.url, { captureError: 'Captured copy could not be cached: ' + e.message, refresh: true });
    } finally {
      uploading.delete(uploadId);
      if (!complete) {
        if (uploaded.get(d.url) === d.captureId) uploaded.delete(d.url);
        if (scope) send({ target: 'offscreen', type: 'pdf-cancel', scope, uploadId });
      }
    }
  }
})();
