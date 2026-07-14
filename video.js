// --- Video mode: WebGL LUT engine + real-time capture pipeline ---
// There is no backend, so the filter is applied by playing the video in
// real time, redrawing every decoded frame through a GPU shader (fast
// enough to keep up with playback, unlike the CPU worker used for photos),
// and recording the result with MediaRecorder. Processing therefore takes
// roughly as long as the video itself.

const pickVideoBtn = document.getElementById('pickVideoBtn');
const videoInput = document.getElementById('videoInput');
const emptyStateEl = document.getElementById('emptyState');
const previewStateEl = document.getElementById('previewState');
const videoState = document.getElementById('videoState');
const videoCanvas = document.getElementById('videoCanvas');
const videoProgressOverlay = document.getElementById('videoProgressOverlay');
const videoProgressFill = document.getElementById('videoProgressFill');
const videoProgressLabel = document.getElementById('videoProgressLabel');
const videoCancelBtn = document.getElementById('videoCancelBtn');
const videoResultEl = document.getElementById('videoResult');
const toolbarEl = document.getElementById('toolbar');
const saveBtnEl = document.getElementById('saveBtn');
const chooseAnotherBtnEl = document.getElementById('chooseAnotherBtn');
const intensitySliderEl = document.getElementById('intensitySlider');
const intensityValueEl = document.getElementById('intensityValue');

let glCtx = null;
let glProgram = null;
let glUniforms = null;
let frameTexture = null;
let lutTexture = null;
let lutScale = 1;
let lutOffset = 0;
let sourceVideoEl = null;
let recorder = null;
let recordedChunks = [];
let resultBlob = null;
let resultMimeType = '';
let resultBaseName = 'video';
let cancelRequested = false;
let wakeLockRef = null;
let videoStage = null; // 'preview' | 'processing' | 'done'
let rafToken = 0;

const videoLut = { buffer: null, size: 32 };

async function ensureVideoLutLoaded() {
  if (videoLut.buffer) return;
  const res = await fetch('Amelie.cube');
  const text = await res.text();
  const parsed = parseCube(text); // parseCube is defined in app.js
  videoLut.buffer = parsed.data;
  videoLut.size = parsed.size;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Error de shader: ' + info);
  }
  return shader;
}

const VERTEX_SRC = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform highp sampler3D uLut;
uniform float uLutScale;
uniform float uLutOffset;
uniform float uIntensity;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 src = texture(uFrame, vUv);
  vec3 lutCoord = src.rgb * uLutScale + uLutOffset;
  vec3 filtered = texture(uLut, lutCoord).rgb;
  outColor = vec4(mix(src.rgb, filtered, uIntensity), src.a);
}`;

function setupGL(canvasEl) {
  const gl = canvasEl.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 no disponible');

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Error al enlazar el programa: ' + gl.getProgramInfoLog(program));
  }

  const uniforms = {
    uFrame: gl.getUniformLocation(program, 'uFrame'),
    uLut: gl.getUniformLocation(program, 'uLut'),
    uLutScale: gl.getUniformLocation(program, 'uLutScale'),
    uLutOffset: gl.getUniformLocation(program, 'uLutOffset'),
    uIntensity: gl.getUniformLocation(program, 'uIntensity'),
  };

  frameTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, frameTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const size = videoLut.size;
  const u8 = new Uint8Array(videoLut.buffer.length);
  for (let i = 0; i < videoLut.buffer.length; i++) {
    u8[i] = Math.max(0, Math.min(255, Math.round(videoLut.buffer[i] * 255)));
  }
  lutTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, lutTexture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, u8);

  lutScale = (size - 1) / size;
  lutOffset = 0.5 / size;

  glCtx = gl;
  glProgram = program;
  glUniforms = uniforms;
}

function renderVideoFrame() {
  const gl = glCtx;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.bindTexture(gl.TEXTURE_2D, frameTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceVideoEl);

  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.useProgram(glProgram);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameTexture);
  gl.uniform1i(glUniforms.uFrame, 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTexture);
  gl.uniform1i(glUniforms.uLut, 1);

  gl.uniform1f(glUniforms.uLutScale, lutScale);
  gl.uniform1f(glUniforms.uLutOffset, lutOffset);
  gl.uniform1f(glUniforms.uIntensity, Number(intensitySliderEl.value) / 100);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function formatTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen');
  } catch (err) {
    /* not critical, e.g. page not visible */
  }
  return null;
}

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
}

function resetVideoState() {
  cancelRequested = true;
  if (sourceVideoEl) {
    sourceVideoEl.pause();
    if (sourceVideoEl.src) URL.revokeObjectURL(sourceVideoEl.src);
    sourceVideoEl.remove();
    sourceVideoEl = null;
  }
  if (videoResultEl.src) {
    URL.revokeObjectURL(videoResultEl.src);
    videoResultEl.removeAttribute('src');
  }
  if (recorder && recorder.state !== 'inactive') {
    try {
      recorder.stop();
    } catch (err) {
      /* already stopped */
    }
  }
  if (wakeLockRef) {
    wakeLockRef.release().catch(() => {});
    wakeLockRef = null;
  }
  if (rafToken) cancelAnimationFrame(rafToken);
  resultBlob = null;
  videoStage = null;
  videoState.hidden = true;
  videoProgressOverlay.hidden = true;
  videoCanvas.hidden = false;
  videoResultEl.hidden = true;
}

async function handleVideoFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    window.showToast('Elige un archivo de vídeo');
    return;
  }

  try {
    await ensureVideoLutLoaded();
  } catch (err) {
    console.error(err);
    window.showToast('No se pudo cargar el filtro');
    return;
  }

  resultBaseName = file.name.replace(/\.[^.]+$/, '') || 'video';
  emptyStateEl.hidden = true;
  previewStateEl.hidden = true;
  videoState.hidden = false;
  videoResultEl.hidden = true;
  videoResultEl.removeAttribute('src');
  videoCanvas.hidden = false;
  toolbarEl.hidden = false;
  intensitySliderEl.value = 100;
  intensityValueEl.textContent = '100%';
  saveBtnEl.disabled = true;
  saveBtnEl.textContent = 'Aplicar filtro';
  cancelRequested = false;
  videoStage = 'loading';

  const objectUrl = URL.createObjectURL(file);
  sourceVideoEl = document.createElement('video');
  sourceVideoEl.src = objectUrl;
  sourceVideoEl.muted = true;
  sourceVideoEl.playsInline = true;
  sourceVideoEl.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(sourceVideoEl);

  try {
    await new Promise((resolve, reject) => {
      sourceVideoEl.onloadedmetadata = resolve;
      sourceVideoEl.onerror = () => reject(new Error('No se pudo abrir el vídeo'));
    });
  } catch (err) {
    window.showToast(err.message);
    resetVideoState();
    return;
  }

  videoCanvas.width = sourceVideoEl.videoWidth;
  videoCanvas.height = sourceVideoEl.videoHeight;

  try {
    setupGL(videoCanvas);
  } catch (err) {
    console.error(err);
    window.showToast('Este dispositivo no soporta el procesado de vídeo');
    resetVideoState();
    return;
  }

  await new Promise((resolve) => {
    sourceVideoEl.onseeked = resolve;
    sourceVideoEl.currentTime = 0;
  });
  renderVideoFrame();

  videoStage = 'preview';
  saveBtnEl.disabled = false;
}

intensitySliderEl.addEventListener('input', () => {
  if (videoStage === 'preview' && glCtx) renderVideoFrame();
});

async function startVideoProcessing() {
  if (videoStage !== 'preview') return;
  videoStage = 'processing';
  cancelRequested = false;
  saveBtnEl.disabled = true;
  chooseAnotherBtnEl.disabled = true;
  videoProgressOverlay.hidden = false;
  videoProgressFill.style.width = '0%';
  videoProgressLabel.textContent = `0:00 / ${formatTime(sourceVideoEl.duration)}`;

  wakeLockRef = await requestWakeLock();

  const canvasStream = videoCanvas.captureStream();
  let audioTracks = [];
  try {
    const sourceStream = sourceVideoEl.captureStream ? sourceVideoEl.captureStream() : sourceVideoEl.mozCaptureStream();
    audioTracks = sourceStream.getAudioTracks();
  } catch (err) {
    console.warn('No se pudo capturar el audio del vídeo', err);
  }
  const outStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

  const mimeType = pickMimeType();
  resultMimeType = mimeType || 'video/webm';
  recordedChunks = [];
  try {
    recorder = new MediaRecorder(outStream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
  } catch (err) {
    console.error(err);
    window.showToast('No se pudo grabar el vídeo en este dispositivo');
    videoStage = 'preview';
    videoProgressOverlay.hidden = true;
    chooseAnotherBtnEl.disabled = false;
    saveBtnEl.disabled = false;
    if (wakeLockRef) wakeLockRef.release().catch(() => {});
    return;
  }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  };

  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  recorder.start(1000);

  function step() {
    if (cancelRequested || !sourceVideoEl || sourceVideoEl.paused || sourceVideoEl.ended) return;
    renderVideoFrame();
    const cur = sourceVideoEl.currentTime;
    const dur = sourceVideoEl.duration || cur;
    videoProgressFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
    videoProgressLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    if (sourceVideoEl.requestVideoFrameCallback) {
      sourceVideoEl.requestVideoFrameCallback(step);
    } else {
      rafToken = requestAnimationFrame(step);
    }
  }

  await new Promise((resolve) => {
    sourceVideoEl.onseeked = resolve;
    sourceVideoEl.currentTime = 0;
  });
  if (sourceVideoEl.requestVideoFrameCallback) {
    sourceVideoEl.requestVideoFrameCallback(step);
  } else {
    rafToken = requestAnimationFrame(step);
  }
  await sourceVideoEl.play();

  await new Promise((resolve) => {
    if (!sourceVideoEl) {
      resolve();
      return;
    }
    sourceVideoEl.onended = resolve;
  });

  if (!cancelRequested && recorder.state !== 'inactive') {
    recorder.stop();
    await stopped;
    resultBlob = new Blob(recordedChunks, { type: resultMimeType });
    const resultUrl = URL.createObjectURL(resultBlob);
    videoResultEl.src = resultUrl;
    videoResultEl.hidden = false;
    videoCanvas.hidden = true;
    videoStage = 'done';
    saveBtnEl.textContent = 'Guardar vídeo';
  }

  videoProgressOverlay.hidden = true;
  chooseAnotherBtnEl.disabled = false;
  saveBtnEl.disabled = false;
  if (wakeLockRef) {
    wakeLockRef.release().catch(() => {});
    wakeLockRef = null;
  }
}

videoCancelBtn.addEventListener('click', () => {
  resetVideoState();
});

async function saveVideoResult() {
  if (!resultBlob) return;
  const ext = resultMimeType.includes('mp4') ? 'mp4' : 'webm';
  const fileName = `${resultBaseName}_amelie.${ext}`;
  const file = new File([resultBlob], fileName, { type: resultBlob.type });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  window.showToast('Vídeo descargado');
}

// --- Wiring ---

pickVideoBtn.addEventListener('click', () => videoInput.click());
videoInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleVideoFile(e.target.files[0]);
  videoInput.value = '';
});

window.getVideoStage = () => videoStage;
window.startVideoProcessing = startVideoProcessing;
window.saveVideoResult = saveVideoResult;
window.resetVideoState = resetVideoState;
