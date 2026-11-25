import test from 'node:test';
import assert from 'node:assert/strict';
import { initBuiltinUpdater } from '../shared/builtin-updater.js';

const ready = { kind: 'folder', connected: true, autoInstall: false, state: 'ready', installedVersion: '2.3.1', permission: 'granted', requiresReload: false };
const browser = { runtime: { getManifest: () => ({ version: '2.3.1', version_name: '2.3.1 BETA' }) } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

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

test('saved-folder status refreshes after reload or a stale cache without reconnecting', async () => {
  let time = 100000, calls = 0, state = { ...ready, connected: false };
  const updater = initBuiltinUpdater({ chrome: browser, now: () => time, offscreen: async () => { calls++; return state; } });
  assert.equal((await updater.status()).connected, false); assert.equal(calls, 1);
  state = { ...ready, autoInstall: true };
  time += 15000;
  const current = await updater.status();
  assert.equal(current.connected, true); assert.equal(current.autoInstall, true); assert.equal(calls, 2);
});

test('concurrent folder status reads coalesce but cannot erase a lost-read recovery gate', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const updater = initBuiltinUpdater({ chrome: browser, offscreen: async () => { calls++; return gate; } });
  const first = updater.refresh(), second = updater.refresh();
  release(ready); await first; await second; assert.equal(calls, 1);
  const recovering = initBuiltinUpdater({ chrome: browser, offscreen: async () => { throw new Error('worker disconnected'); } });
  const lost = await recovering.status(); assert.equal(lost.initialized, false); assert.equal(lost.uncertain, true); assert.equal(recovering.isApplying(), true);
});

test('automatic installation intent is forwarded without treating manual installation as opt-in', async () => {
  const calls = [], updater = initBuiltinUpdater({ chrome: browser, offscreen: async (type, payload) => { calls.push({ type, payload }); return ready; } });
  await updater.refresh();
  const release = { version: '2.4.0', prerelease: false };
  await updater.update(release, { automatic: true });
  assert.deepEqual(calls.at(-1), { type: 'folder-install', payload: { release, automatic: true } });
});

test('a pre-install status response cannot overwrite a newer verified installation', async () => {
  let releaseRead, reads = 0;
  const slow = new Promise((resolve) => { releaseRead = resolve; }), calls = [];
  const updater = initBuiltinUpdater({ chrome: browser, offscreen: async (type) => {
    calls.push(type);
    if (type === 'folder-state') return ++reads === 2 ? slow : ready;
    return { ...ready, installedVersion: '2.4.0', requiresReload: true, state: 'updated' };
  } });
  await updater.refresh();
  const reading = updater.refresh(); await tick();
  const installing = updater.update({ version: '2.4.0' }); await tick();
  assert.equal(calls.filter((type) => type === 'folder-install').length, 0, 'The read and write observations must be serialized');
  assert.equal(updater.isApplying(), true);
  releaseRead(ready); await reading; await installing;
  const current = await updater.status(); assert.equal(current.installedVersion, '2.4.0'); assert.equal(current.requiresReload, true); assert.equal(updater.isApplying(), true);
});

test('a lost install reply always requests a fresh post-dispatch state before admitting downloads', async () => {
  let finishOld, finishNew, reads = 0;
  const old = new Promise((resolve) => { finishOld = resolve; }), post = new Promise((resolve) => { finishNew = resolve; }), calls = [];
  const updater = initBuiltinUpdater({ chrome: browser, offscreen: async (type) => {
    calls.push(type);
    if (type === 'folder-install') throw new Error('The worker reply was lost');
    reads++; return reads === 1 ? ready : reads === 2 ? old : post;
  } });
  await updater.refresh(); const reading = updater.refresh(); await tick();
  const installing = updater.update({ version: '2.4.0' });
  finishOld(ready); await reading; await tick();
  assert.deepEqual(calls, ['folder-state', 'folder-state', 'folder-install', 'folder-state']);
  assert.equal(updater.isApplying(), true);
  finishNew({ ...ready, state: 'updated', installedVersion: '2.4.0', requiresReload: true });
  const result = await installing; assert.equal(result.requiresReload, true); assert.equal(updater.isApplying(), true);
});

test('forgetting a folder is observed after earlier reads and cannot resurrect a stale connection', async () => {
  let finishRead, reads = 0;
  const old = new Promise((resolve) => { finishRead = resolve; });
  const updater = initBuiltinUpdater({ chrome: browser, offscreen: async (type) => type === 'folder-forget' ? { ...ready, connected: false, autoInstall: false, state: 'not-connected' } : ++reads === 2 ? old : ready });
  await updater.refresh(); const reading = updater.refresh(); await tick();
  const forgetting = updater.forget(); finishRead(ready); await reading; await forgetting;
  assert.equal((await updater.status()).connected, false);
});
