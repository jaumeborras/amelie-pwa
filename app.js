const emptyState = document.getElementById('emptyState');
const previewState = document.getElementById('previewState');
const pickBtn = document.getElementById('pickBtn');
const fileInput = document.getElementById('fileInput');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const compareOverlay = document.getElementById('compareOverlay');
const compareDivider = document.getElementById('compareDivider');
const processingOverlay = document.getElementById('processingOverlay');
const batchPosition = document.getElementById('batchPosition');
const batchStrip = document.getElementById('batchStrip');
const toolbar = document.getElementById('toolbar');
const saveBtn = document.getElementById('saveBtn');
const chooseAnotherBtn = document.getElementById('chooseAnotherBtn');
const intensitySlider = document.getElementById('intensitySlider');
const intensityValue = document.getElementById('intensityValue');
const toast = document.getElementById('toast');

let lutBuffer = null; // Float32Array
let lutSize = 32;
let toastTimer = null;

// Offscreen layers composited into the visible canvas for the before/after compare slider.
const beforeCanvas = document.createElement('canvas');
const beforeCtx = beforeCanvas.getContext('2d');
const afterCanvas = document.createElement('canvas');
const afterCtx = afterCanvas.getContext('2d');

const state = {
  mode: null, // 'single' | 'batch'
  currentBaseName: 'foto',
  originalImageData: null,
  filteredPixels: null,
  compareSplit: 0.5,
  batchItems: [], // { file, name, rowEl, thumbEl, cache: null | { originalImageData, filteredPixels } }
  activeIndex: -1,
};
let loadToken = 0;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function parseCube(text) {
  const lines = text.split('\n');
  let size = 32;
  const values = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (/^[A-Za-z]/.test(line)) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
      values.push(parts[0], parts[1], parts[2]);
    }
  }
  return { size, data: Float32Array.from(values) };
}

async function initLUT() {
  const res = await fetch('Amelie.cube');
  const text = await res.text();
  const parsed = parseCube(text);
  lutBuffer = parsed.data;
  lutSize = parsed.size;
}

function runLutOnImageData(imageData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('worker.js');
    const pixelsCopy = imageData.data.buffer.slice(0);
    worker.onmessage = (event) => {
      resolve(new Uint8ClampedArray(event.data.result));
      worker.terminate();
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage(
      {
        pixels: pixelsCopy,
        width: imageData.width,
        height: imageData.height,
        lut: lutBuffer.buffer,
        size: lutSize,
      },
      [pixelsCopy]
    );
  });
}

function blendPixels(original, filtered, t) {
  if (t >= 1) return filtered;
  if (t <= 0) return original;
  const out = new Uint8ClampedArray(original.length);
  for (let i = 0; i < original.length; i += 4) {
    out[i] = original[i] + (filtered[i] - original[i]) * t;
    out[i + 1] = original[i + 1] + (filtered[i + 1] - original[i + 1]) * t;
    out[i + 2] = original[i + 2] + (filtered[i + 2] - original[i + 2]) * t;
    out[i + 3] = filtered[i + 3];
  }
  return out;
}

function currentIntensity() {
  return Number(intensitySlider.value) / 100;
}

// --- Before/after compare slider ---
// object-fit: contain letterboxes the canvas bitmap inside its CSS box
// whenever the box aspect ratio doesn't match the photo, so the divider must
// be positioned against the actual painted photo area, not the full box.
function getImageDisplayRect() {
  const boxW = compareOverlay.clientWidth;
  const boxH = compareOverlay.clientHeight;
  const iw = canvas.width;
  const ih = canvas.height;
  if (!iw || !ih || !boxW || !boxH) return { x: 0, y: 0, width: boxW, height: boxH };
  let width;
  let height;
  if (iw / ih > boxW / boxH) {
    width = boxW;
    height = boxW * (ih / iw);
  } else {
    height = boxH;
    width = boxH * (iw / ih);
  }
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

function setBeforeImage(imageData) {
  beforeCanvas.width = imageData.width;
  beforeCanvas.height = imageData.height;
  beforeCtx.putImageData(imageData, 0, 0);
}

function setAfterImage(pixels, width, height) {
  afterCanvas.width = width;
  afterCanvas.height = height;
  afterCtx.putImageData(new ImageData(pixels, width, height), 0, 0);
}

function renderCompare() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(afterCanvas, 0, 0);
  const splitX = Math.round(w * state.compareSplit);
  if (splitX > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, h);
    ctx.clip();
    ctx.drawImage(beforeCanvas, 0, 0);
    ctx.restore();
  }
  const disp = getImageDisplayRect();
  compareDivider.style.left = `${disp.x + disp.width * state.compareSplit}px`;
}

function updateCompareSplitFromEvent(e) {
  const rect = compareOverlay.getBoundingClientRect();
  const disp = getImageDisplayRect();
  if (!disp.width) return;
  const xWithinBox = e.clientX - rect.left;
  const fraction = (xWithinBox - disp.x) / disp.width;
  state.compareSplit = Math.min(1, Math.max(0, fraction));
  renderCompare();
}

let comparing = false;
compareOverlay.addEventListener('pointerdown', (e) => {
  comparing = true;
  compareOverlay.setPointerCapture(e.pointerId);
  updateCompareSplitFromEvent(e);
});
compareOverlay.addEventListener('pointermove', (e) => {
  if (!comparing) return;
  updateCompareSplitFromEvent(e);
});
['pointerup', 'pointercancel'].forEach((evtName) => {
  compareOverlay.addEventListener(evtName, () => {
    comparing = false;
  });
});

const compareResizeObserver = new ResizeObserver(() => {
  if (!compareOverlay.hidden && state.originalImageData) renderCompare();
});
compareResizeObserver.observe(compareOverlay);

function updatePreviewIntensity() {
  if (!state.originalImageData || !state.filteredPixels) return;
  const t = currentIntensity();
  const blended = blendPixels(state.originalImageData.data, state.filteredPixels, t);
  setAfterImage(blended, state.originalImageData.width, state.originalImageData.height);
  renderCompare();
}

let intensityRAF = null;
intensitySlider.addEventListener('input', () => {
  intensityValue.textContent = `${intensitySlider.value}%`;
  if (intensityRAF) cancelAnimationFrame(intensityRAF);
  intensityRAF = requestAnimationFrame(updatePreviewIntensity);
});

// --- Image loading ---

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, objectUrl });
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('No se pudo abrir la imagen'));
    };
    img.src = objectUrl;
  });
}

function resetToEmpty() {
  loadToken++;
  if (window.resetVideoState) window.resetVideoState();
  state.mode = null;
  state.originalImageData = null;
  state.filteredPixels = null;
  state.compareSplit = 0.5;
  state.batchItems = [];
  state.activeIndex = -1;
  previewState.hidden = true;
  emptyState.hidden = false;
  toolbar.hidden = true;
  compareOverlay.hidden = true;
  batchStrip.hidden = true;
  batchStrip.innerHTML = '';
  batchPosition.hidden = true;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardar';
  intensitySlider.value = 100;
  intensityValue.textContent = '100%';
  fileInput.value = '';
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  if (!files.length) {
    showToast('Elige uno o varios archivos de imagen');
    return;
  }
  if (!lutBuffer) {
    showToast('El filtro todavía se está cargando, espera un segundo');
    return;
  }

  emptyState.hidden = true;
  previewState.hidden = false;
  toolbar.hidden = false;
  compareOverlay.hidden = true;
  saveBtn.disabled = true;
  intensitySlider.value = 100;
  intensityValue.textContent = '100%';

  if (files.length === 1) {
    state.mode = 'single';
    state.batchItems = [];
    batchStrip.hidden = true;
    batchStrip.innerHTML = '';
    batchPosition.hidden = true;
    saveBtn.textContent = 'Guardar';
    await loadSinglePhoto(files[0]);
  } else {
    state.mode = 'batch';
    saveBtn.textContent = `Guardar ${files.length} fotos`;
    setupBatchList(files);
    await showBatchItem(0);
  }
}

async function loadSinglePhoto(file) {
  const myToken = ++loadToken;
  state.currentBaseName = file.name.replace(/\.[^.]+$/, '') || 'foto';
  processingOverlay.hidden = false;

  let loaded;
  try {
    loaded = await loadImage(file);
  } catch (err) {
    processingOverlay.hidden = true;
    showToast('No se pudo abrir esa imagen');
    return;
  }
  if (myToken !== loadToken) return;

  const { img, objectUrl } = loaded;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(objectUrl);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  state.originalImageData = imageData;

  try {
    const filtered = await runLutOnImageData(imageData);
    if (myToken !== loadToken) return;
    state.filteredPixels = filtered;
    state.compareSplit = 0.5;
    setBeforeImage(imageData);
    updatePreviewIntensity();
    compareOverlay.hidden = false;
    processingOverlay.hidden = true;
    saveBtn.disabled = false;
  } catch (err) {
    console.error(err);
    processingOverlay.hidden = true;
    showToast('Error al aplicar el filtro');
  }
}

// --- Batch (multiple photos) ---

function setupBatchList(files) {
  batchStrip.hidden = false;
  batchStrip.innerHTML = '';
  state.batchItems = files.map((file, index) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'batch-item';
    rowEl.dataset.status = 'pending';
    const thumbEl = document.createElement('canvas');
    thumbEl.className = 'batch-thumb';
    thumbEl.width = 112;
    thumbEl.height = 112;
    rowEl.appendChild(thumbEl);
    rowEl.addEventListener('click', () => showBatchItem(index));
    batchStrip.appendChild(rowEl);
    return { file, name: file.name, rowEl, thumbEl, cache: null };
  });
}

function drawThumb(item) {
  const { originalImageData, filteredPixels } = item.cache;
  const src = document.createElement('canvas');
  src.width = originalImageData.width;
  src.height = originalImageData.height;
  src.getContext('2d').putImageData(new ImageData(filteredPixels, src.width, src.height), 0, 0);

  const size = item.thumbEl.width;
  const scale = Math.max(size / src.width, size / src.height);
  const dw = src.width * scale;
  const dh = src.height * scale;
  const tctx = item.thumbEl.getContext('2d');
  tctx.clearRect(0, 0, size, size);
  tctx.drawImage(src, (size - dw) / 2, (size - dh) / 2, dw, dh);
  item.rowEl.dataset.status = 'done';
}

function updateBatchPositionUI() {
  const total = state.batchItems.length;
  batchPosition.hidden = total === 0;
  if (!total) return;
  batchPosition.textContent = `${state.activeIndex + 1} / ${total}`;
  state.batchItems.forEach((item, i) => item.rowEl.classList.toggle('active', i === state.activeIndex));
  const activeEl = state.batchItems[state.activeIndex]?.rowEl;
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

async function showBatchItem(index) {
  if (index < 0 || index >= state.batchItems.length) return;
  const myToken = ++loadToken;
  state.activeIndex = index;
  updateBatchPositionUI();

  const item = state.batchItems[index];
  state.currentBaseName = item.name.replace(/\.[^.]+$/, '') || 'foto';

  if (item.cache) {
    canvas.width = item.cache.originalImageData.width;
    canvas.height = item.cache.originalImageData.height;
    state.originalImageData = item.cache.originalImageData;
    state.filteredPixels = item.cache.filteredPixels;
    state.compareSplit = 0.5;
    setBeforeImage(item.cache.originalImageData);
    updatePreviewIntensity();
    compareOverlay.hidden = false;
    saveBtn.disabled = false;
    return;
  }

  compareOverlay.hidden = true;
  processingOverlay.hidden = false;

  let loaded;
  try {
    loaded = await loadImage(item.file);
  } catch (err) {
    processingOverlay.hidden = true;
    showToast('No se pudo abrir esa imagen');
    return;
  }
  if (myToken !== loadToken) return;

  const { img, objectUrl } = loaded;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(objectUrl);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  try {
    const filtered = await runLutOnImageData(imageData);
    if (myToken !== loadToken) return;
    item.cache = { originalImageData: imageData, filteredPixels: filtered };
    state.originalImageData = imageData;
    state.filteredPixels = filtered;
    state.compareSplit = 0.5;
    setBeforeImage(imageData);
    updatePreviewIntensity();
    compareOverlay.hidden = false;
    processingOverlay.hidden = true;
    saveBtn.disabled = false;
    drawThumb(item);
  } catch (err) {
    console.error(err);
    processingOverlay.hidden = true;
    showToast('Error al aplicar el filtro');
  }
}

// --- Save / share ---

async function saveImage() {
  const blob = await new Promise((resolve) => afterCanvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    showToast('No se pudo generar la imagen');
    return;
  }
  const fileName = `${state.currentBaseName}_amelie.png`;
  const file = new File([blob], fileName, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // fall through to the download fallback below
    }
  }

  downloadFile(file);
  showToast('Foto descargada');
}

async function saveBatch() {
  saveBtn.disabled = true;
  const t = currentIntensity();
  const files = [];

  for (const item of state.batchItems) {
    if (!item.cache) {
      try {
        const { img, objectUrl } = await loadImage(item.file);
        const off = document.createElement('canvas');
        off.width = img.naturalWidth;
        off.height = img.naturalHeight;
        const offCtx = off.getContext('2d');
        offCtx.drawImage(img, 0, 0);
        URL.revokeObjectURL(objectUrl);
        const imageData = offCtx.getImageData(0, 0, off.width, off.height);
        const filtered = await runLutOnImageData(imageData);
        item.cache = { originalImageData: imageData, filteredPixels: filtered };
        drawThumb(item);
      } catch (err) {
        console.error(err);
        continue;
      }
    }

    const { originalImageData, filteredPixels } = item.cache;
    const blended = blendPixels(originalImageData.data, filteredPixels, t);
    const outCanvas = document.createElement('canvas');
    outCanvas.width = originalImageData.width;
    outCanvas.height = originalImageData.height;
    outCanvas.getContext('2d').putImageData(new ImageData(blended, outCanvas.width, outCanvas.height), 0, 0);
    const blob = await new Promise((resolve) => outCanvas.toBlob(resolve, 'image/png'));
    if (!blob) continue;
    const baseName = item.name.replace(/\.[^.]+$/, '') || 'foto';
    files.push(new File([blob], `${baseName}_amelie.png`, { type: 'image/png' }));
  }

  saveBtn.disabled = false;

  if (!files.length) {
    showToast('No se pudo generar ninguna imagen');
    return;
  }

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // fall through to the download fallback below
    }
  }

  files.forEach((file, i) => {
    setTimeout(() => downloadFile(file), i * 400);
  });
  showToast(`${files.length} fotos descargadas`);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// --- Wiring ---

pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFiles(e.target.files);
});
chooseAnotherBtn.addEventListener('click', resetToEmpty);
saveBtn.addEventListener('click', () => {
  if (saveBtn.disabled) return;
  const videoStage = window.getVideoStage && window.getVideoStage();
  if (videoStage === 'preview') {
    window.startVideoProcessing();
    return;
  }
  if (videoStage === 'done') {
    window.saveVideoResult();
    return;
  }
  if (state.mode === 'batch') saveBatch();
  else saveImage();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}

window.getSharedLut = () => (lutBuffer ? { buffer: lutBuffer, size: lutSize } : null);
window.lutReadyPromise = initLUT();
