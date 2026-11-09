// Pruebas del núcleo de procesamiento (se ejecutan con `npm test`, sin dependencias).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { computeTargetSize, planUpscale, SIZE_PRESETS } from '../public/js/core/plan.js';
import { resizeImage, StreamingResizer, splitRGBA, mergeRGBA, resizeRGBAPremultiplied } from '../public/js/core/resample.js';
import { planTiles } from '../public/js/core/tiles.js';
import { runUpscale, tileFidelityError } from '../public/js/core/pipeline.js';
import { preserveColors, sharpen } from '../public/js/core/enhance.js';

const fixture = (name) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

// ---------- utilidades de prueba ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function noiseImage(w, h, seed = 1, channels = 3) {
  const r = rng(seed);
  const a = new Uint8ClampedArray(w * h * channels);
  for (let i = 0; i < a.length; i++) a[i] = Math.floor(r() * 256);
  return a;
}
function smoothImage(w, h) {
  const a = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      a[i] = 128 + 100 * Math.sin(x / 9);
      a[i + 1] = 128 + 90 * Math.cos(y / 11);
      a[i + 2] = 128 + 80 * Math.sin((x + y) / 15);
    }
  return a;
}
function nearestUpscale(src, w, h, s) {
  const W = w * s;
  const out = new Uint8ClampedArray(W * h * s * 3);
  for (let y = 0; y < h * s; y++)
    for (let x = 0; x < W; x++) {
      const si = ((Math.floor(y / s) * w) + Math.floor(x / s)) * 3;
      const di = (y * W + x) * 3;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
    }
  return out;
}
function mae(a, b) {
  assert.equal(a.length, b.length);
  let t = 0;
  for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
  return t / a.length;
}
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

// ---------- tamaños ----------
test('4K: el lado largo queda en 3840 y se respeta la proporción', () => {
  assert.deepEqual(computeTargetSize(1280, 960, '4k'), { width: 3840, height: 2880 });
  assert.deepEqual(computeTargetSize(960, 1280, '4k'), { width: 2880, height: 3840 });
  assert.deepEqual(computeTargetSize(1920, 1080, '4k'), { width: 3840, height: 2160 });
});

test('4K UHD: cabe en 3840×2160 (o 2160×3840 si es vertical)', () => {
  assert.deepEqual(computeTargetSize(1280, 960, '4k-uhd'), { width: 2880, height: 2160 });
  assert.deepEqual(computeTargetSize(960, 1280, '4k-uhd'), { width: 2160, height: 2880 });
  assert.deepEqual(computeTargetSize(1000, 1000, '4k-uhd'), { width: 2160, height: 2160 });
});

test('×2 y ×4 multiplican exacto', () => {
  assert.deepEqual(computeTargetSize(333, 222, 'x2'), { width: 666, height: 444 });
  assert.deepEqual(computeTargetSize(333, 222, 'x4'), { width: 1332, height: 888 });
});

// ---------- plan de pasadas ----------
test('no amplía si la foto ya es 4K o más', () => {
  const plan = planUpscale({ width: 4000, height: 3000 }, computeTargetSize(4000, 3000, '4k'), 4);
  assert.equal(plan.needed, false);
});

test('modelo ×4 con foto de 1000 px: una pasada y reducción fina', () => {
  const target = computeTargetSize(1000, 750, '4k');
  const plan = planUpscale({ width: 1000, height: 750 }, target, 4);
  assert.equal(plan.passes.length, 1);
  assert.equal(plan.preScale, null);
  assert.deepEqual(plan.passes[0].output, { width: 4000, height: 3000 });
  assert.deepEqual(plan.passes[0].next, target);
});

test('modelo ×2 con foto de 1000 px: dos pasadas, el intermedio se ajusta', () => {
  const target = computeTargetSize(1000, 750, '4k');
  const plan = planUpscale({ width: 1000, height: 750 }, target, 2);
  assert.equal(plan.passes.length, 2);
  assert.deepEqual(plan.passes[0].input, { width: 1000, height: 750 });
  assert.deepEqual(plan.passes[1].input, { width: 1920, height: 1440 });
  assert.deepEqual(plan.passes[1].output, { width: 3840, height: 2880 });
});

test('foto muy pequeña: se pre-amplía con Lanczos antes de la IA', () => {
  const target = computeTargetSize(300, 200, '4k');
  const plan = planUpscale({ width: 300, height: 200 }, target, 2);
  assert.deepEqual(plan.preScale, { width: 960, height: 640 });
  assert.deepEqual(plan.passes.at(-1).output, { width: 3840, height: 2560 });
});

test('invariantes del plan en muchos casos aleatorios', () => {
  const r = rng(42);
  for (let k = 0; k < 2000; k++) {
    const w = 1 + Math.floor(r() * 4000);
    const h = 1 + Math.floor(r() * 4000);
    const preset = Object.keys(SIZE_PRESETS)[k % 4];
    const scale = k % 3 === 0 ? 2 : 4;
    const target = computeTargetSize(w, h, preset);
    const plan = planUpscale({ width: w, height: h }, target, scale);
    if (!plan.needed) {
      assert.ok(target.width <= w && target.height <= h || Math.max(target.width / w, target.height / h) <= 1);
      continue;
    }
    const first = plan.passes[0].input;
    // nunca se reduce el original
    assert.ok(first.width >= w && first.height >= h, `reduce el original ${w}x${h} -> ${first.width}x${first.height}`);
    plan.passes.forEach((p, i) => {
      assert.equal(p.output.width, p.input.width * scale);
      assert.equal(p.output.height, p.input.height * scale);
      const nxt = i + 1 < plan.passes.length ? plan.passes[i + 1].input : target;
      assert.deepEqual(p.next, nxt);
      // un intermedio de IA nunca baja del tamaño del original
      assert.ok(p.next.width >= Math.min(w, target.width) && p.next.height >= Math.min(h, target.height));
    });
    const last = plan.passes.at(-1).output;
    assert.ok(last.width >= target.width && last.height >= target.height, 'la IA debe alcanzar el tamaño final');
    assert.ok(plan.passes.length <= 2);
  }
});

// ---------- remuestreo ----------
test('Lanczos coincide con Pillow (referencia en precisión flotante)', () => {
  const meta = JSON.parse(new TextDecoder().decode(fixture('lanczos.json')));
  for (const [name, m] of Object.entries(meta)) {
    const src = fixture(`lanczos-${name}-src.rgb`);
    const ref = fixture(`lanczos-${name}-pil.rgb`);
    const out = resizeImage(src, m.srcW, m.srcH, m.dstW, m.dstH, 3);
    const md = maxDiff(out, ref);
    const avg = mae(out, ref);
    assert.ok(md <= 1 && avg < 0.01, `${name}: diferencia máx ${md}, media ${avg.toFixed(3)}`);
  }
});

test('redimensionar por bandas da exactamente lo mismo que de una vez', () => {
  const W = 173, H = 131;
  const src = noiseImage(W, H, 3);
  for (const [dw, dh] of [[400, 77], [61, 300], [173, 131], [173, 50], [90, 131]]) {
    const whole = resizeImage(src, W, H, dw, dh, 3);
    const r = rng(dw * dh);
    const s = new StreamingResizer(W, H, dw, dh, 3);
    let row = 0;
    while (row < H) {
      const n = Math.min(H - row, 1 + Math.floor(r() * 40));
      s.pushRows(src, n, row * W * 3);
      row += n;
    }
    const banded = s.finish();
    assert.deepEqual(banded, whole, `bandas ${dw}x${dh}`);
  }
});

test('una imagen de color plano sigue plana al ampliar y reducir', () => {
  const src = new Uint8ClampedArray(40 * 30 * 3).fill(173);
  for (const [w, h] of [[160, 120], [13, 9], [41, 300]]) {
    const out = resizeImage(src, 40, 30, w, h, 3);
    assert.ok(out.every((v) => v === 173));
  }
});

test('alfa: se separa, se une y se amplía sin halos', () => {
  const w = 8, h = 8;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba.set([200, 30, 30, i % w < 4 ? 255 : 0], i * 4);
  }
  const { rgb, alpha } = splitRGBA(rgba, w, h);
  assert.ok(alpha);
  assert.deepEqual(mergeRGBA(rgb, alpha, w, h), rgba);
  const big = resizeRGBAPremultiplied(rgba, w, h, 32, 32);
  // donde hay algo de opacidad, el color debe seguir siendo rojo (sin bordes oscuros)
  for (let i = 0; i < 32 * 32; i++) {
    if (big[i * 4 + 3] > 20) assert.ok(big[i * 4] > 170, `halo oscuro en ${i}`);
  }
  const opaque = splitRGBA(new Uint8ClampedArray(16).fill(255), 2, 2);
  assert.equal(opaque.alpha, null);
});

// ---------- bloques ----------
test('los bloques cubren cada píxel exactamente una vez y su contexto es constante', () => {
  for (const [W, H, core, pad] of [[1000, 750, 128, 16], [130, 70, 128, 16], [161, 160, 128, 16], [50, 50, 64, 8], [1, 1, 64, 8], [257, 33, 64, 16]]) {
    const tiles = planTiles(W, H, core, pad);
    const cover = new Uint8Array(W * H);
    for (const t of tiles) {
      assert.ok(t.ex <= t.x && t.ey <= t.y, 'el contexto empieza antes del bloque');
      assert.ok(t.ex + t.ew >= t.x + t.w && t.ey + t.eh >= t.y + t.h, 'el contexto contiene al bloque');
      assert.ok(t.ex >= 0 && t.ey >= 0 && t.ex + t.ew <= W && t.ey + t.eh <= H, 'dentro de la imagen');
      if (W >= core + 2 * pad) assert.equal(t.ew, core + 2 * pad);
      if (H >= core + 2 * pad) assert.equal(t.eh, core + 2 * pad);
      for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) cover[y * W + x]++;
    }
    assert.ok(cover.every((c) => c === 1), `${W}x${H}: cobertura incompleta o doble`);
  }
});

// ---------- orquestador ----------
const nearestModel = (s, padTo = 1) => async ({ data, width, height }) => {
  // simula el relleno del procesador de Swin2SR (múltiplos de padTo, abajo/derecha)
  const pw = Math.ceil(width / padTo) * padTo;
  const ph = Math.ceil(height / padTo) * padTo;
  const padded = new Uint8ClampedArray(pw * ph * 3);
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const si = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 3;
      padded.set(data.subarray(si, si + 3), (y * pw + x) * 3);
    }
  return { data: nearestUpscale(padded, pw, ph, s), width: pw * s, height: ph * s };
};

test('unir bloques reproduce exactamente la ampliación de la imagen completa', async () => {
  const w = 203, h = 157;
  const src = noiseImage(w, h, 9);
  const target = { width: w * 4, height: h * 4 };
  const plan = planUpscale({ width: w, height: h }, target, 4);
  let tilesSeen = 0;
  const res = await runUpscale({
    rgb: src, width: w, height: h, plan, scale: 4,
    upscaleTile: nearestModel(4, 8), tileCore: 64, tilePad: 16,
    onTile: () => { tilesSeen++; },
  });
  assert.equal(tilesSeen, 12); // ceil(203/64) × ceil(157/64)
  assert.deepEqual(res.rgb, nearestUpscale(src, w, h, 4));
});

test('dos pasadas con modelo ×2 y reducción final al tamaño 4K', async () => {
  const w = 1000, h = 750;
  const src = smoothImage(w, h);
  const target = computeTargetSize(w, h, '4k');
  const plan = planUpscale({ width: w, height: h }, target, 2);
  const events = [];
  const res = await runUpscale({
    rgb: src, width: w, height: h, plan, scale: 2,
    upscaleTile: nearestModel(2, 8), tileCore: 192, tilePad: 16,
    onProgress: (e) => events.push(e),
  });
  assert.equal(res.width, 3840);
  assert.equal(res.height, 2880);
  assert.equal(res.rgb.length, 3840 * 2880 * 3);
  const last = events.filter((e) => e.stage === 'upscale').at(-1);
  assert.equal(last.pass, 2);
  assert.ok(Math.abs(last.fraction - 1) < 1e-9);
  // el resultado reducido al tamaño original debe parecerse al original
  const back = resizeImage(res.rgb, 3840, 2880, w, h, 3);
  assert.ok(mae(back, src) < 2.5, `diferencia ${mae(back, src)}`);
});

test('detector de GPU defectuosa: 0 si es fiel, alto si es basura', () => {
  const w = 24, h = 16;
  const src = noiseImage(w, h, 5);
  const good = nearestUpscale(src, w, h, 4);
  assert.equal(tileFidelityError(src, w, h, good, w * 4, 4), 0);
  const black = new Uint8ClampedArray(good.length);
  assert.ok(tileFidelityError(src, w, h, black, w * 4, 4) > 60);
});

// ---------- fidelidad de color y nitidez ----------
test('fidelidad de color corrige un desvío sin borrar el detalle fino', () => {
  const w = 120, h = 90;
  const orig = smoothImage(w, h);
  const W = w * 4, H = h * 4;
  const ai = resizeImage(orig, w, h, W, H, 3);
  for (let i = 0; i < W * H; i++) {
    ai[i * 3] = ai[i * 3] + 22; // la "IA" tiñó de rojo
    ai[i * 3 + 2] = ai[i * 3 + 2] - 15; // y quitó azul
    const x = i % W, y = Math.floor(i / W);
    const checker = (x + y) % 2 ? 6 : -6; // detalle fino de la IA
    ai[i * 3 + 1] = ai[i * 3 + 1] + checker;
  }
  const before = mae(resizeImage(ai, W, H, w, h, 3), orig);
  const detailBefore = Math.abs(ai[(10 * W + 10) * 3 + 1] - ai[(10 * W + 11) * 3 + 1]);
  preserveColors(ai, W, H, orig, w, h);
  const after = mae(resizeImage(ai, W, H, w, h, 3), orig);
  const detailAfter = Math.abs(ai[(10 * W + 10) * 3 + 1] - ai[(10 * W + 11) * 3 + 1]);
  assert.ok(before > 10, `antes ${before}`);
  assert.ok(after < 1.5, `después ${after}`);
  assert.ok(Math.abs(detailAfter - detailBefore) <= 1, 'el detalle fino se conserva');
});

test('nitidez: 0 no cambia nada; >0 aumenta el contraste de un borde', () => {
  const w = 40, h = 10;
  const img = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) img.fill(i % w < 20 ? 80 : 160, i * 3, i * 3 + 3);
  const copy = Uint8ClampedArray.from(img);
  sharpen(copy, w, h, 0);
  assert.deepEqual(copy, img);
  sharpen(copy, w, h, 1);
  const row = 5 * w;
  assert.ok(copy[(row + 19) * 3] < 80 && copy[(row + 20) * 3] > 160, 'el borde se realza');
  assert.equal(copy[(row + 2) * 3], 80, 'las zonas planas no cambian');
});
