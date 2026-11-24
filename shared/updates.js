import { readBody } from './download.js';
import { OFFICIAL_REPOSITORY, githubRepository, githubRelease, versionParts, compareVersions } from './update-meta.js';
import { initNativeUpdater } from './native-updater.js';
export { OFFICIAL_REPOSITORY, githubRepository, githubRelease, versionParts, compareVersions } from './update-meta.js';

export const UPDATE_ALARM = 'allen-toolbox-github-updates';
export const UPDATE_RELOAD_ALARM = 'allen-toolbox-updater-reload';
const NOTICE = 'allen-toolbox-update';
const STORAGE = 'githubUpdates';
const HOUR = 60 * 60 * 1000;

/** GitHub supplies metadata and ZIPs, never replacement code executed by the extension. */
export function initUpdates({ chrome: browser = globalThis.chrome, fetch: request = globalThis.fetch,
  now = Date.now, timeout = 20000, acquireRequest, releaseRequest, busy = () => false, nativeUpdater } = {}) {
  const installedVersion = browser.runtime.getManifest().version;
  const native = nativeUpdater || initNativeUpdater({ chrome: browser, busy });
  let reloadTimer;
  const attemptReload = async () => {
    const result = await native.status();
    if (result.uncertain) { await browser.alarms.create(UPDATE_RELOAD_ALARM, { delayInMinutes: 1 }); return; }
    if (!result.requiresReload) { await browser.alarms.clear(UPDATE_RELOAD_ALARM); return; }
    if (await busy()) { await browser.alarms.create(UPDATE_RELOAD_ALARM, { delayInMinutes: 1 }); return; }
    await browser.alarms.clear(UPDATE_RELOAD_ALARM);
    browser.runtime.reload();
  };
  const reloadLater = () => {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => { reloadTimer = null; attemptReload().catch(() => {}); }, 500);
  };
  let record = { repository: OFFICIAL_REPOSITORY, automatic: true, checkedAt: 0, retryAt: 0, metadata: null, etag: '', error: '', notified: '' };
  let revision = 0, flight = null, active = null, sequence = 0, writes = Promise.resolve();
  const commit = (run) => { const next = writes.then(run); writes = next.catch(() => {}); return next; };
  const store = async (next) => { await browser.storage.local.set({ [STORAGE]: next }); record = next; };
  const ready = browser.storage.local.get(STORAGE).then(async (saved) => {
    const value = saved[STORAGE];
    if (!value || typeof value !== 'object') return;
    const sameSource = value.repository === OFFICIAL_REPOSITORY;
    record = { ...record, ...value, repository: OFFICIAL_REPOSITORY, automatic: value.automatic !== false };
    if (!sameSource) Object.assign(record, { metadata: null, etag: '', checkedAt: 0, retryAt: 0, notified: '', error: '' });
    try { if (record.metadata) githubRelease(record.metadata, OFFICIAL_REPOSITORY); }
    catch (error) { Object.assign(record, { metadata: null, etag: '', checkedAt: 0, retryAt: 0, error: 'Saved release metadata was invalid and will be refreshed.' }); }
    if (!sameSource) await store(record);
  }).catch(() => { record.error = 'Update settings could not be restored.'; });

  function status() {
    let latest = null;
    try { if (record.metadata) latest = githubRelease(record.metadata, record.repository); } catch (error) {}
    return { repository: record.repository, automatic: record.automatic, installedVersion, latest,
      available: !!latest && compareVersions(latest.version, installedVersion) > 0,
      checkedAt: record.checkedAt || 0, error: record.error || '', checking: !!flight };
  }

  async function schedule() {
    if (!record.automatic) { await browser.alarms.clear(UPDATE_ALARM); return; }
    const alarm = await browser.alarms.get(UPDATE_ALARM);
    if (!alarm || alarm.periodInMinutes !== 60) await browser.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  }

  async function configure({ repository, automatic }) {
    if (repository !== undefined && githubRepository(repository) !== OFFICIAL_REPOSITORY) throw new Error('The update source is fixed to the official ALLEN Toolbox repository');
    if (typeof automatic !== 'boolean') throw new Error('Choose whether automatic update checks are enabled');
    await ready;
    await commit(async () => {
      revision++; active?.abort();
      await store({ ...record, repository: OFFICIAL_REPOSITORY, automatic, error: '' });
    });
    await browser.notifications.clear(NOTICE).catch(() => {});
    await schedule();
    return { ...status(), native: await native.status() };
  }

  async function check({ force = false } = {}) {
    await ready;
    await writes;
    if (!force && (!record.automatic || now() < (record.retryAt || 0) || now() - (record.checkedAt || 0) < HOUR)) return status();
    if (flight) return flight;
    const snapshot = { ...record }, generation = revision;
    flight = (async () => {
      const controller = new AbortController(); active = controller;
      const requestId = 'github-update:' + now() + ':' + sequence++;
      const release = () => releaseRequest?.(requestId);
      let rejectLease;
      const cancelLease = () => { Promise.resolve(release()).catch(() => {}); rejectLease?.(controller.signal.reason); };
      controller.signal.addEventListener('abort', cancelLease, { once: true });
      const timer = setTimeout(() => controller.abort(), timeout);
      let metadata = snapshot.metadata, etag = snapshot.etag, error = '', retryAt = 0, response;
      try {
        const api = 'https://api.github.com/repos/' + OFFICIAL_REPOSITORY.slice('https://github.com/'.length) + '/releases/latest';
        // Join the same request queue as GM requests, with no captured headers or credentials.
        if (acquireRequest) {
          const acquiring = Promise.resolve(acquireRequest({ url: api, requestId, requestHeaders: [] }));
          acquiring.then(() => { if (controller.signal.aborted) return release(); }).catch(() => {});
          await Promise.race([acquiring, new Promise((resolve, reject) => { rejectLease = reject; })]);
          rejectLease = null;
        }
        controller.signal.throwIfAborted();
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (metadata && etag && etag.length < 500 && !/[\r\n]/.test(etag)) headers['If-None-Match'] = etag;
        response = await request(api, { headers, signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
        if (response.url && response.url !== api) throw new Error('GitHub redirected the official update check. Try again later.');
        if (response.status === 304) {
          if (!metadata) throw new Error('GitHub returned no cached release. Check again.');
        } else {
          if (response.status === 403 || response.status === 429) {
            const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
            const delay = Number(response.headers.get('retry-after')) * 1000;
            retryAt = Math.min(now() + 24 * HOUR, Math.max(now() + HOUR, Number.isFinite(reset) ? reset : 0, now() + (Number.isFinite(delay) ? delay : 0)));
            throw new Error('GitHub rate-limited this check. Automatic checks will retry later.');
          }
          if (response.status === 404) throw new Error('No public release was found at the official update source. Try again later.');
          if (!response.ok) throw new Error('GitHub update check failed (HTTP ' + response.status + ').');
          if (!/\bjson\b/i.test(response.headers.get('content-type') || '')) throw new Error('GitHub returned non-JSON release metadata.');
          const body = await readBody(response, { signal: controller.signal, maxBytes: 512 * 1024, idleTimeout: timeout });
          let data;
          try { data = JSON.parse(await body.blob.text()); } catch (error) { throw new Error('GitHub returned invalid release metadata'); }
          const latest = githubRelease(data, snapshot.repository);
          metadata = { tag_name: latest.tag, html_url: latest.url, draft: false, prerelease: false,
            assets: latest.downloadUrl ? [{ name: latest.filename, browser_download_url: latest.downloadUrl, state: 'uploaded', size: latest.size }] : [] };
          etag = response.headers.get('etag') || '';
        }
      } catch (failure) {
        error = controller.signal.aborted ? 'The GitHub update check timed out. Try again.' : failure.code === 'DOWNLOAD_TOO_LARGE' ?
          'GitHub release metadata exceeded its 512 KiB safety limit.' : failure.name === 'TypeError' ?
          'Could not reach GitHub. Check your connection and try again.' : failure.message;
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort', cancelLease);
        controller.abort();
        try { if (response?.body && !response.body.locked) response.body.cancel().catch(() => {}); } catch (failure) {}
        if (active === controller) active = null;
        if (acquireRequest) await release();
      }
      await commit(async () => {
        if (generation === revision) await store({ ...record, metadata, etag, error, retryAt, checkedAt: now() });
      });
      const result = status();
      const nativeStatus = await native.refresh();
      if (generation === revision && !error && record.automatic && result.available && nativeStatus.installed) {
        const installed = await native.update();
        if (installed.requiresReload || installed.uncertain) { reloadLater(); return { ...status(), native: installed, checking: false }; }
      }
      if (generation === revision && !error && record.automatic && result.available && record.notified !== result.latest.version) {
        try {
          await browser.notifications.create(NOTICE, { type: 'basic', iconUrl: browser.runtime.getURL('icons/icon128.png'),
            title: 'ALLEN Toolbox update available', message: 'Version ' + result.latest.version + ' is ready. The bundled Windows updater can install it after one-time setup; otherwise download the ZIP.' });
          await commit(async () => { if (generation === revision) await store({ ...record, notified: result.latest.version }); });
          if (generation !== revision) await browser.notifications.clear(NOTICE);
        } catch (failure) { /* Update availability remains visible when notifications are disabled. */ }
      }
      return { ...status(), native: await native.status(), checking: false };
    })();
    try { return await flight; } finally { flight = null; }
  }

  async function download() {
    await ready;
    const result = status();
    if (!result.available || !result.latest.downloadUrl) throw new Error('No newer release ZIP is available. Check for updates first.');
    const downloadId = await browser.downloads.download({ url: result.latest.downloadUrl, filename: result.latest.filename, saveAs: true });
    if (!Number.isInteger(downloadId) || downloadId < 0) throw new Error('The browser did not accept the update ZIP download');
    return { downloadId, filename: result.latest.filename, queued: true };
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM) check().catch(() => {});
    if (alarm.name === UPDATE_RELOAD_ALARM) native.refresh().then(attemptReload).catch(() => {});
  });
  browser.notifications.onClicked.addListener((id) => {
    if (id !== NOTICE) return;
    ready.then(() => { const current = status(); if (current.available) return browser.tabs.create({ url: current.latest.url }); }).catch(() => {});
  });
  const start = () => ready.then(schedule).then(() => native.refresh()).then((result) => { if (result.requiresReload || result.uncertain) reloadLater(); return check(); }).catch(() => {});
  browser.runtime.onInstalled.addListener(start);
  browser.runtime.onStartup.addListener(start);
  start();
  return { status: async () => { await ready; return { ...status(), native: await native.status() }; }, configure, check, download,
    isApplying: () => native.isApplying(), install: async () => {
      const result = await native.update();
      if (result.requiresReload || result.uncertain) reloadLater();
      return result;
    } };
}
