// Pull the audio elementary stream out of MPEG-TS segments (no re-encoding).
// AAC (ADTS) comes out as .aac, MPEG audio as .mp3.

export class TsAudioDemuxer {
  constructor() {
    this.pmtPid = null; this.audioPid = null; this.ext = null;
    this.chunks = [];
  }

  push(u8) {
    let off = 0;
    if (u8[0] !== 0x47) {                       // resync if the segment does not start on a packet
      while (off < u8.length - 376 && !(u8[off] === 0x47 && u8[off + 188] === 0x47)) off++;
    }
    for (let i = off; i + 188 <= u8.length; i += 188) {
      if (u8[i] !== 0x47) continue;
      const pid = ((u8[i + 1] & 0x1f) << 8) | u8[i + 2];
      const pusi = !!(u8[i + 1] & 0x40);
      const afc = (u8[i + 3] >> 4) & 3;
      let p = i + 4;
      if (afc & 2) p += 1 + u8[i + 4];
      if (!(afc & 1) || p >= i + 188) continue;
      const payload = u8.subarray(p, i + 188);

      if (pid === 0 && this.pmtPid === null) this._pat(payload, pusi);
      else if (pid === this.pmtPid && this.audioPid === null) this._pmt(payload, pusi);
      else if (pid === this.audioPid) this._audio(payload, pusi);
    }
  }

  _section(payload, pusi) {
    if (!pusi) return null;
    const start = 1 + payload[0];
    return payload.subarray(start);
  }

  _pat(payload, pusi) {
    const s = this._section(payload, pusi);
    if (!s || s[0] !== 0x00) return;
    const len = ((s[1] & 0x0f) << 8) | s[2];
    for (let i = 8; i + 4 <= 3 + len - 4; i += 4) {
      const prog = (s[i] << 8) | s[i + 1];
      if (prog !== 0) { this.pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3]; return; }
    }
  }

  _pmt(payload, pusi) {
    const s = this._section(payload, pusi);
    if (!s || s[0] !== 0x02) return;
    const len = ((s[1] & 0x0f) << 8) | s[2];
    const pil = ((s[10] & 0x0f) << 8) | s[11];
    let i = 12 + pil;
    const end = Math.min(3 + len - 4, s.length);
    while (i + 5 <= end) {
      const type = s[i];
      const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
      const esLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      if (type === 0x0f || type === 0x11) { this.audioPid = pid; this.ext = 'aac'; return; }
      if (type === 0x03 || type === 0x04) { this.audioPid = pid; this.ext = 'mp3'; return; }
      i += 5 + esLen;
    }
  }

  _audio(payload, pusi) {
    let es = payload;
    if (pusi && payload.length > 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
      es = payload.subarray(9 + payload[8]);
    }
    if (es.length) this.chunks.push(es.slice());
  }
}
