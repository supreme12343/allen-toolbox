import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const [html, css, source, recovery] = await Promise.all(['popup/updater.html', 'popup/updater.css', 'popup/updater.js', 'popup/updater-recovery.html']
  .map((path) => readFile(new URL('../' + path, import.meta.url), 'utf8')));
const repository = 'https://github.com/supreme12343/allen-toolbox';
const latest = { version: '2.3.2', prerelease: true, url: repository + '/releases/tag/v2.3.2-beta' };
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const disconnected = (extra = {}) => ({ kind: 'folder', connected: false, autoInstall: false, permission: 'unavailable', state: 'not-connected',
  installedVersion: '', folderName: '', message: '', error: '', recoveryPending: false, requiresReload: false, ...extra });
const connected = (extra = {}) => disconnected({ connected: true, permission: 'granted', state: 'ready', installedVersion: '2.4.0', folderName: 'allen-toolbox', ...extra });

function target() {
  const listeners = new Map();
  return { listeners, addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    async emit(type) { await Promise.all((listeners.get(type) || []).map((listener) => listener({ type, target: this }))); } };
}

function controls() {
  const nodes = {};
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2].replaceAll('&amp;', '&')]));
    const node = { ...target(), tag: match[1], attributes, dataset: {}, textContent: '', href: attributes.href || '',
      disabled: /\sdisabled(?:\s|>)/.test(match[0]), hidden: /\shidden(?:\s|>)/.test(match[0]), checked: /\schecked(?:\s|=|>)/.test(match[0]),
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; } };
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('UI must render untrusted folder/release text with textContent.'); } });
    nodes['#' + match[3]] = node;
  }
  return nodes;
}

async function harness(options = {}) {
  const nodes = controls(), calls = [], messages = [], handle = { kind: 'directory', name: 'allen-toolbox', fixture: true };
  let folder = options.folder || disconnected();
  let manager = { repository, installedVersion: '2.4.0', automatic: true, latest: null, available: false, error: '', ...options.manager };
  let preparations = 0;
  const state = {
    get folder() { return folder; }, get manager() { return manager; },
    setFolder(value) { folder = value; }, setManager(value) { manager = { ...manager, ...value }; },
  };
  const document = { ...target(), visibilityState: 'visible', querySelector(selector) {
    assert.ok(nodes[selector], 'Missing UI element ' + selector);
    return nodes[selector];
  } };
  const window = { ...target(), confirm(message) { calls.push({ type: 'confirm', message }); return options.confirm !== false; } };
  if (!options.unsupported) window.showDirectoryPicker = (value) => {
    calls.push({ type: 'picker', options: plain(value) });
    return options.picker ? options.picker(value) : Promise.resolve(handle);
  };
  handle.requestPermission = (value) => {
    calls.push({ type: 'permission', handle, options: plain(value) });
    return options.permissionRequest ? options.permissionRequest(value) : Promise.resolve(options.grant || 'granted');
  };
  const navigator = options.persist ? { storage: { persist() { calls.push({ type: 'persist' }); return options.persist(); } } } : {};
  const chrome = { runtime: {
    getManifest() { calls.push({ type: 'manifest' }); return options.manifest || { version: '2.4.0' }; },
    async sendMessage(message) {
      const request = plain(message);
      calls.push({ type: 'rpc', message: request }); messages.push(request);
      if (options.rpc) {
        const result = await options.rpc(request, state);
        if (result !== undefined) return result;
      }
      if (options.backgroundError) throw new Error('Fixture background unavailable');
      if (message.type === 'updates:get') return plain({ ...manager, native: folder });
      if (message.type === 'updates:check') { manager = { ...manager, latest, available: true, error: '' }; return plain({ ...manager, native: folder }); }
      if (message.type === 'updates:install') {
        folder = { ...folder, state: 'updated', installedVersion: '2.3.2', requiresReload: true, message: 'Files updated; reload is pending.' };
        return plain({ ...manager, native: folder });
      }
      if (message.type === 'folder:forget') { folder = disconnected(); return plain(folder); }
      if (message.type === 'folder:recover') { folder = connected({ requiresReload: true, message: 'Previous files restored; review before reload.' }); return plain(folder); }
      throw new Error('Unexpected RPC ' + message.type);
    },
  } };
  const script = source.replace(/^import\s*\{[^}]*\}\s*from\s*'[^']+';\s*/, '');
  assert.notEqual(script, source, 'Inject only the provided core contract, without loading core-owned files');
  runInNewContext(script, { document, window, chrome, navigator, URL, console,
    async getFolderUpdateState() { calls.push({ type: 'core:get' }); if (typeof options.stateError === 'function' ? options.stateError(state) : options.stateError) throw new Error('Fixture state unavailable'); return plain(folder); },
    async prepareFolderPermissionRequest() {
      calls.push({ type: 'core:prepare' }); preparations++;
      if (options.prepareError) throw new Error('Fixture preparation unavailable');
      if (options.prepare) {
        const result = await options.prepare(state, preparations);
        if (result !== undefined) return result;
      }
      if (!folder.connected || folder.permission === 'unavailable' || ['FOLDER_MOVED', 'PROFILE_CONFLICT'].includes(folder.error)) return null;
      return { request() {
        const requested = handle.requestPermission({ mode: 'readwrite' });
        return (async () => {
          const permission = await requested;
          if (options.restoreResult) folder = options.restoreResult;
          else folder = { ...folder, permission, state: folder.recoveryPending ? 'needs-recovery' : permission === 'granted' ? 'ready' : 'needs-permission',
            error: folder.recoveryPending ? 'RECOVERY_PENDING' : permission === 'granted' ? '' : 'PERMISSION_REQUIRED',
            message: folder.recoveryPending ? 'Saved recovery is still required.' : permission === 'granted' ? 'Saved folder write access granted.' : 'Write access was not approved. The saved folder is unchanged.' };
          return plain(folder);
        })();
      } };
    },
    async connectFolder(selected, consent) {
      calls.push({ type: 'core:connect', handle: selected, consent: plain(consent) });
      if (options.connectError) throw options.connectError;
      if (options.connectResult) { folder = options.connectResult; return plain(folder); }
      folder = connected({ autoInstall: consent.automatic === true }); return plain(folder);
    },
    async setFolderAutomatic(value) { calls.push({ type: 'core:automatic', value }); folder = { ...folder, autoInstall: value }; return plain(folder); },
  }, { filename: 'popup/updater.js' });
  await tick();
  return { nodes, calls, messages, handle, window, document, state,
    async acknowledge(value = true) { nodes['#single-profile-ack'].checked = value; await nodes['#single-profile-ack'].emit('change'); },
    async click(id) { await nodes['#' + id].emit('click'); await tick(); },
  };
}

test('production setup is a local full-tab page with fixed source, recovery, and unchecked initial consent', () => {
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /href="\.\/theme\.css"/);
  assert.match(html, /<script type="module" src="\.\/updater\.js"><\/script>/);
  assert.match(html, /full-tab setup, not a toolbar popup/);
  assert.match(html, /<title>Folder Updates \| ALLEN Toolbox<\/title>/);
  assert.doesNotMatch(html.replace(/\bid="[^"]*"/g, ''), /Experimental|\bBETA\b|2\.3\.1|Vector|Optimus/i);
  assert.ok(html.includes('href="' + repository + '"'));
  assert.ok(html.includes(repository + '/releases'));
  assert.match(html, /popup\.html\?dashboard=1&amp;view=tools/);
  assert.match(html, /I use this folder only in this browser\/profile and understand the per-file update and recovery limits/);
  const checkbox = html.match(/<input\b[^>]*id="single-profile-ack"[^>]*>/)[0];
  assert.match(checkbox, /type="checkbox"/);
  assert.doesNotMatch(checkbox, /\schecked(?:\s|=|>)/);
  assert.match(html, /for="single-profile-ack"/);
  assert.match(html, /containing <code>manifest\.json<\/code>/);
  assert.match(html, /read\/write access/);
  assert.match(html, /Folder remembered; if Chrome revokes permission, Restore write access reapproves the saved folder/);
  assert.match(html, /Choose again only if it moved or was disconnected/);
  assert.match(html, /Automatic release checks and automatic file installation are separate settings/);
  assert.match(html, /not atomic/);
  assert.match(html, /No Store installation, executable, PowerShell, or Windows helper/);
  assert.doesNotMatch(html, /type="(?:text|url)"|fonts\.googleapis|https?:\/\/[^"\s]+\.(?:js|css)["\s]/);
});

test('setup styles preserve graphite theme tokens, safety warning, 44px controls, focus, and small-screen flow', () => {
  assert.match(css, /font:[^;]*var\(--font-ui\)/);
  assert.match(css, /\.button\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/);
  assert.match(css, /\.acknowledgement\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.automatic-toggle\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /focus-visible[^}]*outline:\s*2px solid var\(--blue\)/);
  const primary = css.match(/\.button\.primary-action\s*\{([^}]*)\}/)[1];
  assert.match(primary, /background:\s*var\(--primary\)/);
  assert.match(primary, /color:\s*var\(--accent-ink\)/);
  assert.match(css, /\.safety-warning\s*\{[^}]*var\(--warning-bg\)[^}]*var\(--amber\)/);
  assert.doesNotMatch(css, /beta-action|beta-badge|beta-warning/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 2fr\) minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /\.setup-aside\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /forced-colors:\s*active/);
  assert.doesNotMatch(css, /min-width:\s*(?:3[3-9]\d|[4-9]\d\d)px|height:\s*590px|overflow(?:-x)?:\s*hidden/);
});

test('opening setup reads state but never prompts, opts in, checks releases, installs, or calls native APIs', async () => {
  const ui = await harness();
  assert.equal(ui.nodes['#single-profile-ack'].checked, false);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
  assert.equal(ui.nodes['#restore-folder-access'].hidden, true);
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'false');
  assert.equal(ui.nodes['#automatic-install'].disabled, true);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#check-beta'].disabled, false);
  assert.deepEqual(ui.messages, [{ type: 'updates:get' }]);
  assert.ok(ui.calls.every((call) => ['manifest', 'core:get', 'core:prepare', 'rpc'].includes(call.type)));
  assert.equal(ui.calls.filter((call) => call.type === 'core:prepare').length, 1);
  assert.doesNotMatch(source, /sendNativeMessage|connectNative|chrome\.permissions|requestPermission|applyFolderRelease|\bfetch\s*\(/);
  assert.match(source, /chrome\.runtime\.sendMessage\(\{ type \}\)/);
});

test('acknowledgement gates choosing a folder without doing any API work itself', async () => {
  const ui = await harness();
  ui.calls.length = 0;
  await ui.click('choose-folder');
  assert.deepEqual(ui.calls, []);
  await ui.acknowledge();
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.nodes['#choose-folder'].disabled, false);
  assert.equal(ui.nodes['#automatic-install'].disabled, true);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
});

test('picker runs synchronously before core or background work and connection explicitly disables automatic installation', async () => {
  let select;
  const selection = new Promise((resolve) => { select = resolve; });
  const ui = await harness({ picker: () => selection });
  await ui.acknowledge(); ui.calls.length = 0; ui.messages.length = 0;
  const pending = ui.nodes['#choose-folder'].emit('click');
  assert.deepEqual(ui.calls, [{ type: 'picker', options: { mode: 'readwrite', id: 'allen-toolbox-updates' } }]);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#single-profile-ack'].disabled, true);
  await ui.nodes['#choose-folder'].emit('click');
  assert.equal(ui.calls.length, 1, 'Repeated clicks cannot open another picker while selection is pending');
  select(ui.handle); await pending;
  const connection = ui.calls.find((call) => call.type === 'core:connect');
  assert.equal(connection.handle, ui.handle);
  assert.deepEqual(connection.consent, { singleProfileAcknowledged: true, automatic: false });
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'false');
  assert.match(ui.nodes['#action-status'].textContent, /Automatic file installation is off/);
  assert.deepEqual(ui.messages, [{ type: 'updates:get' }], 'Directory handle never enters an RPC');
});

test('cancelled explicit Change folder preserves the saved connection and existing automatic opt-in', async () => {
  const ui = await harness({ folder: connected({ autoInstall: true }), picker: () => Promise.reject(new DOMException('Cancelled', 'AbortError')) });
  await ui.acknowledge(); ui.calls.length = 0;
  await ui.click('choose-folder');
  assert.deepEqual(ui.calls.map((call) => call.type), ['picker']);
  assert.match(ui.nodes['#action-status'].textContent, /selection cancelled.*saved setup is unchanged/);
  assert.equal(ui.state.folder.connected, true);
  assert.equal(ui.state.folder.autoInstall, true);
});

test('unsupported browsers get visible feedback and never replace the picker with an automatic permission path', async () => {
  const ui = await harness({ unsupported: true });
  await ui.acknowledge(); ui.calls.length = 0;
  assert.equal(ui.nodes['#picker-support'].hidden, false);
  assert.match(ui.nodes['#picker-support'].textContent, /does not support.*No folder access/);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  await ui.click('choose-folder');
  assert.equal(ui.calls.length, 0);
  assert.match(ui.nodes['#action-status'].textContent, /does not support.*No folder connection was changed/);
});

test('synchronous picker errors report failure without attempting a connection', async () => {
  const ui = await harness({ picker() { throw new DOMException('Open this setup in a full tab.', 'SecurityError'); } });
  await ui.acknowledge(); ui.calls.length = 0;
  await ui.click('choose-folder');
  assert.deepEqual(ui.calls.map((call) => call.type), ['picker']);
  assert.match(ui.nodes['#action-status'].textContent, /full tab/);
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'error');
});

test('a core-rejected root is not presented as connected or installed', async () => {
  const ui = await harness({ connectResult: disconnected({ state: 'error', error: 'FOLDER_NOT_CURRENT', message: 'Choose the currently loaded extension folder.' }) });
  await ui.acknowledge();
  await ui.click('choose-folder');
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#automatic-install'].disabled, true);
  assert.match(ui.nodes['#action-status'].textContent, /currently loaded extension folder/);
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'error');
  assert.ok(!ui.messages.some((message) => message.type === 'updates:install'));
});

test('a core abort after picking is an operation failure, not a misleading picker cancellation', async () => {
  const ui = await harness({ connectError: new DOMException('Folder validation was interrupted.', 'AbortError') });
  await ui.acknowledge();
  await ui.click('choose-folder');
  assert.match(ui.nodes['#action-status'].textContent, /validation was interrupted/);
  assert.doesNotMatch(ui.nodes['#action-status'].textContent, /saved setup is unchanged/);
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'error');
});

test('automatic installation needs connected granted state and fresh unchecked-page acknowledgement', async () => {
  const ui = await harness({ folder: connected() });
  assert.equal(ui.nodes['#single-profile-ack'].checked, false);
  assert.equal(ui.nodes['#automatic-install'].disabled, true);
  await ui.click('automatic-install');
  assert.ok(!ui.calls.some((call) => call.type === 'core:automatic'));
  await ui.acknowledge();
  assert.equal(ui.nodes['#automatic-install'].disabled, false);
  await ui.click('automatic-install');
  assert.deepEqual(ui.calls.filter((call) => call.type === 'core:automatic'), [{ type: 'core:automatic', value: true }]);
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'true');
  assert.match(ui.nodes['#automatic-state'].textContent, /without another click/);
  assert.ok(ui.messages.every((message) => message.type === 'updates:get'), 'Opt-in itself is not an installation request');
});

test('revoked permission pauses file operations but still allows turning existing automatic opt-in off', async () => {
  for (const permission of ['prompt', 'denied', 'unavailable']) {
    const ui = await harness({ folder: connected({ permission, state: 'needs-permission', autoInstall: true }), manager: { latest, available: true } });
    await ui.acknowledge();
    assert.equal(ui.nodes['#install-beta'].disabled, true, permission);
    assert.equal(ui.nodes['#restore-folder-access'].hidden, false, permission);
    assert.equal(ui.nodes['#restore-folder-access'].disabled, permission === 'unavailable', permission);
    assert.equal(ui.nodes['#choose-folder'].disabled, false, permission);
    assert.equal(ui.nodes['#choose-folder'].textContent, 'Change folder');
    assert.match(ui.nodes['#folder-status'].textContent, /Updates are paused/);
    assert.match(ui.nodes['#automatic-state'].textContent, /paused/);
    await ui.acknowledge(false);
    assert.equal(ui.nodes['#automatic-install'].disabled, false, 'Existing opt-in can always be switched off');
    await ui.click('automatic-install');
    assert.equal(ui.state.folder.autoInstall, false);
    assert.equal(ui.nodes['#automatic-install'].disabled, true);
    assert.ok(!ui.calls.some((call) => call.type === 'picker'));
    assert.ok(!ui.messages.some((message) => message.type === 'updates:install'));
  }
});

test('checking and installation use only the reserved background RPCs, not direct file installation', async () => {
  const ui = await harness({ folder: connected() });
  await ui.click('check-beta');
  assert.ok(ui.messages.some((message) => message.type === 'updates:check'));
  assert.equal(ui.nodes['#single-profile-ack'].checked, false, 'Known-folder manual installation reuses saved core consent');
  assert.equal(ui.nodes['#install-beta'].disabled, false);
  assert.equal(ui.nodes['#view-beta-release'].href, latest.url);
  await ui.click('install-beta');
  assert.deepEqual(ui.messages.filter((message) => message.type !== 'updates:get'), [{ type: 'updates:check' }, { type: 'updates:install' }]);
  assert.equal(ui.nodes['#folder-recovery'].hidden, false);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.match(ui.nodes['#recovery-message'].textContent, /previous build.*waits for active work/);
});

test('an older beta fixture still labels same-version stable promotion truthfully and leaves ordering to the manager', async () => {
  const release = { version: '2.3.1', prerelease: false, url: repository + '/releases/tag/v2.3.1' };
  const ui = await harness({ manifest: { version: '2.3.1', version_name: '2.3.1 BETA' }, folder: connected({ installedVersion: '2.3.1' }), manager: { latest: release, available: true } });
  await ui.acknowledge();
  assert.match(ui.nodes['#update-status'].textContent, /^Stable 2\.3\.1 is available/);
  assert.equal(ui.nodes['#view-beta-release'].textContent, 'View checked release');
  assert.equal(ui.nodes['#install-beta'].textContent, 'Install checked release');
  assert.equal(ui.nodes['#install-beta'].disabled, false);
  assert.equal(ui.nodes['#view-beta-release'].href, release.url);
  assert.equal(ui.nodes['#running-version'].textContent, '2.3.1 BETA');
});

test('forget is an explicit confirmed background action and never deletes via the UI', async () => {
  const cancelled = await harness({ folder: connected(), confirm: false });
  await cancelled.click('forget-folder');
  assert.ok(!cancelled.messages.some((message) => message.type === 'folder:forget'));
  const ui = await harness({ folder: connected({ autoInstall: true }) });
  await ui.click('forget-folder');
  assert.deepEqual(ui.messages.filter((message) => message.type !== 'updates:get'), [{ type: 'folder:forget' }]);
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'false');
  assert.equal(ui.nodes['#forget-folder'].disabled, true);
  assert.match(ui.nodes['#action-status'].textContent, /forgotten/);
  assert.doesNotMatch(source, /removeEntry|removeFile|forgetFolder\s*\(/);
});

test('pending recovery blocks new installs and forgetting; recovery uses the busy-gated background RPC', async () => {
  const ui = await harness({ folder: connected({ recoveryPending: true, state: 'needs-recovery' }), manager: { latest, available: true } });
  await ui.acknowledge();
  assert.equal(ui.nodes['#folder-recovery'].hidden, false);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#forget-folder'].disabled, true);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#automatic-install'].disabled, true);
  await ui.click('install-beta'); await ui.click('forget-folder');
  await ui.click('recover-folder');
  assert.deepEqual(ui.messages.filter((message) => message.type !== 'updates:get'), [{ type: 'folder:recover' }]);
  assert.equal(ui.state.folder.recoveryPending, false);
  assert.equal(ui.nodes['#install-beta'].disabled, true, 'Reload must complete after restored files');
  assert.doesNotMatch(source, /recoverFolder\s*\(/);
});

test('lost permission during recovery offers saved-folder Restore, not a different folder or silent recovery', async () => {
  const ui = await harness({ folder: connected({ recoveryPending: true, state: 'needs-recovery', permission: 'prompt' }) });
  assert.equal(ui.nodes['#single-profile-ack'].checked, false);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
  assert.equal(ui.nodes['#recover-folder'].disabled, true);
  assert.equal(ui.nodes['#independent-recovery'].href, './updater-recovery.html');
  assert.ok(!ui.calls.some((call) => call.type === 'picker'));
});

test('background failure leaves independent rescue available and keeps gated actions disabled', async () => {
  const ui = await harness({ folder: connected({ recoveryPending: true, state: 'needs-recovery' }), backgroundError: true });
  assert.equal(ui.nodes['#background-status'].hidden, false);
  assert.equal(ui.nodes['#check-beta'].disabled, true);
  assert.equal(ui.nodes['#recover-folder'].disabled, true);
  assert.equal(ui.nodes['#forget-folder'].disabled, true);
  assert.equal(ui.nodes['#independent-recovery'].href, './updater-recovery.html');
  assert.equal(ui.nodes['#folder-name'].textContent, 'allen-toolbox');
  assert.match(ui.nodes['#background-status'].textContent, /does not depend on it/);
  await ui.click('recover-folder');
  assert.ok(!ui.messages.some((message) => message.type === 'folder:recover'));
});

test('state-read errors fail closed for write controls without hiding the rescue link', async () => {
  const ui = await harness({ stateError: true, manager: { latest, available: true } });
  await ui.acknowledge();
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#automatic-install'].disabled, true);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
  assert.match(ui.nodes['#folder-status'].textContent, /Could not read/);
  assert.equal(ui.nodes['#independent-recovery'].href, './updater-recovery.html');
});

test('busy-gate rejection is visible and does not retry installation or bypass the background', async () => {
  const ui = await harness({ folder: connected(), manager: { latest, available: true }, rpc(message) {
    if (message.type === 'updates:install') return { error: 'Downloads are still running. Installation deferred.' };
  } });
  await ui.acknowledge();
  await ui.click('install-beta');
  assert.match(ui.nodes['#action-status'].textContent, /Downloads are still running/);
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'error');
  assert.equal(ui.messages.filter((message) => message.type === 'updates:install').length, 1);
  assert.ok(!ui.calls.some((call) => call.type === 'core:connect' || call.type === 'core:automatic'));
});

test('manager errors remain legitimate state feedback instead of success or automatic installation', async () => {
  const ui = await harness({ folder: connected(), rpc(message, state) {
    if (message.type === 'updates:check') { state.setManager({ error: 'GitHub rate limited. Try again later.', available: false }); return { ...state.manager, native: state.folder }; }
  } });
  await ui.acknowledge();
  await ui.click('check-beta');
  assert.match(ui.nodes['#action-status'].textContent, /rate limited/);
  assert.match(ui.nodes['#update-status'].textContent, /rate limited/);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.ok(!ui.messages.some((message) => message.type === 'updates:install'));
});

test('structured deferred or permission results are warnings, not successful installs', async () => {
  for (const status of ['deferred', 'needs-permission']) {
    const ui = await harness({ folder: connected(), manager: { latest, available: true }, rpc(message, state) {
      if (message.type === 'updates:install') {
        state.setFolder(connected({ state: status, message: 'Installation is paused; review folder access or active work.' }));
        return { ...state.manager, native: state.folder };
      }
    } });
    await ui.acknowledge();
    await ui.click('install-beta');
    assert.equal(ui.nodes['#action-status'].dataset.tone, 'warning');
    assert.match(ui.nodes['#action-status'].textContent, /paused/);
    assert.equal(ui.messages.filter((message) => message.type === 'updates:install').length, 1);
  }
});

test('folder names and release errors stay plain text; foreign or unexpected-source release links cannot install', async () => {
  const name = '<img src=x onerror="unexpected()">';
  for (const manager of [{ latest: { version: '<b>2.3.2</b>', url: 'javascript:unexpected()' }, available: true },
    { latest: { version: '2.3.2', url: 'https://github.com/other/repo/releases/tag/v2.3.2' }, available: true },
    { repository: 'https://github.com/other/repo', latest, available: true }]) {
    const ui = await harness({ folder: connected({ folderName: name }), manager });
    await ui.acknowledge();
    assert.equal(ui.nodes['#folder-name'].textContent, name);
    assert.equal(ui.nodes['#install-beta'].disabled, true);
    assert.ok(!ui.nodes['#view-beta-release'].href.startsWith('javascript:'));
    assert.equal(ui.nodes['#update-source'].href, repository);
  }
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});

test('focus and explicit refresh only reread state and never start installation or prompt for access', async () => {
  const ui = await harness({ folder: connected() });
  ui.state.setFolder(connected({ permission: 'prompt', state: 'needs-permission' }));
  await ui.window.emit('focus'); await tick();
  assert.match(ui.nodes['#folder-status'].textContent, /Updates are paused/);
  await ui.click('refresh-state');
  assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
  assert.equal(ui.calls.filter((call) => call.type === 'core:prepare').length, 3);
  assert.ok(!ui.calls.some((call) => call.type === 'picker' || call.type === 'permission' || call.type === 'persist' || call.type === 'core:automatic'));
});

test('running build comes from the manifest label, with no default beta label or chosen codename', async () => {
  const versionOnly = await harness();
  assert.equal(versionOnly.nodes['#running-version'].textContent, '2.4.0');
  const named = await harness({ manifest: { version: '2.4.0', version_name: '2.4.0 user-selected-label' } });
  assert.equal(named.nodes['#running-version'].textContent, '2.4.0 user-selected-label');
  assert.doesNotMatch(source, /2\.4\.0|2\.3\.1|Vector|Optimus/);
});

test('remembered granted connection and opt-in survive page load without permission or storage requests', async () => {
  const ui = await harness({ folder: connected({ autoInstall: true }), persist: () => Promise.resolve(true) });
  assert.equal(ui.nodes['#folder-connection'].textContent, 'Remembered in this browser/profile');
  assert.equal(ui.nodes['#folder-permission'].textContent, 'Granted');
  assert.equal(ui.nodes['#choose-folder'].textContent, 'Change folder');
  assert.equal(ui.nodes['#choose-folder'].className, 'button quiet');
  assert.equal(ui.nodes['#choose-folder'].disabled, true, 'Changing a folder remains a separately acknowledged action');
  assert.equal(ui.nodes['#restore-folder-access'].hidden, true);
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'true');
  await ui.window.emit('focus'); await tick();
  assert.equal(ui.state.folder.autoInstall, true);
  assert.ok(ui.calls.every((call) => ['manifest', 'core:get', 'core:prepare', 'rpc'].includes(call.type)));
});

test('saved-folder restore invokes native permission first in the click and preserves opt-in without acknowledgement', async () => {
  for (const autoInstall of [false, true]) {
    let grant;
    const permission = new Promise((resolve) => { grant = resolve; });
    const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall }), permissionRequest: () => permission });
    assert.equal(ui.nodes['#single-profile-ack'].checked, false);
    assert.equal(ui.nodes['#restore-folder-access'].hidden, false);
    assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
    ui.calls.length = 0; ui.messages.length = 0;
    const pending = ui.nodes['#restore-folder-access'].emit('click');
    assert.equal(ui.calls.length, 1, 'No getState, prepare, RPC, storage or other API may precede the native permission request');
    assert.equal(ui.calls[0].type, 'permission');
    assert.equal(ui.calls[0].handle, ui.handle);
    assert.deepEqual(ui.calls[0].options, { mode: 'readwrite' });
    assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
    assert.equal(ui.nodes['#choose-folder'].disabled, true);
    await ui.nodes['#restore-folder-access'].emit('click');
    assert.equal(ui.calls.length, 1, 'Repeated clicks cannot request another permission while pending');
    grant('granted'); await pending; await tick();
    assert.equal(ui.state.folder.connected, true);
    assert.equal(ui.state.folder.autoInstall, autoInstall);
    assert.equal(ui.nodes['#folder-permission'].textContent, 'Granted');
    assert.equal(ui.nodes['#restore-folder-access'].hidden, true);
    assert.equal(ui.nodes['#single-profile-ack'].checked, false);
    assert.match(ui.nodes['#action-status'].textContent, /Write access restored.*automatic installation choice are unchanged.*No update was installed/);
    assert.ok(!ui.calls.some((call) => ['picker', 'core:connect', 'core:automatic'].includes(call.type)));
    assert.deepEqual(ui.messages, [{ type: 'updates:get' }]);
  }
});

test('denied restore retains the saved folder, opt-in, and retry button without selecting again or persisting', async () => {
  const ui = await harness({ folder: connected({ permission: 'denied', state: 'needs-permission', autoInstall: true }), grant: 'denied', persist: () => Promise.resolve(true) });
  ui.calls.length = 0;
  await ui.click('restore-folder-access');
  assert.equal(ui.calls[0].type, 'permission');
  assert.equal(ui.state.folder.connected, true);
  assert.equal(ui.state.folder.autoInstall, true);
  assert.equal(ui.nodes['#folder-permission'].textContent, 'Revoked or denied');
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
  assert.equal(ui.nodes['#automatic-install'].disabled, false, 'Existing opt-in can still be turned off');
  assert.match(ui.nodes['#action-status'].textContent, /not approved.*saved folder is unchanged/);
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'warning');
  assert.ok(!ui.calls.some((call) => ['picker', 'persist', 'core:connect', 'core:automatic'].includes(call.type)));
  assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
});

test('cancelled saved-folder permission request leaves the connection and automatic choice unchanged', async () => {
  const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }),
    permissionRequest: () => Promise.reject(new DOMException('Cancelled', 'AbortError')) });
  ui.calls.length = 0;
  await ui.click('restore-folder-access');
  assert.equal(ui.calls[0].type, 'permission');
  assert.equal(ui.state.folder.permission, 'prompt');
  assert.equal(ui.state.folder.autoInstall, true);
  assert.equal(ui.state.folder.connected, true);
  assert.match(ui.nodes['#action-status'].textContent, /not approved.*remembered folder and automatic installation choice were not changed/);
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'warning');
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
  assert.ok(!ui.calls.some((call) => ['picker', 'persist', 'core:connect', 'core:automatic'].includes(call.type)));
});

test('synchronous saved permission errors do not fall back to folder selection or expose private API details', async () => {
  const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }),
    permissionRequest() { throw new DOMException('token=fixture-private-token https://user:pass@example.invalid/private', 'SecurityError'); } });
  ui.calls.length = 0;
  await ui.click('restore-folder-access');
  assert.deepEqual(ui.calls.map((call) => call.type), ['permission']);
  assert.equal(ui.state.folder.connected, true);
  assert.equal(ui.state.folder.autoInstall, true);
  assert.match(ui.nodes['#action-status'].textContent, /Refresh status or open Recovery and Help/);
  assert.doesNotMatch(ui.nodes['#action-status'].textContent, /fixture-private-token|user:pass|example\.invalid/);
});

test('restore stays disabled during preparation and refresh never uses a stale prepared callback', async () => {
  let release;
  const preparing = new Promise((resolve) => { release = resolve; });
  const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission' }),
    prepare(state, count) { if (count === 2) return preparing; } });
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
  ui.calls.length = 0;
  const refresh = ui.nodes['#refresh-state'].emit('click');
  await tick();
  assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
  assert.equal(ui.nodes['#restore-folder-access'].textContent, 'Preparing saved access...');
  assert.match(ui.nodes['#restore-support'].textContent, /No permission prompt/);
  await ui.click('restore-folder-access');
  assert.ok(!ui.calls.some((call) => call.type === 'permission' || call.type === 'picker'));
  release(undefined); await refresh;
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
  ui.calls.length = 0;
  await ui.click('restore-folder-access');
  assert.equal(ui.calls[0].type, 'permission');
});

test('unavailable or failed preparation leaves the saved connection visible and never opens a replacement picker', async () => {
  for (const options of [{ prepare: () => null }, { prepareError: true }, { folder: connected({ permission: 'prompt', state: 'error', error: 'FOLDER_MOVED' }) }]) {
    const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }), ...options });
    assert.equal(ui.nodes['#folder-connection'].textContent, 'Remembered in this browser/profile');
    assert.equal(ui.nodes['#restore-folder-access'].hidden, false);
    assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
    assert.equal(ui.nodes['#restore-support'].hidden, false);
    assert.match(ui.nodes['#restore-support'].textContent, /Refresh status or open Recovery and Help/);
    ui.calls.length = 0;
    await ui.click('restore-folder-access'); await ui.click('choose-folder');
    assert.deepEqual(ui.calls, [], 'Neither a disabled restore nor unacknowledged Change folder can prompt');
    assert.equal(ui.state.folder.connected, true);
  }
});

test('remembered handle restore works without a picker or background, keeping gated actions unavailable', async () => {
  const ui = await harness({ unsupported: true, backgroundError: true, folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }) });
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  await ui.click('restore-folder-access');
  assert.equal(ui.state.folder.permission, 'granted');
  assert.equal(ui.state.folder.autoInstall, true);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#forget-folder'].disabled, true);
  assert.equal(ui.nodes['#independent-recovery'].href, './updater-recovery.html');
  assert.ok(!ui.calls.some((call) => call.type === 'picker' || call.type === 'core:connect'));
});

test('restoring recovery access preserves the journal and opt-in without installing, recovering, or reloading', async () => {
  const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-recovery', recoveryPending: true, requiresReload: true, autoInstall: true }) });
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  await ui.click('restore-folder-access');
  assert.equal(ui.state.folder.permission, 'granted');
  assert.equal(ui.state.folder.recoveryPending, true);
  assert.equal(ui.state.folder.requiresReload, true);
  assert.equal(ui.state.folder.autoInstall, true);
  assert.equal(ui.nodes['#folder-recovery'].hidden, false);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#forget-folder'].disabled, true);
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'warning');
  assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
  assert.ok(!ui.calls.some((call) => call.type === 'picker' || call.type === 'core:connect' || call.type === 'core:automatic'));
  assert.doesNotMatch(source, /runtime\.reload|folder:recover[^\n]*restoreFolderAccess/);
});

test('busy or stale prepared results are not presented as a successful restore or an invitation to pick again', async () => {
  for (const result of [connected({ permission: 'granted', state: 'deferred', error: 'BUSY', recoveryPending: true, autoInstall: true, message: 'Active work is still running. Review saved folder status.' }),
    connected({ permission: 'granted', state: 'error', error: 'CONNECTION_CHANGED', autoInstall: true, message: 'The saved connection changed. Refresh status before retrying.' })]) {
    const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }), restoreResult: result });
    await ui.click('restore-folder-access');
    assert.notEqual(ui.nodes['#action-status'].dataset.tone, 'success');
    assert.equal(ui.nodes['#install-beta'].disabled, true);
    assert.ok(!ui.calls.some((call) => call.type === 'picker' || call.type === 'core:connect'));
    assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
  }
});

test('automatic release-check setting is separate from the file opt-in and never toggles either on page load', async () => {
  for (const automatic of [true, false]) {
    const ui = await harness({ folder: connected({ autoInstall: false }), manager: { automatic } });
    assert.match(ui.nodes['#automatic-check-state'].textContent, new RegExp('Automatic release checks: ' + (automatic ? 'On' : 'Off')));
    assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'false');
    assert.ok(!ui.calls.some((call) => call.type === 'core:automatic'));
    assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
  }
});

test('persistent browser storage is requested only after explicit granted Connect or Restore, never on load or focus', async () => {
  for (const restore of [false, true]) {
    const ui = await harness({ folder: restore ? connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }) : disconnected(), persist: () => Promise.resolve(true) });
    await ui.window.emit('focus'); await tick();
    assert.ok(!ui.calls.some((call) => call.type === 'persist'));
    if (!restore) await ui.acknowledge();
    ui.calls.length = 0;
    await ui.click(restore ? 'restore-folder-access' : 'choose-folder');
    assert.equal(ui.calls[0].type, restore ? 'permission' : 'picker');
    assert.equal(ui.calls.filter((call) => call.type === 'persist').length, 1);
    assert.ok(ui.calls.findIndex((call) => call.type === 'persist') > ui.calls.findIndex((call) => call.type === (restore ? 'permission' : 'core:connect')));
    assert.match(ui.nodes['#storage-status'].textContent, /storage approved.*folder permission is not permanent/);
    assert.equal(ui.state.folder.connected, true);
    assert.equal(ui.state.folder.autoInstall, restore);
    await ui.window.emit('focus'); await tick();
    assert.equal(ui.calls.filter((call) => call.type === 'persist').length, 1);
  }
});

test('denied or failing storage persistence cannot undo a connection or lose an existing recovery journal', async () => {
  for (const persist of [() => Promise.resolve(false), () => Promise.reject(new Error('token=fixture-private-storage-detail'))]) {
    for (const recoveryPending of [false, true]) {
      const ui = await harness({ folder: connected({ permission: 'prompt', state: recoveryPending ? 'needs-recovery' : 'needs-permission', recoveryPending, autoInstall: true }), persist });
      await ui.click('restore-folder-access');
      assert.equal(ui.state.folder.connected, true);
      assert.equal(ui.state.folder.permission, 'granted');
      assert.equal(ui.state.folder.recoveryPending, recoveryPending);
      assert.equal(ui.state.folder.autoInstall, true);
      assert.equal(ui.nodes['#folder-recovery'].hidden, !recoveryPending);
      assert.match(ui.nodes['#storage-status'].textContent, /storage (?:was not|could not be) approved/);
      assert.doesNotMatch(ui.nodes['#storage-status'].textContent, /fixture-private-storage-detail/);
      assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
    }
  }
});

test('a pending storage-persistence result never keeps successful folder connection busy', async () => {
  let finish;
  const storage = new Promise((resolve) => { finish = resolve; });
  const ui = await harness({ persist: () => storage });
  await ui.acknowledge();
  await ui.click('choose-folder');
  assert.equal(ui.state.folder.connected, true);
  assert.equal(ui.nodes['#setup'].getAttribute('aria-busy'), 'false');
  assert.equal(ui.nodes['#refresh-state'].disabled, false);
  assert.match(ui.nodes['#action-status'].textContent, /Folder connected/);
  assert.match(ui.nodes['#storage-status'].textContent, /Requesting persistent browser storage/);
  finish(false); await tick();
  assert.match(ui.nodes['#storage-status'].textContent, /not approved/);
});

test('a post-restore storage-read error keeps the last remembered recovery visible and blocks new folder writes', async () => {
  const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-recovery', recoveryPending: true, autoInstall: true }),
    stateError(state) { return state.folder.permission === 'granted'; } });
  await ui.click('restore-folder-access');
  assert.equal(ui.state.folder.connected, true);
  assert.equal(ui.state.folder.recoveryPending, true);
  assert.equal(ui.state.folder.autoInstall, true);
  assert.match(ui.nodes['#folder-status'].textContent, /Could not read the saved folder connection/);
  assert.equal(ui.nodes['#folder-recovery'].hidden, false);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#recover-folder'].disabled, true);
  assert.match(ui.nodes['#automatic-state'].textContent, /saved automatic setting is unavailable.*No opt-in was changed/);
  assert.equal(ui.nodes['#independent-recovery'].href, './updater-recovery.html');
  assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
});

test('busy permission restore returns promptly without rereading behind an active writer, and explicit refresh can resolve it', async () => {
  const deferred = connected({ permission: 'unavailable', state: 'deferred', error: 'BUSY', recoveryPending: true, autoInstall: true,
    message: 'Folder access was requested, but another updater action is still running. Refresh after it finishes.' });
  const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }), restoreResult: deferred });
  ui.calls.length = 0; ui.messages.length = 0;
  await ui.click('restore-folder-access');
  assert.deepEqual(ui.calls.map((call) => call.type), ['permission'], 'No queued getState or prepare may wait behind the writer after a nonwaiting BUSY result');
  assert.deepEqual(ui.messages, []);
  assert.equal(ui.nodes['#setup'].getAttribute('aria-busy'), 'false');
  assert.equal(ui.nodes['#folder-recovery'].hidden, false);
  assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#forget-folder'].disabled, true);
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'true');
  assert.equal(ui.nodes['#action-status'].dataset.tone, 'warning');
  ui.state.setFolder(connected({ autoInstall: true }));
  await ui.click('refresh-state');
  assert.equal(ui.nodes['#folder-recovery'].hidden, true);
  assert.equal(ui.nodes['#folder-permission'].textContent, 'Granted');
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'true');
  assert.ok(ui.messages.every((message) => message.type === 'updates:get'));
});

test('unknown durable storage is not mistaken for a forgotten folder or confirmed automatic opt-out', async () => {
  const ui = await harness({ folder: disconnected({ state: 'needs-recovery', error: 'STORAGE_FAILED', recoveryPending: true,
    message: 'Saved storage is unavailable. Recovery status is unknown; writes must remain blocked.' }) });
  await ui.acknowledge();
  assert.match(ui.nodes['#folder-connection'].textContent, /Saved status unavailable; no connection was forgotten/);
  assert.match(ui.nodes['#automatic-state'].textContent, /saved automatic setting is unavailable.*No opt-in was changed/);
  assert.doesNotMatch(ui.nodes['#automatic-state'].textContent, /^Off\./);
  assert.equal(ui.nodes['#folder-name'].textContent, 'Unavailable');
  assert.equal(ui.nodes['#folder-version'].textContent, 'Unavailable');
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.equal(ui.nodes['#restore-folder-access'].disabled, true);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#forget-folder'].disabled, true);
  assert.equal(ui.nodes['#folder-recovery'].hidden, false);
  ui.calls.length = 0;
  await ui.click('choose-folder'); await ui.click('restore-folder-access');
  assert.deepEqual(ui.calls, []);
});

test('visibility refresh prepares saved access only while visible and never prompts, installs, or requests persistence', async () => {
  const ui = await harness({ folder: connected({ permission: 'prompt', state: 'needs-permission', autoInstall: true }), persist: () => Promise.resolve(true) });
  ui.calls.length = 0; ui.messages.length = 0;
  ui.document.visibilityState = 'hidden';
  await ui.document.emit('visibilitychange'); await tick();
  assert.deepEqual(ui.calls, []);
  ui.document.visibilityState = 'visible';
  await ui.document.emit('visibilitychange'); await tick();
  assert.deepEqual(ui.calls.map((call) => call.type), ['core:get', 'rpc', 'core:prepare']);
  assert.deepEqual(ui.messages, [{ type: 'updates:get' }]);
  assert.equal(ui.state.folder.autoInstall, true);
  assert.equal(ui.nodes['#restore-folder-access'].disabled, false);
});

test('setup controls keep valid accessible descriptions and unique stable DOM IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/\baria-(?:describedby|labelledby)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/)) assert.ok(ids.includes(id), 'Missing accessible description ' + id);
  }
  for (const id of ['choose-folder', 'restore-folder-access', 'single-profile-ack', 'automatic-install', 'check-beta', 'install-beta']) assert.ok(ids.includes(id));
  assert.match(html, /id="restore-folder-access"[^>]*type="button"[^>]*aria-describedby="saved-folder-help restore-support"/);
  assert.match(html, /id="automatic-install"[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Automatic file installation"/);
});

test('release links must use exact official numeric tags with the optional supported prerelease suffix', async () => {
  const base = repository + '/releases/tag/';
  for (const url of [base + 'v2.3.2-beta/extra', base + 'v2.3.2-beta/', base + '%762.3.2-beta', base + 'v2.3.2-preview', base + 'v02.3.2',
    base + 'v0.0.0', base + 'v65536.0', base + 'v2.3.2?token=fixture', base + 'v2.3.2#private', 'https://user:pass@github.com/supreme12343/allen-toolbox/releases/tag/v2.3.2',
    'https://github.com:443/supreme12343/allen-toolbox/releases/tag/v2.3.2']) {
    const ui = await harness({ folder: connected(), manager: { latest: { ...latest, url }, available: true } });
    assert.equal(ui.nodes['#view-beta-release'].hidden, true, url);
    assert.equal(ui.nodes['#install-beta'].disabled, true, url);
  }
  for (const release of [latest, { version: '2.4.0', prerelease: false, url: base + 'v2.4.0' }]) {
    const ui = await harness({ folder: connected(), manager: { latest: release, available: true } });
    assert.equal(ui.nodes['#view-beta-release'].href, release.url);
    assert.equal(ui.nodes['#install-beta'].disabled, false);
  }
});

test('error feedback stays meaningful without exposing raw secret-bearing messages or internal error codes', async () => {
  for (const error of ['token=fixture-private-token', 'Authorization: Bearer fixture-private-value', 'https://user:pass@example.invalid/private?token=fixture',
    'C:\\Users\\private-user\\private-folder', 'UNKNOWN_INTERNAL_CODE']) {
    const ui = await harness({ folder: connected(), manager: { error }, rpc(message) {
      if (message.type === 'updates:check') return { error };
    } });
    assert.doesNotMatch(ui.nodes['#update-status'].textContent, /fixture-private|user:pass|private-user|UNKNOWN_INTERNAL_CODE/);
    await ui.click('check-beta');
    assert.match(ui.nodes['#action-status'].textContent, /Review the folder status|Retry later/);
    assert.doesNotMatch(ui.nodes['#action-status'].textContent, /fixture-private|user:pass|private-user|UNKNOWN_INTERNAL_CODE/);
    assert.equal(ui.nodes['#action-status'].dataset.tone, 'error');
  }
});

test('standalone rescue has frozen-style local markup, exact core IDs, disabled actions, and only the standalone script', () => {
  assert.match(recovery, /<title>ALLEN Toolbox Recovery and Help<\/title>/);
  assert.match(recovery, /name="viewport" content="width=device-width, initial-scale=1"/);
  const scripts = [...recovery.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((match) => match[0]);
  assert.deepEqual(scripts, ['<script defer src="./updater-recovery.js"></script>']);
  assert.doesNotMatch(recovery, /type="module"|<link\b[^>]*stylesheet|\son(?:click|load)\s*=|fonts\.googleapis/);
  for (const id of ['recovery-status', 'recovery-details', 'recover-folder', 'reload-extension', 'reconnect-recovery']) assert.ok(recovery.includes('id="' + id + '"'), id);
  for (const id of ['recover-folder', 'reload-extension', 'reconnect-recovery']) assert.match(recovery, new RegExp('<button[^>]*id="' + id + '"[^>]*\\sdisabled>'));
  assert.match(recovery, /id="recovery-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(recovery, /Stop other work before recovering/);
  assert.match(recovery, /does not grant folder permission or start recovery/);
  assert.match(recovery, /cannot see work in another browser\/profile/);
  assert.match(recovery, /Folder updates are not atomic/);
  assert.match(recovery, /saved journal.*original bytes.*unavailable or changed/);
  assert.match(recovery, /min-height:\s*44px/);
  assert.match(recovery, /focus-visible[^}]*outline:/);
  assert.match(recovery, /href="\.\/updater\.html"/);
  assert.match(recovery, /popup\.html\?dashboard=1&amp;view=tools/);
  assert.match(recovery, /No folder permission has been requested/);
});
