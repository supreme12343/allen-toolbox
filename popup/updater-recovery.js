(() => {
  'use strict';
  // Frozen, dependency-free recovery bootstrap. It must work when background.js and
  // every imported updater module fail to load; never add imports or background RPCs.
  const DB = 'allen-toolbox-folder-updater', KEY = 'singleton', LOCK = 'allen-folder-updater';
  const MARKER = '.allen-toolbox-updater.json', REPOSITORY = 'https://github.com/supreme12343/allen-toolbox';
  const MAX_BACKUP = 64 * 1024 * 1024, MAX_FILE = 96 * 1024 * 1024, MAX_FILES = 300;
  const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/, HASH = /^[a-f\d]{64}$/;
  const ROOTS = new Set(['content', 'gm', 'shared', 'popup', 'sandbox', 'icons', 'lib', 'plugins', 'scripts']);
  const ROOT_FILES = new Set(['manifest.json', 'background.js', 'offscreen.js', 'offscreen.html', 'README.md', 'LICENSE']);
  const status = document.getElementById('recovery-status'), details = document.getElementById('recovery-details');
  const recover = document.getElementById('recover-folder'), reload = document.getElementById('reload-extension'), reconnect = document.getElementById('reconnect-recovery');
  let database, config, journal, active = false, restored = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const fail = (message) => { throw new Error(message); };
  const assert = (condition, message) => { if (!condition) fail(message); };
  const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  function text(message, description = '') {
    if (status) status.textContent = message;
    if (details) details.textContent = description;
  }

  function controls() {
    if (recover) recover.disabled = active || !config?.handle || !journal || restored;
    if (reconnect) reconnect.disabled = active || !config?.handle || restored;
    if (reload) reload.disabled = active || !restored;
    if (status) status.setAttribute('aria-busy', String(active));
  }

  function safePath(path) {
    assert(typeof path === 'string' && path && path.length <= 512 && path === path.normalize('NFC') &&
      !/[\\<>:"|?*%#\x00-\x1f\x7f]/.test(path) && !/[\uD800-\uDFFF]/u.test(path) &&
      !/\.(?:exe|dll|com|cmd|bat|ps1|psm1|psd1|msi|vbs|wsf|sys|scr)$/i.test(path) &&
      (ROOT_FILES.has(path) || ROOTS.has(path.split('/')[0])) &&
      path.split('/').every((part) => part && part.length <= 255 && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^\.git$/i.test(part) &&
        !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part)),
    'The recovery journal contains an unsafe path. It was retained without writing that path.');
    return path;
  }

  function version(value) {
    assert(typeof value === 'string' && /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value) &&
      value.split('.').every((part) => Number(part) <= 65535) && value.split('.').some((part) => Number(part) > 0), 'The recovery version is invalid.');
  }

  function readRecords() {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(['state', 'journal'], 'readonly'), state = tx.objectStore('state').get(KEY), pending = tx.objectStore('journal').get(KEY);
      tx.oncomplete = () => resolve({ config: state.result, journal: pending.result || null });
      tx.onerror = tx.onabort = () => reject(new Error('The browser could not read the recovery database.'));
    });
  }

  function commitRestore(next) {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(['state', 'journal'], 'readwrite', { durability: 'strict' });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('Files were restored, but the recovery journal could not be cleared. Retry recovery before reloading.'));
      try { tx.objectStore('state').put(next, KEY); tx.objectStore('journal').delete(KEY); }
      catch (error) { try { tx.abort(); } catch (ignored) {} reject(error); }
    });
  }

  async function locate(handle, path, create = false) {
    const parts = safePath(path).split('/'), name = parts.pop(), traversed = []; let parent = handle;
    for (const part of parts) {
      parent = await parent.getDirectoryHandle(part, { create });
      assert(!parent.name || parent.name === part, 'A recovery folder has changed casing or ownership.');
      traversed.push(part); await inside(handle, parent, traversed);
    }
    const file = await parent.getFileHandle(name, { create });
    assert(!file.name || file.name === name, 'A recovery file has changed casing or ownership.');
    await inside(handle, file, [...parts, name]);
    return { parent, name, file };
  }

  async function inside(handle, entry, expected) {
    assert(typeof handle.resolve === 'function', 'The browser cannot prove that a recovery file remains inside the connected folder.');
    const relative = await handle.resolve(entry);
    assert(Array.isArray(relative) && relative.length === expected.length && relative.every((part, index) => part === expected[index]),
      'A recovery file or linked directory is outside the connected folder. No outside file is written.');
  }

  async function read(file, maximum = MAX_FILE) {
    const value = await file.getFile();
    assert(Number.isSafeInteger(value.size) && value.size <= maximum, 'A recovery file exceeds its safe size limit.');
    const bytes = new Uint8Array(await value.arrayBuffer());
    assert(bytes.byteLength === value.size && bytes.byteLength <= maximum, 'A recovery file changed while being read.');
    return bytes;
  }

  async function checkOwner(current, pending) {
    assert(current?.schema === 1 && UUID.test(current.profileId) && UUID.test(current.installationId) && HASH.test(current.markerHash) &&
      pending.profileId === current.profileId && pending.installationId === current.installationId && pending.markerHash === current.markerHash,
    'The recovery journal belongs to another profile or installation. No files were changed.');
    const file = await current.handle.getFileHandle(MARKER);
    await inside(current.handle, file, [MARKER]);
    const bytes = await read(file, 16 * 1024);
    let marker;
    try { marker = JSON.parse(decoder.decode(bytes)); } catch (error) { fail('The folder ownership marker is invalid. No files were changed.'); }
    assert(marker?.schema === 1 && marker.profileId === current.profileId && marker.installationId === current.installationId &&
      await digest(bytes) === current.markerHash, 'The folder ownership marker changed or belongs to another profile. No files were changed.');
  }

  function oldManifest(bytes, expectedVersion) {
    let value;
    try { value = JSON.parse(decoder.decode(bytes)); } catch (error) { fail('The original manifest in the recovery journal is invalid.'); }
    assert(value?.manifest_version === 3 && value.name === 'ALLEN Toolbox' && value.homepage_url === REPOSITORY &&
      value.version === expectedVersion && !own(value, 'key'), 'The original manifest does not match this extension and recovery version.');
  }

  async function validate(current, pending) {
    assert(pending?.schema === 1 && Array.isArray(pending.entries) && pending.entries.length > 0 && pending.entries.length <= MAX_FILES &&
      pending.fromVersion === current.installedVersion && Number.isSafeInteger(pending.createdAt) && pending.createdAt >= 0 &&
      current.baseline && typeof current.baseline === 'object' && !Array.isArray(current.baseline) &&
      Object.keys(current.baseline).length > 0 && Object.keys(current.baseline).length <= MAX_FILES, 'The recovery journal schema is invalid.');
    version(pending.fromVersion); version(pending.toVersion);
    const seen = new Set(), originals = new Map(); let total = 0;
    for (const entry of pending.entries) {
      safePath(entry.path);
      assert(!seen.has(entry.path.toLowerCase()) && typeof entry.existed === 'boolean' && HASH.test(entry.newHash) &&
        (entry.created == null || typeof entry.created === 'boolean'), 'The recovery journal contains inconsistent file records.');
      seen.add(entry.path.toLowerCase());
      if (entry.existed) {
        assert(entry.bytes instanceof Blob && HASH.test(entry.hash) && own(current.baseline, entry.path) && current.baseline[entry.path] === entry.hash, 'An original recovery file is missing or not in the baseline.');
        total += entry.bytes.size;
        assert(total <= MAX_BACKUP, 'The recovery backup exceeds 64 MiB.');
        assert(await digest(new Uint8Array(await entry.bytes.arrayBuffer())) === entry.hash, 'An original recovery backup has corrupt bytes.');
        originals.set(entry.path, entry);
      } else assert(entry.bytes === null && entry.hash === null && !own(current.baseline, entry.path), 'A new recovery file is not consistently recorded.');
    }
    for (const [path, expected] of Object.entries(current.baseline)) {
      safePath(path);
      assert(HASH.test(expected) && originals.get(path)?.hash === expected, 'The recovery journal does not cover the entire original baseline. It was retained without restoring files.');
    }
    const manifest = pending.entries.find((entry) => entry.path === 'manifest.json');
    assert(manifest?.existed, 'The original extension manifest is missing from the recovery journal.');
    oldManifest(new Uint8Array(await manifest.bytes.arrayBuffer()), pending.fromVersion);
    await checkOwner(current, pending);
  }

  async function write(file, bytes) {
    let stream;
    try { stream = await file.createWritable({ keepExistingData: false }); await stream.write(bytes); await stream.close(); }
    catch (error) { try { await stream?.abort(); } catch (ignored) {} throw error; }
    const actual = await read(file);
    assert(actual.byteLength === bytes.byteLength && actual.every((byte, index) => byte === bytes[index]), 'An original file could not be verified after restoring it.');
  }

  async function verifyBaseline(current) {
    let total = 0;
    for (const [path, expected] of Object.entries(current.baseline)) {
      assert(HASH.test(expected), 'The restored baseline is invalid.');
      const bytes = await read((await locate(current.handle, path)).file, MAX_BACKUP - total); total += bytes.byteLength;
      assert(await digest(bytes) === expected, 'An original baseline file failed final verification. The journal is not cleared and reload is refused.');
    }
  }

  async function checkIdle() {
    const unknown = () => {
      const error = new Error('Activity status is unavailable or stale. Stop downloads and file activity before retrying; this page cannot verify other browsers, profiles or untracked file operations.');
      error.code = 'ACTIVITY_UNKNOWN'; return error;
    };
    if (!globalThis.chrome?.downloads?.search || !chrome.storage?.session?.get) throw unknown();
    let snapshot;
    try { snapshot = await chrome.storage.session.get('jobs'); } catch (error) { throw unknown(); }
    if (!snapshot || !Array.isArray(snapshot.jobs) || snapshot.jobs.length > 1000) throw unknown();
    let busy = false;
    for (const job of snapshot.jobs) {
      if (!job || typeof job.state !== 'string') throw unknown();
      if (['running', 'saving'].includes(job.state)) { busy = true; continue; }
      if (['done', 'error', 'cancelled'].includes(job.state)) continue;
      const complete = job.pendingReady;
      if (job.state !== 'ready' || complete?.state !== 'ready' || typeof complete.blobUrl !== 'string' ||
          !complete.blobUrl.startsWith('blob:' + chrome.runtime.getURL('')) || typeof complete.filename !== 'string' || !complete.filename ||
          !Number.isSafeInteger(complete.size) || complete.size < 0 || complete.bytes !== complete.size ||
          !Number.isSafeInteger(complete.total) || complete.total < 0 || complete.done !== complete.total) throw unknown();
    }
    let downloads;
    try { downloads = await chrome.downloads.search({ state: 'in_progress' }); } catch (error) { throw unknown(); }
    if (!Array.isArray(downloads)) throw unknown();
    if (busy || downloads.length) {
      const error = new Error('Recovery or reload is deferred while browser downloads or session jobs are running/saving. Finish or stop them before retrying; only this browser profile is checked.');
      error.code = 'ACTIVITY_BUSY'; throw error;
    }
  }

  async function restore(current, pending) {
    assert(await current.handle.queryPermission({ mode: 'readwrite' }) === 'granted', 'Folder permission is not granted. Click Reconnect and approve read/write access.');
    await validate(current, pending);
    await checkIdle();
    const rank = (path) => path === 'manifest.json' ? 4 : /^(?:background\.js|offscreen\.(?:js|html)|content\/|popup\/.*\.(?:js|html)|sandbox\/)/.test(path) ? 3 :
      path === 'scripts/scripts.json' || path === 'plugins/plugins.json' ? 2 : 1;
    const entries = [...pending.entries].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path, 'en'));
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      await checkOwner(current, pending);
      text('Restoring previous files (' + (index + 1) + '/' + entries.length + ')', 'Keep this page open. No extension reload occurs until every recorded original is verified.');
      if (entry.existed) await write((await locate(current.handle, entry.path, true)).file, new Uint8Array(await entry.bytes.arrayBuffer()));
      else {
        let found;
        try { found = await locate(current.handle, entry.path); } catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
        const bytes = await read(found.file);
        assert(entry.created === true && (await digest(bytes) === entry.newHash || bytes.byteLength === 0),
          'A newly introduced file has unrelated local bytes. It was not deleted; the recovery journal is retained.');
        await found.parent.removeEntry(found.name);
      }
    }
    for (const entry of entries) {
      if (!entry.existed) {
        try { await locate(current.handle, entry.path); fail('A new update file remains; recovery is incomplete.'); }
        catch (error) { if (error.name !== 'NotFoundError') throw error; }
      }
    }
    await verifyBaseline(current);
    await checkOwner(current, pending);
    oldManifest(await read((await locate(current.handle, 'manifest.json')).file, 512 * 1024), pending.fromVersion);
    const activeManifest = globalThis.chrome?.runtime?.getManifest?.();
    const next = { ...current, installedVersion: pending.fromVersion,
      reloadPending: !!activeManifest && (activeManifest.version !== pending.fromVersion || (activeManifest.version_name || '') !== (current.installedVersionName || '')),
      lastState: 'ready', lastError: '' };
    await commitRestore(next);
    config = next; journal = null; restored = true;
    text('Previous files restored and verified', 'The recovery journal is clear. Reload the extension to resume the previous version. No browser settings or native tools were used.');
  }

  async function refresh() {
    ({ config, journal } = await readRecords());
    if (!config?.handle) text('No connected folder', 'Open update setup to connect the folder currently loaded by this unpacked extension.');
    else if (!journal) text('No interrupted update is pending', 'This rescue page does not reload or change files without a complete verified recovery.');
    else {
      const granted = await config.handle.queryPermission({ mode: 'readwrite' });
      text('An interrupted folder update needs recovery', granted === 'granted' ?
        'Stop downloads and other file activity in every browser using this folder. Restore the recorded previous files; this page works without the background worker.' :
        'Click Reconnect to approve read/write access. No permission prompt was opened in the background.');
    }
    controls();
  }

  function userAction(rollback) {
    if (active || !config?.handle) return;
    let granted;
    // User activation is consumed here, before any await or Web Lock request.
    try { granted = config.handle.requestPermission({ mode: 'readwrite' }); }
    catch (error) { text('Folder permission could not be requested', 'Reconnect the folder from the setup page. The journal is unchanged.'); return; }
    active = true; controls();
    text(rollback ? 'Preparing verified recovery' : 'Reconnecting folder permission', 'No background or native updater is involved.');
    return (async () => {
      assert(await granted === 'granted', 'Read/write permission was not granted. No recovery files were changed.');
      await navigator.locks.request(LOCK, { mode: 'exclusive' }, async () => {
        ({ config, journal } = await readRecords());
        assert(config?.handle, 'The saved folder connection is no longer available.');
        if (rollback) { assert(journal, 'No interrupted update is pending.'); await restore(config, journal); }
        else await refresh();
      });
    })().catch((error) => {
      text('Recovery did not finish', error.name === 'NotAllowedError' ? 'Folder permission was revoked. The journal is retained; reconnect permission and retry.' :
        error.name === 'NotFoundError' ? 'The saved folder or ownership marker is unavailable. The journal is retained; no other folder is adopted automatically.' :
          'The journal is retained. ' + (error.message || 'An original file could not be restored.'));
    }).finally(() => { active = false; controls(); });
  }

  if (recover) recover.addEventListener('click', () => userAction(true));
  if (reconnect) reconnect.addEventListener('click', () => userAction(false));
  if (reload) reload.addEventListener('click', () => {
    if (!restored || active || journal) return;
    const verified = config; active = true; controls();
    text('Verifying restored files before reload', 'No permission prompt is opened. Waiting for any other folder writer to finish.');
    return navigator.locks.request(LOCK, { mode: 'exclusive' }, async () => {
      ({ config, journal } = await readRecords());
      assert(config?.handle && !journal && config.installedVersion === verified.installedVersion &&
        (config.installedVersionName || '') === (verified.installedVersionName || '') && config.markerHash === verified.markerHash &&
        JSON.stringify(config.baseline) === JSON.stringify(verified.baseline), 'Folder state changed after recovery. Reload was refused; review the current recovery state.');
      await checkOwner(config, config);
      await verifyBaseline(config);
      await checkOwner(config, config);
      oldManifest(await read((await locate(config.handle, 'manifest.json')).file, 512 * 1024), config.installedVersion);
      await checkIdle();
      chrome.runtime.reload();
    }).catch((error) => {
      const deferred = ['ACTIVITY_BUSY', 'ACTIVITY_UNKNOWN'].includes(error.code);
      if (!deferred) restored = false;
      text(deferred ? 'Reload is deferred' : 'Reload was refused', 'No extension reload occurred. ' + (error.message || 'The restored folder could not be reverified.'));
    })
      .finally(() => { active = false; controls(); });
  });
  controls();
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle || !globalThis.navigator?.locks?.request) {
    text('Browser recovery is unavailable', 'Use a Chromium extension page with IndexedDB, Web Crypto and Web Locks. No native helper is required.');
    return;
  }
  const opening = indexedDB.open(DB, 1);
  opening.onupgradeneeded = () => { for (const name of ['state', 'journal']) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name); };
  opening.onerror = opening.onblocked = () => text('Recovery database could not be opened', 'No folder files were changed. Keep the current folder and use the manual recovery instructions.');
  opening.onsuccess = () => {
    database = opening.result;
    database.onversionchange = () => { database.close(); active = true; controls(); text('Recovery database changed', 'Reopen this recovery page before attempting a restore.'); };
    refresh().catch(() => { text('Recovery state could not be read', 'No files were changed. The journal was not cleared.'); controls(); });
  };
})();
