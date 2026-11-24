import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadWindowsUpdater, WINDOWS_UPDATER_FILES } from '../tools/windows-updater.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = { algorithm: 'RSA-SHA256', modulus: Buffer.alloc(256, 7).toString('base64'), exponent: 'AQAB' };
const publisher = 'A'.repeat(40);

function fixture() {
  // Pure memory fixtures: no executable is generated, written, signed or launched.
  const root = resolve('signed-helper-memory-fixture');
  const data = new Map(WINDOWS_UPDATER_FILES.map((path) => [resolve(root, path), Buffer.from('inert fixture for ' + path)]));
  data.set(resolve(root, 'updater/public-key.json'), Buffer.from(JSON.stringify(key)));
  const metadata = { protocol: 2, available: true, reason: '', publisherThumbprint: publisher, files: {} };
  for (const path of WINDOWS_UPDATER_FILES) metadata.files[path] = hash(data.get(resolve(root, path)));
  const args = { directory: root, pinnedPublicKey: key, trustedLauncher: data.get(resolve(root, 'Install-ALLEN-Toolbox.cmd')), resolvePath: async (path) => path,
    info: async (path) => ({ isFile: () => true, size: path === resolve(root, 'availability.json') ? Buffer.byteLength('\uFEFF' + JSON.stringify(metadata)) : data.get(path).length }),
    read: async (path) => path === resolve(root, 'availability.json') ? Buffer.from('\uFEFF' + JSON.stringify(metadata)) : data.get(path),
    verify: async () => ({ publisherThumbprint: publisher, files: { ...metadata.files } }) };
  return { root, data, metadata, args };
}

test('without a Windows signing stage, native code is unavailable and no verifier runs', async () => {
  let calls = 0;
  const result = await loadWindowsUpdater({ verify: async () => { calls++; throw new Error('Must not run'); } });
  assert.equal(result.metadata.available, false); assert.deepEqual(result.files, []); assert.equal(calls, 0);
});

test('only a Windows-verified publisher and complete matching inventory enable helper packaging', async () => {
  const env = fixture(), result = await loadWindowsUpdater(env.args);
  assert.equal(result.metadata.available, true); assert.equal(result.metadata.publisherThumbprint, publisher);
  assert.deepEqual(result.files.map((file) => file.path), [...WINDOWS_UPDATER_FILES]);
  assert.ok(!result.files.some((file) => file.path.endsWith('.cs')));
});

test('a false availability stage cannot smuggle an executable into a manual package', async () => {
  const env = fixture(); env.metadata.available = false;
  env.args.verify = async () => { throw new Error('Disabled staging must not invoke a verifier'); };
  const result = await loadWindowsUpdater(env.args);
  assert.deepEqual(result.files, []); assert.equal(result.metadata.available, false);
});

test('missing, untrusted and mismatched publisher verification fail closed', async (t) => {
  for (const mode of ['untrusted', 'different publisher', 'invalid metadata']) await t.test(mode, async () => {
    const env = fixture();
    if (mode === 'untrusted') env.args.verify = async () => { throw new Error('Windows rejected the signature'); };
    if (mode === 'different publisher') env.args.verify = async () => ({ publisherThumbprint: 'B'.repeat(40), files: env.metadata.files });
    if (mode === 'invalid metadata') env.metadata.publisherThumbprint = 'not-a-certificate';
    await assert.rejects(loadWindowsUpdater(env.args), /rejected|differs|Invalid signed helper/);
  });
});

test('post-verification byte changes and pinned-key replacements cannot enter a release', async () => {
  const changed = fixture(); changed.data.set(resolve(changed.root, 'updater/updater.ps1'), Buffer.from('changed'));
  await assert.rejects(loadWindowsUpdater(changed.args), /bytes differ/);
  const replaced = fixture();
  replaced.data.set(resolve(replaced.root, 'updater/public-key.json'), Buffer.from(JSON.stringify({ ...key, exponent: 'Aw==' })));
  replaced.metadata.files['updater/public-key.json'] = hash(replaced.data.get(resolve(replaced.root, 'updater/public-key.json')));
  await assert.rejects(loadWindowsUpdater(replaced.args), /pinned update verification key/);
});

test('rewriting the unsigned launcher and its metadata hash cannot change trusted source commands', async () => {
  const env = fixture();
  env.data.set(resolve(env.root, 'Install-ALLEN-Toolbox.cmd'), Buffer.from('arbitrary commands'));
  env.metadata.files['Install-ALLEN-Toolbox.cmd'] = hash(env.data.get(resolve(env.root, 'Install-ALLEN-Toolbox.cmd')));
  await assert.rejects(loadWindowsUpdater(env.args), /launcher differs from the trusted project source/);
  const missing = fixture(); delete missing.args.trustedLauncher;
  await assert.rejects(loadWindowsUpdater(missing.args), /requires the trusted source launcher/);
});

test('a publisher-only proof or hashes of different signed bytes cannot authorize a staged file', async () => {
  const missing = fixture(); missing.args.verify = async () => ({ publisherThumbprint: publisher });
  await assert.rejects(loadWindowsUpdater(missing.args), /verified inventory/);
  const raced = fixture();
  const original = { ...raced.metadata.files };
  raced.data.set(resolve(raced.root, 'updater/updater.ps1'), Buffer.from('different bytes'));
  raced.metadata.files['updater/updater.ps1'] = hash(raced.data.get(resolve(raced.root, 'updater/updater.ps1')));
  raced.args.verify = async () => ({ publisherThumbprint: publisher, files: original });
  await assert.rejects(loadWindowsUpdater(raced.args), /verified inventory/);
});

test('oversized staging files are rejected before reading their contents', async () => {
  const env = fixture(); let read = false;
  env.args.info = async () => ({ isFile: () => true, size: 16385 });
  env.args.read = async () => { read = true; throw new Error('Must not read oversized metadata'); };
  await assert.rejects(loadWindowsUpdater(env.args), /package limit/); assert.equal(read, false);
});

test('resolved helper paths cannot escape the staging directory', async () => {
  const env = fixture();
  env.args.resolvePath = async (path) => path.endsWith('install.ps1') ? resolve(env.root, '../outside.ps1') : path;
  await assert.rejects(loadWindowsUpdater(env.args), /escapes its staging directory/);
});

test('release workflow blocks on Windows checks and never disables security to publish', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /needs: native-windows/);
  assert.doesNotMatch(workflow, /continue-on-error|DisableRealtimeMonitoring|Add-MpPreference|Set-MpPreference/);
  assert.match(workflow, /Start-MpScan -ScanType CustomScan/);
  assert.ok(workflow.indexOf('Scan release package') < workflow.indexOf('node tools/publish-release.mjs'));
  const preparation = await readFile(new URL('../tools/prepare-ci-defender.ps1', import.meta.url), 'utf8');
  assert.match(preparation, /GITHUB_ACTIONS -cne 'true'/);
  assert.match(preparation, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.match(preparation, /DisableRealtimeMonitoring \$false/);
  assert.match(preparation, /DisableArchiveScanning \$false/);
  assert.match(preparation, /Remove-MpPreference -ExclusionPath/);
  assert.doesNotMatch(preparation, /DisableRealtimeMonitoring \$true|DisableArchiveScanning \$true|Add-MpPreference/);
});
