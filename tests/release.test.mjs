import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildRelease } from '../tools/release.mjs';
import { EXTENSION_ASSETS } from '../shared/package.js';

const decode = (data) => new TextDecoder().decode(data);
function fixture() {
  const data = new Map(EXTENSION_ASSETS.map((path) => [path, 'runtime: ' + path]));
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
  const env = fixture(), repository = 'https://github.com/example/allen-toolbox';
  env.data.set('.env', 'PRIVATE_SECRET'); env.data.set('tests/extra.test.mjs', 'PRIVATE_TEST');
  const release = await buildRelease({ repository, readAsset: env.readAsset }), files = await archiveFiles(release.blob);
  assert.equal(release.filename, 'ALLEN-Toolbox-2.1.1.zip'); assert.equal(release.tag, 'v2.1.1');
  assert.equal(JSON.parse(decode(files.get('allen-toolbox/manifest.json'))).homepage_url, repository);
  assert.equal(JSON.parse(env.data.get('manifest.json')).homepage_url, undefined);
  assert.deepEqual(JSON.parse(decode(files.get('allen-toolbox/scripts/scripts.json'))), [{ id: 'stable-seed', file: 'seed.user.js', enabled: false }]);
  assert.equal(decode(files.get('allen-toolbox/scripts/seed.user.js')), env.data.get('scripts/seed.user.js'));
  assert.equal(files.size, EXTENSION_ASSETS.length + 2); assert.ok(files.has('allen-toolbox/shared/updates.js'));
  assert.ok([...files.keys()].every((path) => !/\/tests\/|\/tools\/|\/\.github\/|\/\.env$|\/package\.json$/.test(path)));
  assert.ok(!env.fetched.includes('.env')); assert.ok(!env.fetched.includes('tests/extra.test.mjs'));
  assert.equal(release.checksum, createHash('sha256').update(new Uint8Array(await release.blob.arrayBuffer())).digest('hex'));
});

test('local releases do not invent a GitHub repository and repeated builds are deterministic', async () => {
  const env = fixture(), first = await buildRelease({ readAsset: env.readAsset }), second = await buildRelease({ readAsset: env.readAsset });
  assert.equal(first.repository, ''); assert.equal(first.checksum, second.checksum);
  const files = await archiveFiles(first.blob); assert.equal(JSON.parse(decode(files.get('allen-toolbox/manifest.json'))).homepage_url, undefined);
});

test('local builds inherit the configured source repository without claiming the ZIP is unlinked', async () => {
  const env = fixture(), repository = 'https://github.com/example/allen-toolbox';
  env.data.set('manifest.json', JSON.stringify({ ...JSON.parse(env.data.get('manifest.json')), homepage_url: repository }));
  const release = await buildRelease({ readAsset: env.readAsset }), files = await archiveFiles(release.blob);
  assert.equal(release.repository, repository);
  assert.equal(JSON.parse(decode(files.get('allen-toolbox/manifest.json'))).homepage_url, repository);
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
  assert.match(workflow, /node-version: '24'/); assert.match(workflow, /branches: \[main\]/);
});
