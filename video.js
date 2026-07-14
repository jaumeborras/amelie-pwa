// --- Video mode: WebCodecs decode -> WebGL LUT filter -> encode pipeline ---
// The earlier approach (play the video in real time, capture the canvas as
// it plays) can never guarantee more frames than the device can render
// live, so on demanding footage (4K60) it silently produced fewer frames
// than the source. WebCodecs decodes/encodes frame-by-frame with no
// real-time constraint at all: every source frame gets decoded, filtered
// and re-encoded in order, regardless of how fast that happens to run. No
// frame can ever be skipped. mp4box.js reads the MP4/MOV container to hand
// WebCodecs raw encoded samples (it has no decoder of its own), and
// mp4-muxer writes the filtered frames back into a new MP4 container.

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
let resultBlob = null;
let resultMimeType = '';
let resultBaseName = 'video';
let cancelRequested = false;
let wakeLockRef = null;
let videoStage = null; // 'preview' | 'processing' | 'done'
let parsedVideo = null;
let currentRotation = 0;
let previewFrame = null; // kept open while in 'preview' so the intensity slider can redraw it
let activeDecoder = null;
let activeEncoder = null;

const videoLut = { buffer: null, size: 32 };

async function ensureVideoLutLoaded() {
  if (videoLut.buffer) return;
  // Reuse app.js's already-proven-reliable fetch/cache instead of racing a
  // second independent request for the exact same file.
  if (window.lutReadyPromise) await window.lutReadyPromise;
  const shared = window.getSharedLut && window.getSharedLut();
  if (shared) {
    videoLut.buffer = shared.buffer;
    videoLut.size = shared.size;
    return;
  }
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
uniform int uRotation;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 suv;
  if (uRotation == 90) {
    suv = vec2(1.0 - vUv.y, vUv.x);
  } else if (uRotation == 180) {
    suv = vec2(1.0 - vUv.x, 1.0 - vUv.y);
  } else if (uRotation == 270) {
    suv = vec2(vUv.y, 1.0 - vUv.x);
  } else {
    suv = vUv;
  }
  vec4 src = texture(uFrame, suv);
  vec3 lutCoord = src.rgb * uLutScale + uLutOffset;
  vec3 filtered = texture(uLut, lutCoord).rgb;
  outColor = vec4(mix(src.rgb, filtered, uIntensity), src.a);
}`;

// `srcWidth`/`srcHeight` are the decoder's coded (unrotated) frame size —
// the frame texture must match that exactly. `canvasEl.width`/`height` is
// the display/output size, which is swapped from the coded size for a
// 90°/270° rotation, so the two can differ.
function setupGL(canvasEl, srcWidth, srcHeight) {
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
    uRotation: gl.getUniformLocation(program, 'uRotation'),
  };

  frameTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, frameTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, srcWidth, srcHeight);

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

// `source` is a VideoFrame (from the decoder). Draws the filtered result
// into videoCanvas, from which encoded output frames are constructed.
function renderFilteredFrame(source) {
  const gl = glCtx;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.bindTexture(gl.TEXTURE_2D, frameTexture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);

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
  gl.uniform1i(glUniforms.uRotation, currentRotation);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen');
  } catch (err) {
    /* not critical, e.g. page not visible */
  }
  return null;
}

// A flat bitrate loses quality on high-resolution source video (a 4K clip
// can be shot at 25-45 Mbps natively) and wastes bits on small ones, so
// scale the recording target to the actual pixel throughput instead.
function computeBitrate(width, height) {
  const bits = width * height * 60 * 0.2;
  return Math.min(100_000_000, Math.max(6_000_000, Math.round(bits)));
}

function codecFamily(codec) {
  if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'avc';
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 'hevc';
  if (codec.startsWith('vp09')) return 'vp9';
  if (codec.startsWith('av01')) return 'av1';
  throw new Error('Códec de vídeo no reconocido: ' + codec);
}

async function pickVideoEncoderConfig(width, height) {
  const bitrate = computeBitrate(width, height);
  const candidates = [
    'avc1.640034', // H.264 High@5.2 — up to 4096x2304 at high frame rates
    'avc1.64002A', // H.264 High@4.2
    'avc1.4D4028', // H.264 Main@4.0
    'avc1.42E01F', // H.264 Baseline@3.1 — broad-compatibility fallback
  ];
  for (const codec of candidates) {
    const config = { codec, width, height, bitrate, framerate: 60, hardwareAcceleration: 'prefer-hardware' };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config;
    } catch (err) {
      /* try next candidate */
    }
  }
  throw new Error('Este dispositivo no soporta codificar vídeo H.264');
}

// Reads the container (mp4box.js has no decoder — it only parses the box
// structure) to get the video/audio codec configs and every sample's raw
// encoded bytes + timestamp, ready to feed into VideoDecoder untouched.
async function demuxFile(file) {
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;

  const mp4boxFile = MP4Box.createFile();
  const videoSamples = [];
  const audioSamples = [];

  const info = await new Promise((resolve, reject) => {
    mp4boxFile.onError = (e) => reject(new Error(String(e)));
    mp4boxFile.onReady = (readyInfo) => {
      const videoTrackInfo = readyInfo.videoTracks && readyInfo.videoTracks[0];
      const audioTrackInfo = readyInfo.audioTracks && readyInfo.audioTracks[0];
      if (!videoTrackInfo) {
        reject(new Error('El archivo no tiene una pista de vídeo reconocible'));
        return;
      }
      mp4boxFile.setExtractionOptions(videoTrackInfo.id, 'video', { nbSamples: 100000 });
      if (audioTrackInfo) mp4boxFile.setExtractionOptions(audioTrackInfo.id, 'audio', { nbSamples: 100000 });
      mp4boxFile.onSamples = (trackId, user, samples) => {
        if (user === 'video') videoSamples.push(...samples);
        else if (user === 'audio') audioSamples.push(...samples);
      };
      mp4boxFile.start();
      resolve({ videoTrackInfo, audioTrackInfo });
    };
    mp4boxFile.appendBuffer(buffer);
    mp4boxFile.flush();
  });

  const { videoTrackInfo, audioTrackInfo } = info;
  const videoTrak = mp4boxFile.getTrackById(videoTrackInfo.id);
  const stsdEntry = videoTrak.mdia.minf.stbl.stsd.entries[0];
  const configBox = stsdEntry.avcC || stsdEntry.hvcC;
  let description;
  if (configBox) {
    // DataStream is a separate global exposed by mp4box.all.min.js, not a
    // property of the MP4Box object itself.
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    configBox.write(stream);
    description = new Uint8Array(stream.buffer, 8); // skip the box's own size+type header
  }

  return {
    width: videoTrackInfo.track_width,
    height: videoTrackInfo.track_height,
    // A portrait phone video is still stored as landscape pixel data — the
    // track's transformation matrix is what tells a player to rotate it for
    // display. mp4box.js never bakes that into track_width/track_height, so
    // it has to be read separately and carried through to the output
    // untouched, or the result plays back sideways.
    rotation: matrixToRotation(videoTrackInfo.matrix),
    videoTimescale: videoTrackInfo.timescale,
    decoderConfig: {
      codec: videoTrackInfo.codec,
      codedWidth: videoTrackInfo.track_width,
      codedHeight: videoTrackInfo.track_height,
      description,
    },
    videoSamples,
    audioTrackInfo,
    audioTimescale: audioTrackInfo ? audioTrackInfo.timescale : null,
    audioSamples,
  };
}

// The matrix is a 9-value affine transform (3x3, 16.16 fixed-point for the
// rotation/scale terms); for the axis-aligned 90°-multiple rotations phones
// actually use, only the top-left 2x2 block (a, b, c, d) matters.
function matrixToRotation(matrix) {
  if (!matrix) return 0;
  const a = Math.round(matrix[0] / 65536);
  const b = Math.round(matrix[1] / 65536);
  if (a === 0 && b === 1) return 90;
  if (a === -1 && b === 0) return 180;
  if (a === 0 && b === -1) return 270;
  return 0;
}

function sampleToChunk(ChunkType, sample, timescale) {
  return new ChunkType({
    type: sample.is_sync ? 'key' : 'delta',
    timestamp: (sample.cts / timescale) * 1e6,
    duration: (sample.duration / timescale) * 1e6,
    data: sample.data,
  });
}

function resetVideoState() {
  cancelRequested = true;
  if (previewFrame) {
    previewFrame.close();
    previewFrame = null;
  }
  if (activeDecoder && activeDecoder.state !== 'closed') {
    try {
      activeDecoder.close();
    } catch (err) {
      /* already closed */
    }
  }
  if (activeEncoder && activeEncoder.state !== 'closed') {
    try {
      activeEncoder.close();
    } catch (err) {
      /* already closed */
    }
  }
  activeDecoder = null;
  activeEncoder = null;
  parsedVideo = null;
  if (videoResultEl.src) {
    URL.revokeObjectURL(videoResultEl.src);
    videoResultEl.removeAttribute('src');
  }
  if (wakeLockRef) {
    wakeLockRef.release().catch(() => {});
    wakeLockRef = null;
  }
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
    window.showToast('No se pudo cargar el filtro: ' + err.message);
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

  try {
    parsedVideo = await demuxFile(file);
  } catch (err) {
    console.error(err);
    window.showToast('No se pudo leer ese vídeo: ' + err.message);
    resetVideoState();
    return;
  }

  if (!parsedVideo.videoSamples.length) {
    window.showToast('Ese vídeo no tiene fotogramas legibles');
    resetVideoState();
    return;
  }

  currentRotation = parsedVideo.rotation;
  const swapped = currentRotation === 90 || currentRotation === 270;
  videoCanvas.width = swapped ? parsedVideo.height : parsedVideo.width;
  videoCanvas.height = swapped ? parsedVideo.width : parsedVideo.height;

  try {
    setupGL(videoCanvas, parsedVideo.width, parsedVideo.height);
  } catch (err) {
    console.error(err);
    window.showToast('No se pudo preparar el procesado de vídeo: ' + err.message);
    resetVideoState();
    return;
  }

  try {
    previewFrame = await new Promise((resolve, reject) => {
      const decoder = new VideoDecoder({
        output: (frame) => resolve(frame),
        error: reject,
      });
      decoder.configure(parsedVideo.decoderConfig);
      decoder.decode(sampleToChunk(EncodedVideoChunk, parsedVideo.videoSamples[0], parsedVideo.videoTimescale));
      // The decoder can buffer frames internally (e.g. for reorder lookahead)
      // and never call `output` for a lone chunk until told there's no more
      // input coming — flush() is what forces it to actually deliver.
      decoder.flush().then(() => decoder.close());
    });
  } catch (err) {
    console.error(err);
    window.showToast('No se pudo decodificar ese vídeo: ' + (err.message || err));
    resetVideoState();
    return;
  }

  renderFilteredFrame(previewFrame);
  videoStage = 'preview';
  saveBtnEl.disabled = false;
}

intensitySliderEl.addEventListener('input', () => {
  if (videoStage === 'preview' && previewFrame) renderFilteredFrame(previewFrame);
});

async function startVideoProcessing() {
  if (videoStage !== 'preview' || !parsedVideo) return;
  videoStage = 'processing';
  cancelRequested = false;
  saveBtnEl.disabled = true;
  chooseAnotherBtnEl.disabled = true;
  videoProgressOverlay.hidden = false;
  videoProgressFill.style.width = '0%';
  videoProgressLabel.textContent = `0 / ${parsedVideo.videoSamples.length}`;

  if (previewFrame) {
    previewFrame.close();
    previewFrame = null;
  }

  wakeLockRef = await requestWakeLock();

  const { videoTimescale, decoderConfig, videoSamples, audioTrackInfo, audioTimescale, audioSamples } = parsedVideo;
  // The shader already rotates pixels into the canvas's (correctly
  // oriented, possibly width/height-swapped) space, so encode at that size
  // with no further rotation flag — otherwise a rotation-respecting player
  // would rotate an already-upright video a second time.
  const width = videoCanvas.width;
  const height = videoCanvas.height;

  let encoderConfig;
  try {
    encoderConfig = await pickVideoEncoderConfig(width, height);
  } catch (err) {
    console.error(err);
    window.showToast(err.message);
    finishProcessingUI(false);
    return;
  }

  const target = new MP4Muxer.ArrayBufferTarget();
  const muxerOptions = {
    target,
    video: { codec: codecFamily(encoderConfig.codec), width, height },
    fastStart: 'in-memory',
    // B-frame reordering means the first sample's presentation timestamp is
    // often slightly non-zero; let the muxer normalize each track so its
    // own first chunk starts at 0 instead of rejecting it.
    firstTimestampBehavior: 'offset',
  };
  if (audioTrackInfo) {
    muxerOptions.audio = {
      codec: 'aac',
      numberOfChannels: audioTrackInfo.audio.channel_count,
      sampleRate: audioTrackInfo.audio.sample_rate,
    };
  }
  const muxer = new MP4Muxer.Muxer(muxerOptions);

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => console.error('Error del codificador', err),
  });
  encoder.configure(encoderConfig);
  activeEncoder = encoder;

  let processed = 0;
  const total = videoSamples.length;
  let decodeError = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      renderFilteredFrame(frame);
      frame.close();
      const filteredFrame = new VideoFrame(videoCanvas, { timestamp: frame.timestamp, duration: frame.duration });
      encoder.encode(filteredFrame);
      filteredFrame.close();
      processed++;
      videoProgressFill.style.width = `${Math.round((processed / total) * 100)}%`;
      videoProgressLabel.textContent = `${processed} / ${total}`;
    },
    error: (err) => {
      decodeError = err;
      console.error('Error del decodificador', err);
    },
  });
  decoder.configure(decoderConfig);
  activeDecoder = decoder;

  for (const sample of videoSamples) {
    if (cancelRequested || decodeError) break;
    if (decoder.decodeQueueSize > 8) {
      await new Promise((resolve) => decoder.addEventListener('dequeue', resolve, { once: true }));
    }
    decoder.decode(sampleToChunk(EncodedVideoChunk, sample, videoTimescale));
  }

  if (!cancelRequested && !decodeError) {
    await decoder.flush();
    await encoder.flush();
  }
  if (decoder.state !== 'closed') decoder.close();
  if (encoder.state !== 'closed') encoder.close();
  activeDecoder = null;
  activeEncoder = null;

  if (decodeError) {
    window.showToast('No se pudo decodificar ese vídeo en este dispositivo');
    finishProcessingUI(false);
    return;
  }

  if (!cancelRequested && audioTrackInfo) {
    for (const sample of audioSamples) {
      const chunk = sampleToChunk(EncodedAudioChunk, sample, audioTimescale);
      muxer.addAudioChunk(chunk);
    }
  }

  if (!cancelRequested) {
    muxer.finalize();
    resultBlob = new Blob([target.buffer], { type: 'video/mp4' });
    resultMimeType = 'video/mp4';
    const resultUrl = URL.createObjectURL(resultBlob);
    videoResultEl.src = resultUrl;
    videoResultEl.hidden = false;
    videoCanvas.hidden = true;
    videoStage = 'done';
    saveBtnEl.textContent = 'Guardar vídeo';
  }

  finishProcessingUI(true);
}

function finishProcessingUI(success) {
  videoProgressOverlay.hidden = true;
  chooseAnotherBtnEl.disabled = false;
  saveBtnEl.disabled = false;
  if (!success) videoStage = 'preview';
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
  const fileName = `${resultBaseName}_amelie.mp4`;
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
