import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeUpdater, NATIVE_UPDATER_HOST } from '../shared/native-updater.js';

const id = 'abcdefghijklmnopabcdefghijklmnop';
function fixture(reply) {
  const calls = [], browser = { runtime: { id, getManifest: () => ({ version: '2.2.0' }), async sendNativeMessage(host, message) {
    calls.push({ host, message }); return typeof reply === 'function' ? reply(message) : reply;
  } } };
  return { calls, browser };
}
const response = (more = {}) => ({ protocol: 1, installed: true, extensionId: id, state: 'up-to-date', installedVersion: '2.2.0', availableVersion: null, ...more });

test('native updater uses a fixed host, strict commands and no caller-controlled paths or URLs', async () => {
  const env = fixture(response()), native = initNativeUpdater({ chrome: env.browser });
  assert.equal((await native.refresh()).installed, true);
  assert.deepEqual(env.calls, [{ host: NATIVE_UPDATER_HOST, message: { protocol: 1, command: 'status', busy: false } }]);
});

test('native updater accepts a verified newer installed version and distinguishes reload from download', async () => {
  const env = fixture(response({ state: 'updated', installedVersion: '2.2.1' })), native = initNativeUpdater({ chrome: env.browser });
  const result = await native.update(); assert.equal(result.requiresReload, true); assert.equal(result.state, 'updated');
  assert.equal((await native.status()).applying, false);
  assert.equal(native.isApplying(), true, 'New downloads stay blocked until the confirmed new code reloads');
});

test('update intent is queued behind a read-only native status request instead of being swallowed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = fixture(async (message) => { if (message.command === 'status') await gate; return response(); });
  const native = initNativeUpdater({ chrome: env.browser });
  const reading = native.refresh(), installing = native.update();
  assert.equal(native.isApplying(), true, 'Reserve installation admission before asynchronous work');
  release(); await reading; await installing;
  assert.deepEqual(env.calls.map((call) => call.message.command), ['status', 'update']);
});

test('native update reserves its admission gate before awaiting asynchronous download checks', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; }), env = fixture(response());
  const native = initNativeUpdater({ chrome: env.browser, busy: () => gate });
  const pending = native.update();
  assert.equal(native.isApplying(), true);
  release(false); await pending;
  assert.equal(native.isApplying(), false);
});

test('active downloads defer native installation without starting an OS operation', async () => {
  const env = fixture(response()), native = initNativeUpdater({ chrome: env.browser, busy: () => true });
  assert.equal((await native.update()).state, 'deferred'); assert.equal(env.calls.length, 0);
});

test('native responses for other extension IDs, protocols or invalid versions fail closed', async () => {
  for (const bad of [{ extensionId: 'p'.repeat(32) }, { protocol: 2 }, { installedVersion: '2.2.1-beta' }, { state: 'untrusted' }]) {
    const env = fixture(response(bad));
    assert.equal((await initNativeUpdater({ chrome: env.browser }).refresh()).installed, false);
  }
});

test('an absent or unresponsive host never claims installation or reload success', async () => {
  const missing = fixture(() => { throw new Error('Specified native messaging host not found'); });
  assert.equal((await initNativeUpdater({ chrome: missing.browser }).refresh()).requiresReload, false);
  const stalled = fixture(() => new Promise(() => {}));
  const result = await initNativeUpdater({ chrome: stalled.browser, timeout: 8 }).update();
  assert.equal(result.installed, false); assert.match(result.error, /did not respond/);
});

test('an unresolved update timeout retains admission until native status confirms a terminal state', async () => {
  let first = true;
  const env = fixture(() => first ? new Promise(() => {}) : response());
  const native = initNativeUpdater({ chrome: env.browser, timeout: 8 });
  await native.update(); assert.equal(native.isApplying(), true);
  first = false; await native.refresh(); assert.equal(native.isApplying(), false);
});
