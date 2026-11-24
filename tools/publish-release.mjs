import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRelease } from './release.mjs';
import { githubRepository, versionParts, OFFICIAL_REPOSITORY } from '../shared/updates.js';
import { readBody } from '../shared/download.js';
import { verifyUpdate } from './update-signing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const execute = async (command, args) => (await promisify(execFile)(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout;

export async function verifyPublishedAssets(state, repository, fetcher = fetch) {
  const verification = JSON.parse(await readFile(resolve(root, 'updater/public-key.json'), 'utf8'));
  const filename = 'ALLEN-Toolbox-' + state.tag_name.replace(/^v/, '') + '.zip';
  const files = [filename, filename + '.sig', filename + '.sha256'];
  const data = [];
  for (const name of files) {
    const asset = state.assets.find((value) => value.name === name), url = repository + '/releases/download/' + state.tag_name + '/' + name;
    if (!asset || asset.browser_download_url !== url || !/^sha256:[a-f\d]{64}$/.test(asset.digest || '')) throw new Error('Published release asset identity is invalid');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetcher(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Published release asset could not be verified');
      const result = await readBody(response, { signal: controller.signal, maxBytes: name === filename ? 64 * 1024 * 1024 : 8192 });
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      if (bytes.length !== asset.size || 'sha256:' + hash(bytes) !== asset.digest) throw new Error('Published release bytes differ from the declared asset');
      data.push(bytes);
    } finally { clearTimeout(timer); }
  }
  if (!verifyUpdate(data[0], data[1], verification) || new TextDecoder().decode(data[2]) !== hash(data[0]) + '  ' + filename + '\n') throw new Error('Published release signature or checksum is invalid');
  return true;
}

export async function publishRelease({ repository, commit, release, run = execute, verifyPublished = verifyPublishedAssets }) {
  const repo = githubRepository(repository), slug = repo.slice('https://github.com/'.length);
  versionParts(release.version);
  if (repo !== OFFICIAL_REPOSITORY || release.repository !== repo || release.tag !== 'v' + release.version || release.filename !== 'ALLEN-Toolbox-' + release.version + '.zip' ||
      !/^[a-f\d]{64}$/.test(release.checksum) || !Number.isSafeInteger(release.blob?.size) || release.blob.size <= 0 ||
      !(release.signature instanceof Uint8Array) || release.signature.length < 256 || release.signature.length > 512 ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit)) throw new Error('Invalid release publication identity');
  const checksumText = release.checksum + '  ' + release.filename + '\n';
  const expected = [{ name: release.filename, size: release.blob.size, digest: 'sha256:' + release.checksum },
    { name: release.filename + '.sha256', size: Buffer.byteLength(checksumText), digest: 'sha256:' + hash(checksumText) },
    { name: release.filename + '.sig', size: release.signature.length, digest: 'sha256:' + hash(release.signature) }];
  let releaseId;
  const readRelease = async () => {
    if (!releaseId) {
      const [owner, name] = slug.split('/');
      // The REST tag endpoint only finds published releases. Resolve drafts by authenticated ID.
      const query = 'query=query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId}}}';
      const lookup = JSON.parse(await run('gh', ['api', 'graphql', '-f', query, '-f', 'owner=' + owner, '-f', 'name=' + name, '-f', 'tag=' + release.tag]));
      if (!lookup.data?.repository) throw new Error('The publication repository could not be resolved');
      const target = lookup.data.repository.release;
      if (!target) return null;
      if (!Number.isSafeInteger(target.databaseId) || target.databaseId <= 0) throw new Error('GitHub returned an invalid release identifier');
      releaseId = target.databaseId;
    }
    const data = JSON.parse(await run('gh', ['api', 'repos/' + slug + '/releases/' + releaseId]));
    if (data.tag_name !== release.tag || !Array.isArray(data.assets) || typeof data.draft !== 'boolean' || data.prerelease !== false) throw new Error('GitHub returned an invalid or prerelease publication');
    if (data.draft && data.assets.some((asset) => !expected.some((file) => file.name === asset.name))) throw new Error('The draft contains unexpected assets; it was not published');
    return data;
  };
  const matches = (asset, file) => asset?.state === 'uploaded' && asset.size === file.size && asset.digest === file.digest;
  let state = await readRelease();
  if (state && !state.draft) {
    if (!expected.every((file) => state.assets.some((asset) => asset.name === file.name && asset.state === 'uploaded' && asset.size > 0))) throw new Error('The published release is incomplete. Publish a new version; existing releases are not modified.');
    if (!(await verifyPublished(state, repo))) throw new Error('The published release could not be authenticated; it was not modified');
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
  if (!process.env.UPDATER_SIGNING_KEY) throw new Error('Signed updater publication requires UPDATER_SIGNING_KEY');
  const release = await buildRelease({ repository, signingKey: process.env.UPDATER_SIGNING_KEY, nativeDirectory: process.env.WINDOWS_UPDATER_DIR || '' });
  const archive = await readFile(resolve(root, 'dist', release.filename));
  const checksum = await readFile(resolve(root, 'dist', release.filename + '.sha256'), 'utf8');
  const signature = await readFile(resolve(root, 'dist', release.filename + '.sig'));
  if (hash(archive) !== release.checksum || archive.length !== release.blob.size || checksum !== release.checksum + '  ' + release.filename + '\n') throw new Error('The built files do not match the tested source package');
  if (!signature.equals(release.signature)) throw new Error('The built updater signature does not match the tested source package');
  const result = await publishRelease({ repository, commit: process.env.GITHUB_SHA, release });
  console.log(result.skipped ? 'Published version already exists; no release was modified: ' + result.tag : 'Published complete release: ' + result.tag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error('Publication failed: ' + error.message); process.exitCode = 1; });
}
