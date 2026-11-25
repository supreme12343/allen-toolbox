import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createFolderUpdater, prepareFolderPermissionRequest, FOLDER_UPDATER_DB, FOLDER_UPDATER_LOCK, FOLDER_UPDATER_MARKER } from '../shared/folder-updater.js';
import { createZip } from '../shared/zip.js';
import { UPDATE_REPOSITORY, RECOVERY_BOOTSTRAP } from '../shared/update-package.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const bytes = (value) => typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
const assets = ['manifest.json', 'background.js', 'shared/helper.js', 'plugins/plugins.json'];
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const jwk = publicKey.export({ format: 'jwk' });
const publicBytes = encoder.encode(JSON.stringify({ algorithm: 'RSA-SHA256', modulus: Buffer.from(jwk.n, 'base64url').toString('base64'), exponent: 'AQAB' }) + '\n');
const sha = async (data) => Buffer.from(await webcrypto.subtle.digest('SHA-256', data)).toString('hex');
let sequence = 0;
const uuid = () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');
function namedError(name) { const error = new Error('In-memory fixture: ' + name); error.name = name; return error; }

class MemoryDirectory {
  constructor(env, node, name = 'fixture-extension', path = '') { this.kind = 'directory'; this.name = name; this.env = env; this.node = node; this.path = path; }
  allowed() { if (this.env.permission !== 'granted') throw namedError('NotAllowedError'); }
  async queryPermission(options) {
    assert.deepEqual({ ...options }, { mode: 'readwrite' }); this.env.queries++;
    if (this.env.queryError) throw this.env.queryError;
    return this.env.permission;
  }
  requestPermission(options) {
    assert.deepEqual({ ...options }, { mode: 'readwrite' }); this.env.permissionRequests++; this.env.events.push(['permission-request']);
    if (this.env.userActivation != null) assert.equal(this.env.userActivation, true, 'permission must be requested before yielding the click');
    if (this.env.requestError) throw this.env.requestError;
    if (this.env.requestOverride) return this.env.requestOverride();
    if (this.env.requestedPermission) this.env.permission = this.env.requestedPermission;
    return Promise.resolve(this.env.permission);
  }
  async isSameEntry(other) {
    this.env.events.push(['same-entry']);
    if (this.env.sameEntryError) throw this.env.sameEntryError;
    return other?.env === this.env && other.node === this.node;
  }
  async resolve(entry) {
    this.env.events.push(['resolve', entry.path]);
    this.allowed();
    if (this.env.resolveOverride) return this.env.resolveOverride(entry);
    return entry.env === this.env && entry.path.startsWith(this.path) ? entry.path.slice(this.path.length).split('/').filter(Boolean) : null;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    this.allowed(); let node = this.node.entries.get(name);
    if (!node && create) { node = { kind: 'directory', entries: new Map() }; this.node.entries.set(name, node); this.env.events.push(['mkdir', this.path + name]); }
    if (!node) throw namedError('NotFoundError'); if (node.kind !== 'directory') throw namedError('TypeMismatchError');
    return new MemoryDirectory(this.env, node, name, this.path + name + '/');
  }
  async getFileHandle(name, { create = false } = {}) {
    const path = this.path + name; this.env.events.push(['lookup', path, create]);
    this.allowed(); let node = this.node.entries.get(name), created = false;
    if (!node && create) {
      if (this.env.beforeCreate) await this.env.beforeCreate(path);
      node = this.node.entries.get(name);
      if (!node) { node = { kind: 'file', bytes: new Uint8Array() }; this.node.entries.set(name, node); this.env.events.push(['create', path]); created = true; }
    }
    if (!node) throw namedError('NotFoundError'); if (node.kind !== 'file') throw namedError('TypeMismatchError');
    const file = new MemoryFile(this.env, node, name, path);
    if (created && this.env.afterCreate) await this.env.afterCreate(path, file);
    return file;
  }
  async removeEntry(name) {
    this.allowed(); if (!this.node.entries.has(name)) throw namedError('NotFoundError');
    const node = this.node.entries.get(name);
    if (node.kind === 'directory' && node.entries.size) throw namedError('InvalidModificationError');
    this.node.entries.delete(name); this.env.events.push(['remove', this.path + name]);
  }
}

class MemoryFile {
  constructor(env, node, name, path) { this.kind = 'file'; this.name = name; this.env = env; this.node = node; this.path = path; }
  allowed() { if (this.env.permission !== 'granted') throw namedError('NotAllowedError'); }
  async isSameEntry(other) { this.allowed(); return other.env === this.env && other.node === this.node; }
  async getFile() {
    this.allowed(); this.env.events.push(['read', this.path]);
    if (this.node.virtualSize != null) return { size: this.node.virtualSize, arrayBuffer() { throw new Error('size must be checked before reading'); } };
    return new Blob([this.node.bytes]);
  }
  async createWritable(options) {
    this.allowed(); assert.deepEqual({ ...options }, { keepExistingData: false });
    if (!this.path.startsWith('.allen-updater-probe-') && this.path !== FOLDER_UPDATER_MARKER && this.env.requireJournal) {
      const journal = this.env.idb.get('journal'); assert.ok(journal, 'all original bytes must be durably journaled BEFORE a stream opens');
      assert.ok(journal.entries.every((entry) => typeof entry.existed === 'boolean' && (!entry.existed || entry.bytes instanceof Blob)));
      assert.ok(this.env.verifications > 0, 'the ZIP signature must be verified before writing');
    }
    this.env.events.push(['open', this.path]); let pending;
    return {
      write: async (data) => {
        this.allowed(); this.env.events.push(['write', this.path]);
        if (this.env.failWrite?.path === this.path && this.env.failWrite.count-- > 0) throw namedError('OperationError');
        pending = new Uint8Array(data);
      },
      close: async () => {
        this.allowed();
        if (this.env.failClose?.path === this.path && this.env.failClose.count-- > 0) throw namedError('OperationError');
        this.node.bytes = pending || new Uint8Array(); this.env.events.push(['close', this.path]);
        if (this.env.afterClose) await this.env.afterClose(this.path);
      },
      abort: async () => { this.env.events.push(['abort', this.path]); pending = null; },
    };
  }
}

function clone(value) {
  if (value instanceof MemoryDirectory) {
    const handle = new MemoryDirectory(value.env, value.node, value.name, value.path);
    for (const name of ['queryPermission', 'requestPermission', 'isSameEntry']) if (Object.hasOwn(value, name)) handle[name] = value[name];
    return handle;
  }
  if (value instanceof Blob) return value.slice();
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

// Serial, transactional, structured-clone IDB fixture. No filesystem or Chrome storage.
class MemoryIDB {
  constructor() {
    this.stores = new Map(); this.tail = Promise.resolve(); this.opens = []; this.transactions = [];
    this.db = { objectStoreNames: { contains: (name) => this.stores.has(name) }, createObjectStore: (name) => this.stores.set(name, new Map()),
      transaction: (names, mode, options) => this.transaction(names, mode, options), close() {} };
  }
  open(name, version) {
    this.opens.push([name, version]); const request = {};
    queueMicrotask(() => {
      if (this.failOpen) { this.failOpen = false; request.onerror?.(); return; }
      request.result = this.db; if (!this.stores.size) request.onupgradeneeded?.(); request.onsuccess?.();
    });
    return request;
  }
  get(name) { return this.stores.get(name)?.get('singleton'); }
  set(name, value) { this.stores.get(name).set('singleton', clone(value)); }
  transaction(names, mode, options) {
    if (mode === 'readwrite') assert.equal(options?.durability, 'strict');
    this.transactions.push([names, mode]); this.onTransaction?.(names, mode);
    if (this.failTransaction) { this.failTransaction = false; throw namedError('InvalidStateError'); }
    const selected = Array.isArray(names) ? names : [names], operations = []; let aborted = false, working;
    const tx = { abort: () => { aborted = true; }, objectStore: (name) => {
      assert.ok(selected.includes(name));
      const enqueue = (operation, key, value) => {
        const request = {}; operations.push(() => {
          if (operation === 'get') request.result = clone(working.get(name).get(key));
          else if (operation === 'put') {
            if (name === 'journal' && this.failJournal) { this.failJournal = false; throw namedError('QuotaExceededError'); }
            if (name === 'state' && this.failState) { this.failState = false; throw namedError('QuotaExceededError'); }
            working.get(name).set(key, clone(value));
          } else working.get(name).delete(key);
          request.onsuccess?.();
        }); return request;
      };
      return { get: (key) => enqueue('get', key), put: (value, key) => enqueue('put', key, value), delete: (key) => enqueue('delete', key) };
    } };
    const run = async () => {
      working = new Map(selected.map((name) => [name, new Map(this.stores.get(name))]));
      try {
        while (operations.length && !aborted) { operations.shift()(); await Promise.resolve(); }
        if (aborted) throw namedError('AbortError');
        if (mode === 'readwrite') for (const [name, store] of working) this.stores.set(name, store);
        tx.oncomplete?.();
      } catch (error) { tx.error = error; tx.onabort?.(); }
    };
    this.tail = this.tail.then(run); return tx;
  }
}

class MemoryLocks {
  constructor() { this.tail = Promise.resolve(); this.calls = []; this.active = 0; this.pending = 0; }
  request(name, options, callback) {
    assert.equal(name, FOLDER_UPDATER_LOCK); assert.deepEqual({ ...options }, { mode: 'exclusive', ...(options.ifAvailable ? { ifAvailable: true } : {}) }); this.calls.push(name);
    if (options.ifAvailable && (this.active || this.pending)) return Promise.resolve(callback(null));
    this.pending++;
    const run = this.tail.then(async () => {
      this.pending--; assert.equal(this.active++, 0);
      try { return await callback({ name, mode: 'exclusive' }); } finally { this.active--; }
    });
    this.tail = run.catch(() => {}); return run;
  }
}

function fixtureFiles(version = '2.3.0', prerelease = false) {
  return new Map([
    ['manifest.json', bytes(JSON.stringify({ manifest_version: 3, name: 'ALLEN Toolbox', version,
      ...(prerelease ? { version_name: version + ' BETA' } : {}), homepage_url: UPDATE_REPOSITORY, background: { service_worker: 'background.js', type: 'module' } }) + '\n')],
    ['background.js', bytes('import "./shared/helper.js";\n')], ['shared/helper.js', bytes('export const version = "old";\n')],
    ['plugins/plugins.json', bytes('[]')], ['scripts/scripts.json', bytes('[{"id":"seed","file":"seed.user.js","enabled":true}]')],
    ['scripts/seed.user.js', bytes('// old bundled source, not executed\n')], ['shared/update-public-key.json', publicBytes],
    ...RECOVERY_BOOTSTRAP.map((path) => [path, bytes('// frozen rescue bytes: ' + path + '\n')]),
  ]);
}

function memoryFolder(files = fixtureFiles()) {
  const env = { permission: 'granted', permissionRequests: 0, queries: 0, events: [], verifications: 0 };
  const root = new MemoryDirectory(env, { kind: 'directory', entries: new Map() });
  root.nodeAt = (path, create = false) => {
    const parts = path.split('/'); let node = root.node;
    for (const part of parts.slice(0, -1)) {
      if (!node.entries.has(part) && create) node.entries.set(part, { kind: 'directory', entries: new Map() });
      node = node.entries.get(part); if (!node || node.kind !== 'directory') return null;
    }
    return { parent: node, name: parts.at(-1), node: node.entries.get(parts.at(-1)) };
  };
  root.set = (path, data) => { const result = root.nodeAt(path, true); result.parent.entries.set(result.name, { kind: 'file', bytes: bytes(data) }); };
  root.bytes = (path) => { const node = root.nodeAt(path)?.node; return node?.kind === 'file' ? new Uint8Array(node.bytes) : null; };
  root.has = (path) => !!root.nodeAt(path)?.node;
  for (const [path, data] of files) root.set(path, data);
  return root;
}

function releaseIdentity(version = '2.3.1', prerelease = true) {
  const tag = 'v' + version + (prerelease ? '-beta' : ''), filename = 'ALLEN-Toolbox-' + version + (prerelease ? '-BETA' : '') + '.zip';
  const downloadUrl = UPDATE_REPOSITORY + '/releases/download/' + tag + '/' + filename;
  return { version, tag, filename, prerelease, downloadUrl, signatureUrl: downloadUrl + '.sig' };
}

function harness({ root = memoryFolder(), idb = new MemoryIDB(), locks = new MemoryLocks(), manifest } = {}) {
  const requests = [], responses = new Map(), running = manifest || JSON.parse(decoder.decode(root.bytes('manifest.json')));
  const env = root.env; env.idb = idb;
  const cryptography = { randomUUID: uuid, subtle: {
    digest: (...args) => webcrypto.subtle.digest(...args), importKey: (...args) => webcrypto.subtle.importKey(...args),
    verify: async (...args) => { env.verifications++; return webcrypto.subtle.verify(...args); },
  } };
  let reloads = 0, nativeCalls = 0;
  const browser = { runtime: { getManifest: () => running, getURL: (path) => 'chrome-extension://folder-test/' + path,
    reload: () => { reloads++; }, sendNativeMessage: () => { nativeCalls++; throw new Error('native code is forbidden'); },
    sendMessage: () => { throw new Error('background worker is deliberately unavailable'); } },
    storage: { local: { get() { throw new Error('handles must not use Chrome storage'); }, set() { throw new Error('handles must not use Chrome storage'); } },
      session: { async get(key) { assert.equal(key, 'jobs'); return { jobs: [] }; } } },
    downloads: { search: async () => [] } };
  const request = async (url, options) => {
    requests.push([url, options]);
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, url.startsWith('chrome-extension://') ? 'error' : 'follow');
    assert.deepEqual(options.headers, {}); assert.equal(options.referrerPolicy, 'no-referrer');
    if (responses.has(url)) { const value = responses.get(url); return typeof value === 'function' ? value(options) : new Response(value); }
    const prefix = browser.runtime.getURL(''); assert.ok(url.startsWith(prefix), 'no unvalidated external URL may be requested');
    const path = url.slice(prefix.length), data = root.bytes(path);
    return data ? new Response(data) : new Response('', { status: 404 });
  };
  const dependencies = { chrome: browser, crypto: cryptography, fetch: request, indexedDB: idb, locks, assets };
  const core = createFolderUpdater(dependencies);
  const connect = async (options = {}) => {
    const result = await core.connectFolder(root, { singleProfileAcknowledged: true, ...options });
    assert.equal(result.error, '', JSON.stringify(result)); assert.equal(result.state, 'ready');
    requests.length = 0; env.events.length = 0; return result;
  };
  const prepare = async (candidate = fixtureFiles('2.3.1', true), { release = releaseIdentity(), mutate, forged = false } = {}) => {
    let archive = new Uint8Array(await (await createZip([...candidate].map(([path, data]) => ({ path: 'allen-toolbox/' + path, data })))).arrayBuffer());
    if (mutate) archive = mutate(archive) || archive;
    responses.set(release.downloadUrl, archive); responses.set(release.signatureUrl, forged ? new Uint8Array(384) : new Uint8Array(sign('RSA-SHA256', archive, privateKey)));
    return release;
  };
  return { root, env, idb, locks, browser, cryptography, requests, responses, running, core, dependencies, connect, prepare,
    get reloads() { return reloads; }, get nativeCalls() { return nativeCalls; } };
}

function noRuntimeWrites(env) { assert.equal(env.events.filter(([action, path]) => ['open', 'write', 'close', 'remove'].includes(action) && !path.startsWith('.allen-updater-probe-') && path !== FOLDER_UPDATER_MARKER).length, 0); }
function noFolderWrites(env) { assert.equal(env.events.filter(([action]) => ['mkdir', 'create', 'open', 'write', 'close', 'remove', 'abort'].includes(action)).length, 0); }
function requestAccess(prepared, env) {
  env.userActivation = true;
  try { return prepared.request(); } finally { env.userActivation = false; }
}
function assertOriginals(root, original = fixtureFiles()) { for (const [path, data] of original) assert.deepEqual(root.bytes(path), data, path); }

test('unavailable browser exposes the exact sanitized state without storage, permissions or native calls', async () => {
  const core = createFolderUpdater({ chrome: null, indexedDB: null, locks: null }); const state = await core.getFolderUpdateState();
  assert.equal(state.kind, 'folder'); assert.equal(state.permission, 'unavailable'); assert.equal(state.connected, false);
  assert.deepEqual(Object.keys(state).sort(), ['kind', 'connected', 'autoInstall', 'permission', 'state', 'installedVersion', 'folderName', 'message', 'error', 'recoveryPending', 'requiresReload'].sort());
  assert.equal(state.error, 'UNSUPPORTED_BROWSER'); assert.equal(state.requiresReload, false);
});

test('profile identity is created once transactionally and the folder handle is structured-cloned only into IDB', async () => {
  const h = harness(), second = createFolderUpdater(h.dependencies);
  await Promise.all([h.core.getFolderUpdateState(), second.getFolderUpdateState()]); const profile = h.idb.get('state').profileId;
  await h.connect(); const saved = h.idb.get('state');
  assert.equal(saved.profileId, profile); assert.ok(saved.handle instanceof MemoryDirectory); assert.notEqual(saved.handle, h.root);
  assert.ok(h.idb.opens.every(([name, version]) => name === FOLDER_UPDATER_DB && version === 1));
  const state = await h.core.getFolderUpdateState(); assert.equal(state.autoInstall, false); assert.ok(!('handle' in state)); assert.ok(!('baseline' in state));
  assert.equal(h.nativeCalls, 0); assert.equal(h.reloads, 0); assert.equal(h.env.permissionRequests, 0);
});

test('one-profile acknowledgment and an explicit readwrite grant are required before probing or marking', async () => {
  const h = harness(); let state = await h.core.connectFolder(h.root, { singleProfileAcknowledged: false });
  assert.equal(state.error, 'SINGLE_PROFILE_REQUIRED'); assert.equal(h.env.events.length, 0);
  h.env.permission = 'prompt'; state = await h.core.connectFolder(h.root, { singleProfileAcknowledged: true });
  assert.equal(state.error, 'PERMISSION_REQUIRED'); assert.equal(h.env.events.length, 0); assert.equal(h.env.permissionRequests, 0);
  h.env.permission = 'denied'; state = await h.core.connectFolder(h.root, { singleProfileAcknowledged: true });
  assert.equal(state.error, 'PERMISSION_REQUIRED'); assert.equal(h.env.permissionRequests, 0); assert.ok(!h.root.has(FOLDER_UPDATER_MARKER));
});

test('a matching manifest in the WRONG folder fails the runtime nonce probe, cleans it and never writes code or a marker', async () => {
  const h = harness(), wrong = memoryFolder(); const state = await h.core.connectFolder(wrong, { singleProfileAcknowledged: true });
  assert.equal(state.error, 'WRONG_FOLDER'); assert.equal(state.connected, false);
  const created = wrong.env.events.filter(([action]) => action === 'create').map(([, path]) => path);
  assert.equal(created.length, 1); assert.match(created[0], /^\.allen-updater-probe-[a-f\d-]+\.json$/);
  assert.equal(wrong.has(created[0]), false); assert.ok(!wrong.has(FOLDER_UPDATER_MARKER)); noRuntimeWrites(wrong.env);
  assertOriginals(wrong); assert.equal(h.env.permissionRequests, 0);
});

test('a changed/keyed/wrong identity manifest is rejected before any inert probe or marker', async () => {
  for (const patch of [{ version: '2.3.2' }, { name: 'Other' }, { homepage_url: 'https://github.com/other/repo' }, { key: '' }]) {
    const h = harness(), wrong = memoryFolder(); wrong.set('manifest.json', JSON.stringify({ ...JSON.parse(decoder.decode(wrong.bytes('manifest.json'))), ...patch }));
    const state = await h.core.connectFolder(wrong, { singleProfileAcknowledged: true });
    assert.equal(state.error, 'WRONG_FOLDER'); assert.equal(wrong.env.events.filter(([action]) => action === 'create').length, 0);
  }
});

test('same-owner reconnect is allowed, while another profile cannot probe or adopt the connected folder', async () => {
  const h = harness(); await h.connect(); const owner = h.idb.get('state').installationId;
  await h.connect(); assert.equal(h.idb.get('state').installationId, owner);
  const foreign = harness({ root: h.root, idb: new MemoryIDB(), locks: h.locks });
  h.env.events.length = 0; const state = await foreign.core.connectFolder(h.root, { singleProfileAcknowledged: true });
  assert.equal(state.error, 'PROFILE_CONFLICT'); assert.equal(h.env.events.filter(([action]) => ['create', 'write', 'remove'].includes(action)).length, 0);
  assert.equal(h.idb.get('state').installationId, owner);
});

test('busy deferral does not download, open streams, persist a journal or prompt', async () => {
  const h = harness(); await h.connect(); const release = await h.prepare(); const state = await h.core.applyFolderRelease(release, { busy: true });
  assert.equal(state.state, 'deferred'); assert.equal(state.error, 'BUSY'); assert.equal(h.requests.length, 0);
  assert.equal(h.idb.get('journal'), undefined); noRuntimeWrites(h.env); assert.equal(h.env.permissionRequests, 0);
});

test('revoked permission surfaces needs-permission without background prompts or release requests', async () => {
  const h = harness(); await h.connect(); const release = await h.prepare(); h.env.permission = 'prompt';
  assert.equal((await h.core.getFolderUpdateState()).state, 'needs-permission');
  const state = await h.core.applyFolderRelease(release); assert.equal(state.state, 'needs-permission'); assert.equal(state.permission, 'prompt');
  assert.equal(h.requests.length, 0); assert.equal(h.env.permissionRequests, 0); noRuntimeWrites(h.env);
});

test('automatic attempts recheck saved opt-in after lock admission without altering the connection', async () => {
  const h = harness(); await h.connect({ automatic: true }); const release = await h.prepare();
  await h.core.setFolderAutomatic(false);
  const saved = clone(h.idb.get('state'));
  h.env.events.length = 0; h.requests.length = 0;
  const state = await h.core.applyFolderRelease(release, { automatic: true });
  assert.equal(state.error, 'AUTOMATIC_DISABLED'); assert.equal(state.state, 'deferred'); assert.equal(state.connected, true); assert.equal(state.autoInstall, false);
  assert.deepEqual(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), undefined); assert.equal(h.requests.length, 0); noRuntimeWrites(h.env);
});

test('explicit manual installation remains possible when automatic file installation is off', async () => {
  const h = harness(); await h.connect({ automatic: false }); const release = await h.prepare();
  const state = await h.core.applyFolderRelease(release, { automatic: false });
  assert.equal(state.state, 'updated'); assert.equal(state.error, ''); assert.equal(state.autoInstall, false);
});

test('permission preparation is unavailable without a connected, acknowledged handle and its permission/identity APIs', async () => {
  assert.equal(typeof prepareFolderPermissionRequest, 'function'); assert.equal(await prepareFolderPermissionRequest(), null);
  const h = harness(); h.env.userActivation = false;
  assert.equal(await h.core.prepareFolderPermissionRequest(), null); assert.equal(h.env.permissionRequests, 0); noFolderWrites(h.env);
  await h.connect({ automatic: true }); const saved = clone(h.idb.get('state'));
  for (const api of ['queryPermission', 'requestPermission', 'isSameEntry']) {
    const config = clone(saved); config.handle[api] = undefined; h.idb.set('state', config);
    const stored = h.idb.get('state'); assert.equal(await h.core.prepareFolderPermissionRequest(), null);
    assert.equal(h.idb.get('state'), stored); assert.equal(stored.autoInstall, true);
  }
  h.idb.set('state', { ...saved, singleProfileAcknowledged: false });
  assert.equal(await h.core.prepareFolderPermissionRequest(), null);
  const unsupported = createFolderUpdater({ ...h.dependencies, locks: null }); assert.equal(await unsupported.prepareFolderPermissionRequest(), null);
  assert.equal(h.env.permissionRequests, 0); assert.equal(h.requests.length, 0); noFolderWrites(h.env);
});

test('unclicked preparation never prompts and the callback requests permission before any async DB/lock/file work', async () => {
  const h = harness(); await h.connect({ automatic: true }); h.env.permission = 'prompt'; h.env.userActivation = false;
  const prepared = await h.core.prepareFolderPermissionRequest(); assert.deepEqual(Object.keys(prepared), ['request']);
  assert.equal(JSON.stringify(prepared), '{}'); assert.equal(h.env.permissionRequests, 0); assert.equal(h.env.events.length, 0);
  const transactions = h.idb.transactions.length, lockCalls = h.locks.calls.length; h.env.requestedPermission = 'granted';
  const restoring = requestAccess(prepared, h.env);
  assert.equal(h.env.permissionRequests, 1); assert.deepEqual(h.env.events, [['permission-request']]);
  assert.equal(h.idb.transactions.length, transactions); assert.equal(h.locks.calls.length, lockCalls);
  const state = await restoring; assert.equal(state.state, 'ready'); assert.equal(state.permission, 'granted'); assert.equal(state.autoInstall, true);
  assert.deepEqual(Object.keys(state).sort(), Object.keys(await h.core.getFolderUpdateState()).sort());
  assert.ok(!('handle' in state)); assert.ok(!('request' in state)); assert.ok(!('profileId' in state));
  noFolderWrites(h.env); assert.equal(h.requests.length, 0); assert.equal(h.reloads, 0); assert.equal(h.nativeCalls, 0);
});

test('a cloned remembered handle survives contexts and restores revoked write access without reconnect/probe/marker/baseline reset', async () => {
  for (const automatic of [false, true]) {
    const h = harness({ root: memoryFolder(fixtureFiles('2.3.2', true)) }); await h.connect({ automatic });
    const markerBytes = h.root.bytes(FOLDER_UPDATER_MARKER); h.env.permission = 'prompt';
    assert.equal((await h.core.applyFolderRelease()).error, 'PERMISSION_REQUIRED');
    const saved = clone(h.idb.get('state')), restarted = createFolderUpdater(h.dependencies);
    const pending = await restarted.getFolderUpdateState(); assert.equal(pending.connected, true); assert.equal(pending.autoInstall, automatic);
    assert.equal(pending.state, 'needs-permission'); assert.equal(pending.installedVersion, '2.3.2'); assert.equal(h.env.permissionRequests, 0);
    const prepared = await restarted.prepareFolderPermissionRequest(); h.env.requestedPermission = 'granted';
    h.idb.onTransaction = (names, mode) => { if (mode === 'readwrite') assert.equal(h.locks.active, 1, 'DB mutations require the exclusive lock'); };
    const restored = await requestAccess(prepared, h.env), current = h.idb.get('state');
    assert.equal(restored.connected, true); assert.equal(restored.autoInstall, automatic); assert.equal(restored.state, 'ready'); assert.equal(restored.error, '');
    assert.equal(current.profileId, saved.profileId); assert.equal(current.installationId, saved.installationId); assert.equal(current.singleProfileAcknowledged, true);
    assert.deepEqual(current.baseline, saved.baseline); assert.equal(current.markerHash, saved.markerHash); assert.equal(current.installedVersionName, '2.3.2 BETA');
    assert.notEqual(current.handle, h.root); assert.equal(current.handle.node, h.root.node); assert.equal(current.handle.env, h.env);
    assert.deepEqual(h.root.bytes(FOLDER_UPDATER_MARKER), markerBytes); assert.equal(h.idb.get('journal'), undefined);
    assert.equal((await createFolderUpdater(h.dependencies).getFolderUpdateState()).autoInstall, automatic);
    assert.ok(h.idb.opens.every(([name, version]) => name === FOLDER_UPDATER_DB && version === 1));
    assert.deepEqual([...h.idb.stores.keys()].sort(), ['journal', 'state']); noFolderWrites(h.env); assert.equal(h.requests.length, 0);
  }
});

test('denial, cancellation and synchronous/asynchronous permission errors retain connection, automatic opt-in and any journal', async () => {
  for (const pending of [false, true]) {
    const h = pending ? await interrupted({ automatic: true }) : harness(); if (!pending) await h.connect({ automatic: true });
    const saved = h.idb.get('state'), journal = h.idb.get('journal'), markerBytes = h.root.bytes(FOLDER_UPDATER_MARKER);
    h.env.permission = 'prompt'; h.env.events.length = 0; h.requests.length = 0;
    const prepared = await h.core.prepareFolderPermissionRequest();
    for (const outcome of ['denied', 'prompt', 'invalid-reply', 'NotAllowedError', 'AbortError', 'SecurityError', 'OperationError', 'async-error']) {
      h.env.permission = 'prompt'; h.env.requestError = null; h.env.requestOverride = null; h.env.requestedPermission = null;
      if (['denied', 'prompt'].includes(outcome)) h.env.requestedPermission = outcome;
      else if (outcome === 'invalid-reply') h.env.requestOverride = () => Promise.resolve('unexpected');
      else if (outcome === 'async-error') h.env.requestOverride = () => Promise.reject(new Error('private fixture details'));
      else h.env.requestError = namedError(outcome);
      const state = await requestAccess(prepared, h.env);
      assert.equal(state.connected, true); assert.equal(state.autoInstall, true); assert.equal(state.state, pending ? 'needs-recovery' : 'needs-permission');
      assert.equal(state.recoveryPending, pending); assert.notEqual(state.permission, 'granted'); assert.ok(!state.message.includes('private fixture'));
      assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), journal); assert.deepEqual(h.root.bytes(FOLDER_UPDATER_MARKER), markerBytes);
    }
    noFolderWrites(h.env); assert.equal(h.requests.length, 0); assert.equal(h.reloads, 0); assert.equal(h.nativeCalls, 0);
  }
});

test('queryPermission errors and transient IndexedDB failures never erase a durable handle, automatic setting or journal', async () => {
  for (const pending of [false, true]) {
    const h = pending ? await interrupted({ automatic: true }) : harness(); if (!pending) await h.connect({ automatic: true });
    const saved = h.idb.get('state'), journal = h.idb.get('journal'); h.env.events.length = 0; h.requests.length = 0;
    for (const name of ['OperationError', 'NotAllowedError']) {
      h.env.queryError = namedError(name);
      const state = await createFolderUpdater(h.dependencies).getFolderUpdateState();
      assert.equal(state.connected, true); assert.equal(state.autoInstall, true); assert.equal(state.state, pending ? 'needs-recovery' : 'needs-permission');
      assert.equal(state.permission, name === 'NotAllowedError' ? 'denied' : 'unavailable');
      if (name === 'OperationError') assert.equal(await h.core.prepareFolderPermissionRequest(), null);
      assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), journal);
    }
    h.env.queryError = null; h.idb.failTransaction = true;
    const unavailable = await h.core.getFolderUpdateState(); assert.equal(unavailable.error, 'STORAGE_FAILED'); assert.equal(unavailable.recoveryPending, true);
    h.idb.failOpen = true; const restarted = createFolderUpdater(h.dependencies);
    assert.equal((await restarted.getFolderUpdateState()).error, 'STORAGE_FAILED');
    const recovered = await restarted.getFolderUpdateState(); assert.equal(recovered.connected, true); assert.equal(recovered.autoInstall, true);
    assert.equal(recovered.recoveryPending, pending); assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), journal);
    assert.equal(h.env.permissionRequests, 0); assert.equal(h.requests.length, 0); noFolderWrites(h.env);
  }
});

test('a granted reply still requires a fresh permission check before folder verification', async () => {
  for (const pending of [false, true]) for (const mode of ['prompt', 'query-error']) {
    const h = pending ? await interrupted({ automatic: true }) : harness(); if (!pending) await h.connect({ automatic: true });
    const saved = h.idb.get('state'), journal = h.idb.get('journal'); h.env.permission = 'prompt';
    const prepared = await h.core.prepareFolderPermissionRequest(); h.env.events.length = 0; h.requests.length = 0;
    h.env.requestOverride = () => {
      if (mode === 'query-error') h.env.queryError = namedError('OperationError');
      return Promise.resolve('granted');
    };
    const state = await requestAccess(prepared, h.env);
    assert.equal(state.state, pending ? 'needs-recovery' : 'needs-permission'); assert.notEqual(state.permission, 'granted'); assert.equal(state.autoInstall, true);
    assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), journal);
    assert.deepEqual(h.env.events, [['permission-request'], ['same-entry']]); noFolderWrites(h.env); assert.equal(h.requests.length, 0);
  }
});

test('restore DB read/write failures report unknown recovery state and keep the same saved connection for a retry', async () => {
  const h = harness(); await h.connect({ automatic: true }); h.env.permission = 'prompt';
  await h.core.applyFolderRelease(); const saved = h.idb.get('state'), prepared = await h.core.prepareFolderPermissionRequest(); h.env.requestedPermission = 'granted';
  for (const mode of ['read', 'write']) {
    if (mode === 'read') h.idb.failTransaction = true; else h.idb.failState = true;
    const state = await requestAccess(prepared, h.env);
    assert.equal(state.error, 'STORAGE_FAILED'); assert.equal(state.state, 'needs-recovery'); assert.equal(state.recoveryPending, true);
    assert.equal(state.connected, true); assert.equal(state.autoInstall, true); assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), undefined);
  }
  assert.equal((await requestAccess(prepared, h.env)).state, 'ready'); assert.equal(h.idb.get('state').installationId, saved.installationId);
  assert.deepEqual(h.idb.get('state').baseline, saved.baseline); noFolderWrites(h.env); assert.equal(h.requests.length, 0);
  const pending = await interrupted({ automatic: true }), stored = pending.idb.get('state'), journal = pending.idb.get('journal');
  const preparedRecovery = await pending.core.prepareFolderPermissionRequest(); pending.env.requestedPermission = 'granted'; pending.idb.failTransaction = true;
  pending.env.events.length = 0; pending.requests.length = 0;
  assert.equal((await requestAccess(preparedRecovery, pending.env)).error, 'STORAGE_FAILED');
  assert.equal(pending.idb.get('state'), stored); assert.equal(pending.idb.get('journal'), journal); noFolderWrites(pending.env); assert.equal(pending.requests.length, 0);
});

test('stale prepared callbacks cannot adopt an old folder after profile, installation, handle or acknowledgment replacement', async () => {
  for (const change of ['disconnect', 'profile', 'installation', 'handle', 'acknowledgment', 'schema']) {
    const h = harness(); await h.connect({ automatic: true }); const original = clone(h.idb.get('state')), markerBytes = h.root.bytes(FOLDER_UPDATER_MARKER);
    h.env.permission = 'prompt'; const prepared = await h.core.prepareFolderPermissionRequest();
    const replacement = clone(original); let other;
    if (change === 'disconnect') Object.assign(replacement, { handle: null, installationId: null, singleProfileAcknowledged: false, autoInstall: false });
    if (change === 'profile') replacement.profileId = uuid();
    if (change === 'installation') replacement.installationId = uuid();
    if (change === 'acknowledgment') replacement.singleProfileAcknowledged = false;
    if (change === 'schema') replacement.schema = 2;
    if (change === 'handle') {
      other = memoryFolder(); other.set(FOLDER_UPDATER_MARKER, markerBytes); replacement.handle = other;
    }
    h.idb.set('state', replacement); const saved = h.idb.get('state'); h.env.events.length = 0; h.env.requestedPermission = 'granted';
    const state = await requestAccess(prepared, h.env);
    assert.equal(state.error, 'CONNECTION_CHANGED'); assert.equal(state.state, 'error'); assert.equal(h.idb.get('state'), saved);
    assert.equal(state.connected, change !== 'disconnect'); assert.equal(state.autoInstall, change !== 'disconnect');
    assert.deepEqual(h.env.events, [['permission-request']], 'no old-folder identity/read/write work after the stored connection changes');
    assert.deepEqual(h.root.bytes(FOLDER_UPDATER_MARKER), markerBytes); noFolderWrites(h.env); assert.equal(h.requests.length, 0);
    if (other) { assert.equal(other.env.permissionRequests, 0); noFolderWrites(other.env); assert.deepEqual(other.bytes(FOLDER_UPDATER_MARKER), markerBytes); }
  }
});

test('changes while the permission prompt is pending are rechecked and current automatic preferences are never overwritten', async () => {
  for (const change of ['installation', 'automatic']) {
    const h = harness(); await h.connect({ automatic: true }); h.env.permission = 'prompt';
    const prepared = await h.core.prepareFolderPermissionRequest(); let grant;
    h.env.requestOverride = () => new Promise((resolve) => { grant = resolve; });
    const restoring = requestAccess(prepared, h.env); assert.equal(h.env.permissionRequests, 1); assert.deepEqual(h.env.events, [['permission-request']]);
    const config = clone(h.idb.get('state'));
    if (change === 'installation') config.installationId = uuid(); else config.autoInstall = false;
    h.idb.set('state', config); const saved = h.idb.get('state'); h.env.permission = 'granted'; grant('granted');
    const state = await restoring; assert.equal(h.idb.get('state'), saved);
    if (change === 'installation') { assert.equal(state.error, 'CONNECTION_CHANGED'); assert.deepEqual(h.env.events, [['permission-request']]); }
    else { assert.equal(state.state, 'ready'); assert.equal(state.autoInstall, false); assert.equal(saved.autoInstall, false); }
    noFolderWrites(h.env); assert.equal(h.requests.length, 0);
  }
});

test('permission restoration detects local tracked edits and changed/missing/foreign markers without writing extension or ownership files', async () => {
  for (const change of ['tracked-file', 'manifest', 'foreign-marker', 'changed-marker', 'missing-marker']) {
    const h = harness(); await h.connect({ automatic: true }); const saved = clone(h.idb.get('state'));
    h.env.permission = 'prompt'; const prepared = await h.core.prepareFolderPermissionRequest();
    if (change === 'tracked-file') h.root.set('shared/helper.js', 'private local edit');
    if (change === 'manifest') h.root.set('manifest.json', JSON.stringify({ ...h.running, version_name: 'private manifest edit' }));
    if (change === 'foreign-marker') h.root.set(FOLDER_UPDATER_MARKER, JSON.stringify({ schema: 1, profileId: uuid(), installationId: uuid() }));
    if (change === 'changed-marker') h.root.set(FOLDER_UPDATER_MARKER, JSON.stringify(JSON.parse(decoder.decode(h.root.bytes(FOLDER_UPDATER_MARKER))), null, 2));
    if (change === 'missing-marker') h.root.node.entries.delete(FOLDER_UPDATER_MARKER);
    const markerBytes = h.root.bytes(FOLDER_UPDATER_MARKER), tracked = h.root.bytes('shared/helper.js'), manifest = h.root.bytes('manifest.json');
    h.env.requestedPermission = 'granted';
    h.idb.onTransaction = (names, mode) => { if (mode === 'readwrite') assert.equal(h.locks.active, 1); };
    const state = await requestAccess(prepared, h.env), expected = ['tracked-file', 'manifest'].includes(change) ? 'LOCAL_CHANGES' :
      change === 'missing-marker' ? 'FOLDER_MOVED' : 'PROFILE_CONFLICT';
    assert.equal(state.error, expected); assert.equal(state.state, 'error'); assert.equal(state.autoInstall, true); assert.equal(state.connected, true);
    assert.equal(h.idb.get('state').profileId, saved.profileId); assert.equal(h.idb.get('state').installationId, saved.installationId);
    assert.deepEqual(h.idb.get('state').baseline, saved.baseline); assert.equal(h.idb.get('state').markerHash, saved.markerHash);
    assert.deepEqual(h.root.bytes(FOLDER_UPDATER_MARKER), markerBytes); assert.deepEqual(h.root.bytes('shared/helper.js'), tracked); assert.deepEqual(h.root.bytes('manifest.json'), manifest);
    assert.equal((await h.core.getFolderUpdateState()).error, expected);
    if (!['tracked-file', 'manifest'].includes(change)) assert.equal(await h.core.prepareFolderPermissionRequest(), null);
    noFolderWrites(h.env); assert.equal(h.requests.length, 0); assert.equal(h.idb.get('journal'), undefined);
  }
});

test('already-readable missing/foreign ownership makes preparation unavailable without losing the remembered connection', async () => {
  for (const missing of [false, true]) {
    const h = harness(); await h.connect({ automatic: true }); const saved = h.idb.get('state');
    if (missing) h.root.node.entries.delete(FOLDER_UPDATER_MARKER);
    else h.root.set(FOLDER_UPDATER_MARKER, JSON.stringify({ schema: 1, profileId: uuid(), installationId: uuid() }));
    assert.equal(await h.core.prepareFolderPermissionRequest(), null); assert.equal(h.env.permissionRequests, 0); assert.equal(h.idb.get('state'), saved);
    assert.equal((await h.core.getFolderUpdateState()).error, missing ? 'FOLDER_MOVED' : 'PROFILE_CONFLICT');
    assert.equal(h.idb.get('state'), saved); assert.equal(saved.autoInstall, true); noFolderWrites(h.env);
  }
});

test('transient folder verification failures are not misreported as a moved folder and retain the connection for retry', async () => {
  const h = harness(); await h.connect({ automatic: true }); const saved = h.idb.get('state'); h.env.permission = 'prompt';
  const prepared = await h.core.prepareFolderPermissionRequest(); h.env.requestedPermission = 'granted';
  h.env.resolveOverride = () => { throw namedError('OperationError'); };
  const state = await requestAccess(prepared, h.env); assert.equal(state.error, 'FOLDER_CHECK_FAILED'); assert.equal(state.state, 'error'); assert.equal(state.autoInstall, true);
  assert.equal((await h.core.getFolderUpdateState()).error, 'FOLDER_CHECK_FAILED'); assert.equal(h.idb.get('state'), saved);
  h.env.resolveOverride = null; assert.equal((await h.core.getFolderUpdateState()).state, 'ready');
  assert.equal((await requestAccess(prepared, h.env)).state, 'ready'); assert.equal(h.idb.get('state'), saved); noFolderWrites(h.env); assert.equal(h.requests.length, 0);
});

test('grants with a pending journal validate durable baseline/ownership but never clear or restore the journal or local changes', async () => {
  for (const mode of ['valid', 'local-changes', 'invalid-baseline', 'foreign-owner']) {
    const h = await interrupted({ automatic: true });
    if (mode === 'local-changes') {
      h.idb.set('state', { ...h.idb.get('state'), lastState: 'error', lastError: 'LOCAL_CHANGES' });
      h.root.set('background.js', 'local edit retained during recovery');
    }
    if (mode === 'invalid-baseline') {
      const journal = clone(h.idb.get('journal')); journal.entries = journal.entries.filter((entry) => entry.path !== 'shared/helper.js'); h.idb.set('journal', journal);
    }
    if (mode === 'foreign-owner') h.root.set(FOLDER_UPDATER_MARKER, JSON.stringify({ schema: 1, profileId: uuid(), installationId: uuid() }));
    const saved = h.idb.get('state'), journal = h.idb.get('journal'), helper = h.root.bytes('shared/helper.js'), background = h.root.bytes('background.js');
    h.env.events.length = 0; h.requests.length = 0; const prepared = await createFolderUpdater(h.dependencies).prepareFolderPermissionRequest();
    h.env.requestedPermission = 'granted'; const transactions = h.idb.transactions.length;
    const state = await requestAccess(prepared, h.env);
    assert.equal(state.state, 'needs-recovery'); assert.equal(state.recoveryPending, true); assert.equal(state.connected, true); assert.equal(state.autoInstall, true);
    if (mode === 'local-changes') { assert.equal(state.error, 'LOCAL_CHANGES'); assert.match(state.message, /explicit restore/); }
    if (mode === 'invalid-baseline') assert.equal(state.error, 'RECOVERY_INVALID');
    if (mode === 'foreign-owner') assert.equal(state.error, 'PROFILE_CONFLICT');
    assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), journal);
    assert.ok(h.idb.transactions.slice(transactions).every(([, mode]) => mode === 'readonly'));
    assert.deepEqual(h.root.bytes('shared/helper.js'), helper); assert.deepEqual(h.root.bytes('background.js'), background);
    noFolderWrites(h.env); assert.equal(h.requests.length, 0); assert.equal(h.reloads, 0);
  }
});

test('permission grants alone never clear an existing local-change or write-failure error, even with matching live bytes', async () => {
  for (const code of ['LOCAL_CHANGES', 'WRITE_FAILED']) {
    const h = harness(); await h.connect({ automatic: true }); h.idb.set('state', { ...h.idb.get('state'), lastState: 'error', lastError: code });
    const saved = h.idb.get('state'); h.env.permission = 'prompt'; const prepared = await h.core.prepareFolderPermissionRequest(); h.env.requestedPermission = 'granted';
    const state = await requestAccess(prepared, h.env); assert.equal(state.error, code); assert.equal(state.state, 'error'); assert.equal(state.autoInstall, true);
    assert.equal(h.idb.get('state'), saved); assertOriginals(h.root); noFolderWrites(h.env);
  }
});

test('repeated and cross-context permission restoration is idempotent and never creates an installation/update', async () => {
  const h = harness(); await h.connect({ automatic: true }); const saved = h.idb.get('state'), second = createFolderUpdater(h.dependencies);
  h.env.permission = 'prompt'; const first = await h.core.prepareFolderPermissionRequest(), other = await second.prepareFolderPermissionRequest();
  h.env.requestedPermission = 'granted';
  const concurrent = await Promise.all([requestAccess(first, h.env), requestAccess(other, h.env)]);
  assert.ok(concurrent.some((state) => state.state === 'ready'));
  assert.ok(concurrent.every((state) => state.state === 'ready' || state.state === 'deferred' && state.error === 'BUSY' && state.recoveryPending));
  const restored = await requestAccess(first, h.env); assert.equal(restored.state, 'ready');
  assert.deepEqual(await requestAccess(other, h.env), restored); assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), undefined);
  noFolderWrites(h.env); assert.equal(h.requests.length, 0); assert.equal(h.reloads, 0); assert.equal(h.nativeCalls, 0);
});

test('a permission grant returns safe BUSY without DB/file work rather than waiting behind an active updater lock', async () => {
  const h = harness(); await h.connect({ automatic: true }); const prepared = await h.core.prepareFolderPermissionRequest(), saved = h.idb.get('state');
  const release = await h.prepare(), archive = h.responses.get(release.downloadUrl); let resume, started, timer;
  const fetching = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { resume = resolve; });
  h.responses.set(release.downloadUrl, async () => { started(); await gate; return new Response(archive); });
  const installing = h.core.applyFolderRelease(release); await fetching; const transactions = h.idb.transactions.length;
  try {
    const state = await Promise.race([requestAccess(prepared, h.env), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('permission restoration must not wait for the held updater lock')), 2000);
    })]);
    assert.equal(state.state, 'deferred'); assert.equal(state.error, 'BUSY'); assert.equal(state.recoveryPending, true);
    assert.equal(state.connected, true); assert.equal(state.autoInstall, true); assert.equal(state.permission, 'unavailable');
    assert.equal(h.idb.transactions.length, transactions); assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), undefined);
    noFolderWrites(h.env); assert.equal(h.env.permissionRequests, 1);
  } finally { clearTimeout(timer); resume(); await installing; }
});

test('a failed lock after permission reports uncertainty without changing a stored connection or recovery journal', async () => {
  const h = await interrupted({ automatic: true }), saved = h.idb.get('state'), journal = h.idb.get('journal');
  const prepared = await h.core.prepareFolderPermissionRequest(); h.env.requestedPermission = 'granted'; h.env.events.length = 0; h.requests.length = 0;
  h.locks.request = () => { throw namedError('InvalidStateError'); };
  const state = await requestAccess(prepared, h.env); assert.equal(state.state, 'deferred'); assert.equal(state.error, 'BUSY'); assert.equal(state.recoveryPending, true);
  assert.equal(state.autoInstall, true); assert.equal(h.idb.get('state'), saved); assert.equal(h.idb.get('journal'), journal);
  assert.deepEqual(h.env.events, [['permission-request']]); noFolderWrites(h.env); assert.equal(h.requests.length, 0);
});

test('only exact newer official stable/BETA identities and signature URLs may be fetched', async () => {
  const h = harness(); await h.connect(); const correct = releaseIdentity();
  for (const patch of [{ tag: 'v2.3.1' }, { filename: 'ALLEN-Toolbox-2.3.1.zip' }, { prerelease: false },
    { downloadUrl: correct.downloadUrl.replace('supreme12343', 'someone-else') }, { signatureUrl: 'https://example.com/file.sig' },
    { version: '2.03.1' }]) {
    const state = await h.core.applyFolderRelease({ ...correct, ...patch }); assert.equal(state.error, 'RELEASE_INVALID');
  }
  assert.equal((await h.core.applyFolderRelease(releaseIdentity('2.3.0', false))).error, 'UPDATE_NOT_NEWER');
  assert.equal(h.requests.length, 0); noRuntimeWrites(h.env); assertOriginals(h.root);
});

test('a forged signature rejects even a malicious raw ZIP BEFORE unzip or any code write', async () => {
  const h = harness(); await h.connect(); const release = await h.prepare(undefined, { forged: true, mutate: () => new Uint8Array(22) });
  const state = await h.core.applyFolderRelease(release);
  assert.equal(state.error, 'SIGNATURE_INVALID'); assert.equal(h.env.verifications, 1); assert.equal(h.idb.get('journal'), undefined);
  noRuntimeWrites(h.env); assertOriginals(h.root);
});

test('a validly signed public-key change, CRC corruption or traversal package still cannot write', async () => {
  for (const kind of ['key', 'crc', 'traversal']) {
    const h = harness(); await h.connect(); const candidate = fixtureFiles('2.3.1', true);
    if (kind === 'key') candidate.set('shared/update-public-key.json', bytes('{"not":"the pinned key"}'));
    if (kind === 'traversal') candidate.set('xx/evil.js', bytes('inert hostile path fixture'));
    const release = await h.prepare(candidate, { mutate: kind === 'crc' ? (zip) => { const view = new DataView(zip.buffer); zip[30 + view.getUint16(26, true)] ^= 1; } :
      kind === 'traversal' ? (zip) => {
        const from = bytes('allen-toolbox/xx/evil.js'), to = bytes('allen-toolbox/../evil.js'); assert.equal(from.length, to.length);
        for (let offset = 0; offset <= zip.length - from.length; offset++) if (from.every((byte, index) => zip[offset + index] === byte)) zip.set(to, offset);
      } : undefined });
    const state = await h.core.applyFolderRelease(release);
    assert.equal(state.error, kind === 'key' ? 'PUBLIC_KEY_CHANGED' : kind === 'crc' ? 'PACKAGE_CRC' : 'PACKAGE_PATH');
    assert.equal(h.env.verifications, 1); assert.equal(h.idb.get('journal'), undefined); noRuntimeWrites(h.env); assertOriginals(h.root);
  }
});

test('local tracked edits and new-file collisions abort without overwriting user bytes', async () => {
  for (const collision of [false, true]) {
    const h = harness(); await h.connect(); const candidate = fixtureFiles('2.3.1', true);
    if (collision) { candidate.set('shared/new.js', bytes('export const candidate = 1;')); candidate.set('background.js', bytes('import "./shared/new.js";\n')); h.root.set('shared/new.js', 'private local data'); }
    else h.root.set('shared/helper.js', 'private local edit');
    const release = await h.prepare(candidate), state = await h.core.applyFolderRelease(release);
    assert.equal(state.error, 'LOCAL_CHANGES'); assert.equal(h.idb.get('journal'), undefined); noRuntimeWrites(h.env);
    assert.equal(decoder.decode(h.root.bytes(collision ? 'shared/new.js' : 'shared/helper.js')), collision ? 'private local data' : 'private local edit');
    assert.ok(!JSON.stringify(state).includes('private local'));
  }
});

test('durable originals precede every stream, dependencies precede entrypoints and the manifest is written LAST', async () => {
  const h = harness(); await h.connect(); h.env.requireJournal = true; h.root.set('notes/user.txt', 'untouched unknown file');
  const candidate = fixtureFiles('2.3.1', true); candidate.set('shared/helper.js', bytes('export const version = "new";\n'));
  candidate.set('background.js', bytes('import "./shared/helper.js";\n// new entrypoint\n'));
  const state = await h.core.applyFolderRelease(await h.prepare(candidate));
  assert.equal(state.state, 'updated'); assert.equal(state.installedVersion, '2.3.1'); assert.equal(state.requiresReload, true); assert.equal(state.recoveryPending, false);
  const closed = h.env.events.filter(([action]) => action === 'close').map(([, path]) => path);
  assert.deepEqual(closed, ['shared/helper.js', 'background.js', 'manifest.json']); assert.equal(h.idb.get('journal'), undefined);
  assert.equal(decoder.decode(h.root.bytes('notes/user.txt')), 'untouched unknown file'); assert.equal(h.nativeCalls, 0); assert.equal(h.reloads, 0);
  const restarted = createFolderUpdater(h.dependencies); assert.equal((await restarted.getFolderUpdateState()).requiresReload, true);
  assert.equal((await restarted.applyFolderRelease(releaseIdentity('2.3.2', true))).error, 'RELOAD_REQUIRED');
});

test('all folder updates freeze rescue files; recovery-bootstrap changes require manual extraction', async () => {
  for (const automatic of [true, false]) {
    const h = harness(); await h.connect(); assert.equal((await h.core.setFolderAutomatic(automatic)).autoInstall, automatic);
    const candidate = fixtureFiles('2.3.1', true); candidate.set('popup/updater-recovery.js', bytes('// changed standalone rescue fixture\n'));
    const state = await h.core.applyFolderRelease(await h.prepare(candidate));
    assert.equal(state.error, 'RECOVERY_BOOTSTRAP_CHANGED');
    noRuntimeWrites(h.env); assert.equal(h.idb.get('journal'), undefined);
  }
});

test('write/close failures abort streams and verified rollback removes only newly introduced files', async () => {
  for (const close of [false, true]) {
    const h = harness(); await h.connect(); h.root.set('unknown.txt', 'preserved unknown'); h.env.requireJournal = true;
    const candidate = fixtureFiles('2.3.1', true); candidate.set('shared/new.js', bytes('export const newFile = 1;\n'));
    candidate.set('background.js', bytes('import "./shared/helper.js";\nimport "./shared/new.js";\n'));
    if (close) h.env.failClose = { path: 'background.js', count: 1 }; else h.env.failWrite = { path: 'background.js', count: 1 };
    const state = await h.core.applyFolderRelease(await h.prepare(candidate));
    assert.equal(state.error, 'WRITE_FAILED'); assert.equal(state.recoveryPending, false); assert.equal(h.idb.get('journal'), undefined);
    assert.equal(h.root.has('shared/new.js'), false); assert.equal(decoder.decode(h.root.bytes('unknown.txt')), 'preserved unknown');
    assertOriginals(h.root); assert.ok(h.env.events.some(([action, path]) => action === 'abort' && path === 'background.js')); assert.equal(h.reloads, 0);
  }
});

test('failure to persist the complete journal prevents all writes', async () => {
  const h = harness(); await h.connect(); h.idb.failJournal = true;
  const state = await h.core.applyFolderRelease(await h.prepare());
  assert.equal(state.error, 'JOURNAL_STORAGE_FAILED'); assert.equal(h.idb.get('journal'), undefined); noRuntimeWrites(h.env); assertOriginals(h.root);
});

test('an interrupted transaction persists across contexts and cannot update/forget until explicit verified recovery', async () => {
  const h = harness(); await h.connect(); h.env.requireJournal = true;
  const candidate = fixtureFiles('2.3.1', true); candidate.set('shared/helper.js', bytes('export const version = "interrupted";\n'));
  h.env.afterClose = (path) => { if (path === 'shared/helper.js') { h.env.afterClose = null; h.env.permission = 'prompt'; } };
  const state = await h.core.applyFolderRelease(await h.prepare(candidate)); assert.equal(state.recoveryPending, true); assert.equal(state.state, 'needs-recovery');
  const saved = h.idb.get('journal'); assert.ok(saved.entries.every((entry) => !entry.existed || entry.bytes instanceof Blob)); assert.equal(saved.fromVersion, '2.3.0');
  const restarted = createFolderUpdater(h.dependencies); assert.equal((await restarted.getFolderUpdateState()).state, 'needs-recovery');
  assert.equal((await restarted.recoverFolder({ busy: true })).state, 'deferred'); assert.equal((await restarted.forgetFolder()).recoveryPending, true);
  assert.equal((await restarted.applyFolderRelease(releaseIdentity('2.3.2', true))).recoveryPending, true); assert.ok(h.idb.get('journal'));
  h.env.permission = 'granted'; const recovered = await restarted.recoverFolder(); assert.equal(recovered.recoveryPending, false); assert.equal(recovered.installedVersion, '2.3.0');
  assert.equal(h.idb.get('journal'), undefined); assertOriginals(h.root); assert.equal(h.env.permissionRequests, 0); assert.equal(h.reloads, 0);
});

test('revoked or foreign ownership during failure retains the journal and blocks rollback writes', async () => {
  const h = harness(); await h.connect(); const candidate = fixtureFiles('2.3.1', true); candidate.set('shared/helper.js', bytes('export const changed = 1;'));
  h.env.afterClose = (path) => { if (path === 'shared/helper.js') { h.env.afterClose = null; h.root.set(FOLDER_UPDATER_MARKER, JSON.stringify({ schema: 1, profileId: uuid(), installationId: uuid() })); } };
  const state = await h.core.applyFolderRelease(await h.prepare(candidate)); assert.equal(state.recoveryPending, true);
  h.env.events.length = 0; assert.equal((await h.core.recoverFolder()).recoveryPending, true); noRuntimeWrites(h.env); assert.ok(h.idb.get('journal'));
});

test('all cross-context writers share one exclusive lock and duplicate apply intent cannot overwrite twice', async () => {
  const h = harness(); await h.connect(); const second = createFolderUpdater(h.dependencies), release = await h.prepare();
  const results = await Promise.all([h.core.applyFolderRelease(release), second.applyFolderRelease(release)]);
  assert.equal(results[0].state, 'updated'); assert.equal(results[1].error, 'RELOAD_REQUIRED');
  assert.equal(h.env.events.filter(([action, path]) => action === 'close' && path === 'manifest.json').length, 1);
  assert.ok(h.locks.calls.length >= 3); assert.equal(h.locks.active, 0);
});

test('forget preserves profile identity and confirmed reload need; it never deletes unknown files or foreign markers', async () => {
  const h = harness(); await h.connect(); const profile = h.idb.get('state').profileId; h.root.set('unknown.txt', 'do not touch');
  await h.core.applyFolderRelease(await h.prepare()); const state = await h.core.forgetFolder();
  assert.equal(state.connected, false); assert.equal(state.requiresReload, true); assert.equal(state.installedVersion, '2.3.1');
  assert.equal(h.idb.get('state').profileId, profile); assert.equal(h.root.has(FOLDER_UPDATER_MARKER), false); assert.equal(decoder.decode(h.root.bytes('unknown.txt')), 'do not touch');
  assert.equal(h.reloads, 0);
  const other = harness(); await other.connect(); const foreign = bytes(JSON.stringify({ schema: 1, profileId: uuid(), installationId: uuid() })); other.root.set(FOLDER_UPDATER_MARKER, foreign);
  assert.equal((await other.core.forgetFolder()).connected, false); assert.deepEqual(other.root.bytes(FOLDER_UPDATER_MARKER), foreign);
});

test('never-connected state does not fabricate a reload after manual version changes, and confirmed disconnect reload is acknowledged once', async () => {
  const h = harness(); await h.core.getFolderUpdateState(); h.running.version = '2.3.1'; h.running.version_name = '2.3.1 BETA';
  assert.equal((await createFolderUpdater(h.dependencies).getFolderUpdateState()).requiresReload, false);
  const confirmed = harness(); await confirmed.connect(); await confirmed.core.applyFolderRelease(await confirmed.prepare()); await confirmed.core.forgetFolder();
  assert.equal(confirmed.idb.get('state').reloadPending, true);
  confirmed.running.version = '2.3.1'; confirmed.running.version_name = '2.3.1 BETA';
  assert.equal((await createFolderUpdater(confirmed.dependencies).getFolderUpdateState()).requiresReload, false); assert.equal(confirmed.idb.get('state').reloadPending, false);
  confirmed.running.version = '2.3.2';
  assert.equal((await createFolderUpdater(confirmed.dependencies).getFolderUpdateState()).requiresReload, false);
});

test('obsolete indexed sources are left in the folder, never deleted or reclassified as new baseline files', async () => {
  const h = harness(); await h.connect(); const candidate = fixtureFiles('2.3.1', true);
  candidate.delete('scripts/seed.user.js'); candidate.set('scripts/scripts.json', bytes('[]'));
  const state = await h.core.applyFolderRelease(await h.prepare(candidate)); assert.equal(state.state, 'updated');
  assert.equal(h.root.has('scripts/seed.user.js'), true); assert.ok(!Object.hasOwn(h.idb.get('state').baseline, 'scripts/seed.user.js'));
  assert.ok(!h.env.events.some(([action, path]) => action === 'remove' && path === 'scripts/seed.user.js'));
});

test('the journal includes ALL baseline originals, even an obsolete source removed from the next script index', async () => {
  const h = harness(); await h.connect(); const candidate = fixtureFiles('2.3.1', true);
  candidate.delete('scripts/seed.user.js'); candidate.set('scripts/scripts.json', bytes('[]')); candidate.set('shared/helper.js', bytes('export const newer = 1;'));
  h.env.afterClose = (path) => { if (path === 'shared/helper.js') { h.env.afterClose = null; h.env.permission = 'prompt'; } };
  assert.equal((await h.core.applyFolderRelease(await h.prepare(candidate))).recoveryPending, true);
  const old = h.idb.get('journal').entries.find((entry) => entry.path === 'scripts/seed.user.js'); assert.ok(old?.existed); assert.ok(old.bytes instanceof Blob);
  assert.deepEqual(new Uint8Array(await old.bytes.arrayBuffer()), fixtureFiles().get('scripts/seed.user.js'));
  h.env.permission = 'granted'; assert.equal((await h.core.recoverFolder()).recoveryPending, false); assertOriginals(h.root);
});

test('unreadable IndexedDB never falsely confirms an empty journal or reopens admission', async () => {
  const h = harness(), broken = { open() { const request = {}; queueMicrotask(() => request.onerror?.()); return request; } };
  const core = createFolderUpdater({ ...h.dependencies, indexedDB: broken }); const state = await core.getFolderUpdateState();
  assert.equal(state.error, 'STORAGE_FAILED'); assert.equal(state.state, 'needs-recovery'); assert.equal(state.recoveryPending, true); assert.equal(state.permission, 'unavailable');
  assert.equal(state.connected, false); assert.equal(h.reloads, 0); noRuntimeWrites(h.env);
});

test('BETA-to-stable promotion is newer even at the same numeric version and requires reload on version_name change', async () => {
  const h = harness({ root: memoryFolder(fixtureFiles('2.3.1', true)) }); await h.connect();
  const release = await h.prepare(fixtureFiles('2.3.1', false), { release: releaseIdentity('2.3.1', false) });
  const state = await h.core.applyFolderRelease(release); assert.equal(state.state, 'updated'); assert.equal(state.installedVersion, '2.3.1'); assert.equal(state.requiresReload, true);
  assert.equal(h.idb.get('state').installedVersionName, ''); assert.equal(h.idb.get('state').installedPrerelease, false); assert.equal(h.reloads, 0);
  const stable = harness({ root: memoryFolder(fixtureFiles('2.3.1', false)) }); await stable.connect();
  assert.equal((await stable.core.applyFolderRelease(releaseIdentity('2.3.1', true))).error, 'UPDATE_NOT_NEWER');
});

test('final GitHub asset URLs are checked before body use; opaque, HTTP, foreign hosts and other repos fail closed', async () => {
  for (const mode of ['safe', 'opaque', 'foreign', 'http', 'other-repo']) {
    const h = harness(); await h.connect(); const release = await h.prepare(), archive = h.responses.get(release.downloadUrl);
    const target = mode === 'foreign' ? 'https://evil.example/asset.zip' : mode === 'http' ? 'http://release-assets.githubusercontent.com/asset.zip' :
      mode === 'other-repo' ? 'https://github.com/other/repo/releases/download/v1/file.zip' :
      'https://release-assets.githubusercontent.com/github-production-release-asset/fixture';
    let readers = 0;
    h.responses.set(release.downloadUrl, () => {
      if (mode === 'opaque') return { type: 'opaqueredirect' };
      if (mode !== 'safe') return { url: target, status: 200, ok: true, headers: new Headers(), body: { locked: false, cancel: async () => {}, getReader() { readers++; throw new Error('must check the final URL first'); } } };
      const response = new Response(archive); Object.defineProperty(response, 'url', { value: target }); return response;
    });
    const state = await h.core.applyFolderRelease(release);
    assert.equal(state.error, mode === 'safe' ? '' : mode === 'opaque' ? 'REDIRECT_UNVERIFIABLE' : 'REDIRECT_INVALID');
    if (mode !== 'safe') { assert.equal(readers, 0); noRuntimeWrites(h.env); }
    assert.ok(h.requests.every(([, options]) => options.credentials === 'omit' && !('Cookie' in options.headers)));
    assert.ok(h.requests.filter(([url]) => url.startsWith('https://')).every(([, options]) => options.redirect === 'follow'));
  }
});

test('ZIP/signature Content-Length limits reject before a response reader starts', async () => {
  for (const signature of [false, true]) {
    const h = harness(); await h.connect(); const release = await h.prepare(); let readers = 0;
    h.responses.set(signature ? release.signatureUrl : release.downloadUrl, () => ({ status: 200, ok: true,
      headers: new Headers({ 'content-length': String(signature ? 8193 : 64 * 1024 * 1024 + 1) }),
      body: { locked: false, cancel: async () => {}, getReader() { readers++; throw new Error('must preflight size'); } } }));
    const state = await h.core.applyFolderRelease(release); assert.equal(state.error, 'DOWNLOAD_TOO_LARGE'); assert.equal(readers, 0); noRuntimeWrites(h.env);
  }
});

test('oversized originals fail backup preflight without allocating their buffers', async () => {
  const h = harness(); await h.connect(); h.root.nodeAt('shared/helper.js').node.virtualSize = 64 * 1024 * 1024 + 1;
  const state = await h.core.applyFolderRelease(await h.prepare()); assert.equal(state.error, 'BACKUP_TOO_LARGE'); noRuntimeWrites(h.env); assert.equal(h.requests.length, 0);
});

test('an existing nonce-probe collision is not overwritten or deleted, and a failed own marker write is cleaned up', async () => {
  const h = harness(); await h.core.getFolderUpdateState();
  const next = '00000000-0000-4000-8000-' + String(sequence + 1).padStart(12, '0'), path = '.allen-updater-probe-' + next + '.json';
  h.root.set(path, 'not owned by this attempt');
  assert.equal((await h.core.connectFolder(h.root, { singleProfileAcknowledged: true })).error, 'LOCAL_CHANGES');
  assert.equal(decoder.decode(h.root.bytes(path)), 'not owned by this attempt'); assert.ok(!h.root.has(FOLDER_UPDATER_MARKER));
  const other = harness(); other.env.failClose = { path: FOLDER_UPDATER_MARKER, count: 1 };
  assert.equal((await other.core.connectFolder(other.root, { singleProfileAcknowledged: true })).error, 'WRITE_FAILED');
  assert.equal(other.root.has(FOLDER_UPDATER_MARKER), false); assertOriginals(other.root);
});

test('permission revoked immediately after probe creation is captured before postchecks and reports the attempted safe cleanup', async () => {
  for (const connected of [false, true]) {
    const h = harness(); if (connected) await h.connect(); let probe;
    h.env.afterCreate = (path) => { if (path.startsWith('.allen-updater-probe-')) { probe = path; h.env.afterCreate = null; h.env.permission = 'prompt'; } };
    const state = await h.core.connectFolder(h.root, { singleProfileAcknowledged: true });
    assert.equal(state.error, 'PROBE_CLEANUP_FAILED'); assert.equal(state.connected, connected); assert.ok(probe); assert.equal(h.root.bytes(probe).byteLength, 0);
    const creation = h.env.events.findIndex(([action, path]) => action === 'create' && path === probe); assert.ok(creation >= 0);
    assert.ok(h.env.events.slice(creation + 1).some(([action, path, create]) => action === 'lookup' && path === probe && !create), 'finally must attempt safe cleanup verification');
    assert.ok(!h.env.events.some(([action, path]) => action === 'remove' && path === probe), 'revoked access must not cause blind deletion');
    if (!connected) assert.equal(h.root.has(FOLDER_UPDATER_MARKER), false);
    assertOriginals(h.root); noRuntimeWrites(h.env); assert.equal(h.env.permissionRequests, 0); assert.equal(h.nativeCalls, 0);
  }
});

test('a post-create check failure cleans a verified empty own probe while permission is still granted', async () => {
  const h = harness(); let failed = false;
  h.env.resolveOverride = (entry) => {
    if (entry.path.startsWith('.allen-updater-probe-') && !failed) { failed = true; throw namedError('OperationError'); }
    return entry.path.split('/').filter(Boolean);
  };
  assert.equal((await h.core.connectFolder(h.root, { singleProfileAcknowledged: true })).error, 'WRITE_FAILED');
  const probe = h.env.events.find(([action, path]) => action === 'create' && path.startsWith('.allen-updater-probe-'))?.[1];
  assert.ok(probe); assert.equal(h.root.has(probe), false); assert.ok(h.env.events.some(([action, path]) => action === 'remove' && path === probe));
  assert.equal(h.root.has(FOLDER_UPDATER_MARKER), false); assertOriginals(h.root); noRuntimeWrites(h.env);
});

test('a raced unowned probe collision or replacement is neither overwritten nor deleted during cleanup', async () => {
  for (const replacement of [false, true]) {
    const h = harness(); let probe;
    const race = (path) => { if (path.startsWith('.allen-updater-probe-')) { probe = path; h.root.set(path, 'raced unowned bytes'); h.env.beforeCreate = null; h.env.afterClose = null; } };
    if (replacement) h.env.afterClose = race; else h.env.beforeCreate = race;
    assert.equal((await h.core.connectFolder(h.root, { singleProfileAcknowledged: true })).error, 'LOCAL_CHANGES');
    assert.ok(probe); assert.equal(decoder.decode(h.root.bytes(probe)), 'raced unowned bytes'); assert.equal(h.root.has(FOLDER_UPDATER_MARKER), false);
    assert.ok(!h.env.events.some(([action, path]) => action === 'remove' && path === probe));
    if (!replacement) assert.ok(!h.env.events.some(([action, path]) => action === 'open' && path === probe));
    assertOriginals(h.root); noRuntimeWrites(h.env);
  }
});

test('pre-existing linked children cannot escape the selected directory handle', async () => {
  const h = harness(); await h.connect();
  h.env.resolveOverride = (entry) => entry.path.startsWith('shared/') ? null : entry.path.split('/').filter(Boolean);
  const state = await h.core.applyFolderRelease(await h.prepare()); assert.equal(state.error, 'LOCAL_CHANGES');
  assert.equal(h.requests.length, 0); noRuntimeWrites(h.env); assertOriginals(h.root);
});

test('local edits during download or after journal creation are never silently overwritten by automatic rollback', async () => {
  for (const afterJournal of [false, true]) {
    const h = harness(); await h.connect(); const candidate = fixtureFiles('2.3.1', true);
    candidate.set('shared/helper.js', bytes('export const upstream = "new";')); candidate.set('background.js', bytes('import "./shared/helper.js";\n// upstream entrypoint'));
    const release = await h.prepare(candidate);
    if (afterJournal) h.env.afterClose = (path) => { if (path === 'shared/helper.js') { h.env.afterClose = null; h.root.set('background.js', 'local edit made during update'); } };
    else { const archive = h.responses.get(release.downloadUrl); h.responses.set(release.downloadUrl, () => { h.root.set('background.js', 'local edit made during update'); return new Response(archive); }); }
    const state = await h.core.applyFolderRelease(release); assert.equal(state.error, 'LOCAL_CHANGES');
    assert.equal(decoder.decode(h.root.bytes('background.js')), 'local edit made during update'); assert.equal(state.recoveryPending, afterJournal);
    if (afterJournal) {
      const restarted = createFolderUpdater(h.dependencies); const pending = await restarted.getFolderUpdateState(); assert.equal(pending.error, 'LOCAL_CHANGES'); assert.match(pending.message, /explicit restore/);
      assert.equal((await restarted.setFolderAutomatic(false)).error, 'LOCAL_CHANGES'); assert.equal((await restarted.getFolderUpdateState()).error, 'LOCAL_CHANGES');
    }
    else noRuntimeWrites(h.env);
  }
});

test('unconfirmed external manifest edits require a reload decision but are not reported as verified updates', async () => {
  const h = harness(); await h.connect(); const manifest = JSON.parse(decoder.decode(h.root.bytes('manifest.json'))); manifest.version_name = 'locally changed display version';
  h.root.set('manifest.json', JSON.stringify(manifest)); const state = await h.core.getFolderUpdateState();
  assert.equal(state.error, 'LOCAL_CHANGES'); assert.equal(state.state, 'error'); assert.equal(state.requiresReload, true); assert.equal(h.reloads, 0);
});

test('new-file cleanup requires durable creation proof even when an external collision has identical release bytes', async () => {
  const h = await interrupted(), pending = clone(h.idb.get('journal')), data = bytes('identical release bytes');
  pending.entries.push({ path: 'shared/collision.js', existed: false, bytes: null, hash: null, newHash: await sha(data), created: false });
  h.idb.set('journal', pending); h.root.set('shared/collision.js', data); h.env.permission = 'granted';
  const state = await h.core.recoverFolder(); assert.equal(state.recoveryPending, true); assert.equal(state.error, 'LOCAL_CHANGES');
  assert.deepEqual(h.root.bytes('shared/collision.js'), data); assert.ok(h.idb.get('journal'));
});

test('an owned empty new file left by an interrupted stream is safely removed during recovery', async () => {
  const h = await interrupted(), pending = clone(h.idb.get('journal'));
  pending.entries.push({ path: 'shared/empty.js', existed: false, bytes: null, hash: null, newHash: await sha(bytes('expected candidate')), created: true });
  h.idb.set('journal', pending); h.root.set('shared/empty.js', new Uint8Array()); h.env.permission = 'granted';
  assert.equal((await h.core.recoverFolder()).recoveryPending, false); assert.equal(h.root.has('shared/empty.js'), false); assertOriginals(h.root);
});

test('core recovery refuses unsafe journal targets and corrupt originals before writing', async () => {
  for (const kind of ['path', 'marker', 'bytes']) {
    const h = await interrupted(), pending = clone(h.idb.get('journal'));
    if (kind === 'path') pending.entries[0].path = '../escape.js';
    if (kind === 'marker') pending.entries.push({ path: FOLDER_UPDATER_MARKER, existed: false, bytes: null, hash: null, newHash: h.idb.get('state').markerHash, created: true });
    if (kind === 'bytes') pending.entries[0].bytes = new Blob(['bad backup']);
    h.idb.set('journal', pending); h.env.permission = 'granted'; h.env.events.length = 0;
    assert.equal((await h.core.recoverFolder()).error, 'RECOVERY_INVALID'); noRuntimeWrites(h.env); assert.ok(h.idb.get('journal')); assert.ok(h.root.has(FOLDER_UPDATER_MARKER));
  }
});

test('core and standalone rescue reject incomplete baseline coverage, duplicate originals and unanchored/corrupt hashes before writes', async () => {
  for (const standalone of [false, true]) for (const kind of ['missing', 'extra-baseline', 'wrong-hash', 'corrupt-blob', 'duplicate', 'wrong-existing']) {
    const h = await interrupted(), pending = clone(h.idb.get('journal')), config = clone(h.idb.get('state'));
    const index = pending.entries.findIndex((entry) => entry.path === 'shared/helper.js'), entry = pending.entries[index];
    if (kind === 'missing') pending.entries.splice(index, 1);
    if (kind === 'extra-baseline') config.baseline['shared/extra.js'] = await sha(bytes('missing original backup'));
    if (kind === 'wrong-hash') { entry.bytes = new Blob(['self-consistent but not baseline bytes']); entry.hash = await sha(new Uint8Array(await entry.bytes.arrayBuffer())); }
    if (kind === 'corrupt-blob') entry.bytes = new Blob(['not the bytes of its matching baseline hash']);
    if (kind === 'duplicate') pending.entries.push(clone(entry));
    if (kind === 'wrong-existing') Object.assign(entry, { existed: false, bytes: null, hash: null });
    h.idb.set('state', config); h.idb.set('journal', pending); const before = h.root.bytes('shared/helper.js');
    if (standalone) {
      const page = await rescuePage(h); h.env.events.length = 0; h.env.requestedPermission = 'granted'; await page.click('recover-folder');
      assert.equal(page.elements.get('reload-extension').disabled, true); assert.match(page.elements.get('recovery-status').textContent, /did not finish/);
    } else {
      h.env.permission = 'granted'; h.env.events.length = 0; const state = await h.core.recoverFolder();
      assert.equal(state.error, 'RECOVERY_INVALID'); assert.equal(state.state, 'needs-recovery'); assert.equal(state.recoveryPending, true);
    }
    assert.ok(h.idb.get('journal')); assert.notEqual(h.idb.get('state').lastState, 'ready'); assert.deepEqual(h.root.bytes('shared/helper.js'), before);
    noRuntimeWrites(h.env); assert.equal(h.reloads, 0);
  }
});

test('both recoveries verify every original baseline path after the last restore write and before clearing', async () => {
  for (const standalone of [false, true]) {
    const h = await interrupted(), baseline = Object.keys(h.idb.get('state').baseline), page = standalone ? await rescuePage(h) : null;
    h.env.events.length = 0;
    if (standalone) { h.env.requestedPermission = 'granted'; await page.click('recover-folder'); }
    else { h.env.permission = 'granted'; assert.equal((await h.core.recoverFolder()).recoveryPending, false); }
    const lastWrite = h.env.events.findLastIndex(([action, path]) => action === 'close' && path === 'manifest.json'); assert.ok(lastWrite >= 0);
    const finalReads = new Set(h.env.events.slice(lastWrite + 1).filter(([action]) => action === 'read').map(([, path]) => path));
    for (const path of baseline) assert.ok(finalReads.has(path), 'whole baseline must be verified after restoring: ' + path);
    assert.equal(h.idb.get('journal'), undefined); assertOriginals(h.root); assert.equal(h.reloads, 0);
  }
});

test('late damage to an already-restored baseline file retains the journal and never reports ready', async () => {
  for (const standalone of [false, true]) {
    const h = await interrupted(), page = standalone ? await rescuePage(h) : null;
    h.env.afterClose = (path) => { if (path === 'manifest.json') { h.env.afterClose = null; h.root.set('shared/helper.js', 'damage after manifest restore'); } };
    if (standalone) { h.env.requestedPermission = 'granted'; await page.click('recover-folder'); assert.equal(page.elements.get('reload-extension').disabled, true); }
    else { h.env.permission = 'granted'; const state = await h.core.recoverFolder(); assert.equal(state.recoveryPending, true); assert.equal(state.state, 'needs-recovery'); }
    assert.ok(h.idb.get('journal')); assert.notEqual(h.idb.get('state').lastState, 'ready'); assert.equal(h.reloads, 0);
  }
});

test('rollback requires reload when an externally restarted runtime has the other same-number channel', async () => {
  const h = harness({ root: memoryFolder(fixtureFiles('2.3.1', true)) }); await h.connect();
  h.env.afterClose = (path) => { if (path === 'manifest.json') { h.env.afterClose = null; h.env.permission = 'prompt'; } };
  const release = await h.prepare(fixtureFiles('2.3.1', false), { release: releaseIdentity('2.3.1', false) });
  assert.equal((await h.core.applyFolderRelease(release)).recoveryPending, true);
  delete h.running.version_name; h.env.permission = 'granted'; const restarted = createFolderUpdater(h.dependencies);
  const state = await restarted.recoverFolder(); assert.equal(state.recoveryPending, false); assert.equal(state.requiresReload, true); assert.equal(state.installedVersion, '2.3.1');
  assert.match(JSON.parse(decoder.decode(h.root.bytes('manifest.json'))).version_name, /BETA/); assert.equal(h.reloads, 0);
});

test('added required/optional API and host permissions require reviewed manual installation even with automatic OFF', async () => {
  for (const automatic of [false, true]) for (const field of ['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions']) {
    const h = harness(); await h.connect({ automatic }); const candidate = fixtureFiles('2.3.1', true), manifest = JSON.parse(decoder.decode(candidate.get('manifest.json')));
    manifest[field] = field.includes('host') ? ['https://new.example/*'] : ['cookies']; candidate.set('manifest.json', bytes(JSON.stringify(manifest)));
    assert.equal((await h.core.applyFolderRelease(await h.prepare(candidate))).error, 'MANIFEST_PERMISSION_CHANGE');
    noRuntimeWrites(h.env); assert.equal(h.idb.get('journal'), undefined); assertOriginals(h.root);
  }
});

function policyFiles() {
  const original = fixtureFiles(), manifest = JSON.parse(decoder.decode(original.get('manifest.json')));
  Object.assign(manifest, {
    permissions: ['storage', 'alarms'], host_permissions: ['https://example.test/*', 'https://other.example.test/*'],
    optional_permissions: ['downloads'], optional_host_permissions: ['https://optional.example.test/*'],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
    externally_connectable: { ids: ['*'], matches: ['https://example.test/*'] },
    content_scripts: [{ matches: ['https://example.test/*', 'https://other.example.test/*'], exclude_matches: ['https://example.test/private/*'],
      include_globs: ['*public*', '*docs*'], all_frames: false, js: ['background.js'] }],
    web_accessible_resources: [{ resources: ['shared/helper.js'], matches: ['https://example.test/*'] }],
  });
  original.set('manifest.json', bytes(JSON.stringify(manifest))); return original;
}

test('CSP/external policies, new injection origins, removed exclusions and frame/world broadening are blocked', async () => {
  const original = policyFiles(), edits = [
    (manifest) => { manifest.content_security_policy.extension_pages += ' https://example.test'; },
    (manifest) => { delete manifest.externally_connectable; },
    (manifest) => { manifest.content_scripts[0].matches.push('https://new.example/*'); },
    (manifest) => { manifest.content_scripts[0].exclude_matches = []; },
    (manifest) => { manifest.content_scripts[0].include_globs = []; },
    (manifest) => { manifest.content_scripts[0].all_frames = true; },
    (manifest) => { manifest.content_scripts[0].match_about_blank = true; },
    (manifest) => { manifest.content_scripts[0].world = 'MAIN'; },
    (manifest) => { manifest.web_accessible_resources[0].matches.push('https://new.example/*'); },
  ];
  for (const edit of edits) {
    const h = harness({ root: memoryFolder(original) }); await h.connect(); const candidate = new Map(original), manifest = JSON.parse(decoder.decode(candidate.get('manifest.json')));
    Object.assign(manifest, { version: '2.3.1', version_name: '2.3.1 BETA' }); edit(manifest); candidate.set('manifest.json', bytes(JSON.stringify(manifest)));
    assert.equal((await h.core.applyFolderRelease(await h.prepare(candidate))).error, 'MANIFEST_PERMISSION_CHANGE'); noRuntimeWrites(h.env); assert.equal(h.idb.get('journal'), undefined);
  }
});

test('permissions and origin scopes may reduce while runtime filenames change without a new grant', async () => {
  const original = policyFiles(), h = harness({ root: memoryFolder(original) }); await h.connect(); const candidate = new Map(original), manifest = JSON.parse(decoder.decode(candidate.get('manifest.json')));
  Object.assign(manifest, { version: '2.3.1', version_name: '2.3.1 BETA', permissions: ['storage'], host_permissions: ['https://example.test/*'], optional_permissions: [], optional_host_permissions: [] });
  manifest.content_scripts[0].matches = ['https://example.test/*']; manifest.content_scripts[0].include_globs = ['*public*'];
  manifest.content_scripts[0].exclude_matches.push('https://example.test/more-private/*'); manifest.content_scripts[0].js = ['shared/helper.js'];
  manifest.web_accessible_resources[0].resources = ['scripts/seed.user.js']; candidate.set('manifest.json', bytes(JSON.stringify(manifest)));
  assert.equal((await h.core.applyFolderRelease(await h.prepare(candidate))).state, 'updated'); assert.equal(h.env.permissionRequests, 0); assert.equal(h.reloads, 0);
});

test('getState waits behind a still-fetching writer and cannot expose pre-journal ready after a lost RPC', async () => {
  const h = harness(); await h.connect(); const release = await h.prepare(), archive = h.responses.get(release.downloadUrl);
  let resume, started; const fetching = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { resume = resolve; });
  h.responses.set(release.downloadUrl, async () => { started(); await gate; return new Response(archive); });
  const install = h.core.applyFolderRelease(release); await fetching; assert.equal(h.idb.get('journal'), undefined);
  let returned = false; const status = h.core.getFolderUpdateState().then((state) => { returned = true; return state; });
  await new Promise(setImmediate); assert.equal(returned, false); noRuntimeWrites(h.env);
  resume(); assert.equal((await install).state, 'updated'); const state = await status; assert.equal(state.state, 'updated'); assert.equal(state.requiresReload, true);
});

test('release leases carry ONLY an empty-header GET context and are released before file writes', async () => {
  const h = harness(); await h.connect(); const release = await h.prepare(), events = [], active = new Set();
  const requestContext = {
    async acquire(url, signal, options) { assert.equal(signal.aborted, false); assert.deepEqual(options, { method: 'get', requestHeaders: [] }); const token = 'lease-' + events.length; active.add(token); events.push(['acquire', url, token]); return token; },
    async release(token) { assert.ok(active.delete(token)); events.push(['release', token]); },
  };
  const core = createFolderUpdater({ ...h.dependencies, requestContext }); h.env.afterClose = () => assert.equal(active.size, 0);
  assert.equal((await core.applyFolderRelease(release)).state, 'updated');
  assert.deepEqual(events.filter(([type]) => type === 'acquire').map(([, url]) => url), [release.downloadUrl, release.signatureUrl]);
  assert.equal(events.filter(([type]) => type === 'release').length, 2); assert.equal(active.size, 0); assert.equal(h.nativeCalls, 0);
});

test('lease failures and stalled acquisition never write, and a late acquired lease is cleaned up', async () => {
  for (const mode of ['acquire-failed', 'release-failed', 'release-unconfirmed', 'stalled']) {
    const h = harness(); await h.connect(); const release = await h.prepare(); let late, released = 0;
    const requestContext = {
      acquire() { if (mode === 'acquire-failed') throw new Error('fixture failed'); return mode === 'stalled' ? new Promise((resolve) => { late = resolve; }) : 'lease'; },
      release() { released++; if (mode === 'release-failed') throw new Error('cleanup failed'); return mode === 'release-unconfirmed' ? null : undefined; },
    };
    const core = createFolderUpdater({ ...h.dependencies, requestContext, timeout: mode === 'stalled' ? 80 : 60000 });
    assert.equal((await core.applyFolderRelease(release)).error, 'DOWNLOAD_FAILED'); noRuntimeWrites(h.env); assert.equal(h.idb.get('journal'), undefined);
    if (mode === 'stalled') { assert.equal(h.requests.filter(([url]) => url.startsWith('https:')).length, 0); late('late-lease'); await new Promise(setImmediate); assert.equal(released, 1); }
    if (mode === 'acquire-failed') assert.equal(released, 0);
  }
});

async function interrupted(options = {}) {
  const h = harness(); await h.connect(options); const candidate = fixtureFiles('2.3.1', true); candidate.set('shared/helper.js', bytes('export const changed = "new";'));
  h.env.afterClose = (path) => { if (path === 'shared/helper.js') { h.env.afterClose = null; h.env.permission = 'prompt'; } };
  await h.core.applyFolderRelease(await h.prepare(candidate)); assert.ok(h.idb.get('journal')); h.env.requireJournal = false;
  return h;
}

async function rescuePage(h) {
  const source = await readFile(new URL('../popup/updater-recovery.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m); assert.doesNotMatch(source, /sendMessage\s*\(|sendNativeMessage\s*\(|\bfetch\s*\(/);
  const elements = new Map(['recovery-status', 'recovery-details', 'recover-folder', 'reload-extension', 'reconnect-recovery'].map((id) => [id,
    { disabled: true, textContent: '', attributes: {}, listeners: {}, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(type, callback) { this.listeners[type] = callback; } }]));
  runInNewContext(source, { document: { getElementById: (id) => elements.get(id) }, indexedDB: h.idb, crypto: h.cryptography,
    navigator: { locks: h.locks }, chrome: h.browser, Blob, Uint8Array, TextDecoder, console });
  for (let i = 0; i < 100 && elements.get('reconnect-recovery').disabled; i++) await new Promise(setImmediate);
  assert.equal(elements.get('reconnect-recovery').disabled, false);
  const click = (id) => {
    h.env.userActivation = true;
    try { return elements.get(id).listeners.click?.(); }
    finally { h.env.userActivation = false; }
  };
  return { elements, click };
}

test('standalone rescue boots without background/imports and requests permission only immediately inside a click', async () => {
  const h = await interrupted(), page = await rescuePage(h);
  assert.equal(h.env.permissionRequests, 0); assert.equal(page.elements.get('reload-extension').disabled, true);
  h.env.requestedPermission = 'granted'; const reconnect = page.click('reconnect-recovery');
  assert.equal(h.env.permissionRequests, 1, 'permission request is synchronous within click, before any awaited DB/lock operation');
  await reconnect; assert.ok(h.idb.get('journal')); assert.equal(h.reloads, 0);
  const restore = page.click('recover-folder'); assert.equal(h.env.permissionRequests, 2); await restore;
  assert.equal(h.idb.get('journal'), undefined); assertOriginals(h.root); assert.equal(page.elements.get('reload-extension').disabled, false);
  assert.equal(h.reloads, 0); await page.click('reload-extension'); assert.equal(h.reloads, 1); assert.equal(h.nativeCalls, 0);
});

test('standalone rescue preserves a failed journal and cannot reload after denied permission or write failure', async () => {
  for (const denied of [true, false]) {
    const h = await interrupted(), page = await rescuePage(h); h.env.requestedPermission = denied ? 'denied' : 'granted';
    if (!denied) h.env.failWrite = { path: 'background.js', count: 1 };
    await page.click('recover-folder'); assert.ok(h.idb.get('journal')); assert.equal(page.elements.get('reload-extension').disabled, true);
    page.click('reload-extension'); assert.equal(h.reloads, 0); assert.match(page.elements.get('recovery-status').textContent, /did not finish/);
  }
});

test('standalone rescue refuses forged original bytes, unsafe paths or foreign ownership before writing', async () => {
  for (const kind of ['bytes', 'path', 'owner']) {
    const h = await interrupted(); const journal = clone(h.idb.get('journal'));
    if (kind === 'bytes') journal.entries[0].bytes = new Blob(['forged original']);
    if (kind === 'path') journal.entries[0].path = '../outside.js';
    if (kind === 'owner') journal.profileId = uuid();
    h.idb.set('journal', journal); const page = await rescuePage(h); h.env.events.length = 0; h.env.requestedPermission = 'granted';
    await page.click('recover-folder'); assert.ok(h.idb.get('journal')); noRuntimeWrites(h.env); assert.equal(h.reloads, 0);
  }
});

test('standalone rescue will not delete an unrelated local file at a recorded new path', async () => {
  const h = await interrupted(), journal = clone(h.idb.get('journal'));
  journal.entries.push({ path: 'shared/new.js', existed: false, bytes: null, hash: null, newHash: await sha(bytes('expected release bytes')), created: true });
  h.idb.set('journal', journal); h.root.set('shared/new.js', 'unrelated local file'); const page = await rescuePage(h); h.env.requestedPermission = 'granted';
  await page.click('recover-folder'); assert.equal(decoder.decode(h.root.bytes('shared/new.js')), 'unrelated local file');
  assert.ok(h.idb.get('journal')); assert.equal(page.elements.get('reload-extension').disabled, true); assert.equal(h.reloads, 0);
});

test('standalone rescue defers while browser downloads are active and retains the journal', async () => {
  const h = await interrupted(); h.browser.downloads.search = async () => [{ state: 'in_progress' }];
  const page = await rescuePage(h); h.env.events.length = 0; h.env.requestedPermission = 'granted'; await page.click('recover-folder');
  assert.ok(h.idb.get('journal')); noRuntimeWrites(h.env); assert.equal(h.reloads, 0); assert.match(page.elements.get('recovery-details').textContent, /deferred/);
});

test('rescue reload performs a fresh downloads query immediately before reload and defers a download started after restore', async () => {
  const h = await interrupted(); let active = false, queries = 0;
  h.browser.downloads.search = async (options) => { assert.deepEqual({ ...options }, { state: 'in_progress' }); queries++; h.env.events.push(['downloads-query']); return active ? [{ state: 'in_progress' }] : []; };
  const originalReload = h.browser.runtime.reload; h.browser.runtime.reload = () => { h.env.events.push(['reload']); originalReload(); };
  const page = await rescuePage(h); h.env.requestedPermission = 'granted'; await page.click('recover-folder'); assert.equal(queries, 1); assert.equal(h.idb.get('journal'), undefined);
  active = true; await page.click('reload-extension'); assert.equal(queries, 2); assert.equal(h.reloads, 0); assert.match(page.elements.get('recovery-status').textContent, /deferred/);
  assert.equal(page.elements.get('reload-extension').disabled, false, 'an explicit retry must recheck activity instead of requiring another restore');
  active = false; await page.click('reload-extension'); assert.equal(queries, 3); assert.equal(h.reloads, 1);
  assert.deepEqual(h.env.events.slice(-2).map(([action]) => action), ['downloads-query', 'reload']); assert.equal(h.nativeCalls, 0);
});

test('running/saving session jobs remain busy even when stale, before restore and after completed recovery', async () => {
  for (const state of ['running', 'saving']) {
    const h = await interrupted(); let jobs = [{ id: 'stale-job', state, startedAt: 1, finishedAt: 1 }], queries = 0;
    h.browser.storage.session.get = async (key) => { assert.equal(key, 'jobs'); return { jobs: clone(jobs) }; };
    h.browser.downloads.search = async () => { queries++; return []; };
    const page = await rescuePage(h); h.env.events.length = 0; h.env.requestedPermission = 'granted'; await page.click('recover-folder');
    assert.ok(h.idb.get('journal')); noRuntimeWrites(h.env); assert.equal(h.reloads, 0); assert.equal(queries, 1);
    jobs = []; await page.click('recover-folder'); assert.equal(h.idb.get('journal'), undefined);
    jobs = [{ id: 'new-job', state, startedAt: 1 }]; await page.click('reload-extension'); assert.equal(h.reloads, 0); assert.equal(queries, 3);
    assert.match(page.elements.get('recovery-details').textContent, /running\/saving/);
  }
});

test('retained complete ready Blob jobs do not deadlock independent restore or reload', async () => {
  const h = await interrupted(), complete = { state: 'ready', blobUrl: 'blob:' + h.browser.runtime.getURL('') + 'complete', filename: 'recording.mp4', size: 16, bytes: 16, done: 3, total: 3 };
  const jobs = [{ id: 'ready-job', state: 'ready', pendingReady: complete }, ...['done', 'error', 'cancelled'].map((state) => ({ id: state, state }))];
  h.browser.storage.session.get = async () => ({ jobs: clone(jobs) }); const page = await rescuePage(h); h.env.requestedPermission = 'granted';
  await page.click('recover-folder'); assert.equal(h.idb.get('journal'), undefined); assertOriginals(h.root); await page.click('reload-extension'); assert.equal(h.reloads, 1);
});

test('unsupported or unreadable activity snapshots defer both rescue actions without a bypass', async () => {
  for (const mode of ['session-unsupported', 'session-error', 'session-missing', 'session-malformed', 'downloads-unsupported', 'downloads-error']) {
    const h = await interrupted(), page = await rescuePage(h); h.env.requestedPermission = 'granted';
    const goodSession = h.browser.storage.session, goodDownloads = h.browser.downloads;
    const breakActivity = () => {
      if (mode === 'session-unsupported') h.browser.storage.session = undefined;
      if (mode === 'session-error') h.browser.storage.session = { get: async () => { throw new Error('session unavailable'); } };
      if (mode === 'session-missing') h.browser.storage.session = { get: async () => ({}) };
      if (mode === 'session-malformed') h.browser.storage.session = { get: async () => ({ jobs: {} }) };
      if (mode === 'downloads-unsupported') h.browser.downloads = undefined;
      if (mode === 'downloads-error') h.browser.downloads = { search: async () => { throw new Error('download status unavailable'); } };
    };
    breakActivity(); h.env.events.length = 0; await page.click('recover-folder'); assert.ok(h.idb.get('journal')); noRuntimeWrites(h.env); assert.equal(h.reloads, 0);
    h.browser.storage.session = goodSession; h.browser.downloads = goodDownloads; await page.click('recover-folder'); assert.equal(h.idb.get('journal'), undefined);
    breakActivity(); await page.click('reload-extension'); assert.equal(h.reloads, 0); assert.match(page.elements.get('recovery-status').textContent, /deferred/);
    assert.match(page.elements.get('recovery-details').textContent, /cannot verify other browsers/);
  }
});

test('unsealed/foreign ready snapshots and unknown job states are not treated as idle activity', async () => {
  const base = { state: 'ready', blobUrl: 'blob:chrome-extension://folder-test/complete', filename: 'recording.mp4', size: 16, bytes: 16, done: 3, total: 3 };
  for (const job of [{ state: 'queued' }, { state: 'ready' }, { state: 'ready', pendingReady: { ...base, done: 2 } },
    { state: 'ready', pendingReady: { ...base, bytes: 15 } }, { state: 'ready', pendingReady: { ...base, blobUrl: 'blob:https://foreign.example/data' } }]) {
    const h = await interrupted(); h.browser.storage.session.get = async () => ({ jobs: [clone(job)] }); const page = await rescuePage(h);
    h.env.events.length = 0; h.env.requestedPermission = 'granted'; await page.click('recover-folder'); assert.ok(h.idb.get('journal')); noRuntimeWrites(h.env); assert.equal(h.reloads, 0);
    assert.match(page.elements.get('recovery-details').textContent, /unavailable or stale/);
  }
});

test('a stale rescue reload refuses a subsequent journal or local file change after its successful restore', async () => {
  for (const journalChanged of [true, false]) {
    const h = await interrupted(), originalJournal = clone(h.idb.get('journal')), page = await rescuePage(h); h.env.requestedPermission = 'granted';
    await page.click('recover-folder'); assert.equal(h.idb.get('journal'), undefined); assert.equal(page.elements.get('reload-extension').disabled, false);
    if (journalChanged) h.idb.set('journal', originalJournal); else h.root.set('background.js', 'a new local edit after restore');
    await page.click('reload-extension'); assert.equal(h.reloads, 0); assert.equal(page.elements.get('reload-extension').disabled, true);
    assert.match(page.elements.get('recovery-status').textContent, /Reload was refused/);
  }
});
