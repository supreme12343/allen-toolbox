import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildRelease, WINDOWS_UPDATER_ASSETS } from '../tools/release.mjs';
import { EXTENSION_ASSETS } from '../shared/package.js';
import { parseUpdatePackage } from '../shared/update-package.js';
import { OFFICIAL_REPOSITORY } from '../shared/updates.js';

const decode = (data) => new TextDecoder().decode(data);
function fixture() {
  const data = new Map(EXTENSION_ASSETS.map((path) => [path, 'runtime: ' + path]));
  for (const path of WINDOWS_UPDATER_ASSETS) data.set(path, 'installer: ' + path);
  data.set('updater/public-key.json', JSON.stringify({ algorithm: 'RSA-SHA256', modulus: Buffer.alloc(256, 7).toString('base64'), exponent: 'AQAB' }));
  data.set('manifest.json', JSON.stringify({ manifest_version: 3, name: 'ALLEN Toolbox', version: '2.1.1' }));
  data.set('package.json', JSON.stringify({ version: '2.1.1' }));
  data.set('plugins/plugins.json', '[]');
  data.set('scripts/scripts.json', JSON.stringify([{ id: 'stable-seed', file: 'seed.user.js', enabled: false }]));
  data.set('scripts/seed.user.js', '// ==UserScript==\n// @name Seed\n// @grant none\n// ==/UserScript==\nvoid 0;\n');
  const fetched = [];
  const readAsset = async (path) => { fetched.push(path); if (!data.has(path)) throw new Error('Missing fixture asset: ' + path); return data.get(path); };
  return { data, fetched, readAsset };
}

async function archiveFiles(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), files = new Map();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    const name = decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength + extra; files.set(name, bytes.subarray(offset, offset + length)); offset += length;
  }
  return files;
}

test('release ZIP embeds the real repository, retains seed identity/state and excludes development/private files', async () => {
  const env = fixture(), repository = OFFICIAL_REPOSITORY;
  env.data.set('.env', 'PRIVATE_SECRET'); env.data.set('tests/extra.test.mjs', 'PRIVATE_TEST');
  const release = await buildRelease({ repository, readAsset: env.readAsset }), files = await archiveFiles(release.blob);
  assert.equal(release.filename, 'ALLEN-Toolbox-2.1.1.zip'); assert.equal(release.tag, 'v2.1.1');
  assert.equal(JSON.parse(decode(files.get('allen-toolbox/manifest.json'))).homepage_url, repository);
  assert.equal(JSON.parse(env.data.get('manifest.json')).homepage_url, undefined);
  assert.deepEqual(JSON.parse(decode(files.get('allen-toolbox/scripts/scripts.json'))), [{ id: 'stable-seed', file: 'seed.user.js', enabled: false }]);
  assert.equal(decode(files.get('allen-toolbox/scripts/seed.user.js')), env.data.get('scripts/seed.user.js'));
  assert.equal(files.size, EXTENSION_ASSETS.length + 4); assert.ok(files.has('allen-toolbox/shared/updates.js'));
  assert.equal(files.has('Install-ALLEN-Toolbox.cmd'), false); assert.equal(files.has('updater/install.ps1'), false);
  assert.equal(files.has('updater/ALLEN-Toolbox-NativeHost.exe'), false); assert.equal(files.has('updater/native-host.cs'), false);
  assert.equal(JSON.parse(decode(files.get('updater/availability.json'))).available, false);
  assert.match(decode(files.get('allen-toolbox/shared/native-updater-config.js')), /WINDOWS_UPDATER_AVAILABLE = false/);
  assert.ok(files.has('allen-toolbox/LICENSE'));
  assert.ok([...files.keys()].every((path) => !/\/tests\/|\/tools\/|\/\.github\/|\/\.env$|\/package\.json$/.test(path)));
  assert.ok(!env.fetched.includes('.env')); assert.ok(!env.fetched.includes('tests/extra.test.mjs'));
  assert.equal(release.checksum, createHash('sha256').update(new Uint8Array(await release.blob.arrayBuffer())).digest('hex'));
});

test('local releases always use the official repository and repeated builds are deterministic', async () => {
  const env = fixture(), first = await buildRelease({ readAsset: env.readAsset }), second = await buildRelease({ readAsset: env.readAsset });
  assert.equal(first.repository, OFFICIAL_REPOSITORY); assert.equal(first.checksum, second.checksum);
  const files = await archiveFiles(first.blob); assert.equal(JSON.parse(decode(files.get('allen-toolbox/manifest.json'))).homepage_url, OFFICIAL_REPOSITORY);
});

test('release hashes are independent of concurrent asset completion order', async () => {
  const build = async (reverse) => {
    const env = fixture(), pending = new Map();
    const result = buildRelease({ readAsset: async (path) => {
      const data = await env.readAsset(path);
      if (!EXTENSION_ASSETS.includes(path) || path === 'manifest.json') return data;
      return new Promise((resolve) => pending.set(path, () => resolve(data)));
    } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.size, EXTENSION_ASSETS.length - 2);
    const releases = [...pending.values()];
    if (reverse) releases.reverse();
    for (const finish of releases) finish();
    return result;
  };
  const first = await build(false), second = await build(true);
  assert.equal(first.checksum, second.checksum);
  assert.deepEqual([...await archiveFiles(first.blob)].map(([path]) => path), [...await archiveFiles(second.blob)].map(([path]) => path));
});

test('real source assets rebuild to the same release bytes and checksum', async () => {
  const first = await buildRelease(), second = await buildRelease();
  assert.equal(first.checksum, second.checksum);
  assert.deepEqual(new Uint8Array(await first.blob.arrayBuffer()), new Uint8Array(await second.blob.arrayBuffer()));
});

test('the Solus updater can discover all newly packaged media files and their license', async () => {
  const release = await buildRelease();
  const added = ['lib/mediabunny-LICENSE.txt', 'lib/mediabunny.min.mjs', 'shared/media-mux.js', 'shared/media-pair.js'];
  const assets = EXTENSION_ASSETS.filter((path) => !added.includes(path));
  const parsed = await parseUpdatePackage(new Uint8Array(await release.blob.arrayBuffer()), { version: release.version, prerelease: release.prerelease, assets });
  assert.ok(added.every((path) => parsed.paths.has(path)));
});

test('manifest homepages cannot redirect the fixed release update source', async () => {
  const env = fixture(), repository = OFFICIAL_REPOSITORY;
  env.data.set('manifest.json', JSON.stringify({ ...JSON.parse(env.data.get('manifest.json')), homepage_url: 'https://github.com/other/toolbox' }));
  const release = await buildRelease({ readAsset: env.readAsset }), files = await archiveFiles(release.blob);
  assert.equal(release.repository, repository);
  assert.equal(JSON.parse(decode(files.get('allen-toolbox/manifest.json'))).homepage_url, repository);
  await assert.rejects(buildRelease({ repository: 'https://github.com/other/toolbox', readAsset: env.readAsset }), /source is fixed/);
});

test('release packaging refuses unsynchronized/invalid versions, unsafe sources and incomplete inventories', async () => {
  const env = fixture(); env.data.set('package.json', '{"version":"2.1.0"}');
  await assert.rejects(buildRelease({ readAsset: env.readAsset }), /same release version/);
  env.data.set('manifest.json', '{"manifest_version":3,"version":"2.1.1-beta"}');
  await assert.rejects(buildRelease({ readAsset: env.readAsset }), /Invalid extension version/);
  const unsafe = fixture(); unsafe.data.set('scripts/scripts.json', '[{"id":"x","file":"../secret.user.js","enabled":true}]');
  await assert.rejects(buildRelease({ readAsset: unsafe.readAsset }), /Unsafe relative file path/);
  assert.ok(!unsafe.fetched.some((path) => path.includes('..')));
  const missing = fixture(); missing.data.delete('shared/updates.js');
  await assert.rejects(buildRelease({ readAsset: missing.readAsset }), /Missing package asset shared\/updates.js/);
  await assert.rejects(buildRelease({ repository: 'https://evil.test/repo', readAsset: fixture().readAsset }), /repository URL/);
});

test('workflow validates before publishing and protects existing version tags', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const publisher = await readFile(new URL('../tools/publish-release.mjs', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('npm run check') < workflow.indexOf('node tools/publish-release.mjs'));
  assert.ok(workflow.indexOf('npm test') < workflow.indexOf('node tools/publish-release.mjs'));
  assert.match(publisher, /'ls-remote', '--exit-code', '--tags'/); assert.match(publisher, /'--verify-tag', '--draft'/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/); assert.doesNotMatch(workflow + publisher, /--force|--clobber|cancel-in-progress: true/);
  assert.match(workflow, /node-version: '24'/); assert.match(workflow, /branches: \[main, beta\/builtin-updater\]/);
});

test('BETA package uses numeric manifest version but prerelease identity, description and no native installer', async () => {
  const env = fixture();
  env.data.set('manifest.json', JSON.stringify({ manifest_version: 3, name: 'ALLEN Toolbox', version: '2.3.1', version_name: '2.3.1 BETA' }));
  env.data.set('package.json', '{"version":"2.3.1"}');
  const out = await buildRelease({ readAsset: env.readAsset });
  assert.equal(out.version, '2.3.1'); assert.equal(out.prerelease, true); assert.equal(out.tag, 'v2.3.1-beta');
  assert.equal(out.filename, 'ALLEN-Toolbox-2.3.1-BETA.zip'); assert.match(out.notes, /not the Latest stable version/);
  assert.equal(out.nativeAvailable, false);
});

test('a named 2.4.0 release keeps numeric update identity and excludes all native installers', async () => {
  const env = fixture();
  env.data.set('manifest.json', JSON.stringify({ manifest_version: 3, name: 'ALLEN Toolbox', version: '2.4.0', version_name: '2.4.0 Test Prime' }));
  env.data.set('package.json', '{"version":"2.4.0"}');
  const out = await buildRelease({ readAsset: env.readAsset, nativeDirectory: 'must-not-be-read' });
  assert.equal(out.title, 'ALLEN Toolbox 2.4.0 Test Prime'); assert.equal(out.tag, 'v2.4.0'); assert.equal(out.prerelease, false);
  assert.equal(out.filename, 'ALLEN-Toolbox-2.4.0.zip'); assert.equal(out.nativeAvailable, false);
  assert.match(out.notes, /Restore write access/); assert.match(out.notes, /browser restarts/);
  const files = await archiveFiles(out.blob);
  assert.ok([...files.keys()].every((path) => !/\.(exe|ps1|cmd|cs)$/i.test(path)));
});
