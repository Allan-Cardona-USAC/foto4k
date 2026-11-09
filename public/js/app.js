// Interfaz de Foto4K: carga de la foto, ajustes, avance por bloques y comparador.

import { MODELS, modelById } from './models.js';
import { SIZE_PRESETS, computeTargetSize, planUpscale, MAX_OUTPUT_PIXELS } from './core/plan.js';
import { extractExif, patchExif, injectExif } from './core/metadata.js';

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'),
  dropzone: $('dropzone'),
  pick: $('pick'),
  file: $('file'),
  frame: $('frame'),
  viewport: $('viewport'),
  cotaX: $('cota-x'),
  cotaY: $('cota-y'),
  caption: $('frame-caption'),
  preview: $('preview'),
  canvas: $('progress-canvas'),
  compare: $('compare'),
  after: $('after'),
  before: $('before'),
  divider: $('divider'),
  tagRight: $('tag-right'),
  bar: $('bar'),
  barFill: $('bar-fill'),
  zoom: $('zoom'),
  settings: $('settings'),
  models: $('models'),
  sizeNote: $('size-note'),
  sharpenOut: $('sharpen-out'),
  run: $('run'),
  cancel: $('cancel'),
  download: $('download'),
  another: $('another'),
  statusText: $('status-text'),
  device: $('device'),
  error: $('error'),
  announcer: $('announcer'),
};

const nf = new Intl.NumberFormat('es');
const nf1 = new Intl.NumberFormat('es', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const mb = (bytes) => nf1.format(bytes / 1e6);
const dims = (w, h) => `${nf.format(w)} × ${nf.format(h)} px`;

const state = {
  phase: 'empty', // empty | ready | working | done
  photo: null, // { file, url, img, width, height, name }
  result: null, // { url, blob, width, height }
  job: null,
  worker: null,
  gpu: false,
  progress: null, // { ctx, cw, ch, pass }
  view: { z: 1, tx: 0, ty: 0, split: 50 },
  lastStage: '',
};

// ---------------------------------------------------------------- inicio

init();

async function init() {
  renderModels();
  wireEvents();
  updateSummary();
  state.gpu = await detectGPU();
  if (!state.gpu) checkModel('rapido');
  showDeviceHint();
}

function renderModels() {
  ui.models.innerHTML = '';
  for (const m of MODELS) {
    const label = document.createElement('label');
    label.className = 'option';
    const size = m.downloadMB ? ` Descarga única de ${m.downloadMB} MB.` : '';
    label.innerHTML = `
      <input type="radio" name="model" value="${m.id}" ${m.id === 'foto' ? 'checked' : ''} />
      <span>
        <span class="name">${m.name}</span>${m.badge ? `<span class="badge">${m.badge}</span>` : ''}
      </span>
      <span class="desc">${m.description}${size}</span>`;
    ui.models.append(label);
  }
}

function checkModel(id) {
  const input = ui.models.querySelector(`input[value="${id}"]`);
  if (input) input.checked = true;
}

async function detectGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    const fallback = adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter ?? false;
    return Boolean(adapter) && !fallback;
  } catch {
    return false;
  }
}

function showDeviceHint() {
  if (state.phase === 'working') return;
  const model = modelById(readSettings().modelId);
  if (!model.scale) {
    ui.device.textContent = 'Sin IA: el resultado es inmediato.';
  } else if (state.gpu) {
    ui.device.textContent = 'Tu equipo tiene una tarjeta gráfica compatible: la IA irá rápido.';
  } else {
    ui.device.textContent =
      model.id === 'rapido'
        ? 'Sin acceso a la tarjeta gráfica: la IA usará el procesador.'
        : 'Sin acceso a la tarjeta gráfica: con este tipo puede tardar varios minutos. «Rápido» es mucho más veloz.';
  }
}

// ---------------------------------------------------------------- eventos

function wireEvents() {
  ui.pick.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', () => {
    if (ui.file.files[0]) loadFile(ui.file.files[0]);
    ui.file.value = '';
  });

  // Arrastrar y soltar sobre la mesa (y evitar que el navegador abra el archivo)
  let dragDepth = 0;
  ui.stage.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || state.phase === 'working') return;
    e.preventDefault();
    dragDepth++;
    ui.stage.classList.add('dragging');
  });
  ui.stage.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.stage.classList.remove('dragging');
  });
  ui.stage.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    ui.stage.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file && state.phase !== 'working') loadFile(file);
  });
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
  }

  // Pegar desde el portapapeles
  document.addEventListener('paste', (e) => {
    if (state.phase === 'working') return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) loadFile(new File([file], file.name || 'foto-pegada.png', { type: file.type }));
  });

  ui.settings.addEventListener('input', onSettingsChange);
  ui.settings.addEventListener('change', onSettingsChange);
  ui.settings.addEventListener('submit', (e) => e.preventDefault());

  ui.run.addEventListener('click', run);
  ui.cancel.addEventListener('click', cancel);
  ui.another.addEventListener('click', () => {
    resetAll();
    ui.pick.focus();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.phase === 'working') e.preventDefault();
  });

  wireViewer();
}

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

function onSettingsChange(e) {
  if (e?.target?.name === 'sharpen') {
    const v = Number(e.target.value);
    ui.sharpenOut.textContent = v === 0 ? 'Ninguna' : v <= 35 ? 'Suave' : v <= 70 ? 'Media' : 'Alta';
  }
  if (state.phase === 'done') {
    // Cambiar un ajuste invalida el resultado: se vuelve a la foto original.
    discardResult();
    setPhase('ready');
  }
  updateSummary();
  showDeviceHint();
}

function readSettings() {
  const data = new FormData(ui.settings);
  return {
    size: data.get('size') || '4k',
    modelId: data.get('model') || 'foto',
    preserveColors: data.get('colors') === 'on',
    metadata: data.get('metadata') === 'on',
    sharpen: Number(data.get('sharpen') || 0) / 100,
    format: data.get('format') === 'jpeg' ? 'jpeg' : 'png',
  };
}

// ---------------------------------------------------------------- foto

async function loadFile(file) {
  clearError();
  const looksLikeImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)$/i.test(file.name);
  if (!looksLikeImage) {
    showError('Ese archivo no es una imagen. Usa una foto JPG, PNG, WebP o AVIF.');
    return;
  }
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    showError('Las imágenes SVG son vectoriales: ya se pueden ampliar a cualquier tamaño sin perder calidad.');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    const heic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    showError(
      heic
        ? 'Este navegador no puede abrir fotos HEIC. Ábrela en Safari o conviértela a JPG primero.'
        : 'No se pudo abrir la imagen. Prueba con otro archivo JPG, PNG, WebP o AVIF.',
    );
    return;
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    showError('No se pudo leer el tamaño de esta imagen. Prueba con otro archivo.');
    return;
  }

  discardResult();
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  state.photo = {
    file,
    url,
    img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    name: file.name.replace(/\.[^.]+$/, '') || 'foto',
  };
  ui.preview.src = url;
  setFrameShape(state.photo.width, state.photo.height);
  setCotas(state.photo.width, state.photo.height);
  setPhase('ready');
  updateSummary();
}

function setFrameShape(w, h) {
  ui.frame.style.setProperty('--w', w);
  ui.frame.style.setProperty('--h', h);
}

function setCotas(w, h) {
  ui.cotaX.textContent = `${nf.format(w)} px`;
  ui.cotaY.textContent = `${nf.format(h)} px`;
  ui.caption.textContent = `Tamaño mostrado: ${dims(w, h)}`;
}

function updateSummary() {
  const s = readSettings();
  const preset = SIZE_PRESETS[s.size];
  ui.run.textContent = s.size.startsWith('4k') ? `Ampliar a ${preset.label}` : `Ampliar ${s.size.replace('x', '×')}`;

  if (!state.photo) {
    const hints = {
      '4k': 'El lado largo queda en 3840 px y se respeta la proporción de tu foto.',
      '4k-uhd': 'La foto completa cabe en una pantalla 4K (3840 × 2160), sin recortes.',
      x2: 'El doble de ancho y de alto que el original.',
      x4: 'Cuatro veces el ancho y el alto del original.',
    };
    ui.sizeNote.textContent = hints[s.size];
    ui.run.disabled = true;
    if (state.phase === 'empty') setStatus('Primero elige una foto.');
    return;
  }

  const { width, height } = state.photo;
  const target = computeTargetSize(width, height, s.size);
  const plan = planUpscale({ width, height }, target, modelById(s.modelId).scale);
  const pixels = target.width * target.height;

  if (!plan.needed) {
    const canDouble = width * height * 4 <= MAX_OUTPUT_PIXELS;
    ui.sizeNote.innerHTML =
      `Tu foto ya mide <strong>${dims(width, height)}</strong>, igual o más que este tamaño, así que no necesita ampliarse.` +
      (canDouble ? ' Si quieres aún más resolución, elige ×2.' : '');
    ui.run.disabled = true;
  } else if (pixels > MAX_OUTPUT_PIXELS) {
    ui.sizeNote.innerHTML = `El resultado tendría ${nf.format(Math.round(pixels / 1e6))} megapíxeles, demasiado para el navegador. Elige un tamaño menor.`;
    ui.run.disabled = true;
  } else {
    const factor = nf1.format(target.width / width);
    ui.sizeNote.innerHTML = `Resultado: <strong>${dims(target.width, target.height)}</strong> (×${factor}).`;
    ui.run.disabled = state.phase !== 'ready';
  }
  if (state.phase === 'ready') setStatus(`Foto de ${dims(width, height)}. Elige los ajustes y amplíala.`);
}

// ---------------------------------------------------------------- fases

function setPhase(phase) {
  state.phase = phase;
  ui.stage.dataset.phase = phase;
  document.body.dataset.phase = phase;
  const hasPhoto = phase !== 'empty';
  ui.dropzone.hidden = hasPhoto;
  ui.frame.hidden = !hasPhoto;
  ui.preview.hidden = phase !== 'ready';
  ui.canvas.hidden = phase !== 'working';
  ui.bar.hidden = phase !== 'working';
  ui.compare.hidden = phase !== 'done';
  ui.zoom.hidden = phase !== 'done';

  ui.run.hidden = phase === 'working' || phase === 'done';
  ui.cancel.hidden = phase !== 'working';
  ui.download.hidden = phase !== 'done';
  ui.another.hidden = phase !== 'done' && phase !== 'ready';
  ui.another.textContent = 'Otra foto';
  for (const fs of ui.settings.querySelectorAll('fieldset, details input')) fs.disabled = phase === 'working';
  if (phase === 'ready' && state.photo) setCotas(state.photo.width, state.photo.height);
  if (phase === 'ready' || phase === 'empty') updateSummary();
}

function resetAll() {
  if (state.worker && state.phase === 'working') stopWorker();
  discardResult();
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  state.photo = null;
  ui.preview.removeAttribute('src');
  clearError();
  setPhase('empty');
  showDeviceHint();
}

function discardResult() {
  if (state.result) URL.revokeObjectURL(state.result.url);
  state.result = null;
  ui.after.removeAttribute('src');
  ui.download.removeAttribute('href');
  if (state.photo) setCotas(state.photo.width, state.photo.height);
}

// ---------------------------------------------------------------- proceso

function getWorker() {
  if (!state.worker) {
    state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    state.worker.onmessage = onWorkerMessage;
    state.worker.onerror = (e) => {
      e.preventDefault?.();
      fail('No se pudo iniciar el procesamiento. Actualiza tu navegador e inténtalo de nuevo.', e.message);
    };
  }
  return state.worker;
}

function stopWorker() {
  state.worker?.terminate();
  state.worker = null;
}

function run() {
  if (state.phase !== 'ready' || ui.run.disabled) return;
  const settings = readSettings();
  const { img, width, height } = state.photo;
  const target = computeTargetSize(width, height, settings.size);
  clearError();

  let rgba;
  try {
    rgba = readPixels(img, width, height);
  } catch (err) {
    showError('No hay memoria suficiente para leer esta foto. Prueba con una más pequeña.');
    console.error(err);
    return;
  }

  state.job = { settings, target, startedAt: performance.now() };
  state.lastStage = '';
  setPhase('working');
  setCotas(target.width, target.height);
  setupProgressCanvas(target);
  setBar(null);
  setStatus('Preparando…');
  ui.device.textContent = '';

  getWorker().postMessage(
    {
      type: 'process',
      width,
      height,
      rgba,
      modelId: settings.modelId,
      target,
      options: {
        preserveColors: settings.preserveColors,
        sharpen: settings.sharpen,
        format: settings.format,
        quality: 0.95,
      },
    },
    [rgba.buffer],
  );
}

function readPixels(img, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 0; // liberar memoria
  return data;
}

function cancel() {
  stopWorker();
  setPhase('ready');
  setStatus('Cancelado. Puedes cambiar los ajustes y volver a intentarlo.');
  showDeviceHint();
}

function onWorkerMessage(e) {
  const m = e.data;
  if (state.phase !== 'working') return;
  switch (m.type) {
    case 'progress':
      handleProgress(m);
      break;
    case 'device':
      showDevice(m.device);
      break;
    case 'tile':
      drawTile(m);
      break;
    case 'restart':
      state.job.restarted = true;
      setupProgressCanvas(state.job.target);
      break;
    case 'done':
      finish(m);
      break;
    case 'error':
      fail(m.message, m.detail);
      break;
  }
}

function showDevice(device) {
  const isolated = globalThis.crossOriginIsolated === true; // varios núcleos disponibles
  const text = {
    webgpu: 'Usando la tarjeta gráfica de tu equipo.',
    wasm: isolated
      ? 'Usando el procesador de tu equipo. Puede tardar varios minutos.'
      : 'Usando el procesador de tu equipo (un solo núcleo). Puede tardar bastante.',
    classic: '',
  };
  const restarted = state.job?.restarted && device === 'wasm';
  ui.device.textContent = restarted
    ? 'La tarjeta gráfica no respondió bien; seguimos con el procesador (puede tardar más).'
    : (text[device] ?? '');
}

function handleProgress(m) {
  const fmt = state.job.settings.format === 'jpeg' ? 'JPG' : 'PNG';
  if (m.stage !== state.lastStage) {
    state.lastStage = m.stage;
    const spoken = { download: 'Descargando la IA.', upscale: 'Ampliando la foto.', encode: 'Guardando el resultado.' };
    if (spoken[m.stage]) announce(spoken[m.stage]);
  }
  switch (m.stage) {
    case 'library':
      setStatus('Cargando el motor de IA…');
      setBar(null);
      break;
    case 'download':
      setStatus(`Descargando la IA (solo la primera vez): ${mb(m.loaded)} de ${mb(m.total)} MB`);
      setBar(m.total ? m.loaded / m.total : null);
      break;
    case 'warmup':
      setStatus('Preparando la IA en tu equipo…');
      setBar(null);
      break;
    case 'prescale':
      setStatus('Preparando la imagen…');
      break;
    case 'upscale': {
      const step = m.passes > 1 ? ` (paso ${m.pass} de ${m.passes})` : '';
      const eta = m.etaMs != null ? `. ${formatEta(m.etaMs)}` : '';
      setStatus(`Ampliando: bloque ${m.tile} de ${m.tiles}${step}${eta}`);
      setBar(m.fraction);
      break;
    }
    case 'classic':
      setStatus('Ampliando sin IA…');
      setBar(null);
      break;
    case 'colors':
      setStatus('Ajustando los colores al original…');
      setBar(1);
      break;
    case 'sharpen':
      setStatus('Aplicando nitidez…');
      break;
    case 'encode':
      setStatus(`Guardando ${fmt}…`);
      setBar(1);
      break;
  }
}

function formatEta(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `Faltan unos ${s} s`;
  const min = Math.round(s / 60);
  return min === 1 ? 'Falta 1 minuto' : `Faltan unos ${min} minutos`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(1, s)} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

function setupProgressCanvas(target) {
  const maxSide = Math.min(2048, Math.max(900, Math.round(ui.frame.clientWidth * (window.devicePixelRatio || 1))));
  const k = Math.min(1, maxSide / Math.max(target.width, target.height));
  const cw = Math.max(1, Math.round(target.width * k));
  const ch = Math.max(1, Math.round(target.height * k));
  ui.canvas.width = cw;
  ui.canvas.height = ch;
  const ctx = ui.canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.photo.img, 0, 0, cw, ch);
  dim(ctx, cw, ch);
  state.progress = { ctx, cw, ch, pass: 0 };
}

function dim(ctx, w, h) {
  ctx.fillStyle = 'rgba(28, 30, 33, 0.58)';
  ctx.fillRect(0, 0, w, h);
}

async function drawTile(m) {
  const p = state.progress;
  if (!p) return;
  if (m.pass !== p.pass) {
    p.pass = m.pass;
    if (m.pass > 0) dim(p.ctx, p.cw, p.ch); // nueva pasada: se vuelve a oscurecer
  }
  const kx = p.cw / m.outW;
  const ky = p.ch / m.outH;
  const x0 = Math.floor(m.x * kx);
  const y0 = Math.floor(m.y * ky);
  const x1 = Math.ceil((m.x + m.w) * kx);
  const y1 = Math.ceil((m.y + m.h) * ky);
  let bitmap = m.bitmap;
  if (!bitmap && m.rgba) bitmap = await createImageBitmap(new ImageData(m.rgba, m.w, m.h));
  if (!bitmap) return;
  p.ctx.drawImage(bitmap, x0, y0, x1 - x0, y1 - y0);
  bitmap.close?.();
}

async function finish(m) {
  const { job, photo } = state;
  let blob = m.blob;
  try {
    if (!blob) blob = await encodeOnMain(m.rgba, m.width, m.height, m.format);
    if (job.settings.metadata) blob = await withExif(blob, photo.file, m.width, m.height);
  } catch (err) {
    fail('No se pudo guardar la imagen ampliada.', String(err));
    return;
  }

  const url = URL.createObjectURL(blob);
  state.result = { url, blob, width: m.width, height: m.height };
  ui.before.src = photo.url;
  ui.after.src = url;
  await Promise.allSettled([ui.after.decode(), ui.before.decode()]);
  if (state.phase !== 'working') {
    URL.revokeObjectURL(url);
    return;
  }

  const ext = m.format === 'jpeg' ? 'jpg' : 'png';
  ui.download.href = url;
  ui.download.download = `${photo.name}-${job.settings.size}.${ext}`;
  ui.download.textContent = `Descargar ${ext.toUpperCase()} (${mb(blob.size)} MB)`;
  ui.tagRight.textContent = job.settings.size.startsWith('4k') ? SIZE_PRESETS[job.settings.size].label : job.settings.size.replace('x', '×');
  setCotas(m.width, m.height);
  setPhase('done');
  resetView();

  const used = { webgpu: 'Procesada con la tarjeta gráfica de tu equipo.', wasm: 'Procesada con el procesador de tu equipo.' };
  ui.device.textContent = used[m.device] || '';
  const elapsed = formatDuration(performance.now() - job.startedAt);
  const alphaNote = m.hasAlpha && job.settings.format === 'jpeg' ? ' Se guardó en PNG para conservar la transparencia.' : '';
  setStatus(
    `Listo en ${elapsed}: ${dims(m.width, m.height)}.${alphaNote} Arrastra la línea amarilla para comparar y usa + o − para acercar.`,
  );
  announce(`Listo. La foto ampliada mide ${dims(m.width, m.height)}.`);
  ui.download.focus({ preventScroll: true });
}

async function encodeOnMain(rgba, width, height, format) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.95));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('El navegador no pudo codificar la imagen');
  return blob;
}

async function withExif(blob, originalFile, width, height) {
  try {
    const exif = extractExif(await originalFile.arrayBuffer());
    const patched = exif && patchExif(exif, { width, height });
    if (!patched) return blob;
    const bytes = injectExif(new Uint8Array(await blob.arrayBuffer()), patched);
    return new Blob([bytes], { type: blob.type });
  } catch (err) {
    console.warn('[Foto4K] No se pudieron copiar los metadatos:', err);
    return blob;
  }
}

function fail(message, detail) {
  if (detail) console.error('[Foto4K]', detail);
  stopWorker();
  setPhase(state.photo ? 'ready' : 'empty');
  showError(message);
  setStatus('');
  showDeviceHint();
}

// ---------------------------------------------------------------- textos

function setStatus(text) {
  ui.statusText.textContent = text;
}

function announce(text) {
  ui.announcer.textContent = text;
}

function setBar(fraction) {
  const indeterminate = fraction == null;
  ui.bar.classList.toggle('indeterminate', indeterminate);
  ui.barFill.style.width = indeterminate ? '' : `${Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10}%`;
}

function showError(text) {
  ui.error.textContent = text;
  ui.error.hidden = false;
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = '';
}

// ---------------------------------------------------------------- comparador

function wireViewer() {
  const v = state.view;
  let drag = null;

  ui.viewport.addEventListener('pointerdown', (e) => {
    if (state.phase !== 'done' || e.button !== 0) return;
    const onDivider = e.target === ui.divider || ui.divider.contains(e.target);
    const mode = onDivider || v.z <= 1.001 ? 'split' : 'pan';
    drag = { mode, x: e.clientX, y: e.clientY, id: e.pointerId };
    ui.viewport.setPointerCapture(e.pointerId);
    if (mode === 'split') moveSplit(e.clientX);
    else ui.compare.classList.add('panning');
  });
  ui.viewport.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.mode === 'split') moveSplit(e.clientX);
    else {
      v.tx += e.clientX - drag.x;
      v.ty += e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      clampView();
      applyView();
    }
  });
  const end = () => {
    drag = null;
    ui.compare.classList.remove('panning');
  };
  ui.viewport.addEventListener('pointerup', end);
  ui.viewport.addEventListener('pointercancel', end);

  ui.viewport.addEventListener(
    'wheel',
    (e) => {
      // Solo con Ctrl/⌘ (o el gesto de pellizco del trackpad): la rueda sola desplaza la página.
      if (state.phase !== 'done' || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = ui.viewport.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  ui.viewport.addEventListener('dblclick', (e) => {
    if (state.phase !== 'done') return;
    const r = ui.viewport.getBoundingClientRect();
    if (v.z > 1.001) resetView();
    else zoomAt(3, e.clientX - r.left, e.clientY - r.top);
  });

  ui.divider.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const keys = { ArrowLeft: -step, ArrowRight: step, Home: -100, End: 100 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    v.split = clamp(v.split + keys[e.key], 0, 100);
    applyView();
  });

  ui.zoom.addEventListener('click', (e) => {
    const action = e.target.closest('[data-zoom]')?.dataset.zoom;
    if (!action) return;
    const W = ui.viewport.clientWidth;
    const H = ui.viewport.clientHeight;
    if (action === 'in') zoomAt(1.6, W / 2, H / 2);
    if (action === 'out') zoomAt(1 / 1.6, W / 2, H / 2);
    if (action === 'fit') resetView();
    if (action === 'actual') zoomAt(Math.max(1, state.result.width / W) / v.z, W / 2, H / 2);
  });

  new ResizeObserver(() => {
    if (state.phase === 'done') {
      clampView();
      applyView();
    }
  }).observe(ui.viewport);
}

function moveSplit(clientX) {
  const r = ui.viewport.getBoundingClientRect();
  state.view.split = clamp(((clientX - r.left) / r.width) * 100, 0, 100);
  applyView();
}

function maxZoom() {
  const W = ui.viewport.clientWidth || 1;
  return Math.max(1, ((state.result?.width || W) / W) * 2);
}

function zoomAt(factor, px, py) {
  const v = state.view;
  const z1 = clamp(v.z * factor, 1, maxZoom());
  v.tx = px - (px - v.tx) * (z1 / v.z);
  v.ty = py - (py - v.ty) * (z1 / v.z);
  v.z = z1;
  clampView();
  applyView();
}

function clampView() {
  const v = state.view;
  const W = ui.viewport.clientWidth;
  const H = ui.viewport.clientHeight;
  v.z = clamp(v.z, 1, maxZoom());
  v.tx = clamp(v.tx, W - W * v.z, 0);
  v.ty = clamp(v.ty, H - H * v.z, 0);
}

function resetView() {
  Object.assign(state.view, { z: 1, tx: 0, ty: 0 });
  applyView();
}

function applyView() {
  const v = state.view;
  const t = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
  ui.after.style.transform = t;
  ui.before.style.transform = t;
  ui.compare.style.setProperty('--split', `${v.split}%`);
  ui.compare.classList.toggle('zoomed', v.z > 1.001);
  ui.divider.setAttribute('aria-valuenow', String(Math.round(v.split)));
}

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}
