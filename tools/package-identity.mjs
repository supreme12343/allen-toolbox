import { OFFICIAL_REPOSITORY, isBetaManifest } from '../shared/update-meta.js';

export function assertPackageIdentity(bytes, identity) {
  const data = Buffer.from(bytes), manifests = [];
  let offset = 0;
  // Official release ZIPs use stored entries. Identity checks run after the raw
  // archive's signature/digest have been authenticated, not as an unzip engine.
  while (offset + 30 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
    const flags = data.readUInt16LE(offset + 6), method = data.readUInt16LE(offset + 8), size = data.readUInt32LE(offset + 18);
    const nameLength = data.readUInt16LE(offset + 26), extra = data.readUInt16LE(offset + 28), start = offset + 30 + nameLength + extra;
    if (flags & 9 || method !== 0 || start > data.length || size > data.length - start) throw new Error('Official archive identity cannot be read safely');
    const name = data.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (name === 'allen-toolbox/manifest.json') {
      if (size > 1024 * 1024) throw new Error('Official package manifest is oversized');
      manifests.push(JSON.parse(data.subarray(start, start + size).toString('utf8')));
    }
    offset = start + size;
  }
  if (manifests.length !== 1) throw new Error('Official package must contain exactly one root manifest');
  const manifest = manifests[0];
  if (manifest.version !== identity.version || isBetaManifest(manifest) !== identity.prerelease ||
      manifest.name !== 'ALLEN Toolbox' || manifest.homepage_url !== OFFICIAL_REPOSITORY) throw new Error('Signed package version/channel differs from its release identity');
  return manifest;
}
