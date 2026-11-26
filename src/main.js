// main.js — wires the engine to the page.
//
// Three levels of work, cheapest first:
//   draw  — new uniforms only
//   geom  — re-extrude the existing streamlines (colour, width, twist, form)
//   trace — re-integrate the field (anything under Field or Streamlines)
// The tracer runs in time slices from the animation loop, so a heavy field
// never freezes the page and the progress bar stays honest.

import { initPanelTabs } from './ui/tabs.js';
import { Noise } from './engine/noise.js';
import { makeEvaluator, FIELD_BY_ID } from './engine/fields.js';
import { foldStepScale } from './engine/fractal.js';
import { recordFrames, chooseVideoFormat, availableVideoFormats } from './io/recorder.js';
import { makeVolume } from './engine/volume.js';
import { halton, diskSample, sphereSample, coneSample } from './engine/rt.js';
import { canParallelise, parallelTrace, workerCount } from './engine/pool.js';
import { ImageSource, makeImageField, toPowerOfTwoCanvas, readImageFile } from './engine/image.js';
import { Tracer } from './engine/integrator.js';
import { prepareCurves, buildMesh, computeOcclusion } from './engine/geometry.js';
import { Gradient } from './engine/palette.js';
import { Renderer } from './engine/renderer.js';
import { OrbitCamera } from './engine/camera.js';
import { defaultState, mergeState, reconcileFieldParams } from './state.js';
import { PRESETS } from './presets.js';
import { Panel } from './ui/panel.js';
import { GradientEditor } from './ui/gradient.js';
import { downloadBlob, stamp, chunksToOBJ, preparedToSVG, stateToJSON, parseStateJSON, resolveExportSize } from './io/exporters.js';

const BUILD = '0.4.0';

const app = {
  state: defaultState(),
  gradient: null,
  renderer: null,
  camera: new OrbitCamera(),
  curves: [],
  prepared: null,
  chunks: [],
  tracer: null,
  rtSample: 0,
  occKey: null,
  occMs: 0,
  rtBroken: false,
  lastStatus: '',
  traceToken: 0,
  parallelBroken: false,
  image: null,          // ImageSource, once one is loaded
  history: [],          // undo ring
  future: [],           // redo stack
  restoring: false,
  dirtyDraw: true,
  pendingTrace: false,
  pendingGeom: false,
  draft: false,
  traceStart: 0,
  lastTraceMs: 0,
};

const el = (id) => document.getElementById(id);
const canvas = el('view');
const statusEl = el('status');
const progressEl = el('progress');
const progressBar = el('progress-bar');

function boot() {
  try {
    app.renderer = new Renderer(canvas);
  } catch (e) {
    document.body.innerHTML = `<div class="fatal"><h1>WebGL is unavailable</h1><p>${e.message}</p>
      <p>Try a different browser, or enable hardware acceleration.</p></div>`;
    return;
  }

  app.gradient = new Gradient(app.state.color.gradient);
  app.camera.attach(canvas, () => { invalidate(); });
  syncCameraFromState();

  const panelRoot = el('panel');
  app.panel = new Panel(panelRoot, app.state, {
    onChange: (level) => { scheduleHistory(); if (holdChange(level)) return; schedule(level); },
    gradientMount: (mount) => {
      app.gradientEditor = new GradientEditor(mount, app.gradient, () => { scheduleHistory(); schedule('geom'); });
    },
  });

  // Dragging a trace-level slider drops the budget until the pointer comes up.
  panelRoot.addEventListener('pointerdown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'range') app.draft = true;
  }, true);
  window.addEventListener('pointerup', () => {
    if (!app.draft) return;
    app.draft = false;
    if (app.held) return;               // confirm mode: the change waits for Apply
    if (app.lastLevel === 'trace') schedule('trace'); else schedule('geom');
  });

  buildToolbar();
  initConfirm();
  initPanelTabs({ sidebar: el('sidebar'), toolbar: el('toolbar'), panel: panelRoot, onLayout: () => invalidate() });
  window.addEventListener('resize', () => { invalidate(); });
  window.addEventListener('keydown', onKey);

  console.log(`Flow Fields 3D — build ${BUILD}`);
  applyPreset(0);
  pushHistory();                        // the state undo eventually returns to
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------- confirm changes
// Retracing thousands of streamlines on every slider step is slow, above all
// on phones. With "Confirm changes" on (the default) trace- and geometry-level
// edits wait for Apply (or Enter); colour, light and camera stay live. Retrace,
// Shuffle and presets act at once and take any held change with them.

let confirmMode = true;
try { const v = localStorage.getItem('ff3d.confirm'); if (v !== null) confirmMode = v === '1'; } catch (_) { /* storage unavailable */ }

function holdChange(level) {
  if (!confirmMode || (level !== 'trace' && level !== 'geom')) return false;
  if (app.held !== 'trace') app.held = level;     // a held trace already covers geometry
  updateApply();
  return true;
}
function updateApply() {
  const b = el('apply');
  if (b) b.hidden = !app.held;
}
function applyHeld() {
  const level = app.held;
  if (!level) return;
  app.held = null; updateApply();
  schedule(level);
}
function initConfirm() {
  el('apply').addEventListener('click', applyHeld);
  const c = el('confirm');
  c.checked = confirmMode;
  c.addEventListener('change', () => {
    confirmMode = c.checked;
    try { localStorage.setItem('ff3d.confirm', confirmMode ? '1' : '0'); } catch (_) { /* storage unavailable */ }
    if (!confirmMode) applyHeld();
  });
}

// ---------------------------------------------------------------- scheduling

let traceTimer = 0;
function schedule(level) {
  app.lastLevel = level;
  if (level === 'trace') {
    app.pendingTrace = true;
    clearTimeout(traceTimer);
    traceTimer = setTimeout(startTrace, 90);
  } else if (level === 'geom') {
    app.pendingGeom = true;
    clearTimeout(traceTimer);
    traceTimer = setTimeout(rebuildGeometry, 40);
  } else if (level !== 'none') {
    invalidate();
  }
}

/** The image as a scalar field, or null when there is nothing to read. */
function imageField() {
  return makeImageField(app.image, app.state.field.image, app.state.field.domain);
}

/**
 * Seed weighting. The floor matters: at zero, dark regions get no seeds at all
 * and the picture loses its darks entirely rather than rendering them sparsely.
 */
function imageSeedWeight() {
  const cfg = app.state.field.image;
  const f = imageField();
  if (!f || cfg.seedPower <= 0) return null;
  const floor = Math.max(0, Math.min(1, cfg.seedFloor));
  return (x, y, z) => floor + (1 - floor) * Math.pow(f(x, y, z), cfg.seedPower);
}

function traceConfig() {
  const s = app.state;
  const scale = app.draft ? 0.3 : 1;
  return {
    ...s.trace,
    domain: s.field.domain,
    maxCurves: Math.max(20, Math.round(s.trace.maxCurves * scale)),
    seedCount: Math.max(20, Math.round(s.trace.seedCount * scale)),
    maxSteps: Math.max(20, Math.round(s.trace.maxSteps * (app.draft ? 0.55 : 1))),
    // Folding compresses the field, so hold the samples-per-feature roughly
    // constant instead of letting the detail slip between steps.
    stepFrac: s.trace.stepFrac / foldStepScale(s.field.fractal),
    inside: makeVolume(s.field.volume, s.field.domain),
    seedWeight: imageSeedWeight(),
    vorticity: !!s.geom.streamribbon,
  };
}

function startTrace() {
  if (app.held) { app.held = null; updateApply(); }
  const s = app.state;
  const ctx = {
    noise: new Noise(s.field.noiseSeed | 0),
    noiseB: new Noise(((s.field.noiseSeed | 0) * 2654435761) >>> 0 || 7),
    time: s.field.time,
    // The image-contour field reads the loaded picture directly, in world units.
    image: makeImageField(app.image, { ...s.field.image, enabled: !!app.image }, s.field.domain),
  };
  let evaluate;
  try {
    evaluate = makeEvaluator({
      fieldA: s.field.fieldA, paramsA: s.field.paramsA,
      fieldB: s.field.fieldB, paramsB: s.field.paramsB,
      blend: s.field.blend, blendMode: s.field.blendMode,
      symmetry: s.field.symmetry, fractal: s.field.fractal,
      warp: s.field.warp, warpScale: s.field.warpScale,
      swirl: s.field.swirl, drift: s.field.drift, domain: s.field.domain,
    }, ctx);
  } catch (e) {
    setStatus(`Could not build the field: ${e.message}`);
    return;
  }
  const cfg = traceConfig();
  app.traceStart = performance.now();
  app.pendingTrace = false;
  progressEl.classList.add('busy');

  if (!app.parallelBroken && canParallelise(cfg)) {
    // The workers rebuild the field from the same config, so this is the same
    // trace, dealt out. Anything that goes wrong falls back to tracing here.
    const token = ++app.traceToken;
    app.tracer = null;
    setStatus(`Tracing on ${workerCount()} workers...`);
    parallelTrace(workerMessage(cfg), (f) => {
      if (token === app.traceToken) progressBar.style.width = (f * 100).toFixed(1) + '%';
    }).then((curves) => {
      if (token !== app.traceToken) return;      // superseded by a newer trace
      app.curves = curves;
      app.lastTraceMs = performance.now() - app.traceStart;
      progressEl.classList.remove('busy');
      progressBar.style.width = '0%';
      rebuildGeometry();
    }).catch(() => {
      if (token !== app.traceToken) return;
      app.parallelBroken = true;                 // do not keep retrying
      app.tracer = new Tracer(cfg, evaluate);
    });
    return;
  }

  app.tracer = new Tracer(cfg, evaluate);
}

/** Everything a worker needs to rebuild this trace from scratch. */
function workerMessage(cfg) {
  const s = app.state;
  const plain = { ...cfg };
  delete plain.inside;                            // closures do not survive the trip
  delete plain.seedWeight;
  const img = app.image;
  const weight = s.field.image.enabled && img && s.field.image.seedPower > 0
    ? { floor: Math.max(0, Math.min(1, s.field.image.seedFloor)), power: s.field.image.seedPower }
    : null;
  return {
    cfg: plain,
    fieldCfg: {
      fieldA: s.field.fieldA, paramsA: s.field.paramsA,
      fieldB: s.field.fieldB, paramsB: s.field.paramsB,
      blend: s.field.blend, blendMode: s.field.blendMode,
      symmetry: s.field.symmetry, fractal: s.field.fractal,
      warp: s.field.warp, warpScale: s.field.warpScale,
      swirl: s.field.swirl, drift: s.field.drift, domain: s.field.domain,
    },
    volumeCfg: s.field.volume,
    imageCfg: s.field.image,
    seedWeightCfg: weight,
    image: img ? { width: img.width, height: img.height, lum: img.lum } : null,
    noiseSeed: s.field.noiseSeed,
    time: s.field.time,
  };
}

function finishTrace() {
  app.curves = app.tracer.curves;
  app.lastTraceMs = performance.now() - app.traceStart;
  app.tracer = null;
  progressEl.classList.remove('busy');
  progressBar.style.width = '0%';
  rebuildGeometry();
}

/**
 * Measure occlusion once per set of curves and per radius, and hang it on the
 * curves. It walks every sample against a grid of every other sample, so it is
 * the slowest thing in a geometry rebuild — recomputing it when only a colour
 * changed would make the panel feel broken.
 */
function ensureOcclusion() {
  const look = app.state.look;
  if (!app.curves || !app.curves.length) return;
  const on = look.occlusion > 0.001;
  const key = on ? `${app.traceToken}|${look.occlusionRadius}|${look.occlusionStrength}` : 'off';
  if (app.occKey === key) return;
  app.occKey = key;

  if (!on) {
    for (const c of app.curves) c.occ = null;
    return;
  }
  // The radius is a fraction of the fitted unit ball, but the curves are still
  // in field units here, so it is scaled back by the same span the fit uses.
  let span = 0;
  for (const c of app.curves) {
    for (let i = 0; i < c.n; i++) {
      span = Math.max(span, Math.abs(c.pts[i * 3]), Math.abs(c.pts[i * 3 + 1]), Math.abs(c.pts[i * 3 + 2]));
    }
  }
  const radius = Math.max(1e-5, look.occlusionRadius * Math.max(1e-6, span));
  const t = performance.now();
  const occ = computeOcclusion(app.curves, radius, look.occlusionStrength);
  for (let i = 0; i < app.curves.length; i++) app.curves[i].occ = occ[i];
  app.occMs = performance.now() - t;
}

function rebuildGeometry() {
  app.pendingGeom = false;
  if (app.held === 'geom') { app.held = null; updateApply(); }
  if (!app.curves.length) { setStatus('No streamlines survived — try a larger escape radius or a smaller minimum length.'); return; }
  const s = app.state;
  const t0 = performance.now();
  ensureOcclusion();
  const opts = {
    h: s.field.domain * s.trace.stepFrac,
    ...s.geom,
    colorMode: s.color.colorMode,
    colorCycles: s.color.colorCycles,
    colorReverse: s.color.colorReverse,
    imageAt: imageField(),
  };
  app.prepared = prepareCurves(app.curves, opts, app.gradient);
  app.chunks = buildMesh(app.prepared, s.geom);
  app.renderer.upload(app.chunks);
  invalidate();
  const ms = performance.now() - t0;
  setStatus(`${app.prepared.items.length} curves · ${app.prepared.totalSamples.toLocaleString()} samples · `
    + `${app.renderer.stats.vertices.toLocaleString()} vertices · trace ${app.lastTraceMs.toFixed(0)} ms · build ${ms.toFixed(0)} ms`);
}

// ---------------------------------------------------------------- frame loop

let lastT = 0;
function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;

  // A tiled export owns the canvas until it finishes; drawing the live view
  // underneath it would resize the buffer out from under the tile being read.
  if (app.exporting) { requestAnimationFrame(loop); return; }

  if (app.tracer) {
    const done = app.tracer.runSlice(14);
    progressBar.style.width = (app.tracer.progress * 100).toFixed(1) + '%';
    if (done) finishTrace();
  }

  const look = app.state.look;
  if (look.autoRotate) { app.camera.yaw += look.autoRotate * dt * 0.35; invalidate(); }
  if (look.flowStrength > 0 && look.flowSpeed !== 0) {
    look.flowPhase += look.flowSpeed * dt;
    invalidate();
  }
  if (look.travelMode > 0 && look.travelSpeed !== 0) {
    look.travelPhase += look.travelSpeed * dt;
    invalidate();
  }

  if (app.dirtyDraw) draw();
  requestAnimationFrame(loop);
}

function viewportSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  return { w: Math.max(1, Math.round(r.width * dpr)), h: Math.max(1, Math.round(r.height * dpr)) };
}

/**
 * Anything that changes the picture restarts the refinement. Averaging samples
 * taken under different settings would smear the old image into the new one,
 * so the mean has to begin again rather than carry on.
 */
function invalidate() {
  app.rtSample = 0;
  app.dirtyDraw = true;
}

/** The camera bundle every draw path hands the renderer. */
function lookBundle() {
  const c = app.camera;
  return {
    mvp: c.mvp, modelView: c.view, normalMat: c.normalMat, viewDir: c.viewDir,
    camPos: c.eyeJittered || c.eye,
    camRight: c.right, camUp: c.upVec, camFwd: c.fwd,
    tanHalfFov: Math.tan((c.fov * Math.PI) / 180 / 2),
  };
}

/**
 * The jitter for one refinement sample: a sub-pixel offset, a point on the
 * lens, a direction inside the sun's disc, and one direction for the sky.
 * Driven by the sample index alone, so a given sample is the same on every
 * machine and in every tile of a big export.
 */
function sampleJitter(i, w, h) {
  const look = app.state.look;
  return {
    ndc: [(halton(i, 2) - 0.5) * 2 / w, (halton(i, 3) - 0.5) * 2 / h],
    lens: diskSample(i),
    aperture: look.rtAperture,
    focus: look.rtFocus,
  };
}

function sampleRtConfig(i) {
  const look = app.state.look;
  const sun = look.lightDir;
  return {
    sunShadow: !!look.rtSunShadow,
    skyLight: !!look.rtSkyLight,
    sunDir: coneSample(sun, i, look.rtSunSoftness),
    skyDir: sphereSample(i),
    bias: look.rtBias,
  };
}

/** True when progressive refinement is on and the driver gave us the targets. */
function rtActive(w, h) {
  const look = app.state.look;
  if (!look.rtEnabled || app.rtBroken) return false;
  const size = (look.rtSunShadow || look.rtSkyLight) ? (look.rtShadowSize | 0) : 0;
  if (!app.renderer.ensureTargets(w, h, size)) {
    app.rtBroken = true;
    setStatus('This driver would not give us an offscreen buffer, so refinement is off.');
    return false;
  }
  return true;
}

function draw() {
  const { w, h } = viewportSize();
  app.renderer.resize(w, h);
  app.camera.fov = app.state.camera.fov;

  if (rtActive(w, h)) {
    // One sample per frame. Restarting on every change is what makes the
    // preview responsive: drag the camera and you get a noisy image that
    // settles the moment you stop, rather than a frozen one that is accurate.
    app.camera.update(w / h, null, sampleJitter(app.rtSample, w, h));
    app.renderer.renderSample(lookBundle(), app.state.look, w, h, app.rtSample, sampleRtConfig(app.rtSample));
    app.rtSample++;
    app.renderer.present(app.state.look, w, h);
    const total = Math.max(1, app.state.look.rtSamples | 0);
    if (app.rtSample < total) app.dirtyDraw = true;       // keep refining
    else app.dirtyDraw = false;
    if (app.rtSample === total) setStatus(`${app.lastStatus} · refined to ${total} samples`);
  } else {
    app.camera.update(w / h);
    app.renderer.renderScene(lookBundle(), app.state.look, w, h);
    app.dirtyDraw = false;
  }

  app.state.camera.yaw = app.camera.yaw;
  app.state.camera.pitch = app.camera.pitch;
  app.state.camera.dist = app.camera.dist;
  app.state.camera.target = app.camera.target.slice();
}

function syncCameraFromState() {
  const c = app.state.camera;
  app.camera.yaw = c.yaw; app.camera.pitch = c.pitch; app.camera.dist = c.dist;
  app.camera.fov = c.fov; app.camera.target = c.target.slice();
  invalidate();
}

const HISTORY_LIMIT = 60;
let historyTimer = 0;

/**
 * Coalesce a slider drag into one undo step. Without this, dragging a slider
 * fills the whole ring with near-identical states and undo becomes useless.
 */
function scheduleHistory() {
  if (app.restoring) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(pushHistory, 450);
}

/**
 * Push the current state onto the undo ring. Snapshots are JSON, which is small
 * enough at this size and immune to the aliasing bugs a shallow copy would give
 * — the state is nested, and a shared sub-object would let undo mutate its own
 * history.
 */
function pushHistory() {
  if (app.restoring) return;
  const snap = stateToJSON(app.state);
  if (app.history.length && app.history[app.history.length - 1] === snap) return;
  app.history.push(snap);
  if (app.history.length > HISTORY_LIMIT) app.history.shift();
  app.future.length = 0;
}

function applyState(patch, message) {
  app.restoring = true;
  try {
    app.state = reconcileFieldParams(mergeState(defaultState(), patch));
    app.gradient = new Gradient(app.state.color.gradient);
    app.panel.state = app.state;
    app.panel.refresh();
    if (app.gradientEditor) { app.gradientEditor.gradient = app.gradient; app.gradientEditor.refresh(); }
    syncCameraFromState();
    schedule('trace');
    if (message) setStatus(message);
  } finally {
    app.restoring = false;
  }
}

function undo() {
  if (app.history.length < 2) { setStatus('Nothing to undo.'); return; }
  app.future.push(app.history.pop());
  applyState(parseStateJSON(app.history[app.history.length - 1]),
    `Undone — ${app.history.length - 1} step${app.history.length === 2 ? '' : 's'} back available`);
}

function redo() {
  if (!app.future.length) { setStatus('Nothing to redo.'); return; }
  const snap = app.future.pop();
  app.history.push(snap);
  applyState(parseStateJSON(snap), 'Redone');
}

function setStatus(text) { app.lastStatus = text; statusEl.textContent = text; }

function setProgress(frac) {
  progressBar.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
  progressEl.classList.toggle('busy', frac > 0);
}

// ---------------------------------------------------------------- toolbar

function buildToolbar() {
  const presetSel = el('preset');
  PRESETS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = p.name;
    presetSel.appendChild(o);
  });
  presetSel.addEventListener('change', () => applyPreset(parseInt(presetSel.value, 10)));

  el('regen').addEventListener('click', () => {
    app.state.trace.seed = Math.floor(Math.random() * 1e8);
    app.panel.refresh();
    schedule('trace');
  });

  el('shuffle').addEventListener('click', shuffle);
  el('fit').addEventListener('click', () => {
    app.state.camera = { yaw: 0.75, pitch: 0.3, dist: 3.2, fov: app.state.camera.fov, target: [0, 0, 0] };
    syncCameraFromState();
  });

  el('png').addEventListener('click', savePNG);
  el('obj').addEventListener('click', () => {
    if (!app.chunks.length) return;
    downloadBlob(new Blob([chunksToOBJ(app.chunks)], { type: 'text/plain' }), `flowfield-${stamp()}.obj`);
  });
  el('svg').addEventListener('click', saveSVG);
  el('video').addEventListener('click', saveVideo);

  el('image').addEventListener('click', () => el('imagefile').click());
  el('imagefile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) loadImageFile(file);
  });

  // shared image shelf (snicker02.github.io/shared/bridge.js)
  if (window.SnickerShelf) {
    window.SnickerShelf.mount({
      app: 'FlowFields3D',
      button: el('shelfBtn'),
      onImage: (file) => loadImageFile(file),
      getImage: () => {
        if (app.exporting) throw new Error('busy exporting');
        return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      },
      getMeta: () => ({ name: `flowfield3d-${stamp()}.png` }),
    });
  } else {
    el('shelfBtn').hidden = true;
  }
  el('save').addEventListener('click', () => {
    app.state.color.gradient = app.gradient.toJSON();
    downloadBlob(new Blob([stateToJSON(app.state)], { type: 'application/json' }), `flowfield-${stamp()}.json`);
  });
  el('load').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const patch = parseStateJSON(txt);
        pushHistory();
        app.state = reconcileFieldParams(mergeState(defaultState(), patch));
        app.gradient = new Gradient(app.state.color.gradient);
        app.panel.state = app.state;
        app.panel.refresh();
        if (app.gradientEditor) { app.gradientEditor.gradient = app.gradient; app.gradientEditor.refresh(); }
        syncCameraFromState();
        schedule('trace');
      } catch (err) {
        setStatus(`That file could not be read: ${err.message}`);
      }
      e.target.value = '';
    });
  });

  el('hide').addEventListener('click', () => setPanelHidden(true));
  el('show').addEventListener('click', () => setPanelHidden(false));
}

function applyPreset(i) {
  scheduleHistory();
  const p = PRESETS[i];
  if (!p) return;
  app.state = reconcileFieldParams(mergeState(defaultState(), p.patch));
  app.gradient = new Gradient(app.state.color.gradient);
  app.panel.state = app.state;
  app.panel.refresh();
  if (app.gradientEditor) { app.gradientEditor.gradient = app.gradient; app.gradientEditor.refresh(); }
  syncCameraFromState();
  startTrace();
}

function shuffle() {
  scheduleHistory();
  const s = app.state;
  const r = (a, b) => a + Math.random() * (b - a);
  s.trace.seed = Math.floor(Math.random() * 1e8);
  s.field.noiseSeed = Math.floor(r(1, 9999));
  s.geom.twist = r(-2.2, 2.2);
  s.color.colorMode = Math.floor(r(0, 9));
  s.color.colorCycles = Math.random() < 0.6 ? 1 : Math.floor(r(2, 5));
  s.field.symmetry = Math.random() < 0.5 ? 0 : Math.floor(r(1, 10));
  s.field.warp = Math.random() < 0.6 ? 0 : r(0.05, 0.4);
  const field = FIELD_BY_ID[s.field.fieldA];
  if (field) {
    for (const p of field.params) {
      if (p.choice) continue;
      const span = (p.max - p.min) * 0.22;
      const v = s.field.paramsA[p.id] + r(-span, span);
      s.field.paramsA[p.id] = Math.max(p.min, Math.min(p.max, p.step >= 1 ? Math.round(v) : v));
    }
  }
  app.panel.refresh();
  schedule('trace');
}

function setPanelHidden(hidden) {
  const sidebar = el('sidebar');
  document.body.classList.toggle('panel-hidden', hidden);
  sidebar.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  if (hidden) {
    // Move focus off the panel before it goes away, so the h key still reaches
    // the window and the tab order does not wander into a hidden region.
    if (document.activeElement && sidebar.contains(document.activeElement)) document.activeElement.blur();
    el('show').focus();
  } else {
    el('hide').focus();
  }
}

function onKey(e) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // Checked before the modifier guard below, since these are the one pair of
  // shortcuts that are *supposed* to arrive with ctrl or cmd held.
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (k === 'Enter' && app.held && !e.repeat) {
    const t = e.target;
    if (!(t && (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA'))) { e.preventDefault(); applyHeld(); return; }
  }

  // h is deliberately not gated on where the focus is: it is the way out of a
  // hidden panel, so it has to work from anywhere. No control here takes typed
  // text, so nothing is lost by claiming the letter.
  if (k === 'h') { e.preventDefault(); setPanelHidden(!document.body.classList.contains('panel-hidden')); return; }

  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (k === 'r') { el('regen').click(); }
  else if (k === ' ') { e.preventDefault(); shuffle(); }
  else if (k === 'p') { savePNG(); }
}

// ---------------------------------------------------------------- exports

/**
 * Record a looping turntable. The clock is the frame index, not wall time, so
 * the clip is the same length and the same motion whatever the machine manages
 * per second — and because the camera does a whole number of turns and the flow
 * a whole number of cycles, the last frame lands exactly where the first began.
 */
async function saveVideo() {
  if (app.exporting) return;
  const s = app.state, look = s.look;

  const format = chooseVideoFormat(look.videoFormat);
  if (!format) {
    const have = availableVideoFormats();
    setStatus(have.length
      ? `This browser will not encode ${look.videoFormat}. It offers: ${have.map((f) => f.label).join(', ')}.`
      : 'This browser cannot record video from a canvas.');
    return;
  }

  const fps = Math.max(1, Math.round(look.videoFps));
  const frames = Math.max(1, Math.round(look.videoSeconds * fps));
  const yaw0 = app.camera.yaw, phase0 = look.flowPhase, travel0 = look.travelPhase;
  const { w, h } = viewportSize();

  app.exporting = true;
  app.cancelExport = false;
  try {
    app.renderer.resize(w, h);
    const blob = await recordFrames({
      canvas,
      format,
      fps,
      frames,
      bitrate: Math.round(look.videoQuality * 1e6),
      shouldCancel: () => app.cancelExport,
      onProgress: (f) => {
        setProgress(f);
        setStatus(`Recording ${format.label} — frame ${Math.round(f * frames)} of ${frames}`);
      },
      drawFrame: (i, t) => {
        app.camera.yaw = yaw0 + t * look.videoTurns * Math.PI * 2;
        look.flowPhase = phase0 + t * look.videoFlowCycles;
        look.travelPhase = travel0 + t * look.videoTravelCycles;
        app.camera.update(w / h);
        app.renderer.renderScene(
          { mvp: app.camera.mvp, modelView: app.camera.view, normalMat: app.camera.normalMat, viewDir: app.camera.viewDir },
          look, w, h,
        );
      },
    });
    if (blob && blob.size) {
      downloadBlob(blob, `flowfield-${stamp()}.${format.ext}`);
      setStatus(`Saved ${frames} frames at ${fps} fps as ${format.label} — ${(blob.size / 1048576).toFixed(1)} MB`);
    } else {
      setStatus('The recording came back empty. Try a shorter clip or a different format.');
    }
  } catch (e) {
    setStatus(`Recording failed: ${e.message}`);
  } finally {
    app.camera.yaw = yaw0;
    look.flowPhase = phase0;
    look.travelPhase = travel0;
    setProgress(0);
    app.exporting = false;
    app.camera.update(w / h);
    invalidate();
  }
}

/**
 * Render a PNG at an arbitrary size by drawing it in tiles.
 *
 * A single huge drawing buffer is the obvious approach and the wrong one: a
 * 12K frame is 75 megapixels before supersampling, past what a WebGL context
 * will hand out on most machines and all of it resident at once. Instead the
 * canvas stays small and walks the image, each tile rendered through its own
 * slice of the *same* frustum, composited into a 2D canvas as it goes. The
 * camera never moves, so the tiles line up exactly.
 */
// Load an image to drive density, colour or texture (Image button, drop, or the shelf).
async function loadImageFile(file) {
    try {
      setStatus(`Reading ${file.name}...`);
      const loaded = await readImageFile(file);
      app.image = new ImageSource(loaded.data, loaded.name);
      app.renderer.setTexture(toPowerOfTwoCanvas(loaded.element));
      app.state.field.image.enabled = true;
      app.panel.refresh();
      pushHistory();
      schedule('trace');
      setStatus(`Loaded ${loaded.name} (${loaded.data.width} x ${loaded.data.height} sampled)`
        + ' — set Seed bias, or pick "Image luminance" for colour, "By image" for width, "Loaded image" for texture.');
    } catch (err) {
      setStatus(`That image could not be loaded: ${err.message}`);
    }
}

async function savePNG() {
  if (app.exporting) return;
  const s = app.state;
  const view = viewportSize();
  const { w: W, h: H, label } = resolveExportSize(s.look, view.w, view.h);
  const ss = Math.max(1, Math.min(4, Math.round(s.look.supersample)));

  // Browsers refuse to allocate a canvas past roughly this area, and the ones
  // that do not refuse tend to return a blank image instead, which is worse.
  const MAX_PIXELS = 300e6;
  if (W * H > MAX_PIXELS) {
    setStatus(`${W} x ${H} is ${(W * H / 1e6).toFixed(0)} megapixels — past what a browser canvas will hold. Try a smaller size.`);
    return;
  }

  let out, ctx2d;
  try {
    out = document.createElement('canvas');
    out.width = W; out.height = H;
    ctx2d = out.getContext('2d');
    if (!ctx2d) throw new Error('no 2D context');
  } catch (e) {
    setStatus(`Could not allocate a ${W} x ${H} image: ${e.message}`);
    return;
  }

  const gl = app.renderer.gl;
  const maxDim = Math.min(2048, gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0] || 2048);
  const tileT = Math.max(64, Math.floor(maxDim / ss));   // tile size in output pixels
  const cols = Math.ceil(W / tileT), rows = Math.ceil(H / tileT);
  const total = cols * rows;

  // Refinement multiplies the work by the sample count, so say so up front
  // rather than letting it look like a hang.
  const rtOn = !!s.look.rtEnabled && !app.rtBroken;
  const rtSamples = rtOn ? Math.max(1, s.look.rtSamples | 0) : 1;
  const shadowSize = (s.look.rtSunShadow || s.look.rtSkyLight) ? (s.look.rtShadowSize | 0) : 0;

  app.exporting = true;
  const restore = () => {
    app.exporting = false;
    const v = viewportSize();
    app.renderer.resize(v.w, v.h);
    app.camera.update(v.w / v.h);
    invalidate();
  };

  try {
    let done = 0;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const x = tx * tileT, y = ty * tileT;
        const tw = Math.min(tileT, W - x), th = Math.min(tileT, H - y);
        const pw = tw * ss, ph = th * ss;

        // Image rows run downwards, the frustum runs upwards.
        const rect = [x / W, (x + tw) / W, 1 - (y + th) / H, 1 - y / H];

        app.renderer.resize(pw, ph);
        const uv = [rect[0], rect[2], rect[1] - rect[0], rect[3] - rect[2]];

        if (rtOn) {
          // Each tile is refined on its own. The jitter is a function of the
          // sample index alone, so every tile uses the same lens positions and
          // the same sun and sky directions — the seams stay invisible.
          app.renderer.ensureTargets(pw, ph, shadowSize);
          for (let k = 0; k < rtSamples; k++) {
            app.camera.update(W / H, rect, sampleJitter(k, pw, ph));
            app.renderer.renderSample(lookBundle(), s.look, pw, ph, k, sampleRtConfig(k), uv);
            if ((k & 15) === 15) {
              setProgress((done + (k + 1) / rtSamples) / total);
              await new Promise((r) => requestAnimationFrame(r));
            }
          }
          app.renderer.present(s.look, pw, ph);
        } else {
          app.camera.update(W / H, rect);
          app.renderer.renderScene(lookBundle(), s.look, pw, ph, uv);
        }
        ctx2d.drawImage(canvas, 0, 0, pw, ph, x, y, tw, th);

        done++;
        if (total > 1) {
          setProgress(done / total);
          setStatus(`Rendering ${W} x ${H}${ss > 1 ? ` at ${ss}x` : ''}`
            + `${rtOn ? ` at ${rtSamples} samples` : ''} — tile ${done} of ${total}`);
          await new Promise((r) => requestAnimationFrame(r));   // let the bar move
        }
      }
    }

    setProgress(0);
    setStatus(`Encoding ${W} x ${H}...`);
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    if (blob) {
      downloadBlob(blob, `flowfield-${stamp()}.png`);
      setStatus(`Saved ${W} x ${H} (${label}${ss > 1 ? `, ${ss}x supersampled` : ''}) — ${(blob.size / 1048576).toFixed(1)} MB`);
    } else {
      setStatus(`The browser would not encode a ${W} x ${H} PNG. Try a smaller size or a lower supersample.`);
    }
  } catch (e) {
    setStatus(`Export failed: ${e.message}`);
  } finally {
    setProgress(0);
    restore();
  }
}

function saveSVG() {
  if (!app.prepared) return;
  const r = canvas.getBoundingClientRect();
  const W = Math.round(r.width), H = Math.round(r.height);
  app.camera.update(W / H);
  const fovScale = 1 / Math.tan((app.state.camera.fov * Math.PI) / 360);
  const svg = preparedToSVG(app.prepared, {
    width: W, height: H,
    mvp: app.camera.mvp,
    fovScale,
    strokeScale: H * 0.5,
    strokeMul: 1,
    perspectiveWidth: true,
    depthFade: 0.55,
    nearW: Math.max(0.05, app.camera.dist - 1),
    farW: app.camera.dist + 1,
    quantise: app.state.color.colorMode === 1 || app.state.color.colorMode === 8 ? 6 : 0,
    background: app.state.look.bgBottom,
  });
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `flowfield-${stamp()}.svg`);
}

boot();
