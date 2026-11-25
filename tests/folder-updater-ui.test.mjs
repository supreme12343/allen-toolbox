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
const connected = (extra = {}) => disconnected({ connected: true, permission: 'granted', state: 'ready', installedVersion: '2.3.1', folderName: 'allen-toolbox', ...extra });

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
  let manager = { repository, installedVersion: '2.3.1', latest: null, available: false, error: '', ...options.manager };
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
  const chrome = { runtime: {
    getManifest() { calls.push({ type: 'manifest' }); return { version: '2.3.1', version_name: '2.3.1 BETA' }; },
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
  runInNewContext(script, { document, window, chrome, URL, console,
    async getFolderUpdateState() { calls.push({ type: 'core:get' }); if (options.stateError) throw new Error('Fixture state unavailable'); return plain(folder); },
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

test('setup is a local full-tab page with fixed source, stable escape hatch, and unchecked explicit consent', () => {
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /href="\.\/theme\.css"/);
  assert.match(html, /<script type="module" src="\.\/updater\.js"><\/script>/);
  assert.match(html, /full-tab setup, not a toolbar popup/);
  assert.match(html, /2\.3\.1 BETA/);
  assert.ok(html.includes('href="' + repository + '"'));
  assert.ok(html.includes(repository + '/releases/tag/v2.3.0'));
  assert.match(html, /popup\.html\?dashboard=1&amp;view=tools/);
  assert.match(html, /I use this folder only in this browser\/profile and accept beta testing risks/);
  const checkbox = html.match(/<input\b[^>]*id="single-profile-ack"[^>]*>/)[0];
  assert.match(checkbox, /type="checkbox"/);
  assert.doesNotMatch(checkbox, /\schecked(?:\s|=|>)/);
  assert.match(html, /for="single-profile-ack"/);
  assert.match(html, /containing <code>manifest\.json<\/code>/);
  assert.match(html, /read\/write access/);
  assert.match(html, /revokes folder permission, updates pause/);
  assert.match(html, /not atomic/);
  assert.match(html, /No Store installation, executable, PowerShell, or Windows helper/);
  assert.doesNotMatch(html, /type="(?:text|url)"|fonts\.googleapis|https?:\/\/[^"\s]+\.(?:js|css)["\s]/);
});

test('new setup styles preserve theme tokens, amber beta treatment, 44px controls, focus, and small-screen flow', () => {
  assert.match(css, /font:[^;]*var\(--font-ui\)/);
  assert.match(css, /\.button\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/);
  assert.match(css, /\.acknowledgement\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.automatic-toggle\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /focus-visible[^}]*outline:\s*2px solid var\(--blue\)/);
  const beta = css.match(/\.button\.beta-action\s*\{([^}]*)\}/)[1];
  assert.match(beta, /background:\s*var\(--warning-bg\)/);
  assert.match(beta, /color:\s*var\(--amber\)/);
  assert.doesNotMatch(beta, /var\(--primary\)/);
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
  assert.equal(ui.nodes['#automatic-install'].getAttribute('aria-checked'), 'false');
  assert.equal(ui.nodes['#automatic-install'].disabled, true);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#check-beta'].disabled, false);
  assert.deepEqual(ui.messages, [{ type: 'updates:get' }]);
  assert.ok(ui.calls.every((call) => ['manifest', 'core:get', 'rpc'].includes(call.type)));
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

test('cancelled selection preserves the saved connection and does not silently grant or opt in', async () => {
  const ui = await harness({ folder: connected(), picker: () => Promise.reject(new DOMException('Cancelled', 'AbortError')) });
  await ui.acknowledge(); ui.calls.length = 0;
  await ui.click('choose-folder');
  assert.deepEqual(ui.calls.map((call) => call.type), ['picker']);
  assert.match(ui.nodes['#action-status'].textContent, /selection cancelled.*saved setup is unchanged/);
  assert.equal(ui.state.folder.connected, true);
  assert.equal(ui.state.folder.autoInstall, false);
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
    assert.equal(ui.nodes['#choose-folder'].disabled, false, permission);
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
  assert.equal(ui.nodes['#install-beta'].disabled, true, 'A saved connection does not check this page acknowledgement');
  await ui.acknowledge();
  assert.equal(ui.nodes['#install-beta'].disabled, false);
  assert.equal(ui.nodes['#view-beta-release'].href, latest.url);
  await ui.click('install-beta');
  assert.deepEqual(ui.messages.filter((message) => message.type !== 'updates:get'), [{ type: 'updates:check' }, { type: 'updates:install' }]);
  assert.equal(ui.nodes['#folder-recovery'].hidden, false);
  assert.equal(ui.nodes['#install-beta'].disabled, true);
  assert.equal(ui.nodes['#choose-folder'].disabled, true);
  assert.match(ui.nodes['#recovery-message'].textContent, /previous build.*waits for active work/);
});

test('the beta setup labels a same-version stable promotion truthfully and leaves version ordering to the manager', async () => {
  const release = { version: '2.3.1', prerelease: false, url: repository + '/releases/tag/v2.3.1' };
  const ui = await harness({ folder: connected(), manager: { latest: release, available: true } });
  await ui.acknowledge();
  assert.match(ui.nodes['#update-status'].textContent, /^Stable 2\.3\.1 is available/);
  assert.equal(ui.nodes['#view-beta-release'].textContent, 'View stable release');
  assert.equal(ui.nodes['#install-beta'].textContent, 'Install checked stable release');
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

test('lost permission during recovery offers explicit reconnection instead of adopting or recovering a different folder silently', async () => {
  const ui = await harness({ folder: connected({ recoveryPending: true, state: 'needs-recovery', permission: 'prompt' }) });
  await ui.acknowledge();
  assert.equal(ui.nodes['#choose-folder'].disabled, false);
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
  assert.ok(!ui.calls.some((call) => call.type === 'picker' || call.type === 'core:automatic'));
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
