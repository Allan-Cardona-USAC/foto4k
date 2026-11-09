// Conserva los metadatos EXIF (cámara, fecha, ubicación, etc.) de la foto original
// en el archivo ampliado. Lee JPG, PNG y WebP; escribe en PNG y JPG.
// Todo se hace con bytes: no hay dependencias.

const enc = new TextEncoder();
const EXIF_HEADER = enc.encode('Exif\0\0');

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_COLOR_SPACE = 0xa001;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;

const asBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

function startsWith(bytes, prefix, at = 0) {
  if (bytes.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

function fourCC(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/**
 * Devuelve el bloque EXIF (estructura TIFF que empieza con "II" o "MM") o null.
 * @param {ArrayBuffer|Uint8Array} input
 */
export function extractExif(input) {
  const b = asBytes(input);
  if (b[0] === 0xff && b[1] === 0xd8) return exifFromJpeg(b);
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return exifFromPng(b);
  if (fourCC(b, 0) === 'RIFF' && fourCC(b, 8) === 'WEBP') return exifFromWebp(b);
  return null;
}

function exifFromJpeg(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // fin o inicio de datos de imagen
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    if (marker === 0xe1 && startsWith(b, EXIF_HEADER, i + 4)) {
      return validTiff(b.slice(i + 10, i + 2 + len));
    }
    i += 2 + len;
  }
  return null;
}

function exifFromPng(b) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = readU32BE(b, i);
    const type = fourCC(b, i + 4);
    if (i + 12 + len > b.length) return null;
    if (type === 'eXIf') return validTiff(b.slice(i + 8, i + 8 + len));
    if (type === 'IEND') return null;
    i += 12 + len;
  }
  return null;
}

function exifFromWebp(b) {
  let i = 12;
  while (i + 8 <= b.length) {
    const type = fourCC(b, i);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    if (i + 8 + len > b.length) return null;
    if (type === 'EXIF') {
      let data = b.slice(i + 8, i + 8 + len);
      if (startsWith(data, EXIF_HEADER)) data = data.slice(6);
      return validTiff(data);
    }
    i += 8 + len + (len & 1);
  }
  return null;
}

function validTiff(t) {
  if (t.length < 8) return null;
  const le = t[0] === 0x49 && t[1] === 0x49;
  const be = t[0] === 0x4d && t[1] === 0x4d;
  if (!le && !be) return null;
  const magic = le ? t[2] | (t[3] << 8) : (t[2] << 8) | t[3];
  return magic === 42 ? t : null;
}

/**
 * Copia el EXIF y lo adapta a la imagen nueva:
 *  - Orientación = 1 (los píxeles ya salen girados correctamente).
 *  - Espacio de color = sRGB (el navegador entrega sRGB).
 *  - Dimensiones en píxeles = las nuevas.
 * Devuelve null si la estructura está dañada (mejor omitir que corromper).
 */
export function patchExif(tiff, { width, height }) {
  const t = validTiff(asBytes(tiff).slice());
  if (!t) return null;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const le = t[0] === 0x49;
  try {
    const ifd0 = dv.getUint32(4, le);
    const ifd0Entries = readIfd(dv, ifd0, le);
    setNumber(dv, ifd0Entries.get(TAG_ORIENTATION), 1, le);
    const exifPtr = ifd0Entries.get(TAG_EXIF_IFD);
    if (exifPtr) {
      const exifEntries = readIfd(dv, dv.getUint32(exifPtr.valueAt, le), le);
      setNumber(dv, exifEntries.get(TAG_COLOR_SPACE), 1, le);
      setNumber(dv, exifEntries.get(TAG_PIXEL_X), width, le);
      setNumber(dv, exifEntries.get(TAG_PIXEL_Y), height, le);
    }
    return t;
  } catch {
    return null;
  }
}

function readIfd(dv, offset, le) {
  const entries = new Map();
  if (offset < 8 || offset + 2 > dv.byteLength) throw new Error('IFD fuera de rango');
  const count = dv.getUint16(offset, le);
  if (offset + 2 + count * 12 > dv.byteLength) throw new Error('IFD truncado');
  for (let k = 0; k < count; k++) {
    const e = offset + 2 + k * 12;
    entries.set(dv.getUint16(e, le), {
      type: dv.getUint16(e + 2, le),
      count: dv.getUint32(e + 4, le),
      valueAt: e + 8,
    });
  }
  return entries;
}

function setNumber(dv, entry, value, le) {
  if (!entry || entry.count !== 1) return;
  if (entry.type === TYPE_SHORT && value <= 0xffff) dv.setUint16(entry.valueAt, value, le);
  else if (entry.type === TYPE_LONG) dv.setUint32(entry.valueAt, value, le);
}

/** Lee la orientación EXIF (1..8) o null. Útil para pruebas y diagnósticos. */
export function readExifNumber(tiff, tag, inExifIfd = false) {
  const t = validTiff(asBytes(tiff));
  if (!t) return null;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const le = t[0] === 0x49;
  let entries = readIfd(dv, dv.getUint32(4, le), le);
  if (inExifIfd) {
    const ptr = entries.get(TAG_EXIF_IFD);
    if (!ptr) return null;
    entries = readIfd(dv, dv.getUint32(ptr.valueAt, le), le);
  }
  const e = entries.get(tag);
  if (!e) return null;
  return e.type === TYPE_SHORT ? dv.getUint16(e.valueAt, le) : dv.getUint32(e.valueAt, le);
}

export const EXIF_TAGS = { TAG_ORIENTATION, TAG_COLOR_SPACE, TAG_PIXEL_X, TAG_PIXEL_Y };

/**
 * Inserta EXIF en un PNG o JPG generado por el navegador.
 * Si el formato no se reconoce o el EXIF no cabe, devuelve el archivo sin cambios.
 * @param {ArrayBuffer|Uint8Array} file
 * @param {Uint8Array} tiff
 */
export function injectExif(file, tiff) {
  const b = asBytes(file);
  if (!tiff || !validTiff(tiff)) return b;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return injectPng(b, tiff);
  if (b[0] === 0xff && b[1] === 0xd8) return injectJpeg(b, tiff);
  return b;
}

function injectPng(b, tiff) {
  // El primer bloque siempre es IHDR (13 bytes de datos): termina en el byte 33.
  if (fourCC(b, 12) !== 'IHDR') return b;
  const ihdrEnd = 8 + 12 + readU32BE(b, 8);
  const parts = [b.subarray(0, ihdrEnd), pngChunk('eXIf', tiff)];
  let i = ihdrEnd;
  while (i + 12 <= b.length) {
    const len = readU32BE(b, i);
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (fourCC(b, i + 4) !== 'eXIf') parts.push(b.subarray(i, end));
    i = end;
  }
  return concat(parts);
}

function injectJpeg(b, tiff) {
  const payloadLen = 2 + EXIF_HEADER.length + tiff.length;
  if (payloadLen > 0xffff) return b; // un segmento APP1 no puede superar 64 KB
  const app1 = new Uint8Array(2 + payloadLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = payloadLen >> 8;
  app1[3] = payloadLen & 0xff;
  app1.set(EXIF_HEADER, 4);
  app1.set(tiff, 10);

  const parts = [b.subarray(0, 2)];
  let i = 2;
  let inserted = false;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    const end = i + 2 + len;
    if (end > b.length) return b;
    const isApp0 = marker === 0xe0;
    const isExif = marker === 0xe1 && startsWith(b, EXIF_HEADER, i + 4);
    if (!inserted && !isApp0) {
      parts.push(app1);
      inserted = true;
    }
    if (!isExif) parts.push(b.subarray(i, end));
    i = end;
  }
  if (!inserted) parts.push(app1);
  parts.push(b.subarray(i));
  return concat(parts);
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32BE(out, 0, data.length);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  writeU32BE(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function readU32BE(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}
function writeU32BE(b, i, v) {
  b[i] = (v >>> 24) & 0xff;
  b[i + 1] = (v >>> 16) & 0xff;
  b[i + 2] = (v >>> 8) & 0xff;
  b[i + 3] = v & 0xff;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
