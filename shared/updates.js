import { readBody } from './download.js';

export const UPDATE_ALARM = 'allen-toolbox-github-updates';
const NOTICE = 'allen-toolbox-update';
const STORAGE = 'githubUpdates';
const HOUR = 60 * 60 * 1000;

export function githubRepository(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const match = /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})\/?$/i.exec(value);
  const repo = match?.[2].replace(/\.git$/i, '');
  if (!match || !repo || repo === '.' || repo === '..') throw new Error('Use a public repository URL: https://github.com/OWNER/REPO');
  return 'https://github.com/' + match[1] + '/' + repo;
}

export function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value)) throw new Error('Invalid extension version');
  const parts = value.split('.').map(Number);
  if (parts.some((n) => n > 65535) || parts.every((n) => n === 0)) throw new Error('Invalid extension version');
  return parts;
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 4; i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function githubRelease(data, repository) {
  const repo = githubRepository(repository);
  if (!repo || !data || data.draft !== false || data.prerelease !== false || typeof data.tag_name !== 'string') throw new Error('GitHub returned invalid release metadata');
  const tag = data.tag_name, version = tag.replace(/^v/, '');
  versionParts(version);
  const url = repo + '/releases/tag/' + tag;
  if (typeof data.html_url !== 'string' || data.html_url.toLowerCase() !== url.toLowerCase()) throw new Error('The release does not belong to the configured repository');
  const filename = 'ALLEN-Toolbox-' + version + '.zip';
  const asset = Array.isArray(data.assets) ? data.assets.find((a) => a?.name === filename && a.state === 'uploaded') : null;
  const downloadUrl = repo + '/releases/download/' + tag + '/' + filename;
  if (asset && (typeof asset.browser_download_url !== 'string' || asset.browser_download_url.toLowerCase() !== downloadUrl.toLowerCase() ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0)) throw new Error('The release ZIP has an invalid download URL or size');
  return { version, tag, url, filename, downloadUrl: asset ? asset.browser_download_url : '', size: asset?.size || 0 };
}

/** GitHub supplies metadata and ZIPs, never replacement code executed by the extension. */
export function initUpdates({ chrome: browser = globalThis.chrome, fetch: request = globalThis.fetch,
  now = Date.now, timeout = 20000, acquireRequest, releaseRequest } = {}) {
  const installedVersion = browser.runtime.getManifest().version;
  let defaultRepository = '';
  try { defaultRepository = githubRepository(browser.runtime.getManifest().homepage_url); } catch (error) {}
  let record = { repository: defaultRepository, automatic: !!defaultRepository, checkedAt: 0, retryAt: 0, metadata: null, etag: '', error: '', notified: '' };
  let revision = 0, flight = null, active = null, sequence = 0, writes = Promise.resolve();
  const commit = (run) => { const next = writes.then(run); writes = next.catch(() => {}); return next; };
  const store = async (next) => { await browser.storage.local.set({ [STORAGE]: next }); record = next; };
  const ready = browser.storage.local.get(STORAGE).then((saved) => {
    const value = saved[STORAGE];
    if (!value || typeof value !== 'object') return;
    try {
      const repository = githubRepository(value.repository);
      record = { ...record, ...value, repository, automatic: !!repository && value.automatic === true };
      if (record.metadata) githubRelease(record.metadata, repository);
    } catch (error) { record.metadata = null; record.etag = ''; record.error = 'Saved update settings are invalid. Save the repository again.'; }
  }).catch(() => { record.error = 'Update settings could not be read.'; });

  function status() {
    let latest = null;
    try { if (record.metadata) latest = githubRelease(record.metadata, record.repository); } catch (error) {}
    return { repository: record.repository, automatic: record.automatic, installedVersion, latest,
      available: !!latest && compareVersions(latest.version, installedVersion) > 0,
      checkedAt: record.checkedAt || 0, error: record.error || '', checking: !!flight };
  }

  async function schedule() {
    if (!record.repository || !record.automatic) { await browser.alarms.clear(UPDATE_ALARM); return; }
    const alarm = await browser.alarms.get(UPDATE_ALARM);
    if (!alarm || alarm.periodInMinutes !== 60) await browser.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  }

  async function configure({ repository, automatic }) {
    const repo = githubRepository(repository);
    if (typeof automatic !== 'boolean') throw new Error('Choose whether automatic update checks are enabled');
    await ready;
    await commit(async () => {
      revision++; active?.abort();
      const changed = repo.toLowerCase() !== record.repository.toLowerCase();
      await store({ ...record, repository: repo, automatic: !!repo && automatic,
        ...(changed ? { metadata: null, etag: '', checkedAt: 0, retryAt: 0, notified: '' } : {}), error: '' });
    });
    await browser.notifications.clear(NOTICE).catch(() => {});
    await schedule();
    return status();
  }

  async function check({ force = false } = {}) {
    await ready;
    await writes;
    if (!record.repository) { if (force) throw new Error('Save a public GitHub repository URL first'); return status(); }
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
        const api = 'https://api.github.com/repos/' + snapshot.repository.slice('https://github.com/'.length) + '/releases/latest';
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
        if (response.url && response.url !== api) throw new Error('GitHub redirected the update check. Verify the repository URL.');
        if (response.status === 304) {
          if (!metadata) throw new Error('GitHub returned no cached release. Check again.');
        } else {
          if (response.status === 403 || response.status === 429) {
            const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
            const delay = Number(response.headers.get('retry-after')) * 1000;
            retryAt = Math.min(now() + 24 * HOUR, Math.max(now() + HOUR, Number.isFinite(reset) ? reset : 0, now() + (Number.isFinite(delay) ? delay : 0)));
            throw new Error('GitHub rate-limited this check. Automatic checks will retry later.');
          }
          if (response.status === 404) throw new Error('No public release was found. Check the repository URL and publish a release first.');
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
          'Could not reach GitHub. Check your connection and repository URL.' : failure.message;
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
      if (generation === revision && !error && record.automatic && result.available && record.notified !== result.latest.version) {
        try {
          await browser.notifications.create(NOTICE, { type: 'basic', iconUrl: browser.runtime.getURL('icons/icon128.png'),
            title: 'ALLEN Toolbox update available', message: 'Version ' + result.latest.version + ' is ready. Click to view the GitHub release. Unpacked installs require replacing files and reloading.' });
          await commit(async () => { if (generation === revision) await store({ ...record, notified: result.latest.version }); });
          if (generation !== revision) await browser.notifications.clear(NOTICE);
        } catch (failure) { /* Update availability remains visible when notifications are disabled. */ }
      }
      return { ...status(), checking: false };
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

  browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === UPDATE_ALARM) check().catch(() => {}); });
  browser.notifications.onClicked.addListener((id) => {
    if (id !== NOTICE) return;
    ready.then(() => { const current = status(); if (current.available) return browser.tabs.create({ url: current.latest.url }); }).catch(() => {});
  });
  const start = () => ready.then(schedule).then(() => check()).catch(() => {});
  browser.runtime.onInstalled.addListener(start);
  browser.runtime.onStartup.addListener(start);
  start();
  return { status: async () => { await ready; return status(); }, configure, check, download };
}
