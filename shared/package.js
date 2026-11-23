import { createZip, validateZipPath } from './zip.js';
import { assertScriptSize } from './usmeta.js';

// Browsers cannot enumerate an installed extension directory. Keep new runtime assets here.
export const EXTENSION_ASSETS = Object.freeze([
  'manifest.json', 'background.js', 'offscreen.html', 'offscreen.js',
  'content/main.js', 'content/content.js',
  'gm/gm-bg.js', 'gm/gm-runtime.js', 'gm/gm-relay.js',
  'shared/features.js', 'shared/hls.js', 'shared/names.js', 'shared/pdf.js', 'shared/tsaudio.js',
  'shared/usmeta.js', 'shared/utilities.js', 'shared/download.js', 'shared/updates.js', 'shared/zip.js', 'shared/package.js',
  'popup/theme.css', 'popup/popup.html', 'popup/popup.js', 'popup/popup.css', 'popup/editor.html', 'popup/editor.js', 'popup/editor.css',
  'sandbox/check.html', 'sandbox/check.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png', 'icons/logo.svg',
  'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs', 'lib/pdfjs-LICENSE.txt',
  'lib/codemirror.js', 'lib/codemirror.css', 'lib/codemirror.LICENSE',
  'plugins/plugins.json', 'plugins/PLUGIN_PROMPT.md', 'README.md',
]);

async function assetText(data, path) {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  throw new Error('Missing or invalid package asset: ' + path);
}

function scriptPath(file) {
  validateZipPath(file);
  if (!/\.user\.js$/i.test(file)) throw new Error('Bundle script files must end in .user.js: ' + file);
  return 'scripts/' + file;
}

/** Fetch fresh package assets and add only the saved-script snapshot, never browser storage. */
export async function buildExtensionBundle(snapshot, fetchAsset, manifest) {
  if (!Array.isArray(snapshot?.index) || !Array.isArray(snapshot?.files)) throw new Error('The saved script snapshot is invalid');
  const ids = new Set(), paths = new Set(), index = [];
  for (const entry of snapshot.index) {
    if (typeof entry?.id !== 'string' || !entry.id || entry.id.trim() !== entry.id || entry.id.length > 200 || /[\x00-\x1f\x7f]/.test(entry.id) || ids.has(entry.id)) throw new Error('Bundle IDs must be nonempty and unique');
    if (typeof entry.enabled !== 'boolean') throw new Error('Bundle enabled states must be booleans');
    const path = scriptPath(entry.file), key = path.toLowerCase();
    if (paths.has(key)) throw new Error('Duplicate bundle script path: ' + path);
    ids.add(entry.id); paths.add(key);
    index.push({ id: entry.id, file: entry.file, enabled: entry.enabled });
  }
  const files = new Map();
  for (const file of snapshot.files) {
    const path = validateZipPath(file?.path);
    if (!path.startsWith('scripts/') || !/\.user\.js$/i.test(path) || typeof file.text !== 'string') throw new Error('Invalid saved script source: ' + path);
    assertScriptSize(file.text);
    if (files.has(path.toLowerCase())) throw new Error('Duplicate saved script source: ' + path);
    files.set(path.toLowerCase(), { path, text: file.text });
  }
  if (files.size !== paths.size || [...paths].some((path) => !files.has(path))) throw new Error('A saved script source is missing or unreferenced; export aborted');
  for (const entry of index) if (files.get(scriptPath(entry.file).toLowerCase()).path !== scriptPath(entry.file)) throw new Error('Saved script path casing does not match its index');

  const assets = new Map();
  const get = async (path) => {
    validateZipPath(path);
    try {
      const data = await fetchAsset(path);
      if (!(typeof data === 'string' || data instanceof Uint8Array || data instanceof Blob)) throw new Error('No file bytes were returned');
      assets.set(path, data);
    } catch (e) { throw new Error('Missing package asset ' + path + ': ' + (e.message || String(e)) + '. Export aborted.'); }
  };
  await Promise.all(EXTENSION_ASSETS.map(get));
  let packagedManifest, plugins;
  try { packagedManifest = JSON.parse(await assetText(assets.get('manifest.json'), 'manifest.json')); }
  catch (e) { throw new Error('The packaged manifest is invalid: ' + e.message); }
  if (packagedManifest?.manifest_version !== 3 || typeof packagedManifest.version !== 'string') throw new Error('The packaged manifest is invalid');
  if (manifest && packagedManifest.version !== manifest.version) throw new Error('The extension version changed during export. Reload the extension and try again.');
  try { plugins = JSON.parse(await assetText(assets.get('plugins/plugins.json'), 'plugins/plugins.json')); }
  catch (e) { throw new Error('The folder-plugin index is invalid: ' + e.message); }
  if (!Array.isArray(plugins)) throw new Error('The folder-plugin index must be an array');
  const pluginIds = new Set(), extra = new Set(), knownPaths = new Map(EXTENSION_ASSETS.map((path) => [path.toLowerCase(), path]));
  for (const plugin of plugins) {
    if (typeof plugin?.id !== 'string' || !plugin.id || pluginIds.has(plugin.id) || (!plugin.file && !plugin.css)) throw new Error('Folder plugins need unique IDs and a file or CSS path');
    pluginIds.add(plugin.id);
    for (const [key, suffix] of [['file', /\.js$/i], ['css', /\.css$/i]]) {
      if (plugin[key] == null) continue;
      const path = validateZipPath(plugin[key]);
      if (!path.startsWith('plugins/') || !suffix.test(path)) throw new Error('Unsafe folder-plugin ' + key + ' path: ' + path);
      const prior = knownPaths.get(path.toLowerCase());
      if (prior && prior !== path) throw new Error('Folder-plugin paths differ only by case: ' + path);
      knownPaths.set(path.toLowerCase(), path);
      if (!assets.has(path)) extra.add(path);
    }
  }
  await Promise.all([...extra].map(get));
  const entries = [...assets].map(([path, data]) => ({ path: 'allen-toolbox/' + path, data }));
  entries.push({ path: 'allen-toolbox/scripts/scripts.json', data: JSON.stringify(index, null, 2) + '\n' });
  for (const { path, text } of files.values()) entries.push({ path: 'allen-toolbox/' + path, data: text });
  return createZip(entries);
}

export async function exportExtensionBundle() {
  const snapshot = await chrome.runtime.sendMessage({ type: 'us:bundle-export' });
  if (!snapshot || snapshot.error) throw new Error(snapshot?.error || 'The extension did not return its saved scripts');
  const manifest = chrome.runtime.getManifest();
  const blob = await buildExtensionBundle(snapshot, async (path) => {
    const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }, manifest);
  const version = manifest.version.replace(/[^a-z\d._-]/gi, '_');
  const filename = 'ALLEN-Toolbox-' + version + '.zip', url = URL.createObjectURL(blob);
  let downloadId = null, accepted = false, cleaned = false;
  const earlyTerminal = new Set();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    chrome.downloads.onChanged.removeListener(changed);
    URL.revokeObjectURL(url);
  };
  const changed = (delta) => {
    if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
    if (!accepted) earlyTerminal.add(delta.id);
    else if (delta.id === downloadId) cleanup();
  };
  try {
    // Listen before download(): tiny exports can finish before its promise returns an ID.
    chrome.downloads.onChanged.addListener(changed);
    downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
    if (!Number.isInteger(downloadId) || downloadId < 0) throw new Error('The browser did not accept the ZIP download');
    accepted = true;
    if (earlyTerminal.has(downloadId)) cleanup();
    earlyTerminal.clear();
    if (!cleaned) {
      try {
        const items = await chrome.downloads.search({ id: downloadId });
        if (items.some((item) => item.state === 'complete' || item.state === 'interrupted')) cleanup();
      } catch (e) { /* Keep the listener and URL alive until a terminal browser event. */ }
    }
    return { filename, count: snapshot.index.length };
  } catch (e) { cleanup(); throw e; }
}
