import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRepository, versionParts, compareVersions, githubRelease, initUpdates, UPDATE_ALARM } from '../shared/updates.js';

const repository = 'https://github.com/example/allen-toolbox';
const HOUR = 60 * 60 * 1000;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { await Promise.all(this.listeners.map((fn) => fn(...args))); } });
const metadata = (version = '2.1.2', repo = repository) => ({ tag_name: 'v' + version, html_url: repo + '/releases/tag/v' + version,
  draft: false, prerelease: false, assets: [{ name: 'ALLEN-Toolbox-' + version + '.zip', state: 'uploaded', size: 12345,
    browser_download_url: repo + '/releases/download/v' + version + '/ALLEN-Toolbox-' + version + '.zip' }] });
const jsonResponse = (data = metadata(), headers = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });

async function harness(options = {}) {
  const data = options.data || {}, alarms = new Map(), notifications = [], cleared = [], downloads = [], tabs = [], calls = [], leases = [], released = [];
  let time = 100 * HOUR;
  const browser = {
    runtime: { getManifest: () => ({ version: options.version || '2.1.1', homepage_url: options.homepage }),
      getURL: (path) => 'chrome-extension://fixture/' + path, onInstalled: event(), onStartup: event() },
    storage: { local: { async get(key) { return { [key]: structuredClone(data[key]) }; }, async set(value) {
      if (options.failStorage) throw new Error('Storage unavailable');
      if (options.beforeWrite) await options.beforeWrite(value);
      Object.assign(data, structuredClone(value));
    } } },
    alarms: { onAlarm: event(), async get(name) { return alarms.get(name); }, async create(name, value) { alarms.set(name, value); }, async clear(name) { return alarms.delete(name); } },
    notifications: { onClicked: event(), async create(id, value) { notifications.push({ id, ...value }); return id; }, async clear(id) { cleared.push(id); } },
    downloads: { async download(value) { downloads.push(value); return downloads.length; } },
    tabs: { async create(value) { tabs.push(value); return value; } },
  };
  const api = initUpdates({ chrome: browser, now: () => time, timeout: options.timeout || 20000,
    fetch: async (url, value) => { calls.push({ url, ...value }); return options.fetch ? options.fetch(url, value, calls.length) : jsonResponse(); },
    async acquireRequest(value) { leases.push(value); if (options.acquire) return options.acquire(value); },
    async releaseRequest(id) { released.push(id); if (options.release) return options.release(id); },
  });
  await api.status(); await tick();
  return { api, browser, data, alarms, notifications, cleared, downloads, tabs, calls, leases, released, advance(ms) { time += ms; } };
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
  assert.equal((await env.api.status()).repository, ''); assert.equal(env.calls.length, 0);
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
  assert.equal(env.calls[0].url, 'https://api.github.com/repos/example/allen-toolbox/releases/latest');
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

test('a changed repository cannot receive a stale in-flight release or notification', async () => {
  let resolve;
  const env = await harness({ fetch: () => new Promise((done) => { resolve = done; }) });
  await env.api.configure({ repository, automatic: true });
  const pending = env.api.check({ force: true }); await tick();
  await env.api.configure({ repository: 'https://github.com/other/toolbox', automatic: true });
  resolve(jsonResponse()); await pending;
  const result = await env.api.status();
  assert.equal(result.repository, 'https://github.com/other/toolbox'); assert.equal(result.latest, null); assert.equal(result.error, '');
  assert.equal(env.notifications.length, 0); assert.equal(env.data.githubUpdates.repository, result.repository);
});

test('checks wait for pending settings writes before snapshotting a new repository revision', async () => {
  let hold = false, releaseWrite, signalWrite;
  const started = new Promise((resolve) => { signalWrite = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const other = 'https://github.com/other/toolbox';
  const env = await harness({ beforeWrite: async (value) => {
    if (hold && value.githubUpdates.repository === other) { hold = false; signalWrite(); await gate; }
  }, fetch: (url) => jsonResponse(metadata('2.1.2', url.includes('/other/') ? other : repository)) });
  await env.api.configure({ repository, automatic: false });
  hold = true;
  const saving = env.api.configure({ repository: other, automatic: true }); await started;
  const checking = env.api.check({ force: true }); await tick();
  try { assert.equal(env.calls.length, 0, 'No old-repository fetch may begin during the storage write'); }
  finally { releaseWrite(); }
  await saving; const result = await checking;
  assert.equal(env.calls.length, 1); assert.ok(env.calls[0].url.includes('/repos/other/toolbox/'));
  assert.equal(result.latest.url, metadata('2.1.2', other).html_url);
  assert.equal(env.data.githubUpdates.repository, other); assert.equal(env.data.githubUpdates.metadata.html_url, result.latest.url);
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

test('repository changes can cancel a queued lease and check another repo without waiting for the old holder', async () => {
  let grant;
  const queued = new Promise((resolve) => { grant = resolve; }), other = 'https://github.com/other/toolbox';
  const env = await harness({ acquire: (value) => value.url.includes('/repos/example/') ? queued : undefined,
    fetch: () => jsonResponse(metadata('2.1.2', other)) });
  await env.api.configure({ repository, automatic: true });
  const first = env.api.check({ force: true }); await tick();
  await env.api.configure({ repository: other, automatic: true }); await first;
  const result = await env.api.check({ force: true });
  assert.equal(result.repository, other); assert.equal(result.latest.url, metadata('2.1.2', other).html_url);
  assert.equal(env.calls.length, 1); grant(); await tick();
});

test('packaged repository defaults enable checks and browser startup restores a missing alarm', async () => {
  const env = await harness({ homepage: repository });
  const result = await env.api.status();
  assert.equal(result.repository, repository); assert.equal(result.automatic, true); assert.equal(env.calls.length, 1);
  env.alarms.clear(); await env.browser.runtime.onStartup.emit();
  assert.equal(env.alarms.get(UPDATE_ALARM).periodInMinutes, 60); assert.equal(env.calls.length, 1);
});

test('failed settings persistence does not replace the working repository', async () => {
  const env = await harness({ failStorage: true });
  await assert.rejects(env.api.configure({ repository, automatic: true }), /Storage unavailable/);
  assert.equal((await env.api.status()).repository, '');
});
