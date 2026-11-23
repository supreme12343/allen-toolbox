import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRelease } from './release.mjs';
import { githubRepository, versionParts } from '../shared/updates.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const execute = async (command, args) => (await promisify(execFile)(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout;

export async function publishRelease({ repository, commit, release, run = execute }) {
  const repo = githubRepository(repository), slug = repo.slice('https://github.com/'.length);
  versionParts(release.version);
  if (!repo || release.repository !== repo || release.tag !== 'v' + release.version || release.filename !== 'ALLEN-Toolbox-' + release.version + '.zip' ||
      !/^[a-f\d]{64}$/.test(release.checksum) || !Number.isSafeInteger(release.blob?.size) || release.blob.size <= 0 ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit)) throw new Error('Invalid release publication identity');
  const checksumText = release.checksum + '  ' + release.filename + '\n';
  const expected = [{ name: release.filename, size: release.blob.size, digest: 'sha256:' + release.checksum },
    { name: release.filename + '.sha256', size: Buffer.byteLength(checksumText), digest: 'sha256:' + hash(checksumText) }];
  const readRelease = async () => {
    let data;
    try { data = JSON.parse(await run('gh', ['api', 'repos/' + slug + '/releases/tags/' + release.tag])); }
    catch (error) { if (/\(HTTP\s+404\)/.test(error.stderr || '')) return null; throw error; }
    if (data.tag_name !== release.tag || !Array.isArray(data.assets) || typeof data.draft !== 'boolean' || data.prerelease !== false) throw new Error('GitHub returned an invalid or prerelease publication');
    if (data.draft && data.assets.some((asset) => !expected.some((file) => file.name === asset.name))) throw new Error('The draft contains unexpected assets; it was not published');
    return data;
  };
  const matches = (asset, file) => asset?.state === 'uploaded' && asset.size === file.size && asset.digest === file.digest;
  let state = await readRelease();
  if (state && !state.draft) {
    if (!expected.every((file) => state.assets.some((asset) => asset.name === file.name && asset.state === 'uploaded' && asset.size > 0))) throw new Error('The published release is incomplete. Publish a new version; existing releases are not modified.');
    return { skipped: true, tag: release.tag };
  }

  const ref = 'refs/tags/' + release.tag;
  let refs = [];
  try { refs = (await run('git', ['ls-remote', '--exit-code', '--tags', 'origin', ref, ref + '^{}'])).trim().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/)); }
  catch (error) { if (error.code !== 2) throw error; }
  const tagCommit = refs.find((line) => line[1] === ref + '^{}')?.[0] || refs.find((line) => line[1] === ref)?.[0];
  if (tagCommit && tagCommit.toLowerCase() !== commit.toLowerCase()) throw new Error('This version tag belongs to a different commit. Rerun its original workflow or publish a newer version.');
  if (!tagCommit) {
    await run('git', ['tag', release.tag, commit]);
    await run('git', ['push', 'origin', ref]);
  }
  if (!state) await run('gh', ['release', 'create', release.tag, '--repo', slug, '--verify-tag', '--draft', '--title', 'ALLEN Toolbox ' + release.version, '--generate-notes']);

  // Keep incomplete uploads private. Reruns may add missing draft assets, never replace them.
  for (const file of expected) {
    state = await readRelease();
    if (!state?.draft) throw new Error('The release is no longer a draft; no assets were modified');
    const asset = state.assets.find((value) => value.name === file.name);
    if (asset) {
      if (!matches(asset, file)) throw new Error('Draft asset differs from the tested artifact: ' + file.name + '. It was not overwritten.');
    } else await run('gh', ['release', 'upload', release.tag, 'dist/' + file.name, '--repo', slug]);
  }
  state = await readRelease();
  if (!state || !expected.every((file) => matches(state.assets.find((asset) => asset.name === file.name), file))) throw new Error('Release assets are not complete or their hashes differ; publication was refused');
  if (state.draft) await run('gh', ['release', 'edit', release.tag, '--repo', slug, '--draft=false', '--latest']);
  return { published: true, tag: release.tag };
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Publication runs only in the main-branch GitHub Actions workflow');
  const repository = githubRepository('https://github.com/' + process.env.GITHUB_REPOSITORY);
  const release = await buildRelease({ repository });
  const archive = await readFile(resolve(root, 'dist', release.filename));
  const checksum = await readFile(resolve(root, 'dist', release.filename + '.sha256'), 'utf8');
  if (hash(archive) !== release.checksum || archive.length !== release.blob.size || checksum !== release.checksum + '  ' + release.filename + '\n') throw new Error('The built files do not match the tested source package');
  const result = await publishRelease({ repository, commit: process.env.GITHUB_SHA, release });
  console.log(result.skipped ? 'Published version already exists; no release was modified: ' + result.tag : 'Published complete release: ' + result.tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error('Publication failed: ' + error.message); process.exitCode = 1; });
}
