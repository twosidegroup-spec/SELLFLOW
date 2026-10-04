/**
 * Splash asset audit.
 *
 * The splash is the one screen a seller cannot dismiss, cannot theme, and cannot
 * scroll past, so two things about it are worth proving rather than assuming:
 *
 *   1. **No baked-in background.** `expo-splash-screen` is configured with a light
 *      `backgroundColor` and a dark one, but a single `image` for both. If that
 *      PNG has an opaque light background of its own, the dark splash renders a
 *      pale square in the middle of a dark screen -- the classic "flash of wrong
 *      colour" that only reproduces on a dark-mode device.
 *   2. **Transparent margins are intentional.** The icon is drawn at
 *      `imageWidth: 180`, so any transparent padding in the source is part of the
 *      design and must not be "corrected" by cropping.
 *
 * Reads the PNG header and the alpha channel directly. No image library, so this
 * runs anywhere Node does.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes an 8-bit RGBA or RGB PNG far enough to inspect its alpha.
 *
 * Deliberately minimal: it handles the colour types these assets actually use
 * (2 = RGB, 6 = RGBA) at bit depth 8, which is what an exported icon is. Anything
 * else is reported rather than guessed at.
 */
export function readPng(path) {
  const buffer = readFileSync(path);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`${path} is not a PNG`);
  }

  let offset = 8;
  let header = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colourType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  if (!header) throw new Error(`${path} has no IHDR`);

  const channels = header.colourType === 6 ? 4 : header.colourType === 2 ? 3 : null;
  if (header.bitDepth !== 8 || channels === null) {
    return { ...header, hasAlphaChannel: false, alpha: null, note: `unsupported colour type ${header.colourType}` };
  }

  /*
   * Colour type 3 is RGB with no alpha channel: every pixel is implicitly opaque.
   * Reporting "has alpha" for it would be exactly the mistake this script exists
   * to catch in an asset, so the distinction is kept explicit.
   */
  const hasAlphaChannel = channels === 4;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(header.height * stride);

  // Undo the per-scanline filters. Only the five standard ones, in order.
  let pos = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[pos + x];
      const a = x >= channels ? pixels[rowStart + x - channels] : 0;
      const b = y > 0 ? pixels[rowStart + x - stride] : 0;
      const c = x >= channels && y > 0 ? pixels[rowStart + x - stride - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter} in ${path}`);
      }
      pixels[rowStart + x] = value & 0xff;
    }
    pos += stride;
  }

  // Corner pixels are what a splash actually shows around the mark.
  const at = (x, y) => {
    const i = y * stride + x * channels;
    return {
      r: pixels[i],
      g: pixels[i + 1],
      b: pixels[i + 2],
      // An image without an alpha channel is fully opaque by definition.
      a: channels === 4 ? pixels[i + 3] : 255,
    };
  };

  let opaquePixels = 0;
  let total = 0;
  let minX = header.width;
  let maxX = -1;
  let minY = header.height;
  let maxY = -1;

  for (let y = 0; y < header.height; y += 1) {
    for (let x = 0; x < header.width; x += 1) {
      const alpha = at(x, y).a;
      total += 1;
      if (alpha > 8) {
        opaquePixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    ...header,
    channels,
    hasAlphaChannel,
    // True once the pixels have been decoded far enough to judge transparency.
    alpha: true,
    corners: {
      topLeft: at(0, 0),
      topRight: at(header.width - 1, 0),
      bottomLeft: at(0, header.height - 1),
      bottomRight: at(header.width - 1, header.height - 1),
      centre: at(Math.floor(header.width / 2), Math.floor(header.height / 2)),
    },
    coverage: opaquePixels / total,
    // The ink bounding box, as a fraction of the canvas.
    ink: {
      left: minX / header.width,
      top: minY / header.height,
      width: (maxX - minX + 1) / header.width,
      height: (maxY - minY + 1) / header.height,
    },
  };
}
