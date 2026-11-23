const encoder = new TextEncoder();
const ZIP32_SENTINEL = 0xffffffff;
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function validateZipPath(path) {
  if (typeof path !== 'string' || !path || /[\\<>:"|?*%#\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe relative file path: ' + String(path));
  }
  return path;
}

function zip32(value, label) {
  // All-ones fields are ZIP64 markers, which this STORE-only writer does not emit.
  if (!Number.isSafeInteger(value) || value < 0 || value >= ZIP32_SENTINEL) throw new Error(label + ' exceeds the ZIP32 size limit');
  return value;
}

/** Build a standard, uncompressed ZIP without executing or interpreting any file contents. */
export async function createZip(entries) {
  if (!Array.isArray(entries) || entries.length >= 0xffff) throw new Error('ZIP32 supports fewer than 65535 entries');
  const seen = new Set(), names = [];
  for (const entry of entries) {
    const path = validateZipPath(entry?.path), key = path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate ZIP path: ' + path);
    seen.add(key);
    const name = encoder.encode(path);
    if (name.length > 0xffff) throw new Error('ZIP filename exceeds 65535 UTF-8 bytes');
    names.push(name);
  }

  const localParts = [], centralParts = [];
  let offset = 0, centralSize = 0;
  for (let i = 0; i < entries.length; i++) {
    const { data } = entries[i], name = names[i];
    let bytes;
    if (typeof data === 'string') bytes = encoder.encode(data);
    else if (data instanceof Uint8Array) { zip32(data.byteLength, 'File'); bytes = new Uint8Array(data); }
    else if (data instanceof Blob) { zip32(data.size, 'File'); bytes = new Uint8Array(await data.arrayBuffer()); }
    else throw new Error('ZIP file data must be text, Uint8Array, or Blob: ' + entries[i].path);
    const size = zip32(bytes.byteLength, 'File'), crc = crc32(bytes);
    const nextOffset = zip32(offset + 30 + name.length + size, 'Local file area');
    centralSize = zip32(centralSize + 46 + name.length, 'Central directory');

    const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); // UTF-8 filenames, known CRC/sizes, no data descriptor.
    l.setUint16(8, 0, true); // STORE
    l.setUint16(12, 33, true); // 1980-01-01, deterministic archive timestamps.
    l.setUint32(14, crc, true);
    l.setUint32(18, size, true);
    l.setUint32(22, size, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, bytes);

    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(14, 33, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset = nextOffset;
  }

  zip32(offset + centralSize + 22, 'Archive');
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}
