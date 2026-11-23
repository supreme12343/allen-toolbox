import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as hls from '../shared/hls.js';
import * as download from '../shared/download.js';
import * as pdf from '../shared/pdf.js';
import * as names from '../shared/names.js';
import { TsAudioDemuxer } from '../shared/tsaudio.js';

const utf8 = (s) => new TextEncoder().encode(s);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const base = 'https://playlist.test/recording.m3u8';
const vod = (body) => '#EXTM3U\n' + body + '\n#EXT-X-ENDLIST\n';
const response = (data, headers = {}, status = 200) => new Response(data, { status, headers: { 'content-type': 'application/octet-stream', ...headers } });
const single = { id: 's0', type: 'video', url: base, muxed: true, audioUrl: null, label: 'Single stream' };
const context = { tabId: 1, frameId: 0, documentId: 'document-a', routeAt: 10, scope: 'scope-a', url: base, pageHref: 'https://www.allenoverseas.com/lecture' };
const joined = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let pos = 0; for (const p of parts) { out.set(p, pos); pos += p.length; } return out; };
const box = (type, data = new Uint8Array()) => { const out = new Uint8Array(8 + data.length); new DataView(out.buffer).setUint32(0, out.length); out.set(utf8(type), 4); out.set(data, 8); return out; };
const init = box('ftyp', utf8('fixture vide metadata is not an audio-track heuristic'));
const fragment = box('moof', utf8('fragment fixture'));
const ts = () => { const out = new Uint8Array(188); out[0] = 0x47; return out; };

async function workerHarness(fetch, send) {
  const source = (await readFile(new URL('../offscreen.js', import.meta.url), 'utf8')).replace(/^import .*;\r?$/gm, '');
  const messages = [], blobs = new Map(), revoked = [];
  class ObjectURL extends URL {}
  ObjectURL.createObjectURL = (blob) => { const key = 'blob:hls-' + blobs.size; blobs.set(key, blob); return key; };
  ObjectURL.revokeObjectURL = (url) => { revoked.push(url); blobs.delete(url); };
  const listeners = [];
  const chrome = { runtime: { id: 'fixture', getURL: (p) => 'chrome-extension://fixture/' + p, onMessage: { addListener(fn) { listeners.push(fn); } },
    async sendMessage(msg) { messages.push(structuredClone(msg)); if (send) return send(msg); return msg.type === 'off:request-acquire' ? { requestId: msg.requestId } : { ok: true }; } } };
  const wrapped = Object.fromEntries(['withResponse', 'fetchBytes', 'fetchBuffer', 'fetchText', 'downloadFile'].map((name) => [name, (url, opts, consume) => download[name](url, { ...opts, fetch, retryDelay: 0 }, consume)]));
  const ctx = vm.createContext({ ...hls, ...download, ...wrapped, ...pdf, ...names, TsAudioDemuxer,
    pdfjs: { GlobalWorkerOptions: {} }, chrome, self: { addEventListener() {} }, crypto: globalThis.crypto, URL: ObjectURL,
    Blob, Uint8Array, TextDecoder, AbortController, DOMException, setTimeout, clearTimeout, console });
  new vm.Script(source + '\n globalThis.api = { runHls, startJob, jobs, hlsInfo, hlsPreview, handle };', { filename: 'offscreen.js' }).runInContext(ctx);
  return { api: ctx.api, messages, blobs, revoked, listeners };
}

async function run(worker, option = single, mode = 'video', extra = {}) {
  const output = hls.selectOutput(option, mode), job = { id: 'hls-fixture', abort: new AbortController(), state: 'running' };
  const result = await worker.api.runHls({ jobId: job.id, option, mode: output.mode, url: output.url, context, name: 'Lecture', ...extra }, job);
  return { result, blob: worker.blobs.get(result.blobUrl), job };
}

test('master options preserve selectable video and external AUDIO metadata', () => {
  const pl = hls.parseM3U8('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="https://audio.test/a.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"\nhttps://video.test/v.m3u8\n', base);
  const options = hls.masterOptions(pl), video = options.find((o) => o.type === 'video'), audio = options.find((o) => o.type === 'audio');
  assert.equal(video.muxed, false); assert.equal(video.audioUrl, 'https://audio.test/a.m3u8'); assert.match(video.label, /audio is separate/);
  assert.equal(hls.selectOutput(video, 'audio').url, video.audioUrl); assert.equal(hls.selectOutput(video, 'audio').audioOnly, true);
  assert.equal(hls.selectOutput(video, 'video').outputRole, 'video-only'); assert.match(hls.selectOutput(video, 'video').notice, /only the video stream/);
  assert.equal(hls.selectOutput(audio, 'video').mode, 'audio');
  assert.deepEqual(hls.playlistHosts(pl, base).sort(), ['https://audio.test', 'https://playlist.test', 'https://video.test']);
});

test('pure-audio variant metadata authorizes intact audio without guessing MP4 contents', () => {
  const pl = hls.parseM3U8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8\n', base);
  const option = hls.masterOptions(pl)[0]; assert.equal(option.type, 'audio'); assert.equal(hls.selectOutput(option, 'audio').audioOnly, true);
  const dolby = hls.parseM3U8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="ac-3"\naudio.m3u8\n', base);
  assert.equal(hls.masterOptions(dolby)[0].type, 'audio');
  const mixed = hls.parseM3U8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2,dvh1.05.06"\nunknown.m3u8\n', base);
  assert.equal(hls.masterOptions(mixed)[0].type, 'video'); assert.equal(hls.selectOutput(hls.masterOptions(mixed)[0], 'audio').audioOnly, false);
});

test('every rotating key, map and segment origin appears in consent preview', () => {
  const pl = hls.parseM3U8(vod('#EXT-X-KEY:METHOD=AES-128,URI="https://keys-a.test/a",IV=0x1\n' +
    '#EXT-X-MAP:URI="https://init.test/init.mp4"\n#EXTINF:2,\nhttps://segments-a.test/1.m4s\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys-b.test/b",IV=0x2\n#EXTINF:2,\nhttps://segments-b.test/2.m4s\n' +
    '#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nhttps://segments-c.test/3.m4s\n#EXTINF:2,\nhttps://segments-d.test/4.m4s'), base);
  hls.assertDownloadable(pl);
  assert.deepEqual(hls.playlistHosts(pl, base).sort(), ['https://init.test', 'https://keys-a.test', 'https://keys-b.test', 'https://playlist.test',
    'https://segments-a.test', 'https://segments-b.test', 'https://segments-c.test', 'https://segments-d.test']);
});

test('AES-128 keys and IVs are validated for media, initialization maps and master session keys', () => {
  for (const key of ['METHOD=AES-128', 'METHOD=AES-128,URI="key",IV=0xNOTHEX', 'METHOD=AES-128,URI="key",IV=0x' + '1'.repeat(33),
    'METHOD=SAMPLE-AES,URI="key"', 'METHOD=AES-128,URI="key",KEYFORMAT="com.apple.streamingkeydelivery"']) {
    assert.throws(() => hls.assertDownloadable(hls.parseM3U8(vod('#EXT-X-KEY:' + key + '\n#EXTINF:1,\nseg.ts'), base)), /key|IV|protection|DRM/i);
  }
  assert.throws(() => hls.assertDownloadable(hls.parseM3U8(vod('#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nseg.m4s'), base)), /explicit IV/);
  assert.throws(() => hls.masterOptions(hls.parseM3U8('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8', base)), /protection/);
  const iv = hls.ivFor({ iv: '0x123' }, 0); assert.equal(iv.length, 16); assert.equal(iv[14], 1); assert.equal(iv[15], 0x23);
  const sequenceIv = hls.ivFor(null, 2 ** 32 + 5); assert.equal(sequenceIv[11], 1); assert.equal(sequenceIv[15], 5);
  assert.throws(() => hls.ivFor({ iv: '0xzz' }, 1), /IV/); assert.throws(() => hls.ivFor(null, -1), /sequence/);
});

test('changed initialization maps, discontinuities, gaps and unfinished/live playlists are refused', () => {
  for (const body of ['#EXT-X-MAP:URI="one.mp4"\n#EXTINF:1,\none.m4s\n#EXT-X-MAP:URI="two.mp4"\n#EXTINF:1,\ntwo.m4s',
    '#EXTINF:1,\none.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\ntwo.ts', '#EXT-X-GAP\n#EXTINF:1,\none.ts', '#EXT-X-SKIP:SKIPPED-SEGMENTS=2\n#EXTINF:1,\none.ts']) {
    assert.throws(() => hls.assertDownloadable(hls.parseM3U8(vod(body), base)), /map|timeline|missing|delta/i);
  }
  assert.throws(() => hls.assertDownloadable(hls.parseM3U8('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\none.ts', base)), /finished/);
  assert.throws(() => hls.parseM3U8('#EXTM3U-invalid\n', base), /Not an HLS/);
});

test('byte range offsets may be implicit only for the adjacent same resource', () => {
  const pl = hls.parseM3U8(vod('#EXTINF:1,\n#EXT-X-BYTERANGE:10@2\na.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:20\na.ts'), base);
  assert.deepEqual(pl.segments.map((s) => s.range), [{ offset: 2, length: 10, end: 12 }, { offset: 12, length: 20, end: 32 }]);
  for (const body of ['#EXTINF:1,\n#EXT-X-BYTERANGE:10\na.ts', '#EXTINF:1,\n#EXT-X-BYTERANGE:10@0\na.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:10\nb.ts',
    '#EXTINF:1,\n#EXT-X-BYTERANGE:0@0\na.ts', '#EXTINF:1,\n#EXT-X-BYTERANGE:bad@0\na.ts']) assert.throws(() => hls.parseM3U8(vod(body), base), /byte range/);
});

test('external AUDIO action fetches audioUrl, while video-only results carry an explicit notice', async () => {
  const option = { ...single, url: 'https://video.test/video.m3u8', muxed: false, audioUrl: 'https://audio.test/audio.m3u8' }, urls = [];
  const worker = await workerHarness(async (url) => {
    urls.push(url);
    if (url.endsWith('.m3u8')) return response(utf8(vod('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg.m4s')));
    return response(url.endsWith('init.mp4') ? init : fragment);
  });
  const audio = await run(worker, option, 'audio');
  assert.equal(urls[0], option.audioUrl); assert.equal(urls.some((u) => u.startsWith('https://video.test')), false);
  assert.equal(audio.result.filename, 'Lecture.m4a'); assert.equal(audio.result.outputRole, 'audio');
  assert.deepEqual(new Uint8Array(await audio.blob.arrayBuffer()), joined(init, fragment));
  urls.length = 0;
  const video = await run(worker, option, 'video');
  assert.equal(urls[0], option.url); assert.equal(video.result.outputRole, 'video-only'); assert.match(video.result.notice, /separate audio track/);
});

test('muxed or unknown fMP4 audio extraction is refused, and missing EXT-X-MAP never prepends null', async () => {
  const worker = await workerHarness(async (url) => url.endsWith('.m3u8') ? response(utf8(vod('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg.m4s'))) : response(url.endsWith('init.mp4') ? init : fragment));
  await assert.rejects(run(worker, single, 'audio'), /MP4 demuxer/); assert.equal(worker.blobs.size, 0);
  const missing = await workerHarness(async (url) => url.endsWith('.m3u8') ? response(utf8(vod('#EXTINF:1,\nseg.m4s'))) : response(fragment));
  for (const mode of ['video', 'audio']) await assert.rejects(run(missing, single, mode), /missing EXT-X-MAP/);
  assert.equal(missing.blobs.size, 0);
});

test('HLS 200 byte-range fallback slices a complete file once instead of duplicating it per segment', async () => {
  const all = joined(ts(), ts()); let mediaRequests = 0;
  const worker = await workerHarness(async (url, opts) => {
    if (url.endsWith('.m3u8')) return response(utf8(vod('#EXTINF:1,\n#EXT-X-BYTERANGE:188@0\nmedia.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:188\nmedia.ts')));
    mediaRequests++; assert.equal(opts.headers.Range, 'bytes=0-187'); return response(all, { 'content-length': String(all.length), etag: '"complete"' });
  });
  const out = await run(worker); assert.equal(mediaRequests, 1); assert.equal(out.blob.size, all.length);
  assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), all);
});

test('HLS changed range validators cannot produce partial assembled output', async () => {
  let segment = 0;
  const worker = await workerHarness(async (url, opts) => {
    if (url.endsWith('.m3u8')) return response(utf8(vod('#EXTINF:1,\n#EXT-X-BYTERANGE:188@0\nmedia.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:188\nmedia.ts')));
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range); segment++;
    return response(ts(), { 'content-range': `bytes ${m[1]}-${m[2]}/376`, etag: segment === 1 ? '"a"' : '"b"' }, 206);
  });
  await assert.rejects(run(worker), { code: 'DOWNLOAD_CHANGED' }); assert.equal(worker.blobs.size, 0);
});

test('AES-128 encrypted initialization and media decrypt with one validated key fetch', async () => {
  const raw = new Uint8Array(16).fill(7), key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt']);
  const iv = hls.ivFor({ iv: '0x1' }, 0);
  const encryptedInit = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, init);
  const encryptedFragment = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, fragment);
  let keyRequests = 0;
  const worker = await workerHarness(async (url) => {
    if (url.endsWith('.m3u8')) return response(utf8(vod('#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg.m4s')));
    if (url.endsWith('/key')) { keyRequests++; return response(raw); }
    return response(url.endsWith('init.mp4') ? encryptedInit : encryptedFragment);
  });
  const out = await run(worker); assert.equal(keyRequests, 1); assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), joined(init, fragment));
});

test('bad AES key sizes and protected initialization maps fail before creating any blob', async () => {
  const worker = await workerHarness(async (url) => {
    if (url.endsWith('.m3u8')) return response(utf8(vod('#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXTINF:1,\nseg.ts')));
    return response(url.endsWith('/key') ? new Uint8Array(15) : new Uint8Array(16));
  });
  await assert.rejects(run(worker), /key size/); assert.equal(worker.blobs.size, 0);
  const urls = [], protectedMap = await workerHarness(async (url) => {
    urls.push(url); return response(utf8(vod('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nseg.m4s')));
  });
  await assert.rejects(run(protectedMap), /protection/); assert.deepEqual(urls, [base]);
});

test('worker errors abort peer fetches, remain errors, and never send late running updates', async () => {
  let peerReady, peerSignal, finishPeer;
  const started = new Promise((resolve) => { peerReady = resolve; });
  const worker = await workerHarness(async (url, opts) => {
    if (url.endsWith('.m3u8')) return response(utf8(vod('#EXTINF:1,\nfailed.ts\n#EXTINF:1,\npeer.ts')));
    if (url.endsWith('failed.ts')) { await started; return response(null, {}, 403); }
    peerSignal = opts.signal; peerReady(); return new Promise((resolve, reject) => {
      finishPeer = resolve; opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
  });
  worker.api.startJob({ jobId: 'error-job', kind: 'hls', url: base, option: single, mode: 'video', context });
  await worker.api.jobs.get('error-job').promise;
  assert.equal(peerSignal.aborted, true);
  const states = worker.messages.filter((m) => m.type === 'off:job');
  assert.equal(states.at(-1).state, 'error'); assert.equal(states.some((m) => m.state === 'cancelled'), false);
  finishPeer(response(ts())); await tick();
  assert.equal(worker.messages.filter((m) => m.type === 'off:job').length, states.length); assert.equal(worker.blobs.size, 0);
});

test('cancellation while a header lease is queued releases late grants and never begins fetch', async () => {
  let grant, fetches = 0;
  const worker = await workerHarness(async () => { fetches++; return response(ts()); }, async (msg) => {
    if (msg.type === 'off:request-acquire') return new Promise((resolve) => { grant = resolve; });
    return { ok: true };
  });
  worker.api.startJob({ jobId: 'cancel-job', kind: 'http', url: 'https://media.test/file.mp4', mode: 'video', context });
  const active = worker.api.jobs.get('cancel-job');
  await worker.api.handle({ type: 'job-cancel', jobId: 'cancel-job' }); await active.promise;
  assert.equal(worker.messages.filter((m) => m.type === 'off:job').at(-1).state, 'cancelled');
  grant({ requestId: 'late' }); await tick();
  assert.equal(fetches, 0); assert.ok(worker.messages.some((m) => m.type === 'off:request-release')); assert.equal(worker.blobs.size, 0);
});

test('job-start retries are idempotent and offscreen success is ready, not browser-complete', async () => {
  let requests = 0;
  const worker = await workerHarness(async () => { requests++; return response(ts(), { 'content-type': 'video/mp4' }); });
  const msg = { jobId: 'once', kind: 'http', url: 'https://media.test/file.mp4', mode: 'video', context };
  worker.api.startJob(msg); const active = worker.api.jobs.get('once'); worker.api.startJob(msg); await active.promise; worker.api.startJob(msg);
  assert.equal(requests, 1); const updates = worker.messages.filter((m) => m.type === 'off:job');
  assert.equal(updates.at(-1).state, 'ready'); assert.equal(updates.some((m) => m.state === 'done'), false);
  assert.equal(worker.listeners[0]({ target: 'offscreen', type: 'job-start' }, { id: 'fixture', tab: { id: 1 } }, () => {}), undefined);
});

test('preview enumerates selected resource hosts and reuses its playlist without a second token fetch', async () => {
  let playlists = 0;
  const worker = await workerHarness(async (url) => {
    if (url.endsWith('.m3u8')) { playlists++; return response(utf8(vod('#EXT-X-MAP:URI="https://init.test/init.mp4"\n#EXTINF:1,\nhttps://segment.test/one.m4s'))); }
    return response(url.endsWith('init.mp4') ? init : fragment);
  });
  const preview = await worker.api.hlsPreview({ url: base, option: single, mode: 'video', context });
  assert.deepEqual([...preview.hosts].sort(), ['https://init.test', 'https://playlist.test', 'https://segment.test']);
  await run(worker, single, 'video', { previewId: preview.previewId }); assert.equal(playlists, 1);
});

test('standalone hls-info, preview and download consume the media playlist only once', async () => {
  let playlists = 0;
  const worker = await workerHarness(async (url) => {
    if (url.includes('.m3u8')) {
      playlists++; if (playlists > 1) return response(null, {}, 403);
      const r = response(utf8(vod('#EXTINF:1,\nseg.ts'))); Object.defineProperty(r, 'url', { value: base }); return r;
    }
    return response(ts());
  });
  const info = await worker.api.hlsInfo({ url: base + '#recording', context });
  const preview = await worker.api.hlsPreview({ url: base, context, option: info.options[0], mode: 'video' });
  await run(worker, info.options[0], 'video', { previewId: preview.previewId }); assert.equal(playlists, 1);
});

function packet(pid, payload) {
  const out = new Uint8Array(188).fill(0xff); out.set([0x47, 0x40 | (pid >> 8), pid & 255, 0x30]);
  out[4] = 183 - payload.length; if (out[4]) out[5] = 0; out.set(payload, 5 + out[4]); return out;
}

function audioTs(type, audio) {
  const pat = new Uint8Array(17); pat.set([0, 0xb0, 13]); pat.set([0, 1, 0xe1, 0], 8);
  const pmt = new Uint8Array(21); pmt.set([2, 0xb0, 18]); pmt.set([0xf0, 0], 10); pmt.set([type, 0xe1, 1, 0xf0, 0], 12);
  const pes = joined(new Uint8Array([0, 0, 1, 0xc0, 0, 0, 0x80, 0, 0]), audio);
  return joined(packet(0, joined(new Uint8Array([0]), pat)), packet(0x100, joined(new Uint8Array([0]), pmt)), packet(0x101, pes));
}

test('TS AAC and MP3 elementary-stream extraction is retained with correct extension and MIME', async () => {
  for (const [type, ext, audio] of [[0x0f, 'aac', new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0xff, 0xfc])], [0x03, 'mp3', new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3])]]) {
    const media = audioTs(type, audio);
    const worker = await workerHarness(async (url) => url.endsWith('.m3u8') ? response(utf8(vod('#EXTINF:1,\nseg.ts'))) : response(media));
    const out = await run(worker, single, 'audio'); assert.equal(out.result.filename, 'Lecture.' + ext);
    assert.equal(out.blob.type, ext === 'mp3' ? 'audio/mpeg' : 'audio/aac'); assert.deepEqual(new Uint8Array(await out.blob.arrayBuffer()), audio);
  }
});

test('packed MPEG audio is not mislabeled as AAC', async () => {
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3]);
  const worker = await workerHarness(async (url) => url.endsWith('.m3u8') ? response(utf8(vod('#EXTINF:1,\nseg.mp3'))) : response(audio));
  const out = await run(worker, single, 'audio', { concurrency: 'not-a-number' }); assert.equal(out.result.filename, 'Lecture.mp3'); assert.equal(out.blob.type, 'audio/mpeg');
});

test('lost request-context, release and ready acknowledgements retry without refetching the file', async () => {
  let contexts = 0, fetches = 0, ready = 0, firstId;
  const releases = new Map();
  const worker = await workerHarness(async () => { fetches++; return response(ts(), { 'content-type': 'video/mp4' }); }, async (msg) => {
    if (msg.type === 'off:request-acquire') {
      contexts++; if (contexts === 1) { firstId = msg.requestId; throw new Error('The message port closed'); }
      return { requestId: msg.requestId };
    }
    if (msg.type === 'off:request-release') {
      const n = (releases.get(msg.requestId) || 0) + 1; releases.set(msg.requestId, n);
      if (msg.requestId === firstId && n === 1) return null;
    }
    if (msg.type === 'off:job' && msg.state === 'ready' && ++ready === 1) return null;
    return { ok: true };
  });
  worker.api.startJob({ jobId: 'retry-ack', kind: 'http', url: 'https://media.test/file.mp4', mode: 'video', context });
  await worker.api.jobs.get('retry-ack').promise;
  assert.equal(contexts, 2); assert.equal(fetches, 1); assert.equal(ready, 2);
  assert.equal(releases.get(firstId), 2); assert.equal(releases.size, 2); assert.equal(worker.revoked.length, 0);
});

test('unacknowledged ready results remain recoverable and are not revoked on ambiguous acceptance', async () => {
  const worker = await workerHarness(async () => response(ts(), { 'content-type': 'video/mp4' }), async (msg) => {
    if (msg.type === 'off:request-acquire') return { requestId: msg.requestId };
    if (msg.type === 'off:job' && msg.state === 'ready') return null;
    return { ok: true };
  });
  worker.api.startJob({ jobId: 'pending-ack', kind: 'http', url: 'https://media.test/file.mp4', mode: 'video', context });
  await worker.api.jobs.get('pending-ack').promise;
  const status = await worker.api.handle({ type: 'job-status' });
  assert.equal(status.jobs[0].state, 'ready'); assert.ok(status.jobs[0].result.blobUrl); assert.equal(worker.revoked.length, 0);
  await worker.api.handle({ type: 'job-ack', jobId: 'pending-ack' });
  assert.equal(worker.api.jobs.size, 0); assert.equal(worker.revoked.length, 0);
});
