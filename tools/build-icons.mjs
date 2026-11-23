import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const colors = { graphite: [25, 29, 36], border: [93, 107, 128], white: [237, 240, 245], blue: [144, 179, 232] };
const roundRect = (x, y, left, top, width, height, radius) => {
  if (x < left || x > left + width || y < top || y > top + height) return false;
  const cx = Math.max(left + radius, Math.min(x, left + width - radius));
  const cy = Math.max(top + radius, Math.min(y, top + height - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};
const arrow = [[58, 52], [70, 52], [70, 74], [83, 74], [64, 94], [45, 74], [58, 74]];
function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function sample(x, y) {
  if (!roundRect(x, y, .5, .5, 127, 127, 17.5)) return [0, 0, 0, 0];
  let color = roundRect(x, y, 3.5, 3.5, 121, 121, 14.5) ? colors.graphite : colors.border;
  if (roundRect(x, y, 41, 23, 46, 32, 12) && !roundRect(x, y, 49, 31, 30, 24, 4)) color = colors.white;
  if (roundRect(x, y, 23, 43, 82, 61, 8)) {
    color = y >= 68.5 && y <= 73.5 ? colors.graphite : colors.blue;
    if (polygon(x, y, arrow)) color = colors.graphite;
  }
  return [...color, 255];
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([length, type, bytes, crc]);
}
for (const size of [16, 32, 48, 128]) {
  const rows = Buffer.alloc((size * 4 + 1) * size), samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const total = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const rgba = sample((x + (sx + .5) / samples) * 128 / size, (y + (sy + .5) / samples) * 128 / size);
      rgba.forEach((value, channel) => { total[channel] += value; });
    }
    total.forEach((value, channel) => { rows[y * (size * 4 + 1) + 1 + x * 4 + channel] = Math.round(value / samples ** 2); });
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(new URL('../icons/icon' + size + '.png', import.meta.url), png);
  console.log('Generated icons/icon' + size + '.png');
}
