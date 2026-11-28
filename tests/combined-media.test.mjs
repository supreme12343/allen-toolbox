import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingYoutubeTracks, youtubeAudioPairs, youtubeTrack } from '../shared/media-pair.js';
import { muxTracks } from '../shared/media-mux.js';
import { BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, Mp4OutputFormat, Output, WEBM, WebMOutputFormat } from '../lib/mediabunny.min.mjs';

function capture(id, itag, ct, query = '') {
  return { id, kind: 'media', url: `https://${id}.googlevideo.com/videoplayback?id=recording&itag=${itag}${query}`, ct,
    tabId: 7, frameId: 0, documentId: 'doc-one', scope: 'current-route', pageHref: 'https://www.youtube.com/watch?v=fixture', ts: 10 };
}

test('combines related adaptive tracks and prefers a same-container full audio capture', () => {
  const video = capture('video', 399, 'video/mp4');
  const other = capture('opus', 251, 'audio/webm');
  const part = { ...capture('part', 140, 'audio/mp4', '&range=100-199'), ts: 50 };
  const audio = capture('audio', 140, 'audio/mp4', '&clen=1234');
  assert.deepEqual(youtubeAudioPairs([other, part, audio, video]).get('video'), { id: 'audio', origin: 'https://audio.googlevideo.com' });
  assert.equal(youtubeAudioPairs([other, video]).get('video').id, 'opus');
  assert.equal(youtubeAudioPairs([part, other, video]).get('video').id, 'opus');
  assert.equal(matchingYoutubeTracks(video, audio).audio.length, 1234);
});

test('mismatched recordings, frame scopes and already-muxed or live formats cannot be paired', () => {
  const video = capture('video', 137, 'video/mp4'), audio = capture('audio', 140, 'audio/mp4');
  for (const other of [{ ...audio, tabId: 8 }, { ...audio, frameId: 1 }, { ...audio, documentId: 'doc-two' }, { ...audio, scope: 'old-route' },
    { ...audio, url: audio.url.replace('id=recording', 'id=different') }, { ...audio, url: audio.url + '&expire=1' },
    { ...audio, pageHref: 'https://notyoutube.com' }, { ...audio, url: audio.url.replace('.googlevideo.com/', '.googlevideo.com.example.org/') },
    capture('ambiguous', 140, 'audio/mp4', '&id=duplicate'), capture('live', 140, 'audio/mp4', '&live=1'), capture('segment', 140, 'audio/mp4', '&sq=0')]) {
    assert.equal(matchingYoutubeTracks(video, other, 2000), null);
  }
  for (const item of [capture('progressive', 22, 'video/mp4'), capture('wrong-type', 140, 'video/mp4'), capture('not-video', 137, 'text/html')]) assert.equal(youtubeTrack(item), null);
});

async function singleTrack(isVideo, { fragmented = false, start = 0, count = 3 } = {}) {
  const output = new Output({ target: new BufferTarget(), format: fragmented ? new Mp4OutputFormat({ fastStart: 'fragmented' }) : new WebMOutputFormat() });
  const source = isVideo ? new EncodedVideoPacketSource('vp8') : new EncodedAudioPacketSource('opus');
  const config = isVideo ? { codec: 'vp8', codedWidth: 32, codedHeight: 32 } : { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
  if (isVideo) output.addVideoTrack(source); else output.addAudioTrack(source);
  await output.start();
  for (let i = 0; i < count; i++) {
    const data = isVideo ? [0x10, 0, 0, 0x9d, 1, 0x2a, 32, 0, 32, 0] : [0xf8, 0xff, 0xfe];
    await source.add(new EncodedPacket(Uint8Array.from(data), 'key', start + i * .02, .02), i === 0 ? { decoderConfig: config } : undefined);
  }
  source.close(); await output.finalize();
  return new Blob([output.target.buffer]);
}

function scratch(onWrite) {
  const files = new Map();
  const dir = {
    async getFileHandle(name) {
      let data = new Uint8Array(); files.set(name, true);
      return { async createWritable() { return new WritableStream({ write({ position, data: chunk }) {
        assert.ok(chunk instanceof Uint8Array);
        if (data.length < position + chunk.length) { const expanded = new Uint8Array(position + chunk.length); expanded.set(data); data = expanded; }
        data.set(chunk, position); onWrite?.();
      } }); }, async getFile() { return new File([data], name); } };
    },
    async removeEntry(name) { files.delete(name); },
  };
  return { files, storage: { async getDirectory() { return { async getDirectoryHandle() { return dir; } }; } } };
}

async function trackPackets(blob) {
  const input = new Input({ formats: [MP4, WEBM], source: new BlobSource(blob) });
  try {
    const result = {};
    for (const track of await input.getTracks()) {
      const packets = [];
      for await (const packet of new EncodedPacketSink(track).packets()) packets.push({ bytes: [...packet.data], timestamp: packet.timestamp });
      result[track.type] = { codec: await track.getCodec(), packets };
    }
    return result;
  } finally { input.dispose(); }
}

test('WebM and fragmented MP4 inputs become one file with both original encoded streams', async (t) => {
  for (const fragmented of [false, true]) await t.test(fragmented ? 'MP4' : 'WebM', async () => {
    const video = await singleTrack(true, { fragmented, start: .04 }), audio = await singleTrack(false, { fragmented });
    const { files, storage } = scratch();
    const result = await muxTracks(video, audio, { storage, preferWebm: !fragmented });
    assert.equal(result.extension, fragmented ? 'mp4' : 'webm'); assert.equal(files.size, 1);
    assert.deepEqual(await trackPackets(result.blob), { ...await trackPackets(video), ...await trackPackets(audio) });
    await result.cleanup(); assert.equal(files.size, 0);
  });
});

test('invalid input or cancelled output never leaves a combined download waiting to be saved', async () => {
  const video = await singleTrack(true), audio = await singleTrack(false);
  const controller = new AbortController(), { files, storage } = scratch(() => controller.abort());
  await assert.rejects(muxTracks(video, video, { storage, preferWebm: true }), /video-only file and an audio-only file/);
  assert.equal(files.size, 0);
  await assert.rejects(muxTracks(video, audio, { storage, preferWebm: true, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(files.size, 0);
});
