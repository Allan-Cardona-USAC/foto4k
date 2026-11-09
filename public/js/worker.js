// Worker de procesamiento: corre la IA fuera del hilo principal para que la página
// no se congele. Se comunica con app.js por mensajes.
//
// Mensajes que recibe:
//   { type: 'process', width, height, rgba, modelId, target, options }
// Mensajes que envía:
//   { type: 'progress', stage, ... }   avance (descarga, bloques, ajustes, guardado)
//   { type: 'device', device }          'webgpu' | 'wasm' | 'classic'
//   { type: 'tile', ... bitmap }        bloque terminado (vista previa)
//   { type: 'restart' }                 se reinicia con el procesador tras un fallo de GPU
//   { type: 'done', blob | rgba, ... }  resultado final
//   { type: 'error', message, detail }

import { MODELS, TRANSFORMERS_URL, TILE_PAD } from './models.js';
import { planUpscale } from './core/plan.js';
import { runUpscale, tileFidelityError } from './core/pipeline.js';
import { splitRGBA, mergeRGBA, resizeImage, resizeRGBAPremultiplied } from './core/resample.js';
import { preserveColors, sharpen } from './core/enhance.js';

const MAX_TILE_ERROR = 30; // ver tileFidelityError

let transformers = null;
let loaded = null; // { key, pipe }
let gpuAvailable = null;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

class BackendError extends Error {}
class LibraryError extends Error {}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg?.type !== 'process') return;
  try {
    await processJob(msg);
  } catch (err) {
    post({ type: 'error', message: describeError(err), detail: String(err?.stack || err) });
  }
};

async function hasUsableGPU() {
  if (gpuAvailable !== null) return gpuAvailable;
  try {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
    // Un adaptador "de respaldo" es una GPU emulada por software: más lenta que WASM.
    const fallback = adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter ?? false;
    gpuAvailable = Boolean(adapter) && !fallback;
  } catch {
    gpuAvailable = false;
  }
  return gpuAvailable;
}

async function loadTransformers() {
  if (!transformers) {
    post({ type: 'progress', stage: 'library' });
    try {
      transformers = await import(TRANSFORMERS_URL);
    } catch (err) {
      throw new LibraryError(`No se pudo cargar Transformers.js: ${err?.message || err}`);
    }
    transformers.env.allowLocalModels = false; // los modelos vienen siempre de Hugging Face
    transformers.env.useBrowserCache = true; // y se guardan en el navegador tras la 1.ª descarga
  }
  return transformers;
}

async function releaseModel() {
  if (!loaded) return;
  try {
    await loaded.pipe.dispose?.();
  } catch {
    /* sin importancia */
  }
  loaded = null;
}

async function getUpscaler(model, device) {
  const key = `${model.repo}@${device}`;
  if (loaded?.key === key) return loaded.pipe;
  await releaseModel();
  const { pipeline } = await loadTransformers();

  const files = new Map();
  let lastSent = 0;
  const pipe = await pipeline('image-to-image', model.repo, {
    device,
    dtype: model.dtype?.[device] || 'fp32', // máxima fidelidad (los cuantizados pueden dejar artefactos)
    progress_callback: (p) => {
      if (p?.status === 'progress' && p.file && p.total) {
        files.set(p.file, { loaded: p.loaded || 0, total: p.total });
        const now = Date.now();
        if (now - lastSent < 120 && p.loaded < p.total) return;
        lastSent = now;
        let loadedBytes = 0;
        let totalBytes = 0;
        for (const f of files.values()) {
          loadedBytes += f.loaded;
          totalBytes += f.total;
        }
        post({ type: 'progress', stage: 'download', loaded: loadedBytes, total: totalBytes });
      }
    },
  });
  loaded = { key, pipe };
  return pipe;
}

function makeTileFn(pipe, RawImage, scale) {
  let checked = false;
  return async ({ data, width, height }) => {
    let out = await pipe(new RawImage(data, width, height, 3));
    if (out.channels !== 3) out = out.rgb();
    if (!checked) {
      checked = true;
      const err = tileFidelityError(data, width, height, out.data, out.width, scale);
      if (!(err < MAX_TILE_ERROR)) throw new BackendError(`Salida de IA inválida (desvío ${err.toFixed(1)})`);
    }
    return { data: out.data, width: out.width, height: out.height };
  };
}

async function sendPreviewTile(t) {
  const rgba = mergeRGBA(t.data, null, t.w, t.h);
  const meta = { type: 'tile', pass: t.pass, passes: t.passes, x: t.x, y: t.y, w: t.w, h: t.h, outW: t.outW, outH: t.outH };
  try {
    const bitmap = await createImageBitmap(new ImageData(rgba, t.w, t.h));
    post({ ...meta, bitmap }, [bitmap]);
  } catch {
    post({ ...meta, rgba }, [rgba.buffer]);
  }
}

async function processJob(msg) {
  const { width, height, modelId, target, options } = msg;
  let rgba = msg.rgba;
  msg.rgba = null; // así se puede liberar la memoria cuando ya no haga falta
  const started = performance.now();
  const model = MODELS.find((m) => m.id === modelId) || MODELS[0];
  const { rgb, alpha } = splitRGBA(rgba, width, height);
  let outRGB;
  let outAlpha = null;
  let device = 'classic';
  let colorShift = 0;

  if (!model.scale) {
    post({ type: 'device', device });
    post({ type: 'progress', stage: 'classic' });
    if (alpha) {
      const big = resizeRGBAPremultiplied(rgba, width, height, target.width, target.height);
      ({ rgb: outRGB, alpha: outAlpha } = splitRGBA(big, target.width, target.height));
    } else {
      outRGB = resizeImage(rgb, width, height, target.width, target.height, 3);
    }
  } else {
    rgba = null; // la IA trabaja con RGB; se libera la copia RGBA
    const plan = planUpscale({ width, height }, target, model.scale);
    const devices = (await hasUsableGPU()) ? ['webgpu', 'wasm'] : ['wasm'];
    for (let k = 0; k < devices.length; k++) {
      device = devices[k];
      try {
        const pipe = await getUpscaler(model, device);
        post({ type: 'device', device });
        post({ type: 'progress', stage: 'warmup' });
        const res = await runUpscale({
          rgb,
          width,
          height,
          plan,
          scale: model.scale,
          upscaleTile: makeTileFn(pipe, transformers.RawImage, model.scale),
          tileCore: model.tile,
          tilePad: TILE_PAD,
          onProgress: (p) => post({ type: 'progress', ...p }),
          onTile: sendPreviewTile,
        });
        outRGB = res.rgb;
        break;
      } catch (err) {
        // Cualquier fallo con la GPU (salvo no poder cargar la librería) se reintenta con el procesador.
        const canFallBack = device === 'webgpu' && k + 1 < devices.length && !(err instanceof LibraryError);
        if (!canFallBack) throw err;
        console.warn('[Foto4K] La GPU falló, se usará el procesador:', err);
        await releaseModel();
        post({ type: 'restart', reason: describeError(err) });
      }
    }
    if (alpha) outAlpha = resizeImage(alpha, width, height, target.width, target.height, 1);
    if (options.preserveColors) {
      post({ type: 'progress', stage: 'colors' });
      colorShift = preserveColors(outRGB, target.width, target.height, rgb, width, height);
    }
  }

  if (options.sharpen > 0) {
    post({ type: 'progress', stage: 'sharpen' });
    sharpen(outRGB, target.width, target.height, options.sharpen);
  }

  post({ type: 'progress', stage: 'encode' });
  const format = outAlpha ? 'png' : options.format; // JPG no admite transparencia
  const outRGBA = mergeRGBA(outRGB, outAlpha, target.width, target.height);
  const blob = await encode(outRGBA, target.width, target.height, format, options.quality);
  const info = {
    type: 'done',
    width: target.width,
    height: target.height,
    device,
    format,
    hasAlpha: Boolean(outAlpha),
    colorShift,
    ms: Math.round(performance.now() - started),
  };
  if (blob) post({ ...info, blob });
  else post({ ...info, rgba: outRGBA }, [outRGBA.buffer]); // el hilo principal lo codifica
}

async function encode(rgba, width, height, format, quality = 0.95) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return await canvas.convertToBlob(format === 'jpeg' ? { type, quality } : { type });
  } catch {
    return null;
  }
}

function isNetworkError(err) {
  if (err instanceof LibraryError) return true;
  const text = String(err?.message || err);
  return /failed to fetch|networkerror|network error|load failed|err_internet|err_connection/i.test(text);
}

function describeError(err) {
  const text = String(err?.message || err);
  if (isNetworkError(err)) {
    return 'No se pudo descargar la IA. Revisa tu conexión a internet e inténtalo de nuevo.';
  }
  if (/memory|allocation|out of|Aborted|RangeError|device.*lost/i.test(text)) {
    return 'Tu dispositivo se quedó sin memoria. Prueba con «4K UHD», el tipo «Rápido» o una foto más pequeña.';
  }
  if (err instanceof BackendError) {
    return 'La IA no produjo un resultado válido en este equipo. Prueba el tipo «Rápido» o «Sin IA».';
  }
  return `Ocurrió un error inesperado: ${text}`;
}
