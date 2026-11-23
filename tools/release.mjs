import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { buildExtensionBundle } from '../shared/package.js';
import { validateZipPath } from '../shared/zip.js';
import { githubRepository, versionParts } from '../shared/updates.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const decoder = new TextDecoder('utf-8', { fatal: true });

async function sourceAsset(path) {
  validateZipPath(path);
  const target = await realpath(resolve(root, path)), within = relative(root, target);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('Release source escapes the project: ' + path);
  return readFile(target);
}

export async function buildRelease({ repository = '', readAsset = sourceAsset } = {}) {
  const text = async (path) => { const data = await readAsset(path); return typeof data === 'string' ? data : decoder.decode(data); };
  const [manifest, pkg, index] = await Promise.all(['manifest.json', 'package.json', 'scripts/scripts.json'].map(async (path) => JSON.parse(await text(path))));
  versionParts(manifest.version);
  if (pkg.version !== manifest.version) throw new Error('manifest.json and package.json must have the same release version');
  const repo = githubRepository(repository || manifest.homepage_url);
  const packagedManifest = { ...manifest, ...(repo ? { homepage_url: repo } : {}) };
  if (!Array.isArray(index)) throw new Error('scripts/scripts.json must be an array');
  const files = await Promise.all(index.map(async (entry) => {
    validateZipPath(entry?.file);
    if (!/\.user\.js$/i.test(entry.file)) throw new Error('Release scripts must end in .user.js');
    const path = 'scripts/' + entry.file;
    return { path, text: await text(path) };
  }));
  const blob = await buildExtensionBundle({ index, files }, async (path) => path === 'manifest.json' ? JSON.stringify(packagedManifest, null, 2) + '\n' : readAsset(path), packagedManifest);
  const checksum = createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
  return { blob, checksum, version: manifest.version, tag: 'v' + manifest.version, filename: 'ALLEN-Toolbox-' + manifest.version + '.zip', repository: repo };
}

async function main() {
  const args = {};
  for (const argument of process.argv.slice(2)) {
    if (argument === '--help') { console.log('Usage: npm run release -- --repository=https://github.com/OWNER/REPO'); return; }
    if (!argument.startsWith('--repository=')) throw new Error('Unknown release argument: ' + argument);
    args.repository = argument.slice('--repository='.length);
  }
  const repository = args.repository ?? (process.env.GITHUB_REPOSITORY ? 'https://github.com/' + process.env.GITHUB_REPOSITORY : '');
  const result = await buildRelease({ repository });
  const output = resolve(root, 'dist');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, result.filename), new Uint8Array(await result.blob.arrayBuffer()));
  await writeFile(resolve(output, result.filename + '.sha256'), result.checksum + '  ' + result.filename + '\n');
  console.log('Built dist/' + result.filename + ' (' + result.blob.size + ' bytes)');
  console.log(result.repository ? 'Update repository: ' + result.repository : 'No update repository configured; this ZIP is unlinked.');
  console.log('SHA-256: ' + result.checksum);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error('Release failed: ' + error.message); process.exitCode = 1; });
}
