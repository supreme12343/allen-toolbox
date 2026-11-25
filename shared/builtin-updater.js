import { compareVersions } from './update-meta.js';

export function initBuiltinUpdater({ chrome: browser = globalThis.chrome, offscreen, busy = () => false, now = Date.now } = {}) {
  const activeVersion = browser.runtime.getManifest().version;
  let cached = { kind: 'folder', connected: false, installed: false, autoInstall: false, state: 'not-connected', installedVersion: activeVersion, requiresReload: false, uncertain: false };
  let operations = Promise.resolve(), pending = 0, checked = false, refreshedAt = 0, reading = null;
  function remember(result) {
    if (!result || result.kind !== 'folder' || typeof result.connected !== 'boolean') throw new Error('The folder updater returned an invalid status');
    cached = { ...result, installed: result.connected, requiresReload: result.requiresReload === true,
      uncertain: result.recoveryPending === true || result.state === 'needs-recovery' };
    checked = true;
    refreshedAt = now();
    if (cached.installedVersion && compareVersions(cached.installedVersion, activeVersion) < 0) cached.requiresReload = true;
    return { ...cached, applying: pending > 0, initialized: checked };
  }
  function serialize(operation) {
    const task = operations.then(operation);
    operations = task.catch(() => {});
    return task;
  }
  async function readFresh() {
    try { return remember(await offscreen('folder-state')); }
    catch (error) {
      checked = false;
      cached = { ...cached, uncertain: true, error: error.message, state: 'needs-recovery' };
      return { ...cached, applying: pending > 0, initialized: false };
    }
  }
  async function refresh() {
    if (reading) return reading;
    const task = serialize(readFresh);
    reading = task;
    try { return await task; } finally { if (reading === task) reading = null; }
  }
  async function mutate(type, release, options) {
    pending++;
    const task = serialize(async () => {
      if (!checked) await readFresh();
      if (type === 'folder-install' && (cached.uncertain || cached.requiresReload || !checked)) return {
        ...cached, state: 'deferred', error: cached.requiresReload ? 'RELOAD_REQUIRED' : 'RECOVERY_PENDING',
      };
      if (await busy()) return { ...cached, state: 'deferred', error: 'BUSY', message: 'Close script editors and wait until active downloads finish.' };
      try { return remember(await offscreen(type, release ? { release, ...(options ? { automatic: options.automatic === true } : {}) } : {})); }
      catch (error) {
        // A lost worker may have left a durable transaction. Keep admission closed
        // until the recovery status confirms what was actually committed.
        cached = { ...cached, uncertain: true, recoveryPending: true, state: 'needs-recovery', error: error.message };
        // This read must be post-dispatch, never a coalesced earlier snapshot.
        await readFresh();
        return { ...cached, applying: false };
      }
    });
    try { return await task; } finally { pending--; }
  }
  return { status: async () => !checked || now() - refreshedAt >= 15000 ? refresh() : ({ ...cached, applying: pending > 0, initialized: checked }), refresh,
    update: (release, options) => mutate('folder-install', release, options), recover: () => mutate('folder-recover'),
    forget: async () => {
      if (pending || cached.uncertain || cached.requiresReload) throw new Error('Finish or recover the folder update before forgetting access');
      return serialize(async () => {
        if (!checked) await readFresh();
        if (pending || cached.uncertain || cached.requiresReload || !checked) throw new Error('Finish or recover the folder update before forgetting access');
        return remember(await offscreen('folder-forget'));
      });
    },
    isApplying: () => !checked || pending > 0 || cached.uncertain || cached.requiresReload };
}
