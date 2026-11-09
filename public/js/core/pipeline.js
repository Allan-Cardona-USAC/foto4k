// Orquestador: pre-ampliación, pasadas de IA por bloques y redimensionado final.
// No depende de la IA concreta: recibe una función `upscaleTile` (en las pruebas es
// un simulador; en el navegador es el modelo Swin2SR de Transformers.js).

import { planTiles, extractRegion, blitRegion } from './tiles.js';
import { StreamingResizer, resizeImage } from './resample.js';

/**
 * @param {object} p
 * @param {Uint8ClampedArray} p.rgb       Píxeles RGB del original.
 * @param {number} p.width
 * @param {number} p.height
 * @param {ReturnType<import('./plan.js').planUpscale>} p.plan
 * @param {number} p.scale                Escala del modelo (2 o 4).
 * @param {(tile:{data:Uint8ClampedArray,width:number,height:number}, info:object) =>
 *   Promise<{data:Uint8ClampedArray|Uint8Array,width:number,height:number}>} p.upscaleTile
 * @param {number} p.tileCore
 * @param {number} p.tilePad
 * @param {(info:object) => void} [p.onProgress]
 * @param {(info:object) => void|Promise<void>} [p.onTile]   Recibe cada bloque terminado (vista previa).
 */
export async function runUpscale({ rgb, width, height, plan, scale, upscaleTile, tileCore, tilePad, onProgress, onTile }) {
  if (!plan.needed) return { rgb, width, height };

  let cur = rgb;
  let curW = width;
  let curH = height;

  if (plan.preScale) {
    onProgress?.({ stage: 'prescale' });
    cur = resizeImage(rgb, width, height, plan.preScale.width, plan.preScale.height, 3);
    curW = plan.preScale.width;
    curH = plan.preScale.height;
  }

  const allTiles = plan.passes.map((pass) => planTiles(pass.input.width, pass.input.height, tileCore, tilePad));
  const totalWork = allTiles.flat().reduce((s, t) => s + t.ew * t.eh, 0);
  let doneWork = 0;
  let firstTileDoneAt = 0;
  let workAtFirstTile = 0;

  for (let p = 0; p < plan.passes.length; p++) {
    const pass = plan.passes[p];
    if (curW !== pass.input.width || curH !== pass.input.height) {
      throw new Error('Plan inconsistente: la entrada de la pasada no coincide');
    }
    const tiles = allTiles[p];
    const outW = pass.output.width;
    const outH = pass.output.height;
    const sink = new StreamingResizer(outW, outH, pass.next.width, pass.next.height, 3);
    const band = new Uint8ClampedArray(outW * tileCore * scale * 3);
    let bandRow = -1;
    let bandRows = 0;

    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t.row !== bandRow) {
        if (bandRow >= 0) sink.pushRows(band, bandRows * scale);
        bandRow = t.row;
        bandRows = t.h;
      }

      const input = extractRegion(cur, curW, t.ex, t.ey, t.ew, t.eh);
      const out = await upscaleTile(
        { data: input, width: t.ew, height: t.eh },
        { pass: p, tileIndex: i, tileCount: tiles.length },
      );
      if (!out || out.width < t.ew * scale || out.height < t.eh * scale) {
        throw new Error(
          `La IA devolvió un bloque de ${out?.width}×${out?.height}; se esperaba ${t.ew * scale}×${t.eh * scale}`,
        );
      }
      const cx = (t.x - t.ex) * scale;
      const cy = (t.y - t.ey) * scale;
      const cw = t.w * scale;
      const ch = t.h * scale;
      blitRegion(out.data, out.width, cx, cy, cw, ch, band, outW, t.x * scale, 0);

      if (onTile) {
        const core = extractRegion(out.data, out.width, cx, cy, cw, ch);
        await onTile({ pass: p, passes: plan.passes.length, x: t.x * scale, y: t.y * scale, w: cw, h: ch, outW, outH, data: core });
      }

      doneWork += t.ew * t.eh;
      const now = nowMs();
      let etaMs = null;
      if (!firstTileDoneAt) {
        firstTileDoneAt = now; // el primer bloque incluye la compilación de la GPU: no cuenta para el ETA
        workAtFirstTile = doneWork;
      } else if (doneWork > workAtFirstTile) {
        const rate = (doneWork - workAtFirstTile) / (now - firstTileDoneAt);
        etaMs = (totalWork - doneWork) / rate;
      }
      onProgress?.({
        stage: 'upscale',
        pass: p + 1,
        passes: plan.passes.length,
        tile: i + 1,
        tiles: tiles.length,
        fraction: doneWork / totalWork,
        etaMs,
      });
    }
    sink.pushRows(band, bandRows * scale);
    cur = sink.finish();
    curW = pass.next.width;
    curH = pass.next.height;
  }

  return { rgb: cur, width: curW, height: curH };
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Comprueba que un bloque ampliado "se parece" a su entrada: se reduce por promedio
 * de bloques s×s y se compara. Un modelo que funciona da un error bajo (< ~12);
 * una GPU que devuelve basura (negro, ruido, NaN) da valores muy altos.
 * @returns {number} error medio absoluto en niveles 0..255
 */
export function tileFidelityError(input, inW, inH, output, outW, scale) {
  let total = 0;
  const area = scale * scale;
  for (let y = 0; y < inH; y++) {
    for (let x = 0; x < inW; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let dy = 0; dy < scale; dy++) {
          const rowBase = ((y * scale + dy) * outW + x * scale) * 3 + c;
          for (let dx = 0; dx < scale; dx++) acc += output[rowBase + dx * 3];
        }
        total += Math.abs(acc / area - input[(y * inW + x) * 3 + c]);
      }
    }
  }
  return total / (inW * inH * 3);
}
