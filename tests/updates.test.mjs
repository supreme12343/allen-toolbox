import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRepository, versionParts, compareVersions, githubRelease, initUpdates, UPDATE_ALARM, UPDATE_RELOAD_ALARM, UPDATE_INSTALL_ALARM, OFFICIAL_REPOSITORY } from '../shared/updates.js';
import { releaseIdentity } from '../shared/update-meta.js';

const repository = OFFICIAL_REPOSITORY;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { await Promise.all(this.listeners.map((fn) => fn(...args))); } });
const metadata = (version = '2.1.2', repo = repository) => ({ tag_name: 'v' + version, html_url: repo + '/releases/tag/v' + version,
  draft: false, prerelease: false, assets: [{ name: 'ALLEN-Toolbox-' + version + '.zip', state: 'uploaded', size: 12345,
    browser_download_url: repo + '/releases/download/v' + version + '/ALLEN-Toolbox-' + version + '.zip' }] });
const jsonResponse = (data = metadata(), headers = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });
const signedMetadata = (version = '2.1.2', prerelease = false) => {
  const identity = releaseIdentity(version, prerelease), url = repository + '/releases/download/' + identity.tag + '/' + identity.filename;
  return { tag_name: identity.tag, html_url: repository + '/releases/tag/' + identity.tag, draft: false, prerelease,
    assets: [{ name: identity.filename, browser_download_url: url, state: 'uploaded', size: 12345 },
      { name: identity.filename + '.sig', browser_download_url: url + '.sig', state: 'uploaded', size: 384 }] };
};
const savedUpdates = (data = signedMetadata(), extra = {}) => ({ repository, channel: 'stable', automatic: true, metadata: data, checkedAt: 100 * HOUR, ...extra });
const savedRetry = (data = signedMetadata(), extra = {}) => {
  const latest = githubRelease(data, repository, { allowPrerelease: true });
  return { retryTag: latest.tag, retryIdentity: latest.tag + ':' + latest.size + ':' + latest.signatureSize,
    retryAttempt: 1, nextRetryAt: 100 * HOUR + MINUTE, lastInstallState: 'deferred', ...extra };
};
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Mocked updater operation did not settle')), 2000); })]); }
  finally { clearTimeout(timer); }
}
function folderBackend(options = {}) {
  const backend = { state: { kind: 'folder', installed: true, connected: true, autoInstall: true, permission: 'granted',
    initialized: true, applying: false, uncertain: false, recoveryPending: false, requiresReload: false,
    installedVersion: '2.1.1', folderName: 'Remembered fixture', state: 'ready', error: '', ...options.state }, updates: [], refreshes: [] };
  backend.native = {
    async status() { await options.status?.(backend); return { ...backend.state }; },
    async refresh(value = {}) { backend.refreshes.push(value); await options.refresh?.(backend, value); return { ...backend.state }; },
    isApplying: () => options.isApplying ? options.isApplying(backend) : !!(backend.state.applying || backend.state.uncertain || backend.state.recoveryPending || backend.state.requiresReload || !backend.state.initialized),
    async update(release, mode) {
      backend.updates.push({ release: structuredClone(release), mode: structuredClone(mode) });
      return options.update ? options.update(backend, release, mode) : { ...backend.state, state: 'deferred', error: 'BUSY' };
    },
  };
  return backend;
}

async function harness(options = {}) {
  const data = options.data || {}, alarms = options.alarms || new Map(), alarmTimes = new Map(), notifications = [], cleared = [], downloads = [], tabs = [], calls = [], leases = [], released = [];
  if (!options.data && !options.fresh) data.githubUpdates = { repository, automatic: false };
  let time = options.time ?? 100 * HOUR;
  for (const [name, value] of alarms) alarmTimes.set(name, value.when ?? value.scheduledTime ?? time + (value.delayInMinutes || 0) * MINUTE);
  let reloads = 0, reloaded;
  const reloadSignal = new Promise((resolve) => { reloaded = resolve; });
  const browser = {
    runtime: { getManifest: () => ({ version: options.version || '2.1.1', homepage_url: options.homepage,
      ...(options.beta ? { version_name: (options.version || '2.1.1') + ' BETA' } : {}) }),
      getURL: (path) => 'chrome-extension://fixture/' + path, onInstalled: event(), onStartup: event() },
    storage: { local: { async get(key) { if (options.beforeRead) await options.beforeRead(key); return { [key]: structuredClone(data[key]) }; }, async set(value) {
      if (options.failStorage) throw new Error('Storage unavailable');
      if (options.beforeWrite) await options.beforeWrite(value);
      Object.assign(data, structuredClone(value));
    } } },
    alarms: { onAlarm: event(), async get(name) { return alarms.get(name); }, async create(name, value) {
      alarms.set(name, value); alarmTimes.set(name, value.when ?? time + (value.delayInMinutes || 0) * MINUTE); options.onAlarmCreate?.(name, value);
    }, async clear(name) { alarmTimes.delete(name); return alarms.delete(name); } },
    notifications: { onClicked: event(), async create(id, value) { notifications.push({ id, ...value }); return id; }, async clear(id) { cleared.push(id); } },
    downloads: { async download(value) { downloads.push(value); return downloads.length; } },
    tabs: { async create(value) { tabs.push(value); return value; } },
  };
  browser.runtime.reload = () => { reloads++; reloaded(); };
  const api = initUpdates({ chrome: browser, now: () => time, timeout: options.timeout || 20000,
    nativeUpdater: options.nativeUpdater, busy: options.busy || (() => false),
    fetch: async (url, value) => { calls.push({ url, ...value }); return options.fetch ? options.fetch(url, value, calls.length) : jsonResponse(); },
    async acquireRequest(value) { leases.push(value); if (options.acquire) return options.acquire(value); },
    async releaseRequest(id) { released.push(id); if (options.release) return options.release(id); },
  });
  options.onApi?.(api);
  await api.status(); await tick();
  return { api, browser, data, alarms, notifications, cleared, downloads, tabs, calls, leases, released, reloadSignal,
    get reloads() { return reloads; }, get time() { return time; }, advance(ms) { time += ms; }, async fireAlarm(name) {
      assert.ok(alarms.has(name), 'The one-shot retry must be armed');
      assert.ok(time >= alarmTimes.get(name), 'The mocked clock must reach the alarm deadline');
      if (!alarms.get(name).periodInMinutes) { alarms.delete(name); alarmTimes.delete(name); }
      await deadline(browser.alarms.onAlarm.emit({ name })); await tick();
    } };
}

test('GitHub configuration accepts only a public HTTPS owner/repository URL', () => {
  assert.equal(githubRepository(' https://github.com/Owner/tool.git/ '), 'https://github.com/Owner/tool');
  assert.equal(githubRepository(''), '');
  for (const value of ['http://github.com/u/r', 'https://evil.github.com/u/r', 'https://u:secret@github.com/u/r', 'https://github.com/u/r?token=secret',
    'https://github.com/u/r#x', 'https://github.com/u/../r', 'https://github.com/u/%2e%2e', 'https://github.com/u/r/tree/main', 'https://github.com/u/.git', 'https://github.com/u/r\n/evil']) {
    assert.throws(() => githubRepository(value), /repository URL/, value);
  }
});

test('extension versions compare numeric components and refuse prerelease or invalid Chrome versions', () => {
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
  assert.equal(compareVersions('2.1.1', '2.1.1.0'), 0);
  assert.equal(compareVersions('2.1.1', '2.1.2'), -1);
  assert.equal(compareVersions('6.1', '6.0'), 1);
  for (const value of ['2.1.2-beta', 'v2.1.2', '2.01', '1.2.3.4.5', '65536.0', '0', '', null, 'Infinity']) assert.throws(() => versionParts(value), /Invalid extension version/);
});

test('release selection rejects foreign URLs and never treats draft/prerelease metadata as an update', () => {
  const release = githubRelease(metadata(), repository);
  assert.equal(release.version, '2.1.2'); assert.equal(release.filename, 'ALLEN-Toolbox-2.1.2.zip');
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: 'v2.1.2-beta' }, { html_url: 'https://github.com/other/repo/releases/tag/v2.1.2' }]) {
    assert.throws(() => githubRelease({ ...metadata(), ...change }, repository));
  }
  const foreign = metadata(); foreign.assets[0].browser_download_url = 'https://evil.test/update.zip';
  assert.throws(() => githubRelease(foreign, repository), /invalid download URL/);
  const missing = metadata(); missing.assets[0].name = 'unrelated.zip';
  assert.equal(githubRelease(missing, repository).downloadUrl, '');
});

test('configuration enables bounded hourly alarms and opt-out removes them without fetching code', async () => {
  const env = await harness();
  assert.equal((await env.api.status()).repository, repository); assert.equal(env.calls.length, 0);
  await env.api.configure({ repository, automatic: true });
  assert.deepEqual(env.alarms.get(UPDATE_ALARM), { delayInMinutes: 1, periodInMinutes: 60 });
  assert.equal(env.calls.length, 0);
  await env.api.configure({ repository, automatic: false }); assert.equal(env.alarms.has(UPDATE_ALARM), false);
  await env.api.check(); assert.equal(env.calls.length, 0);
  await assert.rejects(env.api.configure({ repository: 'https://evil.test/r', automatic: true }));
  assert.equal((await env.api.status()).repository, repository);
});

test('checks omit credentials, isolate request leases, cache 304s and notify only once per version', async () => {
  const env = await harness({ fetch: (url, opts, n) => n === 1 ? jsonResponse(metadata(), { etag: '"release-a"' }) : new Response(null, { status: 304 }) });
  await env.api.configure({ repository, automatic: true });
  const first = await env.api.check({ force: true });
  assert.equal(first.available, true); assert.equal(first.checking, false); assert.equal(first.error, '');
  assert.equal(env.calls[0].url, 'https://api.github.com/repos/supreme12343/allen-toolbox/releases/latest');
  assert.equal(env.calls[0].credentials, 'omit'); assert.equal(env.calls[0].redirect, 'error'); assert.equal(env.calls[0].referrerPolicy, 'no-referrer');
  assert.deepEqual(env.leases[0].requestHeaders, []); assert.deepEqual(env.released, env.leases.map((lease) => lease.requestId));
  await env.api.check({ force: true });
  assert.equal(env.calls[1].headers['If-None-Match'], '"release-a"'); assert.equal(env.notifications.length, 1);
  const saved = await env.api.download();
  assert.equal(saved.queued, true); assert.equal(saved.downloadId, 1);
  assert.deepEqual(env.downloads[0], { url: metadata().assets[0].browser_download_url, filename: 'ALLEN-Toolbox-2.1.2.zip', saveAs: true });
  await env.browser.notifications.onClicked.emit('untrusted-notice'); await tick(); assert.equal(env.tabs.length, 0);
  await env.browser.notifications.onClicked.emit('allen-toolbox-update'); await tick();
  assert.equal(env.tabs[0].url, metadata().html_url);
  const reloaded = await harness({ data: env.data, version: '2.1.2' });
  assert.equal((await reloaded.api.status()).available, false); assert.equal(reloaded.calls.length, 0);
  await assert.rejects(reloaded.api.download(), /No newer release ZIP/);
});

test('automatic checks are throttled but manual checks remain available after opt-out', async () => {
  const env = await harness(); await env.api.configure({ repository, automatic: true });
  await env.api.check(); assert.equal(env.calls.length, 1);
  env.advance(HOUR - 1); await env.api.check(); assert.equal(env.calls.length, 1);
  env.advance(1); await env.api.check(); assert.equal(env.calls.length, 2);
  await env.api.configure({ repository, automatic: false });
  env.advance(HOUR); await env.api.check(); assert.equal(env.calls.length, 2);
  await env.api.check({ force: true }); assert.equal(env.calls.length, 3);
});

test('rate limits defer automatic checks and errors cannot start a ZIP download', async () => {
  const env = await harness({ fetch: () => new Response('PRIVATE RESPONSE MUST NOT BE DISPLAYED', { status: 403,
    headers: { 'x-ratelimit-reset': String(102 * HOUR / 1000) } }) });
  await env.api.configure({ repository, automatic: true });
  const result = await env.api.check({ force: true });
  assert.match(result.error, /rate-limited/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE RESPONSE/);
  env.advance(HOUR); await env.api.check(); assert.equal(env.calls.length, 1);
  env.advance(HOUR); await env.api.check(); assert.equal(env.calls.length, 2);
  await assert.rejects(env.api.download()); assert.equal(env.downloads.length, 0); assert.equal(env.notifications.length, 0);
});

test('invalid, oversized, unavailable or redirected metadata is refused without saving executable content', async (t) => {
  const cases = [
    ['HTML', () => new Response('<html>not a release</html>', { headers: { 'content-type': 'text/html' } })],
    ['invalid JSON', () => new Response('PRIVATE_NOT_JSON', { headers: { 'content-type': 'application/json' } })],
    ['oversized JSON', () => new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/json' } })],
    ['no release', () => new Response('PRIVATE_BODY', { status: 404 })],
    ['uncached 304', () => new Response(null, { status: 304 })],
    ['offline', () => { throw new TypeError('PRIVATE_NETWORK_DETAIL'); }],
    ['foreign redirect', () => { const response = jsonResponse(); Object.defineProperty(response, 'url', { value: 'https://evil.test/metadata' }); return response; }],
  ];
  for (const [name, fetch] of cases) await t.test(name, async () => {
    const env = await harness({ fetch }); await env.api.configure({ repository, automatic: true });
    const result = await env.api.check({ force: true });
    assert.ok(result.error); assert.equal(result.latest, null); assert.equal(result.available, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/); assert.equal(env.notifications.length, 0);
    await assert.rejects(env.api.download()); assert.equal(env.downloads.length, 0);
    assert.ok(env.leases.every((lease) => env.released.includes(lease.requestId)));
  });
});

test('timeout aborts a stalled check and releases its request lease', async () => {
  let signal;
  const env = await harness({ timeout: 8, fetch: (url, opts) => { signal = opts.signal;
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true })); } });
  await env.api.configure({ repository, automatic: true });
  const result = await env.api.check({ force: true });
  assert.match(result.error, /timed out/); assert.equal(signal.aborted, true);
  assert.ok(env.released.includes(env.leases[0].requestId)); assert.equal(result.checking, false);
});

test('repository redirection and clearing are rejected even while a check is in flight', async () => {
  let resolve;
  const env = await harness({ fetch: () => new Promise((done) => { resolve = done; }) });
  await env.api.configure({ repository, automatic: true });
  const pending = env.api.check({ force: true }); await tick();
  for (const target of ['https://github.com/other/toolbox', '']) await assert.rejects(env.api.configure({ repository: target, automatic: true }), /source is fixed/);
  resolve(jsonResponse()); await pending;
  const result = await env.api.status();
  assert.equal(result.repository, repository); assert.equal(result.latest.url, metadata().html_url); assert.equal(result.error, '');
  assert.equal(env.notifications.length, 1); assert.equal(env.data.githubUpdates.repository, repository);
});

test('checks wait for pending automatic-check preference writes', async () => {
  let hold = false, releaseWrite, signalWrite;
  const started = new Promise((resolve) => { signalWrite = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const env = await harness({ beforeWrite: async (value) => {
    if (hold && value.githubUpdates.automatic === false) { hold = false; signalWrite(); await gate; }
  } });
  await env.api.configure({ automatic: true });
  hold = true;
  const saving = env.api.configure({ automatic: false }); await started;
  const checking = env.api.check({ force: true }); await tick();
  try { assert.equal(env.calls.length, 0, 'A check may not start during a pending settings write'); }
  finally { releaseWrite(); }
  await saving; const result = await checking;
  assert.equal(env.calls.length, 1); assert.ok(env.calls[0].url.includes('/repos/supreme12343/allen-toolbox/'));
  assert.equal(result.latest.url, metadata().html_url); assert.equal(result.automatic, false);
  assert.equal(env.data.githubUpdates.repository, repository); assert.equal(env.data.githubUpdates.metadata.html_url, result.latest.url);
});

test('timeout bounds a lease queued behind an unresolved request and cleans late grants', async () => {
  let grant;
  const queued = new Promise((resolve) => { grant = resolve; });
  const env = await harness({ timeout: 8, acquire: () => queued });
  await env.api.configure({ repository, automatic: true });
  let timer;
  try {
    const result = await Promise.race([env.api.check({ force: true }), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Lease timeout did not settle the check')), 1000); })]);
    assert.match(result.error, /timed out/); assert.equal(result.checking, false); assert.equal(env.calls.length, 0);
    assert.ok(env.released.includes(env.leases[0].requestId));
  } finally { clearTimeout(timer); grant(); }
  await tick(); assert.ok(env.released.filter((id) => id === env.leases[0].requestId).length >= 2);
});

test('turning automatic checks off cancels a queued lease and preserves manual checks', async () => {
  let grant, acquisitions = 0;
  const queued = new Promise((resolve) => { grant = resolve; });
  const env = await harness({ acquire: () => acquisitions++ === 0 ? queued : undefined });
  await env.api.configure({ repository, automatic: true });
  const first = env.api.check({ force: true }); await tick();
  await env.api.configure({ automatic: false }); await first;
  const result = await env.api.check({ force: true });
  assert.equal(result.repository, repository); assert.equal(result.latest.url, metadata().html_url);
  assert.equal(env.calls.length, 1); grant(); await tick();
});

test('the fixed official default needs no input and ignores alternate manifest homepages', async () => {
  const env = await harness({ fresh: true, homepage: 'https://github.com/other/toolbox' });
  const result = await env.api.status();
  assert.equal(result.repository, repository); assert.equal(result.automatic, true); assert.equal(env.calls.length, 1);
  env.alarms.clear(); await env.browser.runtime.onStartup.emit();
  assert.equal(env.alarms.get(UPDATE_ALARM).periodInMinutes, 60); assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, 'https://api.github.com/repos/supreme12343/allen-toolbox/releases/latest');
});

test('legacy or tampered saved repository settings cannot redirect checks or retain foreign metadata', async () => {
  const other = 'https://github.com/other/toolbox';
  const env = await harness({ data: { githubUpdates: { repository: other, automatic: false, metadata: metadata('2.1.2', other),
    etag: '"foreign"', checkedAt: 99 * HOUR, retryAt: 200 * HOUR } } });
  const initial = await env.api.status();
  assert.equal(initial.repository, repository); assert.equal(initial.latest, null); assert.equal(initial.checkedAt, 0);
  assert.equal(env.data.githubUpdates.repository, repository);
  const result = await env.api.check({ force: true });
  assert.equal(result.latest.url, metadata().html_url); assert.equal(env.calls[0].headers['If-None-Match'], undefined);
  assert.ok(env.calls[0].url.includes('/repos/supreme12343/allen-toolbox/'));
});

test('failed settings persistence does not replace the working repository', async () => {
  const env = await harness({ failStorage: true });
  await assert.rejects(env.api.configure({ repository, automatic: true }), /Storage unavailable/);
  assert.equal((await env.api.status()).repository, repository);
});

test('beta runtime selects and caches signed prereleases without affecting the stable endpoint', async () => {
  const identity = releaseIdentity('2.3.2', true), url = repository + '/releases/download/' + identity.tag + '/';
  const beta = { ...metadata('2.3.2'), tag_name: identity.tag, prerelease: true, html_url: repository + '/releases/tag/' + identity.tag,
    assets: [{ name: identity.filename, browser_download_url: url + identity.filename, state: 'uploaded', size: 100 },
      { name: identity.filename + '.sig', browser_download_url: url + identity.filename + '.sig', state: 'uploaded', size: 384 }] };
  const env = await harness({ version: '2.3.1', beta: true, fetch: (url, opts, n) => n === 1 ? jsonResponse([beta, metadata('2.3.0')], { etag: '"beta"' }) : new Response(null, { status: 304 }) });
  const first = await env.api.check({ force: true });
  assert.equal(first.channel, 'beta'); assert.equal(first.latest.prerelease, true); assert.equal(first.available, true);
  assert.equal(env.calls[0].url, 'https://api.github.com/repos/supreme12343/allen-toolbox/releases?per_page=30');
  const cached = await env.api.check({ force: true });
  assert.equal(cached.latest.signatureUrl, beta.assets[1].browser_download_url); assert.equal(cached.latest.signatureSize, 384);
  assert.equal(env.calls[1].headers['If-None-Match'], '"beta"');
  const stable = await harness(); await stable.api.check({ force: true });
  assert.ok(stable.calls[0].url.endsWith('/releases/latest'));
});

test('a connected folder does not automatically install without its separate file-write opt-in', async () => {
  let installs = 0;
  const state = { kind: 'folder', installed: true, connected: true, autoInstall: false };
  const native = { async refresh() { return state; }, async status() { return state; }, isApplying: () => false, async update() { installs++; return state; } };
  const env = await harness({ nativeUpdater: native });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  assert.equal(installs, 0); assert.equal(env.reloads, 0);
});

test('manual installation waits for saved release restoration rather than dispatching a null release', async () => {
  let release, api, installs = 0, selected;
  const gate = new Promise((resolve) => { release = resolve; });
  const native = { async refresh() { return {}; }, async status() { return {}; }, isApplying: () => false,
    async update(value, mode) { assert.deepEqual(mode, { automatic: false }); installs++; selected = value; return { installed: true }; } };
  const constructing = harness({ data: { githubUpdates: { repository, channel: 'stable', automatic: false, metadata: metadata(), checkedAt: 100 * HOUR } },
    beforeRead: () => gate, onApi: (value) => { api = value; }, nativeUpdater: native });
  const installing = api.install(); await tick(); assert.equal(installs, 0);
  release(); await constructing; await installing;
  assert.equal(installs, 1); assert.equal(selected.version, '2.1.2');
});

test('beta-to-stable promotion notifications are deduplicated by release tag, not numeric version', async () => {
  const env = await harness({ version: '2.3.1', beta: true, data: { githubUpdates: { repository, channel: 'beta', automatic: true,
    notified: 'v2.3.1-beta', checkedAt: 100 * HOUR } }, fetch: () => jsonResponse([metadata('2.3.1')]) });
  const result = await env.api.check({ force: true });
  assert.equal(result.available, true); assert.equal(result.latest.prerelease, false); assert.equal(env.notifications.length, 1);
  assert.equal(env.data.githubUpdates.notified, 'v2.3.1');
});

test('unconfirmed folder edits and deferred recovery cannot trigger a reload', async () => {
  const state = { kind: 'folder', installed: true, initialized: true, state: 'error', error: 'LOCAL_CHANGES', requiresReload: true };
  const native = { async status() { return state; }, async refresh() { return state; }, isApplying: () => true,
    async recover() { return { ...state, state: 'deferred', uncertain: true, recoveryPending: true }; } };
  const env = await harness({ nativeUpdater: native });
  await env.api.recover(); await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(env.reloads, 0);
});

test('a later verified folder refresh schedules rollback reload even without a newer release', async () => {
  let state = { kind: 'folder', installed: false, initialized: true, state: 'not-connected' };
  const native = { async status() { return state; }, async refresh() { return state; }, isApplying: () => false };
  const env = await harness({ version: '2.3.1', beta: true, nativeUpdater: native, fetch: () => jsonResponse([metadata('2.3.0')]) });
  state = { kind: 'folder', installed: true, initialized: true, state: 'ready', installedVersion: '2.3.0', requiresReload: true };
  const result = await env.api.check({ force: true }); assert.equal(result.available, false);
  await env.reloadSignal; assert.equal(env.reloads, 1);
});

test('approved native installation reloads only after a confirmed newer installed version', async () => {
  let installs = 0, state = { installed: true };
  const native = { async refresh() { return state; }, async status() { return state; }, isApplying: () => false,
    async update(release, mode) { assert.deepEqual(mode, { automatic: true }); installs++; state = { installed: true, installedVersion: '2.1.2', state: 'updated', requiresReload: true }; return state; } };
  const env = await harness({ nativeUpdater: native });
  await env.api.configure({ automatic: true });
  const result = await env.api.check({ force: true });
  assert.equal(installs, 1); assert.equal(result.native.state, 'updated'); assert.equal(env.reloads, 0);
  await env.reloadSignal; assert.equal(env.reloads, 1);
});

test('confirmed reloads persist through busy intervals even when GitHub checks are disabled', async () => {
  let isBusy = true, armed;
  const alarmSignal = new Promise((resolve) => { armed = resolve; });
  const state = { installed: true, installedVersion: '2.1.2', state: 'up-to-date', requiresReload: true };
  const native = { async refresh() { return state; }, async status() { return state; }, isApplying: () => false, async update() { return state; } };
  const env = await harness({ nativeUpdater: native, busy: () => isBusy, onAlarmCreate: (name) => { if (name === UPDATE_RELOAD_ALARM) armed(); } });
  await alarmSignal;
  assert.equal(env.reloads, 0); assert.equal(env.calls.length, 0);
  isBusy = false; await env.browser.alarms.onAlarm.emit({ name: UPDATE_RELOAD_ALARM });
  await env.reloadSignal; assert.equal(env.reloads, 1);
});

test('missing native setup never claims automatic installation and keeps ZIP fallback', async () => {
  const env = await harness(); await env.api.configure({ automatic: true });
  const result = await env.api.check({ force: true });
  assert.equal(result.native.installed, false); assert.equal(env.reloads, 0);
  assert.equal((await env.api.download()).queued, true);
});

test('busy folder installation retries on a one-shot minute alarm using only validated saved release metadata', async () => {
  const source = signedMetadata();
  const backend = folderBackend({ update: (current) => {
    if (current.updates.length === 1) return { ...current.state, state: 'deferred', error: 'BUSY' };
    current.state = { ...current.state, installedVersion: '2.1.2', state: 'updated', requiresReload: true };
    return { ...current.state };
  } });
  const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(source, { etag: '"signed"' }) });
  await env.api.configure({ automatic: true });
  const first = await env.api.check({ force: true });
  assert.equal(first.lastInstallState, 'deferred'); assert.equal(first.nextRetryAt, env.time + MINUTE);
  assert.equal(env.data.githubUpdates.retryTag, 'v2.1.2'); assert.equal(env.data.githubUpdates.retryAttempt, 1);
  assert.deepEqual(env.alarms.get(UPDATE_INSTALL_ALARM), { when: first.nextRetryAt });
  env.advance(MINUTE - 1); await env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM });
  assert.equal(backend.updates.length, 1, 'Early or duplicate alarm delivery cannot bypass the retry deadline');
  env.advance(1); await env.fireAlarm(UPDATE_INSTALL_ALARM);
  assert.equal(backend.updates.length, 2); assert.equal(env.calls.length, 1); assert.equal(env.leases.length, 1);
  assert.deepEqual(backend.updates.map((call) => call.mode), [{ automatic: true }, { automatic: true }]);
  assert.deepEqual(backend.updates[1].release, backend.updates[0].release);
  assert.equal(backend.updates[1].release.signatureUrl, source.assets[1].browser_download_url);
  assert.equal(backend.updates[1].release.signatureSize, 384);
  assert.equal(env.data.githubUpdates.retryTag, ''); assert.equal(env.data.githubUpdates.nextRetryAt, 0);
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.equal(env.data.githubUpdates.etag, '"signed"');
  await deadline(env.reloadSignal); assert.equal(env.reloads, 1);
});

test('read-only UI polling cannot postpone an already-due retry alarm', async () => {
  let created = 0;
  const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()),
    onAlarmCreate: (name) => { if (name === UPDATE_INSTALL_ALARM) created++; } });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  const original = { ...env.alarms.get(UPDATE_INSTALL_ALARM) };
  assert.equal(created, 1);
  env.advance(MINUTE + 1000);
  for (let poll = 0; poll < 3; poll++) await env.api.status({ refresh: true });
  assert.deepEqual(env.alarms.get(UPDATE_INSTALL_ALARM), original); assert.equal(created, 1);
  await env.fireAlarm(UPDATE_INSTALL_ALARM); assert.equal(backend.updates.length, 2);
});

test('disabling manager checks before an install alarm cancels retries without changing folder opt-in', async () => {
  const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  await env.api.configure({ automatic: false }); env.advance(MINUTE);
  await env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM });
  assert.equal(backend.updates.length, 1); assert.equal(env.calls.length, 1);
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.equal(env.alarms.has(UPDATE_ALARM), false);
  assert.equal(env.data.githubUpdates.retryTag, ''); assert.equal(env.data.githubUpdates.retryAttempt, 0);
  assert.equal(backend.state.autoInstall, true); assert.equal(backend.state.connected, true);
});

test('permission revocation and file-install opt-out pause retries without forgetting the saved connection', async (t) => {
  for (const change of [{ autoInstall: false }, { permission: 'prompt', state: 'needs-permission', error: 'PERMISSION_REQUIRED' },
    { permission: 'denied', state: 'needs-permission', error: 'PERMISSION_REQUIRED' }]) await t.test(JSON.stringify(change), async () => {
    const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
    await env.api.configure({ automatic: true }); await env.api.check({ force: true });
    Object.assign(backend.state, change); const remembered = structuredClone(backend.state);
    env.advance(MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
    assert.equal(backend.updates.length, 1); assert.equal(env.calls.length, 1);
    assert.equal(env.data.githubUpdates.retryTag, ''); assert.equal(env.data.githubUpdates.nextRetryAt, 0);
    assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.deepEqual(backend.state, remembered);
    assert.equal((await env.api.status()).native.folderName, 'Remembered fixture');
  });
});

test('hard folder errors, missing connections and unresolved recovery cannot be retried or reloaded', async (t) => {
  const changes = [
    { connected: false, installed: false, state: 'not-connected' },
    ...['LOCAL_CHANGES', 'PUBLIC_KEY_INVALID', 'PUBLIC_KEY_CHANGED', 'SIGNATURE_INVALID', 'MANIFEST_PERMISSION_CHANGE', 'PACKAGE_MANIFEST', 'FOLDER_CHECK_FAILED', 'AUTOMATIC_DISABLED']
      .map((error) => ({ state: 'error', error, requiresReload: true })),
    { state: 'deferred', error: 'BUSY', recoveryPending: true, requiresReload: true },
    { state: 'needs-recovery', error: 'STORAGE_FAILED', uncertain: true, recoveryPending: true },
    { initialized: false, uncertain: true, state: 'needs-recovery', error: 'STORAGE_FAILED' },
    { state: 'deferred', error: 'Unrecognized failure', requiresReload: true },
  ];
  for (const change of changes) await t.test(change.error || change.state, async () => {
    const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
    await env.api.configure({ automatic: true }); await env.api.check({ force: true });
    Object.assign(backend.state, change); const remembered = structuredClone(backend.state);
    env.advance(MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
    await env.browser.alarms.onAlarm.emit({ name: UPDATE_RELOAD_ALARM });
    assert.equal(backend.updates.length, 1); assert.equal(env.reloads, 0); assert.equal(env.calls.length, 1);
    assert.equal(env.data.githubUpdates.retryTag, ''); assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
    assert.deepEqual(backend.state, remembered, 'The manager must not alter core consent, recovery or remembered-folder state');
    if (change.uncertain || change.recoveryPending) assert.equal(env.alarms.has(UPDATE_RELOAD_ALARM), true);
  });
});

test('a forced manual check resumes a paused candidate only after core state becomes eligible again', async () => {
  const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  Object.assign(backend.state, { state: 'error', error: 'LOCAL_CHANGES' });
  env.advance(MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
  Object.assign(backend.state, { state: 'ready', error: '' });
  await env.api.status({ refresh: true }); await env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM });
  assert.equal(backend.updates.length, 1, 'Read-only refresh and an obsolete alarm cannot restart a paused install');
  await env.api.check({ force: true });
  assert.equal(backend.updates.length, 2); assert.equal(env.calls.length, 2); assert.equal(env.data.githubUpdates.retryAttempt, 1);
  assert.equal(env.data.githubUpdates.nextRetryAt, env.time + MINUTE);
});

test('known pre-write transients use bounded backoff and cannot reset their budget on hourly checks or restart', async () => {
  const backend = folderBackend({ update: (current) => {
    current.state = { ...current.state, state: 'error', error: 'DOWNLOAD_FAILED' }; return { ...current.state };
  } });
  const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  for (const [index, minutes] of [1, 2, 4, 8, 15].entries()) {
    assert.equal(env.data.githubUpdates.retryAttempt, index + 1);
    assert.equal(env.data.githubUpdates.nextRetryAt, env.time + minutes * MINUTE);
    assert.equal(env.alarms.get(UPDATE_INSTALL_ALARM).periodInMinutes, undefined);
    env.advance(minutes * MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
  }
  assert.equal(backend.updates.length, 6); assert.equal(env.calls.length, 1);
  assert.equal(env.data.githubUpdates.retryTag, 'v2.1.2'); assert.equal(env.data.githubUpdates.retryAttempt, 5);
  assert.equal(env.data.githubUpdates.nextRetryAt, 0); assert.equal(env.data.githubUpdates.lastInstallState, 'retry-exhausted');
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
  await env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM }); await env.browser.runtime.onStartup.emit();
  env.advance(HOUR); await env.api.check(); assert.equal(backend.updates.length, 6); assert.equal(env.calls.length, 2);
  const restarted = await harness({ data: structuredClone(env.data), time: env.time, nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  assert.equal(backend.updates.length, 6); assert.equal(restarted.calls.length, 0);
  assert.equal((await restarted.api.status()).lastInstallState, 'retry-exhausted');
  Object.assign(backend.state, { state: 'ready', error: '' });
  await restarted.api.check({ force: true });
  assert.equal(backend.updates.length, 7); assert.equal(restarted.data.githubUpdates.retryAttempt, 1);
});

test('a manual retry reset queued during an automatic check preserves its forced intent', async () => {
  const source = signedMetadata(), backend = folderBackend(), first = deferred();
  const env = await harness({ nativeUpdater: backend.native,
    data: { githubUpdates: savedUpdates(source, savedRetry(source, { retryAttempt: 5, nextRetryAt: 0, lastInstallState: 'retry-exhausted' })) },
    fetch: (url, options, count) => count === 1 ? first.promise : jsonResponse(source) });
  assert.equal(backend.updates.length, 0);
  env.advance(HOUR);
  const automatic = env.api.check(); await tick();
  const manual = env.api.check({ force: true }), duplicate = env.api.check({ force: true });
  first.resolve(jsonResponse(source));
  await deadline(automatic);
  const [one, two] = await deadline(Promise.all([manual, duplicate]));
  assert.equal(env.calls.length, 2, 'One forced check follows the active automatic check, not one per click');
  assert.equal(backend.updates.length, 1); assert.equal(one.lastInstallState, 'deferred'); assert.equal(two.lastInstallState, 'deferred');
  assert.equal(env.data.githubUpdates.retryAttempt, 1);
});

test('startup restores an old cached record and persisted file opt-in only after backend refresh, without an API poll', async () => {
  let initialized = false;
  const backend = folderBackend({ isApplying: () => !initialized, refresh: () => { initialized = true; } });
  const env = await harness({ data: { githubUpdates: savedUpdates() }, nativeUpdater: backend.native });
  await env.browser.runtime.onStartup.emit(); await env.browser.runtime.onInstalled.emit();
  assert.equal(backend.updates.length, 1); assert.equal(initialized, true); assert.equal(env.calls.length, 0);
  assert.equal(backend.updates[0].mode.automatic, true); assert.equal(backend.state.autoInstall, true);
  assert.equal(env.data.githubUpdates.retryAttempt, 1);
  const restarted = await harness({ data: structuredClone(env.data), nativeUpdater: backend.native, time: env.time });
  assert.equal(backend.updates.length, 1); assert.equal(restarted.calls.length, 0);
  restarted.advance(MINUTE); await restarted.fireAlarm(UPDATE_INSTALL_ALARM);
  assert.equal(backend.updates.length, 2); assert.equal(restarted.calls.length, 0);
  assert.deepEqual(backend.updates[1].release, backend.updates[0].release);
});

test('an overdue saved install retry resumes at startup from cached official identity and signature', async () => {
  const source = signedMetadata(), backend = folderBackend();
  const env = await harness({ data: { githubUpdates: savedUpdates(source, savedRetry(source, { nextRetryAt: 100 * HOUR - MINUTE })) }, nativeUpdater: backend.native });
  await env.browser.runtime.onStartup.emit();
  assert.equal(backend.updates.length, 1); assert.equal(env.calls.length, 0);
  assert.equal(backend.updates[0].release.signatureUrl, source.assets[1].browser_download_url);
  assert.equal(env.data.githubUpdates.retryAttempt, 2); assert.equal(env.data.githubUpdates.nextRetryAt, env.time + 2 * MINUTE);
});

test('the running manifest acknowledging the candidate clears saved install retries without installation', async () => {
  const source = signedMetadata(), backend = folderBackend({ state: { installedVersion: '2.1.2' } });
  const env = await harness({ version: '2.1.2', data: { githubUpdates: savedUpdates(source, savedRetry(source)) }, nativeUpdater: backend.native });
  assert.equal((await env.api.status()).available, false); assert.equal(backend.updates.length, 0); assert.equal(env.calls.length, 0);
  assert.equal(env.data.githubUpdates.retryTag, ''); assert.equal(env.data.githubUpdates.retryAttempt, 0);
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
});

test('changing candidate tag or signed asset metadata cancels the old retry scope', async (t) => {
  for (const source of [signedMetadata('2.1.3'), (() => { const value = signedMetadata(); value.assets[0].size++; return value; })(),
    (() => { const value = signedMetadata(); value.assets[1].size++; return value; })()]) await t.test(source.tag_name + ':' + source.assets.map((asset) => asset.size), async () => {
    const backend = folderBackend(); let response = signedMetadata();
    const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(response) });
    await env.api.configure({ automatic: true }); await env.api.check({ force: true });
    backend.state.autoInstall = false; response = source; await env.api.check({ force: true });
    await env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM });
    assert.equal(backend.updates.length, 1); assert.equal(env.data.githubUpdates.retryTag, '');
    assert.equal(env.data.githubUpdates.nextRetryAt, 0); assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
    assert.deepEqual(env.data.githubUpdates.metadata, source);
  });
});

test('retry restoration rejects invalid counters, deadlines, scope and private state text', async (t) => {
  const source = signedMetadata();
  for (const change of [{ retryAttempt: -1 }, { retryAttempt: 6 }, { retryAttempt: 1.5 }, { nextRetryAt: -1 },
    { nextRetryAt: Number.MAX_SAFE_INTEGER }, { nextRetryAt: 100 * HOUR + 16 * MINUTE }, { nextRetryAt: 0 },
    { retryTag: 'v2.1.3' }, { retryTag: 'v2.1.2-beta' }, { retryIdentity: 'unvalidated' },
    { retryAttempt: 5, nextRetryAt: 0, lastInstallState: 'https://private.invalid/path' }]) await t.test(JSON.stringify(change), async () => {
    const backend = folderBackend({ state: { autoInstall: false } });
    const env = await harness({ data: { githubUpdates: savedUpdates(source, savedRetry(source, change)) }, nativeUpdater: backend.native });
    const result = await env.api.status();
    assert.equal(result.nextRetryAt, 0); assert.equal(env.data.githubUpdates.retryTag, ''); assert.equal(env.data.githubUpdates.retryAttempt, 0);
    assert.equal(backend.updates.length, 0); assert.equal(env.calls.length, 0); assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
    assert.deepEqual(env.data.githubUpdates.metadata, source); assert.doesNotMatch(JSON.stringify(result), /private\.invalid/);
  });
});

test('stable runtime discards beta retry metadata and never selects a beta install or endpoint', async () => {
  const source = signedMetadata('2.1.2', true), backend = folderBackend();
  const env = await harness({ data: { githubUpdates: savedUpdates(source, { automatic: false, ...savedRetry(source) }) }, nativeUpdater: backend.native,
    fetch: () => jsonResponse(source) });
  assert.equal((await env.api.status()).latest, null); assert.equal(env.data.githubUpdates.retryTag, '');
  await env.api.check({ force: true });
  assert.equal(backend.updates.length, 0); assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
  assert.ok(env.calls.every((call) => call.url.endsWith('/releases/latest')));
});

test('unsigned or absent cached install assets never trigger automatic folder writes', async () => {
  const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native });
  await env.api.configure({ automatic: true }); const result = await env.api.check({ force: true });
  assert.equal(result.available, true); assert.equal(backend.updates.length, 0); assert.equal(result.nextRetryAt, 0);
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.equal((await env.api.download()).queued, true);
});

test('an opt-out revision during a retry refresh or pending preference write prevents admission', async () => {
  const reading = deferred(), readStarted = deferred(), writing = deferred(), writeStarted = deferred();
  let holdRead = false, holdWrite = false;
  const backend = folderBackend({ refresh: async () => { if (holdRead) { readStarted.resolve(); await reading.promise; } } });
  const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()), beforeWrite: async (value) => {
    if (holdWrite && value.githubUpdates.automatic === false) { writeStarted.resolve(); await writing.promise; }
  } });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  env.advance(MINUTE); holdRead = true; const retrying = env.fireAlarm(UPDATE_INSTALL_ALARM); await deadline(readStarted.promise);
  holdWrite = true; const optingOut = env.api.configure({ automatic: false }); await deadline(writeStarted.promise);
  reading.resolve(); await tick(); assert.equal(backend.updates.length, 1);
  writing.resolve(); await deadline(Promise.all([retrying, optingOut]));
  assert.equal(backend.updates.length, 1); assert.equal(env.data.githubUpdates.automatic, false);
  assert.equal(env.data.githubUpdates.retryTag, ''); assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.equal(env.calls.length, 1);
});

test('file opt-out after candidate fetch is rechecked before automatic installation', async () => {
  const reading = deferred(), started = deferred(); let hold = false;
  const backend = folderBackend({ status: async () => { if (hold) { started.resolve(); await reading.promise; } } });
  const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  await env.api.configure({ automatic: true }); hold = true;
  const checking = env.api.check({ force: true }); await deadline(started.promise);
  backend.state.autoInstall = false; reading.resolve(); await deadline(checking);
  assert.equal(env.calls.length, 1); assert.equal(backend.updates.length, 0);
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.equal(backend.state.connected, true);
});

test('automatic intent is delivered to the backend so a late core opt-out can refuse all writes', async () => {
  let writes = 0;
  const backend = folderBackend({ update: (current, release, mode) => {
    current.state.autoInstall = false;
    if (mode.automatic) return { ...current.state, state: 'deferred', error: 'AUTOMATIC_DISABLED' };
    writes++; return { ...current.state };
  } });
  const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  await env.api.configure({ automatic: true }); const result = await env.api.check({ force: true });
  assert.equal(result.native.error, 'AUTOMATIC_DISABLED'); assert.equal(writes, 0);
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.equal(env.data.githubUpdates.retryTag, '');
  await env.api.install(); assert.equal(writes, 1); assert.deepEqual(backend.updates[1].mode, { automatic: false });
});

test('manual and automatic installs serialize, and the first confirmed reload blocks the second candidate apply', async () => {
  const applying = deferred(), started = deferred();
  const backend = folderBackend({ update: async (current) => {
    current.state.applying = true; started.resolve(); await applying.promise;
    current.state = { ...current.state, applying: false, installedVersion: '2.1.2', state: 'updated', requiresReload: true };
    return { ...current.state };
  } });
  const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  await env.api.configure({ automatic: true }); const checking = env.api.check({ force: true }); await deadline(started.promise);
  const manual = env.api.install(), duplicateCheck = env.api.check({ force: true });
  const refreshed = await env.api.status({ refresh: true });
  assert.equal(refreshed.native.applying, true); assert.equal(env.api.isApplying(), true); assert.equal(await env.api.canSaveCompleted(), false);
  assert.equal(backend.updates.length, 1); assert.equal(env.calls.length, 1);
  applying.resolve(); const [, result] = await deadline(Promise.all([checking, manual, duplicateCheck]));
  assert.equal(result.requiresReload, true); assert.equal(backend.updates.length, 1);
  assert.equal(await env.api.canSaveCompleted(), true, 'Retained completed-file saves remain allowed after a verified update');
  await Promise.all([env.browser.alarms.onAlarm.emit({ name: UPDATE_RELOAD_ALARM }), env.browser.alarms.onAlarm.emit({ name: UPDATE_RELOAD_ALARM })]);
  await deadline(env.reloadSignal); assert.equal(env.reloads, 1);
});

test('manual install waits for a read-only initialization and never mistakes that refresh for an update', async () => {
  const reading = deferred(); let api, installs = 0;
  const state = { kind: 'folder', connected: true, installed: true, initialized: true, state: 'ready', permission: 'granted', autoInstall: false };
  const native = { async refresh() { await reading.promise; return state; }, async status() { await reading.promise; return state; }, isApplying: () => false,
    async update(release, mode) { installs++; assert.equal(release.tag, 'v2.1.2'); assert.deepEqual(mode, { automatic: false }); return state; } };
  const constructing = harness({ nativeUpdater: native, data: { githubUpdates: savedUpdates(signedMetadata(), { automatic: false }) }, onApi: (value) => { api = value; } });
  const installing = api.install(); await tick(); assert.equal(installs, 0);
  reading.resolve(); await deadline(Promise.all([constructing, installing])); assert.equal(installs, 1);
});

test('a pending failed metadata read cannot erase a retry progressed from the cached signed release', async () => {
  const response = deferred(), started = deferred(); let fail = false;
  const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: async () => {
    if (fail) { started.resolve(); await response.promise; throw new TypeError('PRIVATE_NETWORK_DETAIL'); }
    return jsonResponse(signedMetadata(), { etag: '"cached"' });
  } });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  const cached = structuredClone(env.data.githubUpdates.metadata);
  fail = true; const checking = env.api.check({ force: true }); await deadline(started.promise);
  env.advance(MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
  assert.equal(env.data.githubUpdates.retryAttempt, 2); const next = env.data.githubUpdates.nextRetryAt;
  response.resolve(); const result = await deadline(checking);
  assert.match(result.error, /Could not reach GitHub/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NETWORK/);
  assert.deepEqual(env.data.githubUpdates.metadata, cached); assert.equal(env.data.githubUpdates.etag, '"cached"');
  assert.equal(env.data.githubUpdates.retryAttempt, 2); assert.equal(env.data.githubUpdates.nextRetryAt, next);
  assert.equal(backend.updates.length, 2); assert.equal(env.calls.length, 2);
});

test('failed settings restoration preserves saved preferences and retry data without fetching or installing', async () => {
  const data = { githubUpdates: savedUpdates(signedMetadata(), savedRetry()) }, original = structuredClone(data), backend = folderBackend();
  const env = await harness({ data, nativeUpdater: backend.native, beforeRead: () => { throw new Error('PRIVATE_STORAGE_PATH'); } });
  const result = await env.api.status({ refresh: true });
  assert.match(result.error, /settings could not be restored/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STORAGE/);
  await env.api.check({ force: true }); await env.browser.runtime.onStartup.emit();
  await env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM });
  await assert.rejects(env.api.configure({ automatic: false }), /settings could not be restored/);
  await assert.rejects(env.api.install());
  assert.deepEqual(data, original); assert.equal(env.calls.length, 0); assert.equal(backend.updates.length, 0);
});

test('forced status refresh retains the parent refresh contract and never reopens uncertain initialization', async () => {
  const backend = folderBackend({ state: { initialized: false, uncertain: true, recoveryPending: true, state: 'needs-recovery', error: 'STORAGE_FAILED' } });
  const env = await harness({ nativeUpdater: backend.native });
  const result = await env.api.status({ refresh: true });
  assert.deepEqual(backend.refreshes.at(-1), { force: true }); assert.equal(result.native.initialized, false);
  assert.equal(env.api.isApplying(), true); assert.equal(await env.api.canSaveCompleted(), false); assert.equal(backend.updates.length, 0);
  await env.browser.alarms.onAlarm.emit({ name: UPDATE_RELOAD_ALARM });
  assert.equal(env.reloads, 0); assert.equal(env.alarms.has(UPDATE_RELOAD_ALARM), true);
});

test('duplicate due alarm deliveries serialize and cannot make a busy install spin', async () => {
  const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  env.advance(MINUTE);
  await deadline(Promise.all([env.fireAlarm(UPDATE_INSTALL_ALARM), env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM })]));
  assert.equal(backend.updates.length, 2); assert.equal(env.calls.length, 1);
  assert.equal(env.data.githubUpdates.retryAttempt, 2); assert.equal(env.data.githubUpdates.nextRetryAt, env.time + 2 * MINUTE);
});

test('an original offscreen apply still in progress is never dispatched again by a cached retry', async () => {
  const backend = folderBackend({ state: { applying: true } });
  const env = await harness({ data: { githubUpdates: savedUpdates() }, nativeUpdater: backend.native });
  await env.browser.runtime.onStartup.emit();
  assert.equal(backend.updates.length, 0); assert.equal(env.data.githubUpdates.retryAttempt, 1);
  env.advance(MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
  assert.equal(backend.updates.length, 0); assert.equal(env.data.githubUpdates.retryAttempt, 2);
  backend.state.applying = false; env.advance(2 * MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
  assert.equal(backend.updates.length, 1); assert.equal(env.calls.length, 0);
  assert.deepEqual(backend.updates[0].mode, { automatic: true });
});

test('unknown backend read failures pause an install retry rather than rearming an unbounded status loop', async (t) => {
  for (const operation of ['refresh', 'status']) await t.test(operation, async () => {
    let fail = false;
    const backend = folderBackend({ [operation]: () => { if (fail) throw new Error('PRIVATE_BACKEND_PATH'); } });
    const env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()) });
    await env.api.configure({ automatic: true }); await env.api.check({ force: true });
    const cached = structuredClone(env.data.githubUpdates.metadata);
    fail = true; env.advance(MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
    assert.equal(backend.updates.length, 1); assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
    assert.equal(env.data.githubUpdates.retryTag, ''); assert.deepEqual(env.data.githubUpdates.metadata, cached);
    fail = false; const paused = await env.api.status({ refresh: true });
    assert.equal(paused.nextRetryAt, 0); assert.equal(paused.lastInstallState, 'paused'); assert.doesNotMatch(JSON.stringify(paused), /PRIVATE_BACKEND/);
    await env.browser.runtime.onStartup.emit(); assert.equal(backend.updates.length, 1);
    await env.api.check({ force: true }); assert.equal(backend.updates.length, 2);
  });
});

test('retry persistence must be writable before backend admission and failure does not erase the saved release or folder', async () => {
  let fail = false;
  const backend = folderBackend(), env = await harness({ nativeUpdater: backend.native, fetch: () => jsonResponse(signedMetadata()),
    beforeWrite: () => { if (fail) throw new Error('PRIVATE_STORAGE_FAILURE'); } });
  await env.api.configure({ automatic: true }); await env.api.check({ force: true });
  const saved = structuredClone(env.data.githubUpdates), core = structuredClone(backend.state);
  fail = true; env.advance(MINUTE); await env.fireAlarm(UPDATE_INSTALL_ALARM);
  assert.equal(backend.updates.length, 1, 'A retry with unwritable tracking state must not reach the file backend');
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false); assert.deepEqual(env.data.githubUpdates, saved); assert.deepEqual(backend.state, core);
  const result = await env.api.status({ refresh: true });
  assert.equal(result.nextRetryAt, 0); assert.equal(result.lastInstallState, 'paused'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STORAGE/);
  fail = false; await env.browser.runtime.onStartup.emit(); assert.equal(backend.updates.length, 1);
  await env.api.check({ force: true }); assert.equal(backend.updates.length, 2);
});

test('folder retry state is not reused by a non-folder native backend after restart', async () => {
  let updates = 0;
  const native = { async refresh() { return { installed: true }; }, async status() { return { installed: true }; }, isApplying: () => false,
    async update(release, mode) { updates++; assert.deepEqual(mode, { automatic: true }); return { installed: true }; } };
  const env = await harness({ data: { githubUpdates: savedUpdates(signedMetadata(), savedRetry()) }, nativeUpdater: native });
  assert.equal(updates, 0); assert.equal(env.calls.length, 0); assert.equal(env.data.githubUpdates.retryTag, '');
  assert.equal(env.alarms.has(UPDATE_INSTALL_ALARM), false);
  env.advance(MINUTE); await env.browser.alarms.onAlarm.emit({ name: UPDATE_INSTALL_ALARM }); assert.equal(updates, 0);
});
