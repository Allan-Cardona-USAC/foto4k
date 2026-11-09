// Ajustes posteriores a la IA: fidelidad de color y nitidez opcional.

import { resizeImage } from './resample.js';

/** Desenfoque gaussiano separable sobre un Float32Array intercalado (en el lugar). */
export function gaussianBlur(data, width, height, channels, sigma) {
  if (!(sigma > 0)) return data;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(data.length);
  // Horizontal: data -> tmp
  for (let y = 0; y < height; y++) {
    const rowBase = y * width * channels;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          let xx = x + k;
          if (xx < 0) xx = 0;
          else if (xx >= width) xx = width - 1;
          acc += data[rowBase + xx * channels + c] * kernel[k + radius];
        }
        tmp[rowBase + x * channels + c] = acc;
      }
    }
  }
  // Vertical: tmp -> data
  const rowLen = width * channels;
  const acc = new Float32Array(rowLen);
  for (let y = 0; y < height; y++) {
    acc.fill(0);
    for (let k = -radius; k <= radius; k++) {
      let yy = y + k;
      if (yy < 0) yy = 0;
      else if (yy >= height) yy = height - 1;
      const w = kernel[k + radius];
      const base = yy * rowLen;
      for (let i = 0; i < rowLen; i++) acc[i] += tmp[base + i] * w;
    }
    data.set(acc, y * rowLen);
  }
  return data;
}

/**
 * Fidelidad de color: garantiza que el resultado, visto al tamaño del original,
 * tenga los mismos colores y tonos que el original.
 *
 * Se mide la diferencia de baja frecuencia (desenfocada) entre el original y el
 * resultado reducido, y se suma de vuelta al resultado. El detalle fino que aportó
 * la IA no se toca; solo se corrigen desvíos de color, brillo o contraste.
 *
 * @returns {number} desvío medio corregido (niveles de 0 a 255), útil para diagnósticos.
 */
export function preserveColors(result, W, H, original, w, h, sigma = 4) {
  if (W === w && H === h) return 0;
  const reduced = resizeImage(result, W, H, w, h, 3, new Float32Array(w * h * 3));
  const err = reduced; // se reutiliza el búfer: err = original - reducido
  let total = 0;
  for (let i = 0; i < err.length; i++) {
    const d = original[i] - err[i];
    err[i] = d;
    total += Math.abs(d);
  }
  gaussianBlur(err, w, h, 3, sigma);

  // Muestreo bilineal del error (tamaño original) en cada píxel del resultado.
  const sx = w / W;
  const sy = h / H;
  for (let Y = 0; Y < H; Y++) {
    let fy = (Y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    let y0 = Math.floor(fy);
    if (y0 > h - 1) y0 = h - 1;
    const y1 = Math.min(y0 + 1, h - 1);
    const ty = Math.min(1, fy - y0);
    for (let X = 0; X < W; X++) {
      let fx = (X + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      let x0 = Math.floor(fx);
      if (x0 > w - 1) x0 = w - 1;
      const x1 = Math.min(x0 + 1, w - 1);
      const tx = Math.min(1, fx - x0);
      const i00 = (y0 * w + x0) * 3;
      const i01 = (y0 * w + x1) * 3;
      const i10 = (y1 * w + x0) * 3;
      const i11 = (y1 * w + x1) * 3;
      const o = (Y * W + X) * 3;
      for (let c = 0; c < 3; c++) {
        const top = err[i00 + c] + (err[i01 + c] - err[i00 + c]) * tx;
        const bottom = err[i10 + c] + (err[i11 + c] - err[i10 + c]) * tx;
        result[o + c] = result[o + c] + top + (bottom - top) * ty; // Uint8Clamped redondea y recorta
      }
    }
  }
  return total / err.length;
}

/**
 * Nitidez extra (máscara de enfoque sobre la luminancia, sin halos de color).
 * @param {number} amount 0 = nada, 1 = fuerte.
 */
export function sharpen(rgb, width, height, amount, sigma = 1, threshold = 2) {
  if (!(amount > 0)) return rgb;
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  }
  const blurred = gaussianBlur(Float32Array.from(lum), width, height, 1, sigma);
  for (let i = 0; i < n; i++) {
    const diff = lum[i] - blurred[i];
    if (Math.abs(diff) <= threshold) continue; // no realzar ruido mínimo
    const d = amount * diff;
    rgb[i * 3] = rgb[i * 3] + d;
    rgb[i * 3 + 1] = rgb[i * 3 + 1] + d;
    rgb[i * 3 + 2] = rgb[i * 3 + 2] + d;
  }
  return rgb;
}
