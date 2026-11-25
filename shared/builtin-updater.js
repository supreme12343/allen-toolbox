import { compareVersions } from './update-meta.js';

export function initBuiltinUpdater({ chrome: browser = globalThis.chrome, offscreen, busy = () => false } = {}) {
  const activeVersion = browser.runtime.getManifest().version;
  let cached = { kind: 'folder', connected: false, installed: false, autoInstall: false, state: 'not-connected', installedVersion: activeVersion, requiresReload: false, uncertain: false };
  let operations = Promise.resolve(), pending = 0, checked = false;
  function remember(result) {
    if (!result || result.kind !== 'folder' || typeof result.connected !== 'boolean') throw new Error('The folder updater returned an invalid status');
    cached = { ...result, installed: result.connected, requiresReload: result.requiresReload === true,
      uncertain: result.recoveryPending === true || result.state === 'needs-recovery' };
    checked = true;
    if (cached.installedVersion && compareVersions(cached.installedVersion, activeVersion) < 0) cached.requiresReload = true;
    return { ...cached, applying: pending > 0, initialized: checked };
  }
  async function refresh() {
    try { return remember(await offscreen('folder-state')); }
    catch (error) { cached = { ...cached, error: error.message, state: cached.uncertain ? 'needs-recovery' : 'error' }; return { ...cached, applying: pending > 0 }; }
  }
  async function mutate(type, release) {
    pending++;
    const task = operations.then(async () => {
      if (await busy()) return { ...cached, state: 'deferred', error: 'Close script editors and wait until active downloads finish.' };
      try { return remember(await offscreen(type, release ? { release } : {})); }
      catch (error) {
        // A lost worker may have left a durable transaction. Keep admission closed
        // until the recovery status confirms what was actually committed.
        cached = { ...cached, uncertain: true, recoveryPending: true, state: 'needs-recovery', error: error.message };
        await refresh();
        return { ...cached, applying: false };
      }
    });
    operations = task.catch(() => {});
    try { return await task; } finally { pending--; }
  }
  return { status: async () => ({ ...cached, applying: pending > 0, initialized: checked }), refresh,
    update: (release) => mutate('folder-install', release), recover: () => mutate('folder-recover'),
    forget: async () => { if (pending || cached.uncertain || cached.requiresReload) throw new Error('Finish or recover the folder update before forgetting access'); return remember(await offscreen('folder-forget')); },
    isApplying: () => !checked || pending > 0 || cached.uncertain || cached.requiresReload };
}
