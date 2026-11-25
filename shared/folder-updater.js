import { EXTENSION_ASSETS } from './package.js';
import { readBody } from './download.js';
import { UPDATE_REPOSITORY, MAX_UPDATE_ZIP_BYTES, MAX_UPDATE_EXPANDED_BYTES, MAX_UPDATE_FILES, RECOVERY_BOOTSTRAP,
  parseUpdatePackage, getUpdatePaths, validateUpdateFiles, validateUpdatePath, validateUpdateFilePath, validateUpdateVersion, compareUpdateVersions } from './update-package.js';

export const FOLDER_UPDATER_DB = 'allen-toolbox-folder-updater';
export const FOLDER_UPDATER_SCHEMA = 1;
export const FOLDER_UPDATER_LOCK = 'allen-folder-updater';
export const FOLDER_UPDATER_MARKER = '.allen-toolbox-updater.json';
const SINGLETON = 'singleton', MAX_BACKUP = 64 * 1024 * 1024, MAX_SIGNATURE = 8 * 1024;
const KEY_PATH = 'shared/update-public-key.json';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const HASH = /^[a-f\d]{64}$/;
const RELEASE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const MESSAGES = {
  SINGLE_PROFILE_REQUIRED: 'Acknowledge that only this browser profile may use this extension folder.',
  UNSUPPORTED_BROWSER: 'Folder updates require File System Access, IndexedDB, Web Crypto and Web Locks in a Chromium extension page.',
  PERMISSION_REQUIRED: 'Read/write access is not granted. Reconnect the folder from the setup page; no background permission prompt was opened.',
  WRONG_FOLDER: 'The selected folder is not the folder currently loaded by this unpacked extension. No extension code was changed.',
  PROFILE_CONFLICT: 'This folder is owned by another browser profile or installation. No files were changed.',
  LOCAL_CHANGES: 'A tracked file changed or a new release file collides with a local file. Use a reviewed manual update; local changes were not silently overwritten.',
  FOLDER_MOVED: 'The connected folder or its ownership marker is unavailable. Reconnect the current unpacked extension folder.',
  RECOVERY_PENDING: 'An interrupted folder update needs recovery before any further update or disconnect.',
  RECOVERY_INVALID: 'The recovery journal could not be validated. It was retained and no unvalidated files were restored.',
  RECOVERY_FAILED: 'Rollback did not finish. The durable journal was retained; restore from the standalone recovery page after reconnecting permission.',
  WRITE_FAILED: 'A file write failed. Check recovery status before reloading; rollback is complete only when the journal is clear and original bytes are verified.',
  STORAGE_FAILED: 'The updater database could not be read or saved. Recovery status is unknown until IndexedDB is readable; writes and reload must stay blocked.',
  JOURNAL_STORAGE_FAILED: 'The complete recovery backup could not be saved. No update files were written.',
  BACKUP_TOO_LARGE: 'The original runtime files exceed the 64 MiB recovery-backup limit. Use a manual update.',
  PUBLIC_KEY_INVALID: 'The bundled update public key is invalid; the update was refused.',
  PUBLIC_KEY_CHANGED: 'The signed update changes the pinned public key. Key rotation requires a reviewed manual update.',
  SIGNATURE_INVALID: 'The release ZIP signature is invalid. No archive was unpacked or written.',
  RELEASE_INVALID: 'Only an exact, newer official ALLEN Toolbox stable or BETA release may update this folder.',
  UPDATE_NOT_NEWER: 'The selected release is not newer than the connected folder version.',
  RELOAD_REQUIRED: 'The folder version changed. Reload the extension before attempting another update.',
  RECOVERY_BOOTSTRAP_CHANGED: 'Folder installation requires byte-identical standalone recovery HTML and JavaScript. Review and extract this release manually instead.',
  DOWNLOAD_FAILED: 'The signed release could not be downloaded. No extension files were changed.',
  DOWNLOAD_TOO_LARGE: 'The ZIP or signature exceeded its bounded download limit. No extension files were changed.',
  REDIRECT_INVALID: 'The release download redirected outside the allowed GitHub release-asset hosts.',
  REDIRECT_UNVERIFIABLE: 'This browser hides the release redirect target. The updater refused to follow it; use the manual ZIP update.',
  PROBE_CLEANUP_FAILED: 'The inert folder-verification probe could not be safely verified or removed. Reconnect permission and review the folder before retrying; no runtime code was changed.',
  PACKAGE_INVALID: 'The signed ZIP failed runtime-package validation. No extension files were changed.',
  PACKAGE_PATH: 'The signed ZIP contains unsafe, native, undeclared or aliased paths. No extension files were changed.',
  PACKAGE_MANIFEST: 'The signed ZIP manifest does not match the selected release and official extension.',
  PACKAGE_INCOMPLETE: 'The signed ZIP is missing required runtime files or dependencies.',
  PACKAGE_ZIP: 'The signed ZIP uses unsupported or inconsistent archive metadata.',
  PACKAGE_CRC: 'The signed ZIP contains corrupt file bytes.',
  PACKAGE_LIMIT: 'The signed ZIP exceeds the archive/file safety limits.',
  MANIFEST_PERMISSION_CHANGE: 'This release changes extension permissions, security policy or injection/external-access scope. A reviewed manual installation is required; no automatic or manual folder write is allowed.',
  DEFLATE_UNAVAILABLE: 'This browser cannot unpack raw DEFLATE safely. Use the manual ZIP update.',
  BUSY: 'Installation is deferred while downloads or file operations are active.',
};

function failure(code) { const error = new Error(MESSAGES[code] || MESSAGES.WRITE_FAILED); error.code = code; return error; }
function assert(condition, code) { if (!condition) throw failure(code); }
function equalBytes(a, b) { return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]); }
function folderName(handle) { return typeof handle?.name === 'string' ? handle.name.replace(/[\x00-\x1f\x7f\\/:]/g, '').slice(0, 120) : ''; }

/** The handle is structured-cloned by IndexedDB, not serialized into storage or an RPC. */
export function createFolderUpdater({ chrome: browser = globalThis.chrome, fetch: request = globalThis.fetch,
  crypto: cryptography = globalThis.crypto, indexedDB: databaseFactory = globalThis.indexedDB,
  locks = globalThis.navigator?.locks, assets = EXTENSION_ASSETS, now = Date.now, timeout = 60000,
  DecompressionStream: Stream = globalThis.DecompressionStream, requestContext = null } = {}) {
  const running = browser?.runtime?.getManifest?.();
  const runningVersion = running?.version || '';
  const runningVersionName = running?.version_name || '';
  let databasePromise;
  const supported = () => !!(running && browser.runtime.getURL && request && cryptography?.subtle && cryptography.randomUUID && databaseFactory?.open && locks?.request);
  const hash = async (bytes) => [...new Uint8Array(await cryptography.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const emptyConfig = (profileId) => ({ schema: 1, profileId, installationId: null, handle: null,
    singleProfileAcknowledged: false, autoInstall: false, installedVersion: runningVersion, installedVersionName: runningVersionName,
    installedPrerelease: /\bBETA\b/i.test(runningVersionName), reloadPending: false, baseline: {}, markerHash: '', lastState: 'not-connected', lastError: '' });

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const opening = databaseFactory.open(FOLDER_UPDATER_DB, FOLDER_UPDATER_SCHEMA);
      opening.onupgradeneeded = () => {
        for (const name of ['state', 'journal']) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name);
      };
      opening.onerror = () => reject(failure('STORAGE_FAILED'));
      opening.onblocked = () => reject(failure('STORAGE_FAILED'));
      opening.onsuccess = () => {
        const db = opening.result;
        db.onversionchange = () => { db.close(); databasePromise = null; };
        try {
          const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
          const store = tx.objectStore('state'), existing = store.get(SINGLETON);
          existing.onsuccess = () => {
            try { if (!existing.result) store.put(emptyConfig(cryptography.randomUUID()), SINGLETON); }
            catch (error) { try { tx.abort(); } catch (ignored) {} reject(failure('STORAGE_FAILED')); }
          };
          tx.oncomplete = () => resolve(db);
          tx.onerror = tx.onabort = () => reject(failure('STORAGE_FAILED'));
        } catch (error) { reject(failure('STORAGE_FAILED')); }
      };
    }).catch((error) => { databasePromise = null; throw error; });
    return databasePromise;
  }

  async function records() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'journal'], 'readonly'), state = tx.objectStore('state').get(SINGLETON), journal = tx.objectStore('journal').get(SINGLETON);
      tx.oncomplete = () => resolve({ config: state.result, journal: journal.result || null });
      tx.onerror = tx.onabort = () => reject(failure('STORAGE_FAILED'));
    });
  }

  async function save({ config, journal, clearJournal = false }, errorCode = 'STORAGE_FAILED') {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'journal'], 'readwrite', { durability: 'strict' });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure(errorCode));
      try {
        if (config) tx.objectStore('state').put(config, SINGLETON);
        if (journal) tx.objectStore('journal').put(journal, SINGLETON);
        if (clearJournal) tx.objectStore('journal').delete(SINGLETON);
      } catch (error) { try { tx.abort(); } catch (ignored) {} reject(failure(errorCode)); }
    });
  }

  async function permission(handle) {
    if (!handle?.queryPermission) return 'unavailable';
    try { const result = await handle.queryPermission({ mode: 'readwrite' }); return ['granted', 'prompt', 'denied'].includes(result) ? result : 'unavailable'; }
    catch (error) { return error.name === 'NotAllowedError' ? 'denied' : 'unavailable'; }
  }

  async function publicState(config = emptyConfig(''), journal = null, override = {}) {
    const granted = override.permission || (config.handle ? await permission(config.handle) : supported() ? 'prompt' : 'unavailable');
    const recoveryPending = override.recoveryPending ?? !!journal, connected = !!config.handle;
    const requiresReload = override.requiresReload ?? ((connected || config.reloadPending === true) && !!config.installedVersion &&
      (config.installedVersion !== runningVersion || (config.installedVersionName || '') !== runningVersionName));
    const state = override.state || (recoveryPending ? 'needs-recovery' : !connected ? config.lastError ? 'error' : requiresReload ? 'updated' : 'not-connected' :
      granted !== 'granted' ? 'needs-permission' : requiresReload ? 'updated' : config.lastState === 'error' || config.lastState === 'deferred' ? config.lastState : 'ready');
    const code = override.code ?? (recoveryPending ? config.lastError || 'RECOVERY_PENDING' : connected && granted !== 'granted' ? 'PERMISSION_REQUIRED' : config.lastError || '');
    let message = override.message || MESSAGES[code] || (state === 'updated' ? 'The complete signed update is verified. Reload is required; the core did not reload the browser.' :
      connected ? 'Folder connected. Updates are per-file transactions with a durable rollback journal, not whole-folder atomic or multi-profile safe.' : 'Connect the current unpacked extension folder to enable browser-only updates.');
    if (recoveryPending && code === 'LOCAL_CHANGES') message += ' The journal is retained. Back up local edits before an explicit restore; do not run automatic recovery.';
    return { kind: 'folder', connected, autoInstall: connected && config.autoInstall === true, permission: granted, state,
      installedVersion: connected || config.reloadPending ? config.installedVersion || runningVersion : runningVersion, folderName: connected ? folderName(config.handle) : '', message,
      error: code, recoveryPending, requiresReload };
  }

  async function directory(handle, parts, create = false) {
    let current = handle; const traversed = [];
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create });
      if (current.name && current.name !== part) throw failure('LOCAL_CHANGES');
      traversed.push(part); await inside(handle, current, traversed);
    }
    return current;
  }

  async function inside(handle, entry, parts) {
    assert(typeof handle.resolve === 'function', 'UNSUPPORTED_BROWSER');
    const resolved = await handle.resolve(entry);
    assert(Array.isArray(resolved) && resolved.length === parts.length && resolved.every((part, index) => part === parts[index]), 'LOCAL_CHANGES');
  }

  async function fileHandle(handle, path, create = false, onCreate = null) {
    const parts = validateUpdatePath(path).split('/'), name = parts.pop();
    const parent = await directory(handle, parts, create), file = await parent.getFileHandle(name, { create });
    const result = { parent, file, name };
    if (create) onCreate?.(result);
    if (file.name && file.name !== name) throw failure('LOCAL_CHANGES');
    await inside(handle, file, [...parts, name]);
    return result;
  }

  async function readFile(handle, path, maximum = MAX_UPDATE_EXPANDED_BYTES) {
    const { file } = await fileHandle(handle, path), data = await file.getFile();
    assert(Number.isSafeInteger(data.size) && data.size <= maximum, 'BACKUP_TOO_LARGE');
    const bytes = new Uint8Array(await data.arrayBuffer());
    assert(bytes.byteLength === data.size && bytes.byteLength <= maximum, 'LOCAL_CHANGES');
    return bytes;
  }

  async function absent(handle, path) {
    try { await fileHandle(handle, path); throw failure('LOCAL_CHANGES'); }
    catch (error) { if (error.name !== 'NotFoundError') throw error.code ? error : failure(error.name === 'NotAllowedError' ? 'PERMISSION_REQUIRED' : 'LOCAL_CHANGES'); }
  }

  async function createNewCheck(handle, path, onCreate = null) {
    await absent(handle, path);
    const result = await fileHandle(handle, path, true, onCreate);
    assert((await result.file.getFile()).size === 0, 'LOCAL_CHANGES');
    return result;
  }

  async function completeWrite(file, bytes) {
    let stream;
    try { stream = await file.createWritable({ keepExistingData: false }); await stream.write(bytes); await stream.close(); }
    catch (error) { try { await stream?.abort(); } catch (ignored) {} throw error; }
    const result = await file.getFile();
    assert(result.size === bytes.byteLength && equalBytes(new Uint8Array(await result.arrayBuffer()), bytes), 'WRITE_FAILED');
  }

  async function marker(handle) {
    const bytes = await readFile(handle, FOLDER_UPDATER_MARKER, 16 * 1024);
    let value;
    try { value = JSON.parse(decoder.decode(bytes)); } catch (error) { throw failure('PROFILE_CONFLICT'); }
    assert(value?.schema === 1 && UUID.test(value.profileId) && UUID.test(value.installationId), 'PROFILE_CONFLICT');
    return { value, bytes };
  }

  async function checkOwner(config) {
    let stored;
    try { stored = await marker(config.handle); }
    catch (error) { if (error.name === 'NotFoundError') throw failure('FOLDER_MOVED'); throw error; }
    assert(stored.value.profileId === config.profileId && stored.value.installationId === config.installationId && await hash(stored.bytes) === config.markerHash, 'PROFILE_CONFLICT');
  }

  function checkManifest(bytes, version, versionName = null) {
    let manifest;
    try { manifest = JSON.parse(decoder.decode(bytes)); } catch (error) { throw failure('WRONG_FOLDER'); }
    assert(running?.name === 'ALLEN Toolbox' && running.homepage_url === UPDATE_REPOSITORY && !Object.hasOwn(running, 'key') &&
      manifest?.manifest_version === 3 && manifest.name === running.name && manifest.homepage_url === UPDATE_REPOSITORY &&
      !Object.hasOwn(manifest, 'key') && manifest.version === version && (versionName === null || (manifest.version_name || '') === versionName), 'WRONG_FOLDER');
    return manifest;
  }

  async function readBaseline(config) {
    assert(config.baseline && typeof config.baseline === 'object' && Object.keys(config.baseline).length <= MAX_UPDATE_FILES, 'LOCAL_CHANGES');
    const files = new Map(); let total = 0;
    for (const [path, expected] of Object.entries(config.baseline)) {
      assert(HASH.test(expected), 'LOCAL_CHANGES');
      let bytes;
      try { bytes = await readFile(config.handle, path, MAX_BACKUP - total); }
      catch (error) { if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') throw failure('LOCAL_CHANGES'); throw error; }
      total += bytes.byteLength;
      assert(total <= MAX_BACKUP, 'BACKUP_TOO_LARGE');
      assert(await hash(bytes) === expected, 'LOCAL_CHANGES'); files.set(path, bytes);
    }
    assert(files.has('manifest.json') && files.has(KEY_PATH) && RECOVERY_BOOTSTRAP.every((path) => files.has(path)), 'LOCAL_CHANGES');
    try { checkManifest(files.get('manifest.json'), config.installedVersion, config.installedVersionName || ''); } catch (error) { throw failure('LOCAL_CHANGES'); }
    return files;
  }

  async function boundedFetch(url, maximum, { release = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    let response, lease, acquired = false;
    try {
      if (release && requestContext) {
        assert(typeof requestContext.acquire === 'function' && typeof requestContext.release === 'function', 'DOWNLOAD_FAILED');
        const acquisition = Promise.resolve().then(() => requestContext.acquire(url, controller.signal, { method: 'get', requestHeaders: [] }));
        let cancel;
        const cancelled = new Promise((resolve, reject) => {
          cancel = () => reject(failure('DOWNLOAD_FAILED'));
          controller.signal.addEventListener('abort', cancel, { once: true });
          if (controller.signal.aborted) cancel();
        });
        try { lease = await Promise.race([acquisition, cancelled]); acquired = true; }
        catch (error) { acquisition.then((late) => requestContext.release(late)).catch(() => {}); throw error; }
        finally { controller.signal.removeEventListener('abort', cancel); }
        assert(!controller.signal.aborted && lease !== null && lease !== undefined, 'DOWNLOAD_FAILED');
      }
      // Fetch does not expose intermediate redirect hops. Trust is the exact official
      // initial URL, a checked final GitHub asset host, and the pinned ZIP signature.
      response = await request(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: release ? 'follow' : 'error',
        referrerPolicy: 'no-referrer', headers: {}, signal: controller.signal });
      if (response.type === 'opaqueredirect' || response.type === 'opaque') throw failure('REDIRECT_UNVERIFIABLE');
      if (release) {
        const final = new URL(response.url || url);
        assert(final.protocol === 'https:' && !final.username && !final.password && !final.port && !final.hash && RELEASE_HOSTS.has(final.hostname), 'REDIRECT_INVALID');
        if (final.hostname === 'github.com') assert(final.href === url, 'REDIRECT_INVALID');
      } else assert(!response.url || response.url === url, 'WRONG_FOLDER');
      assert(response.ok && response.status === 200, release ? 'DOWNLOAD_FAILED' : 'WRONG_FOLDER');
      const length = response.headers.get('content-length');
      if (length != null && length !== '') assert(/^\d+$/.test(length) && Number(length) <= maximum, 'DOWNLOAD_TOO_LARGE');
      const result = await readBody(response, { signal: controller.signal, maxBytes: maximum, idleTimeout: Math.min(timeout, 20000) });
      assert(result.len <= maximum, 'DOWNLOAD_TOO_LARGE');
      return new Uint8Array(await result.blob.arrayBuffer());
    } catch (error) {
      if (error.code === 'DOWNLOAD_TOO_LARGE') throw failure('DOWNLOAD_TOO_LARGE');
      if (error.code && MESSAGES[error.code]) throw error;
      throw failure(release ? 'DOWNLOAD_FAILED' : 'WRONG_FOLDER');
    } finally {
      clearTimeout(timer); controller.abort();
      try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch (ignored) {}
      if (acquired) {
        let cleanupTimer;
        try {
          const released = await Promise.race([Promise.resolve().then(() => requestContext.release(lease)),
            new Promise((resolve, reject) => { cleanupTimer = setTimeout(() => reject(failure('DOWNLOAD_FAILED')), Math.min(timeout, 5000)); })]);
          assert(released !== null && released !== false && !released?.error && released?.ok !== false, 'DOWNLOAD_FAILED');
        } catch (error) { throw failure('DOWNLOAD_FAILED'); }
        finally { clearTimeout(cleanupTimer); }
      }
    }
  }

  function guardManifestCapabilities(previous, next) {
    const code = 'MANIFEST_PERMISSION_CHANGE';
    const list = (object, key) => {
      const value = object?.[key] ?? [];
      assert(Array.isArray(value) && value.length <= MAX_UPDATE_FILES && value.every((item) => typeof item === 'string'), code);
      return value;
    };
    const subset = (candidate, original) => candidate.every((value) => original.includes(value));
    const canonical = (value, depth = 0) => {
      assert(depth <= 5, code);
      if (Array.isArray(value)) return value.map((entry) => canonical(entry, depth + 1));
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
      return value;
    };
    for (const field of ['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions']) assert(subset(list(next, field), list(previous, field)), code);
    for (const field of ['content_security_policy', 'externally_connectable']) assert(Object.hasOwn(previous, field) === Object.hasOwn(next, field) &&
      JSON.stringify(canonical(previous[field])) === JSON.stringify(canonical(next[field])), code);
    const scripts = previous.content_scripts || [], candidates = next.content_scripts || [];
    assert(Array.isArray(scripts) && Array.isArray(candidates), code);
    for (const candidate of candidates) {
      assert(candidate && typeof candidate === 'object', code);
      for (const field of ['all_frames', 'match_about_blank', 'match_origin_as_fallback']) assert(candidate[field] == null || typeof candidate[field] === 'boolean', code);
      assert(scripts.some((original) => {
        if (!subset(list(candidate, 'matches'), list(original, 'matches')) || !subset(list(original, 'exclude_matches'), list(candidate, 'exclude_matches')) ||
            !subset(list(original, 'exclude_globs'), list(candidate, 'exclude_globs'))) return false;
        const includes = list(original, 'include_globs'), selected = list(candidate, 'include_globs');
        if (includes.length && (!selected.length || !subset(selected, includes))) return false;
        for (const field of ['all_frames', 'match_about_blank', 'match_origin_as_fallback']) if (candidate[field] === true && original[field] !== true) return false;
        return (candidate.world || 'ISOLATED') === (original.world || 'ISOLATED') && (candidate.run_at || 'document_idle') === (original.run_at || 'document_idle');
      }), code);
    }
    const exposed = previous.web_accessible_resources || [], resources = next.web_accessible_resources || [];
    assert(Array.isArray(exposed) && Array.isArray(resources), code);
    for (const resource of resources) assert(resource && exposed.some((original) =>
      subset(list(resource, 'matches'), list(original, 'matches')) && subset(list(resource, 'extension_ids'), list(original, 'extension_ids')) &&
      !!resource.use_dynamic_url === !!original.use_dynamic_url), code);
  }

  async function sourceFiles() {
    const files = new Map(); let total = 0;
    for (;;) {
      const missing = [...getUpdatePaths(files, { assets })].filter((path) => !files.has(path));
      if (!missing.length) break;
      for (const path of missing) {
        const bytes = await boundedFetch(browser.runtime.getURL(path), MAX_BACKUP - total);
        total += bytes.byteLength; assert(total <= MAX_BACKUP, 'BACKUP_TOO_LARGE'); files.set(path, bytes);
      }
    }
    validateUpdateFiles(files, { version: runningVersion, prerelease: /\bBETA\b/i.test(running.version_name || ''), assets });
    return files;
  }

  async function proveCurrentFolder(handle, profileId) {
    const path = '.allen-updater-probe-' + cryptography.randomUUID() + '.json', nonce = cryptography.randomUUID();
    const bytes = encoder.encode(JSON.stringify({ nonce, profileId }));
    let creation = null, problem;
    try {
      const { file } = await createNewCheck(handle, path, (proof) => { creation = proof; });
      await completeWrite(file, bytes);
      const fetched = await boundedFetch(browser.runtime.getURL(path), 4096);
      assert(equalBytes(fetched, bytes), 'WRONG_FOLDER');
    } catch (error) { problem = error; }
    finally {
      if (creation) try {
        const current = await fileHandle(handle, path);
        assert(typeof creation.file.isSameEntry === 'function', 'PROBE_CLEANUP_FAILED');
        if (await creation.file.isSameEntry(current.file)) {
          const data = await current.file.getFile();
          if (data.size === 0 || (data.size === bytes.byteLength && equalBytes(new Uint8Array(await data.arrayBuffer()), bytes))) await current.parent.removeEntry(current.name);
          else problem = failure('LOCAL_CHANGES');
        } else problem = failure('LOCAL_CHANGES');
      } catch (error) { if (error.name !== 'NotFoundError') problem = failure('PROBE_CLEANUP_FAILED'); }
    }
    if (problem) throw problem;
  }

  function selectedRelease(release, config) {
    assert(release && typeof release.version === 'string' && typeof release.prerelease === 'boolean', 'RELEASE_INVALID');
    try { validateUpdateVersion(release.version); } catch (error) { throw failure('RELEASE_INVALID'); }
    const suffix = release.prerelease ? '-BETA' : '', tag = 'v' + release.version + (release.prerelease ? '-beta' : ''),
      filename = 'ALLEN-Toolbox-' + release.version + suffix + '.zip', url = UPDATE_REPOSITORY + '/releases/download/' + tag + '/' + filename;
    assert(release.tag === tag && release.filename === filename && release.downloadUrl === url && release.signatureUrl === url + '.sig', 'RELEASE_INVALID');
    const comparison = compareUpdateVersions(release.version, config.installedVersion);
    assert(comparison > 0 || (comparison === 0 && config.installedPrerelease === true && release.prerelease === false), 'UPDATE_NOT_NEWER');
    return { version: release.version, prerelease: release.prerelease, downloadUrl: url, signatureUrl: url + '.sig' };
  }

  async function verifySignature(zip, signature, bytes) {
    let key;
    try {
      const data = JSON.parse(decoder.decode(bytes));
      assert(data.algorithm === 'RSA-SHA256' && /^[A-Za-z\d+/]+={0,2}$/.test(data.modulus) && /^[A-Za-z\d+/]+={0,2}$/.test(data.exponent), 'PUBLIC_KEY_INVALID');
      const modulus = Uint8Array.from(atob(data.modulus), (character) => character.charCodeAt(0)), exponent = Uint8Array.from(atob(data.exponent), (character) => character.charCodeAt(0));
      assert(modulus.length === 384 && modulus[0] >= 128 && exponent.length === 3 && exponent[0] === 1 && exponent[1] === 0 && exponent[2] === 1, 'PUBLIC_KEY_INVALID');
      const base64url = (value) => value.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      key = await cryptography.subtle.importKey('jwk', { kty: 'RSA', n: base64url(data.modulus), e: base64url(data.exponent), alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    } catch (error) { throw failure('PUBLIC_KEY_INVALID'); }
    let verified = false;
    try { verified = signature.byteLength === 384 && await cryptography.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, zip); } catch (error) {}
    assert(verified, 'SIGNATURE_INVALID');
  }

  function writeOrder(entries) {
    const rank = (path) => path === 'manifest.json' ? 4 : /^(?:background\.js|offscreen\.(?:js|html)|content\/|popup\/.*\.(?:js|html)|sandbox\/)/.test(path) ? 3 :
      path === 'scripts/scripts.json' || path === 'plugins/plugins.json' ? 2 : 1;
    return [...entries].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path, 'en'));
  }

  async function validateJournal(config, journal) {
    assert(journal?.schema === 1 && journal.profileId === config.profileId && journal.installationId === config.installationId &&
      journal.markerHash === config.markerHash && journal.fromVersion === config.installedVersion && HASH.test(journal.markerHash) &&
      Number.isSafeInteger(journal.createdAt) && journal.createdAt >= 0 &&
      config.baseline && typeof config.baseline === 'object' && !Array.isArray(config.baseline) &&
      Object.keys(config.baseline).length > 0 && Object.keys(config.baseline).length <= MAX_UPDATE_FILES &&
      Array.isArray(journal.entries) && journal.entries.length > 0 && journal.entries.length <= MAX_UPDATE_FILES, 'RECOVERY_INVALID');
    try { validateUpdateVersion(journal.fromVersion); validateUpdateVersion(journal.toVersion); } catch (error) { throw failure('RECOVERY_INVALID'); }
    const paths = new Set(), originals = new Map(); let total = 0;
    for (const entry of journal.entries) {
      try { validateUpdateFilePath(entry.path, { assets }); } catch (error) { throw failure('RECOVERY_INVALID'); }
      assert(!/\.(?:exe|dll|com|cmd|bat|ps1|psm1|psd1|msi|vbs|wsf|sys|scr)$/i.test(entry.path) && !entry.path.startsWith('updater/') &&
        !paths.has(entry.path.toLowerCase()) && typeof entry.existed === 'boolean' && HASH.test(entry.newHash) &&
        (entry.created == null || typeof entry.created === 'boolean'), 'RECOVERY_INVALID');
      paths.add(entry.path.toLowerCase());
      if (entry.existed) {
        assert(entry.bytes instanceof Blob && HASH.test(entry.hash) && Object.hasOwn(config.baseline, entry.path) && config.baseline[entry.path] === entry.hash, 'RECOVERY_INVALID');
        total += entry.bytes.size; assert(total <= MAX_BACKUP, 'RECOVERY_INVALID');
        assert(await hash(new Uint8Array(await entry.bytes.arrayBuffer())) === entry.hash, 'RECOVERY_INVALID');
        originals.set(entry.path, entry);
      } else assert(entry.bytes === null && entry.hash === null && !Object.hasOwn(config.baseline, entry.path), 'RECOVERY_INVALID');
    }
    for (const [path, expected] of Object.entries(config.baseline)) {
      try { validateUpdateFilePath(path, { assets }); } catch (error) { throw failure('RECOVERY_INVALID'); }
      assert(HASH.test(expected) && originals.get(path)?.hash === expected, 'RECOVERY_INVALID');
    }
    const manifest = journal.entries.find((entry) => entry.path === 'manifest.json');
    assert(manifest?.existed, 'RECOVERY_INVALID');
    try { checkManifest(new Uint8Array(await manifest.bytes.arrayBuffer()), journal.fromVersion, config.installedVersionName || ''); } catch (error) { throw failure('RECOVERY_INVALID'); }
  }

  async function restore(config, journal, createdPaths = new Set(), touched = null) {
    assert(await permission(config.handle) === 'granted', 'PERMISSION_REQUIRED');
    await checkOwner(config); await validateJournal(config, journal);
    if (touched) for (const entry of journal.entries) {
      let current;
      try { current = await readFile(config.handle, entry.path); }
      catch (error) { if (!entry.existed && error.name === 'NotFoundError') continue; throw failure(error.name === 'NotFoundError' ? 'LOCAL_CHANGES' : error.code || 'RECOVERY_FAILED'); }
      const currentHash = await hash(current);
      if (entry.existed) assert(currentHash === entry.hash || (touched.has(entry.path) && currentHash === entry.newHash), 'LOCAL_CHANGES');
      else assert((entry.created === true || createdPaths.has(entry.path)) && (currentHash === entry.newHash || current.byteLength === 0), 'LOCAL_CHANGES');
    }
    for (const entry of writeOrder(journal.entries)) {
      await checkOwner(config);
      if (entry.existed) {
        const { file } = await fileHandle(config.handle, entry.path, true);
        await completeWrite(file, new Uint8Array(await entry.bytes.arrayBuffer()));
      } else {
        let existing;
        try { existing = await fileHandle(config.handle, entry.path); } catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
        const current = await existing.file.getFile();
        assert(current.size <= MAX_UPDATE_EXPANDED_BYTES, 'LOCAL_CHANGES');
        const matches = await hash(new Uint8Array(await current.arrayBuffer())) === entry.newHash;
        assert((entry.created === true || createdPaths.has(entry.path)) && (matches || current.size === 0), 'LOCAL_CHANGES');
        await existing.parent.removeEntry(existing.name);
      }
    }
    for (const entry of journal.entries) if (!entry.existed) await absent(config.handle, entry.path);
    await readBaseline(config);
    await checkOwner(config);
    checkManifest(await readFile(config.handle, 'manifest.json', 512 * 1024), journal.fromVersion);
    await save({ config: { ...config, installedVersion: journal.fromVersion, reloadPending: journal.fromVersion !== runningVersion || (config.installedVersionName || '') !== runningVersionName,
      lastState: 'ready', lastError: '' }, clearJournal: true });
  }

  async function reportError(error, persist = true) {
    let data;
    try { data = await records(); } catch (ignored) { return publicState(undefined, null, { code: 'STORAGE_FAILED', state: 'needs-recovery', recoveryPending: true, permission: 'unavailable' }); }
    const denied = data.config.handle && await permission(data.config.handle) !== 'granted';
    const code = data.journal ? ['LOCAL_CHANGES', 'PROFILE_CONFLICT', 'RECOVERY_INVALID'].includes(error.code) ? error.code :
      error.code === 'RECOVERY_PENDING' && data.config.lastError === 'LOCAL_CHANGES' ? 'LOCAL_CHANGES' : 'RECOVERY_FAILED' :
      denied && !['PROFILE_CONFLICT', 'RECOVERY_PENDING', 'PROBE_CLEANUP_FAILED'].includes(error.code) ? 'PERMISSION_REQUIRED' : MESSAGES[error.code] ? error.code : 'WRITE_FAILED';
    if (persist) try { await save({ config: { ...data.config, lastState: 'error', lastError: code } }); } catch (ignored) {}
    return publicState(data.config, data.journal, { code, state: data.journal ? 'needs-recovery' : code === 'PERMISSION_REQUIRED' ? 'needs-permission' : 'error' });
  }

  async function mutate(operation) {
    if (!supported()) return publicState(undefined, null, { code: 'UNSUPPORTED_BROWSER', state: 'error', permission: 'unavailable' });
    try {
      return await locks.request(FOLDER_UPDATER_LOCK, { mode: 'exclusive' }, async () => {
        try { return await operation(await records()); }
        catch (error) { return reportError(error); }
      });
    } catch (error) { return reportError(error, false); }
  }

  async function getFolderUpdateState() {
    if (!supported()) return publicState(undefined, null, { code: 'UNSUPPORTED_BROWSER', state: 'error', permission: 'unavailable' });
    try {
      return await locks.request(FOLDER_UPDATER_LOCK, { mode: 'exclusive' }, async () => {
        const data = await records();
        if (!data.journal && data.config.reloadPending && data.config.installedVersion === runningVersion && (data.config.installedVersionName || '') === runningVersionName) {
          data.config = { ...data.config, reloadPending: false }; await save({ config: data.config });
        }
        if (data.config.handle && !data.journal && await permission(data.config.handle) === 'granted') {
          try {
            await checkOwner(data.config);
            const bytes = await readFile(data.config.handle, 'manifest.json', 512 * 1024);
            try { checkManifest(bytes, data.config.installedVersion, data.config.installedVersionName || ''); }
            catch (error) {
              let changed = false;
              try { const manifest = JSON.parse(decoder.decode(bytes)); validateUpdateVersion(manifest.version); changed = manifest.version !== runningVersion || (manifest.version_name || '') !== runningVersionName; } catch (ignored) {}
              return publicState(data.config, null, { code: 'LOCAL_CHANGES', state: 'error', requiresReload: changed });
            }
          } catch (error) {
            const granted = await permission(data.config.handle);
            return publicState(data.config, null, granted !== 'granted' ? { code: 'PERMISSION_REQUIRED', state: 'needs-permission', permission: granted } : { code: error.code || 'FOLDER_MOVED', state: 'error' });
          }
        }
        return publicState(data.config, data.journal);
      });
    } catch (error) { return publicState(undefined, null, { code: 'STORAGE_FAILED', state: 'needs-recovery', recoveryPending: true, permission: 'unavailable' }); }
  }

  function connectFolder(handle, { singleProfileAcknowledged, automatic = false } = {}) {
    return mutate(async ({ config, journal }) => {
      assert(!journal, 'RECOVERY_PENDING');
      assert(singleProfileAcknowledged === true, 'SINGLE_PROFILE_REQUIRED');
      assert(typeof automatic === 'boolean' && handle?.kind === 'directory' && handle.getFileHandle && handle.getDirectoryHandle, 'WRONG_FOLDER');
      assert(await permission(handle) === 'granted', 'PERMISSION_REQUIRED');
      const existingManifest = checkManifest(await readFile(handle, 'manifest.json', 512 * 1024), runningVersion, runningVersionName);
      guardManifestCapabilities(running, existingManifest);
      let owned = null;
      try { owned = await marker(handle); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
      if (owned) assert(owned.value.profileId === config.profileId, 'PROFILE_CONFLICT');
      if (owned && config.installationId === owned.value.installationId && config.handle) {
        assert(await hash(owned.bytes) === config.markerHash, 'PROFILE_CONFLICT');
        await readBaseline({ ...config, handle });
      }
      await proveCurrentFolder(handle, config.profileId);
      const source = await sourceFiles(), baseline = {}; let total = 0;
      for (const [path, expected] of source) {
        const actual = await readFile(handle, path, MAX_BACKUP - total); total += actual.byteLength;
        assert(equalBytes(actual, expected), 'LOCAL_CHANGES'); baseline[path] = await hash(actual);
      }
      const installationId = owned?.value.installationId || cryptography.randomUUID();
      const markerBytes = owned?.bytes || encoder.encode(JSON.stringify({ schema: 1, profileId: config.profileId, installationId }) + '\n');
      if (!owned) {
        const { file } = await createNewCheck(handle, FOLDER_UPDATER_MARKER);
        try { await completeWrite(file, markerBytes); }
        catch (error) { try { await handle.removeEntry(FOLDER_UPDATER_MARKER); } catch (ignored) {} throw error; }
      }
      const next = { ...config, handle, installationId, singleProfileAcknowledged: true, autoInstall: automatic,
        installedVersion: runningVersion, installedVersionName: runningVersionName, installedPrerelease: /\bBETA\b/i.test(runningVersionName),
        reloadPending: false, baseline, markerHash: await hash(markerBytes), lastState: 'ready', lastError: '' };
      await checkOwner(next);
      await save({ config: next });
      return publicState(next);
    });
  }

  function setFolderAutomatic(automatic) {
    return mutate(async ({ config, journal }) => {
      assert(typeof automatic === 'boolean', 'RELEASE_INVALID');
      if (automatic) {
        assert(!journal, 'RECOVERY_PENDING'); assert(config.handle && config.singleProfileAcknowledged, 'SINGLE_PROFILE_REQUIRED');
        assert(await permission(config.handle) === 'granted', 'PERMISSION_REQUIRED'); await checkOwner(config); await readBaseline(config);
      }
      const next = { ...config, autoInstall: automatic, lastError: journal ? config.lastError : '', lastState: journal ? config.lastState : config.handle ? 'ready' : 'not-connected' };
      await save({ config: next }); return publicState(next, journal);
    });
  }

  function forgetFolder() {
    return mutate(async ({ config, journal }) => {
      assert(!journal, 'RECOVERY_PENDING');
      if (config.handle && await permission(config.handle) === 'granted') {
        try { await checkOwner(config); await config.handle.removeEntry(FOLDER_UPDATER_MARKER); }
        catch (error) { /* Disconnect never deletes a missing, changed or foreign ownership marker. */ }
      }
      const next = config.reloadPending ? { ...emptyConfig(config.profileId), installedVersion: config.installedVersion, installedVersionName: config.installedVersionName,
        installedPrerelease: config.installedPrerelease, reloadPending: true } : emptyConfig(config.profileId);
      await save({ config: next }); return publicState(next);
    });
  }

  function applyFolderRelease(release, { busy = false } = {}) {
    return mutate(async ({ config, journal: pending }) => {
      assert(!pending, 'RECOVERY_PENDING');
      if (busy !== false) return publicState(config, null, { state: 'deferred', code: 'BUSY' });
      assert(config.handle && config.singleProfileAcknowledged, 'SINGLE_PROFILE_REQUIRED');
      assert(await permission(config.handle) === 'granted', 'PERMISSION_REQUIRED');
      assert(config.installedVersion === runningVersion && (config.installedVersionName || '') === runningVersionName, 'RELOAD_REQUIRED');
      const selected = selectedRelease(release, config);
      await checkOwner(config); await readBaseline(config);
      const key = await boundedFetch(browser.runtime.getURL(KEY_PATH), 16 * 1024);
      assert(await hash(key) === config.baseline[KEY_PATH], 'PUBLIC_KEY_CHANGED');
      const zip = await boundedFetch(selected.downloadUrl, MAX_UPDATE_ZIP_BYTES, { release: true });
      const signature = await boundedFetch(selected.signatureUrl, MAX_SIGNATURE, { release: true });
      await verifySignature(zip, signature, key);
      const candidate = await parseUpdatePackage(zip, { version: selected.version, prerelease: selected.prerelease, assets, DecompressionStream: Stream });
      assert(equalBytes(candidate.files.get(KEY_PATH), key), 'PUBLIC_KEY_CHANGED');
      const originals = await readBaseline(config);
      guardManifestCapabilities(running, candidate.manifest);
      guardManifestCapabilities(checkManifest(originals.get('manifest.json'), config.installedVersion, config.installedVersionName || ''), candidate.manifest);
      for (const path of RECOVERY_BOOTSTRAP) assert(equalBytes(candidate.files.get(path), originals.get(path)), 'RECOVERY_BOOTSTRAP_CHANGED');
      const entries = [], baseline = {}; let total = 0;
      for (const [path, bytes] of candidate.files) {
        const original = originals.get(path), existed = !!original;
        if (!existed) await absent(config.handle, path);
        total += original?.byteLength || 0; assert(total <= MAX_BACKUP, 'BACKUP_TOO_LARGE');
        const newHash = await hash(bytes); baseline[path] = newHash;
        entries.push({ path, existed, bytes: existed ? new Blob([original]) : null, hash: existed ? config.baseline[path] : null, newHash, created: false });
      }
      for (const [path, original] of originals) if (!candidate.files.has(path)) {
        total += original.byteLength; assert(total <= MAX_BACKUP, 'BACKUP_TOO_LARGE');
        entries.push({ path, existed: true, bytes: new Blob([original]), hash: config.baseline[path], newHash: config.baseline[path], created: false });
      }
      assert(entries.length <= MAX_UPDATE_FILES, 'PACKAGE_LIMIT');
      await checkOwner(config);
      const journal = { schema: 1, profileId: config.profileId, installationId: config.installationId, markerHash: config.markerHash,
        fromVersion: config.installedVersion, toVersion: selected.version, fromVersionName: config.installedVersionName || '',
        toVersionName: candidate.manifest.version_name || '', createdAt: now(), entries };
      await save({ config: { ...config, lastError: '', lastState: 'ready' }, journal }, 'JOURNAL_STORAGE_FAILED');
      const createdPaths = new Set(), touched = new Set();
      try {
        for (const entry of writeOrder(entries)) {
          if (entry.hash === entry.newHash) continue;
          await checkOwner(config);
          let file;
          if (entry.existed) {
            assert(await hash(await readFile(config.handle, entry.path)) === entry.hash, 'LOCAL_CHANGES');
            file = (await fileHandle(config.handle, entry.path)).file;
          } else {
            file = (await createNewCheck(config.handle, entry.path)).file; createdPaths.add(entry.path); entry.created = true;
            await save({ journal });
          }
          touched.add(entry.path); await completeWrite(file, candidate.files.get(entry.path));
        }
        for (const entry of entries) assert(await hash(await readFile(config.handle, entry.path)) === entry.newHash, 'WRITE_FAILED');
        checkManifest(await readFile(config.handle, 'manifest.json', 512 * 1024), selected.version, candidate.manifest.version_name || '');
        await checkOwner(config);
        const next = { ...config, installedVersion: selected.version, installedVersionName: candidate.manifest.version_name || '',
          installedPrerelease: selected.prerelease, reloadPending: true, baseline, lastState: 'updated', lastError: '' };
        await save({ config: next, clearJournal: true });
        return publicState(next, null, { state: 'updated', code: '' });
      } catch (error) {
        try { await restore(config, journal, createdPaths, touched); }
        catch (recoveryError) { throw failure(recoveryError.code === 'LOCAL_CHANGES' ? 'LOCAL_CHANGES' : 'RECOVERY_FAILED'); }
        throw failure(error.code && MESSAGES[error.code] ? error.code : 'WRITE_FAILED');
      }
    });
  }

  function recoverFolder({ busy = false } = {}) {
    return mutate(async ({ config, journal }) => {
      if (busy !== false) return publicState(config, journal, { state: 'deferred', code: 'BUSY' });
      if (!journal) return publicState(config, null, { message: 'No interrupted folder update is pending.' });
      await restore(config, journal);
      return publicState({ ...config, installedVersion: journal.fromVersion, lastState: 'ready', lastError: '' }, null,
        { code: '', message: 'Every recorded original was restored and verified. The recovery journal is clear; reload is now safe.' });
    });
  }

  return { getFolderUpdateState, connectFolder, setFolderAutomatic, forgetFolder, applyFolderRelease, recoverFolder };
}

let defaultUpdater;
function updater() { return defaultUpdater ||= createFolderUpdater(); }
export const getFolderUpdateState = () => updater().getFolderUpdateState();
export const connectFolder = (handle, options) => updater().connectFolder(handle, options);
export const setFolderAutomatic = (automatic) => updater().setFolderAutomatic(automatic);
export const forgetFolder = () => updater().forgetFolder();
export const applyFolderRelease = (release, options) => updater().applyFolderRelease(release, options);
export const recoverFolder = (options) => updater().recoverFolder(options);
