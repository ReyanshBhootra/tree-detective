// Reads a Tree Detective tag from a photo. ZXing (the same engine phone
// scanner apps use) reads the QR first, since it copes with glare, angles and
// photos of screens; jsQR is a second try; an AI model reading the printed code
// is the last resort. Handles JPEG, PNG and iPhone HEIC photos, all offline.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

// Pulls the tree code and key out of a tag link (…/?tree=TD-001&k=ABC123)
// or the typed code printed on the tag (TD-001-ABC123).
export function parseTagText(input) {
  const s = String(input ?? '').trim();
  try {
    const url = new URL(s);
    const code = url.searchParams.get('tree');
    if (code) return { code: code.toUpperCase(), key: url.searchParams.get('k')?.toUpperCase() ?? null };
  } catch { /* not a link */ }
  const m = s.toUpperCase().match(/\b([A-Z]{1,4}-\d{1,4})(?:[-\s]+([A-Z0-9]{4,12}))?\b/);
  return m ? { code: m[1], key: m[2] ?? null } : null;
}

export function sniffMime(buffer, given = '') {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  const brand = buffer.subarray(4, 12).toString('latin1');
  if (/^ftyp(heic|heix|hevc|mif1|msf1|heif)/.test(brand)) return 'image/heic';
  return given || 'application/octet-stream';
}

async function pixels(buffer, mime) {
  if (mime === 'image/jpeg') {
    const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 });
    return { data: img.data, width: img.width, height: img.height };
  }
  if (mime === 'image/png') {
    const img = PNG.sync.read(buffer);
    return { data: img.data, width: img.width, height: img.height };
  }
  if (mime === 'image/heic' || mime === 'image/heif') {
    const decode = (await import('heic-decode')).default;
    const img = await decode({ buffer });
    return { data: img.data, width: img.width, height: img.height };
  }
  return null;
}

// Nearest-neighbour shrink, so phone photos decode fast.
function shrink(img, max) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / scale) * img.width;
    for (let x = 0; x < width; x++) {
      const s = (sy + Math.floor(x / scale)) * 4;
      const d = (y * width + x) * 4;
      data[d] = img.data[s]; data[d + 1] = img.data[s + 1]; data[d + 2] = img.data[s + 2]; data[d + 3] = 255;
    }
  }
  return { data, width, height };
}

let zxing = null;
async function zxingReader() {
  if (!zxing) {
    zxing = (async () => {
      const mod = await import('zxing-wasm/reader');
      const wasm = createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm');
      mod.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(wasm) }, fireImmediately: true });
      return mod;
    })();
  }
  return zxing;
}

const ZX_OPTS = { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 1 };

// input: image file bytes (JPEG/PNG) or { data, width, height } pixels.
export async function zxingRead(input) {
  const { readBarcodes } = await zxingReader();
  const arg = input.data ? { data: new Uint8ClampedArray(input.data.buffer, input.data.byteOffset, input.data.length), width: input.width, height: input.height, colorSpace: 'srgb' } : new Uint8Array(input);
  const hits = await readBarcodes(arg, ZX_OPTS);
  return hits.find((h) => h.isValid && h.text)?.text ?? null;
}

export function findQr(img) {
  for (const max of [900, 1600]) {
    const small = shrink(img, max);
    const hit = jsQR(new Uint8ClampedArray(small.data.buffer, small.data.byteOffset, small.data.length), small.width, small.height, { inversionAttempts: 'attemptBoth' });
    if (hit?.data) return hit.data;
    if (small === img) break;
  }
  return null;
}

// readText(buffer, mime) is an optional AI fallback that returns any text it sees on the tag.
export async function readTag(buffer, givenMime, { readText } = {}) {
  const mime = sniffMime(buffer, givenMime);
  const heic = mime === 'image/heic' || mime === 'image/heif';
  let img = null;
  const tries = [
    // JPEG and PNG go straight to ZXing, which decodes them itself (fast).
    async () => (heic ? null : zxingRead(buffer)),
    async () => { img = heic || !img ? await pixels(buffer, mime) : img; return img && zxingRead(img); },
    async () => { img ??= await pixels(buffer, mime); return img && findQr(img); },
  ];
  for (const attempt of tries) {
    try {
      const tag = parseTagText(await attempt());
      if (tag) return { ...tag, via: 'qr' };
    } catch (e) {
      console.warn('QR decode attempt failed:', e.message);
    }
  }
  if (readText) {
    try {
      const timeout = new Promise((_, no) => setTimeout(() => no(new Error('took too long')), 8000));
      const tag = parseTagText(await Promise.race([readText(buffer, mime), timeout]));
      if (tag) return { ...tag, via: 'ai' };
    } catch (e) {
      console.warn('tag reading failed:', e.message);
    }
  }
  return null;
}
