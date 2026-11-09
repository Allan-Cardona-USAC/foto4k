// Catálogo de modelos de IA y configuración compartida entre la interfaz y el worker.

/**
 * Versión fija de Transformers.js (se carga desde el CDN gratuito jsDelivr).
 * Para actualizar: cambia el número y prueba la app antes de publicar.
 */
export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

/** Margen de contexto alrededor de cada bloque (px de entrada). */
export const TILE_PAD = 16;

/**
 * Modelos Swin2SR (licencia Apache-2.0) convertidos a ONNX por Hugging Face.
 * Se descargan una sola vez y quedan guardados en el navegador.
 * `tile`  = lado del bloque útil; más grande es más rápido pero usa más memoria de GPU.
 * `dtype` = precisión por dispositivo. 'fp32' da la máxima fidelidad; para descargas más
 *           pequeñas puedes usar 'fp16' (GPU, ~32 MB) o 'q8' (procesador, ~21 MB) a cambio
 *           de algo de calidad. Si no se indica, se usa 'fp32'.
 */
export const MODELS = [
  {
    id: 'foto',
    repo: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    scale: 4,
    tile: 128,
    downloadMB: 54,
    name: 'Foto de celular o cámara',
    badge: 'Recomendado',
    description:
      'Limpia el ruido, el desenfoque leve y la compresión típicos de las fotos de celular, WhatsApp y redes sociales.',
  },
  {
    id: 'fiel',
    repo: 'Xenova/swin2SR-classical-sr-x2-64',
    scale: 2,
    tile: 192,
    downloadMB: 54,
    name: 'Foto nítida y limpia',
    description: 'Cambia lo mínimo posible. Ideal para fotos de buena cámara, escaneos o archivos PNG.',
  },
  {
    id: 'comprimida',
    repo: 'Xenova/swin2SR-compressed-sr-x4-48',
    scale: 4,
    tile: 128,
    downloadMB: 55,
    name: 'Muy comprimida o pixelada',
    description: 'Para imágenes con bloques, manchas o bordes sucios por compresión JPG.',
  },
  {
    id: 'rapido',
    repo: 'Xenova/swin2SR-lightweight-x2-64',
    scale: 2,
    tile: 256,
    downloadMB: 8,
    name: 'Rápido',
    description: 'IA ligera, hasta 10 veces más veloz. Úsalo si tu equipo no tiene tarjeta gráfica o es antiguo.',
  },
  {
    id: 'clasico',
    repo: null,
    scale: null,
    tile: 0,
    downloadMB: 0,
    name: 'Sin IA',
    description: 'Ampliación matemática instantánea (Lanczos). No agrega detalle, pero tampoco altera nada.',
  },
];

export const modelById = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
