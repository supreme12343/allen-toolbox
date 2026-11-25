import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { parseUpdatePackage, validateUpdatePath, UPDATE_REPOSITORY, MAX_UPDATE_ZIP_BYTES,
  MAX_UPDATE_EXPANDED_BYTES, MAX_UPDATE_FILES, RECOVERY_BOOTSTRAP } from '../shared/update-package.js';
import { EXTENSION_ASSETS } from '../shared/package.js';

const encode = (value) => typeof value === 'string' ? new TextEncoder().encode(value) : value;
const assets = ['manifest.json', 'background.js', 'shared/helper.js', 'plugins/plugins.json', 'popup/page.html'];
const selected = { version: '2.3.1', prerelease: true, assets };

function checksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Independent fixture writer intentionally permits malformed paths and metadata.
function zip(records) {
  const local = [], central = []; let offset = 0, centralSize = 0;
  for (const record of records) {
    const name = encode(record.path), localName = encode(record.localName || record.path), data = encode(record.data ?? ''),
      method = record.method ?? 0, flags = record.flags ?? (0x0800 | (record.descriptor ? 8 : 0)), crc = record.crc ?? checksum(data),
      packed = method === 8 ? new Uint8Array(deflateRawSync(data)) : data, size = record.size ?? data.byteLength,
      extra = record.extra || new Uint8Array(), localExtra = record.localExtra || new Uint8Array();
    const header = new Uint8Array(30 + localName.length + localExtra.length), l = new DataView(header.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, record.needed ?? 20, true); l.setUint16(6, flags, true);
    l.setUint16(8, record.localMethod ?? method, true);
    if (!(flags & 8)) { l.setUint32(14, crc, true); l.setUint32(18, packed.length, true); l.setUint32(22, size, true); }
    l.setUint16(26, localName.length, true); l.setUint16(28, localExtra.length, true); header.set(localName, 30); header.set(localExtra, 30 + localName.length);
    let descriptor = new Uint8Array();
    if (flags & 8) {
      descriptor = new Uint8Array(record.descriptor === 'unsigned' ? 12 : 16); const d = new DataView(descriptor.buffer), base = descriptor.length === 16 ? 4 : 0;
      if (base) d.setUint32(0, 0x08074b50, true);
      d.setUint32(base, crc, true); d.setUint32(base + 4, packed.length, true); d.setUint32(base + 8, size, true);
    }
    local.push(header, packed, descriptor);
    const entry = new Uint8Array(46 + name.length + extra.length), c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x0314, true); c.setUint16(6, record.needed ?? 20, true);
    c.setUint16(8, flags, true); c.setUint16(10, method, true); c.setUint32(16, crc, true); c.setUint32(20, packed.length, true);
    c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint16(30, extra.length, true);
    c.setUint32(38, record.attributes ?? (record.path.endsWith('/') ? 0x41ed0010 : 0x81a40000), true); c.setUint32(42, offset, true);
    entry.set(name, 46); entry.set(extra, 46 + name.length); central.push(entry); centralSize += entry.length;
    offset += header.length + packed.length + descriptor.length;
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, records.length, true); e.setUint16(10, records.length, true);
  e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  const parts = [...local, ...central, end], bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let position = 0;
  for (const part of parts) { bytes.set(part, position); position += part.length; }
  return bytes;
}

function files() {
  return new Map([
    ['manifest.json', JSON.stringify({ manifest_version: 3, name: 'ALLEN Toolbox', version: '2.3.1', version_name: '2.3.1 BETA', homepage_url: UPDATE_REPOSITORY,
      background: { service_worker: 'background.js', type: 'module' }, action: { default_popup: 'popup/page.html' } })],
    ['background.js', 'import "./shared/helper.js";\n'], ['shared/helper.js', 'export const helper = 1;\n'],
    ['plugins/plugins.json', '[]'], ['popup/page.html', '<script src="./page.js"></script>'], ['popup/page.js', 'void 0;\n'],
    ['scripts/scripts.json', JSON.stringify([{ id: 'seed', file: 'caf\u00e9.user.js', enabled: false }])],
    ['scripts/caf\u00e9.user.js', '// inert bundled user-script data\n'], ['shared/update-public-key.json', '{}'],
    ...RECOVERY_BOOTSTRAP.map((path) => [path, '// frozen recovery fixture\n']),
  ]);
}
const records = (map = files()) => [...map].map(([path, data]) => ({ path: 'allen-toolbox/' + path, data }));
const parse = (bytes, options = {}) => parseUpdatePackage(bytes, { ...selected, ...options });
const refused = (code) => (error) => { assert.equal(error.code, code); return true; };

test('STORE package has a complete keyless manifest, imports, script index and frozen rescue files', async () => {
  const candidate = await parse(zip(records()));
  assert.equal(candidate.version, '2.3.1'); assert.equal(candidate.prerelease, true);
  assert.equal(candidate.manifest.name, 'ALLEN Toolbox');
  assert.deepEqual([...candidate.files.keys()], [...files().keys()]);
  assert.equal(new TextDecoder().decode(candidate.files.get('scripts/caf\u00e9.user.js')), files().get('scripts/caf\u00e9.user.js'));
});

test('DEFLATE supports bounded DecompressionStream and independently checks the resulting CRC', async () => {
  const packed = records().map((entry, index) => ({ ...entry, method: index % 2 ? 8 : 0 }));
  const candidate = await parse(zip(packed));
  assert.equal(new TextDecoder().decode(candidate.files.get('background.js')), files().get('background.js'));
  const corrupt = packed.map((entry) => entry.path.endsWith('helper.js') ? { ...entry, crc: 123 } : entry);
  await assert.rejects(parse(zip(corrupt)), refused('PACKAGE_CRC'));
});

test('DEFLATE injection is bounded and browsers without raw DEFLATE fail closed', async () => {
  const packed = records().map((entry) => ({ ...entry, method: 8 })); let expanded = 0;
  await parse(zip(packed), { inflateRaw: async (data, size) => { const output = new Uint8Array(inflateRawSync(data)); assert.equal(output.length, size); expanded++; return output; } });
  assert.equal(expanded, packed.length);
  await assert.rejects(parse(zip(packed), { DecompressionStream: class { constructor() { throw new TypeError('unsupported'); } } }), refused('DEFLATE_UNAVAILABLE'));
  await assert.rejects(parse(zip(packed), { inflateRaw: async () => new Uint8Array() }), refused('PACKAGE_CRC'));
});

test('signed and unsigned ZIP32 data descriptors are checked against both local and central records', async () => {
  for (const descriptor of [true, 'unsigned']) await parse(zip(records().map((entry) => ({ ...entry, method: 8, descriptor }))));
  const bytes = zip(records().map((entry) => ({ ...entry, descriptor: true }))), view = new DataView(bytes.buffer);
  const firstName = view.getUint16(26, true), firstSize = encode(records()[0].data).length, descriptor = 30 + firstName + firstSize;
  view.setUint32(descriptor + 4, 123, true);
  await assert.rejects(parse(bytes), refused('PACKAGE_ZIP'));
  const magicCrc = records().map((entry, index) => index ? entry : { ...entry, descriptor: 'unsigned', crc: 0x08074b50 });
  await assert.rejects(parse(zip(magicCrc)), refused('PACKAGE_CRC'));
});

test('known public-key and availability extras are validated but never included in application writes', async () => {
  const candidate = await parse(zip([{ path: 'allen-toolbox/', data: '' }, ...records(), { path: 'updater/', data: '' },
    { path: 'updater/public-key.json', data: '{}' }, { path: 'updater/availability.json', data: '{"available":false}' }]));
  assert.ok([...candidate.files.keys()].every((path) => !path.startsWith('updater/') && !path.startsWith('allen-toolbox/')));
  assert.equal(candidate.files.size, files().size);
});

test('traversal, absolute paths, Windows reserved names, Unicode aliases and hidden git paths are refused', async () => {
  const unsafe = ['../evil.js', '/evil.js', 'C:/evil.js', 'allen-toolbox/../evil.js', 'allen-toolbox/a/./evil.js', 'allen-toolbox/a//evil.js',
    'allen-toolbox/a\\evil.js', 'allen-toolbox/%2e%2e/evil.js', 'allen-toolbox/shared/NUL.js', 'allen-toolbox/shared/COM1.txt',
    'allen-toolbox/shared/LPT\u00b2.js', 'allen-toolbox/shared/CONOUT$.js', 'allen-toolbox/shared/a.', 'allen-toolbox/shared/a ',
    'allen-toolbox/.git/config', 'allen-toolbox/shared/cafe\u0301.js', 'allen-toolbox/shared/a:stream.js', 'allen-toolbox/shared/a?b.js', 'allen-toolbox/shared/' + 'a'.repeat(256)];
  for (const path of unsafe) {
    assert.throws(() => validateUpdatePath(path), refused('PACKAGE_PATH'));
    await assert.rejects(parse(zip([...records(), { path, data: 'x' }])), refused('PACKAGE_PATH'));
  }
});

test('unknown roots, undeclared runtime files and all native/executable payloads are forbidden', async () => {
  for (const path of ['README.md', 'Install-ALLEN-Toolbox.cmd', 'updater/install.ps1', 'updater/native-host.cs', 'updater/ALLEN-Toolbox-NativeHost.exe',
    'allen-toolbox/tests/fixture.js', 'allen-toolbox/tools/build.js', 'allen-toolbox/shared/undeclared.js', 'allen-toolbox/shared/payload.exe', 'allen-toolbox/shared/runner.ps1']) {
    await assert.rejects(parse(zip([...records(), { path, data: 'not executable fixture data' }])), refused('PACKAGE_PATH'));
  }
});

test('case aliases in files or directory ancestors, duplicates and file/directory collisions are rejected', async () => {
  for (const extras of [
    [{ path: 'allen-toolbox/background.js', data: 'duplicate' }],
    [{ path: 'allen-toolbox/BACKGROUND.js', data: 'alias' }],
    [{ path: 'allen-toolbox/Shared/new.js', data: 'ancestor alias' }],
    [{ path: 'allen-toolbox/shared', data: 'file at directory path' }],
    [{ path: 'allen-toolbox/shared/helper.js/', data: '' }],
  ]) await assert.rejects(parse(zip([...records(), ...extras])), refused('PACKAGE_PATH'));
});

test('symlinks, special files and inconsistent directory attributes fail before extraction', async () => {
  for (const attributes of [0xa1ff0000, 0x21ff0000, 0x81a40010, 0x81a40400]) {
    await assert.rejects(parse(zip(records().map((entry, index) => index ? entry : { ...entry, attributes }))), refused('PACKAGE_ZIP'));
  }
  await assert.rejects(parse(zip([{ path: 'allen-toolbox/shared/', data: 'directory payload' }, ...records()])), refused('PACKAGE_ZIP'));
  await assert.rejects(parse(zip([{ path: 'allen-toolbox/shared/', attributes: 0x81a40010 }, ...records()])), refused('PACKAGE_ZIP'));
});

test('encryption, unsupported compression and ZIP64 extra/size/count markers are rejected', async () => {
  for (const patch of [{ flags: 0x0801 }, { flags: 0x0840 }, { flags: 0x2800 }, { method: 12 }, { needed: 45 },
    { size: 0xffffffff }, { extra: new Uint8Array([1, 0, 0, 0]) }, { localExtra: new Uint8Array([1, 0, 0, 0]) },
    { extra: new Uint8Array([0x75, 0x70, 0, 0]) }, { extra: new Uint8Array([0x01, 0x02, 0x03]) }]) {
    await assert.rejects(parse(zip(records().map((entry, index) => index ? entry : { ...entry, ...patch }))), refused('PACKAGE_ZIP'));
  }
  for (const offset of [8, 10]) {
    const bytes = zip(records()), view = new DataView(bytes.buffer); view.setUint16(bytes.length - 22 + offset, 0xffff, true);
    await assert.rejects(parse(bytes), refused('PACKAGE_ZIP'));
  }
});

test('local names, methods, sizes and CRC must agree with the central directory', async () => {
  for (const patch of [{ localName: 'allen-toolbox/xxxxxxxx.json' }, { localMethod: 8 }, { size: 1 }]) {
    await assert.rejects(parse(zip(records().map((entry, index) => index ? entry : { ...entry, ...patch }))), refused('PACKAGE_ZIP'));
  }
  for (const offset of [14, 18, 22]) {
    const bytes = zip(records()), view = new DataView(bytes.buffer); view.setUint32(offset, 123, true);
    await assert.rejects(parse(bytes), refused('PACKAGE_ZIP'));
  }
  const corrupt = records().map((entry, index) => index ? entry : { ...entry, crc: 123 });
  await assert.rejects(parse(zip(corrupt)), refused('PACKAGE_CRC'));
});

test('overlap, trailing data, split disks and unreferenced leading local data are forbidden', async () => {
  const good = zip(records());
  for (const mutate of [
    (view, length) => view.setUint16(length - 18, 1, true),
    (view, length) => view.setUint32(length - 10, 1, true),
    (view, length) => { const start = view.getUint32(length - 6, true), next = start + 46 + view.getUint16(start + 28, true); view.setUint32(next + 42, 0, true); },
  ]) {
    const bytes = new Uint8Array(good), view = new DataView(bytes.buffer); mutate(view, bytes.length);
    await assert.rejects(parse(bytes), refused('PACKAGE_ZIP'));
  }
  const trailing = new Uint8Array(good.length + 1); trailing.set(good);
  await assert.rejects(parse(trailing), refused('PACKAGE_ZIP'));
  const leading = new Uint8Array(good.length + 1); leading.set(good, 1); const view = new DataView(leading.buffer);
  const start = view.getUint32(leading.length - 6, true) + 1; view.setUint32(leading.length - 6, start, true);
  for (let cursor = start; cursor < leading.length - 22; cursor += 46 + view.getUint16(cursor + 28, true)) view.setUint32(cursor + 42, view.getUint32(cursor + 42, true) + 1, true);
  await assert.rejects(parse(leading), refused('PACKAGE_ZIP'));
});

test('ZIP, expanded-byte and 300-entry limits preflight without inflating a bomb', async () => {
  await assert.rejects(parse(new Uint8Array(MAX_UPDATE_ZIP_BYTES + 1)), refused('PACKAGE_LIMIT'));
  let inflations = 0;
  const bomb = records().map((entry, index) => index ? entry : { ...entry, method: 8, size: MAX_UPDATE_EXPANDED_BYTES + 1 });
  await assert.rejects(parse(zip(bomb), { inflateRaw: async () => { inflations++; throw new Error('must not inflate'); } }), refused('PACKAGE_LIMIT'));
  assert.equal(inflations, 0);
  await assert.rejects(parse(zip(Array.from({ length: MAX_UPDATE_FILES + 1 }, (_, index) => ({ path: 'allen-toolbox/shared/a' + index + '.js', data: '' })))), refused('PACKAGE_ZIP'));
});

test('manifest version, extension identity, homepage and keyless requirement are enforced', async () => {
  for (const patch of [{ version: '2.3.2' }, { name: 'Another Extension' }, { homepage_url: 'https://github.com/other/repo' }, { key: '' }, { manifest_version: 2 }]) {
    const map = files(); map.set('manifest.json', JSON.stringify({ ...JSON.parse(map.get('manifest.json')), ...patch }));
    await assert.rejects(parse(zip(records(map))), refused('PACKAGE_MANIFEST'));
  }
  await assert.rejects(parse(zip(records()), { version: '2.03.1' }), refused('PACKAGE_INVALID'));
  const map = files(); map.set('manifest.json', '{invalid');
  await assert.rejects(parse(zip(records(map))), refused('PACKAGE_INVALID'));
});

test('every expected manifest asset, static import, HTML dependency and indexed script is required', async () => {
  for (const path of files().keys()) {
    const map = files(); map.delete(path);
    await assert.rejects(parse(zip(records(map))), (error) => ['PACKAGE_INCOMPLETE', 'PACKAGE_INVALID'].includes(error.code));
  }
  const map = files(); map.set('background.js', 'export { x } from "./shared/missing.js";\n');
  await assert.rejects(parse(zip(records(map))), refused('PACKAGE_INCOMPLETE'));
  map.set('background.js', 'const code = import("./shared/missing.js");\n');
  await assert.rejects(parse(zip(records(map))), refused('PACKAGE_INCOMPLETE'));
  map.set('background.js', 'const worker = new URL("./shared/missing.js", import.meta.url);\n');
  await assert.rejects(parse(zip(records(map))), refused('PACKAGE_INCOMPLETE'));
});

test('runtime remote imports, escaping relative dependencies, invalid UTF-8 and malformed indexes are rejected', async () => {
  for (const source of ['import "https://example.com/remote.js";\n', 'import "../escape.js";\n', 'import "node:fs";\n', 'import("https://example.com/remote.js");\n']) {
    const map = files(); map.set('background.js', source);
    await assert.rejects(parse(zip(records(map))), refused('PACKAGE_PATH'));
  }
  const map = files(); map.set('background.js', new Uint8Array([255]));
  await assert.rejects(parse(zip(records(map))), refused('PACKAGE_INVALID'));
  for (const index of [{}, [{ id: 'same', file: 'a.user.js', enabled: true }, { id: 'same', file: 'b.user.js', enabled: false }], [{ id: 'x', file: '../evil.user.js', enabled: true }]]) {
    const invalid = files(); invalid.set('scripts/scripts.json', JSON.stringify(index));
    await assert.rejects(parse(zip(records(invalid))), (error) => ['PACKAGE_INVALID', 'PACKAGE_PATH'].includes(error.code));
  }
});

test('declared plugins and CSS dependencies are required without writing undeclared files', async () => {
  const map = files(); map.set('plugins/plugins.json', '[{"id":"test","file":"plugins/test.js","css":"plugins/test.css"}]');
  map.set('plugins/test.js', 'void 0;\n'); map.set('plugins/test.css', 'body { background: url("./test.png"); }'); map.set('plugins/test.png', new Uint8Array([1, 2, 3]));
  const candidate = await parse(zip(records(map))); assert.ok(candidate.files.has('plugins/test.png'));
  map.delete('plugins/test.png'); await assert.rejects(parse(zip(records(map))), refused('PACKAGE_INCOMPLETE'));
});

test('comments, strings, regexes and template text are not executable imports, but template expressions and commented imports are', async () => {
  const map = files();
  map.set('background.js', [
    '// import("https://example.com/ignored.js");',
    'const string = "import(\'https://example.com/ignored.js\')";',
    'const template = `await import("${worker}")`;',
    'const pattern = /import("ignored")/;',
    'import /* ignored comment */ "./shared/helper.js";',
  ].join('\n'));
  await parse(zip(records(map)));
  for (const source of ['import( /* comment */ "./shared/missing.js");', 'const text = `${import("./shared/missing.js")}`;',
    'export { x } from /* comment */ "./shared/missing.js";', 'const worker = new URL(/* comment */ "./shared/missing.js", import.meta.url);',
    'function helper(){}import "./shared/missing.js";']) {
    map.set('background.js', source); await assert.rejects(parse(zip(records(map))), refused('PACKAGE_INCOMPLETE'));
  }
  map.set('background.js', 'object.import("ignored"); const value = $import("ignored");'); await parse(zip(records(map)));
  map.set('background.js', 'import "data:text/javascript,void 0";'); await assert.rejects(parse(zip(records(map))), refused('PACKAGE_PATH'));
});

test('BETA manifests and stable release identities cannot be mismatched', async () => {
  await assert.rejects(parse(zip(records()), { prerelease: false }), refused('PACKAGE_MANIFEST'));
  const map = files(); const manifest = JSON.parse(map.get('manifest.json')); delete manifest.version_name; map.set('manifest.json', JSON.stringify(manifest));
  await assert.rejects(parse(zip(records(map))), refused('PACKAGE_MANIFEST'));
  await parse(zip(records(map)), { prerelease: false });
});

test('the actual checked-in runtime inventory parses without interpreting or executing its sources', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const map = new Map();
  for (const path of [...new Set([...EXTENSION_ASSETS, 'shared/update-public-key.json', ...RECOVERY_BOOTSTRAP, 'scripts/scripts.json'])]) map.set(path, new Uint8Array(await readFile(new URL('../' + path, import.meta.url))));
  for (const entry of JSON.parse(new TextDecoder().decode(map.get('scripts/scripts.json')))) map.set('scripts/' + entry.file, new Uint8Array(await readFile(new URL('../scripts/' + entry.file, import.meta.url))));
  const candidate = await parseUpdatePackage(zip(records(map)), { version: manifest.version, prerelease: /\bBETA\b/i.test(manifest.version_name || '') });
  assert.equal(candidate.files.size, map.size); assert.equal(candidate.manifest.version, manifest.version);
});
