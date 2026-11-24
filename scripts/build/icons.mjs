// Packs PNG images into a .ico: Windows wants one file with several sizes, each either a raw BMP or a PNG.
// PNG entries are read as-is (256 px must be stored with 0 in the size bytes, which is what this writes).
import { readFileSync, writeFileSync } from 'node:fs';

const HEADER = 6;
const ENTRY = 16;

/** Whether the ico already holds an image of exactly `size` pixels. */
export function hasSize(ico, size) {
  if (ico.length < HEADER + ENTRY) return false;
  const count = ico.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const at = HEADER + i * ENTRY;
    if (at + ENTRY > ico.length) return false;
    const width = ico[at] || 256;
    const height = ico[at + 1] || 256;
    if (width === size && height === size) return true;
  }
  return false;
}

/** An ico with a single PNG-compressed image. `size` is the image's real width (256 for the big icon). */
export function packIco(png, size = 256) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = size >= 256 ? 0 : size;
  const dir = Buffer.alloc(HEADER + ENTRY);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // 1 = icon
  dir.writeUInt16LE(1, 4); // one image
  dir[HEADER] = width;
  dir[HEADER + 1] = width;
  dir[HEADER + 2] = 0; // palette size: none
  dir[HEADER + 3] = 0; // reserved
  dir.writeUInt16LE(1, HEADER + 4); // colour planes
  dir.writeUInt16LE(32, HEADER + 6); // bits per pixel
  dir.writeUInt32LE(png.length, HEADER + 8);
  dir.writeUInt32LE(HEADER + ENTRY, HEADER + 12);
  return Buffer.concat([dir, png]);
}

if (process.argv[1] && process.argv[1].endsWith('icons.mjs')) {
  const [, , source, target, size = '256'] = process.argv;
  if (!source || !target) {
    console.error('usage: node scripts/build/icons.mjs <png> <ico> [size]');
    process.exit(1);
  }
  writeFileSync(target, packIco(readFileSync(source), Number(size)));
}
