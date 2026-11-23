/*
 * ALLEN Toolbox — page-world script.
 * Runs inside the page (world: MAIN) at document_start so it can undo the site's own
 * restrictions before the site's scripts run. It has no access to extension APIs; settings
 * arrive from content.js through the "ao:cfg" DOM event, and captured data goes back to
 * content.js through window.postMessage.
 */
(() => {
  'use strict';
  if (window.__aoMain) return;
  Object.defineProperty(window, '__aoMain', { value: true });

  const IS_TOP = window.top === window;
  var extraAllow = new Set();   // filled by plugins (see section 6)

  // Install hooks early, but wait for saved settings before changing page behavior.
  const CFG = {
    contextmenu: false, selection: false, clipboard: false, drag: false,
    keys: false, zoom: false, unload: false, alerts: false,
    printCss: false, unblur: false, scrollLock: false, watermark: false,
    pdfDetect: true, viewerArgs: false, viewerButtons: false, mediaDetect: true,
    consoleClear: false, viewport: false,
  };

  const post = (data) => { try { window.postMessage(Object.assign({ __ao: true }, data), '*'); } catch (e) {} };

  /* ------------------------------------------------------------------ *
   * 1. Undo event blocking (preventDefault / returnValue neutralised)
   * ------------------------------------------------------------------ */
  const COMBO = new Set(['a', 'c', 'f', 'p', 's', 'u', 'v', 'x', 'i', 'j']);
  const editing = (ev) => {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
    return path.some((node) => node && node.nodeType === 1 &&
      (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.getAttribute('role') === 'textbox'));
  };

  function allow(ev) {
    try {
      const t = ev.type;
      if (extraAllow.has(t)) return true;
      if (CFG.contextmenu && t === 'contextmenu') return true;
      if (CFG.selection && t === 'selectstart') return true;
      if (CFG.clipboard && /^(copy|cut|paste|beforecopy|beforecut|beforepaste)$/.test(t) && !editing(ev)) return true;
      if (CFG.drag && /^(dragstart|drag|dragend)$/.test(t)) return true;
      if (CFG.unload && t === 'beforeunload') return true;
      if (CFG.zoom && ((t === 'wheel' && ev.ctrlKey) || /^gesture(start|change)$/.test(t))) return true;
      if (CFG.keys && (t === 'keydown' || t === 'keypress')) {
        const k = (ev.key || '').toLowerCase();
        if (['f5', 'f7', 'f11', 'f12'].includes(k)) return true;
        if (editing(ev)) return false;
        if ((ev.ctrlKey || ev.metaKey) && COMBO.has(k)) return true;
        if (ev.ctrlKey && ev.shiftKey && ['i', 'j', 'c', 'k', 'e'].includes(k)) return true;
      }
    } catch (e) {}
    return false;
  }

  const origPD = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    if (allow(this)) return;
    return origPD.call(this);
  };

  try {
    const d = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue') || {};
    Object.defineProperty(Event.prototype, 'returnValue', {
      configurable: true, enumerable: true,
      get() { try { return d.get ? d.get.call(this) : !this.defaultPrevented; } catch (e) { return true; } },
      set(v) {
        if (v === false && allow(this)) return;
        if (typeof d.set === 'function') d.set.call(this, v);
      },
    });
  } catch (e) {}

  // Keep handlers registered so switching the fix off restores unsaved-work warnings.
  window.addEventListener('beforeunload', (event) => {
    if (CFG.unload) event.stopImmediatePropagation();
  }, true);

  /* ------------------------------------------------------------------ *
   * 2. Stylesheet (rebuilt whenever a switch changes)
   * ------------------------------------------------------------------ */
  const CSS_SELECT = `
    html, body, * { -webkit-user-select: text !important; user-select: text !important;
      -webkit-touch-callout: default !important; }
    .textLayer, .textLayer span, .textLayer br, .textLayer > div { user-select: text !important;
      -webkit-user-select: text !important; pointer-events: auto !important; }
    .pdfViewer .canvasWrapper { user-select: none !important; }`;
  const CSS_PRINT = `
    @media print {
      html, body, #app, #root, #__next, main, .content, .viewer, .pdfViewer, .page, .exam {
        display: block !important; visibility: visible !important; height: auto !important;
        max-height: none !important; overflow: visible !important; }
      * { visibility: visible !important; }
      .no-print, .hide-print, .print-hide { display: none !important; }
      canvas, img, svg { max-width: 100% !important; break-inside: avoid; }
      .page, .question { break-inside: avoid; page-break-inside: avoid; } }`;
  const CSS_PDFJS = `
    #download, #secondaryDownload, #print, #secondaryPrint, #openFile, #secondaryOpenFile,
    #viewBookmark, #secondaryViewBookmark, #toolsToggle, #editorStampParamsToolbar {
      display: inline-block !important; visibility: visible !important; opacity: 1 !important; }
    #toolbar, .toolbar { display: flex !important; visibility: visible !important; }`;
  const CSS_WM = '.ao-wm { display: none !important; }';

  function buildCss() {
    const parent = document.head || document.documentElement;
    if (!parent) return;
    let st = document.getElementById('ao-style');
    if (!st) { st = document.createElement('style'); st.id = 'ao-style'; parent.appendChild(st); }
    const isPdfjs = !!document.getElementById('viewerContainer');
    const css = (CFG.selection ? CSS_SELECT : '') + (CFG.printCss ? CSS_PRINT : '') +
      (CFG.viewerButtons && isPdfjs ? CSS_PDFJS : '') + (CFG.watermark ? CSS_WM : '');
    if (st.textContent !== css) st.textContent = css;
  }

  /* ------------------------------------------------------------------ *
   * 3. DOM clean-up
   * ------------------------------------------------------------------ */
  const INLINE = { oncontextmenu: 'contextmenu', oncopy: 'clipboard', oncut: 'clipboard', onpaste: 'clipboard', onselectstart: 'selection', ondragstart: 'drag' };
  const inlineChanges = new Map();
  function stripInline() {
    for (const [element, saved] of inlineChanges) {
      for (const [name, original] of saved) {
        if (CFG[INLINE[name]]) continue;
        if (element[name] == null && (!element.getAttribute || element.getAttribute(name) == null)) {
          if (original.attribute != null) element.setAttribute(name, original.attribute);
          else element[name] = original.handler;
        }
        saved.delete(name);
      }
      if (!saved.size || (element.nodeType === 1 && !element.isConnected)) inlineChanges.delete(element);
    }
    for (const [name, feature] of Object.entries(INLINE)) {
      if (!CFG[feature]) continue;
      const elements = new Set([...document.querySelectorAll('[' + name + ']'), document, document.documentElement, document.body, window]);
      for (const element of elements) {
        if (!element || (feature === 'clipboard' && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)))) continue;
        try {
          const attribute = element.getAttribute ? element.getAttribute(name) : null;
          const handler = element[name];
          if (attribute == null && handler == null) continue;
          if (!inlineChanges.has(element)) inlineChanges.set(element, new Map());
          const saved = inlineChanges.get(element);
          if (!saved.has(name)) saved.set(name, { attribute, handler });
          element[name] = null;
          if (element.removeAttribute) element.removeAttribute(name);
        } catch (e) {}
      }
    }
  }

  const seenSrc = new Set();
  function fixViewerArgs() {
    if (!CFG.viewerArgs) return;
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
      const v = el.src || el.data || '';
      if (!v || seenSrc.has(v) || !/(pdf|viewer|reader|stream)/i.test(v)) return;
      seenSrc.add(v);
      try {
        const url = new URL(v, document.baseURI), params = new URLSearchParams(url.hash.slice(1));
        let changed = false;
        for (const key of ['toolbar', 'navpanes', 'scrollbar', 'statusbar', 'messages']) {
          if (/^(0|no|false)$/i.test(params.get(key) || '')) { params.delete(key); changed = true; }
        }
        if (changed) {
          url.hash = params.toString();
          seenSrc.add(url.href);
          if ('src' in el) el.src = url.href; else el.data = url.href;
        }
      } catch (e) {}
    });
  }

  function tagWatermarks(on) {
    if (!on) { document.querySelectorAll('.ao-wm').forEach((el) => el.classList.remove('ao-wm')); return; }
    document.querySelectorAll('body *').forEach((el) => {
      if (el.classList.contains('ao-wm')) return;
      let cs; try { cs = getComputedStyle(el); } catch (e) { return; }
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
      if (cs.pointerEvents !== 'none' || parseFloat(cs.opacity || '1') > 0.92) return;
      const t = (el.textContent || '').trim();
      if (t && t.length <= 120 && /allen|overseas|www\.|@|digital/i.test(t)) el.classList.add('ao-wm');
    });
  }

  const scrollChanges = new Map(), blurChanges = new Map();
  function overrideStyle(changes, element, property, value) {
    let saved = changes.get(element);
    if (!saved) { saved = new Map(); changes.set(element, saved); }
    const previous = saved.get(property);
    if (!previous || element.style.getPropertyValue(property) !== previous.applied) {
      saved.set(property, { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property), applied: value });
    } else previous.applied = value;
    if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== 'important') {
      element.style.setProperty(property, value, 'important');
    }
  }
  function restoreStyles(changes) {
    for (const [element, saved] of changes) for (const [property, original] of saved) {
      if (element.style.getPropertyValue(property) === original.applied && element.style.getPropertyPriority(property) === 'important') {
        if (original.value) element.style.setProperty(property, original.value, original.priority);
        else element.style.removeProperty(property);
      }
    }
    changes.clear();
  }
  function unlockScroll() {
    if (!CFG.scrollLock) { restoreStyles(scrollChanges); return; }
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (/^(hidden|clip)$/.test(cs.overflowY)) overrideStyle(scrollChanges, el, 'overflow-y', 'auto');
    }
  }
  function removeBlur() {
    if (!CFG.unblur) { restoreStyles(blurChanges); return; }
    for (const element of document.querySelectorAll('body *')) {
      const computed = getComputedStyle(element);
      for (const property of ['filter', 'backdrop-filter']) {
        const value = computed.getPropertyValue(property);
        if (/blur\(/i.test(value)) overrideStyle(blurChanges, element, property, value.replace(/blur\([^)]*\)/gi, '').trim() || 'none');
      }
    }
    for (const element of blurChanges.keys()) if (!element.isConnected) blurChanges.delete(element);
  }

  const viewportMetaChanges = new Map();
  function fixViewportMeta() {
    if (!CFG.zoom) {
      for (const [meta, saved] of viewportMetaChanges) if (meta.content === saved.applied) meta.content = saved.original;
      viewportMetaChanges.clear(); return;
    }
    const m = document.querySelector('meta[name="viewport"]');
    if (m && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(m.content)) {
      const original = m.content;
      const applied = original.replace(/user-scalable\s*=\s*(no|0)/gi, 'user-scalable=yes')
        .replace(/maximum-scale\s*=\s*[\d.]+/gi, 'maximum-scale=5');
      if (!viewportMetaChanges.has(m) || m.content !== viewportMetaChanges.get(m).applied) viewportMetaChanges.set(m, { original, applied });
      m.content = applied;
    }
  }

  let busy = false;
  function enforce() {
    if (busy) return;
    busy = true;
    try {
      stripInline(); fixViewerArgs(); unlockScroll(); removeBlur();
      tagWatermarks(CFG.watermark); fixViewportMeta(); runRemovers();
    } catch (e) {}
    busy = false;
  }

  /* ------------------------------------------------------------------ *
   * 4. Devtools sniffing neutralisers
   * ------------------------------------------------------------------ */
  try {
    const oc = console.clear;
    console.clear = function () { if (!CFG.consoleClear) return oc.apply(console, arguments); };
  } catch (e) {}

  const viewportChanges = new Map();
  function syncWindowSize() {
    for (const [property, inner, delta] of [['outerWidth', 'innerWidth', 76], ['outerHeight', 'innerHeight', 92]]) {
      try {
        if (CFG.viewport && !viewportChanges.has(property)) {
          viewportChanges.set(property, Object.getOwnPropertyDescriptor(window, property));
          Object.defineProperty(window, property, { configurable: true, get: () => window[inner] + delta });
        } else if (!CFG.viewport && viewportChanges.has(property)) {
          const descriptor = viewportChanges.get(property);
          if (descriptor) Object.defineProperty(window, property, descriptor); else delete window[property];
          viewportChanges.delete(property);
        }
      } catch (e) {}
    }
  }

  try {
    const oA = window.alert, oC = window.confirm;
    window.alert = function () { if (CFG.alerts) return; return oA.apply(window, arguments); };
    window.confirm = function () { if (CFG.alerts) return false; return oC.apply(window, arguments); };
  } catch (e) {}

  /* ------------------------------------------------------------------ *
   * 5. Capture hooks (documents + media)
   *    Report viewer links before the response; keep only complete PDF copies.
   * ------------------------------------------------------------------ */
  const abs = (u) => { try { return new URL(u, document.baseURI || location.href).href; } catch (e) { return ''; } };
  const isStream = (u) => {
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) && /\/stream\/?$/i.test(x.pathname) &&
      [...x.searchParams.keys()].some((k) => k.toLowerCase() === 'token'); } catch (e) { return false; }
  };
  const isPdfUrl = (u) => isStream(u) || /\.pdf(\?|#|$)/i.test(u);
  const MEDIA_CT = /mpegurl|dash\+xml|^video\/(?!mp2t)|^audio\//i;
  const routeHref = (href) => {
    try {
      const u = new URL(href), hash = u.hash.slice(1), fields = [...new URLSearchParams(hash)];
      if (!hash || (fields.length && fields.every(([k, v]) =>
        /^(page|zoom|search|phrase|nameddest|pagemode|view|viewrect|highlight|toolbar|navpanes|scrollbar|statusbar|messages)$/i.test(k) &&
        (k.toLowerCase() !== 'page' || /^[1-9]\d*$/.test(v))))) u.hash = '';
      return u.href;
    } catch (e) { return href; }
  };
  const pageId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  let routeNumber = 0, captureNumber = 0;
  let route = { pageId, routeId: pageId + ':0', pageHref: routeHref(location.href), routeAt: Date.now() };
  const captureContext = () => ({ ...route, captureId: pageId + ':c' + (++captureNumber), captureOrder: captureNumber, capturedAt: Date.now() });
  const currentCapture = (ctx) => ctx.routeId === route.routeId && ctx.pageHref === routeHref(location.href);
  const requestHeaders = (headers) => {
    const out = {};
    try { new Headers(headers).forEach((v, k) => { if (/^(authorization|accept|accept-language)$|^x-/i.test(k)) out[k.toLowerCase()] = v; }); } catch (e) {}
    return out;
  };
  function offerUrl(url, ctx, headers, via) {
    if (CFG.pdfDetect && isPdfUrl(url) && currentCapture(ctx)) {
      post({ kind: 'pdf-url', url, stream: isStream(url), headers, via, ...ctx });
    }
  }
  function fullResponse(meta, size) {
    if (meta.status < 200 || meta.status >= 300) return false;
    if (meta.status === 206 || meta.range) {
      const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec((meta.range || '').trim());
      if (!m || +m[1] !== 0 || +m[2] + 1 !== +m[3] || +m[3] <= 0 || (size != null && size !== +m[3])) return false;
    }
    if (size != null && (!meta.encoding || /^identity$/i.test(meta.encoding)) && /^\d+$/.test(meta.length || '') && size !== +meta.length) return false;
    return true;
  }
  async function offerPdf(url, blob, cd, ctx, meta) {
    try {
      if (!CFG.pdfDetect || !currentCapture(ctx) || !fullResponse(meta, blob.size) || (await blob.slice(0, 5).text()) !== '%PDF-') return;
      const tail = await blob.slice(Math.max(0, blob.size - 65536)).text();
      const end = /startxref\s+(\d+)\s+%%EOF[\s\x00]*$/.exec(tail);
      if (!end || +end[1] >= blob.size || !currentCapture(ctx)) return;
      post({ kind: 'pdf', url, blob, cd: cd || '', complete: true, response: meta, ...ctx });
    } catch (e) {}
  }

  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      const p = nativeFetch.apply(this, arguments);
      try {
        const raw = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
        const url = abs(raw);
        const ctx = captureContext();
        const wantPdf = CFG.pdfDetect && isPdfUrl(url);
        const headers = requestHeaders(init && init.headers != null ? init.headers : input && input.headers);
        offerUrl(url, ctx, headers, 'fetch');
        if (CFG.pdfDetect || CFG.mediaDetect) {
          p.then((r) => {
            if (!r || !r.ok || !currentCapture(ctx)) return;
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            if (CFG.mediaDetect && !isPdfUrl(url) && MEDIA_CT.test(ct)) post({ kind: 'media-ct', url, ct, ...ctx });
            if (CFG.pdfDetect && (wantPdf || /application\/pdf/.test(ct))) {
              const meta = { status: r.status, range: r.headers.get('content-range') || '', length: r.headers.get('content-length') || '', encoding: r.headers.get('content-encoding') || '' };
              post({ kind: 'pdf-url', url, ct, stream: isStream(url), headers, via: 'headers', ...ctx });
              if (!fullResponse(meta)) return;
              const cd = r.headers.get('content-disposition') || '';
              r.clone().blob().then((b) => offerPdf(url, b, cd, ctx, meta)).catch(() => {});
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrRequests = new WeakMap();
  XMLHttpRequest.prototype.open = function (m, u) {
    const result = nativeOpen.apply(this, arguments);
    try {
      const url = abs(typeof u === 'string' ? u : String(u || ''));
      if (!xhrRequests.has(this)) {
        this.addEventListener('readystatechange', () => {
          try {
            const req = xhrRequests.get(this);
            if (this.readyState !== 2 || !req || !currentCapture(req.ctx)) return;
            const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
            if (CFG.mediaDetect && !isPdfUrl(req.url) && MEDIA_CT.test(ct)) post({ kind: 'media-ct', url: req.url, ct, ...req.ctx });
            if (CFG.pdfDetect && /application\/pdf/.test(ct)) {
              post({ kind: 'pdf-url', url: req.url, ct, stream: isStream(req.url), headers: req.headers, via: 'headers', ...req.ctx });
            }
          } catch (e) {}
        });
        this.addEventListener('load', () => {
          try {
            const req = xhrRequests.get(this);
            if (!req || !currentCapture(req.ctx)) return;
            const ct = this.getResponseHeader('content-type') || '';
            if (!CFG.pdfDetect || !(isPdfUrl(req.url) || /application\/pdf/i.test(ct))) return;
            const r = this.response;
            const b = r instanceof Blob ? r : r instanceof ArrayBuffer ? new Blob([r]) : null;
            const meta = { status: this.status, range: this.getResponseHeader('content-range') || '', length: this.getResponseHeader('content-length') || '', encoding: this.getResponseHeader('content-encoding') || '' };
            if (b) offerPdf(req.url, b, this.getResponseHeader('content-disposition') || '', req.ctx, meta);
          } catch (e) {}
        });
      }
      const req = { url, ctx: captureContext(), headers: {} };
      xhrRequests.set(this, req);
      offerUrl(url, req.ctx, req.headers, 'xhr');
    } catch (e) {}
    return result;
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const result = nativeSetHeader.apply(this, arguments);
    try {
      const req = xhrRequests.get(this), key = String(name).toLowerCase();
      if (req && /^(authorization|accept|accept-language)$|^x-/.test(key)) req.headers[key] = req.headers[key] ? req.headers[key] + ', ' + value : String(value);
    } catch (e) {}
    return result;
  };
  XMLHttpRequest.prototype.send = function () {
    const result = nativeSend.apply(this, arguments);
    try { const req = xhrRequests.get(this); if (req) offerUrl(req.url, req.ctx, { ...req.headers }, 'xhr'); } catch (e) {}
    return result;
  };

  function changeRoute(reset = false) {
    const pageHref = routeHref(location.href);
    if (!reset && route.pageHref === pageHref) return;
    route = { pageId, routeId: pageId + ':' + (++routeNumber), pageHref, routeAt: Date.now() };
    post({ kind: 'route', reset, ...route });
  }
  const wrapHistory = (fn) => function () {
    const result = fn.apply(this, arguments);
    try { changeRoute(); } catch (e) {}
    return result;
  };
  try {
    history.pushState = wrapHistory(history.pushState);
    history.replaceState = wrapHistory(history.replaceState);
  } catch (e) {}
  window.addEventListener('popstate', () => changeRoute());
  window.addEventListener('hashchange', () => changeRoute());
  document.addEventListener('ao:capture-reset', () => changeRoute(true));
  post({ kind: 'route', initial: true, ...route });

  /* ------------------------------------------------------------------ *
   * 6. Plugin API  (window.AOToolbox) — see plugins/_template.js
   * ------------------------------------------------------------------ */
  const hideSelectors = new Set();
  const removers = [];
  const cssBlocks = new Map();
  const cfgListeners = [];
  const readyFns = [];
  let isReady = document.readyState !== 'loading';

  function applyPluginCss() {
    const parent = document.head || document.documentElement;
    if (!parent) return;
    let st = document.getElementById('ao-plugin-style');
    if (!st) { st = document.createElement('style'); st.id = 'ao-plugin-style'; parent.appendChild(st); }
    st.textContent = [...cssBlocks.values()].join('\n') +
      (hideSelectors.size ? '\n' + [...hideSelectors].join(',\n') + ' { display: none !important; }' : '');
  }

  function runRemovers() {
    for (const r of removers) {
      try {
        document.querySelectorAll(r.selector).forEach((el) => { if (!r.test || r.test(el)) el.remove(); });
      } catch (e) {}
    }
  }

  const API = {
    version: 1,
    cfg: CFG,
    isTop: IS_TOP,
    /** Run fn once the DOM is ready (immediately if it already is). */
    onReady(fn) { if (isReady) { try { fn(); } catch (e) { console.error(e); } } else readyFns.push(fn); },
    /** Re-run fn whenever the toolbox settings change. */
    onConfig(fn) { cfgListeners.push(fn); },
    /** Make preventDefault() a no-op for these event types (undo a site's blocking). */
    allowEvents(types) { [].concat(types).forEach((t) => extraAllow.add(t)); },
    /** Stop the site's own listeners seeing these events (capture phase, before the page). */
    blockEvents(types, filter) {
      [].concat(types).forEach((t) => window.addEventListener(t, (e) => {
        if (!filter || filter(e)) e.stopImmediatePropagation();
      }, true));
    },
    /** Hide elements matching one selector or a list of selectors. */
    hide(selectors) { [].concat(selectors).forEach((s) => hideSelectors.add(s)); applyPluginCss(); },
    /** Delete elements matching selector now and whenever they reappear. test(el) can veto. */
    removeWhen(selector, test) { removers.push({ selector, test }); API.onReady(runRemovers); },
    /** Inject a named block of CSS (calling again with the same id replaces it). */
    addCss(id, css) { cssBlocks.set(id, css); applyPluginCss(); },
    /** Call fn on a debounced MutationObserver tick (useful for SPA content). */
    onMutation(fn) {
      let t = null;
      API.onReady(() => new MutationObserver(() => { clearTimeout(t); t = setTimeout(fn, 300); })
        .observe(document.documentElement, { childList: true, subtree: true }));
    },
    log: (...a) => console.log('%c[AO plugin]', 'color:#2f6df6', ...a),
  };
  Object.defineProperty(window, 'AOToolbox', { value: Object.freeze(API), configurable: false });

  /* ------------------------------------------------------------------ *
   * 7. Config channel + boot
   * ------------------------------------------------------------------ */
  document.addEventListener('ao:cfg', (e) => {
    try {
      Object.assign(CFG, JSON.parse(e.detail));
      buildCss(); enforce(); syncWindowSize();
      cfgListeners.forEach((fn) => { try { fn(CFG); } catch (err) {} });
    } catch (err) {}
  });
  document.dispatchEvent(new CustomEvent('ao:req'));

  buildCss();
  const boot = () => {
    isReady = true;
    readyFns.splice(0).forEach((fn) => { try { fn(); } catch (err) { console.error(err); } });
    buildCss(); enforce(); applyPluginCss();
    try {
      let t = null;
      new MutationObserver(() => { clearTimeout(t); t = setTimeout(enforce, 500); })
        .observe(document.documentElement, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ['src', 'data', 'style', 'class', ...Object.keys(INLINE)],
        });
    } catch (e) {}
    setInterval(enforce, 2500);   // safety net for state the observer cannot see
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
