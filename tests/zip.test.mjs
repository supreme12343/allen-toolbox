import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createZip, crc32, validateZipPath } from '../shared/zip.js';
import { buildExtensionBundle, exportExtensionBundle, EXTENSION_ASSETS } from '../shared/package.js';
import { MAX_SCRIPT_BYTES } from '../shared/usmeta.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const manifest = { manifest_version: 3, version: '2.0.0', name: 'ALLEN Toolbox' };

function independentCRC(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// An independent reader verifies STORE headers, directory offsets, lengths and CRCs.
async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 4, true), 0);
  assert.equal(view.getUint16(end + 6, true), 0);
  assert.equal(view.getUint16(end + 20, true), 0);
  const count = view.getUint16(end + 10, true), centralStart = view.getUint32(end + 16, true), centralSize = view.getUint32(end + 12, true);
  assert.equal(view.getUint16(end + 8, true), count);
  assert.equal(centralStart + centralSize, end);
  const records = new Map();
  let offset = 0;
  while (offset < centralStart) {
    const localOffset = offset;
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    assert.equal(view.getUint16(offset + 4, true), 20);
    assert.equal(view.getUint16(offset + 6, true), 0x0800);
    assert.equal(view.getUint16(offset + 8, true), 0);
    const crc = view.getUint32(offset + 14, true), size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    assert.equal(size, view.getUint32(offset + 22, true));
    assert.equal(view.getUint16(offset + 28, true), 0);
    const path = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength;
    const data = bytes.subarray(offset, offset + size);
    assert.equal(independentCRC(data), crc);
    assert.equal(records.has(path), false);
    records.set(path, { data, crc, size, offset: localOffset });
    offset += size;
  }
  assert.equal(offset, centralStart);
  const directoryNames = [];
  while (offset < end) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint16(offset + 6, true), 20);
    assert.equal(view.getUint16(offset + 8, true), 0x0800);
    assert.equal(view.getUint16(offset + 10, true), 0);
    const nameLength = view.getUint16(offset + 28, true);
    assert.equal(view.getUint16(offset + 30, true), 0);
    assert.equal(view.getUint16(offset + 32, true), 0);
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const local = records.get(path);
    assert.ok(local);
    assert.equal(view.getUint32(offset + 16, true), local.crc);
    assert.equal(view.getUint32(offset + 20, true), local.size);
    assert.equal(view.getUint32(offset + 24, true), local.size);
    assert.equal(view.getUint32(offset + 42, true), local.offset);
    directoryNames.push(path);
    offset += 46 + nameLength;
  }
  assert.equal(offset, end);
  assert.equal(directoryNames.length, count);
  assert.equal(records.size, count);
  return records;
}

function assets(plugins = []) {
  const files = new Map(EXTENSION_ASSETS.map((path) => [path, encoder.encode('runtime asset: ' + path)]));
  files.set('manifest.json', JSON.stringify(manifest));
  files.set('plugins/plugins.json', JSON.stringify(plugins));
  files.set('README.md', 'Existing README stays in the package.');
  return files;
}
const snapshot = () => ({ index: [{ id: 'seed-v1', file: 'saved.user.js', enabled: false }], files: [{ path: 'scripts/saved.user.js', text: '// saved version\nvoid 0;\n' }] });
const fetchAssets = (files, fetched = []) => async (path) => {
  fetched.push(path);
  if (!files.has(path)) throw new Error('HTTP 404');
  return files.get(path);
};

test('CRC32 matches standard vectors', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(crc32(bytes), independentCRC(bytes));
});

test('ZIP contains standard UTF-8 STORE entries with correct CRCs and central offsets', async () => {
  const files = [
    { path: 'allen-toolbox/manifest.json', data: '{"manifest_version":3}' },
    { path: 'allen-toolbox/scripts/caf\u00e9.user.js', data: 'const word = "caf\u00e9";\n' },
    { path: 'allen-toolbox/icons/test.png', data: new Uint8Array([0, 1, 2, 254, 255]) },
    { path: 'allen-toolbox/blob.bin', data: new Blob([new Uint8Array([4, 5, 6])]) },
  ];
  const zip = await createZip(files);
  assert.equal(zip.type, 'application/zip');
  const records = await readZip(zip);
  assert.equal(records.size, 4);
  assert.equal(decoder.decode(records.get(files[1].path).data), files[1].data);
  assert.deepEqual(records.get(files[2].path).data, files[2].data);
  assert.deepEqual(records.get(files[3].path).data, new Uint8Array([4, 5, 6]));
  const repeated = await createZip(files);
  assert.deepEqual(new Uint8Array(await repeated.arrayBuffer()), new Uint8Array(await zip.arrayBuffer()));
});

test('an empty ZIP is a valid EOCD-only archive', async () => {
  const zip = await createZip([]);
  assert.equal(zip.size, 22);
  assert.equal((await readZip(zip)).size, 0);
});

test('ZIP refuses traversal, URL aliases, absolute paths, controls and Windows aliases', async () => {
  for (const path of ['../evil.js', '/evil.js', 'a/../evil.js', 'a/./evil.js', 'a//evil.js', 'C:/evil.js', 'a\\evil.js', '%2e%2e/evil.js',
    'a?query.js', 'a#fragment.js', 'a\0b.js', '', '.', 'a/b. ', 'a/b.', 'a:b.js']) {
    assert.throws(() => validateZipPath(path), /Unsafe relative file path/);
    await assert.rejects(createZip([{ path, data: 'x' }]), /Unsafe relative file path/);
  }
});

test('ZIP rejects duplicate paths, missing data, and explicit ZIP32 limits', async () => {
  await assert.rejects(createZip([{ path: 'x.js', data: 'a' }, { path: 'x.js', data: 'b' }]), /Duplicate ZIP path/);
  await assert.rejects(createZip([{ path: 'X.js', data: 'a' }, { path: 'x.js', data: 'b' }]), /Duplicate ZIP path/);
  await assert.rejects(createZip([{ path: 'x.js' }]), /must be text, Uint8Array, or Blob/);
  await assert.rejects(createZip(new Array(65535)), /fewer than 65535/);
  await assert.rejects(createZip([{ path: 'x'.repeat(65536), data: '' }]), /filename exceeds/);
  const tooLarge = new Blob();
  Object.defineProperty(tooLarge, 'size', { value: 0xffffffff });
  tooLarge.arrayBuffer = () => { throw new Error('Must check size before reading'); };
  await assert.rejects(createZip([{ path: 'huge.bin', data: tooLarge }]), /ZIP32 size limit/);
});

test('extension ZIP has a load-unpacked root, complete runtime inventory and only snapshot scripts', async () => {
  const saved = snapshot(), files = assets(), fetched = [];
  files.set('scripts/scripts.json', JSON.stringify([{ id: 'deleted-default', file: 'example.user.js', enabled: false }]));
  files.set('scripts/example.user.js', 'DELETED DEFAULT MUST NOT RESURRECT');
  saved.values = 'stored-value-secret'; saved.drafts = 'draft-secret'; saved.cfg = 'configuration-secret';
  saved.index[0].cache = 'cache-secret'; saved.files[0].channel = 'channel-secret';
  const records = await readZip(await buildExtensionBundle(saved, fetchAssets(files, fetched), manifest));
  assert.equal(records.size, EXTENSION_ASSETS.length + 2);
  assert.deepEqual(JSON.parse(decoder.decode(records.get('allen-toolbox/manifest.json').data)), manifest);
  assert.deepEqual(JSON.parse(decoder.decode(records.get('allen-toolbox/scripts/scripts.json').data)), [{ id: 'seed-v1', file: 'saved.user.js', enabled: false }]);
  assert.equal(decoder.decode(records.get('allen-toolbox/scripts/saved.user.js').data), saved.files[0].text);
  assert.equal(records.has('allen-toolbox/scripts/example.user.js'), false);
  assert.ok([...records.keys()].every((path) => path.startsWith('allen-toolbox/')));
  assert.deepEqual(new Set(fetched), new Set(EXTENSION_ASSETS));
  for (const path of ['shared/zip.js', 'shared/package.js', 'shared/utilities.js', 'shared/download.js', 'icons/logo.svg', 'icons/icon32.png',
    'lib/pdf.worker.min.mjs', 'lib/pdfjs-LICENSE.txt', 'lib/codemirror.LICENSE', 'plugins/PLUGIN_PROMPT.md', 'README.md', 'popup/editor.js']) {
    assert.ok(records.has('allen-toolbox/' + path), path);
  }
  const all = [...records.values()].map((rec) => decoder.decode(rec.data)).join('\n');
  assert.doesNotMatch(all, /stored-value-secret|draft-secret|configuration-secret|cache-secret|channel-secret|DELETED DEFAULT/);
});

test('empty saved snapshot replaces the default index with [] and emits no default sources', async () => {
  const records = await readZip(await buildExtensionBundle({ index: [], files: [] }, fetchAssets(assets()), manifest));
  assert.deepEqual(JSON.parse(decoder.decode(records.get('allen-toolbox/scripts/scripts.json').data)), []);
  assert.equal([...records.keys()].filter((path) => /\.user\.js$/i.test(path)).length, 0);
});

test('package export refuses sources above the same UTF-8 import limit before fetching assets', async () => {
  const saved = snapshot(), fetched = [];
  saved.files[0].text = '\u4e2d'.repeat(MAX_SCRIPT_BYTES / 3 + 1);
  await assert.rejects(buildExtensionBundle(saved, fetchAssets(assets(), fetched), manifest), /6 MiB UTF-8/);
  assert.deepEqual(fetched, []);
});

test('the real package assets build a valid ZIP and the inventory covers every runtime directory', async () => {
  const actualManifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  async function inventory(directory) {
    const paths = [];
    for (const item of await readdir(new URL('../' + directory + '/', import.meta.url), { withFileTypes: true })) {
      const path = directory + '/' + item.name;
      if (item.isDirectory()) paths.push(...await inventory(path));
      else paths.push(path);
    }
    return paths;
  }
  for (const directory of ['content', 'gm', 'icons', 'lib', 'popup', 'sandbox', 'shared']) {
    for (const path of await inventory(directory)) assert.ok(EXTENSION_ASSETS.includes(path), 'Missing runtime inventory entry: ' + path);
  }
  const fetched = [];
  const zip = await buildExtensionBundle(snapshot(), async (path) => {
    fetched.push(path);
    return readFile(new URL('../' + path, import.meta.url));
  }, actualManifest);
  const records = await readZip(zip);
  assert.deepEqual(JSON.parse(decoder.decode(records.get('allen-toolbox/manifest.json').data)), actualManifest);
  assert.ok(fetched.every((path) => !path.startsWith('scripts/')));
  for (const path of EXTENSION_ASSETS) assert.ok(records.has('allen-toolbox/' + path));
  for (const path of ['manifest.json', 'popup/popup.html', 'popup/editor.html', 'README.md']) {
    assert.match(decoder.decode(records.get('allen-toolbox/' + path).data), /Supreme/, 'Missing exported credits: ' + path);
  }
  const referenced = [actualManifest.background.service_worker, actualManifest.action.default_popup,
    ...Object.values(actualManifest.icons), ...actualManifest.sandbox.pages,
    ...actualManifest.content_scripts.flatMap((script) => [...(script.js || []), ...(script.css || [])])];
  for (const path of referenced) assert.ok(records.has('allen-toolbox/' + path), 'Missing manifest asset: ' + path);
});

test('every missing required runtime resource aborts export rather than producing a broken package', async () => {
  for (const path of ['icons/icon32.png', 'gm/gm-runtime.js', 'lib/pdf.worker.min.mjs', 'shared/download.js', 'README.md']) {
    const files = assets(); files.delete(path);
    await assert.rejects(buildExtensionBundle(snapshot(), fetchAssets(files), manifest), (error) => error.message.includes(path) && error.message.includes('Export aborted'));
  }
});

test('referenced folder-plugin JS and CSS are safely included even when disabled', async () => {
  const files = assets([{ id: 'plugin', file: 'plugins/nested/plugin.js', css: 'plugins/plugin.css', enabled: false },
    { id: 'shared-css', css: 'plugins/plugin.css' }]);
  files.set('plugins/nested/plugin.js', 'void 0;'); files.set('plugins/plugin.css', 'body { color: black; }');
  const fetched = [], records = await readZip(await buildExtensionBundle(snapshot(), fetchAssets(files, fetched), manifest));
  assert.equal(decoder.decode(records.get('allen-toolbox/plugins/nested/plugin.js').data), 'void 0;');
  assert.equal(fetched.filter((path) => path === 'plugins/plugin.css').length, 1);
  files.delete('plugins/nested/plugin.js');
  await assert.rejects(buildExtensionBundle(snapshot(), fetchAssets(files), manifest), /Missing package asset plugins\/nested\/plugin\.js/);
});

test('malformed or unsafe folder-plugin references abort without fetching those paths', async () => {
  for (const path of ['../evil.js', 'https://example.com/a.js', '/plugins/a.js', 'plugins/../evil.js', 'plugins/%2e%2e/evil.js', 'background.js']) {
    const fetched = [], files = assets([{ id: 'bad', file: path }]);
    await assert.rejects(buildExtensionBundle(snapshot(), fetchAssets(files, fetched), manifest), /Unsafe/);
    assert.equal(fetched.filter((file) => file === path).length, path === 'background.js' ? 1 : 0);
  }
  await assert.rejects(buildExtensionBundle(snapshot(), fetchAssets(assets([{ id: 'x', file: 'plugins/x.js' }, { id: 'x', css: 'plugins/x.css' }])), manifest), /unique IDs/);
  const files = assets(); files.set('plugins/plugins.json', '{bad');
  await assert.rejects(buildExtensionBundle(snapshot(), fetchAssets(files), manifest), /folder-plugin index is invalid/);
});

test('snapshot source mismatches, duplicate IDs, unsafe paths and changed versions are refused', async () => {
  await assert.rejects(buildExtensionBundle({ index: snapshot().index, files: [] }, fetchAssets(assets()), manifest), /missing or unreferenced/);
  const duplicate = snapshot(); duplicate.index.push({ ...duplicate.index[0], file: 'other.user.js' });
  await assert.rejects(buildExtensionBundle(duplicate, fetchAssets(assets()), manifest), /unique/);
  const unsafe = snapshot(); unsafe.index[0].file = '../escape.user.js';
  await assert.rejects(buildExtensionBundle(unsafe, fetchAssets(assets()), manifest), /Unsafe/);
  const extra = snapshot(); extra.files.push({ path: 'scripts/extra.user.js', text: 'void 0;' });
  await assert.rejects(buildExtensionBundle(extra, fetchAssets(assets()), manifest), /missing or unreferenced/);
  const casing = snapshot(); casing.files[0].path = 'scripts/SAVED.user.js';
  await assert.rejects(buildExtensionBundle(casing, fetchAssets(assets()), manifest), /casing/);
  await assert.rejects(buildExtensionBundle(snapshot(), fetchAssets(assets()), { ...manifest, version: '3.0.0' }), /version changed/);
});

function browser(t, { download, search = async () => [{ state: 'in_progress' }], files = assets(), response = snapshot() } = {}) {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const listeners = new Set(), removed = [], revoked = [], requested = [], messages = [], blobs = [];
  const env = { listeners, removed, revoked, requested, messages, blobs,
    emit(delta) { for (const listener of [...listeners]) listener(delta); } };
  globalThis.chrome = {
    runtime: { async sendMessage(message) { messages.push(message); return response; }, getManifest: () => manifest, getURL: (path) => 'chrome-extension://zip-test/' + path },
    downloads: {
      onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { removed.push(fn); listeners.delete(fn); } },
      async download(options) { requested.push(options); return download ? download(options, env) : 42; }, search,
    },
  };
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith('chrome-extension://zip-test/'));
    const path = String(url).slice('chrome-extension://zip-test/'.length);
    return files.has(path) ? new Response(files.get(path)) : new Response('Missing', { status: 404 });
  };
  URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:zip-test/' + blobs.length; };
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => { globalThis.chrome = original.chrome; globalThis.fetch = original.fetch; URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke; });
  return env;
}

test('export API requests saved snapshot and retains its URL/listener until the matching terminal event', async (t) => {
  const env = browser(t);
  const result = await exportExtensionBundle();
  assert.deepEqual(env.messages, [{ type: 'us:bundle-export' }]);
  assert.deepEqual(result, { filename: 'ALLEN-Toolbox-2.0.0.zip', count: 1 });
  assert.deepEqual(env.requested, [{ url: 'blob:zip-test/1', filename: result.filename, saveAs: true }]);
  assert.equal(env.listeners.size, 1);
  assert.deepEqual(env.revoked, []);
  env.emit({ id: 99, state: { current: 'complete' } });
  env.emit({ id: 42, state: { current: 'in_progress' } });
  assert.deepEqual(env.revoked, []);
  env.emit({ id: 42, state: { current: 'complete' } });
  assert.deepEqual(env.revoked, ['blob:zip-test/1']);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.removed.length, 1);
  env.emit({ id: 42, state: { current: 'interrupted' } });
  assert.equal(env.revoked.length, 1);
});

test('download completion before acceptance is handled without an object-URL race', async (t) => {
  let accept, started;
  const began = new Promise((resolve) => { started = resolve; });
  const env = browser(t, { download: (_options, current) => {
    assert.equal(current.listeners.size, 1);
    started();
    return new Promise((resolve) => { accept = resolve; });
  } });
  const exporting = exportExtensionBundle();
  await began;
  env.emit({ id: 42, state: { current: 'complete' } });
  assert.deepEqual(env.revoked, []);
  accept(42);
  assert.equal((await exporting).count, 1);
  assert.deepEqual(env.revoked, ['blob:zip-test/1']);
  assert.equal(env.listeners.size, 0);
});

test('download interruption and a terminal search result clean up the URL and listener', async (t) => {
  const env = browser(t, { search: async () => [{ id: 42, state: 'interrupted' }] });
  await exportExtensionBundle();
  assert.deepEqual(env.revoked, ['blob:zip-test/1']);
  assert.equal(env.listeners.size, 0);
});

test('an event racing an awaited downloads.search cleans up exactly once', async (t) => {
  let finishSearch, searched;
  const searching = new Promise((resolve) => { searched = resolve; });
  const env = browser(t, { search: () => { searched(); return new Promise((resolve) => { finishSearch = resolve; }); } });
  const exporting = exportExtensionBundle();
  await searching;
  env.emit({ id: 42, state: { current: 'interrupted' } });
  finishSearch([{ id: 42, state: 'interrupted' }]);
  await exporting;
  assert.equal(env.revoked.length, 1);
  assert.equal(env.removed.length, 1);
});

test('search failure does not revoke an active download URL', async (t) => {
  const env = browser(t, { search: async () => { throw new Error('Search unavailable'); } });
  await exportExtensionBundle();
  assert.deepEqual(env.revoked, []);
  env.emit({ id: 42, state: { current: 'interrupted' } });
  assert.equal(env.revoked.length, 1);
  assert.equal(env.listeners.size, 0);
});

test('rejected download cleans up, and missing package resources refuse to start a download', async (t) => {
  const env = browser(t, { download: async () => { throw new Error('Download cancelled'); } });
  await assert.rejects(exportExtensionBundle(), /Download cancelled/);
  assert.deepEqual(env.revoked, ['blob:zip-test/1']);
  assert.equal(env.listeners.size, 0);
  const files = assets(); files.delete('icons/icon32.png');
  globalThis.fetch = async (url) => {
    const path = String(url).slice('chrome-extension://zip-test/'.length);
    return files.has(path) ? new Response(files.get(path)) : new Response('Missing', { status: 404 });
  };
  await assert.rejects(exportExtensionBundle(), /Missing package asset icons\/icon32\.png/);
  assert.equal(env.requested.length, 1);
  assert.equal(env.blobs.length, 1);
});

test('background snapshot errors are surfaced without fetching assets or downloading', async (t) => {
  const env = browser(t, { response: { error: 'Storage unavailable' } });
  await assert.rejects(exportExtensionBundle(), /Storage unavailable/);
  assert.equal(env.blobs.length, 0);
  assert.equal(env.requested.length, 0);
});
