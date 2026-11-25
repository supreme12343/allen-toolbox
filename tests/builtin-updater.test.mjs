import test from 'node:test';
import assert from 'node:assert/strict';
import { initBuiltinUpdater } from '../shared/builtin-updater.js';

const ready = { kind: 'folder', connected: true, autoInstall: false, state: 'ready', installedVersion: '2.3.1', permission: 'granted', requiresReload: false };
const browser = { runtime: { getManifest: () => ({ version: '2.3.1', version_name: '2.3.1 BETA' }) } };

test('cold-start file admission waits for persisted recovery state', async () => {
  const updater = initBuiltinUpdater({ chrome: browser, offscreen: async () => ready });
  assert.equal(updater.isApplying(), true); await updater.refresh(); assert.equal(updater.isApplying(), false);
});
test('browser-only installation reserves admission before async busy checks and respects deferral', async () => {
  let release, calls = 0;
  const busy = new Promise((resolve) => { release = resolve; });
  const updater = initBuiltinUpdater({ chrome: browser, busy: () => busy, offscreen: async () => { calls++; return ready; } });
  await updater.refresh();
  const pending = updater.update({ version: '2.3.2' }); assert.equal(updater.isApplying(), true);
  release(true); assert.equal((await pending).state, 'deferred'); assert.equal(calls, 1);
});
test('confirmed file installation preserves the reload gate and cannot forget its recovery handle', async () => {
  const calls = [], updater = initBuiltinUpdater({ chrome: browser, offscreen: async (type, payload) => {
    calls.push({ type, payload }); return type === 'folder-install' ? { ...ready, installedVersion: '2.3.2', state: 'updated', requiresReload: true } : ready;
  } });
  await updater.refresh(); const release = { version: '2.3.2', prerelease: true };
  assert.equal((await updater.update(release)).requiresReload, true);
  assert.deepEqual(calls[1], { type: 'folder-install', payload: { release } });
  assert.equal(updater.isApplying(), true); await assert.rejects(updater.forget(), /Finish or recover/);
});
