import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publishRelease } from '../tools/publish-release.mjs';
import { OFFICIAL_REPOSITORY } from '../shared/updates.js';

const repository = OFFICIAL_REPOSITORY, commit = 'a'.repeat(40);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const archive = Buffer.from('ZIP fixture'), filename = 'ALLEN-Toolbox-2.1.1.zip', checksum = hash(archive);
const signature = Buffer.alloc(384, 17);
const release = { repository, version: '2.1.1', tag: 'v2.1.1', filename, checksum, signature, blob: new Blob([archive]) };
const checksumText = checksum + '  ' + filename + '\n';
const expected = [{ name: filename, size: archive.length, digest: 'sha256:' + checksum, state: 'uploaded' },
  { name: filename + '.sha256', size: Buffer.byteLength(checksumText), digest: 'sha256:' + hash(checksumText), state: 'uploaded' },
  { name: filename + '.sig', size: signature.length, digest: 'sha256:' + hash(signature), state: 'uploaded' }];
const draft = (assets = []) => ({ tag_name: release.tag, draft: true, prerelease: false, assets: structuredClone(assets) });

function fixture(options = {}) {
  const calls = [], env = { tag: options.tag || '', state: options.state ? structuredClone(options.state) : null };
  let localTag = '', failed = false;
  env.run = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git') {
      if (args[0] === 'ls-remote') {
        if (options.failRefs) throw Object.assign(new Error('Cannot reach origin'), { code: 128 });
        if (!env.tag) throw Object.assign(new Error('No tag'), { code: 2 });
        return env.tag + '\trefs/tags/' + release.tag + '\n';
      }
      if (args[0] === 'tag') localTag = args[2];
      if (args[0] === 'push') env.tag = localTag;
      return '';
    }
    if (args[0] === 'api') {
      if (args[1] === 'graphql') return JSON.stringify(options.lookupResponse || { data: { repository: { release: env.state ? { databaseId: 101 } : null } } });
      if (args[1].endsWith('/releases/101') && env.state) return JSON.stringify(env.state);
      throw Object.assign(new Error('No published release at this endpoint'), { stderr: 'gh: Not Found (HTTP 404)' });
    }
    const operation = args[1];
    if (operation === 'create') {
      if (options.failCreate && !failed) { failed = true; throw new Error('API temporarily unavailable'); }
      assert.ok(args.includes('--draft')); env.state = draft();
    }
    if (operation === 'upload') {
      assert.equal(env.state.draft, true, 'Uploads must remain private');
      const name = args[3].slice('dist/'.length);
      if (options.failUpload === name && !failed) { failed = true; throw new Error('Upload interrupted'); }
      env.state.assets.push(structuredClone(expected.find((asset) => asset.name === name)));
    }
    if (operation === 'edit') {
      assert.deepEqual(env.state.assets, expected, 'Do not publish an incomplete release');
      assert.ok(args.includes('--draft=false')); env.state.draft = false;
    }
    return '';
  };
  env.publish = () => publishRelease({ repository, commit, release, run: env.run, verifyPublished: async () => options.invalidPublished ? false : true });
  env.calls = calls;
  return env;
}

test('publication creates an immutable tag, uploads privately and publishes only complete verified artifacts', async () => {
  const env = fixture(), result = await env.publish();
  assert.equal(result.published, true); assert.equal(env.tag, commit); assert.equal(env.state.draft, false);
  assert.deepEqual(env.state.assets, expected);
  assert.equal(env.calls.filter((call) => call.command === 'git' && call.args[0] === 'push').length, 1);
  assert.ok(!env.calls.some((call) => call.args.includes('--force') || call.args.includes('--clobber')));
});

test('a tag push followed by failed draft creation can resume the same commit without changing the tag', async () => {
  const env = fixture({ failCreate: true });
  await assert.rejects(env.publish(), /temporarily unavailable/); assert.equal(env.tag, commit); assert.equal(env.state, null);
  await env.publish(); assert.equal(env.state.draft, false);
  assert.equal(env.calls.filter((call) => call.command === 'git' && call.args[0] === 'push').length, 1);
});

test('an interrupted checksum upload stays a draft and reruns upload only the missing file', async () => {
  const env = fixture({ failUpload: filename + '.sha256' });
  await assert.rejects(env.publish(), /Upload interrupted/); assert.equal(env.state.draft, true); assert.deepEqual(env.state.assets, [expected[0]]);
  await env.publish(); assert.equal(env.state.draft, false); assert.deepEqual(env.state.assets, expected);
  assert.equal(env.calls.filter((call) => call.args[1] === 'upload' && call.args[3] === 'dist/' + filename).length, 1);
});

test('drafts hidden by the REST tag endpoint are resolved by authenticated release ID', async () => {
  const env = fixture({ tag: commit, state: draft([expected[0]]) });
  await env.publish();
  assert.equal(env.state.draft, false);
  assert.ok(env.calls.some((call) => call.args[0] === 'api' && call.args[1] === 'graphql'));
  assert.ok(env.calls.some((call) => call.args[0] === 'api' && call.args[1].endsWith('/releases/101')));
  assert.ok(!env.calls.some((call) => call.args[1]?.includes('/releases/tags/')));
  assert.ok(!env.calls.some((call) => call.args[1] === 'create'));
});

test('unsigned or malformed signature releases cannot create tags or publish executable updates', async () => {
  const env = fixture();
  for (const signature of [null, Buffer.alloc(12)]) await assert.rejects(publishRelease({ repository, commit, release: { ...release, signature }, run: env.run }), /publication identity/);
  assert.equal(env.calls.length, 0);
});
test('unresolved repositories and invalid release IDs cannot create tags or modify releases', async (t) => {
  for (const lookupResponse of [{ data: { repository: null } }, { data: { repository: { release: { databaseId: 'untrusted' } } } }]) await t.test(JSON.stringify(lookupResponse), async () => {
    const env = fixture({ lookupResponse });
    await assert.rejects(env.publish(), /could not be resolved|invalid release identifier/);
    assert.ok(env.calls.every((call) => call.command === 'gh' && call.args[0] === 'api'));
  });
});

test('already published releases are never modified even when the new main commit differs', async () => {
  const env = fixture({ tag: 'b'.repeat(40), state: { ...draft(expected), draft: false } });
  assert.equal((await env.publish()).skipped, true);
  assert.ok(env.calls.every((call) => call.command === 'gh' && call.args[0] === 'api'));
});

test('a published but unauthentic release is refused without repairing or replacing its assets', async () => {
  const env = fixture({ tag: commit, state: { ...draft(expected), draft: false }, invalidPublished: true });
  await assert.rejects(env.publish(), /could not be authenticated/);
  assert.ok(env.calls.every((call) => call.command === 'gh' && call.args[0] === 'api'));
});

test('incomplete public releases, changed tags and foreign draft assets fail closed without replacing artifacts', async (t) => {
  const cases = [
    ['incomplete public release', { tag: commit, state: { ...draft([expected[0]]), draft: false } }, /published release is incomplete/],
    ['different tag commit', { tag: 'b'.repeat(40) }, /different commit/],
    ['different draft hash', { tag: commit, state: draft([{ ...expected[0], digest: 'sha256:' + 'f'.repeat(64) }]) }, /differs from the tested artifact/],
    ['unexpected draft upload', { tag: commit, state: draft([{ name: 'private.txt', state: 'uploaded', size: 12 }]) }, /unexpected assets/],
    ['failed remote query', { failRefs: true }, /Cannot reach origin/],
  ];
  for (const [name, options, message] of cases) await t.test(name, async () => {
    const env = fixture(options); await assert.rejects(env.publish(), message);
    assert.ok(!env.calls.some((call) => call.args[1] === 'upload' || call.args[1] === 'edit'));
    assert.ok(!env.calls.some((call) => call.command === 'git' && call.args[0] === 'push'));
  });
});
