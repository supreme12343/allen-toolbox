import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { versionParts } from '../shared/updates.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path); else files.push(path);
  }
}
await walk(root);
let failures = 0;
function fail(message) { failures++; console.error(message); }
async function requireAsset(path, source) {
  const target = resolve(path);
  if (relative(root, target).startsWith('..')) { fail('Asset escapes extension: ' + source); return; }
  try { await access(target); } catch { fail('Missing asset: ' + relative(root, target) + ' (' + source + ')'); }
}
for (const path of files) {
  if (/\.(js|mjs)$/.test(path)) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) fail(relative(root, path) + '\n' + result.stderr);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) await requireAsset(resolve(dirname(path), match[1]), relative(root, path));
  }
  if (path.endsWith('.json')) {
    try { JSON.parse(await readFile(path, 'utf8')); } catch (error) { fail(relative(root, path) + ': ' + error.message); }
  }
  if (path.endsWith('.html')) {
    const source = await readFile(path, 'utf8'), ids = new Set();
    for (const match of source.matchAll(/\bid="([^"]+)"/g)) {
      if (ids.has(match[1])) fail('Duplicate HTML id ' + match[1] + ' in ' + relative(root, path));
      ids.add(match[1]);
    }
    for (const match of source.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:|data:|#)/.test(match[1])) continue;
      await requireAsset(resolve(dirname(path), match[1].split(/[?#]/)[0]), relative(root, path));
    }
  }
}
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) fail('package.json and manifest.json versions must match.');
try { versionParts(manifest.version); } catch (error) { fail(error.message); }
for (const asset of new Set([
  ...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {}),
  manifest.action.default_popup, manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((script) => [...(script.js || []), ...(script.css || [])]),
  ...(manifest.sandbox.pages || []),
])) await requireAsset(resolve(root, asset), 'manifest.json');
if (manifest.manifest_version !== 3) fail('Manifest must use version 3.');
if (failures) process.exitCode = 1;
else console.log('Checked ' + files.length + ' files: JavaScript syntax, JSON, HTML IDs, imports and manifest assets are valid.');
