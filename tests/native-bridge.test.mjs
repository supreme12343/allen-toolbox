import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeUpdater, NATIVE_UPDATER_HOST } from '../shared/native-updater.js';

const id = 'abcdefghijklmnopabcdefghijklmnop';
const clientId = '12345678-1234-4abc-8def-1234567890ab', key = 'nativeUpdaterClientId';
const publisherThumbprint = 'A'.repeat(40);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const response = (more = {}) => ({ protocol: 2, installed: true, extensionId: id, state: 'up-to-date', installedVersion: '2.2.0', availableVersion: null,
  lastCheckedAt: 0, lastUpdatedAt: 0, error: '', security: { authenticode: true, publisherThumbprint }, ...more });

test.beforeEach((t) => { t.mock.method(globalThis, 'fetch', () => { throw new Error('Native bridge tests must not use the network'); }); });

function fixture(reply = response(), options = {}) {
  const data = options.data || { [key]: clientId }, calls = [], reads = [], writes = [], reloads = [];
  const browser = { runtime: { id, getManifest: () => ({ version: '2.2.0' }), reload() { reloads.push(true); }, async sendNativeMessage(host, message) {
    calls.push({ host, message: structuredClone(message) }); return typeof reply === 'function' ? reply(message, calls.length) : reply;
  } }, storage: { local: {
    async get(name) { reads.push(name); await options.get?.(); return { [name]: data[name] }; },
    async set(value) { writes.push(structuredClone(value)); await options.set?.(); Object.assign(data, value); },
  } } };
  return { calls, browser, data, reads, writes, reloads };
}

function clock(t) { t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() }); }

test('native updater uses a fixed host, strict commands and no caller-controlled paths or URLs', async () => {
  const env = fixture(response()), native = initNativeUpdater({ chrome: env.browser, publisherThumbprint });
  assert.equal(NATIVE_UPDATER_HOST, 'com.supreme.allen_toolbox_updater_v2');
  assert.equal((await native.refresh({ command: 'execute', url: 'https://invalid.test/helper.exe', path: 'C:\\invalid' })).installed, true);
  await native.check({ command: 'execute' }); await native.update({ path: 'C:\\invalid', url: 'https://invalid.test' });
  assert.deepEqual(env.calls, ['status', 'check', 'update'].map((command) => ({ host: NATIVE_UPDATER_HOST, message: { protocol: 2, command, busy: false, clientId } })));
  assert.deepEqual(env.reads, [key]); assert.deepEqual(env.writes, []); assert.deepEqual(env.reloads, []);
});

test('native updater accepts a verified newer installed version and distinguishes reload from download', async () => {
  const env = fixture(response({ state: 'updated', installedVersion: '2.2.1', lastUpdatedAt: Date.now() })), native = initNativeUpdater({ chrome: env.browser });
  const result = await native.update(); assert.equal(result.requiresReload, true); assert.equal(result.state, 'updated');
  assert.equal((await native.status()).applying, false);
  assert.equal(native.isApplying(), true, 'New downloads stay blocked until the confirmed new code reloads');
  assert.deepEqual(result.security, { authenticode: true, publisherThumbprint });
  result.security.authenticode = false; assert.equal((await native.status()).security.authenticode, true);
  assert.deepEqual(env.reloads, [], 'Reload belongs to the parent updater, never the bridge');
});

test('distinct concurrent reads and updates serialize without swallowing installation intent', async () => {
  const hold = gate();
  const env = fixture(async (message) => { if (message.command === 'status') await hold.promise; return response(); });
  const native = initNativeUpdater({ chrome: env.browser });
  const reading = native.refresh(), checking = native.check(), installing = native.update(), again = native.update();
  assert.equal(native.isApplying(), true, 'Reserve installation admission before asynchronous work');
  await tick(); assert.deepEqual(env.calls.map((call) => call.message.command), ['status']);
  hold.resolve(); await Promise.all([reading, checking, installing, again]);
  assert.deepEqual(env.calls.map((call) => call.message.command), ['status', 'check', 'update', 'update']);
  assert.ok(env.calls.every((call) => call.message.clientId === clientId)); assert.equal(native.isApplying(), false);
});

test('native update reserves its admission gate before awaiting asynchronous download checks', async () => {
  const hold = gate(), env = fixture(response());
  const native = initNativeUpdater({ chrome: env.browser, busy: () => hold.promise });
  const pending = native.update();
  assert.equal(native.isApplying(), true);
  await tick(); assert.equal(env.calls.length, 0); assert.equal((await native.status()).applying, true);
  hold.resolve(false); await pending;
  assert.equal(native.isApplying(), false);
});

test('a missing UUID is generated once, persisted before dispatch and shared by concurrent clients', async (t) => {
  const random = t.mock.method(globalThis.crypto, 'randomUUID', () => clientId), hold = gate();
  const env = fixture(response(), { data: {}, set: () => hold.promise });
  const native = initNativeUpdater({ chrome: env.browser }), second = initNativeUpdater({ chrome: env.browser });
  const reading = native.refresh(), installing = native.update(), checking = second.check();
  assert.equal(native.isApplying(), true); await tick();
  assert.equal(random.mock.callCount(), 1); assert.equal(env.calls.length, 0); assert.deepEqual(env.writes, [{ [key]: clientId }]);
  hold.resolve(); await Promise.all([reading, installing, checking]);
  assert.equal(env.data[key], clientId); assert.ok(env.calls.every((call) => call.message.clientId === clientId));
  const restarted = fixture(response(), { data: env.data }); await initNativeUpdater({ chrome: restarted.browser }).refresh();
  assert.equal(random.mock.callCount(), 1); assert.equal(restarted.calls[0].message.clientId, clientId);
});

test('invalid stored identities are replaced, while a valid uppercase UUID is canonicalized without regeneration', async (t) => {
  const random = t.mock.method(globalThis.crypto, 'randomUUID', () => clientId);
  for (const value of [undefined, null, '', 'not-a-uuid', '0'.repeat(32), '00000000-0000-0000-0000-000000000000', '{' + clientId + '}', 'https://invalid.test']) {
    const env = fixture(response(), { data: { [key]: value } });
    await initNativeUpdater({ chrome: env.browser }).refresh(); assert.equal(env.data[key], clientId);
    assert.equal(env.calls[0].message.clientId, clientId);
  }
  const count = random.mock.callCount(), env = fixture(response(), { data: { [key]: clientId.toUpperCase() } });
  await initNativeUpdater({ chrome: env.browser }).check(); assert.equal(random.mock.callCount(), count);
  assert.deepEqual(env.writes, [{ [key]: clientId }]); assert.equal(env.calls[0].message.clientId, clientId);
});

test('different browser profiles retain different generated identities', async (t) => {
  const other = '87654321-4321-4fed-9cba-ba0987654321'; let n = 0;
  const random = t.mock.method(globalThis.crypto, 'randomUUID', () => n++ ? other : clientId);
  const first = fixture(response(), { data: {} }), second = fixture(response(), { data: {} });
  await Promise.all([initNativeUpdater({ chrome: first.browser }).refresh(), initNativeUpdater({ chrome: second.browser }).refresh()]);
  assert.equal(random.mock.callCount(), 2); assert.equal(first.calls[0].message.clientId, clientId); assert.equal(second.calls[0].message.clientId, other);
});

test('identity storage failures fail closed without invoking a host', async (t) => {
  t.mock.method(globalThis.crypto, 'randomUUID', () => clientId);
  for (const options of [{ get() { throw new Error('Storage unavailable'); } }, { data: {}, set() { throw new Error('Storage unavailable'); } }]) {
    const env = fixture(response(), options), native = initNativeUpdater({ chrome: env.browser });
    const result = await native.update(); assert.equal(result.installed, false); assert.equal(result.requiresReload, false);
    assert.equal(native.isApplying(), false); assert.equal(env.calls.length, 0);
  }
});

test('identity storage can be retried without replacing a valid persisted UUID', async (t) => {
  const random = t.mock.method(globalThis.crypto, 'randomUUID', () => clientId); let fail = true;
  const env = fixture(response(), { get() { if (fail) throw new Error('Storage unavailable'); } });
  const native = initNativeUpdater({ chrome: env.browser }); await native.update(); assert.equal(env.calls.length, 0);
  fail = false; assert.equal((await native.update()).installed, true);
  assert.equal(random.mock.callCount(), 0); assert.deepEqual(env.reads, [key, key]); assert.equal(env.calls[0].message.clientId, clientId);
});

test('active downloads defer native installation without starting an OS operation', async () => {
  const env = fixture(response()), native = initNativeUpdater({ chrome: env.browser, busy: () => true });
  assert.equal((await native.update()).state, 'deferred'); assert.equal(env.calls.length, 0);
  assert.equal(native.isApplying(), false);
});

test('protocol 1 and missing or invalid trusted-signature attestations are rejected', async () => {
  for (const bad of [{ protocol: 1 }, { protocol: '2' }, { security: undefined }, { security: null }, { security: {} },
    { security: { authenticode: false, publisherThumbprint } }, { security: { authenticode: 'true', publisherThumbprint } },
    { security: { authenticode: true } }, { security: { authenticode: true, publisherThumbprint: 'A'.repeat(39) } },
    { security: { authenticode: true, publisherThumbprint: 'g'.repeat(40) } }, { security: { authenticode: true, publisherThumbprint, trusted: true } },
    { security: Object.assign(Object.create({ authenticode: true, publisherThumbprint }), { extra: true, other: true }) }]) {
    const env = fixture(response(bad)), native = initNativeUpdater({ chrome: env.browser });
    const result = await native.refresh(); assert.equal(result.installed, false); assert.equal(result.requiresReload, false);
    assert.equal(result.security, null); assert.equal(native.isApplying(), false); assert.match(result.error, /legacy helpers are unsupported/);
    assert.ok(env.calls.every((call) => call.host === 'com.supreme.allen_toolbox_updater_v2'));
  }
});

test('the optional packaged publisher pin accepts only a matching attested signature', async () => {
  const matching = fixture(response({ security: { authenticode: true, publisherThumbprint: publisherThumbprint.toLowerCase() } }));
  const native = initNativeUpdater({ chrome: matching.browser, publisherThumbprint: publisherThumbprint.toLowerCase() });
  assert.equal((await native.refresh()).installed, true); assert.deepEqual((await native.status()).security, { authenticode: true, publisherThumbprint });
  const foreign = fixture(response({ security: { authenticode: true, publisherThumbprint: 'B'.repeat(40) } }));
  const rejected = await initNativeUpdater({ chrome: foreign.browser, publisherThumbprint }).refresh();
  assert.equal(rejected.installed, false); assert.equal(rejected.requiresReload, false); assert.equal(rejected.security, null);
  assert.match(rejected.error, /trusted Authenticode signature/);
});

test('invalid configured publisher pins fail closed while disabled availability accepts its empty pin', async () => {
  const env = fixture();
  for (const pin of ['', null, false, 123, 'A'.repeat(39), 'g'.repeat(40), publisherThumbprint + '\n']) {
    assert.throws(() => initNativeUpdater({ chrome: env.browser, publisherThumbprint: pin }), /hexadecimal thumbprint/);
  }
  const disabled = initNativeUpdater({ chrome: env.browser, enabled: false, publisherThumbprint: '' });
  assert.equal((await disabled.update()).installed, false); assert.deepEqual(env.calls, []); assert.deepEqual(env.reads, []);
});

test('a different publisher cannot report update success or recover an unresolved-update gate', async (t) => {
  clock(t); let reply = response({ state: 'updated', installedVersion: '2.2.1', lastUpdatedAt: Date.now(), security: { authenticode: true, publisherThumbprint: 'B'.repeat(40) } });
  const env = fixture(() => reply), native = initNativeUpdater({ chrome: env.browser, publisherThumbprint });
  const result = await native.update(); assert.equal(result.installed, false); assert.equal(result.requiresReload, false);
  assert.equal(result.uncertain, true); assert.equal(native.isApplying(), true);
  reply = response({ security: { authenticode: true, publisherThumbprint: 'B'.repeat(40) } });
  t.mock.timers.tick(20000); await tick(); assert.equal(native.isApplying(), true); assert.equal((await native.status()).installed, false);
  reply = response(); await native.refresh({ force: true }); assert.equal(native.isApplying(), false);
});

test('native replies require all fields, the matching extension ID and valid coherent versions', async () => {
  const badReplies = [null, [], {}, response({ installed: false }), response({ extensionId: 'p'.repeat(32) }), response({ extensionId: id + 'a' }),
    response({ extensionId: 'z'.repeat(32) }), response({ installedVersion: '2.2.1-beta' }), response({ installedVersion: '2.02' }),
    response({ installedVersion: '65536.0' }), response({ installedVersion: '0' }), response({ installedVersion: '2.1.9' }),
    response({ availableVersion: undefined }), response({ availableVersion: 'not-a-version' }), response({ state: 'untrusted' }),
    response({ availableVersion: '2.1.9' }), response({ availableVersion: '2.2.0' }), response({ state: 'available' }),
    response({ state: 'available', availableVersion: '2.2.1', error: 'signature-invalid' }), response({ state: 'updated' }),
    response({ state: 'updated', installedVersion: '2.1.9', lastUpdatedAt: Date.now() }), response({ extra: 'https://invalid.test' })];
  const missing = response(); delete missing.lastCheckedAt; badReplies.push(missing);
  for (const reply of badReplies) {
    const env = fixture(reply), native = initNativeUpdater({ chrome: env.browser }), result = await native.refresh();
    assert.equal(result.installed, false); assert.equal(result.requiresReload, false); assert.equal(native.isApplying(), false);
  }
});

test('native timestamps and errors are bounded and state/error contradictions fail closed', async (t) => {
  clock(t);
  for (const bad of [{ lastCheckedAt: -1 }, { lastUpdatedAt: -1 }, { lastCheckedAt: 0.5 }, { lastUpdatedAt: Infinity },
    { lastCheckedAt: Number.MAX_SAFE_INTEGER + 1 }, { lastUpdatedAt: Date.now() + 60001 }, { lastCheckedAt: Date.now() + 60001 }, { lastCheckedAt: NaN }, { lastCheckedAt: '1' },
    { error: undefined }, { error: null }, { state: 'error', error: 'x'.repeat(501) }, { state: 'error', error: 'bad\nerror' },
    { state: 'error' }, { state: 'deferred' }, { error: 'update-in-progress' }, { error: 'failure' }]) {
    const env = fixture(response(bad));
    assert.equal((await initNativeUpdater({ chrome: env.browser }).refresh()).installed, false);
  }
  for (const good of [response({ state: 'available', availableVersion: '2.2.1', lastCheckedAt: Date.now() }),
    response({ state: 'updated', lastUpdatedAt: Date.now() }), response({ state: 'error', error: 'x'.repeat(500) }),
    response({ lastCheckedAt: Date.now() + 60000, lastUpdatedAt: Date.now() + 60000, security: { authenticode: true, publisherThumbprint: publisherThumbprint.toLowerCase() } })]) {
    assert.equal((await initNativeUpdater({ chrome: fixture(good).browser }).refresh()).installed, true);
  }
});

test('disabled availability and absent native APIs do not invoke hosts or mutate storage', async () => {
  for (const unavailable of ['disabled', 'no-api']) {
    const env = fixture(); if (unavailable === 'no-api') delete env.browser.runtime.sendNativeMessage;
    const native = initNativeUpdater({ chrome: env.browser, enabled: unavailable !== 'disabled' });
    const pending = native.update(); assert.equal(native.isApplying(), false);
    for (const result of await Promise.all([pending, native.refresh({ force: true }), native.check(), native.status()])) {
      assert.equal(result.installed, false); assert.equal(result.requiresReload, false); assert.equal(result.uncertain, false);
      assert.match(result.error, /Unsigned legacy helpers are unsupported; use the manual ZIP/);
    }
    assert.deepEqual(env.calls, []); assert.deepEqual(env.reads, []); assert.deepEqual(env.writes, []);
  }
  assert.throws(() => initNativeUpdater({ chrome: fixture().browser, enabled: 'true' }), /boolean/);
});

test('a missing signed host never claims installation and does not block manual ZIP admission', async () => {
  const missing = fixture(() => { throw new Error('Specified native messaging host not found'); });
  const native = initNativeUpdater({ chrome: missing.browser });
  for (const result of [await native.refresh(), await native.update()]) {
    assert.equal(result.installed, false); assert.equal(result.requiresReload, false); assert.equal(result.uncertain, false);
    assert.match(result.error, /signed protocol 2.*unavailable/); assert.match(result.error, /manual ZIP/);
  }
  assert.equal(native.isApplying(), false);
});

test('missing-host refresh cooldown avoids repeated process attempts but manual requests always retry', async (t) => {
  clock(t); let missing = true;
  const env = fixture(() => { if (missing) throw new Error('Specified native messaging host not found'); return response(); });
  const native = initNativeUpdater({ chrome: env.browser });
  await Promise.all([native.refresh(), native.refresh(), native.refresh()]); assert.equal(env.calls.length, 1);
  t.mock.timers.tick(59999); await native.refresh(); assert.equal(env.calls.length, 1);
  t.mock.timers.tick(1); await native.refresh(); assert.equal(env.calls.length, 2);
  await native.refresh({ force: true }); await native.check(); await native.update(); assert.equal(env.calls.length, 5);
  missing = false; assert.equal((await native.refresh({ force: true })).installed, true);
  await native.refresh(); assert.equal(env.calls.length, 7);
});

test('confirmed reload admission survives later missing hosts and stale downgrade responses', async () => {
  let reply = response({ state: 'updated', installedVersion: '2.2.1', lastUpdatedAt: Date.now() });
  const env = fixture(() => { if (reply instanceof Error) throw reply; return reply; }), native = initNativeUpdater({ chrome: env.browser });
  await native.update(); reply = new Error('Specified native messaging host not found');
  assert.equal((await native.refresh()).requiresReload, true); assert.equal(native.isApplying(), true);
  reply = response(); const stale = await native.refresh({ force: true });
  assert.equal(stale.installed, false); assert.equal(stale.installedVersion, '2.2.1'); assert.equal(stale.requiresReload, true);
});

test('update timeouts keep admission closed and late replies cannot report success', async (t) => {
  clock(t); const hold = gate(); let first = true;
  const env = fixture(() => first ? hold.promise : response());
  const native = initNativeUpdater({ chrome: env.browser, timeout: 8 });
  const pending = native.update(); await tick(); t.mock.timers.tick(8);
  const result = await pending; assert.equal(result.installed, false); assert.match(result.error, /did not respond/);
  assert.equal(result.requiresReload, false); assert.equal(result.uncertain, true); assert.equal(native.isApplying(), true);
  hold.resolve(response({ state: 'updated', installedVersion: '2.2.1', lastUpdatedAt: Date.now() })); await tick();
  assert.equal((await native.status()).requiresReload, false); assert.equal(native.isApplying(), true);
  first = false; await native.refresh(); assert.equal(native.isApplying(), false);
});

test('timeouts also bound asynchronous busy checks without dispatching after a late resolution', async (t) => {
  clock(t); const hold = gate(), env = fixture(), native = initNativeUpdater({ chrome: env.browser, timeout: 8, busy: () => hold.promise });
  const pending = native.update(); assert.equal(native.isApplying(), true); await tick(); t.mock.timers.tick(8);
  const result = await pending; assert.equal(result.uncertain, false); assert.equal(native.isApplying(), false); assert.equal(env.calls.length, 0);
  hold.resolve(false); await tick(); assert.equal(env.calls.length, 0);
});

test('every native operation is capped at 200 seconds even with an excessive configured timeout', async (t) => {
  clock(t); const env = fixture(() => new Promise(() => {})), native = initNativeUpdater({ chrome: env.browser, timeout: 400000 });
  let settled = false; const pending = native.update().then((result) => { settled = true; return result; }); await tick();
  t.mock.timers.tick(199999); await tick(); assert.equal(settled, false); assert.equal(native.isApplying(), true);
  t.mock.timers.tick(1); const result = await pending; assert.match(result.error, /did not respond/); assert.equal(result.uncertain, true);
});

test('unsigned update replies and unresolved recovery states never reopen an actual-update gate', async (t) => {
  clock(t); let reply = new Promise(() => {});
  const env = fixture(() => { if (reply instanceof Error) throw reply; return reply; }), native = initNativeUpdater({ chrome: env.browser, timeout: 8 });
  const pending = native.update(); await tick(); t.mock.timers.tick(8); await pending;
  for (const [state, error] of [['deferred', 'update-in-progress'], ['deferred', 'recovery-deferred'], ['error', 'transaction-recovery-required'],
    ['error', 'native-timeout'], ['error', 'native-output-invalid']]) {
    reply = response({ state, error }); const result = await native.refresh({ force: true });
    assert.equal(result.uncertain, true); assert.equal(native.isApplying(), true);
  }
  reply = response({ security: null }); assert.equal((await native.refresh({ force: true })).installed, false); assert.equal(native.isApplying(), true);
  reply = new Error('Specified native messaging host not found'); await native.update(); assert.equal(native.isApplying(), true);
  await native.refresh({ force: true }); assert.equal(native.isApplying(), true);
  reply = response(); await native.refresh({ force: true }); assert.equal(native.isApplying(), false);
});

test('an unsigned protocol 1 update reply cannot report installation success or release admission', async (t) => {
  clock(t); let reply = response({ protocol: 1, security: null, state: 'updated', installedVersion: '2.2.1', lastUpdatedAt: Date.now() });
  const env = fixture(() => reply), native = initNativeUpdater({ chrome: env.browser });
  const result = await native.update(); assert.equal(result.installed, false); assert.equal(result.requiresReload, false);
  assert.equal(result.uncertain, true); assert.equal(native.isApplying(), true);
  reply = response(); await native.refresh({ force: true }); assert.equal(native.isApplying(), false);
});

test('deferred and timed-out asynchronous busy retries preserve earlier actual-update uncertainty', async (t) => {
  clock(t); const hold = gate(); let activity = false, reply = new Promise(() => {});
  const env = fixture(() => reply), native = initNativeUpdater({ chrome: env.browser, timeout: 8, busy: () => activity });
  const update = native.update(); await tick(); t.mock.timers.tick(8); await update;
  activity = true; assert.equal((await native.update()).state, 'deferred'); assert.equal(native.isApplying(), true);
  activity = hold.promise; const retry = native.update(); assert.equal(native.isApplying(), true);
  await tick(); t.mock.timers.tick(8); assert.equal((await retry).uncertain, true); assert.equal(env.calls.length, 1);
  hold.resolve(false); await tick(); assert.equal(env.calls.length, 1); assert.equal(native.isApplying(), true);
  activity = false; reply = response(); await native.refresh({ force: true }); assert.equal(native.isApplying(), false);
});

test('independent busy heartbeats bypass a pending update and preserve UUID and command ordering', async (t) => {
  clock(t); const hold = gate(); let active = false, completed = false;
  const env = fixture((message) => message.command === 'update' ? hold.promise : response(completed ? { installedVersion: '2.2.1' } : { state: 'deferred', error: 'update-in-progress' }));
  const native = initNativeUpdater({ chrome: env.browser, busy: async () => active });
  const installing = native.update(), checking = native.check(); await tick(); assert.deepEqual(env.calls.map((call) => call.message.command), ['update']);
  active = true; t.mock.timers.tick(19999); await tick(); assert.equal(env.calls.length, 1);
  t.mock.timers.tick(1); await tick(); assert.equal(env.calls[1].message.command, 'status'); assert.equal(env.calls[1].message.busy, true);
  assert.equal(native.isApplying(), true); active = false; t.mock.timers.tick(20000); await tick();
  assert.equal(env.calls[2].message.busy, false); assert.equal(native.isApplying(), true);
  completed = true; hold.resolve(response({ state: 'updated', installedVersion: '2.2.1', lastUpdatedAt: Date.now() }));
  await installing; await checking;
  assert.deepEqual(env.calls.map((call) => call.message.command), ['update', 'status', 'status', 'check']);
  assert.ok(env.calls.every((call) => call.message.clientId === clientId)); assert.equal((await native.status()).requiresReload, true);
  t.mock.timers.tick(40000); await tick(); assert.equal(env.calls.length, 4); assert.deepEqual(env.reloads, []);
});

test('an asynchronous stalled heartbeat busy check conservatively reports busy without opening admission', async (t) => {
  clock(t); const hold = gate(); let checks = 0;
  const env = fixture((message) => message.command === 'update' ? hold.promise : response());
  const native = initNativeUpdater({ chrome: env.browser, busy: () => checks++ ? new Promise(() => {}) : false });
  const pending = native.update(); await tick(); t.mock.timers.tick(20000); await tick(); assert.equal(env.calls.length, 1);
  t.mock.timers.tick(5000); await tick(); assert.equal(env.calls[1].message.busy, true);
  assert.equal((await native.status()).uncertain, true, 'Even a valid terminal heartbeat cannot settle the outstanding update');
  assert.equal(native.isApplying(), true); hold.resolve(response()); await pending; assert.equal(native.isApplying(), false);
});

test('stalled heartbeat replies do not prevent subsequent independent activity messages', async (t) => {
  clock(t); const update = gate(), replies = gate();
  const env = fixture((message) => message.command === 'update' ? update.promise : replies.promise), native = initNativeUpdater({ chrome: env.browser });
  const pending = native.update(); await tick(); t.mock.timers.tick(20000); await tick(); assert.equal(env.calls.length, 2);
  t.mock.timers.tick(20000); await tick(); assert.equal(env.calls.length, 3); assert.equal(native.isApplying(), true);
  assert.ok(env.calls.every((call) => call.message.clientId === clientId));
  update.resolve(response()); await pending; replies.resolve(response({ protocol: 1 })); await tick();
  assert.equal((await native.status()).installed, true); assert.equal(native.isApplying(), false);
  t.mock.timers.tick(40000); await tick(); assert.equal(env.calls.length, 3);
});

test('missing-host recovery heartbeats keep uncertainty, expose manual fallback and respect refresh cooldown', async (t) => {
  clock(t); let missing = true;
  const env = fixture((message) => {
    if (message.command === 'update') return new Promise(() => {});
    if (missing) throw new Error('Specified native messaging host not found');
    return response();
  }), native = initNativeUpdater({ chrome: env.browser, timeout: 8 });
  const pending = native.update(); await tick(); t.mock.timers.tick(8); await pending;
  t.mock.timers.tick(19992); await tick(); assert.equal(env.calls.length, 2);
  const result = await native.status(); assert.equal(result.uncertain, true); assert.equal(result.installed, false); assert.match(result.error, /manual ZIP/);
  t.mock.timers.tick(40000); await tick(); await native.refresh(); assert.equal(env.calls.length, 2); assert.equal(native.isApplying(), true);
  missing = false; assert.equal((await native.refresh({ force: true })).installed, true); assert.equal(env.calls.length, 3); assert.equal(native.isApplying(), false);
});

test('heartbeats continue after timeout but only a newly issued signed terminal status can recover admission', async (t) => {
  clock(t); const update = gate(), oldHeartbeat = gate(); let statuses = 0;
  const env = fixture((message) => message.command === 'update' ? update.promise : ++statuses === 1 ? oldHeartbeat.promise : response());
  const native = initNativeUpdater({ chrome: env.browser, timeout: 30000 }), pending = native.update(); await tick();
  t.mock.timers.tick(20000); await tick(); assert.equal(env.calls.length, 2);
  t.mock.timers.tick(10000); await pending; assert.equal(native.isApplying(), true);
  oldHeartbeat.resolve(response()); await tick(); assert.equal(native.isApplying(), true, 'A heartbeat issued before timeout is not recovery evidence');
  t.mock.timers.tick(10000); await tick(); assert.equal(env.calls.length, 3); assert.equal(native.isApplying(), false);
  assert.ok(env.calls.every((call) => call.message.clientId === clientId));
  update.resolve(response({ state: 'updated', installedVersion: '2.2.1', lastUpdatedAt: Date.now() })); await tick();
  assert.equal((await native.status()).requiresReload, false, 'Late timed-out update responses cannot mutate the recovered state');
});
