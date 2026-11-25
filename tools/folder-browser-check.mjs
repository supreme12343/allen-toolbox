import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXTENSION_ASSETS } from '../shared/package.js';
import { buildRelease } from './release.mjs';
import { isBetaManifest } from '../shared/update-meta.js';
import { parseUpdatePackage } from '../shared/update-package.js';
import { verifyUpdate } from './update-signing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = Object.fromEntries(process.argv.slice(2).map((value) => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
if (!options['--playwright'] || !options['--browser'] || !options['--temp']) throw new Error('Supply --playwright, --browser and an isolated --temp parent');
const { chromium } = await import(pathToFileURL(options['--playwright']).href);
const directory = await mkdtemp(join(options['--temp'], 'allen-folder-browser-')), extension = join(directory, 'extension');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const beta = isBetaManifest(manifest);
const scripts = JSON.parse(await readFile(join(root, 'scripts/scripts.json'), 'utf8'));
let baseline = null;
if (options['--from-beta'] === '2.3.2') {
  const url = 'https://github.com/supreme12343/allen-toolbox/releases/download/v2.3.2-beta/ALLEN-Toolbox-2.3.2-BETA.zip';
  const [archive, signature] = await Promise.all([url, url + '.sig'].map(async (url) => {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, 'The signed baseline fixture could not be downloaded'); return new Uint8Array(await response.arrayBuffer());
  }));
  assert.equal(verifyUpdate(archive, signature, JSON.parse(await readFile(join(root, 'updater/public-key.json'), 'utf8'))), true);
  baseline = await parseUpdatePackage(archive, { version: '2.3.2', prerelease: true });
}
const sourcePaths = baseline ? [...baseline.files.keys()] : [...EXTENSION_ASSETS, 'scripts/scripts.json', ...scripts.map((value) => 'scripts/' + value.file)];
for (const path of sourcePaths) {
  let data = baseline ? Buffer.from(baseline.files.get(path)) : await readFile(join(root, path));
  if (path === 'background.js') {
    // Keep the production manager out of this isolated engine test's database.
    const replacement = "nativeUpdater: { async status() { return { kind: 'folder', connected: false, initialized: true }; }, async refresh() { return { kind: 'folder', connected: false, initialized: true }; }, isApplying() { return false; } }";
    const source = data.toString();
    const expression = baseline ? "isBetaManifest(chrome.runtime.getManifest()) ? { nativeUpdater: folderUpdater } : {}" : 'nativeUpdater: folderUpdater';
    assert.ok(source.includes(expression), 'The fixture must disable only its production folder backend');
    data = Buffer.from(source.replace(expression, baseline ? '{ ' + replacement + ' }' : replacement));
  }
  await mkdir(dirname(join(extension, path)), { recursive: true }); await writeFile(join(extension, path), data);
}
const pair = generateKeyPairSync('rsa', { modulusLength: 3072 }), jwk = pair.publicKey.export({ format: 'jwk' });
const key = { algorithm: 'RSA-SHA256', modulus: Buffer.from(jwk.n, 'base64url').toString('base64'), exponent: Buffer.from(jwk.e, 'base64url').toString('base64') };
const nextVersion = manifest.version.split('.').map(Number); if (!baseline) nextVersion[nextVersion.length - 1]++;
const version = nextVersion.join('.');
const release = await buildRelease({ signingKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), readAsset: async (path) => {
  if (path === 'manifest.json') return JSON.stringify({ ...manifest, version, version_name: beta ? version + ' BETA' : version + (manifest.version_name || '').slice(manifest.version.length) });
  if (path === 'package.json') return JSON.stringify({ version });
  if (['updater/public-key.json', 'shared/update-public-key.json'].includes(path)) return JSON.stringify(key);
  return readFile(join(root, path));
} });
const zip = Array.from(new Uint8Array(await release.blob.arrayBuffer())), signature = Array.from(release.signature);
const repo = 'https://github.com/supreme12343/allen-toolbox';
const selected = { version, tag: release.tag, filename: release.filename, prerelease: release.prerelease,
  downloadUrl: repo + '/releases/download/' + release.tag + '/' + release.filename,
  signatureUrl: repo + '/releases/download/' + release.tag + '/' + release.filename + '.sig' };
async function launch() {
  const context = await chromium.launchPersistentContext(join(directory, 'profile'), { executablePath: options['--browser'], headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  return { context, id };
}
let { context, id } = await launch();
try {
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
    const optedIn = await engine.setFolderAutomatic(true);
    if (!optedIn.autoInstall) throw new Error('The explicit automatic-install choice was not saved');
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
  await context.close();
  ({ context, id } = await launch());
  const restarted = await context.newPage(); await restarted.goto('chrome-extension://' + id + '/popup/updater.html');
  const persistence = await restarted.evaluate(async () => {
    const { createFolderUpdater } = await import('../shared/folder-updater.js');
    const state = await createFolderUpdater({ chrome, fetch: globalThis.fetch, crypto, indexedDB, locks: navigator.locks }).getFolderUpdateState();
    if (!state.connected || !state.autoInstall || state.permission !== 'granted' || state.recoveryPending) throw new Error('The saved folder or opt-in was lost after browser-profile restart: ' + JSON.stringify(state));
    return { folderRememberedAfterBrowserRestart: true, automaticPreferenceRemembered: true, permissionGrantedForOpfs: true };
  });
  Object.assign(result, persistence);
  console.log(JSON.stringify(result));
  console.log('PASS: real Chrome OPFS/IndexedDB/WebCrypto integration and browser-profile restart' + (baseline ? ' using the published 2.3.2 BETA engine.' : '.') + ' This does NOT test the native directory-picker grant. Artifacts: ' + directory);
} finally { await context.close(); }
