// Planificación de tamaños y pasadas de IA.
// Módulo puro (sin DOM): lo usan la interfaz, el worker y las pruebas de Node.

/** Lado largo de una imagen 4K (UHD). */
export const UHD_LONG = 3840;
export const UHD_SHORT = 2160;

/** Límite de píxeles de salida para no agotar la memoria del navegador (~48 MP). */
export const MAX_OUTPUT_PIXELS = 48_000_000;

/** Máximo de pasadas de IA encadenadas antes de completar con ampliación clásica. */
export const MAX_AI_PASSES = 2;

export const SIZE_PRESETS = {
  '4k': {
    label: '4K',
    hint: 'Lado largo de 3840 px',
    compute: (w, h) => fitLongSide(w, h, UHD_LONG),
  },
  '4k-uhd': {
    label: '4K UHD',
    hint: 'Cabe en 3840 × 2160 px',
    compute: (w, h) => (w >= h ? fitInBox(w, h, UHD_LONG, UHD_SHORT) : fitInBox(w, h, UHD_SHORT, UHD_LONG)),
  },
  x2: {
    label: 'Doble',
    hint: '×2 del original',
    compute: (w, h) => ({ width: w * 2, height: h * 2 }),
  },
  x4: {
    label: 'Cuádruple',
    hint: '×4 del original',
    compute: (w, h) => ({ width: w * 4, height: h * 4 }),
  },
};

export function fitLongSide(w, h, longSide) {
  const k = longSide / Math.max(w, h);
  return scaleDims(w, h, k);
}

export function fitInBox(w, h, boxW, boxH) {
  const k = Math.min(boxW / w, boxH / h);
  return scaleDims(w, h, k);
}

function scaleDims(w, h, k) {
  return {
    width: Math.max(1, Math.round(w * k)),
    height: Math.max(1, Math.round(h * k)),
  };
}

export function computeTargetSize(width, height, presetId) {
  const preset = SIZE_PRESETS[presetId];
  if (!preset) throw new Error(`Tamaño desconocido: ${presetId}`);
  return preset.compute(width, height);
}

/**
 * Decide cómo llegar del tamaño original al tamaño final.
 *
 * Reglas (pensadas para no perder información del original):
 *  - El original NUNCA se reduce antes de la IA.
 *  - Se usan las pasadas de IA mínimas para alcanzar (o superar) el tamaño final.
 *  - Si ni con MAX_AI_PASSES se llega, se amplía el original con Lanczos antes de la IA.
 *  - Un resultado intermedio de IA sí puede reducirse antes de la última pasada
 *    (ahorra tiempo y sigue teniendo más píxeles que el original).
 *  - Si la IA produce más píxeles que el final, se reduce con Lanczos (sobremuestreo).
 *
 * @param {{width:number,height:number}} src
 * @param {{width:number,height:number}} target
 * @param {number|null} scale  Escala del modelo (2 o 4); null = sin IA.
 */
export function planUpscale(src, target, scale, maxPasses = MAX_AI_PASSES) {
  const ratio = Math.max(target.width / src.width, target.height / src.height);
  const base = { source: { ...src }, target: { ...target }, ratio };

  if (!(ratio > 1)) {
    return { ...base, needed: false, preScale: null, passes: [] };
  }
  if (!scale) {
    return { ...base, needed: true, preScale: null, passes: [] };
  }

  let n = Math.ceil(Math.log(ratio) / Math.log(scale) - 1e-9);
  n = Math.max(1, Math.min(n, maxPasses));
  const reach = scale ** n;

  let current = { ...src };
  let preScale = null;
  if (src.width * reach < target.width || src.height * reach < target.height) {
    preScale = {
      width: Math.ceil(target.width / reach),
      height: Math.ceil(target.height / reach),
    };
    current = { ...preScale };
  }

  const passes = [];
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    let input = current;
    if (isLast && i > 0) {
      const ideal = {
        width: Math.ceil(target.width / scale),
        height: Math.ceil(target.height / scale),
      };
      if (current.width > ideal.width && current.height > ideal.height) input = ideal;
    }
    const output = { width: input.width * scale, height: input.height * scale };
    passes.push({ input, output });
    current = output;
  }
  // Tamaño al que se lleva la salida de cada pasada: la entrada de la siguiente o el final.
  for (let i = 0; i < passes.length; i++) {
    passes[i].next = i + 1 < passes.length ? passes[i + 1].input : { ...target };
  }

  return { ...base, needed: true, preScale, passes };
}

/** Megapíxeles que procesará la IA en total (sirve para estimar el trabajo). */
export function aiWorkload(plan) {
  return plan.passes.reduce((sum, p) => sum + p.input.width * p.input.height, 0);
}
