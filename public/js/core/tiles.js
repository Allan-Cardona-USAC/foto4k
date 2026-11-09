// División de la imagen en bloques (tiles) con margen de contexto.
// La IA procesa cada bloque con un margen alrededor y solo se conserva el centro,
// así no se notan las uniones y la memoria de la GPU se mantiene acotada.

/**
 * @param {number} width
 * @param {number} height
 * @param {number} core  Lado del bloque útil (en píxeles de entrada).
 * @param {number} pad   Margen de contexto a cada lado.
 * @returns {Array<{x:number,y:number,w:number,h:number,ex:number,ey:number,ew:number,eh:number,row:number}>}
 *   (x,y,w,h) = zona útil; (ex,ey,ew,eh) = zona que se envía a la IA.
 *   Todas las zonas extendidas tienen el mismo tamaño (core + 2·pad) cuando la imagen
 *   es más grande que eso, lo que acelera la GPU (misma forma de tensor siempre).
 */
export function planTiles(width, height, core, pad) {
  if (core <= 0) throw new Error('Tamaño de bloque inválido');
  const ext = core + 2 * pad;
  const tiles = [];
  let row = 0;
  for (let y = 0; y < height; y += core, row++) {
    const h = Math.min(core, height - y);
    const [ey, eh] = extendWindow(y, height, pad, ext);
    for (let x = 0; x < width; x += core) {
      const w = Math.min(core, width - x);
      const [ex, ew] = extendWindow(x, width, pad, ext);
      tiles.push({ x, y, w, h, ex, ey, ew, eh, row });
    }
  }
  return tiles;
}

function extendWindow(start, total, pad, ext) {
  if (total <= ext) return [0, total];
  let s = start - pad;
  let e = s + ext;
  if (s < 0) {
    s = 0;
    e = ext;
  }
  if (e > total) {
    e = total;
    s = total - ext;
  }
  return [s, e - s];
}

/** Copia una región RGB (o con `channels` canales) de una imagen a un búfer nuevo. */
export function extractRegion(src, srcW, x, y, w, h, channels = 3) {
  const out = new Uint8ClampedArray(w * h * channels);
  const rowLen = w * channels;
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * srcW + x) * channels;
    out.set(src.subarray(s, s + rowLen), r * rowLen);
  }
  return out;
}

/** Copia una región de `src` (ancho srcW) a `dst` (ancho dstW) en (dx, dy). */
export function blitRegion(src, srcW, sx, sy, w, h, dst, dstW, dx, dy, channels = 3) {
  const rowLen = w * channels;
  for (let r = 0; r < h; r++) {
    const s = ((sy + r) * srcW + sx) * channels;
    const d = ((dy + r) * dstW + dx) * channels;
    dst.set(src.subarray(s, s + rowLen), d);
  }
}
