(function (CHAN, INFO, GRANTS, VALUES, RES, MODE) {
  'use strict';
  /*
   * ALLEN Toolbox — userscript runtime (Greasemonkey / Violentmonkey-compatible GM_* API + AO helpers).
   * This function's source is embedded into every installed script by the background worker, so it
   * never leaks a global. It talks to the extension through:
   *   MODE 'page'    – secret-named DOM events handled by a relay running in the extension's own world
   *   MODE 'content' – a direct chrome.runtime port (script runs in the extension's sandbox world)
   */
  const G = new Set(GRANTS);
  const doc = document, win = window;
  const nAdd = EventTarget.prototype.addEventListener;
  const nDispatch = EventTarget.prototype.dispatchEvent;
  const CE = CustomEvent, J = JSON;
  const isTop = win.top === win;
  const clone = (v) => (v && typeof v === 'object' ? J.parse(J.stringify(v)) : v);
  const warn = (...a) => console.warn('[' + INFO.script.name + ']', ...a);

  /* ===================================================================== transport */
  let seq = 0, port = null, menuSeq = 0, listenSeq = 0, connected = false, connectedOnce = false;
  let connectionPromise = null, resolveConnection, rejectConnection, connectionTimer;
  const queued = [], changedValues = new Set();
  const pending = new Map(), streams = new Map(), cmds = new Map(), changeL = new Map();

  const send = (m) => {
    if (MODE === 'page') nDispatch.call(doc, new CE(CHAN + ':req', { detail: J.stringify(m) }));
    else port.postMessage(m);
  };

  function connection() {
    if (!connectionPromise) {
      connectionPromise = new Promise((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
      connectionPromise.catch(() => {}); // Legacy, synchronous GM APIs need not await the connection.
      connectionTimer = setTimeout(() => incoming({ ev: 'disconnected', error: 'Userscript connection timed out. Reload the website.' }), 15000);
    }
    const waiting = connectionPromise;
    if (!connected) {
      if (MODE === 'page') send({ op: 'connect' });
      else if (!port) {
        const current = chrome.runtime.connect({ name: 'gm:' + INFO.script.id + ':' + CHAN });
        port = current;
        current.onMessage.addListener(incoming);
        current.onDisconnect.addListener(() => { if (port === current) { port = null; incoming({ ev: 'disconnected' }); } });
      }
    }
    return waiting;
  }

  function toBg(m) {
    if (connected) { send(m); return; }
    if (queued.length >= 100) throw new Error('Too many userscript requests before connection. Reload the website.');
    queued.push(m);
    try { connection(); } catch (error) { queued.pop(); throw error; }
  }

  const call = (op, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try { toBg({ id, op, args }); } catch (e) { pending.delete(id); reject(e); }
  });
  function stream(op, args, onEv) {
    const id = ++seq; streams.set(id, onEv);
    try { toBg({ id, op, args }); } catch (error) { streams.delete(id); throw error; }
    return id;
  }

  function incoming(m) {
    if (!m) return;
    if (m.ev === 'ready') { if (!connected) connection(); return; }
    if (m.ev === 'hello') {
      // The backend supplies current values; retain writes made locally before its handshake.
      for (const key of Object.keys(vals)) if (!changedValues.has(key)) delete vals[key];
      for (const [key, value] of Object.entries(m.values || {})) if (!changedValues.has(key)) vals[key] = value;
      connected = true; connection(); clearTimeout(connectionTimer); resolveConnection();
      for (const message of queued.splice(0)) send(message);
      changedValues.clear();
      if (connectedOnce) for (const [cmdId, c] of cmds) toBg({ op: 'menu.reg', args: { cmdId, name: c.name } });
      connectedOnce = true;
      return;
    }
    if (m.ev === 'disconnected') {
      const error = new Error(m.error || 'Connection to the extension was lost. Reload the website.');
      connected = false; clearTimeout(connectionTimer); rejectConnection?.(error); connectionPromise = null; queued.length = 0; changedValues.clear();
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      for (const f of streams.values()) f({ type: 'error', data: { error: 'Connection to the extension was lost' } });
      streams.clear();
      return;
    }
    if (m.ev === 'menu') { const c = cmds.get(m.cmdId); if (c) { try { c.fn(); } catch (e) { console.error(e); } } return; }
    if (m.ev === 'val') {
      const old = vals[m.key];
      if (m.deleted) delete vals[m.key]; else vals[m.key] = J.parse(m.value);
      fireChange(m.key, old, m.deleted ? undefined : vals[m.key], true);
      return;
    }
    if (m.id && m.ok === false && streams.has(m.id)) {
      const callback = streams.get(m.id); streams.delete(m.id);
      callback({ type: 'error', data: { error: m.error || 'The extension refused the request' } });
      return;
    }
    if (m.id && m.ev) { const f = streams.get(m.id); if (f) f(m); return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'The extension refused the request'));
    }
  }
  if (MODE === 'page') nAdd.call(doc, CHAN + ':res', (e) => { try { incoming(J.parse(e.detail)); } catch (err) { /* ignore */ } }, true);

  /* ===================================================================== values (synchronous, like the real thing) */
  const vals = Object.assign(Object.create(null), VALUES);
  function fireChange(key, oldV, newV, remote) {
    for (const l of changeL.values()) if (l.key === key) { try { l.cb.call(win, key, oldV, newV, remote); } catch (e) { console.error(e); } }
  }
  function GM_getValue(key, def) { return key in vals ? clone(vals[key]) : def; }
  function GM_setValue(key, value, confirm = false) {
    if (value === undefined) return GM_deleteValue(key, confirm);
    const old = vals[key];
    vals[key] = clone(value);
    changedValues.add(key);
    const args = { key, value: J.stringify(value) };
    const result = confirm ? call('val.set', args) : toBg({ op: 'val.set', args });
    fireChange(key, old, vals[key], false);
    return result;
  }
  function GM_deleteValue(key, confirm = false) {
    const old = vals[key];
    delete vals[key];
    changedValues.add(key);
    const result = confirm ? call('val.delete', { key }) : toBg({ op: 'val.delete', args: { key } });
    fireChange(key, old, undefined, false);
    return result;
  }
  const GM_listValues = () => Object.keys(vals);
  function GM_addValueChangeListener(key, cb) { const id = ++listenSeq; changeL.set(id, { key, cb }); return id; }
  const GM_removeValueChangeListener = (id) => { changeL.delete(id); };

  /* ===================================================================== DOM helpers */
  function whenHead(fn) {
    if (doc.head || doc.documentElement) fn(doc.head || doc.documentElement);
    else nAdd.call(doc, 'DOMContentLoaded', () => fn(doc.head || doc.documentElement), { once: true });
  }
  function GM_addStyle(css) {
    const s = doc.createElement('style');
    s.textContent = css;
    whenHead((p) => p.appendChild(s));
    return s;
  }
  function GM_addElement(a, b, c) {
    const parent = typeof a === 'string' ? (doc.head || doc.documentElement) : a;
    const tag = typeof a === 'string' ? a : b, attrs = (typeof a === 'string' ? b : c) || {};
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'textContent') el.textContent = v; else el.setAttribute(k, v); }
    (parent || doc.documentElement).appendChild(el);
    return el;
  }
  function GM_setClipboard(data, info) {
    const text = typeof data === 'string' ? data : String(data);
    const legacy = () => {
      const ta = doc.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      (doc.body || doc.documentElement).appendChild(ta); ta.select();
      try { doc.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove();
    };
    try { navigator.clipboard.writeText(text).catch(legacy); } catch (e) { legacy(); }
  }
  const GM_log = (...a) => console.log(...a);
  function GM_getResourceText(name) { const r = RES[name]; return r ? r.text : null; }
  function GM_getResourceURL(name) { const r = RES[name]; return r ? r.dataUrl || r.url : null; }

  /* ===================================================================== extension-backed APIs */
  function GM_registerMenuCommand(name, fn, opts) {
    const id = ++menuSeq;
    cmds.set(id, { name, fn });
    toBg({ op: 'menu.reg', args: { cmdId: id, name: String(name) } });
    return id;
  }
  function GM_unregisterMenuCommand(id) { cmds.delete(id); toBg({ op: 'menu.unreg', args: { cmdId: id } }); }

  function GM_openInTab(url, opts) {
    const o = typeof opts === 'boolean' ? { active: !opts } : opts || {};
    const handle = { closed: false, onclose: null, close() { call('tab.close', { id: handle.__id }).catch(() => {}); } };
    call('tab.open', { url: String(new URL(url, location.href)), active: o.active !== false }).then((r) => { handle.__id = r.id; }).catch((e) => warn('GM_openInTab failed:', e.message));
    return handle;
  }

  function GM_notification(a, b, c, d) {
    const o = typeof a === 'object' && a ? Object.assign({}, a) : { text: a, title: b, image: c, onclick: d };
    stream('notify', { title: o.title || INFO.script.name, text: String(o.text || ''), image: o.image || '', silent: !!o.silent, timeout: o.timeout || 0 }, (m) => {
      if (m.type === 'click' && o.onclick) o.onclick.call(win);
      if (m.type === 'done' && o.ondone) o.ondone.call(win, !!m.byUser);
    });
  }

  async function encodeBody(data) {
    if (data == null) return null;
    if (typeof data === 'string') return { t: 's', v: data };
    const r = new Response(data);                       // lets the browser serialise FormData / Blob / buffers / URLSearchParams
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { t: 'b', v: btoa(bin), ct: r.headers.get('content-type') || '' };
  }
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

  function GM_xmlhttpRequest(d) {
    d = d || {};
    const rtype = d.responseType || '';
    let rid = 0, aborted = false;
    const ctl = { abort() { aborted = true; if (rid) toBg({ op: 'xhr.abort', args: { id: rid } }); } };
    const respond = (data) => {
      const r = {
        readyState: data.readyState == null ? 4 : data.readyState, status: data.status, statusText: data.statusText,
        responseHeaders: data.responseHeaders || '', finalUrl: data.finalUrl || d.url, context: d.context,
        lengthComputable: !!data.lengthComputable, loaded: data.loaded, total: data.total,
      };
      if (data.b64 !== undefined) {
        const bytes = b64ToBytes(data.b64);
        r.response = rtype === 'blob' ? new Blob([bytes], { type: data.ct || '' }) : bytes.buffer;
      } else if (data.text !== undefined) {
        r.responseText = data.text;
        if (rtype === 'json') { try { r.response = J.parse(data.text); } catch (e) { r.response = null; } }
        else if (rtype === 'document') { r.response = r.responseXML = new DOMParser().parseFromString(data.text, 'text/html'); }
        else r.response = data.text;
      }
      return r;
    };
    (async () => {
      let body = null;
      try { body = await encodeBody(d.data); } catch (e) { if (d.onerror) d.onerror({ error: 'Could not encode the request body: ' + e.message }); return; }
      if (aborted) return;
      const headers = Object.assign({}, d.headers || {});
      if (body && body.ct && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type') && body.ct) headers['Content-Type'] = body.ct;
      rid = stream('xhr', {
        method: d.method || 'GET', url: String(new URL(d.url, location.href)), headers, body, user: d.user, password: d.password,
        anonymous: !!d.anonymous, timeout: d.timeout || 0, responseType: rtype, redirect: d.redirect, binary: !!d.binary, page: location.href,
      }, (m) => {
        const data = m.data || {};
        const cb = d['on' + m.type];
        if (m.type === 'error' && cb) cb({ error: data.error || 'Network error', status: 0, readyState: 4, finalUrl: d.url, context: d.context, responseHeaders: '' });
        else if (cb) cb.call(d, respond(data));
        if (['load', 'error', 'timeout', 'abort'].includes(m.type)) { if (d.onloadend) d.onloadend(respond(data)); streams.delete(m.id); }
      });
      if (d.onloadstart) d.onloadstart({ readyState: 0, status: 0 });
    })();
    return ctl;
  }
  function xmlHttpRequestAsync(d) {
    let ctl;
    const p = new Promise((resolve, reject) => {
      const o = Object.assign({}, d);
      const prevLoad = o.onload, prevErr = o.onerror, prevTo = o.ontimeout, prevAb = o.onabort;
      o.onload = (r) => { if (prevLoad) prevLoad(r); resolve(r); };
      o.onerror = (r) => { if (prevErr) prevErr(r); reject(r); };
      o.ontimeout = (r) => { if (prevTo) prevTo(r); reject(r); };
      o.onabort = (r) => { if (prevAb) prevAb(r); reject(r); };
      ctl = GM_xmlhttpRequest(o);
    });
    p.abort = () => ctl && ctl.abort();
    return p;
  }

  function GM_download(a, b) {
    const d = typeof a === 'string' ? { url: a, name: b } : Object.assign({}, a || {});
    let rid = 0;
    rid = stream('download', { url: String(new URL(d.url, location.href)), name: d.name || '', headers: d.headers || {}, page: location.href }, (m) => {
      const cb = d['on' + m.type];
      if (cb) cb.call(d, m.data || {});
      if (['load', 'error', 'timeout'].includes(m.type)) streams.delete(m.id);
    });
    return { abort() { toBg({ op: 'download.abort', args: { id: rid } }); } };
  }

  /* ===================================================================== AO helpers (always-on-top UI and friends) */
  const readyFns = [];
  let domReady = doc.readyState !== 'loading';
  if (!domReady) nAdd.call(doc, 'DOMContentLoaded', () => { domReady = true; readyFns.splice(0).forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }, { once: true });
  const onReady = (fn) => { if (domReady) { try { fn(); } catch (e) { console.error(e); } } else readyFns.push(fn); };

  const UI = (() => {
    let host = null, root = null, toastBox = null, mo = null;
    const docks = {};
    const css = `
      *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      .dock{position:fixed;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-height:100vh}
      .dock>*{pointer-events:auto}
      .bottom-right{right:16px;bottom:16px;align-items:flex-end}.bottom-left{left:16px;bottom:16px;align-items:flex-start}
      .top-right{right:16px;top:16px;align-items:flex-end}.top-left{left:16px;top:16px;align-items:flex-start}
      .btn{all:unset;pointer-events:auto;box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;cursor:pointer;background:#242a34;color:#edf0f5;
        border:1px solid #8594a8;border-radius:4px;padding:9px 14px;font:500 13px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.18);user-select:none;transition:background-color 120ms,border-color 120ms}
      .btn:hover{background:#2c3440}.btn:active{background:#303b48}.btn[disabled]{opacity:.5;cursor:not-allowed}
      .btn:focus-visible,.ph button:focus-visible{outline:2px solid #90b3e8;outline-offset:3px}
      .btn.primary{background:#2d66b4;color:#fff}.btn.primary:hover{background:#346fc0}.btn.primary:active{background:#24538f}
      .panel{width:min(340px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;background:#191d24;color:#edf0f5;border:1px solid #8594a8;
        border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.25);overflow:hidden;font:13px/1.5 system-ui,sans-serif}
      .panel[hidden]{display:none}
      .panel:not([hidden]){animation:ao-panel-enter 180ms cubic-bezier(.2,.8,.2,1)}
      .ph{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#191d24;border-bottom:1px solid #363d49;font-weight:600}
      .ph span{flex:1}.ph button{all:unset;cursor:pointer;color:#abb5c4;padding:2px 7px;border-radius:4px;min-width:24px;min-height:24px;text-align:center}.ph button:hover{background:#2c3440;color:#edf0f5}
      .pb{padding:12px;overflow:auto}
      .toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#191d24;color:#edf0f5;border:1px solid #8594a8;border-radius:4px;
        padding:9px 15px;font:500 13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;max-width:90vw;animation:ao-toast-enter 180ms ease-out}
      @keyframes ao-panel-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
      @keyframes ao-toast-enter{from{opacity:0;transform:translate(-50%,-4px)}to{opacity:1;transform:translate(-50%,0)}}
      @media(pointer:coarse){.btn,.ph button{min-height:44px;min-width:44px}}
      @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`;

    function ensure() {
      if (!isTop) return false;
      const parent = doc.body || doc.documentElement;
      if (!parent) return false;
      if (!host) {
        host = doc.createElement('div');
        host.setAttribute('data-ao-ui', INFO.script.id);
        host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0';
        root = host.attachShadow({ mode: 'closed' });
        try { const sh = new CSSStyleSheet(); sh.replaceSync(css); root.adoptedStyleSheets = [sh]; }
        catch (e) { const st = doc.createElement('style'); st.textContent = css; root.appendChild(st); }
        for (const pos of ['bottom-right', 'bottom-left', 'top-right', 'top-left']) { const d = doc.createElement('div'); d.className = 'dock ' + pos; root.appendChild(d); docks[pos] = d; }
        toastBox = doc.createElement('div'); root.appendChild(toastBox);
      }
      if (host.parentNode !== parent) parent.appendChild(host);
      if (!mo) {                                              // the page may wipe the DOM: put the host back
        mo = new MutationObserver(() => { const p = doc.body || doc.documentElement; if (host && p && host.parentNode !== p) p.appendChild(host); });
        mo.observe(doc.documentElement, { childList: true });
        if (doc.body) mo.observe(doc.body, { childList: true });
      }
      return true;
    }

    const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const whenUi = (fn) => onReady(() => { if (!ensure()) warn('AO.ui is only available in the top window'); else fn(); });

    function button(o) {
      o = o || {};
      const b = mk('button', 'btn' + (o.primary ? ' primary' : ''));
      const label = mk('span', '', o.label || 'Button');
      if (o.icon) b.append(mk('span', '', o.icon));
      b.append(label);
      if (o.title) b.title = o.title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!o.onClick || b.disabled) return;
        try { const r = o.onClick(e, handle); if (r && r.catch) r.catch((err) => { console.error(err); toast('Error: ' + (err && err.message || err)); }); } catch (err) { console.error(err); toast('Error: ' + err.message); }
      });
      const handle = {
        element: b,
        setLabel(t) { label.textContent = t; },
        setDisabled(v) { b.disabled = !!v; },
        show() { b.hidden = false; }, hide() { b.hidden = true; },
        remove() { b.remove(); },
      };
      whenUi(() => docks[o.position || 'bottom-right'].appendChild(b));
      return handle;
    }

    function panel(o) {
      o = o || {};
      const p = mk('div', 'panel'); p.hidden = !o.open;
      const head = mk('div', 'ph'); const title = mk('span', '', o.title || 'Panel'); const x = mk('button', '', '✕'); x.title = 'Close';
      head.append(title, x);
      const body = mk('div', 'pb');
      p.append(head, body);
      const setContent = (c) => { body.replaceChildren(); if (typeof c === 'string') body.textContent = c; else if (c) body.append(c); };
      setContent(o.content);
      const handle = {
        element: p, body,
        open() { p.hidden = false; }, close() { p.hidden = true; }, toggle() { p.hidden = !p.hidden; },
        setContent, setTitle(t) { title.textContent = t; }, remove() { p.remove(); },
      };
      x.addEventListener('click', () => handle.close());
      whenUi(() => docks[o.position || 'bottom-right'].prepend(p));
      return handle;
    }

    function toast(text, ms) {
      whenUi(() => {
        const t = mk('div', 'toast', String(text));
        toastBox.appendChild(t);
        setTimeout(() => t.remove(), ms || 2600);
      });
    }
    return { button, panel, toast };
  })();

  const allowSet = (() => {
    const KEY = Symbol.for('allen-toolbox.allow');
    if (!Event.prototype[KEY]) {
      const set = new Set();
      Object.defineProperty(Event.prototype, KEY, { value: set, enumerable: false });
      const orig = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function () { if (set.has(this.type)) return; return orig.call(this); };
    }
    return Event.prototype[KEY];
  })();

  const AO = {
    version: 2, world: MODE === 'page' ? 'page' : 'sandbox', isTop, scriptId: INFO.script.id,
    log: (...a) => console.log('%c[AO ' + INFO.script.name + ']', 'color:#2f6df6', ...a),
    onReady,
    onMutation(fn) {
      let t = null;
      onReady(() => new MutationObserver(() => { clearTimeout(t); t = setTimeout(fn, 300); }).observe(doc.documentElement, { childList: true, subtree: true }));
    },
    addCss(id, css) {
      onReady(() => {
        let s = doc.querySelector('style[data-ao-css="' + id + '"]');
        if (!s) { s = doc.createElement('style'); s.setAttribute('data-ao-css', id); (doc.head || doc.documentElement).appendChild(s); }
        s.textContent = css;
      });
    },
    hide(sel) { AO.addCss('hide-' + INFO.script.id, [].concat(sel).join(',\n') + '{display:none!important}'); },
    removeWhen(selector, test) {
      const run = () => doc.querySelectorAll(selector).forEach((el) => { if (!test || test(el)) el.remove(); });
      run(); AO.onMutation(run); onReady(run);
    },
    allowEvents(types) { [].concat(types).forEach((t) => allowSet.add(t)); },
    blockEvents(types, filter) {
      [].concat(types).forEach((t) => win.addEventListener(t, (e) => { if (!filter || filter(e)) e.stopImmediatePropagation(); }, true));
    },
    ui: UI,
    items: () => call('ao.items', {}),
    saveItem: (id, opts) => call('ao.save', { id, opts: opts || {} }),
  };

  /* ===================================================================== what the script receives */
  const GM = {
    info: INFO,
    getValue: async (k, d) => { await connection(); return GM_getValue(k, d); },
    setValue: async (k, v) => { await GM_setValue(k, v, true); },
    deleteValue: async (k) => { await GM_deleteValue(k, true); },
    listValues: async () => { await connection(); return GM_listValues(); },
    xmlHttpRequest: xmlHttpRequestAsync, xmlhttpRequest: xmlHttpRequestAsync,
    openInTab: GM_openInTab, notification: GM_notification, setClipboard: GM_setClipboard,
    registerMenuCommand: GM_registerMenuCommand, unregisterMenuCommand: GM_unregisterMenuCommand,
    addStyle: async (c) => GM_addStyle(c), addElement: async (...a) => GM_addElement(...a),
    download: GM_download, log: GM_log,
    getResourceText: async (n) => GM_getResourceText(n), getResourceUrl: async (n) => GM_getResourceURL(n),
  };
  const offer = (name, impl) => (G.has(name) ? impl : undefined);
  const api = {
    unsafeWindow: win,
    GM_info: INFO,
    GM,
    GM_getValue: offer('GM_getValue', GM_getValue), GM_setValue: offer('GM_setValue', GM_setValue),
    GM_deleteValue: offer('GM_deleteValue', GM_deleteValue), GM_listValues: offer('GM_listValues', GM_listValues),
    GM_addValueChangeListener: offer('GM_addValueChangeListener', GM_addValueChangeListener),
    GM_removeValueChangeListener: offer('GM_addValueChangeListener', GM_removeValueChangeListener),
    GM_addStyle: offer('GM_addStyle', GM_addStyle), GM_addElement: offer('GM_addElement', GM_addElement),
    GM_setClipboard: offer('GM_setClipboard', GM_setClipboard), GM_log: offer('GM_log', GM_log),
    GM_getResourceText: offer('GM_getResourceText', GM_getResourceText), GM_getResourceURL: offer('GM_getResourceURL', GM_getResourceURL),
    GM_registerMenuCommand: offer('GM_registerMenuCommand', GM_registerMenuCommand),
    GM_unregisterMenuCommand: offer('GM_registerMenuCommand', GM_unregisterMenuCommand),
    GM_openInTab: offer('GM_openInTab', GM_openInTab), GM_notification: offer('GM_notification', GM_notification),
    GM_xmlhttpRequest: offer('GM_xmlhttpRequest', GM_xmlhttpRequest), GM_download: offer('GM_download', GM_download),
    AO: G.has('AO') ? AO : undefined,
  };
  // the page-world API object only offers what the script asked for (@grant), like the real managers
  for (const k of Object.keys(GM)) {
    const need = { getValue: 'GM_getValue', setValue: 'GM_setValue', deleteValue: 'GM_deleteValue', listValues: 'GM_listValues',
      xmlHttpRequest: 'GM_xmlhttpRequest', xmlhttpRequest: 'GM_xmlhttpRequest', openInTab: 'GM_openInTab', notification: 'GM_notification',
      setClipboard: 'GM_setClipboard', registerMenuCommand: 'GM_registerMenuCommand', unregisterMenuCommand: 'GM_registerMenuCommand',
      addStyle: 'GM_addStyle', addElement: 'GM_addElement', download: 'GM_download', log: 'GM_log',
      getResourceText: 'GM_getResourceText', getResourceUrl: 'GM_getResourceURL' }[k];
    if (need && !G.has(need)) delete GM[k];
  }
  try { connection(); } catch (error) { incoming({ ev: 'disconnected', error: error.message }); }
  return api;
})
