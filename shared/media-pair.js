// Positive identification only: progressive (already muxed) formats are not in these lists.
const MP4_VIDEO = new Set('133 134 135 136 137 138 160 212 264 266 298 299 394 395 396 397 398 399 400 401 402 571'.split(' '));
const WEBM_VIDEO = new Set('242 243 244 245 246 247 248 271 272 278 302 303 308 313 315 330 331 332 333 334 335 336 337'.split(' '));
const MP4_AUDIO = new Set(['139', '140', '141']);
const WEBM_AUDIO = new Set(['171', '172', '249', '250', '251']);
const mime = (value) => (value || '').split(';')[0].trim().toLowerCase();

export function youtubeTrack(item) {
  if (item?.kind !== 'media' || !item.scope || !Number.isInteger(item.tabId) || !Number.isInteger(item.frameId)) return null;
  let url, page;
  try { url = new URL(item.url); page = new URL(item.pageHref); } catch (err) { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !/(^|\.)googlevideo\.com$/.test(url.hostname) || url.pathname !== '/videoplayback') return null;
  if (page.protocol !== 'https:' || !/(^|\.)youtube(?:-nocookie)?\.com$/.test(page.hostname)) return null;
  const p = url.searchParams, itag = p.get('itag'), id = p.get('id');
  if (!id || p.getAll('id').length !== 1 || p.getAll('itag').length !== 1 ||
      (p.has('source') && p.get('source') !== 'youtube') || p.get('live') === '1' || p.get('otfp') === '1' || p.has('sq')) return null;

  const role = MP4_VIDEO.has(itag) || WEBM_VIDEO.has(itag) ? 'video' : MP4_AUDIO.has(itag) || WEBM_AUDIO.has(itag) ? 'audio' : '';
  if (!role) return null;
  const container = MP4_VIDEO.has(itag) || MP4_AUDIO.has(itag) ? 'mp4' : 'webm';
  const type = role + '/' + container;
  if ([mime(item.ct), mime(p.get('mime'))].some((ct) => ct && ct !== 'application/octet-stream' && ct !== type)) return null;
  const length = Number(p.get('clen'));
  return {
    key: JSON.stringify([item.tabId, item.frameId, item.documentId || '', item.scope, id]), role, container,
    length: Number.isSafeInteger(length) && length > 0 ? length : 0,
    expires: Number(p.get('expire')) || 0,
    rangeRank: !p.has('range') ? 2 : /^0-/.test(p.get('range')) ? 1 : 0,
  };
}

export function matchingYoutubeTracks(video, audio, now = Date.now()) {
  const v = youtubeTrack(video), a = youtubeTrack(audio);
  return v?.role === 'video' && a?.role === 'audio' && v.key === a.key &&
    [v, a].every((t) => !t.expires || t.expires * 1000 > now) ? { video: v, audio: a } : null;
}

export function youtubeAudioPairs(items, now = Date.now()) {
  const pairs = new Map(), groups = new Map(), videos = [];
  for (const item of items) {
    const track = youtubeTrack(item);
    if (!track || (track.expires && track.expires * 1000 <= now)) continue;
    if (track.role === 'video') { videos.push({ item, track }); continue; }
    const key = track.key + track.container, previous = groups.get(key);
    if (!previous || track.rangeRank > previous.track.rangeRank || (track.rangeRank === previous.track.rangeRank && item.ts > previous.item.ts)) {
      groups.set(key, { item, track });
    }
  }
  for (const { item, track } of videos) {
    const same = groups.get(track.key + track.container), alternate = groups.get(track.key + (track.container === 'mp4' ? 'webm' : 'mp4'));
    const audio = same && (!alternate || same.track.rangeRank >= alternate.track.rangeRank) ? same : alternate;
    if (audio) pairs.set(item.id, { id: audio.item.id, origin: new URL(audio.item.url).origin });
  }
  return pairs;
}
