// Minimal, strict HLS playlist parser (RFC 8216) — enough for VOD recordings.

export function parseAttrs(s) {
  const o = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}

function parseRange(spec, prevEnd) {
  if (!spec) return null;
  const m = /^(\d+)(?:@(\d+))?$/.exec(spec);
  if (!m) throw new Error('Invalid HLS byte range');
  const length = Number(m[1]), offset = m[2] === undefined ? prevEnd : Number(m[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) {
    throw new Error('An HLS byte range is missing a valid length or offset');
  }
  return { offset, length, end: offset + length };
}

export function parseM3U8(text, baseUrl) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
  const abs = (u) => {
    if (!u) throw new Error('The playlist is missing a resource URI');
    const url = new URL(u, baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only HTTP(S) HLS resources are supported');
    url.hash = '';
    return url.href;
  };
  const readKey = (s) => {
    const a = parseAttrs(s);
    return a.METHOD === 'NONE' ? null : {
      method: a.METHOD, uri: a.URI ? abs(a.URI) : null, iv: a.IV || null,
      keyformat: a.KEYFORMAT || 'identity', versions: a.KEYFORMATVERSIONS || '1',
    };
  };

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:')) ||
      (!lines.some((l) => l.startsWith('#EXTINF:')) && lines.some((l) => l.startsWith('#EXT-X-MEDIA:')))) {
    const variants = [], media = [], keys = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (lines[j]) {
          const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
          variants.push({
            url: abs(lines[j]),
            bandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || '0', 10),
            width: res ? +res[1] : 0, height: res ? +res[2] : 0,
            codecs: a.CODECS || '', audioGroup: a.AUDIO || '',
          });
        }
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        media.push({
          type: a.TYPE, group: a['GROUP-ID'], name: a.NAME || '', lang: a.LANGUAGE || '',
          default: a.DEFAULT === 'YES', url: a.URI ? abs(a.URI) : null,
        });
      } else if (l.startsWith('#EXT-X-SESSION-KEY:')) keys.push(readKey(l.slice(19)));
    }
    return { master: true, variants, media, keys };
  }

  const segments = [];
  let seq = 0, key = null, map = null, dur = 0, brSpec = null, endlist = false, vod = false, target = 0;
  let discontinuity = false, gap = false, skipped = false;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(l.slice(22));
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid HLS media sequence');
    }
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = parseInt(l.split(':')[1], 10) || 0;
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) vod = /VOD/.test(l);
    else if (l.startsWith('#EXT-X-ENDLIST')) endlist = true;
    else if (l.startsWith('#EXT-X-KEY:')) {
      key = readKey(l.slice(11));
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      map = { url: abs(a.URI), range: parseRange(a.BYTERANGE, 0), key };
    } else if (l.startsWith('#EXTINF:')) {
      dur = Number(l.slice(8).split(',')[0]);
      if (!Number.isFinite(dur) || dur <= 0) throw new Error('Invalid HLS segment duration');
    }
    else if (l.startsWith('#EXT-X-BYTERANGE:')) brSpec = l.slice(17);
    else if (l === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (l === '#EXT-X-GAP') gap = true;
    else if (l.startsWith('#EXT-X-SKIP:')) skipped = true;
    else if (!l.startsWith('#')) {
      const url = abs(l), previous = segments[segments.length - 1];
      const range = parseRange(brSpec, previous && previous.url === url && previous.range ? previous.range.end : undefined);
      if (!Number.isSafeInteger(seq + segments.length)) throw new Error('Invalid HLS media sequence');
      segments.push({ url, dur, key, map, seq: seq + segments.length, range, discontinuity, gap });
      dur = 0; brSpec = null; discontinuity = false; gap = false;
    }
  }
  return { master: false, segments, map: segments[0]?.map || null, endlist, vod, target, skipped,
    duration: segments.reduce((s, x) => s + x.dur, 0) };
}

function validateKey(k, init = false) {
  if (!k) return;
  if (k.method !== 'AES-128') throw new Error('This stream uses ' + (k.method || 'unknown') + ' protection, which is not supported');
  if (k.keyformat !== 'identity' || k.versions !== '1') throw new Error('This stream uses DRM or an unsupported key format');
  if (!k.uri) throw new Error('The AES-128 stream is missing its decryption key URI');
  if (k.iv && !/^0x[0-9a-f]{1,32}$/i.test(k.iv)) throw new Error('The AES-128 stream has an invalid 128-bit IV');
  if (init && !k.iv) throw new Error('An encrypted HLS initialization map requires an explicit IV');
}

/** Throws a user-readable error for anything we will not (or cannot) download. */
export function assertDownloadable(pl) {
  for (const k of pl.keys || []) validateKey(k);
  if (pl.master) return;
  if (!pl.segments.length) throw new Error('The playlist has no segments');
  if (!pl.endlist) throw new Error('Only finished recordings with EXT-X-ENDLIST are supported, not live or unfinished streams');
  if (pl.skipped) throw new Error('An incomplete delta playlist cannot be downloaded');
  const firstMap = JSON.stringify(pl.segments[0].map);
  for (const s of pl.segments) {
    if (s.discontinuity) throw new Error('This recording changes stream timelines (HLS discontinuity); safe joining is not supported');
    if (s.gap) throw new Error('The recording lists missing media segments and cannot be saved completely');
    if (JSON.stringify(s.map) !== firstMap) throw new Error('This recording changes initialization maps; safe joining is not supported');
    validateKey(s.key);
    if (s.map) validateKey(s.map.key, true);
  }
}

export function ivFor(key, seq) {
  const iv = new Uint8Array(16);
  if (key && key.iv) {
    if (!/^0x[0-9a-f]{1,32}$/i.test(key.iv)) throw new Error('Invalid AES-128 IV');
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid HLS media sequence for AES-128 IV');
    let n = seq;
    for (let i = 15; i >= 0 && n > 0; i--) { iv[i] = n % 256; n = Math.floor(n / 256); }
  }
  return iv;
}

/** Turn a master playlist into a flat list of download options for the popup. */
export function masterOptions(pl) {
  assertDownloadable(pl);
  const out = [];
  const audioByGroup = new Map();
  for (const m of pl.media) {
    if (m.type !== 'AUDIO' || !m.url) continue;
    if (!audioByGroup.has(m.group)) audioByGroup.set(m.group, []);
    audioByGroup.get(m.group).push(m);
  }
  const variants = [...pl.variants].sort((a, b) => b.bandwidth - a.bandwidth);
  variants.forEach((v, i) => {
    const audioOnly = !v.height && String(v.codecs || '').split(',').every((codec) =>
      /^(?:mp4a(?:\.[a-z0-9-]+)*|aac|mp3|opus|ac-3|ec-3|flac|alac|vorbis)$/i.test(codec.trim()));
    const group = v.audioGroup ? audioByGroup.get(v.audioGroup) : null;
    const alt = group && group.length ? (group.find((m) => m.default) || group[0]) : null;
    const res = v.height ? v.height + 'p' : audioOnly ? 'Audio' : 'Stream';
    const rate = v.bandwidth ? (v.bandwidth / 1e6).toFixed(v.bandwidth >= 1e7 ? 0 : 1) + ' Mbps' : '';
    out.push({
      id: 'v' + i, type: audioOnly ? 'audio' : 'video', url: v.url, muxed: audioOnly || !alt,
      audioUrl: !audioOnly && alt ? alt.url : null,
      hosts: origins([v.url, !audioOnly && alt ? alt.url : null]),
      label: [res, rate, !audioOnly && alt ? 'video only; audio is separate' : ''].filter(Boolean).join(' · '),
    });
  });
  const seen = new Set(out.map((o) => o.url));
  pl.media.filter((m) => m.type === 'AUDIO' && m.url && !seen.has(m.url)).forEach((m, i) => {
    out.push({
      id: 'a' + i, type: 'audio', url: m.url, muxed: false, audioUrl: null,
      hosts: origins([m.url]),
      label: 'Audio · ' + (m.name || m.lang || 'track ' + (i + 1)),
    });
  });
  return out;
}

const origins = (urls) => [...new Set(urls.filter(Boolean).map((url) => new URL(url).origin))];

/** Every referenced origin, including rotating keys and initialization maps. */
export function playlistHosts(pl, url) {
  const urls = [url];
  if (pl.master) urls.push(...pl.variants.map((v) => v.url), ...pl.media.map((m) => m.url), ...(pl.keys || []).map((k) => k?.uri));
  else for (const s of pl.segments) urls.push(s.url, s.key?.uri, s.map?.url, s.map?.key?.uri);
  return origins(urls);
}

export function selectOutput(option, mode) {
  if (!option || !['audio', 'video'].includes(mode)) throw new Error('Choose a valid stream and download mode');
  mode = option.type === 'audio' ? 'audio' : mode;
  const audioOnly = option.type === 'audio' || (mode === 'audio' && !!option.audioUrl);
  const url = mode === 'audio' && option.audioUrl ? option.audioUrl : option.url;
  const outputRole = mode === 'audio' ? 'audio' : option.muxed === false ? 'video-only' : 'video';
  const notice = outputRole === 'video-only' ? 'This saves only the video stream. Use Audio to save its separate audio track; this extension does not combine them.' : '';
  return { url, mode, audioOnly, outputRole, notice };
}
