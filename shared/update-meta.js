export const OFFICIAL_REPOSITORY = 'https://github.com/supreme12343/allen-toolbox';

export function githubRepository(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const match = /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})\/?$/i.exec(value);
  const repo = match?.[2].replace(/\.git$/i, '');
  if (!match || !repo || repo === '.' || repo === '..') throw new Error('Use a public repository URL: https://github.com/OWNER/REPO');
  return 'https://github.com/' + match[1] + '/' + repo;
}

export function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value)) throw new Error('Invalid extension version');
  const parts = value.split('.').map(Number);
  if (parts.some((n) => n > 65535) || parts.every((n) => n === 0)) throw new Error('Invalid extension version');
  return parts;
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 4; i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function releaseIdentity(version, prerelease = false, versionName = '') {
  versionParts(version);
  if (typeof prerelease !== 'boolean') throw new Error('Invalid release channel');
  const display = versionName || version + (prerelease ? ' BETA' : '');
  if (typeof display !== 'string' || display.length > 100 || display !== version && !display.startsWith(version + ' ') ||
      !/^[A-Za-z0-9 ._-]+$/.test(display) || prerelease && display !== version + ' BETA' || !prerelease && /\bBETA$/i.test(display)) throw new Error('Invalid release display name');
  return { version, versionName: display, prerelease, tag: 'v' + version + (prerelease ? '-beta' : ''),
    filename: 'ALLEN-Toolbox-' + version + (prerelease ? '-BETA' : '') + '.zip',
    title: 'ALLEN Toolbox ' + display };
}

export function isBetaManifest(manifest) { return manifest?.version_name === manifest?.version + ' BETA'; }

export function isNewerRelease(release, manifest) {
  const difference = compareVersions(release.version, manifest.version);
  return difference > 0 || difference === 0 && isBetaManifest(manifest) && !release.prerelease;
}

export function githubRelease(data, repository, { allowPrerelease = false } = {}) {
  const repo = githubRepository(repository);
  if (!repo || !data || data.draft !== false || typeof data.prerelease !== 'boolean' || data.prerelease && !allowPrerelease || typeof data.tag_name !== 'string') throw new Error('GitHub returned invalid release metadata');
  const match = /^v((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3})(-beta)?$/.exec(data.tag_name);
  if (!match || Boolean(match[2]) !== data.prerelease) throw new Error('GitHub returned an invalid release tag or channel');
  const { version, tag, filename } = releaseIdentity(match[1], data.prerelease);
  const url = repo + '/releases/tag/' + tag;
  if (typeof data.html_url !== 'string' || data.html_url.toLowerCase() !== url.toLowerCase()) throw new Error('The release does not belong to the official repository');
  const asset = Array.isArray(data.assets) ? data.assets.find((a) => a?.name === filename && a.state === 'uploaded') : null;
  const downloadUrl = repo + '/releases/download/' + tag + '/' + filename;
  if (asset && (typeof asset.browser_download_url !== 'string' || asset.browser_download_url.toLowerCase() !== downloadUrl.toLowerCase() ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0)) throw new Error('The release ZIP has an invalid download URL or size');
  const signature = Array.isArray(data.assets) ? data.assets.find((a) => a?.name === filename + '.sig' && a.state === 'uploaded') : null;
  const signatureUrl = repo + '/releases/download/' + tag + '/' + filename + '.sig';
  if (signature && (signature.browser_download_url !== signatureUrl || !Number.isSafeInteger(signature.size) || signature.size <= 0 || signature.size > 8192)) throw new Error('The release signature has an invalid URL or size');
  return { version, tag, url, filename, downloadUrl: asset ? asset.browser_download_url : '', size: asset?.size || 0,
    prerelease: data.prerelease, signatureUrl: signature ? signatureUrl : '', signatureSize: signature?.size || 0 };
}

export function selectGithubRelease(data, repository, options = {}) {
  if (!Array.isArray(data)) return githubRelease(data, repository, options);
  let latest = null;
  for (const item of data) {
    let candidate;
    try { candidate = githubRelease(item, repository, options); } catch (error) { continue; }
    if (!latest || compareVersions(candidate.version, latest.version) > 0 || compareVersions(candidate.version, latest.version) === 0 && !candidate.prerelease && latest.prerelease) latest = candidate;
  }
  if (!latest) throw new Error('No compatible official release was found for this update channel');
  return latest;
}
