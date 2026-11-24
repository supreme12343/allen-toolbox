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

export function githubRelease(data, repository) {
  const repo = githubRepository(repository);
  if (!repo || !data || data.draft !== false || data.prerelease !== false || typeof data.tag_name !== 'string') throw new Error('GitHub returned invalid release metadata');
  const tag = data.tag_name, version = tag.replace(/^v/, '');
  versionParts(version);
  const url = repo + '/releases/tag/' + tag;
  if (typeof data.html_url !== 'string' || data.html_url.toLowerCase() !== url.toLowerCase()) throw new Error('The release does not belong to the official repository');
  const filename = 'ALLEN-Toolbox-' + version + '.zip';
  const asset = Array.isArray(data.assets) ? data.assets.find((a) => a?.name === filename && a.state === 'uploaded') : null;
  const downloadUrl = repo + '/releases/download/' + tag + '/' + filename;
  if (asset && (typeof asset.browser_download_url !== 'string' || asset.browser_download_url.toLowerCase() !== downloadUrl.toLowerCase() ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0)) throw new Error('The release ZIP has an invalid download URL or size');
  return { version, tag, url, filename, downloadUrl: asset ? asset.browser_download_url : '', size: asset?.size || 0 };
}
