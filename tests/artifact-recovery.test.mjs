import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreRelease } from '../tools/restore-release.mjs';

const commit = 'a'.repeat(40);
function fixture(artifacts = [], branch = 'main') {
  const calls = [];
  return { calls, run: async (args) => {
    calls.push(args);
    if (args[0] !== 'api') return '';
    return JSON.stringify(args[1].endsWith('/artifacts') ? { artifacts } : { head_sha: commit, head_branch: branch });
  } };
}
test('fresh builds do not download nonexistent artifacts or skip signing work', async () => {
  const env = fixture(); assert.equal(await restoreRelease({ runId: '123', commit, run: env.run }), false);
  assert.equal(env.calls.length, 2);
});
test('same-run retries restore exact original artifacts before timestamped files can be rebuilt', async () => {
  const env = fixture([{ name: 'allen-toolbox-package', expired: false, workflow_run: { head_sha: commit } }]);
  assert.equal(await restoreRelease({ runId: '123', commit, directory: 'dist-fixture', run: env.run }), true);
  assert.deepEqual(env.calls[2], ['run', 'download', '123', '--repo', 'supreme12343/allen-toolbox', '--name', 'allen-toolbox-package', '--dir', 'dist-fixture']);
});
test('foreign, ambiguous and expired artifacts cannot silently replace the tested release', async () => {
  const foreign = fixture([{ name: 'allen-toolbox-package', expired: false, workflow_run: { head_sha: 'b'.repeat(40) } }]);
  await assert.rejects(restoreRelease({ runId: '123', commit, run: foreign.run }), /another commit/);
  const expired = fixture([{ name: 'allen-toolbox-package', expired: true, workflow_run: { head_sha: commit } }]);
  assert.equal(await restoreRelease({ runId: '123', commit, run: expired.run }), false);
  await assert.rejects(restoreRelease({ runId: '../other', commit, run: fixture().run }), /Invalid workflow identity/);
});

test('beta artifact recovery stays bound to its exact beta branch and commit', async () => {
  const branch = 'beta/builtin-updater', artifacts = [{ name: 'allen-toolbox-package', expired: false, workflow_run: { head_sha: commit } }];
  const env = fixture(artifacts, branch);
  assert.equal(await restoreRelease({ runId: '123', commit, branch, run: env.run }), true);
  await assert.rejects(restoreRelease({ runId: '123', commit, branch: 'main', run: fixture(artifacts, branch).run }), /publishing-branch commit/);
});
