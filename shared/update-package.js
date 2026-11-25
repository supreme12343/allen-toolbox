import { EXTENSION_ASSETS } from './package.js';

export const UPDATE_REPOSITORY = 'https://github.com/supreme12343/allen-toolbox';
export const MAX_UPDATE_ZIP_BYTES = 64 * 1024 * 1024;
export const MAX_UPDATE_EXPANDED_BYTES = 96 * 1024 * 1024;
export const MAX_UPDATE_FILES = 300;
export const RECOVERY_BOOTSTRAP = Object.freeze(['popup/updater-recovery.html', 'popup/updater-recovery.js']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const EXTRA_FILES = new Set(['updater/public-key.json', 'updater/availability.json']);
const ROOTS = new Set(['content', 'gm', 'shared', 'popup', 'sandbox', 'icons', 'lib', 'plugins', 'scripts']);
const NATIVE = /\.(?:exe|dll|com|cmd|bat|ps1|psm1|psd1|msi|vbs|wsf|sys|scr)$/i;

function fail(code, message) {
  const error = new Error(message); error.code = code; throw error;
}

export function validateUpdateVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) fail('PACKAGE_INVALID', 'Invalid update version.');
  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) fail('PACKAGE_INVALID', 'Invalid update version.');
  return parts;
}

export function compareUpdateVersions(a, b) {
  const left = validateUpdateVersion(a), right = validateUpdateVersion(b);
  for (let i = 0; i < 4; i++) if ((left[i] || 0) !== (right[i] || 0)) return Math.sign((left[i] || 0) - (right[i] || 0));
  return 0;
}

export function validateUpdatePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || path !== path.normalize('NFC') ||
      /[\\<>:"|?*%#\x00-\x1f\x7f]/.test(path) || /[\uD800-\uDFFF]/u.test(path) ||
      path.split('/').some((part) => !part || part.length > 255 || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^\.git$/i.test(part) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part))) {
    fail('PACKAGE_PATH', 'The update contains an unsafe file path.');
  }
  return path;
}

function applicationPath(path, assets) {
  validateUpdatePath(path);
  if (NATIVE.test(path) || (!ROOTS.has(path.split('/')[0]) && !assets.includes(path))) fail('PACKAGE_PATH', 'The update contains a non-runtime or native file.');
  return path;
}

export function validateUpdateFilePath(path, { assets = EXTENSION_ASSETS } = {}) { return applicationPath(path, assets); }

function jsonFile(files, path, maximum = 512 * 1024) {
  const bytes = files.get(path);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum) fail('PACKAGE_INVALID', 'Required update metadata is missing or too large.');
  try { return JSON.parse(decoder.decode(bytes)); }
  catch (error) { fail('PACKAGE_INVALID', 'The update contains invalid JSON metadata.'); }
}

function relativeReference(path, reference, module = false) {
  if (!module && (reference.startsWith('#') || reference.startsWith('data:'))) return null;
  if (typeof reference !== 'string' || !reference || /[\\%?#\x00-\x20\x7f]/.test(reference) ||
      reference.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(reference) || (module && !/^\.\.?\//.test(reference))) {
    fail('PACKAGE_PATH', 'Runtime dependencies must be local extension files.');
  }
  const parts = path.split('/'); parts.pop();
  for (const part of reference.split('/')) {
    if (part === '.') continue;
    if (part === '..') { if (!parts.length) fail('PACKAGE_PATH', 'A runtime dependency escapes the extension folder.'); parts.pop(); }
    else { if (!part) fail('PACKAGE_PATH', 'Invalid runtime dependency path.'); parts.push(part); }
  }
  return validateUpdatePath(parts.join('/'));
}

function manifestPaths(manifest) {
  const paths = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_page,
    manifest.options_ui?.page, manifest.devtools_page, manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}), ...Object.values(typeof manifest.action?.default_icon === 'object' ? manifest.action.default_icon : {})];
  if (typeof manifest.action?.default_icon === 'string') paths.push(manifest.action.default_icon);
  if (manifest.content_scripts != null && !Array.isArray(manifest.content_scripts)) fail('PACKAGE_INVALID', 'Invalid manifest content scripts.');
  for (const script of manifest.content_scripts || []) {
    if (!script || (script.js != null && !Array.isArray(script.js)) || (script.css != null && !Array.isArray(script.css))) fail('PACKAGE_INVALID', 'Invalid manifest content scripts.');
    paths.push(...(script.js || []), ...(script.css || []));
  }
  if (manifest.sandbox?.pages != null && !Array.isArray(manifest.sandbox.pages)) fail('PACKAGE_INVALID', 'Invalid manifest sandbox.');
  paths.push(...(manifest.sandbox?.pages || []));
  for (const group of manifest.web_accessible_resources || []) {
    if (!Array.isArray(group?.resources)) fail('PACKAGE_INVALID', 'Invalid web-accessible resources.');
    for (const path of group.resources) if (typeof path === 'string' && !path.includes('*')) paths.push(path);
  }
  return paths.filter((path) => path != null).map(validateUpdatePath);
}

function javascriptMask(text) {
  const mask = new Uint8Array(text.length), comments = [], expression = new Set(['', '(', '[', '{', '=', ':', ',', ';', '!', '?', '&', '|', 'return', 'throw', 'case', '=>']);
  const quoted = (start, quote) => {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === quote) return i + 1;
    }
    return text.length;
  };
  const template = (start) => {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '`') return i + 1;
      if (text[i] === '$' && text[i + 1] === '{') { i = code(i + 2, true); continue; }
      i++;
    }
    return i;
  };
  const code = (start, nested = false) => {
    let depth = nested ? 1 : 0, prior = '', i = start;
    while (i < text.length) {
      const character = text[i];
      if (/\s/.test(character)) { mask[i++] = 1; continue; }
      if (character === '/' && text[i + 1] === '/') {
        const start = i, end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; comments.push([start, i]); continue;
      }
      if (character === '/' && text[i + 1] === '*') {
        const start = i, end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; comments.push([start, i]); continue;
      }
      if (character === '"' || character === "'") { i = quoted(i, character); prior = 'literal'; continue; }
      if (character === '`') { i = template(i); prior = 'literal'; continue; }
      if (character === '/' && expression.has(prior)) {
        let bracket = false; i++;
        while (i < text.length) {
          if (text[i] === '\\') { i += 2; continue; }
          if (text[i] === '[') bracket = true;
          if (text[i] === ']') bracket = false;
          if (text[i++] === '/' && !bracket) break;
        }
        while (/[a-z]/i.test(text[i] || '0')) i++;
        prior = 'literal'; continue;
      }
      if (/[a-z_$]/i.test(character)) {
        const begin = i++;
        while (/[a-z\d_$]/i.test(text[i] || '-')) i++;
        mask.fill(1, begin, i); prior = text.slice(begin, i); continue;
      }
      mask[i++] = 1;
      if (nested && character === '{') depth++;
      if (nested && character === '}' && --depth === 0) return i;
      prior = character;
    }
    return i;
  };
  code(0);
  const parts = []; let cursor = 0;
  for (const [start, end] of comments) { parts.push(text.slice(cursor, start), ' '.repeat(end - start)); cursor = end; }
  parts.push(text.slice(cursor));
  return { mask, source: parts.join('') };
}

/** Enumerate only declared runtime assets and local dependencies, never arbitrary folder contents. */
export function getUpdatePaths(files, { assets = EXTENSION_ASSETS } = {}) {
  const paths = new Set([...assets, 'scripts/scripts.json', 'shared/update-public-key.json', ...RECOVERY_BOOTSTRAP].map(validateUpdatePath));
  if (files.has('manifest.json')) for (const path of manifestPaths(jsonFile(files, 'manifest.json'))) paths.add(path);
  if (files.has('scripts/scripts.json')) {
    const index = jsonFile(files, 'scripts/scripts.json');
    if (!Array.isArray(index) || index.length > MAX_UPDATE_FILES) fail('PACKAGE_INVALID', 'Invalid bundled-script index.');
    const ids = new Set(), names = new Set();
    for (const entry of index) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 || entry.id.trim() !== entry.id ||
          /[\x00-\x1f\x7f]/.test(entry.id) || ids.has(entry.id) || typeof entry.enabled !== 'boolean') fail('PACKAGE_INVALID', 'Invalid bundled-script index.');
      const path = validateUpdatePath('scripts/' + validateUpdatePath(entry.file));
      if (!/\.user\.js$/i.test(path) || names.has(path.toLowerCase())) fail('PACKAGE_INVALID', 'Invalid bundled-script path.');
      ids.add(entry.id); names.add(path.toLowerCase()); paths.add(path);
      if (files.has(path) && files.get(path).byteLength > 6 * 1024 * 1024) fail('PACKAGE_LIMIT', 'A bundled script exceeds its size limit.');
    }
  }
  if (files.has('plugins/plugins.json')) {
    const plugins = jsonFile(files, 'plugins/plugins.json');
    if (!Array.isArray(plugins) || plugins.length > MAX_UPDATE_FILES) fail('PACKAGE_INVALID', 'Invalid plugin index.');
    const ids = new Set();
    for (const plugin of plugins) {
      if (!plugin || typeof plugin.id !== 'string' || !plugin.id || ids.has(plugin.id) || (!plugin.file && !plugin.css)) fail('PACKAGE_INVALID', 'Invalid plugin index.');
      ids.add(plugin.id);
      for (const [field, suffix] of [['file', /\.js$/i], ['css', /\.css$/i]]) {
        if (plugin[field] == null) continue;
        const path = validateUpdatePath(plugin[field]);
        if (!path.startsWith('plugins/') || !suffix.test(path)) fail('PACKAGE_PATH', 'Invalid plugin dependency path.');
        paths.add(path);
      }
    }
  }
  // This is a dependency inventory, not a JavaScript interpreter. Non-literal dynamic imports
  // still have to be covered by the explicit EXTENSION_ASSETS release inventory.
  for (const [path, bytes] of files) {
    if (path.startsWith('scripts/') || !/\.(?:js|mjs|html|css)$/i.test(path)) continue;
    let text;
    try { text = decoder.decode(bytes); } catch (error) { fail('PACKAGE_INVALID', 'A runtime text file is not valid UTF-8.'); }
    const add = (reference, module = false) => {
      let target;
      try { target = relativeReference(path, reference, module); }
      catch (error) { error.asset = path; error.reference = reference; throw error; }
      if (target) paths.add(target);
    };
    if (/\.(?:js|mjs)$/i.test(path)) {
      const { mask, source } = javascriptMask(text);
      const keyword = (index) => mask[index] && !/[\p{ID_Continue}.$]/u.test(source[index - 1] || ' ');
      const imports = /\b(?:import\s+(?:[^;'"`]*?\s+from\s*)?|export\s+[^;'"`]*?\s+from\s*)(['"])([^'"\r\n]+)\1/g;
      for (const match of source.matchAll(imports)) if (keyword(match.index)) add(match[2], true);
      for (const match of source.matchAll(/\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)) if (keyword(match.index)) add(match[2], true);
      for (const match of source.matchAll(/\bnew\s+URL\s*\(\s*(['"])([^'"\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)) if (mask[match.index]) add(match[2]);
    } else if (/\.html$/i.test(path)) {
      for (const match of text.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*?\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/gi)) add(match[2]);
    } else {
      for (const match of text.matchAll(/\burl\(\s*(['"]?)([^'"()\s]+)\1\s*\)/gi)) add(match[2]);
      for (const match of text.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) add(match[2]);
    }
  }
  if (paths.size > MAX_UPDATE_FILES) fail('PACKAGE_LIMIT', 'The runtime inventory exceeds 300 files.');
  for (const path of paths) applicationPath(path, assets);
  return paths;
}

export function validateUpdateFiles(files, { version, prerelease = false, assets = EXTENSION_ASSETS } = {}) {
  validateUpdateVersion(version);
  if (typeof prerelease !== 'boolean' || !(files instanceof Map)) fail('PACKAGE_INVALID', 'Invalid update package selection.');
  const manifest = jsonFile(files, 'manifest.json');
  if (!manifest || manifest.manifest_version !== 3 || manifest.name !== 'ALLEN Toolbox' || manifest.version !== version ||
      manifest.homepage_url !== UPDATE_REPOSITORY || Object.hasOwn(manifest, 'key') ||
      (manifest.version_name != null && (typeof manifest.version_name !== 'string' || manifest.version_name.length > 128 || /[\x00-\x1f\x7f]/.test(manifest.version_name))) ||
      /\bBETA\b/i.test(manifest.version_name || '') !== prerelease) fail('PACKAGE_MANIFEST', 'The signed package manifest does not match this extension and release.');
  const paths = getUpdatePaths(files, { assets });
  for (const path of paths) if (!files.has(path)) fail('PACKAGE_INCOMPLETE', 'The signed package is missing a required runtime file.');
  for (const path of files.keys()) if (!paths.has(applicationPath(path, assets))) fail('PACKAGE_PATH', 'The signed package contains an undeclared runtime file.');
  return { manifest, files, paths, version, prerelease };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extraFields(bytes, start, length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = start + length;
  while (start < end) {
    if (start + 4 > end) fail('PACKAGE_ZIP', 'Malformed ZIP extra fields.');
    const type = view.getUint16(start, true), size = view.getUint16(start + 2, true);
    if (start + 4 + size > end || [0x0001, 0x9901, 0x7075].includes(type)) fail('PACKAGE_ZIP', 'ZIP64, encrypted or aliased ZIP metadata is not supported.');
    start += 4 + size;
  }
}

async function inflate(bytes, size, Stream = globalThis.DecompressionStream) {
  let decompressor;
  try { decompressor = new Stream('deflate-raw'); }
  catch (error) { fail('DEFLATE_UNAVAILABLE', 'This browser cannot safely unpack DEFLATE updates. Use the manual ZIP update.'); }
  const reader = new Blob([bytes]).stream().pipeThrough(decompressor).getReader();
  const parts = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > size) fail('PACKAGE_LIMIT', 'A DEFLATE entry exceeds its declared size.');
      parts.push(value);
    }
    if (length !== size) fail('PACKAGE_ZIP', 'A DEFLATE entry has a mismatched size.');
    const result = new Uint8Array(length); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
  } catch (error) {
    try { await reader.cancel(); } catch (ignored) {}
    if (error.code) throw error;
    fail('PACKAGE_ZIP', 'The update contains invalid DEFLATE data.');
  } finally { reader.releaseLock(); }
}

/** ZIP32 reader written for the signed browser updater; no archive content is executed. */
export async function parseUpdatePackage(input, { version, prerelease = false, assets = EXTENSION_ASSETS,
  DecompressionStream: Stream = globalThis.DecompressionStream, inflateRaw } = {}) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.byteLength < 22 || bytes.byteLength > MAX_UPDATE_ZIP_BYTES) fail('PACKAGE_LIMIT', 'The update ZIP must be at most 64 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true), u32 = (offset) => view.getUint32(offset, true);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) fail('PACKAGE_ZIP', 'The ZIP end record is missing.');
  const count = u16(end + 10), start = u32(end + 16), centralSize = u32(end + 12);
  if (u16(end + 4) || u16(end + 6) || count !== u16(end + 8) || count === 0xffff || start === 0xffffffff || centralSize === 0xffffffff ||
      !count || count > MAX_UPDATE_FILES || start + centralSize !== end) fail('PACKAGE_ZIP', 'Split, ZIP64 or oversized ZIP directories are not supported.');
  const entries = [], aliases = new Map(), explicit = new Set();
  let cursor = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail('PACKAGE_ZIP', 'Malformed ZIP central directory.');
    const needed = u16(cursor + 6), flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16),
      compressed = u32(cursor + 20), size = u32(cursor + 24), nameSize = u16(cursor + 28), extraSize = u16(cursor + 30),
      commentSize = u16(cursor + 32), attributes = u32(cursor + 38), local = u32(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || !nameSize || nameSize > 1024 || needed > 20 || flags & ~0x080e || ![0, 8].includes(method) ||
        (method === 0 && flags & 6) || u16(cursor + 34) || [compressed, size, local].includes(0xffffffff)) fail('PACKAGE_ZIP', 'Unsupported or inconsistent ZIP entry.');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    if (!(flags & 0x0800) && rawName.some((byte) => byte > 127)) fail('PACKAGE_ZIP', 'Non-UTF-8 ZIP filenames are not supported.');
    let name;
    try { name = decoder.decode(rawName); } catch (error) { fail('PACKAGE_PATH', 'Invalid ZIP filename encoding.'); }
    const directory = name.endsWith('/'), path = validateUpdatePath(directory ? name.slice(0, -1) : name);
    const unixType = (attributes >>> 16) & 0xf000;
    if ((unixType && unixType !== (directory ? 0x4000 : 0x8000)) || (attributes & 0x400) ||
        (!directory && attributes & 0x10) || (directory && (size || crc))) fail('PACKAGE_ZIP', 'Symlinks, special files or mismatched ZIP entry types are forbidden.');
    const key = path.toLowerCase();
    if (explicit.has(key)) fail('PACKAGE_PATH', 'Duplicate or case-aliased ZIP filenames are forbidden.');
    explicit.add(key);
    const segments = path.split('/');
    for (let n = 1; n <= segments.length; n++) {
      const prefix = segments.slice(0, n).join('/'), alias = prefix.toLowerCase(), isFile = n === segments.length && !directory;
      const prior = aliases.get(alias);
      if (prior && (prior.path !== prefix || prior.file || isFile)) fail('PACKAGE_PATH', 'ZIP file/directory aliases are forbidden.');
      if (!prior) aliases.set(alias, { path: prefix, file: isFile });
    }
    if (method === 0 && compressed !== size) fail('PACKAGE_ZIP', 'A STORE entry has mismatched sizes.');
    expanded += size;
    if (expanded > MAX_UPDATE_EXPANDED_BYTES || compressed > MAX_UPDATE_ZIP_BYTES) fail('PACKAGE_LIMIT', 'The update exceeds its 96 MiB expanded limit.');
    extraFields(bytes, cursor + 46 + nameSize, extraSize);
    if (local + 30 > start || u32(local) !== 0x04034b50 || u16(local + 4) !== needed || u16(local + 6) !== flags || u16(local + 8) !== method ||
        u16(local + 10) !== u16(cursor + 12) || u16(local + 12) !== u16(cursor + 14) || u16(local + 26) !== nameSize) fail('PACKAGE_ZIP', 'Local and central ZIP headers do not agree.');
    const localExtra = u16(local + 28), dataStart = local + 30 + nameSize + localExtra;
    if (dataStart + compressed > start || rawName.some((byte, n) => bytes[local + 30 + n] !== byte)) fail('PACKAGE_ZIP', 'Local ZIP data or filename is inconsistent.');
    extraFields(bytes, local + 30 + nameSize, localExtra);
    let dataEnd = dataStart + compressed;
    if (flags & 8) {
      for (const [offset, expected] of [[14, crc], [18, compressed], [22, size]]) if (u32(local + offset) !== 0 && u32(local + offset) !== expected) fail('PACKAGE_ZIP', 'Inconsistent ZIP data descriptor.');
      const signedDescriptor = dataEnd + 16 <= start && u32(dataEnd) === 0x08074b50 && u32(dataEnd + 4) === crc &&
        u32(dataEnd + 8) === compressed && u32(dataEnd + 12) === size;
      const descriptor = dataEnd + (signedDescriptor ? 4 : 0);
      if (descriptor + 12 > start || u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) fail('PACKAGE_ZIP', 'Invalid ZIP data descriptor.');
      dataEnd = descriptor + 12;
    } else if (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size) fail('PACKAGE_ZIP', 'Local ZIP sizes or CRC do not agree.');
    const application = path.startsWith('allen-toolbox/');
    if (!application && !(directory && path === 'allen-toolbox') && !EXTRA_FILES.has(path) && !(directory && path === 'updater')) fail('PACKAGE_PATH', 'Unexpected top-level update file.');
    if (application && !directory) applicationPath(path.slice('allen-toolbox/'.length), assets);
    entries.push({ path, directory, application, method, crc, size, local, dataStart, dataEnd, compressed });
    cursor = next;
  }
  if (cursor !== end) fail('PACKAGE_ZIP', 'The ZIP directory size is inconsistent.');
  const ranges = [...entries].sort((a, b) => a.local - b.local);
  let frontier = 0;
  for (const entry of ranges) {
    if (entry.local !== frontier) fail('PACKAGE_ZIP', 'Overlapping, hidden or unreferenced ZIP data is forbidden.');
    frontier = entry.dataEnd;
  }
  if (frontier !== start) fail('PACKAGE_ZIP', 'The ZIP local area is inconsistent.');
  const files = new Map();
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
    const data = entry.method === 0 ? new Uint8Array(compressed) : inflateRaw ? await inflateRaw(compressed, entry.size) : await inflate(compressed, entry.size, Stream);
    if (!(data instanceof Uint8Array) || data.byteLength !== entry.size || crc32(data) !== entry.crc) fail('PACKAGE_CRC', 'The update contains corrupt file bytes.');
    if (entry.application && !entry.directory) files.set(entry.path.slice('allen-toolbox/'.length), data);
  }
  return validateUpdateFiles(files, { version, prerelease, assets });
}
