import { parseMeta, ensureHeader, sourceUrl as cleanSource, siteMatch, newScript, setMetaValue, scriptOrigins, MAX_SCRIPT_BYTES, assertScriptSize } from '../shared/usmeta.js';
import { exportExtensionBundle } from '../shared/package.js';

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const metaKeys = { match: 'matches', include: 'includes', exclude: 'excludes', 'exclude-match': 'excludeMatches', grant: 'grants', connect: 'connects', 'run-at': 'runAt', 'inject-into': 'injectInto' };
const hintContext = Object.fromEntries('unsafeWindow GM_info GM_getValue GM_setValue GM_deleteValue GM_listValues GM_addValueChangeListener GM_removeValueChangeListener GM_addStyle GM_addElement GM_setClipboard GM_log GM_getResourceText GM_getResourceURL GM_registerMenuCommand GM_unregisterMenuCommand GM_openInTab GM_notification GM_xmlhttpRequest GM_download'.split(' ').map((name) => [name, null]));
hintContext.GM = Object.fromEntries('info getValue setValue deleteValue listValues addStyle addElement setClipboard log getResourceText getResourceUrl registerMenuCommand unregisterMenuCommand openInTab notification xmlHttpRequest download'.split(' ').map((name) => [name, null]));
hintContext.AO = { ui: { button: null, panel: null, toast: null }, items: null, saveItem: null, hide: null, removeWhen: null, addCss: null, allowEvents: null, blockEvents: null, onReady: null, onMutation: null };
let source = cleanSource(params.get('source'));
let sourceTab = params.has('tab') ? Number(params.get('tab')) : null;
if (!Number.isInteger(sourceTab) || sourceTab < 0) sourceTab = null;
let scriptId = params.get('id') || null;
let draftKey, cm, savedCode = '', savedEnabled = true, revision;
let loaded = false, saving = false, dirty = false, allowExit = false, draftTimer, pendingDraft, pendingDraftKey;
let exporting = false, scanning = false;
let saveWarning = '';
let currentView = 'code', available = false, fallbackName = 'Untitled script';

async function bg(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result) throw new Error('The extension did not respond. Reload the extension and editor.');
  if (result.error && !(['us:save', 'us:toggle'].includes(type) && result.id)) throw new Error(result.error);
  return result;
}

function status(message, kind = '') {
  $('#status').textContent = message;
  $('#status').className = kind;
  $('#error-alert').hidden = kind !== 'error';
  $('#error-alert').textContent = kind === 'error' ? message : '';
}

function updateState() {
  if (!cm) return;
  const meta = parseMeta(cm.getValue());
  dirty = cm.getValue() !== savedCode || $('#enabled').checked !== savedEnabled;
  const name = meta.name || fallbackName;
  $('#script-title').textContent = name + (dirty ? ' *' : '');
  document.title = (dirty ? '* ' : '') + name + ' | ALLEN Toolbox';
  $('#save').disabled = $('#save-close').disabled = !loaded || saving || (!!scriptId && !dirty && !saveWarning);
  $('#export-bundle').disabled = !loaded || saving || exporting;
  $('#scan-bundles').disabled = !loaded || saving || scanning;
  $('#no-header').hidden = meta.hasHeader;
  const matches = [...meta.matches, ...meta.includes];
  $('#metadata-line').textContent = (matches.length ? matches.join(', ') : 'No @match') + ' | ' + (meta.noneGrant ? '@grant none' : meta.grants.length + ' APIs');
  $('#metadata-line').title = $('#metadata-line').textContent;
  const origins = scriptOrigins(meta);
  $('#permissions-summary').textContent = 'Site and dependency access: ' + (origins.join(', ') || 'none') +
    (!meta.connects.length && meta.grants.includes('GM_xmlhttpRequest') ? '. No @connect list: requests may use any host the extension can access.' : '') +
    (meta.requires.length || meta.resources.length ? '. Dependencies need network access and permissions on a fresh install.' : '');
}

function syncSettings() {
  const meta = parseMeta(cm.getValue());
  for (const field of document.querySelectorAll('[data-meta]')) {
    const key = field.dataset.meta;
    let value = meta[metaKeys[key] || key];
    if (!meta.hasHeader && key === 'name') value = fallbackName;
    if (!meta.hasHeader && key === 'match') value = [siteMatch(source)].filter(Boolean);
    if (key === 'grant' && meta.noneGrant) value = ['none'];
    if (field.type === 'checkbox') field.checked = !!value;
    else field.value = Array.isArray(value) ? value.join('\n') : value || '';
  }
}

function replaceCode(code, origin = 'paste') {
  cm.replaceRange(code, { line: 0, ch: 0 }, cm.posFromIndex(cm.getValue().length), origin);
  syncSettings();
  showView('code');
  cm.focus();
}

function changeMeta(field) {
  let code = cm.getValue();
  if (!parseMeta(code).hasHeader) {
    const matches = $('#meta-match').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!matches.length) matches.push(siteMatch(source) || '*://example.org/*');
    code = setMetaValue(ensureHeader(code, { name: $('#meta-name').value.trim() || fallbackName, match: matches[0] }), 'match', matches);
  }
  const values = field.type === 'checkbox' ? (field.checked ? [''] : []) : field.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const next = setMetaValue(code, field.dataset.meta, values);
  cm.replaceRange(next, { line: 0, ch: 0 }, cm.posFromIndex(cm.getValue().length), '+metadata');
}

function showView(view) {
  currentView = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('.view')) panel.hidden = panel.id !== 'view-' + view;
  if (view === 'code') { cm.refresh(); cm.focus(); }
  if (view === 'settings') syncSettings();
  if (view === 'scripts') refreshScripts().catch((error) => status(error.message, 'error'));
}

async function persistDraft() {
  clearTimeout(draftTimer);
  if (!loaded || !draftKey) return;
  if (!dirty) { if (!pendingDraft) await chrome.storage.local.remove(draftKey); return; }
  await chrome.storage.local.set({ [draftKey]: {
    code: cm.getValue(), enabled: $('#enabled').checked, baseUpdatedAt: revision,
    scriptId, source, tab: sourceTab, draft: params.get('draft'),
    name: parseMeta(cm.getValue()).name || fallbackName, updatedAt: Date.now(),
  } });
}

function queueDraft() {
  updateState();
  clearTimeout(draftTimer);
  if (loaded) draftTimer = setTimeout(() => persistDraft().catch((error) => status('Draft could not be saved: ' + error.message, 'error')), 300);
}

function restoreDraft(draft) {
  $('#enabled').checked = draft.enabled !== false;
  pendingDraft = null;
  pendingDraftKey = null;
  $('#draft-note').hidden = true;
  replaceCode(draft.code, 'draft');
  queueDraft();
  status('Local draft restored. Save to install these changes.', 'warning');
}

function checkSyntax(code) {
  // Compilation is confined to the existing sandbox; submitted code is never executed here.
  return new Promise((resolve) => {
    const frame = $('#syntax'), id = crypto.randomUUID();
    const send = () => frame.contentWindow.postMessage({ id, code }, '*');
    const finish = (error) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', send);
      resolve(error);
    };
    const onMessage = (event) => {
      if (event.source === frame.contentWindow && event.data?.id === id && typeof event.data.error === 'string') finish(event.data.error);
    };
    const timer = setTimeout(() => finish('Syntax checker unavailable. Reload this editor before saving.'), 4000);
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', send);
    try { send(); } catch (error) { finish(error.message); }
  });
}

async function requestOrigins(origins) {
  const missing = [];
  for (const origin of origins) if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  if (!missing.length) return true;
  return chrome.permissions.request({ origins: missing }).catch(() => false);
}

function setBusy(busy) {
  saving = busy;
  cm.setOption('readOnly', busy);
  for (const field of document.querySelectorAll('[data-edit]')) field.disabled = busy;
  $('#match-site').disabled = $('#match-page').disabled = busy || !source;
  updateState();
}

async function save(closeAfter = false) {
  if (!loaded || saving) return false;
  try {
    let code = cm.getValue();
    if (!code.trim()) throw new Error('The script is empty.');
    if (!parseMeta(code).hasHeader) {
      const name = $('#meta-name').value.trim(), matches = $('#meta-match').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!name || !matches.length) throw new Error('Open Settings and supply a name and @match for this script.');
      code = setMetaValue(ensureHeader(code, { name, match: matches[0] }), 'match', matches);
      replaceCode(code, '+header');
    }
    const meta = parseMeta(code);
    if (!meta.name) throw new Error('The header needs an @name line.');
    assertScriptSize(code);
    if (meta.noneGrant && meta.grants.length) throw new Error('Use @grant none alone, or remove it before adding GM grants.');
    setBusy(true);
    status('Checking script and site access...');
    // Begin site permission handling in the Save gesture, not after a sandbox message round-trip.
    const [syntax, granted] = await Promise.all([checkSyntax(code), requestOrigins(scriptOrigins(meta))]);
    if (syntax) throw new Error('Syntax error: ' + syntax);
    const enabled = $('#enabled').checked;
    const result = await bg('us:save', { id: scriptId || undefined, code, enabled, expectedUpdatedAt: revision });
    scriptId = result.id;
    revision = result.updatedAt;
    savedCode = code;
    savedEnabled = enabled;
    pendingDraft = null;
    pendingDraftKey = null;
    params.set('id', scriptId);
    history.replaceState(null, '', location.pathname + '?' + params);
    await chrome.storage.local.remove(draftKey);
    $('#draft-note').hidden = true;
    updateState();
    await refreshScripts();
    saveWarning = result.error || (!granted ? 'Saved, but site access was not granted. Use Save again after allowing access.' : !available ? 'Saved. Enable Allow User Scripts, then reload the website.' : !result.hasMatch ? 'Saved, but no valid @match / @include was found; the script will not run.' : '');
    updateState();
    status(saveWarning || 'Saved ' + result.name + '. Reload the website to run it.', saveWarning ? 'warning' : 'ok');
    if (closeAfter && !saveWarning && !dirty) await closeEditor();
    return true;
  } catch (error) {
    status(error.message, 'error');
    return false;
  } finally { setBusy(false); }
}

async function closeEditor() {
  if (saving && dirty) return;
  if (dirty && !confirm('Close this editor? Unsaved changes will be kept as a local draft.')) return;
  await persistDraft();
  allowExit = true;
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) await chrome.tabs.remove(tab.id);
  else window.close();
}

async function navigate(id, draft, restoreKey) {
  if (saving) return;
  if (dirty && !confirm('Leave this script? Unsaved changes will be kept as a local draft.')) return;
  await persistDraft();
  const next = new URLSearchParams();
  const context = draft ? draft.source : source;
  const tab = draft ? draft.tab : sourceTab;
  if (context) next.set('source', context);
  if (tab != null) next.set('tab', String(tab));
  if (id) next.set('id', id);
  next.set('draft', crypto.randomUUID());
  if (restoreKey) next.set('restore', restoreKey);
  allowExit = true;
  location.assign(location.pathname + '?' + next);
}

function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

async function refreshScripts() {
  const result = await bg('us:list');
  available = result.available;
  $('#us-banner').hidden = available;
  $('#scripts-empty').hidden = result.scripts.length > 0;
  const list = $('#script-list');
  list.replaceChildren();
  if (result.bundles?.errors.length) list.append(element('p', 'Folder scripts / registration: ' + result.bundles.errors.join(' | '), 'warning-text'));
  for (const script of result.scripts) {
    const row = element('div', undefined, 'script-row');
    const text = element('div', undefined, 'script-description');
    text.append(element('b', script.name + (script.version ? ' v' + script.version : '')), element('small', script.matches.join(', ') || 'No valid @match'));
    if (script.bundleId) text.append(element('small', 'Folder script (protected; disable instead of deleting)'));
    if (script.error || !script.access) text.append(element('small', script.error || 'Needs site access', 'warning-text'));
    const toggle = element('label', undefined, 'check');
    const input = element('input'); input.type = 'checkbox'; input.checked = script.enabled;
    toggle.append(input, element('span', 'Enabled'));
    input.onchange = async () => {
      input.disabled = true;
      try {
        const granted = !input.checked || await requestOrigins(script.origins);
        const updated = await bg('us:toggle', { id: script.id, enabled: input.checked });
        let changedElsewhere = false;
        if (script.id === scriptId) {
          const latest = await bg('us:get', { id: script.id });
          changedElsewhere = latest.code !== savedCode || latest.updatedAt !== updated.updatedAt;
          if (!changedElsewhere) revision = updated.updatedAt;
          savedEnabled = updated.enabled; $('#enabled').checked = updated.enabled; queueDraft();
        }
        status(changedElsewhere ? 'This script changed in another tab. Reopen it before saving your current draft.' : updated.error || (!granted ? 'Enabled, but site or dependency access was not granted.' : 'Script ' + (updated.enabled ? 'enabled' : 'disabled') + '. Reload the website.'), changedElsewhere || updated.error || !granted ? 'warning' : '');
      } catch (error) { input.checked = script.enabled; status(error.message, 'error'); }
      input.disabled = false;
    };
    const edit = element('button', 'Edit'); edit.onclick = () => navigate(script.id).catch((error) => status(error.message, 'error'));
    const remove = element('button', 'Delete');
    remove.disabled = !!script.bundleId;
    if (remove.disabled) remove.title = 'Folder scripts cannot be deleted here. Disable the script instead.';
    remove.onclick = async () => {
      if (remove.disabled) return;
      if (!confirm('Delete ' + script.name + ' and its stored script values?')) return;
      try { await bg('us:delete', { id: script.id }); status('Script deleted.'); await refreshScripts(); }
      catch (error) { status(error.message, 'error'); }
    };
    row.append(text, toggle, edit, remove);
    list.append(row);
  }
  const all = await chrome.storage.local.get(null);
  const drafts = $('#draft-list'); drafts.replaceChildren();
  for (const [key, draft] of Object.entries(all)) {
    if (!key.startsWith('usdraft:') || typeof draft?.code !== 'string') continue;
    const row = element('div', undefined, 'draft-row');
    const text = element('div', undefined, 'script-description');
    text.append(element('b', draft.name || 'Untitled draft'), element('small', new Date(draft.updatedAt).toLocaleString()));
    const restore = element('button', 'Open Draft'); restore.onclick = () => navigate(draft.scriptId, draft, key).catch((error) => status(error.message, 'error'));
    const discard = element('button', 'Discard'); discard.onclick = async () => {
      if (!confirm('Discard this local draft?')) return;
      await chrome.storage.local.remove(key);
      if (key === draftKey) {
        pendingDraft = null; pendingDraftKey = null; $('#draft-note').hidden = true;
        $('#enabled').checked = savedEnabled; replaceCode(savedCode, 'discard'); queueDraft();
      }
      await refreshScripts();
    };
    row.append(text, restore, discard); drafts.append(row);
  }
  if (!drafts.childElementCount) drafts.append(element('p', 'No local drafts.', 'muted'));
}

function applyPreferences() {
  const fontSize = Math.max(10, Math.min(26, Number($('#font-size').value) || 14));
  const indent = $('#indent').value;
  cm.getWrapperElement().style.fontSize = fontSize + 'px';
  cm.setOption('lineWrapping', $('#wrap').checked);
  cm.setOption('indentWithTabs', indent === 'tab');
  cm.setOption('indentUnit', indent === '4' ? 4 : 2);
  cm.setOption('tabSize', indent === '4' ? 4 : 2);
  cm.refresh();
  return { fontSize, indent, wrap: $('#wrap').checked };
}

async function paste() {
  try { replaceCode(await navigator.clipboard.readText()); status('Clipboard code pasted. Ctrl+Z undoes the replacement.'); }
  catch (error) { status('Clipboard access unavailable. Paste directly into the code editor.', 'error'); }
}

function wire() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = () => showView(button.dataset.view);
    button.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...document.querySelectorAll('[data-view]')];
      const next = buttons[(buttons.indexOf(button) + (event.key === 'ArrowRight' ? 1 : 3)) % buttons.length];
      showView(next.dataset.view); next.focus();
    };
  });
  document.querySelectorAll('[data-meta]').forEach((field) => field.addEventListener('input', () => changeMeta(field)));
  document.querySelectorAll('[data-pref]').forEach((field) => field.addEventListener('change', () => chrome.storage.local.set({ usEditor: applyPreferences() }).catch((error) => status(error.message, 'error'))));
  $('#enabled').onchange = queueDraft;
  $('#save').onclick = () => save();
  $('#save-close').onclick = () => save(true);
  $('#close').onclick = () => closeEditor().catch((error) => status(error.message, 'error'));
  $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(cm.getValue()); status('Complete userscript copied.', 'ok'); } catch (error) { status(error.message, 'error'); } };
  $('#paste').onclick = paste;
  $('#new-script').onclick = $('#manager-new').onclick = () => navigate(null).catch((error) => status(error.message, 'error'));
  $('#import-toggle').onclick = () => { $('#import-panel').hidden = !$('#import-panel').hidden; cm.refresh(); };
  $('#upload').onclick = () => $('#script-file').click();
  $('#script-file').onchange = async (event) => {
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > MAX_SCRIPT_BYTES) throw new Error('The script file exceeds the 6 MiB UTF-8 limit.');
      fallbackName = file.name.replace(/\.(user\.)?js$/i, '');
      const code = await file.text(); assertScriptSize(code);
      replaceCode(code); status('File imported. Save to install it.');
    } catch (error) { status(error.message, 'error'); }
    event.target.value = '';
  };
  $('#fetch-script').onclick = async () => {
    const button = $('#fetch-script'); button.disabled = true;
    try {
      const url = new URL($('#import-url').value.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error('Enter a full HTTP(S) userscript URL.');
      if (!(await requestOrigins([url.origin + '/*']))) throw new Error('Site access was not granted.');
      const { code } = await bg('us:fetch', { url: url.href });
      assertScriptSize(code);
      if (/^\s*</.test(code)) throw new Error('That URL returned HTML, not JavaScript. Use a raw .user.js link.');
      replaceCode(code); status('Script fetched. Review its code, then Save to install.');
    } catch (error) { status(error.message, 'error'); }
    button.disabled = false;
  };
  $('#export').onclick = async () => {
    const name = (parseMeta(cm.getValue()).name || fallbackName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 160) || 'script';
    const url = URL.createObjectURL(new Blob([cm.getValue()], { type: 'text/javascript;charset=utf-8' }));
    try { await chrome.downloads.download({ url, filename: name + '.user.js', saveAs: true }); status('Userscript export started.', 'ok'); }
    catch (error) { status(error.message, 'error'); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  };
  $('#export-bundle').onclick = async () => {
    if (!loaded || saving || exporting) return;
    const warning = (dirty ? 'Unsaved editor changes are NOT included. Save first to include them, or continue with the SAVED version.\n\n' : '') +
      'Export the extension and saved scripts? Drafts, script values and private settings are excluded. Review all saved script code for passwords, tokens and other secrets before sharing; embedded secrets cannot be removed automatically. Remote @require/@resource URLs may need network access and site permission on a fresh install.';
    if (!confirm(warning)) return;
    exporting = true; updateState();
    try {
      await persistDraft();
      status('Building the extension ZIP from saved scripts...');
      const result = await exportExtensionBundle();
      status('Export requested: ' + result.filename + ' (' + result.count + ' saved scripts). Review script code before sharing.', 'ok');
    } catch (error) { status(error.message, 'error'); }
    finally { exporting = false; updateState(); }
  };
  $('#scan-bundles').onclick = async () => {
    if (!loaded || saving || scanning) return;
    scanning = true; updateState();
    try {
      const result = await bg('us:scan-bundles');
      await refreshScripts();
      status('Folder scan: ' + result.imported + ' imported, ' + result.skipped + ' preserved.' +
        (result.errors.length ? ' ' + result.errors.join(' | ') : ''), result.errors.length ? 'warning' : 'ok');
    } catch (error) { status(error.message, 'error'); }
    finally { scanning = false; updateState(); }
  };
  $('#find').onclick = () => { showView('code'); cm.execCommand('findPersistent'); };
  $('#replace').onclick = () => { showView('code'); cm.execCommand('replace'); };
  $('#check').onclick = async () => { const error = await checkSyntax(cm.getValue()); status(error ? 'Syntax error: ' + error : 'Syntax valid. No code was executed.', error ? 'error' : 'ok'); };
  for (const [selector, page] of [['#match-site', false], ['#match-page', true]]) $(selector).onclick = () => {
    $('#meta-match').value = siteMatch(source, page); changeMeta($('#meta-match'));
  };
  $('#reload-source').onclick = async () => { try { await chrome.tabs.reload(sourceTab); status('Website reloaded.'); } catch (error) { status('The originating tab is no longer available.', 'error'); } };
  $('#extension-settings').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
  $('#recheck').onclick = () => refreshScripts().catch((error) => status(error.message, 'error'));
  $('#restore-draft').onclick = () => { if (pendingDraft) restoreDraft(pendingDraft); };
  $('#discard-draft').onclick = async () => { const key = pendingDraftKey || draftKey; pendingDraft = null; pendingDraftKey = null; $('#draft-note').hidden = true; await chrome.storage.local.remove(key); status('Local draft discarded.'); };
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(event.shiftKey); }
    if (event.key === 'F1') { event.preventDefault(); showView('help'); }
  });
  window.addEventListener('beforeunload', (event) => {
    persistDraft().catch(() => {});
    if (dirty && !allowExit) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistDraft().catch(() => {}); });
}

async function init() {
  if (!source && sourceTab != null) { try { source = cleanSource((await chrome.tabs.get(sourceTab)).url); } catch (error) { /* source tab closed */ } }
  if (!params.get('draft')) params.set('draft', crypto.randomUUID());
  const editorTab = await chrome.tabs.getCurrent();
  // A duplicated editor URL must not share draft ownership with its original tab.
  draftKey = 'usdraft:' + params.get('draft') + ':' + (editorTab?.id ?? crypto.randomUUID());
  const restoreKey = params.get('restore')?.startsWith('usdraft:') ? params.get('restore') : null;
  const [record, stored] = await Promise.all([
    scriptId ? bg('us:get', { id: scriptId }).catch((error) => { if (error.message === 'Script not found') return null; throw error; }) : Promise.resolve(null),
    chrome.storage.local.get(['usEditor', draftKey, ...(restoreKey ? [restoreKey] : [])]),
  ]);
  const draft = stored[restoreKey || draftKey];
  const orphan = scriptId && !record;
  if (orphan) {
    if (typeof draft?.code !== 'string') throw new Error('Script not found. Open Manage in tab to create a script or restore a local draft.');
    scriptId = null; params.delete('id');
  }
  params.delete('restore');
  history.replaceState(null, '', location.pathname + '?' + params);
  savedCode = record ? record.code : newScript(source);
  savedEnabled = record ? record.enabled : true;
  revision = record?.updatedAt;
  fallbackName = parseMeta(savedCode).name || fallbackName;
  $('#enabled').checked = savedEnabled;
  $('#code').value = savedCode;
  cm = window.CodeMirror.fromTextArea($('#code'), {
    mode: 'javascript', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true,
    screenReaderLabel: 'Userscript code',
    styleActiveLine: true, foldGutter: true, gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    indentUnit: 2, tabSize: 2, undoDepth: 500, highlightSelectionMatches: { showToken: /\w/ },
    hintOptions: { completeSingle: false, additionalContext: hintContext },
    extraKeys: {
      'Ctrl-S': () => save(), 'Cmd-S': () => save(), 'Ctrl-Shift-S': () => save(true), 'Cmd-Shift-S': () => save(true),
      'Ctrl-F': 'findPersistent', 'Cmd-F': 'findPersistent',
      'Ctrl-Space': 'autocomplete', 'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment', 'Alt-F': 'fold',
      'Ctrl-Enter': () => $('#check').click(), 'Cmd-Enter': () => $('#check').click(),
      Tab: (editor) => { if (editor.somethingSelected()) editor.indentSelection('add'); else editor.replaceSelection(editor.getOption('indentWithTabs') ? '\t' : ' '.repeat(editor.getOption('indentUnit')), 'end', '+input'); },
      'Shift-Tab': 'indentLess',
    },
  });
  const preferences = stored.usEditor || {};
  $('#wrap').checked = !!preferences.wrap;
  $('#font-size').value = preferences.fontSize || 14;
  $('#indent').value = preferences.indent || '2';
  applyPreferences();
  cm.on('changes', queueDraft);
  cm.on('cursorActivity', () => { const cursor = cm.getCursor(); $('#cursor').textContent = 'Line ' + (cursor.line + 1) + ', Col ' + (cursor.ch + 1); });
  $('#source-label').textContent = source ? new URL(source).hostname : 'No website context';
  $('#source-label').title = source;
  $('#source-notice').hidden = !!source;
  $('#reload-source').disabled = sourceTab == null;
  $('#match-site').disabled = $('#match-page').disabled = !source;
  wire();
  loaded = true;
  syncSettings(); updateState();
  if (typeof draft?.code === 'string' && (draft.code !== savedCode || draft.enabled !== savedEnabled)) {
    if (!scriptId || draft.baseUpdatedAt === revision) restoreDraft(draft);
    else {
      pendingDraft = draft;
      pendingDraftKey = restoreKey || draftKey;
      $('#draft-note').hidden = false;
      $('#draft-message').textContent = 'An older local draft exists, but this script has changed since it was written. Restore only if you want to replace the current code.';
    }
  } else status(scriptId ? 'Script loaded. Changes are saved for the next page load.' : 'New script ready. @match is filled from the originating website.');
  if (orphan) status('The original script was deleted. Its draft is open as a new script; Save installs a new copy.', 'warning');
  await refreshScripts();
  showView(params.get('view') === 'scripts' ? 'scripts' : 'code');
}

init().catch((error) => status(error.message, 'error'));
