import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'supreme12343/allen-toolbox';
const execute = async (args) => (await promisify(execFile)('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout;

export async function restoreRelease({ runId, commit, branch = 'main', directory = resolve('dist'), run = execute } = {}) {
  if (!/^\d+$/.test(runId || '') || !/^[a-f\d]{40}$/i.test(commit || '')) throw new Error('Invalid workflow identity for artifact recovery');
  const workflow = JSON.parse(await run(['api', 'repos/' + repository + '/actions/runs/' + runId]));
  if (!['main', 'beta/builtin-updater'].includes(branch) || workflow.head_sha !== commit || workflow.head_branch !== branch) throw new Error('The original artifact does not belong to this publishing-branch commit');
  const result = JSON.parse(await run(['api', 'repos/' + repository + '/actions/runs/' + runId + '/artifacts']));
  if (!Array.isArray(result.artifacts)) throw new Error('GitHub returned invalid artifact metadata');
  const artifacts = result.artifacts.filter((value) => value.name === 'allen-toolbox-package' && value.expired === false);
  if (!artifacts.length) return false;
  if (artifacts.length !== 1 || artifacts[0].workflow_run?.head_sha !== commit) throw new Error('Artifact recovery is ambiguous or belongs to another commit');
  await run(['run', 'download', runId, '--repo', repository, '--name', 'allen-toolbox-package', '--dir', directory]);
  return true;
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_OUTPUT) throw new Error('Artifact recovery runs only inside GitHub Actions');
  const restored = await restoreRelease({ runId: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA, branch: process.env.GITHUB_REF_NAME });
  await appendFile(process.env.GITHUB_OUTPUT, 'restored=' + restored + '\n');
  console.log(restored ? 'Restored original tested artifacts; timestamped native files will not be rebuilt.' : 'No original artifact exists; a fresh build is required.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
