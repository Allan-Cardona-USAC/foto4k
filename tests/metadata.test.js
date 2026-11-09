// Pruebas de conservación de metadatos EXIF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractExif, patchExif, injectExif, readExifNumber, crc32, EXIF_TAGS } from '../public/js/core/metadata.js';

const { TAG_ORIENTATION, TAG_COLOR_SPACE, TAG_PIXEL_X, TAG_PIXEL_Y } = EXIF_TAGS;
const fixture = (name) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
const text = (bytes) => new TextDecoder('latin1').decode(bytes);

test('lee EXIF de JPG, PNG y WebP', () => {
  for (const name of ['exif-orient6.jpg', 'exif.png', 'exif.webp']) {
    const tiff = extractExif(fixture(name));
    assert.ok(tiff, `${name}: sin EXIF`);
    assert.equal(readExifNumber(tiff, TAG_ORIENTATION), 6, name);
    assert.ok(text(tiff).includes('Canon'), `${name}: falta la marca de la cámara`);
  }
});

test('archivos sin EXIF devuelven null', () => {
  assert.equal(extractExif(fixture('plain.png')), null);
  assert.equal(extractExif(fixture('plain.jpg')), null);
  assert.equal(extractExif(new Uint8Array([1, 2, 3])), null);
});

test('ajusta orientación, espacio de color y dimensiones (little y big endian)', () => {
  for (const name of ['exif-orient6.jpg', 'exif-bigendian.jpg']) {
    const original = extractExif(fixture(name));
    const patched = patchExif(original, { width: 3840, height: 2880 });
    assert.ok(patched, name);
    assert.equal(readExifNumber(patched, TAG_ORIENTATION), 1, `${name}: orientación`);
    assert.equal(readExifNumber(patched, TAG_COLOR_SPACE, true), 1, `${name}: sRGB`);
    assert.equal(readExifNumber(patched, TAG_PIXEL_X, true), 3840, `${name}: ancho`);
    assert.equal(readExifNumber(patched, TAG_PIXEL_Y, true), 2880, `${name}: alto`);
    // el original no se modifica
    assert.notEqual(readExifNumber(original, TAG_ORIENTATION), 1);
  }
});

test('EXIF dañado: se omite en lugar de corromper', () => {
  const broken = new Uint8Array([0x49, 0x49, 42, 0, 0xff, 0xff, 0, 0]);
  assert.equal(patchExif(broken, { width: 1, height: 1 }), null);
  assert.equal(patchExif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { width: 1, height: 1 }), null);
});

function pngChunks(b) {
  const chunks = [];
  let i = 8;
  while (i < b.length) {
    const len = new DataView(b.buffer, b.byteOffset).getUint32(i);
    const type = text(b.subarray(i + 4, i + 8));
    const crc = new DataView(b.buffer, b.byteOffset).getUint32(i + 8 + len);
    chunks.push({ type, len, crcOk: crc === crc32(b.subarray(i + 4, i + 8 + len)) });
    i += 12 + len;
  }
  return chunks;
}

test('inserta EXIF en PNG justo después de IHDR con CRC válido', () => {
  const tiff = patchExif(extractExif(fixture('exif-orient6.jpg')), { width: 64, height: 48 });
  const out = injectExif(fixture('plain.png'), tiff);
  const chunks = pngChunks(out);
  assert.deepEqual(chunks.slice(0, 2).map((c) => c.type), ['IHDR', 'eXIf']);
  assert.ok(chunks.every((c) => c.crcOk), 'CRC inválido');
  assert.equal(chunks.at(-1).type, 'IEND');
  assert.deepEqual(extractExif(out), tiff);
  // insertar dos veces no duplica el bloque
  const twice = injectExif(out, tiff);
  assert.equal(pngChunks(twice).filter((c) => c.type === 'eXIf').length, 1);
});

test('inserta EXIF en JPG después de JFIF y conserva la imagen', () => {
  const plain = fixture('plain.jpg');
  const tiff = patchExif(extractExif(fixture('exif.webp')), { width: 64, height: 48 });
  const out = injectExif(plain, tiff);
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
  assert.equal(out[3], 0xe0, 'APP0 (JFIF) sigue primero');
  assert.deepEqual(extractExif(out), tiff);
  assert.equal(out.length, plain.length + 10 + tiff.length);
  // los datos de imagen (desde SOS) quedan idénticos
  const sos = (b) => b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda);
  assert.deepEqual(out.subarray(sos(out)), plain.subarray(sos(plain)));
  const twice = injectExif(out, tiff);
  assert.equal(twice.length, out.length, 'no duplica el EXIF');
});

test('formatos desconocidos o EXIF inválido: el archivo queda igual', () => {
  const plain = fixture('plain.png');
  assert.equal(injectExif(plain, null), plain);
  const webp = fixture('exif.webp');
  assert.deepEqual(injectExif(webp, extractExif(webp)), webp);
});
