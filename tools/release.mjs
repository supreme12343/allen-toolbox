import { readFile, realpath, mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { buildExtensionBundle } from '../shared/package.js';
import { validateZipPath } from '../shared/zip.js';
import { githubRepository, versionParts, OFFICIAL_REPOSITORY, releaseIdentity, isBetaManifest } from '../shared/update-meta.js';
import { signUpdate } from './update-signing.mjs';
import { loadWindowsUpdater, WINDOWS_UPDATER_FILES } from './windows-updater.mjs';
import { releaseNotes } from './release-notes.mjs';

export const WINDOWS_UPDATER_ASSETS = WINDOWS_UPDATER_FILES;

const root = fileURLToPath(new URL('../', import.meta.url));
const decoder = new TextDecoder('utf-8', { fatal: true });

async function sourceAsset(path) {
  validateZipPath(path);
  const target = await realpath(resolve(root, path)), within = relative(root, target);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('Release source escapes the project: ' + path);
  return readFile(target);
}

export async function buildRelease({ repository = '', readAsset = sourceAsset, signingKey = '', nativeDirectory = '', verifyNative } = {}) {
  const text = async (path) => { const data = await readAsset(path); return typeof data === 'string' ? data : decoder.decode(data); };
  const [manifest, pkg, index] = await Promise.all(['manifest.json', 'package.json', 'scripts/scripts.json'].map(async (path) => JSON.parse(await text(path))));
  versionParts(manifest.version);
  if (pkg.version !== manifest.version) throw new Error('manifest.json and package.json must have the same release version');
  const repo = OFFICIAL_REPOSITORY;
  if (repository && githubRepository(repository) !== repo) throw new Error('The release update source is fixed to the official ALLEN Toolbox repository');
  const packagedManifest = { ...manifest, ...(repo ? { homepage_url: repo } : {}) };
  if (!Array.isArray(index)) throw new Error('scripts/scripts.json must be an array');
  const files = await Promise.all(index.map(async (entry) => {
    validateZipPath(entry?.file);
    if (!/\.user\.js$/i.test(entry.file)) throw new Error('Release scripts must end in .user.js');
    const path = 'scripts/' + entry.file;
    return { path, text: await text(path) };
  }));
  const publicKey = JSON.parse(await text('updater/public-key.json'));
  const identity = releaseIdentity(manifest.version, isBetaManifest(manifest), manifest.version_name || '');
  // This release uses browser-granted folder access only. Legacy native build
  // metadata cannot introduce executables or installers into its update payload.
  const native = await loadWindowsUpdater();
  const installerFiles = [...(native.files.length ? native.files : [{ path: 'updater/public-key.json', data: await readAsset('updater/public-key.json') }]),
    { path: 'updater/availability.json', data: JSON.stringify(native.metadata, null, 2) + '\n' }];
  const nativeConfig = 'export const WINDOWS_UPDATER_AVAILABLE = ' + native.metadata.available + ';\nexport const WINDOWS_UPDATER_PUBLISHER = ' + JSON.stringify(native.metadata.publisherThumbprint) + ';\n';
  const blob = await buildExtensionBundle({ index, files }, async (path) => path === 'manifest.json' ? JSON.stringify(packagedManifest, null, 2) + '\n' :
    path === 'shared/native-updater-config.js' ? nativeConfig : readAsset(path), packagedManifest, installerFiles);
  const bytes = new Uint8Array(await blob.arrayBuffer()), checksum = createHash('sha256').update(bytes).digest('hex');
  const signature = signingKey ? signUpdate(bytes, signingKey, publicKey) : null;
  return { blob, checksum, signature, nativeAvailable: native.metadata.available, ...identity, repository: repo, notes: releaseNotes(identity) };
}

async function main() {
  const args = {};
  for (const argument of process.argv.slice(2)) {
    if (argument === '--help') { console.log('Usage: npm run release (official update repository is fixed)'); return; }
    if (argument.startsWith('--repository=')) args.repository = argument.slice('--repository='.length);
    else if (argument.startsWith('--windows-updater-dir=')) args.nativeDirectory = argument.slice('--windows-updater-dir='.length);
    else throw new Error('Unknown release argument: ' + argument);
  }
  const repository = args.repository ?? (process.env.GITHUB_REPOSITORY ? 'https://github.com/' + process.env.GITHUB_REPOSITORY : '');
  const signingKey = process.env.UPDATER_SIGNING_KEY || '';
  if (process.env.GITHUB_ACTIONS === 'true' && !signingKey) throw new Error('Signed updater releases require the UPDATER_SIGNING_KEY secret');
  const result = await buildRelease({ repository, signingKey, nativeDirectory: args.nativeDirectory || process.env.WINDOWS_UPDATER_DIR || '' });
  const output = resolve(root, 'dist');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, result.filename), new Uint8Array(await result.blob.arrayBuffer()));
  await writeFile(resolve(output, result.filename + '.sha256'), result.checksum + '  ' + result.filename + '\n');
  if (result.signature) await writeFile(resolve(output, result.filename + '.sig'), result.signature);
  else await unlink(resolve(output, result.filename + '.sig')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(resolve(output, 'RELEASE_NOTES.md'), result.notes);
  if (result.prerelease) await writeFile(resolve(output, 'STABLE_RELEASE_NOTES.md'), releaseNotes({ version: '2.3.0' }));
  await writeFile(resolve(output, 'release.json'), JSON.stringify({ version: result.version, prerelease: result.prerelease, tag: result.tag, filename: result.filename, title: result.title }, null, 2) + '\n');
  console.log('Built dist/' + result.filename + ' (' + result.blob.size + ' bytes)');
  console.log(result.repository ? 'Update repository: ' + result.repository : 'No update repository configured; this ZIP is unlinked.');
  console.log('SHA-256: ' + result.checksum);
  console.log('Built-in browser folder updater package: no native installer or executable included.');
  console.log(result.signature ? 'RSA-SHA256 updater signature generated.' : 'Unsigned local development package: signature-verifying updaters will refuse installation of it.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error('Release failed: ' + error.message); process.exitCode = 1; });
}
