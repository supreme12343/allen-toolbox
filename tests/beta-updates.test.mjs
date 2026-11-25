import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OFFICIAL_REPOSITORY, releaseIdentity, githubRelease, selectGithubRelease, isNewerRelease } from '../shared/update-meta.js';

function metadata(version, prerelease) {
  const identity = releaseIdentity(version, prerelease), root = OFFICIAL_REPOSITORY + '/releases/download/' + identity.tag + '/';
  return { tag_name: identity.tag, draft: false, prerelease, html_url: OFFICIAL_REPOSITORY + '/releases/tag/' + identity.tag,
    assets: [{ name: identity.filename, browser_download_url: root + identity.filename, state: 'uploaded', size: 100 },
      { name: identity.filename + '.sig', browser_download_url: root + identity.filename + '.sig', state: 'uploaded', size: 384 }] };
}

test('stable metadata parsing never promotes a prerelease into its normal update channel', () => {
  assert.throws(() => githubRelease(metadata('2.3.1', true), OFFICIAL_REPOSITORY));
  assert.equal(selectGithubRelease([metadata('2.3.1', true), metadata('2.3.0', false)], OFFICIAL_REPOSITORY).version, '2.3.0');
});
test('beta parsing accepts only coherent prerelease tags and exact signed asset URLs', () => {
  const out = githubRelease(metadata('2.3.1', true), OFFICIAL_REPOSITORY, { allowPrerelease: true });
  assert.equal(out.tag, 'v2.3.1-beta'); assert.equal(out.filename, 'ALLEN-Toolbox-2.3.1-BETA.zip'); assert.equal(out.signatureSize, 384);
  assert.ok(out.signatureUrl.endsWith('ALLEN-Toolbox-2.3.1-BETA.zip.sig'));
  const wrong = metadata('2.3.1', true); wrong.prerelease = false;
  assert.throws(() => githubRelease(wrong, OFFICIAL_REPOSITORY, { allowPrerelease: true }));
});
test('beta testers can move to a same-number stable release, never the reverse', () => {
  const beta = { version: '2.3.1', version_name: '2.3.1 BETA' };
  assert.equal(isNewerRelease({ version: '2.3.1', prerelease: false }, beta), true);
  assert.equal(isNewerRelease({ version: '2.3.1', prerelease: true }, { version: '2.3.1' }), false);
});
test('the runtime signature key is identical to the previously pinned release key', async () => {
  const [runtime, release] = await Promise.all(['../shared/update-public-key.json', '../updater/public-key.json'].map((path) => readFile(new URL(path, import.meta.url), 'utf8').then(JSON.parse)));
  assert.deepEqual(runtime, release);
});

test('release codenames affect display titles but never the stable tag or archive URL', () => {
  const out = releaseIdentity('2.4.0', false, '2.4.0 Test Prime');
  assert.equal(out.title, 'ALLEN Toolbox 2.4.0 Test Prime'); assert.equal(out.tag, 'v2.4.0'); assert.equal(out.filename, 'ALLEN-Toolbox-2.4.0.zip');
  assert.throws(() => releaseIdentity('2.4.0', false, '2.4.0 BETA'), /display name/);
  assert.throws(() => releaseIdentity('2.4.0', false, '2.4.1 Other'), /display name/);
  assert.throws(() => releaseIdentity('2.4.0', true, '2.4.0 Test Prime'), /display name/);
});
