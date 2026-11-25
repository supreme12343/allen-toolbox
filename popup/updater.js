import { getFolderUpdateState, prepareFolderPermissionRequest, connectFolder, setFolderAutomatic } from '../shared/folder-updater.js';

const $ = (selector) => document.querySelector(selector);
const OFFICIAL_SOURCE = 'https://github.com/supreme12343/allen-toolbox';
const acknowledgement = $('#single-profile-ack');
const manifest = globalThis.chrome?.runtime?.getManifest?.();
const runningVersion = manifest?.version_name || manifest?.version || 'Unavailable';
let folder = null, updates = null, busy = false, backgroundAvailable = false;
let folderProblem = '', backgroundProblem = '';
let preparedAccess = null, preparingAccess = false;

function text(value, fallback = '') {
  return typeof value === 'string' && value ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : fallback;
}

function feedback(value, fallback) {
  const message = text(value);
  if (!message || /^[A-Z][A-Z\d_:-]+$/.test(message) ||
      /https?:\/\/|[a-z]:[\\/]|\b(?:authorization|bearer|cookie|password|passwd|secret|token|credential|api[_ -]?key)\b|\b(?:gh[opsur]_|github_pat_|sk-)[a-z\d_-]+/i.test(message)) return fallback;
  return message;
}

function announce(message, tone = '') {
  const status = $('#action-status');
  status.textContent = feedback(message, 'This action could not be completed. Review the folder status or open Recovery and Help.');
  status.dataset.tone = tone;
}

function releaseURL(value) {
  try {
    const url = new URL(value);
    const match = /^\/supreme12343\/allen-toolbox\/releases\/tag\/v((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3})(-beta)?$/.exec(url.pathname);
    const parts = match?.[1].split('.').map(Number);
    if (url.origin === 'https://github.com' && match && parts.every((part) => part <= 65535) && parts.some((part) => part > 0) &&
        !url.username && !url.password && !url.port && !url.search && !url.hash && url.href === value) return url.href;
  } catch {}
  return '';
}

function recoveryPending() {
  return folder?.recoveryPending === true || folder?.state === 'needs-recovery';
}

function reloadPending() {
  return folder?.requiresReload === true || updates?.native?.requiresReload === true;
}

function readyForFiles() {
  return !folderProblem && folder?.error !== 'STORAGE_FAILED' && folder?.connected === true && folder.permission === 'granted' && !recoveryPending() && !reloadPending() &&
    ['ready', 'deferred', 'updated'].includes(folder.state);
}

function canInstall() {
  return readyForFiles() && backgroundAvailable && updates?.repository === OFFICIAL_SOURCE &&
    updates.available === true && !updates.error && !updates.checking && !!releaseURL(updates.latest?.url);
}

function render() {
  const connected = folder?.connected === true;
  const granted = folder?.permission === 'granted';
  const recovery = recoveryPending(), reload = reloadPending();
  const automatic = folder?.autoInstall === true;
  const unknown = !!folderProblem || folder?.error === 'STORAGE_FAILED';
  const supported = typeof window.showDirectoryPicker === 'function';
  $('#setup').setAttribute('aria-busy', String(busy));
  acknowledgement.disabled = busy;
  $('#choose-folder').disabled = busy || !!folderProblem || !acknowledgement.checked || !supported || recovery || reload;
  $('#choose-folder').textContent = connected ? 'Change folder' : 'Choose extension folder';
  $('#choose-folder').className = connected ? 'button quiet' : 'button primary-action';
  $('#restore-folder-access').hidden = !connected || granted;
  $('#restore-folder-access').disabled = busy || preparingAccess || !!folderProblem || !preparedAccess;
  $('#restore-folder-access').textContent = preparingAccess ? 'Preparing saved access...' : 'Restore write access';
  $('#restore-support').hidden = !connected || granted || (!!preparedAccess && !preparingAccess && !folderProblem);
  $('#restore-support').textContent = preparingAccess
    ? 'Preparing the remembered folder handle. No permission prompt is opened by this step.'
    : 'Saved access could not be prepared. Refresh status or open Recovery and Help. Choose again only if the folder moved or was disconnected; no replacement folder is selected automatically.';
  $('#picker-support').hidden = supported;
  $('#picker-support').textContent = supported ? '' : 'This browser does not support the read/write folder picker. Use a supported Chrome full tab or a reviewed manual ZIP release. No folder access has been granted by this page.';

  const automaticControl = $('#automatic-install');
  automaticControl.setAttribute('aria-checked', String(automatic));
  automaticControl.disabled = busy || !connected || (!automatic && (!readyForFiles() || !acknowledgement.checked));
  $('#automatic-state').textContent = unknown
    ? 'The saved automatic setting is unavailable. No opt-in was changed; updates are paused until saved state can be read.'
    : automatic
    ? (readyForFiles() ? 'On for this browser/profile. Verified files may install without another click.' : 'On, but paused. Resolve folder permission, recovery, reload, or a folder error before installation can continue.')
    : 'Off. Only an explicit install can change extension files.';

  $('#folder-name').textContent = unknown ? 'Unavailable' : connected ? text(folder.folderName, 'Connected folder') : 'Not selected';
  $('#folder-connection').textContent = unknown ? 'Saved status unavailable; no connection was forgotten' : connected ? 'Remembered in this browser/profile' : recovery ? 'Storage or recovery needs attention' : 'Not connected';
  $('#folder-version').textContent = unknown ? 'Unavailable' : text(folder?.installedVersion, 'Not connected');
  $('#running-version').textContent = text(runningVersion, 'Unavailable');
  $('#folder-permission').textContent = ({ granted: 'Granted', prompt: 'Needs your approval', denied: 'Revoked or denied', unavailable: 'Unavailable' })[folder?.permission] || 'Not granted';
  const stateMessages = {
    'not-connected': 'No folder is connected. Acknowledge the risks before choosing the original extension folder.',
    ready: 'The original folder is connected with read/write access.',
    'needs-permission': 'The folder is remembered, but write permission is not granted. Updates are paused; use Restore write access for this saved folder.',
    'needs-recovery': 'An interrupted update needs recovery. Another update is blocked.',
    updated: 'Folder files have been updated. Review whether the extension still needs to reload.',
    deferred: 'Installation is deferred until active work finishes. No new install is being started by this page.',
    error: 'The folder updater reported an error. Resolve it before trying another update.',
  };
  const folderStatus = $('#folder-status');
  folderStatus.textContent = folderProblem || (!granted && connected
    ? stateMessages['needs-permission'] + ' ' + feedback(folder.message, '')
    : feedback(folder?.message, stateMessages[folder?.state] || 'No folder connection is available.'));
  folderStatus.dataset.tone = folderProblem || folder?.error ? 'error' : recovery || (connected && !granted) || reload ? 'warning' : '';
  $('#saved-folder-help').textContent = connected
    ? 'Folder remembered; if Chrome revokes permission, Restore write access reapproves the saved folder. Choose again only if it moved or was disconnected. This page never silently requests permission.'
    : unknown
      ? 'The saved connection could not be read. Refresh status or open Recovery and Help before choosing a folder; no saved connection was replaced.'
      : 'Choose the original extension folder for first-time setup. Its handle will be remembered in this browser/profile; later permission requests use Restore write access, not a new folder selection.';

  $('#storage-status').hidden = !connected;
  if (!$('#storage-status').textContent) $('#storage-status').textContent = 'The folder handle is saved in this profile\'s IndexedDB. Clearing browser data or storage eviction can remove it. Remembering a folder does not guarantee permanent Chrome permission.';
  $('#forget-folder').disabled = busy || !!folderProblem || !connected || recovery || reload || !backgroundAvailable;
  $('#check-beta').disabled = busy || !backgroundAvailable;
  $('#install-beta').disabled = busy || !canInstall();
  $('#refresh-state').disabled = busy;
  const url = releaseURL(updates?.latest?.url);
  $('#view-beta-release').hidden = !url;
  $('#view-beta-release').href = url || OFFICIAL_SOURCE + '/releases';
  const releaseChannel = updates?.latest?.prerelease ? 'Prerelease' : 'Stable';
  $('#view-beta-release').textContent = 'View checked release';
  $('#install-beta').textContent = 'Install checked release';
  $('#automatic-check-state').textContent = !backgroundAvailable || typeof updates?.automatic !== 'boolean'
    ? 'Automatic release-check setting is unavailable. Manage release checks separately in Utilities.'
    : updates.automatic
      ? 'Automatic release checks: On. File installation still follows the separate opt-in above. Manage release checks in Utilities.'
      : 'Automatic release checks: Off. Use Check for updates or manage release checks in Utilities. Automatic file installation is a separate setting.';
  const releaseVersion = text(updates?.latest?.version, 'release');
  const updateStatus = $('#update-status');
  if (!backgroundAvailable) updateStatus.textContent = 'Release checks and installations are unavailable until the background responds.';
  else if (updates.repository !== OFFICIAL_SOURCE) updateStatus.textContent = 'The background returned an unexpected update source. Installation is blocked.';
  else if (updates.error) updateStatus.textContent = feedback(updates.error, 'The release check failed. Retry later or review the official releases in Utilities.');
  else if (updates.checking) updateStatus.textContent = 'Checking GitHub for an official release...';
  else if (updates.available) updateStatus.textContent = url
    ? releaseChannel + ' ' + releaseVersion + ' is available. Review the release before installing.'
    : 'Release metadata is incomplete. Installation is blocked.';
  else if (updates.latest) updateStatus.textContent = 'No newer release is available. Latest checked version: ' + releaseVersion + '.';
  else updateStatus.textContent = 'No installable release has been checked yet. Checking a release never grants folder access.';
  if (updates?.lastInstallState === 'retry-exhausted') updateStatus.textContent += ' Automatic retry limit reached. Resolve the cause, then use Check for updates to retry.';
  else if (Number.isSafeInteger(updates?.nextRetryAt) && updates.nextRetryAt > 0) updateStatus.textContent += ' Deferred installation retries at ' + new Date(updates.nextRetryAt).toLocaleTimeString() + '.';
  updateStatus.dataset.tone = updates?.error || (backgroundAvailable && updates?.repository !== OFFICIAL_SOURCE) ? 'error' : '';

  $('#background-status').hidden = backgroundAvailable;
  $('#background-status').textContent = backgroundProblem;
  $('#folder-recovery').hidden = !recovery && !reload;
  $('#recovery-message').textContent = recovery
    ? 'Stop or finish active downloads before recovering. If access is revoked, use Restore write access for the remembered folder. If the background is unavailable, open independent Recovery and Help. Recovery cannot coordinate another browser/profile.'
    : 'The folder has changed, but Chrome may still be running the previous build. The background waits for active work before reloading. If it cannot finish, use Recovery and Help; do not start another file update.';
  $('#recover-folder').hidden = !recovery;
  $('#recover-folder').disabled = busy || !!folderProblem || !recovery || !granted || !backgroundAvailable;
}

async function bg(type) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('The extension background is unavailable.');
  const response = await chrome.runtime.sendMessage({ type });
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('The extension background did not return a valid response.');
  if (response.error && response.kind !== 'folder' && typeof response.installedVersion !== 'string' && response.native?.kind !== 'folder') {
    throw new Error(feedback(response.message, feedback(response.error, 'The background rejected this action. Review the folder status or retry after active work finishes.')));
  }
  return response;
}

async function readState() {
  preparedAccess = null;
  preparingAccess = true;
  render();
  const [saved, manager, access] = await Promise.allSettled([getFolderUpdateState(), bg('updates:get'), prepareFolderPermissionRequest()]);
  if (saved.status === 'fulfilled' && saved.value?.kind === 'folder') {
    folder = saved.value;
    folderProblem = '';
  } else {
    folderProblem = 'Could not read the saved folder connection. Use Refresh status or independent Recovery and Help.';
  }
  preparedAccess = !folderProblem && folder?.connected && access.status === 'fulfilled' && typeof access.value?.request === 'function' ? access.value : null;
  preparingAccess = false;
  if (manager.status === 'fulfilled') {
    updates = manager.value;
    backgroundAvailable = true;
    backgroundProblem = '';
  } else {
    updates = null;
    backgroundAvailable = false;
    backgroundProblem = 'The background is unavailable. Install, forget, and background recovery are paused. Independent Recovery and Help does not depend on it.';
  }
}

async function refreshState() {
  if (busy) return;
  busy = true;
  render();
  try { await readState(); }
  finally { busy = false; render(); }
}

async function runAction(message, action, successMessage, failureMessage) {
  if (busy) return;
  busy = true;
  render();
  announce(message);
  try {
    const result = await action();
    const state = result?.kind === 'folder' ? result : result?.native;
    if (result?.kind === 'folder') folder = result;
    if (state?.kind === 'folder' && state.state === 'deferred' && state.error === 'BUSY' && state.recoveryPending) {
      // Do not queue a status read behind the writer that made this permission request defer.
      folder = state;
      preparedAccess = null;
    } else await readState();
    const issue = text(result?.error, text(state?.error));
    const paused = ['deferred', 'needs-permission', 'needs-recovery'].includes(state?.state) || state?.recoveryPending;
    const failed = state?.state === 'error' || (issue && !['PERMISSION_REQUIRED', 'RECOVERY_PENDING', 'BUSY'].includes(issue));
    const fallback = issue ? feedback(issue, 'This action is blocked. Review the folder status or open Recovery and Help.') : successMessage;
    announce(feedback(result?.message, feedback(result?.error, feedback(state?.message, fallback))), failed ? 'error' : paused ? 'warning' : 'success');
  } catch (error) {
    await readState();
    const cancelled = failureMessage && ['AbortError', 'NotAllowedError'].includes(error?.name);
    announce(cancelled ? failureMessage : feedback(error?.message, failureMessage || 'This action failed. Review the folder status or open Recovery and Help. No further installation has been started.'), cancelled ? 'warning' : 'error');
  } finally {
    busy = false;
    render();
  }
}

async function requestStoragePersistence() {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== 'function') return;
  const status = $('#storage-status');
  status.textContent = 'Requesting persistent browser storage. Folder permission is separate and can still be revoked.';
  try {
    const persisted = await storage.persist();
    status.textContent = persisted === true
      ? 'Persistent browser storage approved. Clearing browser data can still remove the saved connection; folder permission is not permanent.'
      : 'Persistent browser storage was not approved. The remembered folder uses normal browser storage, which Chrome can evict. Folder permission is separate.';
  } catch {
    status.textContent = 'Persistent browser storage could not be approved. The saved connection and recovery status were not changed by this request; Chrome can still evict storage or revoke folder permission.';
  }
}

function restoreFolderAccess() {
  if (busy || preparingAccess || folderProblem || !folder?.connected || folder.permission === 'granted' || !preparedAccess) return;
  let requested;
  try {
    // The prepared callback invokes the saved handle's native permission API before any await or RPC.
    requested = preparedAccess.request();
  } catch (error) {
    announce(feedback(error?.message, 'Write access could not be requested. Refresh status or open Recovery and Help; the saved folder was not replaced.'), 'error');
    return;
  }
  preparedAccess = null;
  return runAction('Approve Chrome write access to the remembered folder. No update is being installed by this action.', async () => {
    const result = await requested;
    if (result?.connected && result.permission === 'granted') {
      void requestStoragePersistence();
      if (!result.error && !result.recoveryPending) return { ...result, message: 'Write access restored. The remembered folder and automatic installation choice are unchanged. No update was installed by this action.' };
    }
    return result;
  }, 'Write access request finished. Review the saved folder status.', 'Write access was not approved. The remembered folder and automatic installation choice were not changed. Use Restore write access to try again.');
}

async function chooseFolder() {
  if (busy || folderProblem || !acknowledgement.checked || recoveryPending() || reloadPending()) return;
  if (typeof window.showDirectoryPicker !== 'function') {
    announce('This browser does not support the read/write folder picker. No folder connection was changed.', 'warning');
    return;
  }
  let selection;
  try {
    // Keep the picker in this click's user activation, before any asynchronous or extension API work.
    selection = window.showDirectoryPicker({ mode: 'readwrite', id: 'allen-toolbox-updates' });
  } catch (error) {
    announce(feedback(error?.message, 'Chrome could not open the folder picker. Try again from this full tab.'), 'error');
    return;
  }
  busy = true;
  render();
  announce('Choose the original allen-toolbox folder and approve Chrome read/write access.');
  let picked = false;
  try {
    const handle = await selection;
    picked = true;
    const result = await connectFolder(handle, { singleProfileAcknowledged: acknowledgement.checked, automatic: false });
    await readState();
    if (result?.error || result?.connected !== true) {
      announce(feedback(result?.message, 'The selected folder was not connected. Review the folder status; no update has been installed.'), 'error');
    } else {
      if (result.permission === 'granted') void requestStoragePersistence();
      announce(result.autoInstall ? 'Folder connected. Review the automatic installation setting below.' : 'Folder connected. Automatic file installation is off.', 'success');
    }
  } catch (error) {
    if (!picked && error?.name === 'AbortError') announce('Folder selection cancelled. Your saved setup is unchanged.');
    else {
      await readState();
      announce(feedback(error?.message, 'The folder could not be connected. Review the folder status or open Recovery and Help. No update has been installed.'), 'error');
    }
  } finally {
    busy = false;
    render();
  }
}

acknowledgement.addEventListener('change', render);
$('#choose-folder').addEventListener('click', chooseFolder);
$('#restore-folder-access').addEventListener('click', restoreFolderAccess);
$('#refresh-state').addEventListener('click', refreshState);
$('#automatic-install').addEventListener('click', () => {
  const automatic = folder?.autoInstall !== true;
  if (!folder?.connected || (automatic && (!readyForFiles() || !acknowledgement.checked))) return;
  return runAction(automatic ? 'Saving automatic file installation opt-in...' : 'Turning automatic file installation off...',
    () => setFolderAutomatic(automatic), automatic ? 'Automatic file installation is on for this browser/profile.' : 'Automatic file installation is off.');
});
$('#check-beta').addEventListener('click', () => {
  if (!backgroundAvailable) return;
  return runAction('Checking the official release metadata...', () => bg('updates:check'), 'Release check finished. Review the release status above.');
});
$('#install-beta').addEventListener('click', () => {
  if (!canInstall()) return;
  return runAction('Requesting a gated, verified installation. Keep the browser open...', () => bg('updates:install'), 'Installation request finished. Review the folder status before another update.');
});
$('#forget-folder').addEventListener('click', () => {
  if (busy || folderProblem || !folder?.connected || recoveryPending() || reloadPending() || !backgroundAvailable) return;
  if (!window.confirm('Forget this browser\'s folder connection and stop automatic updates? Your extension folder and browser data will not be deleted.')) return;
  return runAction('Forgetting the folder connection...', () => bg('folder:forget'), 'Folder connection forgotten. Automatic file installation is off.');
});
$('#recover-folder').addEventListener('click', () => {
  if (folderProblem || !recoveryPending() || folder?.permission !== 'granted' || !backgroundAvailable) return;
  return runAction('Requesting recovery through the background active-work gate...', () => bg('folder:recover'), 'Recovery request finished. Review the status before reloading.');
});
window.addEventListener('focus', () => { if (document.visibilityState === 'visible') void refreshState(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshState(); });
void refreshState();
