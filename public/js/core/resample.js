// Remuestreo de alta calidad (Lanczos-3, con antialias al reducir), al estilo de Pillow.
// Funciona por filas en "streaming": se le pueden entregar bandas de filas a medida
// que la IA las termina, sin tener nunca la imagen intermedia completa en memoria.

const LANCZOS_SUPPORT = 3;

function lanczos3(x) {
  if (x === 0) return 1;
  if (x <= -LANCZOS_SUPPORT || x >= LANCZOS_SUPPORT) return 0;
  const px = Math.PI * x;
  return (LANCZOS_SUPPORT * Math.sin(px) * Math.sin(px / LANCZOS_SUPPORT)) / (px * px);
}

/**
 * Precalcula, para cada píxel de salida, qué píxeles de entrada lo forman y con qué peso.
 */
export function computeCoefficients(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(1, scale);
  const support = LANCZOS_SUPPORT * filterScale;
  const maxTaps = Math.ceil(support) * 2 + 1;
  const starts = new Int32Array(outSize);
  const counts = new Int32Array(outSize);
  const weights = new Float32Array(outSize * maxTaps);

  for (let x = 0; x < outSize; x++) {
    const center = (x + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    const count = Math.max(1, xmax - xmin);
    let sum = 0;
    const base = x * maxTaps;
    for (let j = 0; j < count; j++) {
      const w = lanczos3((j + xmin - center + 0.5) / filterScale);
      weights[base + j] = w;
      sum += w;
    }
    if (sum !== 0) {
      for (let j = 0; j < count; j++) weights[base + j] /= sum;
    } else {
      weights[base] = 1;
    }
    starts[x] = Math.min(xmin, inSize - 1);
    counts[x] = Math.min(count, inSize - starts[x]);
  }
  return { starts, counts, weights, maxTaps };
}

/**
 * Redimensiona una imagen recibida por bandas de filas.
 * `out` puede ser Uint8ClampedArray (redondea y recorta solo) o Float32Array.
 */
export class StreamingResizer {
  constructor(srcW, srcH, dstW, dstH, channels, out) {
    this.srcW = srcW;
    this.srcH = srcH;
    this.dstW = dstW;
    this.dstH = dstH;
    this.c = channels;
    this.out = out || new Uint8ClampedArray(dstW * dstH * channels);
    if (this.out.length !== dstW * dstH * channels) {
      throw new Error('El búfer de salida no tiene el tamaño esperado');
    }
    this.rowsIn = 0; // filas de entrada recibidas
    this.nextOut = 0; // siguiente fila de salida por calcular
    this.identityH = srcW === dstW;
    this.identityV = srcH === dstH;
    this.hc = this.identityH ? null : computeCoefficients(srcW, dstW);
    this.vc = this.identityV ? null : computeCoefficients(srcH, dstH);
    this.rows = new Map(); // fila de entrada -> Float32Array (ya remuestreada en horizontal)
  }

  get done() {
    return this.nextOut >= this.dstH;
  }

  /**
   * Entrega `rowCount` filas consecutivas (empezando en la fila `this.rowsIn`).
   * `data` contiene las filas una tras otra con `srcW * channels` valores por fila,
   * a partir de `offset`.
   */
  pushRows(data, rowCount, offset = 0) {
    const { srcW, dstW, c } = this;
    const stride = srcW * c;
    if (this.rowsIn + rowCount > this.srcH) throw new Error('Se recibieron más filas de las esperadas');

    if (this.identityH && this.identityV) {
      const start = this.rowsIn * stride;
      this.out.set(data.subarray(offset, offset + rowCount * stride), start);
      this.rowsIn += rowCount;
      this.nextOut = this.rowsIn;
      return;
    }

    for (let r = 0; r < rowCount; r++) {
      const rowStart = offset + r * stride;
      let row;
      if (this.identityH) {
        row = Float32Array.from(data.subarray(rowStart, rowStart + stride));
      } else {
        row = new Float32Array(dstW * c);
        const { starts, counts, weights, maxTaps } = this.hc;
        for (let x = 0; x < dstW; x++) {
          const s0 = starts[x];
          const n = counts[x];
          const wb = x * maxTaps;
          for (let ch = 0; ch < c; ch++) {
            let acc = 0;
            let p = rowStart + s0 * c + ch;
            for (let j = 0; j < n; j++, p += c) acc += data[p] * weights[wb + j];
            row[x * c + ch] = acc;
          }
        }
      }
      this.rows.set(this.rowsIn + r, row);
    }
    this.rowsIn += rowCount;
    this.#emit();
  }

  #emit() {
    const { dstW, c, out } = this;
    const rowLen = dstW * c;
    while (this.nextOut < this.dstH) {
      const y = this.nextOut;
      if (this.identityV) {
        if (y >= this.rowsIn) break;
        out.set(this.rows.get(y), y * rowLen); // set() convierte (y recorta) al tipo de salida
        this.rows.delete(y);
      } else {
        const { starts, counts, weights, maxTaps } = this.vc;
        const s0 = starts[y];
        const n = counts[y];
        if (s0 + n > this.rowsIn) break;
        const wb = y * maxTaps;
        const acc = (this.acc ??= new Float32Array(rowLen));
        acc.fill(0);
        for (let j = 0; j < n; j++) {
          const row = this.rows.get(s0 + j);
          const w = weights[wb + j];
          for (let i = 0; i < rowLen; i++) acc[i] += row[i] * w;
        }
        out.set(acc, y * rowLen);
        // Liberar filas que ya no necesitará ninguna salida posterior.
        const keepFrom = y + 1 < this.dstH ? starts[y + 1] : this.rowsIn;
        for (const key of this.rows.keys()) {
          if (key < keepFrom) this.rows.delete(key);
        }
      }
      this.nextOut++;
    }
  }

  finish() {
    if (this.rowsIn !== this.srcH) throw new Error(`Faltan filas: ${this.rowsIn} de ${this.srcH}`);
    if (!this.done) throw new Error('El redimensionado no terminó');
    this.rows.clear();
    return this.out;
  }
}

/** Redimensiona una imagen completa de una sola vez. */
export function resizeImage(src, srcW, srcH, dstW, dstH, channels, out) {
  const r = new StreamingResizer(srcW, srcH, dstW, dstH, channels, out);
  r.pushRows(src, srcH, 0);
  return r.finish();
}

/** Separa RGBA en RGB y alfa; `alpha` es null si la imagen es totalmente opaca. */
export function splitRGBA(rgba, width, height) {
  const n = width * height;
  const rgb = new Uint8ClampedArray(n * 3);
  let alpha = null;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
    if (rgba[i * 4 + 3] !== 255 && !alpha) alpha = new Uint8ClampedArray(n).fill(255, 0, n);
  }
  if (alpha) for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 3];
  return { rgb, alpha };
}

/** Une RGB y alfa (o 255) en RGBA. */
export function mergeRGBA(rgb, alpha, width, height) {
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha ? alpha[i] : 255;
  }
  return rgba;
}

/**
 * Ampliación clásica de RGBA con alfa premultiplicado (evita halos en bordes transparentes).
 */
export function resizeRGBAPremultiplied(rgba, srcW, srcH, dstW, dstH) {
  const n = srcW * srcH;
  const pre = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    pre[i * 4] = rgba[i * 4] * a;
    pre[i * 4 + 1] = rgba[i * 4 + 1] * a;
    pre[i * 4 + 2] = rgba[i * 4 + 2] * a;
    pre[i * 4 + 3] = rgba[i * 4 + 3];
  }
  const outF = resizeImage(pre, srcW, srcH, dstW, dstH, 4, new Float32Array(dstW * dstH * 4));
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let i = 0; i < dstW * dstH; i++) {
    const a = Math.min(255, Math.max(0, outF[i * 4 + 3]));
    out[i * 4 + 3] = a;
    if (a > 0.5) {
      const k = 255 / a;
      out[i * 4] = outF[i * 4] * k;
      out[i * 4 + 1] = outF[i * 4 + 1] * k;
      out[i * 4 + 2] = outF[i * 4 + 2] * k;
    }
  }
  return out;
}
