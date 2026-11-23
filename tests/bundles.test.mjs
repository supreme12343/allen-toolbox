import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initGM } from '../gm/gm-bg.js';
import { MAX_SCRIPT_BYTES, assertScriptSize, parseMeta } from '../shared/usmeta.js';
import { validateZipPath } from '../shared/zip.js';

const BASE = 'chrome-extension://bundle-test/';
const source = (name = 'Folder script', extra = '', body = 'void 0;') => [
  '// ==UserScript==', '// @name ' + name, '// @version 1.0.0', '// @match https://example.org/*',
  '// @grant none', extra, '// ==/UserScript==', body,
].join('\n');
const entry = (id = 'bundle-one', file = 'one.user.js', enabled = false) => ({ id, file, enabled });
const event = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); }, emit(message) { for (const fn of [...this.listeners]) fn(message); } });

function environment(t, { index = [entry()], files = { 'one.user.js': source() }, initial = {} } = {}) {
  const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch;
  const env = {
    index, files: new Map(Object.entries(files)), remote: new Map(), state: structuredClone(initial), sets: [], fetches: [],
    registrations: new Map(), batches: [], contains: [], userScriptsAvailable: true, failRegister: () => false,
    failUnregister: false, failWorld: false, failSet: () => false, beforeFetch: null, leases: [], releases: [],
  };
  const userscripts = {
    async getScripts({ ids } = {}) {
      if (!env.userScriptsAvailable) throw new Error('Allow User Scripts is off');
      return [...env.registrations.values()].filter((rec) => !ids || ids.includes(rec.id));
    },
    async configureWorld() { if (env.failWorld) throw new Error('World configuration failed'); },
    async unregister({ ids }) {
      if (env.failUnregister) throw new Error('Unregister failed');
      for (const id of ids) env.registrations.delete(id);
    },
    async register(records) {
      env.batches.push(records.map((rec) => rec.id));
      if (env.failRegister(records)) throw new Error('Invalid registration');
      if (records.some((rec) => env.registrations.has(rec.id))) throw new Error('Duplicate registration');
      for (const rec of records) env.registrations.set(rec.id, structuredClone(rec));
    },
    async update(records) { for (const rec of records) env.registrations.set(rec.id, structuredClone(rec)); },
  };
  env.chrome = {
    storage: { local: {
      async get(keys) {
        if (keys == null) return structuredClone(env.state);
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => Object.hasOwn(env.state, key)).map((key) => [key, structuredClone(env.state[key])]));
      },
      async set(data) {
        const snapshot = structuredClone(data);
        env.sets.push(snapshot);
        if (env.failSet(snapshot)) throw new Error('Storage quota exceeded');
        Object.assign(env.state, snapshot);
      },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete env.state[key]; },
    } },
    runtime: { getURL: (path) => BASE + path, getManifest: () => ({ version: '2.0.0' }), onUserScriptConnect: event() },
    userScripts: userscripts,
    permissions: { async contains({ origins }) { env.contains.push(origins); return env.allowedOrigins ? origins.every((origin) => env.allowedOrigins.has(origin)) : true; } },
    notifications: { onClicked: event(), onClosed: event() },
  };
  globalThis.chrome = env.chrome;
  globalThis.fetch = async (url) => {
    const href = String(url);
    env.fetches.push(href);
    if (env.beforeFetch) await env.beforeFetch(href);
    if (href.startsWith(BASE)) {
      const path = href.slice(BASE.length);
      if (path === 'scripts/scripts.json') return new Response(typeof env.index === 'string' ? env.index : JSON.stringify(env.index), { headers: { 'content-type': 'application/json' } });
      if (path.startsWith('scripts/') && env.files.has(path.slice(8))) return new Response(env.files.get(path.slice(8)), { headers: { 'content-type': 'text/javascript' } });
      if (path === 'gm/gm-runtime.js') return new Response('function () { return {}; }');
      if (path === 'gm/gm-relay.js') return new Response('function () {}');
      return new Response('Missing', { status: 404 });
    }
    if (!env.remote.has(href)) throw new TypeError('Failed to fetch');
    const remote = env.remote.get(href);
    return new Response(remote.body, { status: remote.status || 200, headers: { 'content-type': remote.type || 'text/javascript' } });
  };
  env.manager = (extra = {}) => initGM({ ready: Promise.resolve(),
    acquireRequest: async (request) => { env.leases.push(request); return { requestId: request.requestId }; },
    releaseRequest: async (id) => { env.releases.push(id); return { ok: true }; }, ...extra });
  t.after(() => { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; });
  return env;
}

function scriptPort(env, record) {
  const waiting = new Set();
  const port = { name: 'gm:' + record.id + ':' + record.chan, sender: { tab: { id: 4 }, frameId: 0, url: 'https://example.org/page' },
    messages: [], closed: false, onMessage: event(), onDisconnect: event(),
    postMessage(message) {
      if (this.closed) throw new Error('Port closed');
      const copy = JSON.parse(JSON.stringify(message)); this.messages.push(copy);
      for (const listener of [...waiting]) listener(copy);
    },
    disconnect() { this.closed = true; this.onDisconnect.emit(); },
    wait(predicate) {
      const found = this.messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(listener); reject(new Error('Userscript reply did not arrive')); }, 2000);
        const listener = (message) => { if (predicate(message)) { clearTimeout(timer); waiting.delete(listener); resolve(message); } };
        waiting.add(listener);
      });
    },
  };
  env.chrome.runtime.onUserScriptConnect.emit(port);
  return port;
}

test('Unicode code accepted by Save round-trips through a fresh bundled import', async (t) => {
  const env = environment(t, { index: [], files: {} }), gm = env.manager();
  const code = source('Unicode source', '', '/*' + '\u4e2d'.repeat(1_100_000) + '*/\nvoid 0;');
  assert.ok(new TextEncoder().encode(code).byteLength > 3 * 1024 * 1024);
  const saved = await gm.saveScript({ code, enabled: false });
  assert.equal((await gm.getCode(saved.id)).code, code);
  const exported = await gm.exportBundle();
  env.index = exported.index; env.files = new Map(exported.files.map((file) => [file.path.slice(8), file.text]));
  env.state = {}; env.registrations.clear(); env.chrome.runtime.onUserScriptConnect.listeners.clear();
  const recipient = env.manager(), imported = await recipient.listScripts();
  assert.equal(imported.bundles.imported, 1); assert.deepEqual(imported.bundles.errors, []);
  assert.equal((await recipient.getCode(imported.scripts[0].id)).code, code);
  assert.deepEqual(await recipient.exportBundle(), exported);
});

test('source byte limits and remote imports reject oversized code before installation', async (t) => {
  const env = environment(t, { index: [], files: {} }), gm = env.manager();
  const oversized = source('Oversized', '', '/*' + '\u4e2d'.repeat(MAX_SCRIPT_BYTES / 3) + '*/');
  assert.throws(() => assertScriptSize(oversized), /6 MiB UTF-8/);
  await assert.rejects(gm.saveScript({ code: oversized, enabled: false }), /6 MiB UTF-8/);
  assert.equal((await gm.listScripts()).scripts.length, 0);
  const url = 'https://example.org/raw.user.js', code = source('Remote source');
  env.remote.set(url, { body: code });
  assert.equal((await gm.fetchSource(url)).code, code);
  const lease = env.leases.at(-1);
  assert.equal(lease.url, url); assert.equal(lease.method, 'GET'); assert.deepEqual(lease.requestHeaders, []);
  assert.ok(env.releases.includes(lease.requestId));
  env.remote.set(url, { body: ' '.repeat(MAX_SCRIPT_BYTES + 1) });
  await assert.rejects(gm.fetchSource(url), /6 MiB/);
  await assert.rejects(gm.fetchSource('file:///private.js'), /HTTP\(S\)/);
});

test('cold worker buffers authenticated messages, preserves reserved value keys and authorizes menu unregistration', async (t) => {
  const env = environment(t, { index: [], files: {} }), first = env.manager();
  const code = source('Early script').replace('@grant none', '@grant GM_setValue\n// @grant GM_registerMenuCommand');
  const saved = await first.saveScript({ code, enabled: true }), record = env.state.uscripts[0];
  env.state['usval:' + saved.id] = { counter: 4 };
  env.chrome.runtime.onUserScriptConnect.listeners.clear();
  let resume;
  const ready = new Promise((resolve) => { resume = resolve; });
  const gm = env.manager({ ready }), port = scriptPort(env, record);
  try {
    assert.equal(port.onMessage.listeners.size, 1);
    port.onMessage.emit({ id: 1, op: 'val.set', args: { key: 'counter', value: '5' } });
    port.onMessage.emit({ id: 2, op: 'menu.reg', args: { cmdId: 1, name: 'Early command' } });
    await Promise.resolve(); assert.deepEqual(port.messages, []); assert.equal(env.state['usval:' + saved.id].counter, 4);
    resume();
    assert.equal((await port.wait((message) => message.id === 1)).ok, true);
    await port.wait((message) => message.id === 2);
    assert.equal(port.messages[0].ev, 'hello'); assert.equal(port.messages[0].values.counter, 4);
    assert.equal(env.state['usval:' + saved.id].counter, 5); assert.equal(gm.menuList(4).length, 1);
    port.onMessage.emit({ id: 3, op: 'menu.unreg', args: { cmdId: 1 } });
    assert.equal((await port.wait((message) => message.id === 3)).ok, true); assert.equal(gm.menuList(4).length, 0);
    port.onMessage.emit({ id: 4, op: 'val.set', args: { key: '__proto__', value: '{"safe":true}' } });
    await port.wait((message) => message.id === 4);
    assert.equal(Object.hasOwn(env.state['usval:' + saved.id], '__proto__'), true);
    assert.equal({}.safe, undefined);
    await gm.toggleScript(saved.id, false);
    port.onMessage.emit({ id: 5, op: 'val.set', args: { key: 'counter', value: '99' } });
    assert.equal((await port.wait((message) => message.id === 5)).ok, false);
    assert.equal(env.state['usval:' + saved.id].counter, 5);
  } finally { resume(); port.disconnect(); await gm.removeScript(saved.id); }
});

test('GM XHR leases its exact URL and actual method, and releases on success', async (t) => {
  const env = environment(t, { index: [], files: {} }), gm = env.manager();
  const code = source('Network script').replace('@grant none', '@grant GM_xmlhttpRequest');
  await gm.saveScript({ code, enabled: true });
  const port = scriptPort(env, env.state.uscripts[0]); await port.wait((message) => message.ev === 'hello');
  const url = 'https://example.org/api?request=one'; env.remote.set(url, { body: '{"ok":true}', type: 'application/json' });
  port.onMessage.emit({ id: 1, op: 'xhr', args: { url, method: 'POST', page: 'https://example.org/page', headers: { Cookie: 'fixture=one' } } });
  const loaded = await port.wait((message) => message.id === 1 && message.type === 'load');
  assert.equal(loaded.data.status, 200);
  const lease = env.leases.at(-1);
  assert.equal(lease.url, url); assert.equal(lease.method, 'POST');
  assert.equal(lease.requestHeaders.find((header) => header.header === 'cookie').value, 'fixture=one');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(env.releases.includes(lease.requestId)); port.disconnect();
});

test('a GM XHR timeout cancels a queued lease without starting a fetch', async (t) => {
  const env = environment(t, { index: [], files: {} });
  const gm = env.manager({ acquireRequest: async (request) => { env.leases.push(request); return new Promise(() => {}); } });
  await gm.saveScript({ code: source('Queued request').replace('@grant none', '@grant GM_xmlhttpRequest'), enabled: true });
  const port = scriptPort(env, env.state.uscripts[0]); await port.wait((message) => message.ev === 'hello');
  const url = 'https://example.org/queued';
  port.onMessage.emit({ id: 1, op: 'xhr', args: { url, page: 'https://example.org/page', timeout: 20 } });
  await port.wait((message) => message.id === 1 && message.type === 'timeout');
  assert.equal(env.fetches.includes(url), false);
  assert.ok(env.releases.includes(env.leases[0].requestId)); port.disconnect();
});

test('fresh bundles seed once using an atomic record and stable-ID ledger write', async (t) => {
  const env = environment(t), gm = env.manager();
  const result = await gm.listScripts();
  assert.equal(result.scripts.length, 1);
  assert.equal(result.bundles.imported, 1);
  assert.deepEqual(result.bundles.errors, []);
  assert.equal(result.scripts[0].bundleId, 'bundle-one');
  const saved = env.state.uscripts[0];
  assert.equal(saved.enabled, false);
  assert.equal(env.state.usbundles['bundle-one'], saved.id);
  assert.match(saved.id, /^[a-f\d-]{36}$/i);
  assert.ok(env.sets.some((set) => set.uscripts?.some((rec) => rec.id === saved.id) && set.usbundles?.['bundle-one'] === saved.id));
  assert.equal((await gm.scanBundles()).skipped, 1);
  assert.equal(env.state.uscripts.length, 1);
  assert.equal(env.fetches.filter((url) => url === BASE + 'scripts/one.user.js').length, 1);
});

test('the packaged script index references valid sources and preserves declared enabled states', async () => {
  const index = JSON.parse(await readFile(new URL('../scripts/scripts.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(index));
  const ids = new Set();
  for (const entry of index) {
    assert.ok(typeof entry.id === 'string' && entry.id.trim());
    assert.equal(ids.has(entry.id), false); ids.add(entry.id);
    assert.ok(typeof entry.file === 'string' && /\.user\.js$/i.test(entry.file));
    const path = validateZipPath('scripts/' + entry.file);
    assert.ok(path.startsWith('scripts/'));
    assert.ok(entry.enabled === undefined || typeof entry.enabled === 'boolean');
    const code = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assertScriptSize(code); assert.ok(parseMeta(code).name, 'Missing @name in ' + path);
  }
});

test('rescan and worker reload preserve UUID, saved edits, toggle state and values', async (t) => {
  const env = environment(t), gm = env.manager();
  const [installed] = (await gm.listScripts()).scripts;
  const toggled = await gm.toggleScript(installed.id, true);
  const edited = source('User edits', '', 'const savedEdit = true;');
  await gm.saveScript({ id: installed.id, code: edited, enabled: false, expectedUpdatedAt: toggled.updatedAt });
  await env.chrome.storage.local.set({ ['usval:' + installed.id]: { count: 42, token: 'value-secret' } });
  const before = structuredClone(env.state.uscripts[0]);
  env.index[0].enabled = true;
  env.files.set('one.user.js', source('Changed packaged default'));
  assert.equal((await gm.scanBundles()).skipped, 1);
  const reloaded = env.manager();
  const result = await reloaded.listScripts();
  assert.equal(result.bundles.imported, 0);
  assert.equal(result.bundles.skipped, 1);
  assert.equal(result.scripts[0].id, installed.id);
  assert.equal(result.scripts[0].bundleId, 'bundle-one');
  assert.equal(result.scripts[0].enabled, false);
  assert.deepEqual(env.state.uscripts[0], before);
  assert.deepEqual(env.state['usval:' + installed.id], { count: 42, token: 'value-secret' });
  assert.equal((await reloaded.getCode(installed.id)).code, edited);
  env.index = [];
  assert.equal((await reloaded.scanBundles()).imported, 0);
  assert.equal((await reloaded.listScripts()).scripts.length, 1);
  await assert.rejects(reloaded.removeScript(installed.id), /Folder scripts cannot be deleted/);
});

test('legacy deleted folder imports recover with a fresh UUID and their original stable ID', async (t) => {
  const deletedId = 'previously-deleted-uuid';
  const env = environment(t, { initial: { usbundles: { 'bundle-one': deletedId } } }), gm = env.manager();
  assert.equal((await gm.scanBundles()).imported, 1);
  const [restored] = (await gm.listScripts()).scripts;
  assert.notEqual(restored.id, deletedId);
  assert.match(restored.id, /^[a-f\d-]{36}$/i);
  assert.equal(restored.bundleId, 'bundle-one');
  assert.equal(restored.enabled, false);
  assert.equal(env.state.usbundles['bundle-one'], restored.id);
  await gm.removeScript(deletedId);
  await assert.rejects(gm.saveScript({ id: deletedId, code: source('Stale editor') }), /This script was deleted/);
  const reloaded = env.manager();
  assert.equal((await reloaded.listScripts()).scripts[0].id, restored.id);
  assert.equal((await reloaded.scanBundles()).skipped, 1);
  assert.equal((await reloaded.exportBundle()).index[0].id, 'bundle-one');
  env.index.push(entry('bundle-two'));
  const scan = await reloaded.scanBundles();
  assert.equal(scan.imported, 1);
  assert.equal(scan.skipped, 1);
  assert.equal(env.state.uscripts.length, 2);
  assert.notEqual(env.state.usbundles['bundle-two'], restored.id);
  assert.equal(env.state.usbundles['bundle-one'], restored.id);
});

test('folder deletion is rejected before changing storage, values, ports or registrations', async (t) => {
  const env = environment(t, { index: [entry('bundle-one', 'one.user.js', true)],
    files: { 'one.user.js': source().replace('@grant none', '@grant GM_getValue') } }), gm = env.manager();
  const [installed] = (await gm.listScripts()).scripts;
  await env.chrome.storage.local.set({ ['usval:' + installed.id]: { counter: 3 } });
  const port = scriptPort(env, env.state.uscripts[0]);
  try {
    await port.wait((message) => message.ev === 'hello');
    const before = structuredClone(env.state), registrations = structuredClone([...env.registrations]);
    await assert.rejects(gm.removeScript(installed.id), /Folder scripts cannot be deleted.*Disable the script instead/);
    assert.deepEqual(env.state, before);
    assert.deepEqual([...env.registrations], registrations);
    assert.equal(port.closed, false);
  } finally { port.disconnect(); }
});

test('manually saved scripts stay deletable even with identical folder-script source', async (t) => {
  const env = environment(t), gm = env.manager();
  const [folder] = (await gm.listScripts()).scripts;
  const manual = await gm.saveScript({ code: source(), enabled: true });
  assert.equal(manual.bundleId, '');
  await env.chrome.storage.local.set({ ['usval:' + manual.id]: { counter: 4 } });
  await gm.removeScript(manual.id);
  assert.equal(env.state['usval:' + manual.id], undefined);
  assert.deepEqual((await gm.listScripts()).scripts.map((script) => script.id), [folder.id]);
  assert.equal(env.state.usbundles['bundle-one'], folder.id);
  assert.equal((await gm.scanBundles()).imported, 0);
});

test('concurrent hydration/list/scan repairs legacy deletion once without deadlock', async (t) => {
  const env = environment(t, { initial: { usbundles: { 'bundle-one': 'deleted-uuid' } } }), gm = env.manager();
  const results = await Promise.all([gm.listScripts(), gm.listScripts(), gm.scanBundles()]);
  assert.equal(env.state.uscripts.length, 1);
  assert.equal(env.fetches.filter((url) => url === BASE + 'scripts/scripts.json').length, 1);
  assert.equal(env.fetches.filter((url) => url === BASE + 'scripts/one.user.js').length, 1);
  assert.equal(results[0].scripts[0].id, results[1].scripts[0].id);
  assert.equal(results[2].imported, 1);
});

test('malformed index fails open and valid rows still import without traversing paths', async (t) => {
  const env = environment(t, { index: [] }), gm = env.manager();
  const manual = await gm.saveScript({ code: source('Manual'), enabled: false });
  env.index = '{not JSON';
  assert.match((await gm.scanBundles()).errors.join(' '), /scripts\/scripts\.json/);
  assert.equal((await gm.getCode(manual.id)).code, source('Manual'));
  env.index = { scripts: [] };
  assert.match((await gm.scanBundles()).errors.join(' '), /Expected an array/);
  env.index = [entry('good'), entry('duplicate'), entry('duplicate'),
    ...['../evil.user.js', '/evil.user.js', 'a\\evil.user.js', '%2e%2e/evil.user.js', 'https://host/a.user.js', 'one.js', 'a/./one.user.js'].map((file, i) => entry('unsafe-' + i, file)),
    { id: '', file: 'one.user.js' }, { id: 'bad-enabled', file: 'one.user.js', enabled: 'yes' }, null];
  const report = await gm.scanBundles();
  assert.equal(report.imported, 1);
  assert.ok(report.errors.length >= 10);
  assert.match(report.errors.join(' '), /Duplicate bundle id/);
  assert.match(report.errors.join(' '), /Unsafe relative file path/);
  assert.equal(Object.hasOwn(env.state.usbundles, 'duplicate'), false);
  assert.equal(env.state.uscripts.length, 2);
  assert.ok(env.fetches.filter((url) => url.startsWith(BASE + 'scripts/')).every((url) => ['scripts/scripts.json', 'scripts/one.user.js'].includes(url.slice(BASE.length))));
  await gm.toggleScript(manual.id, true);
  assert.equal((await gm.listScripts()).scripts.find((script) => script.id === manual.id).enabled, true);
});

test('prototype-named IDs and null or stale ledger entries recover safely', async (t) => {
  const ledger = JSON.parse('{"__proto__":null,"constructor":"deleted-uuid"}');
  const env = environment(t, { index: [entry('__proto__'), entry('constructor')], initial: { usbundles: ledger } });
  const gm = env.manager(), result = await gm.listScripts();
  assert.equal(result.scripts.length, 2);
  assert.equal(result.bundles.imported, 2);
  assert.equal(result.bundles.skipped, 0);
  assert.deepEqual(result.bundles.errors, []);
  assert.equal(Object.hasOwn(env.state.usbundles, '__proto__'), true);
  assert.equal(env.state.usbundles.__proto__, result.scripts[0].id);
  assert.equal(env.state.usbundles.constructor, result.scripts[1].id);
  assert.notEqual(result.scripts[0].id, result.scripts[1].id);
  assert.equal((await gm.scanBundles()).skipped, 2);
});

test('missing or invalid sources do not consume IDs and can be retried', async (t) => {
  const env = environment(t, { files: {} }), gm = env.manager();
  const first = await gm.scanBundles();
  assert.equal(first.imported, 0);
  assert.match(first.errors.join(' '), /HTTP 404/);
  assert.equal(Object.hasOwn(env.state.usbundles, 'bundle-one'), false);
  env.files.set('one.user.js', 'void 0;');
  assert.match((await gm.scanBundles()).errors.join(' '), /@name/);
  assert.equal(Object.hasOwn(env.state.usbundles, 'bundle-one'), false);
  env.files.set('one.user.js', source());
  assert.equal((await gm.scanBundles()).imported, 1);
});

test('dependency preparation failures leave bundle IDs retryable and explain network/site access', async (t) => {
  const required = 'https://cdn.example.net/lib.js', resource = 'https://images.example.net/banner.txt';
  const env = environment(t, { files: { 'one.user.js': source('Dependencies', '// @require ' + required + '\n// @resource banner ' + resource) } });
  const gm = env.manager();
  let scan = await gm.scanBundles();
  assert.equal(scan.imported, 0);
  assert.match(scan.errors.join(' '), /@require.*Network access and site permission/);
  assert.equal(Object.hasOwn(env.state.usbundles, 'bundle-one'), false);
  env.remote.set(required, { body: 'const dependencyCache = "cached-secret";' });
  scan = await gm.scanBundles();
  assert.equal(scan.imported, 0);
  assert.match(scan.errors.join(' '), /@resource.*Network access and site permission/);
  assert.equal(Object.hasOwn(env.state.usbundles, 'bundle-one'), false);
  env.remote.set(resource, { body: 'resource-secret', type: 'text/plain' });
  assert.equal((await gm.scanBundles()).imported, 1);
  assert.equal(env.state.uscripts[0].requireCode.length, 1);
  assert.equal(env.state.uscripts[0].resources.banner.text, 'resource-secret');
  env.remote.clear();
  const fetches = env.fetches.length;
  assert.equal((await gm.scanBundles()).skipped, 1);
  assert.equal(env.fetches.length - fetches, 1);
});

test('record+ledger storage failure is atomic and does not consume the bundle ID', async (t) => {
  const env = environment(t), gm = env.manager();
  env.failSet = (set) => Object.hasOwn(set.usbundles || {}, 'bundle-one');
  const failed = await gm.scanBundles();
  assert.equal(failed.imported, 0);
  assert.match(failed.errors.join(' '), /Storage quota exceeded/);
  assert.equal(env.state.uscripts.length, 0);
  assert.equal(Object.hasOwn(env.state.usbundles, 'bundle-one'), false);
  env.failSet = () => false;
  assert.equal((await gm.scanBundles()).imported, 1);
  assert.equal(env.state.uscripts.length, 1);
});

test('failed legacy restoration retains its old mapping until an atomic retry succeeds', async (t) => {
  const env = environment(t, { files: {}, initial: { usbundles: { 'bundle-one': 'deleted-uuid' } } }), gm = env.manager();
  assert.match((await gm.scanBundles()).errors.join(' '), /HTTP 404/);
  assert.equal(env.state.usbundles['bundle-one'], 'deleted-uuid');
  env.files.set('one.user.js', source());
  env.failSet = (set) => set.usbundles?.['bundle-one'] !== 'deleted-uuid';
  assert.match((await gm.scanBundles()).errors.join(' '), /Storage quota exceeded/);
  assert.equal(env.state.uscripts.length, 0);
  assert.equal(env.state.usbundles['bundle-one'], 'deleted-uuid');
  env.failSet = () => false;
  assert.equal((await gm.scanBundles()).imported, 1);
  assert.equal(env.state.uscripts.length, 1);
  assert.equal(env.state.usbundles['bundle-one'], env.state.uscripts[0].id);
});

test('storage consumes IDs while userScripts is unavailable and recheck recovers after worker recycle', async (t) => {
  const env = environment(t, { index: [entry('bundle-one', 'one.user.js', true)] }), gm = env.manager();
  env.userScriptsAvailable = false;
  const first = await gm.scanBundles();
  assert.equal(first.imported, 1);
  assert.match(first.errors.join(' '), /Allow User Scripts/);
  const id = env.state.uscripts[0].id;
  assert.equal(env.state.usbundles['bundle-one'], id);
  assert.equal(env.state.usneedsync, true);
  const reloaded = env.manager();
  assert.equal((await reloaded.listScripts()).available, false);
  env.userScriptsAvailable = true;
  const checked = await reloaded.listScripts();
  assert.equal(checked.available, true);
  assert.deepEqual(checked.bundles.errors, []);
  assert.equal(checked.scripts[0].id, id);
  assert.ok(env.registrations.has('ao-us-' + id));
  assert.equal(env.state.usneedsync, false);
  assert.equal(env.state.uscripts.length, 1);
  assert.equal(env.fetches.filter((url) => url === BASE + 'scripts/one.user.js').length, 1);
});

test('missing userScripts API fails open after storage and becomes usable later', async (t) => {
  const env = environment(t, { index: [entry('bundle-one', 'one.user.js', true)] });
  const api = env.chrome.userScripts;
  delete env.chrome.userScripts;
  const gm = env.manager();
  assert.equal((await gm.scanBundles()).imported, 1);
  assert.equal((await gm.listScripts()).available, false);
  env.chrome.userScripts = api;
  assert.equal((await gm.listScripts()).available, true);
  assert.equal(env.registrations.size, 1);
  assert.equal(env.state.usneedsync, false);
});

test('one invalid registration cannot prevent unrelated scripts from registering', async (t) => {
  const env = environment(t, { index: [entry('bad', 'bad.user.js', true), entry('good', 'good.user.js', true)], files: {
    'bad.user.js': source('Bad registration', '', '// REJECT_REGISTRATION'),
    'good.user.js': source('Good registration').replace('@grant none', '@grant GM_getValue'),
  } });
  env.registrations.set('unrelated-extension-script', { id: 'unrelated-extension-script' });
  env.failRegister = (records) => records.some((rec) => rec.js[0].code.includes('REJECT_REGISTRATION'));
  const gm = env.manager(), result = await gm.listScripts();
  const bad = result.scripts.find((script) => script.name === 'Bad registration'), good = result.scripts.find((script) => script.name === 'Good registration');
  assert.match(bad.error, /Registration pending/);
  assert.equal(good.error, '');
  assert.ok(env.registrations.has('ao-us-' + good.id));
  assert.ok(env.registrations.has('ao-us-relay-' + good.id));
  assert.ok(env.registrations.has('unrelated-extension-script'));
  assert.equal(env.state.usneedsync, true);
  assert.ok(env.batches.every((batch) => batch.length <= 2));
  env.failRegister = () => false;
  assert.deepEqual((await gm.listScripts()).bundles.errors, []);
  assert.ok(env.registrations.has('ao-us-' + bad.id));
  assert.equal(env.state.usneedsync, false);
});

test('global registration failures and failed toggles retain retry state until successful recheck', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const env = environment(t, { index: [entry('bundle-one', 'one.user.js', true)] }), gm = env.manager();
  env.failWorld = true;
  assert.match((await gm.scanBundles()).errors.join(' '), /World configuration failed/);
  assert.equal(env.state.usneedsync, true);
  const pending = env.state.uscripts[0];
  const saved = await gm.saveScript({ id: pending.id, code: pending.code, enabled: true, expectedUpdatedAt: pending.updatedAt });
  assert.match(saved.error, /World configuration failed/);
  env.failWorld = false;
  const [installed] = (await gm.listScripts()).scripts;
  assert.ok(env.registrations.has('ao-us-' + installed.id));
  assert.equal(env.state.usneedsync, false);
  env.failUnregister = true;
  const toggle = await gm.toggleScript(installed.id, false);
  assert.equal(toggle.enabled, false);
  assert.match(toggle.error, /Unregister failed/);
  assert.equal(env.state.usneedsync, true);
  env.failUnregister = false;
  const result = await gm.listScripts();
  assert.equal(result.scripts[0].enabled, false);
  assert.equal(env.registrations.size, 0);
  assert.equal(env.state.usneedsync, false);
  assert.equal(logged.mock.callCount(), 2);
});

test('Allow User Scripts off/on clears are detected even with no intervening manager call', async (t) => {
  const env = environment(t, { index: [entry('bundle-one', 'one.user.js', true)] }), gm = env.manager();
  const [installed] = (await gm.listScripts()).scripts;
  assert.equal(env.state.usneedsync, false);
  env.registrations.clear();
  await gm.listScripts();
  assert.ok(env.registrations.has('ao-us-' + installed.id));
});

test('permission summary covers matches, require/resource URLs and connect origins', async (t) => {
  const extra = '// @require https://cdn.example.net/a.js\n// @resource image https://images.example.net/p.png\n// @connect api.example.net\n// @connect self\n// @connect *.other.example.net';
  const env = environment(t, { files: { 'one.user.js': source('Origins', extra) } });
  env.remote.set('https://cdn.example.net/a.js', { body: 'void 0;' });
  env.remote.set('https://images.example.net/p.png', { body: new Uint8Array([1, 2]), type: 'image/png' });
  env.allowedOrigins = new Set(['https://example.org/*']);
  const [script] = (await env.manager().listScripts()).scripts;
  assert.deepEqual(script.origins, ['https://example.org/*', 'https://cdn.example.net/*', 'https://images.example.net/*', '*://api.example.net/*', '*://*.api.example.net/*', '*://example.org/*', '*://*.example.org/*', '*://*.other.example.net/*']);
  assert.equal(script.access, false);
  assert.ok(env.contains.some((origins) => origins.length === 8));
});

test('export uses original seeded IDs/manual UUIDs and includes only SAVED code and enabled state', async (t) => {
  const required = 'https://cdn.example.net/a.js';
  const code = source('Embedded secret', '// @require ' + required, 'const embedded = "code-token-must-be-reviewed";');
  const env = environment(t, { files: { 'one.user.js': code } }), gm = env.manager();
  env.remote.set(required, { body: 'const cache = "dependency-cache-secret";' });
  const [seeded] = (await gm.listScripts()).scripts;
  const manual = await gm.saveScript({ code: source('Manual'), enabled: true });
  await env.chrome.storage.local.set({ ['usval:' + seeded.id]: { value: 'stored-value-secret' },
    'usdraft:one': { code: 'draft-secret' }, cfg: { key: 'config-secret' }, channels: 'channel-secret' });
  const exported = await gm.exportBundle(), serialized = JSON.stringify(exported);
  assert.deepEqual(Object.keys(exported).sort(), ['files', 'index']);
  assert.equal(exported.index[0].id, 'bundle-one');
  assert.equal(exported.index[1].id, manual.id);
  assert.equal(exported.index[0].enabled, false);
  assert.equal(exported.index[1].enabled, true);
  assert.ok(exported.index.every((row) => Object.keys(row).sort().join() === 'enabled,file,id'));
  assert.ok(exported.files.every((file) => Object.keys(file).sort().join() === 'path,text'));
  assert.equal(exported.files[0].text, code);
  assert.match(serialized, /code-token-must-be-reviewed/);
  assert.match(serialized, /cdn\.example\.net/);
  for (const secret of ['stored-value-secret', 'draft-secret', 'dependency-cache-secret', 'config-secret', 'channel-secret', env.state.uscripts[0].chan]) assert.equal(serialized.includes(secret), false);
});

test('a concurrent toggle cannot be overwritten after slow dependency preparation', async (t) => {
  const env = environment(t, { index: [] }), gm = env.manager();
  const manual = await gm.saveScript({ code: source('Original'), enabled: false });
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetching = new Promise((resolve) => { started = resolve; });
  const required = 'https://cdn.example.net/slow.js';
  env.remote.set(required, { body: 'void 0;' });
  env.beforeFetch = async (url) => { if (url === required) { started(); await gate; } };
  const saving = gm.saveScript({ id: manual.id, code: source('New edit', '// @require ' + required), enabled: false, expectedUpdatedAt: manual.updatedAt });
  await fetching;
  await gm.toggleScript(manual.id, true);
  release();
  await assert.rejects(saving, /changed while its dependencies/);
  assert.equal((await gm.getCode(manual.id)).code, source('Original'));
  assert.equal((await gm.getCode(manual.id)).enabled, true);
});
