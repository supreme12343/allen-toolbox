// ==UserScript==
// @name         ALLEN Overseas — Blocker Bundle V6.1 (V6.0 full + startup fixes)
// @namespace    ghost.candidate
// @version      6.1
// @description  V6.0 full layer set, with startup-breaking hooks surgically repaired
// @match        https://digitalclass.allenoverseas.com/*
// @run-at       document-start
// @grant        none
// @all-frames   true
// ==/UserScript==

(function () {
  'use strict';
  if (window.__GC6) return;
  window.__GC6 = true;

  const CFG = {
    fullscreen:        true,
    visibility:        true,
    wireRewrite:       true,
    dropActivityPosts: false,
    mockCamera:        true,
    gateKiller:        true,
    keyboardUnlock:    true,
    devtoolsShields:   true,
    multiMonitorSpoof: true,
    deviceSpoof:       true,
    beforeUnloadUnlock:true,
    antiDebugStrip:    true,
    navTimingSpoof:    true,
    selectionUnlock:   true,
    debug:             false   // set true to see [GC] logs
  };
  const log = (...a) => { if (CFG.debug) console.log('%c[GC]', 'color:#0a0', ...a); };

  const errors = [];
  const ok = (label, fn) => { try { return fn(); } catch (e) { errors.push(label + ': ' + e.message); } };

  /* ===== NATIVE MASKING (unchanged) ===== */
  const nativeToString = Function.prototype.toString;
  const spoofed = new Map();
  const mask = (fn, label) => {
    spoofed.set(fn, label || `function ${fn.name || ''}() { [native code] }`);
    return fn;
  };
  ok('toString', () => {
    Function.prototype.toString = function () {
      return spoofed.has(this) ? spoofed.get(this) : nativeToString.call(this);
    };
    mask(Function.prototype.toString, 'function toString() { [native code] }');
  });
  const nativeAdd = EventTarget.prototype.addEventListener;

  const PATCHES = [];
  const spoofProp = (obj, prop, getter, label) => {
    ok(label || prop, () => {
      Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true });
      PATCHES.push({ obj, prop, getter });
    });
  };

  /* ===================== LAYER 1: FULLSCREEN (unchanged from your V6.0) ===================== */
  const REAL_W = (window.screen && screen.width) || 1920;
  const REAL_H = (window.screen && screen.height) || 1080;
  const fsTarget = () => document.documentElement || document.body;

  if (CFG.fullscreen) {
    spoofProp(window, 'innerWidth',  () => REAL_W);
    spoofProp(window, 'innerHeight', () => REAL_H);
    spoofProp(window, 'outerWidth',  () => REAL_W);
    spoofProp(window, 'outerHeight', () => REAL_H);
    if (window.screen) {
      spoofProp(screen, 'availWidth',  () => REAL_W);
      spoofProp(screen, 'availHeight', () => REAL_H);
      spoofProp(screen, 'availLeft',   () => 0);
      spoofProp(screen, 'availTop',    () => 0);
    }
    spoofProp(document, 'fullscreen',              () => true);
    spoofProp(document, 'mozFullScreen',           () => true);
    spoofProp(document, 'webkitFullscreen',        () => true);
    spoofProp(document, 'msFullscreen',            () => true);
    spoofProp(document, 'fullscreenElement',       fsTarget);
    spoofProp(document, 'webkitFullscreenElement', fsTarget);
    spoofProp(document, 'mozFullScreenElement',    fsTarget);
    spoofProp(document, 'msFullscreenElement',     fsTarget);
    spoofProp(document, 'fullscreenEnabled',       () => true);
    spoofProp(document, 'webkitFullscreenEnabled', () => true);

    let synth = false;
    const fireEntered = () => {
      synth = true;
      ok('synth-fsc', () => document.dispatchEvent(new Event('fullscreenchange', { bubbles: true })));
      setTimeout(() => { synth = false; }, 0);
    };
    const reqFs = mask(function () {
      setTimeout(fireEntered, 0);
      return Promise.resolve();
    }, 'function requestFullscreen() { [native code] }');
    ok('requestFullscreen', () => {
      Element.prototype.requestFullscreen = reqFs;
      Element.prototype.webkitRequestFullscreen = reqFs;
      Element.prototype.msRequestFullscreen = reqFs;
      document.documentElement.requestFullscreen = reqFs;
    });
    const exitFs = mask(function () { return Promise.resolve(); }, 'function exitFullscreen() { [native code] }');
    ok('exitFullscreen', () => {
      document.exitFullscreen = exitFs;
      document.webkitExitFullscreen = exitFs;
      document.mozCancelFullScreen = exitFs;
      document.msExitFullscreen = exitFs;
      window.exitFullscreen = exitFs;
    });
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
      .forEach((ev) => ok('fs-capture-' + ev, () => {
        nativeAdd.call(window, ev, (e) => { if (!synth) e.stopImmediatePropagation(); }, true);
      }));

    if (CFG.multiMonitorSpoof) {
      spoofProp(screen, 'isExtended', () => false, 'isExtended');
      ok('getScreenDetails', () => {
        const oneScreen = () => ({
          availLeft: 0, availTop: 0, availWidth: REAL_W, availHeight: REAL_H,
          width: REAL_W, height: REAL_H, left: 0, top: 0,
          colorDepth: 24, pixelDepth: 24, isInternal: true, isPrimary: true,
          label: 'Built-in Display', devicePixelRatio: window.devicePixelRatio || 1, onchange: null
        });
        const details = { screens: [oneScreen()], oncurrentscreenchange: null, onscreenschange: null };
        details.currentScreen = details.screens[0];
        window.getScreenDetails = mask(function () { return Promise.resolve(details); },
          'function getScreenDetails() { [native code] }');
      });
    }
  }

  /* ===================== LAYER 2: VISIBILITY / FOCUS (FIXED) ===================== */
  if (CFG.visibility) {
    spoofProp(document, 'visibilityState',       () => 'visible');
    spoofProp(document, 'webkitVisibilityState', () => 'visible');
    spoofProp(document, 'hidden',                () => false);
    spoofProp(document, 'webkitHidden',          () => false);
    spoofProp(window,   'documentHidden',        () => false);
    ok('hasFocus', () => {
      const hf = mask(function () { return true; }, 'function hasFocus() { [native code] }');
      Document.prototype.hasFocus = hf;
      document.hasFocus = hf;
    });

    // FIX 1: SWALLOW list no longer contains 'blur' as a blanket registration kill.
    // Input-element blur is legitimate page logic (answer validation, start button).
    // We only swallow visibility events at registration, and handle window-blur
    // via capture-phase filtering by target.
    const SWALLOW = new Set(['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange']);
    const isDocTarget = (t) => t === window || t === document || t === Document.prototype || t instanceof Document;
    ok('addEventListener', () => {
      EventTarget.prototype.addEventListener = mask(function (type, fn, opts) {
        try {
          if (isDocTarget(this) && SWALLOW.has(String(type).toLowerCase())) return; // blocked
        } catch (e) {}
        return nativeAdd.call(this, type, fn, opts);
      }, 'function addEventListener() { [native code] }');
    });

    // FIX 1b: window-blur swallow now checks target explicitly, so element blur
    // events (inputs, buttons) pass through untouched.
    ['blur', 'visibilitychange', 'webkitvisibilitychange'].forEach((ev) => ok('cap-' + ev, () => {
      nativeAdd.call(window, ev, (e) => {
        if (e.target === window || e.target === document) e.stopImmediatePropagation();
      }, true);
    }));

    // FIX 1c: onvisibilitychange trap stays; 'onblur' property trap REMOVED —
    // the page may legitimately assign window.onblur during init.
    [[document, 'onvisibilitychange'], [document, 'onwebkitvisibilitychange']]
      .forEach(([o, p]) => ok('prop-' + p, () => {
        Object.defineProperty(o, p, { set() {}, get() { return null; }, configurable: true });
      }));
  }

  /* ===================== LAYER 3: WIRE REWRITE (unchanged) ===================== */
  const FLAGS = new Set(['cheating', 'isCheating', 'focused', 'fullscreen', 'isFullscreen',
    'fullscreen_exit', 'tab_switched', 'tabSwitched', 'window_blurred', 'windowBlurred',
    'blur_count', 'visibility_lost', 'devtools_open']);
  const POS_TRUE = new Set(['focused', 'fullscreen', 'isFullscreen']);

  const walkJson = (o) => {
    let touched = false;
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      for (const k of Object.keys(n)) {
        if (FLAGS.has(k)) { n[k] = POS_TRUE.has(k); touched = true; }
        else visit(n[k]);
      }
    };
    visit(o);
    return touched;
  };

  const sanitize = (data) => {
    try {
      if (data == null) return data;
      if (typeof data === 'string') {
        const t = data.trim();
        if ((t[0] === '{' || t[0] === '[') && /cheating|fullscreen|focused|tab_|blur|visibility|devtools/i.test(t)) {
          const obj = JSON.parse(t);
          return walkJson(obj) ? JSON.stringify(obj) : data;
        }
        if (data.includes('=') && /cheating|fullscreen|focused/i.test(data)) {
          return data
            .replace(/(^|&)(cheating|isCheating|devtools_open|tab_switched|window_blurred|blur_count|visibility_lost|fullscreen_exit)=([^&]*)/g, (m, p, k) => p + k + '=false')
            .replace(/(^|&)(focused|fullscreen|isFullscreen)=([^&]*)/g, (m, p, k) => p + k + '=true');
        }
        return data;
      }
      if (typeof FormData !== 'undefined' && data instanceof FormData) {
        for (const k of Array.from(data.keys())) if (FLAGS.has(k)) data.set(k, String(POS_TRUE.has(k)));
        return data;
      }
      if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
        for (const k of Array.from(data.keys())) if (FLAGS.has(k)) data.set(k, String(POS_TRUE.has(k)));
        return data;
      }
      return data;
    } catch (e) { return data; }
  };

  const isActivityURL = (u) =>
    /saveStudentTestActivity|saveResumeExamData|activity|proctor|monitor|heartbeat|violation/i.test(String(u || ''));

  if (CFG.wireRewrite) {
    ok('xhr', () => {
      const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = mask(function (m, u) { this.__gcUrl = u; return oOpen.apply(this, arguments); }, 'function open() { [native code] }');
      XMLHttpRequest.prototype.send = mask(function (body) {
        try {
          if (this.__gcUrl && isActivityURL(this.__gcUrl)) {
            if (CFG.dropActivityPosts) {
              this.__gcDropped = true;
              ok('xhr-drop', () => {
                Object.defineProperty(this, 'readyState', { get: () => 4, configurable: true });
                Object.defineProperty(this, 'status', { get: () => 200, configurable: true });
                Object.defineProperty(this, 'statusText', { get: () => 'OK', configurable: true });
                Object.defineProperty(this, 'responseText', { get: () => '{}', configurable: true });
                Object.defineProperty(this, 'response', { get: () => '{}', configurable: true });
                setTimeout(() => ok('xhr-ev', () => {
                  this.dispatchEvent(new Event('readystatechange'));
                  this.dispatchEvent(new Event('load'));
                  this.dispatchEvent(new Event('loadend'));
                }), 0);
              });
              return;
            }
            body = sanitize(body);
          }
        } catch (e) {}
        return oSend.call(this, body);
      }, 'function send() { [native code] }');
    });
    ok('fetch', () => {
      const oFetch = window.fetch;
      window.fetch = mask(function (input, init) {
        try {
          const url = (typeof input === 'string') ? input : ((input && input.url) || '');
          if (isActivityURL(url)) {
            if (CFG.dropActivityPosts) return Promise.resolve(new Response('{}', { status: 200 }));
            if (input instanceof Request) {
              return input.clone().text().then((t) => oFetch.call(window, new Request(input, { body: sanitize(t) }), init));
            }
            if (init && init.body) init = Object.assign({}, init, { body: sanitize(init.body) });
          }
        } catch (e) {}
        return oFetch.apply(window, arguments);
      }, 'function fetch() { [native code] }');
    });
    ok('beacon', () => {
      if (!navigator.sendBeacon) return;
      const oBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = mask(function (u, d) {
        try {
          if (isActivityURL(u)) { if (CFG.dropActivityPosts) return true; d = sanitize(d); }
        } catch (e) {}
        return oBeacon(u, d);
      }, 'function sendBeacon() { [native code] }');
    });
    ok('websocket', () => {
      const oWsSend = WebSocket.prototype.send;
      WebSocket.prototype.send = mask(function (d) {
        try { if (typeof d === 'string') { const s = sanitize(d); if (s !== d) d = s; } } catch (e) {}
        return oWsSend.call(this, d);
      }, 'function send() { [native code] }');
    });
  }

  /* ===================== LAYER 4: GATE KILLER (FIXED) ===================== */
  if (CFG.gateKiller) {
    const kill = (el) => { try { el.remove(); } catch (e) {} };
    const openShadow = (root, depth) => {
      if (!root || depth > 6) return;
      try {
        root.querySelectorAll('#go-button, .enable_full_screen').forEach(kill);
        root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) openShadow(el.shadowRoot, depth + 1); });
      } catch (e) {}
    };
    window.GC_sweep = function () {
      try {
        document.querySelectorAll('#go-button, .enable_full_screen').forEach(kill);
        // FIX 3: overlay-hider REMOVED from the periodic sweep. It was hiding any
        // fixed/absolute div containing "overlay"/"blocker" — including the page's
        // own start dialog / countdown containers. Gate removal + MutationObserver
        // below is sufficient for #go-button / .enable_full_screen.
        openShadow(document, 0);
      } catch (e) { errors.push('sweep: ' + e.message); }
    };
    ok('attachShadow', () => {
      const origAttach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = mask(function (init) {
        return origAttach.call(this, Object.assign({}, init, { mode: 'open' }));
      }, 'function attachShadow() { [native code] }');
    });
    ok('observer', () => {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (n.id === 'go-button' || (n.classList && n.classList.contains('enable_full_screen'))) { kill(n); continue; }
          if (n.querySelector) { const i = n.querySelector('#go-button, .enable_full_screen'); if (i) kill(i); }
          if (n.shadowRoot) openShadow(n.shadowRoot, 0);
        }
      });
      window.GC_root = document.documentElement || document;
      mo.observe(window.GC_root, { childList: true, subtree: true });
      window.GC_mo = mo;
    });
    ok('start-sweep', () => {
      if (document.readyState === 'loading') {
        nativeAdd.call(document, 'DOMContentLoaded', () => window.GC_sweep(), { once: true });
      } else window.GC_sweep();
      setInterval(window.GC_sweep, 800);
    });
    ok('spa-routes', () => {
      ['pushState', 'replaceState'].forEach((m) => {
        const orig = history[m];
        history[m] = mask(function () { const r = orig.apply(this, arguments); setTimeout(window.GC_sweep, 50); return r; },
          `function ${m}() { [native code] }`);
      });
    });
    ok('iframe-inject', () => {
      nativeAdd.call(document, 'load', (e) => {
        const f = e.target;
        if (f && f.tagName === 'IFRAME') {
          setTimeout(() => ok('iframe-doc', () => {
            const d = f.contentDocument;
            if (d) d.querySelectorAll('#go-button, .enable_full_screen').forEach(kill);
            window.GC_sweep();
          }), 100);
        }
      }, true);
    });
  }

  /* ===================== LAYER 5: KEYBOARD / CLIPBOARD (FIXED) ===================== */
  if (CFG.keyboardUnlock) {
    const LOCK_KEYS = new Set(['F11', 'F12', 'PrintScreen', 'MetaLeft', 'MetaRight', 'ContextMenu']);
    const isCtrlCombo = (e) => (e.ctrlKey || e.metaKey) &&
      ['c', 'v', 'x', 'u', 'p', 's', 'w', 't', 'a', 'f'].includes(String(e.key).toLowerCase());
    const block = (e) => { if (LOCK_KEYS.has(e.key) || isCtrlCombo(e)) e.stopImmediatePropagation(); };
    ok('key-lock', () => {
      nativeAdd.call(window, 'keydown', block, true);
      nativeAdd.call(window, 'keyup', block, true);
    });
    ok('ctx-menu', () => nativeAdd.call(window, 'contextmenu', (e) => e.stopImmediatePropagation(), true));
    // FIX 2: document.onkeydown/onkeyup nulling and the oncontextmenu set-trap
    // REMOVED. The exam page installs its own keydown handler during init
    // (question navigation); killing it broke the start sequence and navigation.
    // The capture-phase 'block' above already suppresses restricted keys before
    // the page's handlers ever see them, which is the entire goal.
    ok('inline-handlers', () => {
      document.oncopy = document.onpaste = document.oncut = null;
      document.onselectstart = null;
    });
  }

  if (CFG.beforeUnloadUnlock) {
    ok('beforeunload', () => {
      Object.defineProperty(window, 'onbeforeunload', { set() {}, get() { return null; }, configurable: true });
      nativeAdd.call(window, 'beforeunload', (e) => {
        try { delete e.returnValue; } catch (err) {}
        e.stopImmediatePropagation();
      }, true);
    });
  }

  /* ===================== LAYER 6: CAMERA / MIC (FIXED) ===================== */
  const mockStream = () => {
    try {
      if (!window.MediaStream || !HTMLCanvasElement.prototype.captureStream) return null;
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const g = ctx.createLinearGradient(0, 0, 0, 480);
      g.addColorStop(0, '#3a4a5a'); g.addColorStop(1, '#1b2229');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#c9a98a';
      ctx.beginPath(); ctx.ellipse(320, 190, 78, 96, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2f3945';
      ctx.beginPath(); ctx.ellipse(320, 460, 175, 150, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d8d8d8'; ctx.font = '14px sans-serif';
      ctx.fillText('camera', 16, 468);
      const ms = new MediaStream();
      c.captureStream(5).getVideoTracks().forEach((t) => {
        ok('track-settings', () => {
          t.getSettings = () => ({ width: 640, height: 480, frameRate: 5, deviceId: 'default', facingMode: 'user' });
        });
        ms.addTrack(t);
      });
      ok('audio-track', () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ac = new AC();
        const dst = ac.createMediaStreamDestination();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain); gain.connect(dst); osc.start();
        dst.stream.getAudioTracks().forEach((t) => ms.addTrack(t));
      });
      return ms;
    } catch (e) { return null; }
  };

  ok('media', () => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const deny = () => () => Promise.reject(
      Object.assign(new DOMException('Permission denied', 'NotAllowedError'), { name: 'NotAllowedError' }));
    // FIX 4: getUserMedia now tries the mock stream, and if the mock cannot be
    // built, FALLS THROUGH TO THE REAL CAMERA instead of a hard rejection.
    // A hard NotAllowedError during the pre-start camera check stalls the
    // start flow; the real camera is the safe fallback.
    md.getUserMedia = mask(function (constraints) {
      if (CFG.mockCamera) {
        const s = mockStream();
        if (s) { log('mock camera served'); return Promise.resolve(s); }
      }
      return md.__gcOrig.getUserMedia.call(md, constraints);
    }, 'function getUserMedia() { [native code] }');
    md.__gcOrig = md;
    md.getDisplayMedia = mask(deny(), 'function getDisplayMedia() { [native code] }');
    md.enumerateDevices = mask(function () {
      return Promise.resolve([
        { deviceId: 'default', groupId: 'gc', kind: 'audioinput',  label: 'Default Microphone', toJSON() { return this; } },
        { deviceId: 'default', groupId: 'gc', kind: 'videoinput',  label: 'Default Camera',     toJSON() { return this; } },
        { deviceId: 'default', groupId: 'gc', kind: 'audiooutput', label: 'Default Speaker',    toJSON() { return this; } }
      ]);
    }, 'function enumerateDevices() { [native code] }');
    md.getSupportedConstraints = md.getSupportedConstraints || mask(function () { return {}; },
      'function getSupportedConstraints() { [native code] }');
    if (navigator.permissions && navigator.permissions.query) {
      const oQ = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = mask(function (desc) {
        const n = desc && desc.name ? String(desc.name) : '';
        if (/camera|microphone/.test(n)) return Promise.resolve({ state: 'granted', onchange: null });
        return oQ(desc);
      }, 'function query() { [native code] }');
    }
    if (CFG.mockCamera && window.MediaRecorder) {
      const oMR = window.MediaRecorder;
      window.MediaRecorder = mask(function (stream, opts) { return new oMR(stream || mockStream(), opts); },
        'function MediaRecorder() { [native code] }');
      window.MediaRecorder.isTypeSupported = oMR.isTypeSupported
        ? mask(oMR.isTypeSupported.bind(oMR), 'function isTypeSupported() { [native code] }') : () => true;
    }
  });

  /* ===================== LAYER 7: DEVICE SPOOF (unchanged) ===================== */
  if (CFG.deviceSpoof) {
    ok('usb',       () => { if (navigator.usb)       navigator.usb.getDevices       = () => Promise.resolve([]); });
    ok('bluetooth', () => { if (navigator.bluetooth) navigator.bluetooth.getDevices = () => Promise.resolve([]); });
    ok('serial',    () => { if (navigator.serial)    navigator.serial.getPorts      = () => Promise.resolve([]); });
    ok('hid',       () => { if (navigator.hid)       navigator.hid.getDevices       = () => Promise.resolve([]); });
    ok('matchMedia', () => {
      const oMM = window.matchMedia;
      window.matchMedia = mask(function (q) {
        const mql = oMM.call(window, q);
        try { if (/display-mode:\s*fullscreen/i.test(q)) {
          Object.defineProperty(mql, 'matches', { get: () => true, configurable: true });
        } } catch (e) {}
        return mql;
      }, 'function matchMedia() { [native code] }');
    });
    ok('orientation-lock', () => {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock = mask(function () { return Promise.resolve(); }, 'function lock() { [native code] }');
      }
    });
  }

  /* ===================== LAYER 8: isTrusted (unchanged) ===================== */
  ok('isTrusted', () => {
    [Event, UIEvent, MouseEvent, KeyboardEvent, WheelEvent, PointerEvent, FocusEvent, InputEvent, TouchEvent]
      .forEach((P) => { try {
        Object.defineProperty(P.prototype, 'isTrusted', { get() { return true; }, configurable: true });
      } catch (e) {} });
  });

  /* ===================== LAYER 9: DEVTOOLS SHIELDS (unchanged) ===================== */
  if (CFG.devtoolsShields) {
    ok('worker', () => {
      const OW = window.Worker;
      const W = mask(function (u) {
        if (typeof u === 'string' && /(devtools|detect|debug|proctor-check)/i.test(u)) {
          throw new DOMException('SecurityError', 'SecurityError');
        }
        return new OW(u);
      }, 'function Worker() { [native code] }');
      Object.setPrototypeOf(W, OW);
      window.Worker = W;
    });
    ok('serviceworker', () => {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = mask(function () {
          return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError'));
        }, 'function register() { [native code] }');
      }
    });
    ok('canvas', () => {
      let c16 = null;
      const oDU = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = mask(function () {
        if (this.width <= 16 && this.height <= 16) {
          if (c16 === null) c16 = oDU.apply(this, arguments);
          return c16;
        }
        return oDU.apply(this, arguments);
      }, 'function toDataURL() { [native code] }');
    });
    ok('stack', () => {
      const d = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
      if (!d || !d.get) return;
      const og = d.get;
      Object.defineProperty(Error.prototype, 'stack', {
        get() {
          const s = og.call(this);
          return typeof s === 'string'
            ? s.replace(/userscript|tampermonkey|greasemonkey|content-script/gi, '') : s;
        },
        configurable: true
      });
    });
    ok('console', () => {
      const oLog = console.log;
      console.log = mask(function () {
        if (arguments.length && Array.prototype.some.call(arguments, (a) => typeof a === 'string' && a.indexOf('%c') !== -1)) return;
        return oLog.apply(console, arguments);
      }, 'function log() { [native code] }');
    });

    if (CFG.antiDebugStrip) {
      ok('eval-strip', () => {
        const oEval = window.eval;
        window.eval = mask(function (code) {
          if (typeof code === 'string') code = code.replace(/debugger;?/g, '');
          return oEval(code);
        }, 'function eval() { [native code] }');
      });
      ok('function-strip', () => {
        const oCtor = Function.prototype.constructor;
        Function.prototype.constructor = mask(function (...args) {
          if (typeof args[0] === 'string') args[0] = args[0].replace(/debugger;?/g, '');
          return oCtor.apply(Function, args);
        }, 'function constructor() { [native code] }');
      });
      ok('console-clear', () => {
        console.clear = mask(function () {}, 'function clear() { [native code] }');
      });
    }

    if (CFG.navTimingSpoof) {
      ok('nav-timing', () => {
        const forceNavigate = () => {
          try {
            const entries = performance.getEntriesByType('navigation');
            if (entries && entries.length && entries[0].type === 'reload') {
              Object.defineProperty(performance, 'getEntriesByType', {
                value: (t) => (t === 'navigation')
                  ? [Object.assign({}, entries[0], { type: 'navigate' })]
                  : Performance.prototype.getEntriesByType.call(performance, t),
                configurable: true
              });
            }
          } catch (e) {}
        };
        forceNavigate();
        nativeAdd.call(document, 'DOMContentLoaded', forceNavigate, { once: true });
      });
    }
  }

  /* ===================== SELECTION UNLOCK (unchanged) ===================== */
  if (CFG.selectionUnlock) {
    ok('user-select-css', () => {
      const st = document.createElement('style');
      st.id = 'gc-user-select';
      st.textContent = '*, *::before, *::after { user-select: auto !important; -webkit-user-select: auto !important; }';
      (document.head || document.documentElement).appendChild(st);
    });
    ok('copy-events', () => {
      ['copy', 'cut', 'paste', 'selectstart', 'dragstart'].forEach((ev) => {
        nativeAdd.call(window, ev, (e) => e.stopImmediatePropagation(), true);
      });
    });
  }

  /* ===================== WATCHDOG (unchanged) ===================== */
  setInterval(() => {
    for (const p of PATCHES) {
      try {
        const d = Object.getOwnPropertyDescriptor(p.obj, p.prop);
        if (!d || d.get !== p.getter) {
          Object.defineProperty(p.obj, p.prop, { get: p.getter, configurable: true, enumerable: true });
        }
      } catch (e) {}
    }
    try {
      if (window.GC_mo && document.documentElement !== window.GC_root) {
        window.GC_root = document.documentElement;
        window.GC_mo.observe(window.GC_root, { childList: true, subtree: true });
      }
    } catch (e) {}
  }, 750);

  /* ===================== DIAGNOSTICS (unchanged) ===================== */
  window.GC = {
    status() {
      return {
        fullscreenElement: !!document.fullscreenElement,
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        inner: window.innerWidth + 'x' + window.innerHeight,
        isExtended: screen && 'isExtended' in screen ? screen.isExtended : 'n/a',
        displayModeFullscreen: matchMedia('(display-mode: fullscreen)').matches,
        gatePresent: !!document.querySelector('#go-button, .enable_full_screen'),
        userScriptHidden: !/userscript|tampermonkey/i.test('' + (function s(){return new Error().stack;})())
      };
    },
    report() { return { config: CFG, errors: errors.slice(), state: this.status() }; },
    sweep() { try { window.GC_sweep(); } catch (e) {} }
  };

  ok('hotkey', () => {
    nativeAdd.call(window, 'keydown', (e) => {
      if (!(e.altKey && e.shiftKey && (e.key === 'G' || e.key === 'g'))) return;
      const r = window.GC.report();
      const panel = document.getElementById('gc-panel');
      if (panel) { panel.remove(); return; }
      const p = document.createElement('div');
      p.id = 'gc-panel';
      p.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;max-width:420px;max-height:70vh;overflow:auto;background:#0b0f14;color:#9fe8a0;font:12px/1.4 monospace;padding:10px;border:1px solid #2b3a2c;border-radius:6px;white-space:pre-wrap';
      p.textContent = 'GC V6.1\n\n' + JSON.stringify(r.state, null, 2) +
        '\n\nErrors (' + r.errors.length + '):\n' + (r.errors.join('\n') || 'none');
      document.documentElement.appendChild(p);
    }, true);
  });

  console.log('[GC-V6.1] armed — errors:', errors.length, errors.length ? errors : '');
})();