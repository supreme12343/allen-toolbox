/*
 * ALLEN Toolbox — userscript manager (background half).
 * Stores scripts, registers them with chrome.userScripts, and performs the privileged things a script may
 * ask for (cross-origin requests, downloads, tabs, notifications, saved values, menu commands).
 */
import { parseMeta, buildTargets, chromeRunAt, matchPatternToRegex, globToRegex, scriptOrigins, MAX_SCRIPT_BYTES, assertScriptSize } from '../shared/usmeta.js';
import { validateZipPath } from '../shared/zip.js';

const API_NAMES = ['unsafeWindow', 'GM_info', 'GM', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues',
  'GM_addValueChangeListener', 'GM_removeValueChangeListener', 'GM_addStyle', 'GM_addElement', 'GM_setClipboard', 'GM_log',
  'GM_getResourceText', 'GM_getResourceURL', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM_openInTab',
  'GM_notification', 'GM_xmlhttpRequest', 'GM_download', 'AO'];

// op -> the @grant it needs (enforced here as well as in the page, so a script cannot reach beyond what it declared)
const NEEDS = {
  'val.set': 'GM_setValue', 'val.delete': 'GM_deleteValue', 'xhr': 'GM_xmlhttpRequest', 'xhr.abort': 'GM_xmlhttpRequest',
  'download': 'GM_download', 'download.abort': 'GM_download', 'notify': 'GM_notification', 'tab.open': 'GM_openInTab',
  'tab.close': 'GM_openInTab', 'menu.reg': 'GM_registerMenuCommand', 'menu.unreg': 'GM_registerMenuCommand',
  'ao.items': 'AO', 'ao.save': 'AO',
};
const STREAMING = new Set(['xhr', 'download', 'notify']);
const MAX_TEXT = 3 * 1024 * 1024;           // @require / @resource size cap
const MAX_BINARY_REPLY = 60 * 1024 * 1024;  // GM_xmlhttpRequest reply cap (use GM_download for big files)

export function initGM(deps) {
  const { ready, offscreen, saveBlob, setReferer, listItems, saveItem, startHttpJob, acquireRequest, releaseRequest } = deps;

  let scripts = [];
  const valCache = new Map();               // scriptId -> { key: parsedValue }
  const ports = new Set();                  // live script connections: { port, rec, tabId, frameId, url, aborts }
  const menus = new Map();                  // tabId -> Map(key -> command)
  const gmJobs = new Map();                 // download jobId -> { ctx, id }
  const notifs = new Map();                 // notification id -> { ctx, id }
  const refreshTimers = new Map();
  let texts = null;
  let pendingSync = true;            // Older installs have no marker; missing registrations are also checked on each list.
  let bundleLedger = Object.create(null), bundleReport = { imported: 0, skipped: 0, errors: [] };
  let hydrated = false, scanFlight = null, syncFlight = null, syncError = '', changeSeq = 0;
  let writeTail = Promise.resolve();

  const loaded = (async () => {
    const stored = await chrome.storage.local.get(['uscripts', 'usbundles', 'usneedsync']);
    scripts = Array.isArray(stored.uscripts) ? stored.uscripts : [];
    pendingSync = stored.usneedsync !== false;
    if (stored.usbundles && typeof stored.usbundles === 'object' && !Array.isArray(stored.usbundles)) {
      bundleLedger = Object.assign(Object.create(null), stored.usbundles);
    }
  })();
  const commit = (fn) => {
    const result = writeTail.then(fn);
    writeTail = result.catch(() => {});
    return result;
  };
  async function store(nextScripts = scripts, nextLedger = bundleLedger, needsSync = true) {
    await chrome.storage.local.set({ uscripts: nextScripts, usbundles: nextLedger, usneedsync: needsSync });
    scripts = nextScripts; bundleLedger = nextLedger; pendingSync = needsSync;
  }
  const find = (id) => scripts.find((s) => s.id === id);
  const bundleIdFor = (id) => Object.keys(bundleLedger).find((bundleId) => bundleLedger[bundleId] === id);

  /* ------------------------------------------------------------ availability */
  async function available() {
    try {
      const actual = new Set((await chrome.userScripts.getScripts()).filter((r) => r.id.startsWith('ao-us-')).map((r) => r.id));
      const expected = new Set();
      for (const rec of scripts) if (rec.enabled && buildTargets(rec.meta).matches.length) {
        expected.add('ao-us-' + rec.id);
        if (!rec.meta.noneGrant && rec.meta.injectInto !== 'content') expected.add('ao-us-relay-' + rec.id);
      }
      if (actual.size !== expected.size || [...expected].some((id) => !actual.has(id))) pendingSync = true;
      return true;
    } catch (e) { pendingSync = true; return false; }
  }

  /* ------------------------------------------------------------ values */
  async function getVals(id) {
    if (!valCache.has(id)) { const r = await chrome.storage.local.get('usval:' + id); valCache.set(id, Object.assign(Object.create(null), r['usval:' + id] || {})); }
    return valCache.get(id);
  }
  const saveVals = (id) => chrome.storage.local.set({ ['usval:' + id]: valCache.get(id) || {} });

  /* ------------------------------------------------------------ code generation */
  async function loadTexts() {
    if (!texts) {
      const get = async (p) => {
        const r = await fetch(chrome.runtime.getURL(p));
        if (!r.ok) throw new Error('Missing userscript runtime asset ' + p + ' (HTTP ' + r.status + ')');
        return r.text();
      };
      const [runtime, relay] = await Promise.all([get('gm/gm-runtime.js'), get('gm/gm-relay.js')]);
      texts = { runtime, relay };
    }
    return texts;
  }

  function makeInfo(rec) {
    const m = rec.meta;
    return {
      script: {
        id: rec.id, name: m.name, namespace: m.namespace, version: m.version, description: m.description, author: m.author,
        grant: m.noneGrant ? ['none'] : m.grants, matches: m.matches, includes: m.includes, excludes: m.excludes,
        'run-at': m.runAt, connects: m.connects, resources: m.resources.map((r) => ({ name: r.name, url: r.url })),
        injectInto: m.injectInto, noframes: m.noframes,
      },
      scriptHandler: 'ALLEN Toolbox', version: chrome.runtime.getManifest().version, injectInto: m.injectInto === 'content' ? 'content' : 'page',
      scriptMetaStr: m.raw || '', isIncognito: false, platform: { browserName: 'chrome' },
    };
  }

  function filterCode(targets) {
    if (!targets.needsFilter) return '';
    const conv = (e) => (e.t === 'r' ? { s: e.s, f: e.f } : e.t === 'g' ? { s: globToRegex(e.s).source, f: 'i' } : { s: (matchPatternToRegex(e.s) || /$^/).source, f: 'i' });
    const inc = targets.includeFilter.map(conv), exc = targets.excludeFilter.map(conv);
    return `const __inc=${JSON.stringify(inc)},__exc=${JSON.stringify(exc)};const __t=(a)=>a.some((e)=>new RegExp(e.s,e.f).test(location.href));` +
      'if((__inc.length&&!__t(__inc))||__t(__exc))return;\n';
  }

  async function registrationsFor(rec) {
    const meta = rec.meta, targets = buildTargets(meta);
    if (!targets.matches.length) return [];
    const { runtime, relay } = await loadTexts();
    const vals = await getVals(rec.id);
    const info = makeInfo(rec);
    const mode = meta.injectInto === 'content' ? 'content' : 'page';
    const requires = (rec.requireCode || []).map((r) => '// @require ' + r.url + '\n' + r.code + '\n;').join('\n');
    const body = requires + '\n' + rec.code + '\n';
    let code;
    if (meta.noneGrant) {
      code = `(function(){${filterCode(targets)}const unsafeWindow=window;const GM_info=${JSON.stringify(info)};const GM={info:GM_info};\n${body}\n}).call(window);`;
    } else {
      const res = {};
      for (const [name, r] of Object.entries(rec.resources || {})) res[name] = r;
      code = `(function(){${filterCode(targets)}const __rt=(${runtime})(${JSON.stringify(rec.chan)},${JSON.stringify(info)},${JSON.stringify(meta.grants)},${JSON.stringify(vals)},${JSON.stringify(res)},${JSON.stringify(mode)});\n` +
        `return (function(${API_NAMES.join(',')}){\n${body}\n}).call(window,${API_NAMES.map((n) => '__rt.' + n).join(',')});})();`;
    }
    const base = { matches: targets.matches, ...(targets.excludeMatches.length ? { excludeMatches: targets.excludeMatches } : {}), allFrames: !meta.noframes };
    const out = [{ id: 'ao-us-' + rec.id, ...base, js: [{ code }], runAt: chromeRunAt(meta), world: mode === 'content' ? 'USER_SCRIPT' : 'MAIN' }];
    if (!meta.noneGrant && mode === 'page') {
      out.push({ id: 'ao-us-relay-' + rec.id, ...base, runAt: 'document_start', world: 'USER_SCRIPT', js: [{ code: `(${relay})(${JSON.stringify(rec.chan)},${JSON.stringify(rec.id)});` }] });
    }
    return out;
  }

  async function syncAll() {
    await hydrate();
    if (!syncFlight) {
      syncFlight = reconcile().catch(async (e) => {
        pendingSync = true;
        syncError = 'Userscript registration is pending: ' + (e.message || String(e)) + '. Use Check Again to retry.';
        console.error('[AO] userscript sync failed:', e);
        try { await commit(() => store(scripts, bundleLedger, true)); } catch (storageError) { /* retry on the next management action */ }
        return false;
      }).finally(() => { syncFlight = null; });
    }
    return syncFlight;
  }

  async function reconcile() {
    for (;;) {
      const version = changeSeq;
      if (!(await available())) {
        syncError = 'Allow User Scripts is unavailable. Enable it in the extension settings, then use Check Again.';
        await commit(() => store(scripts, bundleLedger, true));
        return false;
      }
      await chrome.userScripts.configureWorld({ messaging: true });
      const snapshot = scripts.slice(), errors = new Map();
      const owned = new Set(snapshot.flatMap((rec) => ['ao-us-' + rec.id, 'ao-us-relay-' + rec.id]));
      const stale = (await chrome.userScripts.getScripts()).filter((r) => r.id.startsWith('ao-us-') && !owned.has(r.id)).map((r) => r.id);
      let failed = false;
      syncError = '';
      if (stale.length) {
        try { await chrome.userScripts.unregister({ ids: stale }); }
        catch (e) { failed = true; syncError = 'Could not remove a deleted script registration: ' + (e.message || String(e)); }
      }
      for (const rec of snapshot) {
        let error = '';
        try {
          // Prepare before unregistering; one bad script must not take down unrelated scripts.
          const regs = rec.enabled ? await registrationsFor(rec) : [];
          const ids = ['ao-us-' + rec.id, 'ao-us-relay-' + rec.id];
          const old = (await chrome.userScripts.getScripts({ ids })).map((r) => r.id);
          if (old.length) await chrome.userScripts.unregister({ ids: old });
          if (regs.length) await chrome.userScripts.register(regs);
        } catch (e) { failed = true; error = 'Registration pending: ' + (e.message || String(e)) + '. Check site access and use Check Again.'; }
        errors.set(rec.id, { rec, error });
      }
      await commit(async () => {
        const next = scripts.map((rec) => {
          const update = errors.get(rec.id);
          return update?.rec === rec && rec.error !== update.error ? { ...rec, error: update.error } : rec;
        });
        await store(next, bundleLedger, failed || version !== changeSeq);
      });
      if (version === changeSeq) return !failed;
    }
  }

  // keep the value snapshot embedded in the registered code fresh (debounced)
  function scheduleRefresh(id) {
    clearTimeout(refreshTimers.get(id));
    refreshTimers.set(id, setTimeout(async () => {
      const rec = find(id);
      if (!rec || !rec.enabled) return;
      try {
        if (!(await available())) throw new Error('Allow User Scripts is unavailable');
        const regs = await registrationsFor(rec);
        const main = regs.find((r) => r.id === 'ao-us-' + id);
        if (main) await chrome.userScripts.update([main]);
      } catch (e) {
        pendingSync = true;
        try { await commit(() => store(scripts, bundleLedger, true)); } catch (storageError) { /* next management action retries */ }
      }
    }, 800));
  }

  /* ------------------------------------------------------------ install / manage */
  async function fetchText(url, maxBytes = MAX_TEXT) {
    const signal = AbortSignal.timeout(30000);
    return withHeaderRule(new URL(url), [], signal, 'GET', async () => {
      const r = await fetch(url, { cache: 'no-store', signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const reader = r.body?.getReader(), chunks = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('file exceeds the ' + (maxBytes / 1048576) + ' MiB limit'); }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { buf: bytes.buffer, type: (r.headers.get('content-type') || '').split(';')[0] };
    });
  }
  async function fetchSource(href) {
    const url = new URL(href);
    if (!/^https?:$/.test(url.protocol)) throw new Error('Enter a full HTTP(S) userscript URL');
    const { buf } = await fetchText(url.href, MAX_SCRIPT_BYTES);
    const code = new TextDecoder().decode(buf); assertScriptSize(code);
    return { code };
  }
  const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const rand = () => 'ao' + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(36).padStart(2, '0')).join('');

  async function prepareScript({ id, code, enabled = true, expectedUpdatedAt }) {
    if (typeof code !== 'string' || !code.trim()) throw new Error('The script is empty');
    assertScriptSize(code);
    const meta = parseMeta(code);
    const raw = /\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/i.exec(code);
    meta.raw = raw ? raw[0] : '';
    if (!meta.name) throw new Error('The script needs an @name in its header');
    const prev = id ? find(id) : null;
    if (id && !prev) throw new Error('This script was deleted. Export your edits before closing the editor.');
    if (prev && expectedUpdatedAt !== undefined && prev.updatedAt !== expectedUpdatedAt) {
      throw new Error('This script changed in another tab. Your draft is kept; reopen the script or export your edits.');
    }
    const baseUpdatedAt = prev && prev.updatedAt;

    const requireCode = [];
    for (const url of meta.requires) {
      const old = prev && (prev.requireCode || []).find((r) => r.url === url);
      if (old) { requireCode.push(old); continue; }
      try { const { buf } = await fetchText(url); requireCode.push({ url, code: new TextDecoder().decode(buf) }); }
      catch (e) { throw new Error('Could not download @require ' + url + ' - ' + e.message + '. Network access and site permission may be needed; dependency caches are not bundled.'); }
    }
    const resources = {};
    for (const r of meta.resources) {
      const old = prev && prev.resources && prev.resources[r.name];
      if (old && old.url === r.url) { resources[r.name] = old; continue; }
      try {
        const { buf, type } = await fetchText(r.url);
        const isText = /text|json|javascript|xml|svg/.test(type) || !type;
        resources[r.name] = { url: r.url, text: isText ? new TextDecoder().decode(buf) : '', dataUrl: 'data:' + (type || 'application/octet-stream') + ';base64,' + toB64(buf) };
      } catch (e) { throw new Error('Could not download @resource ' + r.name + ' (' + r.url + ') - ' + e.message + '. Network access and site permission may be needed; dependency caches are not bundled.'); }
    }

    // Dependencies may take time to fetch. Do not replace a record changed or deleted during that wait.
    if (prev && (!find(id) || find(id).updatedAt !== baseUpdatedAt)) {
      throw new Error('This script changed while its dependencies were loading. Your draft is kept; reopen the script.');
    }
    const rec = {
      id: prev ? prev.id : crypto.randomUUID(), enabled: !!enabled, code, meta, requireCode, resources, chan: rand(),
      installedAt: prev ? prev.installedAt : Date.now(), updatedAt: Math.max(Date.now(), (Number(baseUpdatedAt) || 0) + 1), error: '',
    };
    return { rec, baseUpdatedAt };
  }

  function scriptFile(file) {
    validateZipPath(file);
    if (!/\.user\.js$/i.test(file)) throw new Error('Folder scripts must use a .user.js file');
    return 'scripts/' + file;
  }

  function importBundles() {
    if (scanFlight) return scanFlight;
    scanFlight = (async () => {
      const report = { imported: 0, skipped: 0, errors: [] };
      let index;
      try {
        const { buf } = await fetchText(chrome.runtime.getURL('scripts/scripts.json'));
        index = JSON.parse(new TextDecoder().decode(buf));
        if (!Array.isArray(index)) throw new Error('Expected an array of {id, file, enabled} entries');
      } catch (e) { report.errors.push('scripts/scripts.json: ' + (e.message || String(e))); bundleReport = report; return report; }
      const counts = new Map();
      for (const entry of index) if (typeof entry?.id === 'string') counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
      for (const entry of index) {
        const label = typeof entry?.id === 'string' ? entry.id : '(invalid entry)';
        try {
          if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.trim() !== entry.id || entry.id.length > 200 || /[\x00-\x1f\x7f]/.test(entry.id)) throw new Error('A nonempty, stable bundle id is required');
          if (counts.get(entry.id) !== 1) throw new Error('Duplicate bundle id; every id must be unique');
          const path = scriptFile(entry.file);
          if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('enabled must be a boolean (omitted defaults to disabled)');
          if (Object.hasOwn(bundleLedger, entry.id) && find(bundleLedger[entry.id])) { report.skipped++; continue; }
          const { buf } = await fetchText(chrome.runtime.getURL(path), MAX_SCRIPT_BYTES);
          const { rec } = await prepareScript({ code: new TextDecoder().decode(buf), enabled: entry.enabled === true });
          await commit(async () => {
            if (Object.hasOwn(bundleLedger, entry.id) && find(bundleLedger[entry.id])) { report.skipped++; return; }
            const nextLedger = Object.assign(Object.create(null), bundleLedger, { [entry.id]: rec.id });
            // Publish the record and its stable-ID mapping together, including restored imports.
            await store([...scripts, rec], nextLedger, true);
            changeSeq++;
            report.imported++;
          });
        } catch (e) { report.errors.push(label + ': ' + (e.message || String(e))); }
      }
      bundleReport = report;
      return report;
    })().finally(() => { hydrated = true; scanFlight = null; });
    return scanFlight;
  }

  async function hydrate() {
    await loaded;
    if (!hydrated || scanFlight) await importBundles();
  }

  function bundlesStatus() {
    const errors = [...bundleReport.errors];
    if (syncError) errors.push(syncError);
    for (const rec of scripts) if (rec.error) errors.push(rec.meta.name + ': ' + rec.error);
    return { imported: bundleReport.imported, skipped: bundleReport.skipped, errors };
  }

  async function scanBundles() {
    await loaded;
    await importBundles();
    await syncAll();
    return bundlesStatus();
  }

  async function saveScript(args) {
    await hydrate();
    const { rec, baseUpdatedAt } = await prepareScript(args);
    await commit(async () => {
      const prev = args.id ? find(args.id) : null;
      if (args.id && (!prev || prev.updatedAt !== baseUpdatedAt)) throw new Error('This script changed or was deleted while saving. Your draft is kept; reopen the script.');
      await store(prev ? scripts.map((s) => s.id === rec.id ? rec : s) : [...scripts, rec]);
      changeSeq++;
    });
    for (const p of [...ports]) if (p.rec.id === rec.id) { try { p.port.disconnect(); } catch (e) { /* gone */ } }
    await syncAll();
    return summary(find(rec.id) || rec);
  }

  async function summary(rec) {
    const t = buildTargets(rec.meta);
    const origins = scriptOrigins(rec.meta);
    let access = true;
    try { if (origins.length) access = await chrome.permissions.contains({ origins }); } catch (e) { access = true; }
    return {
      id: rec.id, bundleId: bundleIdFor(rec.id) || '', enabled: rec.enabled, name: rec.meta.name, version: rec.meta.version, description: rec.meta.description,
      author: rec.meta.author, matches: t.matches, origins, grants: rec.meta.noneGrant ? [] : rec.meta.grants,
      injectInto: rec.meta.injectInto === 'content' ? 'sandbox' : 'page', noneGrant: rec.meta.noneGrant, connects: rec.meta.connects,
      requires: rec.meta.requires.length, resources: rec.meta.resources.length, runAt: rec.meta.runAt, noframes: rec.meta.noframes,
      hasMatch: t.matches.length > 0, access, error: rec.error || (pendingSync ? syncError : ''), updatedAt: rec.updatedAt,
    };
  }

  async function listScripts() {
    await hydrate();
    await available();
    if (pendingSync) await syncAll();
    return { available: await available(), scripts: await Promise.all(scripts.map(summary)), bundles: bundlesStatus() };
  }

  async function removeScript(id) {
    await hydrate();
    const removed = await commit(async () => {
      if (!find(id)) return false;
      if (bundleIdFor(id) !== undefined) throw new Error('Folder scripts cannot be deleted in the toolbox. Disable the script instead.');
      await store(scripts.filter((s) => s.id !== id));
      changeSeq++;
      return true;
    });
    if (!removed) return;
    for (const p of [...ports]) if (p.rec.id === id) { try { p.port.disconnect(); } catch (e) { /* gone */ } }
    clearTimeout(refreshTimers.get(id)); refreshTimers.delete(id);
    valCache.delete(id);
    await chrome.storage.local.remove('usval:' + id);
    await syncAll();
  }

  async function toggleScript(id, enabled) {
    await hydrate();
    await commit(async () => {
      const prev = find(id);
      if (!prev) throw new Error('Script not found');
      const rec = { ...prev, enabled: !!enabled, updatedAt: Math.max(Date.now(), (Number(prev.updatedAt) || 0) + 1) };
      await store(scripts.map((s) => s.id === id ? rec : s));
      changeSeq++;
    });
    await syncAll();
    const rec = find(id);
    if (!rec) throw new Error('This script was deleted while its toggle was being saved');
    return summary(rec);
  }

  async function exportBundle() {
    await hydrate();
    await writeTail;
    const stored = await chrome.storage.local.get(['uscripts', 'usbundles']);
    const saved = Array.isArray(stored.uscripts) ? stored.uscripts : [];
    const originalIds = new Map(Object.entries(stored.usbundles || {}).map(([bundleId, localId]) => [localId, bundleId]));
    const index = [], files = [], ids = new Set();
    for (const rec of saved) {
      const id = originalIds.get(rec.id) || rec.id, file = 'script-' + (index.length + 1) + '.user.js';
      if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('Saved scripts have conflicting or invalid stable bundle IDs');
      if (typeof rec.code !== 'string') throw new Error('A saved script source is missing; export aborted');
      assertScriptSize(rec.code);
      ids.add(id);
      index.push({ id, file, enabled: !!rec.enabled });
      files.push({ path: 'scripts/' + file, text: rec.code });
    }
    return { index, files };
  }

  /* ------------------------------------------------------------ privileged operations a script may request */
  const connectAllowed = (meta, url, pageUrl) => {
    if (!meta.connects.length) return true;
    const host = url.hostname.toLowerCase();
    let pageHost = '';
    try { pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch (e) { /* ignore */ }
    return meta.connects.some((entry) => {
      const c = entry.toLowerCase().replace(/^\*\./, '');
      if (c === 'self') return host === pageHost || host.endsWith('.' + pageHost);
      return c === '*' || host === c || host.endsWith('.' + c);
    });
  };

  async function withHeaderRule(url, headers, signal, method, fn) {
    if (!/^https?:$/.test(url.protocol)) return fn();
    const requestId = 'gm:' + crypto.randomUUID();
    let abort;
    const aborted = new Promise((resolve, reject) => {
      abort = () => { releaseRequest(requestId).catch(() => {}); reject(signal.reason || new Error('The request was aborted')); };
    });
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      await Promise.race([acquireRequest({ url: url.href, requestId, requestHeaders: headers, method }), aborted]);
      signal.throwIfAborted();
      return await fn();
    } finally {
      signal.removeEventListener('abort', abort);
      await releaseRequest(requestId);
    }
  }

  async function doXhr(ctx, id, a, emit) {
    const url = new URL(a.url);
    if (!/^https?:$/.test(url.protocol) && url.protocol !== 'data:') throw new Error('Only http(s) URLs can be requested');
    if (!connectAllowed(ctx.rec.meta, url, a.page || ctx.url)) throw new Error('Blocked: ' + url.hostname + ' is not listed in this script\'s @connect');

    const ctl = new AbortController();
    ctx.aborts.set(id, ctl);
    let timedOut = false;
    const timer = a.timeout ? setTimeout(() => { timedOut = true; ctl.abort(); }, a.timeout) : null;

    const direct = {}, dnr = [], given = new Set();
    for (const [k, v] of Object.entries(a.headers || {})) {
      const l = k.toLowerCase(); given.add(l);
      if (['cookie', 'referer', 'origin', 'user-agent'].includes(l)) dnr.push({ header: l, operation: 'set', value: String(v) });
      else if (!['host', 'accept-encoding', 'connection', 'content-length'].includes(l)) direct[k] = String(v);
    }
    // a real XHR from the page would carry the page as Referer and its origin as Origin
    let pageOrigin = '';
    try { pageOrigin = new URL(a.page).origin; } catch (e) { /* ignore */ }
    if (!given.has('referer') && a.page) dnr.push({ header: 'referer', operation: 'set', value: a.page });
    if (!given.has('origin') && pageOrigin) dnr.push({ header: 'origin', operation: 'set', value: pageOrigin });
    if (a.user) direct.Authorization = 'Basic ' + btoa(a.user + ':' + (a.password || ''));

    let body;
    if (a.body && !['GET', 'HEAD'].includes((a.method || 'GET').toUpperCase())) {
      body = a.body.t === 's' ? a.body.v : Uint8Array.from(atob(a.body.v), (c) => c.charCodeAt(0));
    }
    const binaryReply = a.responseType === 'arraybuffer' || a.responseType === 'blob';

    try {
      await withHeaderRule(url, dnr, ctl.signal, a.method || 'GET', async () => {
        const resp = await fetch(url.href, {
          method: a.method || 'GET', headers: direct, body, credentials: a.anonymous ? 'omit' : 'include',
          redirect: a.redirect || 'follow', cache: 'no-store', signal: ctl.signal,
        });
        const head = {
          status: resp.status, statusText: resp.statusText, finalUrl: resp.url || a.url,
          responseHeaders: [...resp.headers].map(([k, v]) => k + ': ' + v).join('\r\n'),
        };
        const total = +resp.headers.get('content-length') || 0;
        const reader = resp.body ? resp.body.getReader() : null;
        const chunks = []; let loaded = 0, last = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); loaded += value.length;
            if (binaryReply && loaded > MAX_BINARY_REPLY) { ctl.abort(); throw new Error('The reply is larger than ' + (MAX_BINARY_REPLY / 1048576) + ' MB — use GM_download for big files'); }
            if (Date.now() - last > 150) { last = Date.now(); emit('progress', { ...head, readyState: 3, loaded, total, lengthComputable: !!total }); }
          }
        }
        const all = new Uint8Array(loaded); let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        const data = { ...head, readyState: 4, loaded, total: total || loaded, lengthComputable: true };
        if (binaryReply) { data.b64 = toB64(all); data.ct = resp.headers.get('content-type') || ''; }
        else if (a.binary) data.text = Array.from(all, (b) => String.fromCharCode(b)).join('');
        else {
          const cs = /charset=([\w-]+)/i.exec(resp.headers.get('content-type') || '');
          let text;
          try { text = new TextDecoder(cs ? cs[1] : 'utf-8').decode(all); } catch (e) { text = new TextDecoder().decode(all); }
          data.text = text;
        }
        emit('readystatechange', data);
        emit('load', data);
      });
    } catch (e) {
      if (e.name === 'AbortError') emit(timedOut ? 'timeout' : 'abort', { readyState: 4, status: 0 });
      else {
        let hint = '';
        // without host access Chrome applies CORS to the request — say so instead of a bare "Failed to fetch"
        try { if (e instanceof TypeError && !(await chrome.permissions.contains({ origins: [url.origin + '/*'] }))) hint = ' — ALLEN Toolbox has no access to ' + url.hostname + ' yet (popup → Tools → Allow all sites)'; } catch (e2) { /* ignore */ }
        emit('error', { error: (e.message || String(e)) + hint });
      }
    } finally { if (timer) clearTimeout(timer); ctx.aborts.delete(id); }
  }

  /* downloads reuse the extension's own streaming downloader (it already sends the right Referer, resumes ranges, verifies size) */
  async function doDownload(ctx, id, a, emit) {
    const url = new URL(a.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) URLs can be downloaded');
    if (!connectAllowed(ctx.rec.meta, url, a.page || ctx.url)) throw new Error('Blocked: ' + url.hostname + ' is not listed in this script\'s @connect');
    let name = a.name || url.pathname.split('/').pop() || 'download';
    if (!a.name) { try { name = decodeURIComponent(name); } catch (e) { /* Keep a literal percent in a valid URL filename. */ } }
    const jobId = await startHttpJob({ url: url.href, name, exactName: true, referer: a.page || ctx.url, tabId: ctx.tabId });
    gmJobs.set(jobId, { ctx, id, emit, name });
  }

  // called by the background whenever a download job reports progress
  function onJobUpdate(m, job) {
    const g = gmJobs.get(m.jobId);
    if (!g) return;
    if (m.state === 'running' && m.total !== undefined) g.emit('progress', { loaded: m.done, total: m.total, lengthComputable: !!m.total });
    else if (m.state === 'done') { g.emit('load', { url: job && job.filename, name: m.filename }); gmJobs.delete(m.jobId); }
    else if (m.state === 'error' || m.state === 'cancelled') { g.emit('error', { error: 'not_succeeded', details: m.message || m.state }); gmJobs.delete(m.jobId); }
  }

  function doNotify(ctx, id, a, emit) {
    const nid = 'ao-n-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    notifs.set(nid, { emit });
    chrome.notifications.create(nid, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: String(a.title).slice(0, 120), message: String(a.text).slice(0, 400), silent: !!a.silent,
    });
    if (a.timeout) setTimeout(() => chrome.notifications.clear(nid), a.timeout);
  }
  chrome.notifications.onClicked.addListener((nid) => { const n = notifs.get(nid); if (n) n.emit('click', {}); });
  chrome.notifications.onClosed.addListener((nid, byUser) => { const n = notifs.get(nid); if (n) { n.emit('done', { byUser }); notifs.delete(nid); } });

  function menuFor(tabId) { if (!menus.has(tabId)) menus.set(tabId, new Map()); return menus.get(tabId); }
  const menuKey = (ctx, cmdId) => ctx.rec.id + ':' + ctx.frameId + ':' + cmdId;

  async function dispatch(ctx, m) {
    const current = find(ctx.rec.id);
    if (!current?.enabled || current.chan !== ctx.rec.chan) throw new Error('This script changed or was disabled. Reload the website.');
    ctx.rec = current;
    const need = NEEDS[m.op];
    if (!need) throw new Error('Unknown request: ' + m.op);
    if (!ctx.rec.meta.grants.includes(need)) throw new Error('This script did not request @grant ' + need);
    const a = m.args || {};
    switch (m.op) {
      case 'val.set': case 'val.delete': {
        const vals = await getVals(ctx.rec.id);
        if (m.op === 'val.set') vals[a.key] = JSON.parse(a.value); else delete vals[a.key];
        await saveVals(ctx.rec.id);
        for (const p of ports) {                                  // keep other tabs running the same script in step
          if (p !== ctx && p.rec.id === ctx.rec.id) p.port.postMessage({ ev: 'val', key: a.key, value: m.op === 'val.set' ? a.value : undefined, deleted: m.op === 'val.delete' });
        }
        scheduleRefresh(ctx.rec.id);
        return true;
      }
      case 'xhr': case 'download': case 'notify': {
        const emit = (type, data) => { try { ctx.port.postMessage({ id: m.id, ev: m.op === 'xhr' ? 'xhr' : m.op === 'download' ? 'download' : 'notify', type, data }); } catch (e) { /* tab closed */ } };
        const fn = m.op === 'xhr' ? doXhr : m.op === 'download' ? doDownload : doNotify;
        Promise.resolve().then(() => fn(ctx, m.id, a, emit)).catch((e) => emit('error', { error: e.message || String(e) }));
        return undefined;
      }
      case 'xhr.abort': { const c = ctx.aborts.get(a.id); if (c) c.abort(); return true; }
      case 'download.abort': { return true; }
      case 'tab.open': { const t = await chrome.tabs.create({ url: a.url, active: a.active !== false, openerTabId: ctx.tabId }); return { id: t.id }; }
      case 'tab.close': { if (a.id) await chrome.tabs.remove(a.id).catch(() => {}); return true; }
      case 'menu.reg': { if (ctx.tabId != null) menuFor(ctx.tabId).set(menuKey(ctx, a.cmdId), { scriptId: ctx.rec.id, script: ctx.rec.meta.name, cmdId: a.cmdId, name: a.name, frameId: ctx.frameId }); return true; }
      case 'menu.unreg': { if (ctx.tabId != null) menuFor(ctx.tabId).delete(menuKey(ctx, a.cmdId)); return true; }
      case 'ao.items': return listItems(ctx.tabId);
      case 'ao.save': return saveItem(ctx.tabId, a.id, a.opts || {});
      default: throw new Error('Unknown request');
    }
  }

  chrome.runtime.onUserScriptConnect.addListener((port) => {
    const m = /^gm:([^:]+):(.+)$/.exec(port.name || '');
    let ctx = null, disconnected = false;
    const early = [];
    const answer = async (msg) => {
      try {
        const result = await dispatch(ctx, msg);
        if (msg.id && !STREAMING.has(msg.op)) port.postMessage({ id: msg.id, ok: true, result });
      } catch (e) {
        if (msg.id) { try { port.postMessage({ id: msg.id, ok: false, error: e.message || String(e) }); } catch (error) { /* page closed */ } }
      }
    };
    // Port messages can precede storage/worker initialization; subscribe before awaiting it.
    port.onMessage.addListener((msg) => {
      if (disconnected || !msg || typeof msg.op !== 'string') return;
      if (ctx) answer(msg);
      else if (early.length < 100) early.push(msg);
      else port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      disconnected = true; early.length = 0;
      if (!ctx) return;
      ports.delete(ctx);
      for (const c of ctx.aborts.values()) c.abort();
      const mm = ctx.tabId != null && menus.get(ctx.tabId);
      if (mm) for (const [k, v] of mm) if (v.scriptId === ctx.rec.id && v.frameId === ctx.frameId) mm.delete(k);
    });
    ready.then(() => loaded).then(async () => {
      if (disconnected) return;
      const rec = m && find(m[1]);
      if (!rec || rec.chan !== m[2] || !rec.enabled) { port.disconnect(); return; }
      const values = await getVals(rec.id);
      if (disconnected || find(rec.id) !== rec) { port.disconnect(); return; }
      ctx = { port, rec, tabId: port.sender && port.sender.tab ? port.sender.tab.id : null, frameId: port.sender ? port.sender.frameId : 0, url: port.sender ? port.sender.url : '', aborts: new Map() };
      ports.add(ctx);
      port.postMessage({ ev: 'hello', values });
      for (const msg of early.splice(0)) answer(msg);
    }).catch(() => { try { port.disconnect(); } catch (e) { /* page closed */ } });
  });

  /* ------------------------------------------------------------ popup-facing helpers */
  function menuList(tabId) { return [...(menus.get(tabId) || new Map()).values()]; }
  function runMenu(tabId, scriptId, frameId, cmdId) {
    const ctx = [...ports].find((p) => p.tabId === tabId && p.rec.id === scriptId && p.frameId === frameId);
    if (!ctx) throw new Error('That script is no longer connected — reload the page');
    ctx.port.postMessage({ ev: 'menu', cmdId });
    return true;
  }
  const clearTabMenus = (tabId) => menus.delete(tabId);
  const getCode = async (id) => { await hydrate(); const r = find(id); if (!r) throw new Error('Script not found'); return { code: r.code, enabled: r.enabled, updatedAt: r.updatedAt }; };

  return { syncAll, scanBundles, exportBundle, fetchSource, saveScript, listScripts, removeScript, toggleScript, getCode, menuList, runMenu, clearTabMenus, onJobUpdate, available };
}
