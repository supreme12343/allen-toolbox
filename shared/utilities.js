const TRACKING = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl)$/i;

// Keep functional and signed parameters: only known tracking fields are removed.
export function cleanPageLink(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Open a normal website to copy its link.');
  const fields = url.search.slice(1).split('&').filter((field) => {
    let key = field.split('=', 1)[0];
    try { key = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { return true; }
    return !TRACKING.test(key);
  });
  url.search = fields.join('&');
  return url.href;
}

export function isAudioItem(item) {
  return item.kind === 'media' && (/^audio\//i.test(item.ct || '') || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i.test(item.url));
}

export function matchesMediaFilter(item, filter, query = '') {
  if (filter === 'pdf' && item.kind !== 'pdf') return false;
  if (filter === 'audio' && !isAudioItem(item)) return false;
  if (filter === 'video' && (item.kind === 'pdf' || isAudioItem(item))) return false;
  const text = [item.title, item.url, item.kind, item.ct].filter(Boolean).join(' ').toLowerCase();
  return text.includes(query.trim().toLowerCase());
}
