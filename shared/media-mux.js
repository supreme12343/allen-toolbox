import { checkAbort, DownloadError } from './download.js';

const muxError = (message) => new DownloadError('DOWNLOAD_MUX', message + ' The separate downloads are still available.');

export async function muxTracks(video, audio, { signal, storage = globalThis.navigator?.storage, preferWebm = false } = {}) {
  checkAbort(signal);
  const { Input, BlobSource, MP4, WEBM, Output, StreamTarget, Mp4OutputFormat, WebMOutputFormat,
    EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource } = await import('../lib/mediabunny.min.mjs');
  const inputs = [video, audio].map((blob) => new Input({ formats: [MP4, WEBM], source: new BlobSource(blob) }));
  let dir, name, writable, output;
  const readers = [];
  const cleanup = async () => { if (name) await dir.removeEntry(name).catch(() => {}); };
  try {
    const [v, a] = await Promise.all(inputs.map((input) => input.getTracks()));
    const tracks = [v.find((track) => track.type === 'video'), a.find((track) => track.type === 'audio')];
    if (!tracks.every(Boolean) || v.some((track) => track.type === 'audio') || a.some((track) => track.type === 'video')) {
      throw muxError('Expected a video-only file and an audio-only file.');
    }
    const info = await Promise.all(tracks.map(async (track) => ({ codec: await track.getCodec(), config: await track.getDecoderConfig(),
      encrypted: /^(encv|enca)$/.test(await track.getInternalCodecId()) })));
    if (info.some((track) => !track.codec || !track.config || track.encrypted)) throw muxError('One track is protected or uses an unsupported codec.');
    const mp4 = { extension: 'mp4', format: new Mp4OutputFormat({ fastStart: false }) };
    const webm = { extension: 'webm', format: new WebMOutputFormat() };
    const selected = (preferWebm ? [webm, mp4] : [mp4, webm]).find(({ format }) =>
      format.getSupportedVideoCodecs().includes(info[0].codec) && format.getSupportedAudioCodecs().includes(info[1].codec));
    if (!selected) throw muxError('These tracks cannot be combined without converting their codecs.');

    const heads = [];
    for (const track of tracks) {
      const reader = new EncodedPacketSink(track).packets();
      readers.push(reader);
      heads.push(await reader.next());
    }
    if (heads.some((head) => head.done) || heads[0].value.type !== 'key') throw muxError('One of the tracks is incomplete.');
    if (Math.abs(heads[0].value.timestamp - heads[1].value.timestamp) > 2) throw muxError('The tracks start at different points in the video.');
    checkAbort(signal);

    if (!storage?.getDirectory) throw muxError('This browser does not support the temporary storage needed to combine tracks.');
    dir = await (await storage.getDirectory()).getDirectoryHandle('toolbox-combined-downloads', { create: true });
    name = crypto.randomUUID() + '.' + selected.extension;
    const file = await dir.getFileHandle(name, { create: true });
    writable = await file.createWritable();
    output = new Output({ format: selected.format, target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }) });
    const sources = [new EncodedVideoPacketSource(info[0].codec), new EncodedAudioPacketSource(info[1].codec)];
    output.addVideoTrack(sources[0]);
    output.addAudioTrack(sources[1]);
    await output.start();

    const ends = [-Infinity, -Infinity], started = [false, false];
    while (!heads.every((head) => head.done)) {
      checkAbort(signal);
      // Interleave the heads without reordering packets within either track's decode order.
      const i = heads[0].done || !heads[1].done && heads[1].value.timestamp < heads[0].value.timestamp ? 1 : 0;
      const packet = heads[i].value;
      if (!packet.data.length || !Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration < 0) {
        throw muxError('One of the tracks contains an invalid media packet.');
      }
      await sources[i].add(packet, started[i] ? undefined : { decoderConfig: info[i].config });
      started[i] = true;
      ends[i] = Math.max(ends[i], packet.timestamp + packet.duration);
      heads[i] = await readers[i].next();
      if (heads[i].done) sources[i].close();
    }
    if (Math.abs(ends[0] - ends[1]) > 2) throw muxError('The audio and video end at different points. Play the video again and rescan.');
    checkAbort(signal);
    await output.finalize();
    const blob = await file.getFile();
    if (!blob.size) throw muxError('No combined file was produced.');
    checkAbort(signal);
    return { blob, extension: selected.extension, cleanup };
  } catch (error) {
    if (output) await output.cancel().catch(() => {});
    if (writable && !writable.locked) await writable.abort().catch(() => {});
    await cleanup();
    checkAbort(signal);
    if (error instanceof DownloadError) throw error;
    throw muxError(error?.name === 'QuotaExceededError' ? 'There is not enough browser storage to combine the tracks.' : 'Could not combine these audio and video files.');
  } finally {
    const closing = readers.map((reader) => reader.return());
    for (const input of inputs) input.dispose();
    await Promise.allSettled(closing);
  }
}
