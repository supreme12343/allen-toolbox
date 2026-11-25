import { readBody } from './download.js';
import { OFFICIAL_REPOSITORY, githubRepository, githubRelease, selectGithubRelease, versionParts, compareVersions, isBetaManifest, isNewerRelease } from './update-meta.js';
import { initNativeUpdater } from './native-updater.js';
import { WINDOWS_UPDATER_AVAILABLE, WINDOWS_UPDATER_PUBLISHER } from './native-updater-config.js';
export { OFFICIAL_REPOSITORY, githubRepository, githubRelease, versionParts, compareVersions } from './update-meta.js';

export const UPDATE_ALARM = 'allen-toolbox-github-updates';
export const UPDATE_RELOAD_ALARM = 'allen-toolbox-updater-reload';
export const UPDATE_INSTALL_ALARM = 'allen-toolbox-updater-install';
const NOTICE = 'allen-toolbox-update';
const STORAGE = 'githubUpdates';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const INSTALL_DELAYS = [1, 2, 4, 8, 15];
const BUSY_ERRORS = new Set(['BUSY', 'Close script editors and wait until active downloads finish.']);
const INSTALL_STATES = new Set(['', 'ready', 'updated', 'deferred', 'error', 'needs-permission', 'needs-recovery', 'not-connected', 'not-installed', 'available', 'up-to-date', 'paused', 'retry-exhausted']);
const emptyRetry = (lastInstallState = '') => ({ retryTag: '', retryIdentity: '', retryAttempt: 0, nextRetryAt: 0, lastInstallState });
const releaseIdentity = (latest) => latest ? latest.tag + ':' + latest.size + ':' + latest.signatureSize : '';
const sameRelease = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Release checks stay metadata-only unless an explicitly enabled updater applies a verified package. */
export function initUpdates({ chrome: browser = globalThis.chrome, fetch: request = globalThis.fetch,
  now = Date.now, timeout = 20000, acquireRequest, releaseRequest, busy = () => false, nativeUpdater } = {}) {
  const installedVersion = browser.runtime.getManifest().version;
  const manifest = browser.runtime.getManifest(), beta = isBetaManifest(manifest);
  const releaseOptions = { allowPrerelease: beta };
  const native = nativeUpdater || initNativeUpdater({ chrome: browser, busy, enabled: WINDOWS_UPDATER_AVAILABLE, publisherThumbprint: WINDOWS_UPDATER_PUBLISHER });
  let reloadTimer, reloadFlight = null, reloading = false;
  const attemptReload = () => {
    if (reloading) return Promise.resolve();
    const task = (reloadFlight || Promise.resolve()).catch(() => {}).then(async () => {
      if (reloading) return;
      for (let read = 0; read < 2; read++) {
        const result = await native.status();
        if (result.applying || result.uncertain || result.recoveryPending || result.kind === 'folder' && result.initialized === false) {
          await browser.alarms.create(UPDATE_RELOAD_ALARM, { delayInMinutes: 1 }); return;
        }
        if (!result.requiresReload || result.error || result.kind === 'folder' && !['ready', 'updated'].includes(result.state) || ['error', 'deferred'].includes(result.state)) {
          await browser.alarms.clear(UPDATE_RELOAD_ALARM); return;
        }
        if (read === 0 && await busy()) { await browser.alarms.create(UPDATE_RELOAD_ALARM, { delayInMinutes: 1 }); return; }
      }
      await browser.alarms.clear(UPDATE_RELOAD_ALARM);
      if (!reloading) { reloading = true; browser.runtime.reload(); }
    });
    reloadFlight = task;
    task.then(() => { if (reloadFlight === task) reloadFlight = null; }, () => { if (reloadFlight === task) reloadFlight = null; });
    return task;
  };
  const reloadLater = () => {
    if (reloadTimer || reloading) return;
    reloadTimer = setTimeout(() => { reloadTimer = null; attemptReload().catch(() => {}); }, 500);
  };
  const reloadIfNeeded = (result) => { if (result.requiresReload || result.uncertain || result.recoveryPending) reloadLater(); };
  let record = { repository: OFFICIAL_REPOSITORY, channel: beta ? 'beta' : 'stable', automatic: true, checkedAt: 0, retryAt: 0, metadata: null, etag: '', error: '', notified: '', ...emptyRetry() };
  let revision = 0, flight = null, installFlight = null, startFlight = null, active = null, sequence = 0, writes = Promise.resolve(), settingsRestored = false, installPaused = false;
  let flightForced = false, queuedForcedCheck = null;
  const commit = (run) => { const next = writes.then(run); writes = next.catch(() => {}); return next; };
  const store = async (next) => {
    try { await browser.storage.local.set({ [STORAGE]: next }); record = next; }
    catch (error) { installPaused = true; await browser.alarms.clear(UPDATE_INSTALL_ALARM).catch(() => {}); throw error; }
  };
  const ready = browser.storage.local.get(STORAGE).then(async (saved) => {
    const value = saved[STORAGE];
    if (!value || typeof value !== 'object' || Array.isArray(value)) { settingsRestored = true; return; }
    const sameSource = value.repository === OFFICIAL_REPOSITORY && (value.channel || 'stable') === record.channel;
    record = { ...record, ...value, repository: OFFICIAL_REPOSITORY, channel: beta ? 'beta' : 'stable', automatic: value.automatic !== false };
    let changed = !sameSource;
    if (!sameSource) Object.assign(record, { metadata: null, etag: '', checkedAt: 0, retryAt: 0, notified: '', error: '', ...emptyRetry() });
    try { if (record.metadata) githubRelease(record.metadata, OFFICIAL_REPOSITORY, releaseOptions); }
    catch (error) { changed = true; Object.assign(record, { metadata: null, etag: '', checkedAt: 0, retryAt: 0, error: 'Saved release metadata was invalid and will be refreshed.', ...emptyRetry() }); }
    if (!INSTALL_STATES.has(record.lastInstallState)) { record.lastInstallState = ''; changed = true; }
    if (hasRetry() && !validRetry(status().latest)) { Object.assign(record, emptyRetry()); changed = true; }
    if (changed) await store(record);
    settingsRestored = true;
  }).catch(() => { record.error = 'Update settings could not be restored.'; });

  function status() {
    let latest = null;
    try { if (record.metadata) latest = githubRelease(record.metadata, record.repository, releaseOptions); } catch (error) {}
    return { repository: record.repository, channel: record.channel, automatic: record.automatic, installedVersion, versionName: manifest.version_name || installedVersion, latest,
      available: !!latest && isNewerRelease(latest, manifest),
      checkedAt: record.checkedAt || 0, error: record.error || (installPaused ? 'Automatic installation is paused because update state could not be confirmed or saved.' : ''), checking: !!flight,
      nextRetryAt: installPaused ? 0 : record.nextRetryAt || 0, lastInstallState: installPaused ? 'paused' : record.lastInstallState || '' };
  }

  function hasRetry() { return !!(record.retryTag || record.retryIdentity || record.retryAttempt || record.nextRetryAt); }

  function validRetry(latest) {
    return record.automatic && latest && isNewerRelease(latest, manifest) && record.retryTag === latest.tag && record.retryIdentity === releaseIdentity(latest) &&
      Number.isInteger(record.retryAttempt) && record.retryAttempt >= 1 && record.retryAttempt <= INSTALL_DELAYS.length &&
      Number.isSafeInteger(record.nextRetryAt) && record.nextRetryAt >= 0 && record.nextRetryAt <= now() + 15 * MINUTE &&
      (record.nextRetryAt > 0 || record.retryAttempt === INSTALL_DELAYS.length && record.lastInstallState === 'retry-exhausted');
  }

  function automaticEligible(latest, connected) {
    if (!settingsRestored || installPaused || !record.automatic || !latest || !isNewerRelease(latest, manifest) || connected.requiresReload || connected.uncertain || connected.recoveryPending || connected.initialized === false) return false;
    if (connected.kind !== 'folder') return connected.installed === true && !connected.error;
    const url = OFFICIAL_REPOSITORY + '/releases/download/' + latest.tag + '/' + latest.filename;
    if (!connected.connected || connected.autoInstall !== true || connected.permission !== 'granted' || latest.downloadUrl !== url || latest.signatureUrl !== url + '.sig') return false;
    // DOWNLOAD_FAILED is a pre-write failure. Unknown errors, journals and validation failures must pause, never retry.
    return ['ready', 'deferred'].includes(connected.state) && (!connected.error || BUSY_ERRORS.has(connected.error)) || connected.state === 'error' && connected.error === 'DOWNLOAD_FAILED';
  }

  async function armRetry() {
    if (!record.nextRetryAt) { await browser.alarms.clear(UPDATE_INSTALL_ALARM); return; }
    const alarm = await browser.alarms.get(UPDATE_INSTALL_ALARM), scheduled = alarm?.scheduledTime ?? alarm?.when;
    const expected = scheduled === record.nextRetryAt;
    const restoredOverdue = record.nextRetryAt <= now() && Number.isFinite(scheduled) && scheduled > now();
    if (!alarm || alarm.periodInMinutes || !expected && !restoredOverdue) {
      await browser.alarms.create(UPDATE_INSTALL_ALARM, { when: Math.max(record.nextRetryAt, now() + MINUTE) });
    }
  }

  async function syncRetry(connected, generation = revision) {
    if (!settingsRestored) return;
    await commit(async () => {
      if (generation !== revision) return;
      if (installPaused) { await browser.alarms.clear(UPDATE_INSTALL_ALARM); return; }
      if (hasRetry() && (connected.kind !== 'folder' || !validRetry(status().latest) || !automaticEligible(status().latest, connected))) {
        await store({ ...record, ...emptyRetry('paused') });
      }
      await armRetry();
    });
  }

  async function saveInstallState(selected, connected, generation, attempt = 0, automatic = false) {
    await commit(async () => {
      if (generation !== revision || !sameRelease(selected, status().latest)) return;
      const state = INSTALL_STATES.has(connected.state) ? connected.state : 'paused';
      let retry = emptyRetry(state);
      if (automatic && connected.kind === 'folder' && automaticEligible(selected, connected) && (connected.state === 'deferred' || connected.error === 'DOWNLOAD_FAILED')) {
        retry = { retryTag: selected.tag, retryIdentity: releaseIdentity(selected), retryAttempt: Math.min(attempt + 1, INSTALL_DELAYS.length),
          nextRetryAt: attempt < INSTALL_DELAYS.length ? now() + INSTALL_DELAYS[attempt] * MINUTE : 0,
          lastInstallState: attempt < INSTALL_DELAYS.length ? state : 'retry-exhausted' };
      }
      await store({ ...record, ...retry });
      await armRetry();
    });
  }

  function installSelected(selected, { automatic = false, generation = revision, retry = false, reset = false } = {}) {
    const task = (installFlight || Promise.resolve()).catch(() => {}).then(async () => {
      await ready; await writes;
      if (!settingsRestored) throw new Error('Update settings could not be restored. Installation is paused.');
      if (!sameRelease(selected, status().latest) || automatic && generation !== revision) return native.status();
      const connected = await native.status();
      await writes;
      if (!sameRelease(selected, status().latest) || automatic && generation !== revision) return connected;
      if (automatic && !automaticEligible(selected, connected)) { await syncRetry(connected, generation); return connected; }
      if (automatic && !reset && (retry ? !validRetry(selected) || !record.nextRetryAt || now() < record.nextRetryAt : hasRetry())) {
        await syncRetry(connected, generation); return connected;
      }
      if (connected.requiresReload || connected.uncertain || connected.recoveryPending || connected.initialized === false) {
        reloadIfNeeded(connected); await syncRetry(connected, generation); return connected;
      }
      const attempt = automatic && retry ? record.retryAttempt : 0;
      if (connected.applying || native.isApplying()) {
        if (automatic) await saveInstallState(selected, { ...connected, state: 'deferred', error: 'BUSY' }, generation, attempt, true);
        return connected;
      }
      // Reserve install intent separately from read-only refreshes, then recheck preferences after pending writes.
      await commit(async () => {
        if (automatic && generation !== revision) return;
        if (reset && hasRetry()) await store({ ...record, ...emptyRetry() });
        else if (automatic && retry) await store({ ...record });
        await browser.alarms.clear(UPDATE_INSTALL_ALARM);
      });
      if (!sameRelease(selected, status().latest) || automatic && (generation !== revision || !record.automatic)) return connected;
      let installed;
      try { installed = await native.update(selected, { automatic }); }
      catch (error) { await saveInstallState(selected, { state: 'paused' }, generation); throw error; }
      reloadIfNeeded(installed);
      await saveInstallState(selected, installed, automatic ? generation : revision, attempt, automatic);
      return installed;
    }).catch(async (error) => {
      if (automatic && generation === revision && sameRelease(selected, status().latest)) {
        installPaused = true;
        await saveInstallState(selected, { state: 'paused' }, generation).catch(() => {});
        await browser.alarms.clear(UPDATE_INSTALL_ALARM).catch(() => {});
      }
      throw error;
    });
    installFlight = task;
    task.then(() => { if (installFlight === task) installFlight = null; }, () => { if (installFlight === task) installFlight = null; });
    return task;
  }

  async function retryInstall() {
    await ready; await writes;
    if (!settingsRestored) return;
    const generation = revision, selected = status().latest;
    if (!validRetry(selected) || !record.nextRetryAt) { await syncRetry(await native.status(), generation); return; }
    let connected;
    try { connected = await native.refresh(); }
    catch (error) {
      if (generation === revision && sameRelease(selected, status().latest)) { installPaused = true; await saveInstallState(selected, { state: 'paused' }, generation); }
      return;
    }
    reloadIfNeeded(connected);
    await syncRetry(connected, generation);
    return installSelected(selected, { automatic: true, generation, retry: true });
  }

  async function schedule() {
    if (!settingsRestored) return;
    if (!record.automatic) { await browser.alarms.clear(UPDATE_ALARM); await browser.alarms.clear(UPDATE_INSTALL_ALARM); return; }
    const alarm = await browser.alarms.get(UPDATE_ALARM);
    if (!alarm || alarm.periodInMinutes !== 60) await browser.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  }

  async function configure({ repository, automatic }) {
    if (repository !== undefined && githubRepository(repository) !== OFFICIAL_REPOSITORY) throw new Error('The update source is fixed to the official ALLEN Toolbox repository');
    if (typeof automatic !== 'boolean') throw new Error('Choose whether automatic update checks are enabled');
    await ready;
    if (!settingsRestored) throw new Error('Update settings could not be restored. Existing settings were not replaced.');
    await commit(async () => {
      revision++; active?.abort();
      await store({ ...record, repository: OFFICIAL_REPOSITORY, automatic, error: '', ...(!automatic ? emptyRetry('paused') : {}) });
    });
    await browser.notifications.clear(NOTICE).catch(() => {});
    await schedule();
    return { ...status(), native: await native.status() };
  }

  async function check({ force = false } = {}) {
    await ready;
    await writes;
    if (!settingsRestored) return status();
    if (!force && (!record.automatic || now() < (record.retryAt || 0) || now() - (record.checkedAt || 0) < HOUR)) return status();
    if (flight) {
      if (force && !flightForced) {
        if (!queuedForcedCheck) {
          const previous = flight;
          const queued = previous.catch(() => {}).then(() => check({ force: true }));
          queuedForcedCheck = queued;
          queued.then(() => { if (queuedForcedCheck === queued) queuedForcedCheck = null; }, () => { if (queuedForcedCheck === queued) queuedForcedCheck = null; });
        }
        return queuedForcedCheck;
      }
      return flight;
    }
    flightForced = force;
    const snapshot = { ...record };
    let generation = revision;
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
        const api = 'https://api.github.com/repos/' + OFFICIAL_REPOSITORY.slice('https://github.com/'.length) + (beta ? '/releases?per_page=30' : '/releases/latest');
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
          const latest = selectGithubRelease(data, snapshot.repository, releaseOptions);
          metadata = { tag_name: latest.tag, html_url: latest.url, draft: false, prerelease: latest.prerelease,
            assets: latest.downloadUrl ? [{ name: latest.filename, browser_download_url: latest.downloadUrl, state: 'uploaded', size: latest.size }] : [] };
          if (latest.signatureUrl) metadata.assets.push({ name: latest.filename + '.sig', browser_download_url: latest.signatureUrl, state: 'uploaded', size: latest.signatureSize });
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
        if (generation !== revision) return;
        const latest = metadata ? githubRelease(metadata, record.repository, releaseOptions) : null;
        const changed = !sameRelease(status().latest, latest);
        if (changed) generation = ++revision;
        await store({ ...record, metadata, etag, error, retryAt, checkedAt: now(), ...(changed ? emptyRetry() : {}) });
        if (changed) await browser.alarms.clear(UPDATE_INSTALL_ALARM);
      });
      const result = status();
      let nativeStatus = await native.refresh({ force });
      if (force && !error && generation === revision) installPaused = false;
      reloadIfNeeded(nativeStatus);
      await syncRetry(nativeStatus, generation);
      if (generation === revision && !error && automaticEligible(result.latest, nativeStatus)) {
        nativeStatus = await installSelected(result.latest, { automatic: true, generation, reset: force });
        if (nativeStatus.requiresReload || nativeStatus.uncertain || nativeStatus.recoveryPending) return { ...status(), native: nativeStatus, checking: false };
      }
      if (generation === revision && !error && record.automatic && result.available && record.notified !== result.latest.tag) {
        try {
          await browser.notifications.create(NOTICE, { type: 'basic', iconUrl: browser.runtime.getURL('icons/icon128.png'),
            title: 'ALLEN Toolbox update available', message: 'Version ' + result.latest.version + (result.latest.prerelease ? ' BETA' : '') + ' is ready. Open Utilities to review the release and update options.' });
          await commit(async () => { if (generation === revision) await store({ ...record, notified: result.latest.tag }); });
          if (generation !== revision) await browser.notifications.clear(NOTICE);
        } catch (failure) { /* Update availability remains visible when notifications are disabled. */ }
      }
      return { ...status(), native: nativeStatus, checking: false };
    })();
    const completed = flight.finally(() => { if (flight === completed) { flight = null; flightForced = false; } });
    flight = completed;
    return completed;
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
    if (alarm.name === UPDATE_ALARM) return check().catch(() => {});
    if (alarm.name === UPDATE_INSTALL_ALARM) return retryInstall().catch(() => {});
    if (alarm.name === UPDATE_RELOAD_ALARM) return native.refresh().then(attemptReload).catch(() => {});
  });
  browser.notifications.onClicked.addListener((id) => {
    if (id !== NOTICE) return;
    ready.then(() => { const current = status(); if (current.available) return browser.tabs.create({ url: current.latest.url }); }).catch(() => {});
  });
  const start = () => {
    if (startFlight) return startFlight;
    const task = (async () => {
      await ready; await writes; await schedule();
      const generation = revision;
      const connected = await native.refresh();
      reloadIfNeeded(connected);
      await syncRetry(connected, generation);
      if (generation === revision && connected.kind === 'folder' && now() - (record.checkedAt || 0) < HOUR && automaticEligible(status().latest, connected)) {
        await installSelected(status().latest, { automatic: true, generation, retry: !!record.nextRetryAt });
      }
      return check();
    })().catch(() => {});
    startFlight = task;
    task.then(() => { if (startFlight === task) startFlight = null; });
    return task;
  };
  browser.runtime.onInstalled.addListener(start);
  browser.runtime.onStartup.addListener(start);
  start();
  return { status: async ({ refresh = false } = {}) => {
      await ready; await writes;
      const generation = revision;
      const connected = refresh ? await native.refresh({ force: true }) : await native.status();
      reloadIfNeeded(connected);
      await syncRetry(connected, generation);
      return { ...status(), native: connected };
    }, configure, check, download,
    isApplying: () => !!installFlight || native.isApplying(), install: async () => {
      await ready; await writes;
      const selected = status().latest;
      if (!selected) throw new Error('Check an official release before requesting installation');
      return installSelected(selected);
    }, recover: async () => {
      await ready; await writes;
      if (!native.recover) throw new Error('This build has no browser folder recovery backend');
      const result = await native.recover();
      reloadIfNeeded(result);
      return result;
    }, canSaveCompleted: async () => {
      let result = await native.status();
      if (result.kind === 'folder' && !result.initialized) result = await native.refresh();
      return !(result.applying || result.uncertain || result.recoveryPending || result.kind === 'folder' && !result.initialized);
    } };
}
