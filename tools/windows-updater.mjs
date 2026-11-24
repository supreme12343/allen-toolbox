import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_UPDATER_FILES = Object.freeze(['Install-ALLEN-Toolbox.cmd', 'updater/install.ps1', 'updater/updater.ps1', 'updater/public-key.json', 'updater/ALLEN-Toolbox-NativeHost.exe']);
export const WINDOWS_UPDATER_UNAVAILABLE = Object.freeze({ protocol: 2, available: false, reason: 'trusted-windows-signing-not-configured', publisherThumbprint: '', files: {} });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readBounded(path, limit) {
  const file = await open(path, 'r');
  try {
    const details = await file.stat();
    if (!details.isFile() || details.size > limit) throw new Error('Signed helper file exceeds its package limit');
    const bytes = Buffer.alloc(details.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== details.size) throw new Error('Signed helper file changed while reading');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

export async function verifyWindowsUpdater(directory) {
  if (process.platform !== 'win32') throw new Error('Executable helper packaging must be verified on Windows');
  const verifier = fileURLToPath(new URL('./verify-windows-updater.ps1', import.meta.url));
  const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', verifier, '-Directory', directory],
    { windowsHide: false, timeout: 60000, encoding: 'utf8', maxBuffer: 65536 });
  const result = JSON.parse(stdout.trim());
  if (result.protocol !== 2 || result.verified !== true || !/^[a-f\d]{40}$/i.test(result.publisherThumbprint || '')) throw new Error('Windows did not verify the helper publisher');
  if (!result.files || Object.keys(result.files).length !== WINDOWS_UPDATER_FILES.length) throw new Error('Windows did not bind signatures to the staged file hashes');
  return { ...result, publisherThumbprint: result.publisherThumbprint.toUpperCase() };
}

export async function loadWindowsUpdater({ directory = '', read = readBounded, resolvePath = realpath, info = stat, verify = verifyWindowsUpdater, pinnedPublicKey, trustedLauncher } = {}) {
  if (!directory) return { metadata: WINDOWS_UPDATER_UNAVAILABLE, files: [] };
  const root = await resolvePath(directory);
  const inside = async (path) => {
    const full = await resolvePath(resolve(root, path)), local = relative(root, full);
    if (local.startsWith('..') || isAbsolute(local)) throw new Error('Signed helper file escapes its staging directory');
    const limit = path === 'availability.json' ? 16384 : 16 * 1024 * 1024;
    const details = await info(full);
    if (!details.isFile() || details.size > limit) throw new Error('Signed helper file exceeds its package limit');
    const data = await read(full, limit);
    if (data.length > limit || data.length !== details.size) throw new Error('Signed helper file changed or exceeded its package limit');
    return data;
  };
  const source = await inside('availability.json');
  if (source.length > 16384) throw new Error('Signed helper metadata exceeds its limit');
  const metadata = JSON.parse(source.toString('utf8').replace(/^\uFEFF/, ''));
  if (metadata.protocol !== 2 || typeof metadata.available !== 'boolean') throw new Error('Invalid signed helper availability metadata');
  if (!metadata.available) return { metadata: WINDOWS_UPDATER_UNAVAILABLE, files: [] };
  if (!/^[a-f\d]{40}$/i.test(metadata.publisherThumbprint || '') || !metadata.files ||
      Object.keys(metadata.files).length !== WINDOWS_UPDATER_FILES.length) throw new Error('Invalid signed helper publisher or inventory');
  if (typeof trustedLauncher !== 'string' && !(trustedLauncher instanceof Uint8Array)) throw new Error('Signed helper packaging requires the trusted source launcher');
  const proof = await verify(root);
  const publisher = proof?.publisherThumbprint;
  if (typeof publisher !== 'string' || publisher.toUpperCase() !== metadata.publisherThumbprint.toUpperCase()) throw new Error('Signed helper publisher differs from its metadata');
  const files = [];
  for (const path of WINDOWS_UPDATER_FILES) {
    const data = await inside(path);
    if (metadata.files[path] !== hash(data) || proof.files?.[path] !== hash(data)) throw new Error('Signed helper bytes differ from the verified inventory: ' + path);
    files.push({ path, data });
  }
  const launcher = files.find((file) => file.path === 'Install-ALLEN-Toolbox.cmd').data;
  if (!Buffer.from(launcher).equals(Buffer.from(trustedLauncher))) throw new Error('Staged launcher differs from the trusted project source');
  const key = JSON.parse(files.find((file) => file.path === 'updater/public-key.json').data.toString('utf8').replace(/^\uFEFF/, ''));
  if (!pinnedPublicKey || key.algorithm !== pinnedPublicKey.algorithm || key.modulus !== pinnedPublicKey.modulus || key.exponent !== pinnedPublicKey.exponent) throw new Error('Signed helper cannot replace the pinned update verification key');
  return { metadata: { protocol: 2, available: true, reason: '', publisherThumbprint: publisher.toUpperCase(), files: metadata.files }, files };
}
