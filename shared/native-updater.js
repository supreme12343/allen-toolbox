import { compareVersions, versionParts } from './update-meta.js';

export const NATIVE_UPDATER_HOST = 'com.supreme.allen_toolbox_updater';
const STATES = new Set(['up-to-date', 'available', 'updated', 'deferred', 'error']);

export function initNativeUpdater({ chrome: browser = globalThis.chrome, busy = () => false, timeout = 200000 } = {}) {
  const activeVersion = browser.runtime.getManifest().version;
  let current = { installed: false, state: 'not-installed', installedVersion: activeVersion, availableVersion: null, error: '' };
  let queue = Promise.resolve(), pendingUpdates = 0, uncertain = false;
  const status = () => ({ ...current, applying: pendingUpdates > 0 || uncertain, uncertain, requiresReload: current.installed && compareVersions(current.installedVersion, activeVersion) > 0 });

  async function invoke(command) {
    const update = command === 'update';
    if (update) pendingUpdates++;
    const task = queue.then(async () => {
      if (!browser.runtime.sendNativeMessage) return status();
      const active = !!(await busy());
      if (update && active) return { ...status(), state: 'deferred', error: 'Automatic installation waits until active downloads finish.' };
      let timer;
      try {
        if (update) uncertain = true;
        const response = await Promise.race([browser.runtime.sendNativeMessage(NATIVE_UPDATER_HOST, { protocol: 1, command, busy: active }),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('The Windows updater did not respond in time')), timeout); })]);
        if (response?.protocol !== 1 || response.installed !== true || !STATES.has(response.state) || response.extensionId !== browser.runtime.id) throw new Error('The Windows updater is not configured for this extension installation');
        versionParts(response.installedVersion);
        if (response.availableVersion != null) versionParts(response.availableVersion);
        current = { installed: true, state: response.state, installedVersion: response.installedVersion,
          availableVersion: response.availableVersion || null, lastCheckedAt: Number.isFinite(response.lastCheckedAt) ? response.lastCheckedAt : 0,
          lastUpdatedAt: Number.isFinite(response.lastUpdatedAt) ? response.lastUpdatedAt : 0,
          error: typeof response.error === 'string' ? response.error.slice(0, 500) : '' };
        uncertain = response.error === 'update-in-progress';
      } catch (error) {
        current = { ...current, installed: false, state: 'not-installed', error: 'Install or attach the bundled Windows updater once to enable automatic installation.' };
        if (/not found|Specified native messaging host not found|Access to the specified native/i.test(error.message || '')) uncertain = false;
        if (!/native messaging host|native host|not found|not configured|Specified native|Access to/i.test(error.message || '')) current.error = String(error.message || 'Windows updater unavailable').slice(0, 500);
      } finally { clearTimeout(timer); }
      return status();
    });
    queue = task.catch(() => {});
    try { const result = await task; return { ...result, applying: pendingUpdates > (update ? 1 : 0) || uncertain }; }
    finally { if (update) pendingUpdates--; }
  }

  return { status: async () => status(), refresh: () => invoke('status'), check: () => invoke('check'), update: () => invoke('update'), isApplying: () => pendingUpdates > 0 || uncertain || status().requiresReload };
}
