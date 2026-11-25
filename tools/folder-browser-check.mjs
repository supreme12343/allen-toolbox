import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXTENSION_ASSETS } from '../shared/package.js';
import { buildRelease } from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = Object.fromEntries(process.argv.slice(2).map((value) => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
if (!options['--playwright'] || !options['--browser'] || !options['--temp']) throw new Error('Supply --playwright, --browser and an isolated --temp parent');
const { chromium } = await import(pathToFileURL(options['--playwright']).href);
const directory = await mkdtemp(join(options['--temp'], 'allen-folder-browser-')), extension = join(directory, 'extension');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.version_name, manifest.version + ' BETA', 'Run this integration fixture only against the beta branch');
const scripts = JSON.parse(await readFile(join(root, 'scripts/scripts.json'), 'utf8'));
const sourcePaths = [...EXTENSION_ASSETS, 'scripts/scripts.json', ...scripts.map((value) => 'scripts/' + value.file)];
for (const path of sourcePaths) {
  let data = await readFile(join(root, path));
  if (path === 'background.js') {
    // Keep the production manager out of this isolated engine test's database.
    data = Buffer.from(data.toString().replace("isBetaManifest(chrome.runtime.getManifest()) ? { nativeUpdater: folderUpdater } : {}", 'false ? { nativeUpdater: folderUpdater } : {}'));
  }
  await mkdir(dirname(join(extension, path)), { recursive: true }); await writeFile(join(extension, path), data);
}
const pair = generateKeyPairSync('rsa', { modulusLength: 3072 }), jwk = pair.publicKey.export({ format: 'jwk' });
const key = { algorithm: 'RSA-SHA256', modulus: Buffer.from(jwk.n, 'base64url').toString('base64'), exponent: Buffer.from(jwk.e, 'base64url').toString('base64') };
const nextVersion = manifest.version.split('.').map(Number); nextVersion[nextVersion.length - 1]++;
const version = nextVersion.join('.');
const release = await buildRelease({ signingKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), readAsset: async (path) => {
  if (path === 'manifest.json') return JSON.stringify({ ...manifest, version, version_name: version + ' BETA' });
  if (path === 'package.json') return JSON.stringify({ version });
  if (['updater/public-key.json', 'shared/update-public-key.json'].includes(path)) return JSON.stringify(key);
  return readFile(join(root, path));
} });
const zip = Array.from(new Uint8Array(await release.blob.arrayBuffer())), signature = Array.from(release.signature);
const repo = 'https://github.com/supreme12343/allen-toolbox';
const selected = { version, tag: release.tag, filename: release.filename, prerelease: true,
  downloadUrl: repo + '/releases/download/' + release.tag + '/' + release.filename,
  signatureUrl: repo + '/releases/download/' + release.tag + '/' + release.filename + '.sig' };
const context = await chromium.launchPersistentContext(join(directory, 'profile'), { executablePath: options['--browser'], headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  const page = await context.newPage(); await page.goto('chrome-extension://' + id + '/popup/updater.html');
  const result = await page.evaluate(async ({ sourcePaths, key, zip, signature, selected, version }) => {
    const { createFolderUpdater } = await import('../shared/folder-updater.js');
    const parent = await navigator.storage.getDirectory(), folder = await parent.getDirectoryHandle('beta-engine-fixture', { create: true });
    async function entry(path, create = false) {
      const parts = path.split('/'), name = parts.pop(); let directory = folder;
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
      return directory.getFileHandle(name, { create });
    }
    for (const path of sourcePaths) {
      const data = path === 'shared/update-public-key.json' ? new TextEncoder().encode(JSON.stringify(key)) : new Uint8Array(await (await fetch(chrome.runtime.getURL(path))).arrayBuffer());
      const writer = await (await entry(path, true)).createWritable(); await writer.write(data); await writer.close();
    }
    let tamper = true;
    async function fixtureFetch(url, options = {}) {
      let body;
      if (url.startsWith(chrome.runtime.getURL(''))) body = await (await (await entry(decodeURIComponent(new URL(url).pathname.slice(1)))).getFile()).arrayBuffer();
      else if (url === selected.downloadUrl) body = new Uint8Array(zip);
      else if (url === selected.signatureUrl) { body = new Uint8Array(signature); if (tamper) body[0] ^= 1; }
      else throw new Error('Unexpected fixture network URL');
      const response = new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
      Object.defineProperty(response, 'url', { value: url });
      if (!url.startsWith(chrome.runtime.getURL('')) && options.credentials !== 'omit') throw new Error('Update credentials were not omitted');
      return response;
    }
    const engine = createFolderUpdater({ chrome, fetch: fixtureFetch, crypto, indexedDB, locks: navigator.locks });
    const connected = await engine.connectFolder(folder, { singleProfileAcknowledged: true, automatic: false });
    if (!connected.connected || connected.autoInstall) throw new Error('OPFS fixture did not connect with automatic writes off: ' + JSON.stringify({ status: connected,
      permissionApi: typeof folder.queryPermission, permission: folder.queryPermission ? await folder.queryPermission({ mode: 'readwrite' }) : 'unavailable' }));
    const restored = await createFolderUpdater({ chrome, fetch: fixtureFetch, crypto, indexedDB, locks: navigator.locks }).getFolderUpdateState();
    if (!restored.connected) throw new Error('IndexedDB did not preserve the real directory handle');
    const denied = await engine.applyFolderRelease(selected);
    if (!denied.error) throw new Error('Tampered signature was accepted');
    const before = JSON.parse(await (await (await entry('manifest.json')).getFile()).text());
    if (before.version === version) throw new Error('Rejected signature changed the folder');
    tamper = false;
    const applied = await engine.applyFolderRelease(selected);
    const after = JSON.parse(await (await (await entry('manifest.json')).getFile()).text());
    if (applied.state !== 'updated' || after.version !== version || !applied.requiresReload) throw new Error('Verified OPFS update was not committed');
    const ownManifest = await (await fetch(chrome.runtime.getURL('manifest.json'))).json();
    if (ownManifest.version === version) throw new Error('Fixture modified the real loaded extension instead of OPFS');
    return { realBrowserApis: true, directoryHandlePersisted: true, tamperedSignatureRejected: true, verifiedFilesWritten: true,
      manifestLastVerified: after.version, externalFolderPermissionTested: false, actualExtensionUntouched: true };
  }, { sourcePaths, key, zip, signature, selected, version });
  console.log(JSON.stringify(result));
  console.log('PASS: real Chrome OPFS/IndexedDB/WebCrypto integration. This does NOT test the native directory-picker grant. Artifacts: ' + directory);
} finally { await context.close(); }
