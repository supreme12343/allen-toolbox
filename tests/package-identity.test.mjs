import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../shared/zip.js';
import { assertPackageIdentity } from '../tools/package-identity.mjs';
import { releaseIdentity, OFFICIAL_REPOSITORY } from '../shared/update-meta.js';

async function archive(version, beta) {
  const manifest = { name: 'ALLEN Toolbox', manifest_version: 3, version, homepage_url: OFFICIAL_REPOSITORY,
    ...(beta ? { version_name: version + ' BETA' } : {}) };
  return new Uint8Array(await (await createZip([{ path: 'allen-toolbox/manifest.json', data: JSON.stringify(manifest) }])).arrayBuffer());
}
test('signed archive identity must match the release version and beta/stable channel', async () => {
  const beta = await archive('2.3.1', true);
  assert.equal(assertPackageIdentity(beta, releaseIdentity('2.3.1', true)).version_name, '2.3.1 BETA');
  assert.throws(() => assertPackageIdentity(beta, releaseIdentity('2.3.1', false)), /version\/channel differs/);
});
test('renaming a valid old stable archive cannot turn it into a newer beta', async () => {
  const stable = await archive('2.3.0', false);
  assert.throws(() => assertPackageIdentity(stable, releaseIdentity('2.3.1', true)), /version\/channel differs/);
});
