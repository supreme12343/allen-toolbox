import { getFolderUpdateState, connectFolder, setFolderAutomatic } from '../shared/folder-updater.js';

const $ = (selector) => document.querySelector(selector);
const OFFICIAL_SOURCE = 'https://github.com/supreme12343/allen-toolbox';
const acknowledgement = $('#single-profile-ack');
const manifest = globalThis.chrome?.runtime?.getManifest?.();
const runningVersion = manifest?.version_name || manifest?.version || 'Unavailable';
let folder = null, updates = null, busy = false, backgroundAvailable = false;
let folderProblem = '', backgroundProblem = '';

function text(value, fallback = '') {
  return typeof value === 'string' && value ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : fallback;
}

function announce(message, tone = '') {
  const status = $('#action-status');
  status.textContent = text(message);
  status.dataset.tone = tone;
}

function releaseURL(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://github.com' && url.pathname.startsWith('/supreme12343/allen-toolbox/releases/tag/') &&
        !url.username && !url.password && !url.search && !url.hash) return url.href;
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
  return folder?.connected === true && folder.permission === 'granted' && !recoveryPending() && !reloadPending() &&
    ['ready', 'deferred', 'updated'].includes(folder.state);
}

function canInstall() {
  return readyForFiles() && acknowledgement.checked && backgroundAvailable && updates?.repository === OFFICIAL_SOURCE &&
    updates.available === true && !updates.error && !updates.checking && !!releaseURL(updates.latest?.url);
}

function render() {
  const connected = folder?.connected === true;
  const granted = folder?.permission === 'granted';
  const recovery = recoveryPending(), reload = reloadPending();
  const automatic = folder?.autoInstall === true;
  const supported = typeof window.showDirectoryPicker === 'function';
  $('#setup').setAttribute('aria-busy', String(busy));
  acknowledgement.disabled = busy;
  $('#choose-folder').disabled = busy || !acknowledgement.checked || !supported || (recovery && granted) || reload;
  $('#choose-folder').textContent = connected && !granted ? 'Reconnect extension folder' : 'Choose extension folder';
  $('#picker-support').hidden = supported;
  $('#picker-support').textContent = supported ? '' : 'This browser does not support the read/write folder picker. Use a supported Chrome full tab or the stable manual ZIP release. No folder access has been granted by this page.';

  const automaticControl = $('#automatic-install');
  automaticControl.setAttribute('aria-checked', String(automatic));
  automaticControl.disabled = busy || !connected || (!automatic && (!readyForFiles() || !acknowledgement.checked));
  $('#automatic-state').textContent = automatic
    ? (readyForFiles() ? 'On for this browser/profile. Verified beta files may install without another click.' : 'On, but paused. Resolve folder permission, recovery, reload, or a folder error before installation can continue.')
    : 'Off. Only an explicit install can change extension files.';

  $('#folder-name').textContent = connected ? text(folder.folderName, 'Connected folder') : 'Not selected';
  $('#folder-version').textContent = text(folder?.installedVersion, 'Not connected');
  $('#running-version').textContent = text(runningVersion, 'Unavailable');
  $('#folder-permission').textContent = ({ granted: 'Granted', prompt: 'Needs your approval', denied: 'Revoked or denied', unavailable: 'Unavailable' })[folder?.permission] || 'Not granted';
  const stateMessages = {
    'not-connected': 'No folder is connected. Acknowledge the risks before choosing the original extension folder.',
    ready: 'The original folder is connected with read/write access.',
    'needs-permission': 'Folder permission is not granted. Updates are paused; choose the same extension folder again.',
    'needs-recovery': 'An interrupted update needs recovery. Another update is blocked.',
    updated: 'Folder files have been updated. Review whether the extension still needs to reload.',
    deferred: 'Installation is deferred until active work finishes. No new install is being started by this page.',
    error: 'The folder updater reported an error. Resolve it before trying another update.',
  };
  const folderStatus = $('#folder-status');
  folderStatus.textContent = folderProblem || (!granted && connected
    ? stateMessages['needs-permission'] + ' ' + text(folder.message)
    : text(folder?.message, stateMessages[folder?.state] || 'No folder connection is available.'));
  folderStatus.dataset.tone = folderProblem || folder?.error ? 'error' : recovery || (connected && !granted) || reload ? 'warning' : '';

  $('#forget-folder').disabled = busy || !connected || recovery || reload || !backgroundAvailable;
  $('#check-beta').disabled = busy || !backgroundAvailable;
  $('#install-beta').disabled = busy || !canInstall();
  $('#refresh-state').disabled = busy;
  const url = releaseURL(updates?.latest?.url);
  $('#view-beta-release').hidden = !url;
  $('#view-beta-release').href = url || OFFICIAL_SOURCE + '/releases';
  const releaseChannel = updates?.latest?.prerelease ? 'Beta' : 'Stable';
  $('#view-beta-release').textContent = 'View ' + releaseChannel.toLowerCase() + ' release';
  $('#install-beta').textContent = updates?.available && updates.latest?.prerelease === false ? 'Install checked stable release' : 'Install checked beta update';
  const releaseVersion = text(updates?.latest?.version, 'release');
  const updateStatus = $('#update-status');
  if (!backgroundAvailable) updateStatus.textContent = 'Beta checks and installations are unavailable until the background responds.';
  else if (updates.repository !== OFFICIAL_SOURCE) updateStatus.textContent = 'The background returned an unexpected update source. Installation is blocked.';
  else if (updates.error) updateStatus.textContent = text(updates.error, 'The beta check failed. No installation has been started.');
  else if (updates.checking) updateStatus.textContent = 'Checking GitHub for a beta release...';
  else if (updates.available) updateStatus.textContent = url
    ? releaseChannel + ' ' + releaseVersion + ' is available. Review the release before installing.'
    : 'Release metadata is incomplete. Installation is blocked.';
  else if (updates.latest) updateStatus.textContent = 'No newer beta release is available. Latest checked version: ' + releaseVersion + '.';
  else updateStatus.textContent = 'No installable beta has been checked yet. Checking a release never grants folder access.';
  updateStatus.dataset.tone = updates?.error || (backgroundAvailable && updates?.repository !== OFFICIAL_SOURCE) ? 'error' : '';

  $('#background-status').hidden = backgroundAvailable;
  $('#background-status').textContent = backgroundProblem;
  $('#folder-recovery').hidden = !recovery && !reload;
  $('#recovery-message').textContent = recovery
    ? 'Stop or finish active downloads before recovering. If access is revoked, reconnect the same folder. If the background is unavailable, open independent Recovery and Help. Recovery cannot coordinate another browser/profile.'
    : 'The folder has changed, but Chrome may still be running the previous build. The background waits for active work before reloading. If it cannot finish, use Recovery and Help; do not start another file update.';
  $('#recover-folder').hidden = !recovery;
  $('#recover-folder').disabled = busy || !recovery || !granted || !backgroundAvailable;
}

async function bg(type) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('The extension background is unavailable.');
  const response = await chrome.runtime.sendMessage({ type });
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('The extension background did not return a valid response.');
  if (response.error && response.kind !== 'folder' && typeof response.installedVersion !== 'string' && response.native?.kind !== 'folder') {
    throw new Error(text(response.message, text(response.error, 'The background rejected this action.')));
  }
  return response;
}

async function readState() {
  const [saved, manager] = await Promise.allSettled([getFolderUpdateState(), bg('updates:get')]);
  if (saved.status === 'fulfilled' && saved.value?.kind === 'folder') {
    folder = saved.value;
    folderProblem = '';
  } else {
    folder = null;
    folderProblem = 'Could not read the saved folder connection. Use Refresh status or independent Recovery and Help.';
  }
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

async function runAction(message, action, successMessage) {
  if (busy) return;
  busy = true;
  render();
  announce(message);
  try {
    const result = await action();
    await readState();
    const state = result?.kind === 'folder' ? result : result?.native;
    const issue = text(result?.error, text(state?.error));
    const paused = ['deferred', 'needs-permission', 'needs-recovery'].includes(state?.state) || state?.recoveryPending;
    announce(text(result?.message, text(state?.message, issue || successMessage)), issue || state?.state === 'error' ? 'error' : paused ? 'warning' : 'success');
  } catch (error) {
    await readState();
    announce(text(error?.message, 'This action failed. No further installation has been started.'), 'error');
  } finally {
    busy = false;
    render();
  }
}

async function chooseFolder() {
  if (busy || !acknowledgement.checked || (recoveryPending() && folder?.permission === 'granted') || reloadPending()) return;
  if (typeof window.showDirectoryPicker !== 'function') {
    announce('This browser does not support the read/write folder picker. No folder connection was changed.', 'warning');
    return;
  }
  let selection;
  try {
    // Keep the picker in this click's user activation, before any asynchronous or extension API work.
    selection = window.showDirectoryPicker({ mode: 'readwrite', id: 'allen-toolbox-updates' });
  } catch (error) {
    announce(text(error?.message, 'Chrome could not open the folder picker. Try again from this full tab.'), 'error');
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
      announce(text(result?.message, text(result?.error, 'The selected folder was not connected. No update has been installed.')), 'error');
    } else {
      announce(result.autoInstall ? 'Folder connected. Review the automatic installation setting below.' : 'Folder connected. Automatic file installation is off.', 'success');
    }
  } catch (error) {
    if (!picked && error?.name === 'AbortError') announce('Folder selection cancelled. Your saved setup is unchanged.');
    else {
      await readState();
      announce(text(error?.message, 'The folder could not be connected. No update has been installed.'), 'error');
    }
  } finally {
    busy = false;
    render();
  }
}

acknowledgement.addEventListener('change', render);
$('#choose-folder').addEventListener('click', chooseFolder);
$('#refresh-state').addEventListener('click', refreshState);
$('#automatic-install').addEventListener('click', () => {
  const automatic = folder?.autoInstall !== true;
  if (!folder?.connected || (automatic && (!readyForFiles() || !acknowledgement.checked))) return;
  return runAction(automatic ? 'Saving automatic beta installation opt-in...' : 'Turning automatic file installation off...',
    () => setFolderAutomatic(automatic), automatic ? 'Automatic beta file installation is on for this browser/profile.' : 'Automatic file installation is off.');
});
$('#check-beta').addEventListener('click', () => {
  if (!backgroundAvailable) return;
  return runAction('Checking the official beta release metadata...', () => bg('updates:check'), 'Beta check finished. Review the release status above.');
});
$('#install-beta').addEventListener('click', () => {
  if (!canInstall()) return;
  return runAction('Requesting a gated, verified beta installation. Keep the browser open...', () => bg('updates:install'), 'Installation request finished. Review the folder status before another update.');
});
$('#forget-folder').addEventListener('click', () => {
  if (busy || !folder?.connected || recoveryPending() || reloadPending() || !backgroundAvailable) return;
  if (!window.confirm('Forget this browser\'s folder connection and stop automatic updates? Your extension folder and browser data will not be deleted.')) return;
  return runAction('Forgetting the folder connection...', () => bg('folder:forget'), 'Folder connection forgotten. Automatic file installation is off.');
});
$('#recover-folder').addEventListener('click', () => {
  if (!recoveryPending() || folder?.permission !== 'granted' || !backgroundAvailable) return;
  return runAction('Requesting recovery through the background active-work gate...', () => bg('folder:recover'), 'Recovery request finished. Review the status before reloading.');
});
window.addEventListener('focus', () => { if (document.visibilityState === 'visible') void refreshState(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshState(); });
void refreshState();
