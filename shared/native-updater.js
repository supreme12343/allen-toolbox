import { compareVersions, versionParts } from './update-meta.js';

export const NATIVE_UPDATER_HOST = 'com.supreme.allen_toolbox_updater_v2';
const CLIENT_ID = 'nativeUpdaterClientId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(['up-to-date', 'available', 'updated', 'deferred', 'error']);
const FIELDS = new Set(['protocol', 'installed', 'extensionId', 'state', 'installedVersion', 'availableVersion', 'lastCheckedAt', 'lastUpdatedAt', 'error', 'security']);
const UNRESOLVED = new Set(['update-in-progress', 'recovery-deferred', 'transaction-recovery-required', 'native-timeout', 'native-output-invalid']);
const MISSING_HOST = /Specified native messaging host not found|Native messaging host not found|Access to the specified native messaging host is forbidden/i;
const FALLBACK = 'The signed protocol 2 Windows updater is unavailable. Unsigned legacy helpers are unsupported; use the manual ZIP update.';
const HEARTBEAT = 20000, COOLDOWN = 60000, FUTURE_SKEW = 60000;
const clients = new WeakMap();

function clientIdentity(storage) {
  if (!storage?.get || !storage?.set) return Promise.reject(new Error('The Windows updater client identity could not be stored. Use the manual ZIP update.'));
  if (!clients.has(storage)) {
    const identity = (async () => {
      const saved = (await storage.get(CLIENT_ID))[CLIENT_ID];
      const canonical = typeof saved === 'string' ? saved.toLowerCase() : '';
      if (UUID.test(canonical)) {
        if (saved !== canonical) await storage.set({ [CLIENT_ID]: canonical });
        return canonical;
      }
      const value = globalThis.crypto.randomUUID();
      if (!UUID.test(value)) throw new Error('The Windows updater client identity is invalid. Use the manual ZIP update.');
      await storage.set({ [CLIENT_ID]: value });
      return value;
    })();
    clients.set(storage, identity);
    identity.catch(() => { if (clients.get(storage) === identity) clients.delete(storage); });
  }
  return clients.get(storage);
}

export function initNativeUpdater({ chrome: browser = globalThis.chrome, busy = () => false, timeout = 200000, enabled = true, publisherThumbprint } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('Windows updater availability must be a boolean');
  if (enabled && publisherThumbprint !== undefined) {
    if (typeof publisherThumbprint !== 'string' || !/^[0-9a-f]{40}$/i.test(publisherThumbprint)) throw new TypeError('Windows updater publisher must be a 40-digit hexadecimal thumbprint');
    publisherThumbprint = publisherThumbprint.toUpperCase();
  }
  timeout = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 200000) : 200000;
  const activeVersion = browser.runtime.getManifest().version;
  versionParts(activeVersion);
  let current = { installed: false, state: 'not-installed', installedVersion: activeVersion, availableVersion: null,
    lastCheckedAt: 0, lastUpdatedAt: 0, security: null, error: FALLBACK };
  let queue = Promise.resolve(), pendingUpdates = 0, uncertain = false, clientId, retryAt = 0, revision = 0;
  let heartbeatTimer = null, heartbeatGeneration = 0;
  const status = () => ({ ...current, security: current.security ? { ...current.security } : null,
    applying: pendingUpdates > 0 || uncertain, uncertain, requiresReload: compareVersions(current.installedVersion, activeVersion) > 0 });
  const message = (command, active) => ({ protocol: 2, command, busy: active, clientId });

  function validate(response) {
    const invalid = () => { throw new Error('The Windows updater returned an invalid protocol 2 response. Unsigned legacy helpers are unsupported; use the manual ZIP update.'); };
    if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length !== FIELDS.size ||
        Object.keys(response).some((key) => !FIELDS.has(key)) || response.protocol !== 2 || response.installed !== true ||
        typeof response.extensionId !== 'string' || !/^[a-p]{32}$/.test(response.extensionId) || response.extensionId !== browser.runtime.id || !STATES.has(response.state)) invalid();
    const security = response.security;
    if (!security || typeof security !== 'object' || Array.isArray(security) || Object.keys(security).length !== 2 ||
        Object.keys(security).some((key) => key !== 'authenticode' && key !== 'publisherThumbprint') ||
        security.authenticode !== true || typeof security.publisherThumbprint !== 'string' || !/^[0-9a-f]{40}$/i.test(security.publisherThumbprint) ||
        (publisherThumbprint !== undefined && security.publisherThumbprint.toUpperCase() !== publisherThumbprint)) {
      throw new Error('The Windows updater did not attest a trusted Authenticode signature. Unsigned legacy helpers are unsupported; use the manual ZIP update.');
    }
    versionParts(response.installedVersion);
    if (compareVersions(response.installedVersion, current.installedVersion) < 0) invalid();
    if (response.availableVersion !== null) {
      versionParts(response.availableVersion);
      if (compareVersions(response.availableVersion, response.installedVersion) <= 0) invalid();
    }
    for (const field of ['lastCheckedAt', 'lastUpdatedAt']) {
      if (!Number.isSafeInteger(response[field]) || response[field] < 0 || response[field] > Date.now() + FUTURE_SKEW) invalid();
    }
    if (typeof response.error !== 'string' || response.error.length > 500 || /[\x00-\x1f\x7f]/.test(response.error) ||
        (response.state === 'available' && response.availableVersion === null) ||
        (['up-to-date', 'updated'].includes(response.state) && response.availableVersion !== null) ||
        (response.state === 'updated' && response.lastUpdatedAt === 0) ||
        (['error', 'deferred'].includes(response.state) ? !response.error : !!response.error) ||
        (UNRESOLVED.has(response.error) && !['error', 'deferred'].includes(response.state))) invalid();
    // This is an attestation, not JS verification of local code. Installation must enforce WinTrust and the pinned publisher.
    return { installed: true, state: response.state, installedVersion: response.installedVersion, availableVersion: response.availableVersion,
      lastCheckedAt: response.lastCheckedAt, lastUpdatedAt: response.lastUpdatedAt, error: response.error,
      security: { authenticode: true, publisherThumbprint: security.publisherThumbprint.toUpperCase() } };
  }

  function accept(response) {
    current = validate(response);
    uncertain = UNRESOLVED.has(current.error);
    retryAt = 0;
  }

  function failed(error, previousUncertain = uncertain, sentUpdate = false) {
    const text = typeof error?.message === 'string' ? error.message : 'The signed Windows updater is unavailable. Use the manual ZIP update.';
    const missing = MISSING_HOST.test(text);
    if (missing) {
      retryAt = Date.now() + COOLDOWN;
      // A missing host proves only this request never started, not that an earlier timed-out update stopped.
      if (sentUpdate) uncertain = previousUncertain;
    }
    current = { ...current, installed: false, state: 'not-installed', security: null,
      error: missing ? FALLBACK : text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500) };
  }

  async function heartbeat() {
    if (!uncertain || Date.now() < retryAt) return;
    const generation = heartbeatGeneration;
    let busyTimer, replyTimer, snapshot, recovery = false;
    try {
      const active = !!(await Promise.race([Promise.resolve().then(busy).catch(() => true),
        new Promise((resolve) => { busyTimer = setTimeout(() => resolve(true), 5000); })]));
      clearTimeout(busyTimer);
      if (!uncertain || generation !== heartbeatGeneration || Date.now() < retryAt) return;
      snapshot = revision; recovery = pendingUpdates === 0;
      // Never join the command queue: activity must reach another host process while update is awaiting completion.
      const response = await Promise.race([browser.runtime.sendNativeMessage(NATIVE_UPDATER_HOST, message('status', active)),
        new Promise((resolve, reject) => { replyTimer = setTimeout(() => reject(new Error('The Windows updater heartbeat did not respond in time')), HEARTBEAT); })]);
      const checked = validate(response);
      if (generation === heartbeatGeneration && snapshot === revision && recovery && pendingUpdates === 0) {
        current = checked; uncertain = UNRESOLVED.has(checked.error); retryAt = 0;
      }
    } catch (error) {
      if (generation === heartbeatGeneration && uncertain) {
        if (snapshot === revision && recovery && pendingUpdates === 0) failed(error);
        else if (MISSING_HOST.test(error?.message || '')) retryAt = Date.now() + COOLDOWN;
      }
    } finally { clearTimeout(busyTimer); clearTimeout(replyTimer); syncHeartbeat(); }
  }

  function syncHeartbeat() {
    if (uncertain && clientId && heartbeatTimer === null) {
      heartbeatGeneration++;
      heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, HEARTBEAT);
    } else if (!uncertain && heartbeatTimer !== null) {
      clearInterval(heartbeatTimer); heartbeatTimer = null; heartbeatGeneration++;
    }
  }

  function invoke(command, force = false) {
    if (!enabled || typeof browser.runtime.sendNativeMessage !== 'function') return Promise.resolve(status());
    const update = command === 'update';
    if (update) pendingUpdates++;
    revision++;
    const task = queue.then(async () => {
      if (!force && command === 'status' && Date.now() < retryAt) return status();
      let timer, sentUpdate = false, deferred = false;
      const previousUncertain = uncertain;
      try {
        const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('The Windows updater did not respond in time. Installation is unconfirmed; retry status to recover.')), timeout); });
        clientId = await Promise.race([clientIdentity(browser.storage?.local), deadline]);
        const active = !!(await Promise.race([Promise.resolve().then(busy), deadline]));
        if (update && active) deferred = true;
        else {
          if (update) { sentUpdate = true; uncertain = true; syncHeartbeat(); }
          accept(await Promise.race([browser.runtime.sendNativeMessage(NATIVE_UPDATER_HOST, message(command, active)), deadline]));
        }
      } catch (error) { failed(error, previousUncertain, sentUpdate); }
      finally { clearTimeout(timer); if (update) pendingUpdates--; syncHeartbeat(); }
      return deferred ? { ...status(), state: 'deferred', error: 'Automatic installation waits until active downloads finish.' } : status();
    });
    queue = task.catch(() => {});
    return task;
  }

  return { status: async () => status(), refresh: ({ force = false } = {}) => invoke('status', force === true),
    check: () => invoke('check', true), update: () => invoke('update', true), isApplying: () => pendingUpdates > 0 || uncertain || status().requiresReload };
}
