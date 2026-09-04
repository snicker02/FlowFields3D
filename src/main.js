// main.js — wires the engine to the page.
//
// Three levels of work, cheapest first:
//   draw  — new uniforms only
//   geom  — re-extrude the existing streamlines (colour, width, twist, form)
//   trace — re-integrate the field (anything under Field or Streamlines)
// The tracer runs in time slices from the animation loop, so a heavy field
// never freezes the page and the progress bar stays honest.

import { Noise } from './engine/noise.js';
import { makeEvaluator, FIELD_BY_ID } from './engine/fields.js';
import { foldStepScale } from './engine/fractal.js';
import { Tracer } from './engine/integrator.js';
import { prepareCurves, buildMesh } from './engine/geometry.js';
import { Gradient } from './engine/palette.js';
import { Renderer } from './engine/renderer.js';
import { OrbitCamera } from './engine/camera.js';
import { defaultState, mergeState, reconcileFieldParams } from './state.js';
import { PRESETS } from './presets.js';
import { Panel } from './ui/panel.js';
import { GradientEditor } from './ui/gradient.js';
import { downloadBlob, stamp, chunksToOBJ, preparedToSVG, stateToJSON, parseStateJSON } from './io/exporters.js';

const BUILD = '0.1.0';

const app = {
  state: defaultState(),
  gradient: null,
  renderer: null,
  camera: new OrbitCamera(),
  curves: [],
  prepared: null,
  chunks: [],
  tracer: null,
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
  app.camera.attach(canvas, () => { app.dirtyDraw = true; });
  syncCameraFromState();

  const panelRoot = el('panel');
  app.panel = new Panel(panelRoot, app.state, {
    onChange: (level) => schedule(level),
    gradientMount: (mount) => {
      app.gradientEditor = new GradientEditor(mount, app.gradient, () => schedule('geom'));
    },
  });

  // Dragging a trace-level slider drops the budget until the pointer comes up.
  panelRoot.addEventListener('pointerdown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'range') app.draft = true;
  }, true);
  window.addEventListener('pointerup', () => {
    if (app.draft) { app.draft = false; if (app.lastLevel === 'trace') schedule('trace'); else schedule('geom'); }
  });

  buildToolbar();
  window.addEventListener('resize', () => { app.dirtyDraw = true; });
  window.addEventListener('keydown', onKey);

  console.log(`Flow Fields 3D — build ${BUILD}`);
  applyPreset(0);
  requestAnimationFrame(loop);
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
    app.dirtyDraw = true;
  }
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
  };
}

function startTrace() {
  const s = app.state;
  const ctx = {
    noise: new Noise(s.field.noiseSeed | 0),
    noiseB: new Noise(((s.field.noiseSeed | 0) * 2654435761) >>> 0 || 7),
    time: s.field.time,
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
  app.tracer = new Tracer(traceConfig(), evaluate);
  app.traceStart = performance.now();
  app.pendingTrace = false;
  progressEl.classList.add('busy');
}

function finishTrace() {
  app.curves = app.tracer.curves;
  app.lastTraceMs = performance.now() - app.traceStart;
  app.tracer = null;
  progressEl.classList.remove('busy');
  progressBar.style.width = '0%';
  rebuildGeometry();
}

function rebuildGeometry() {
  app.pendingGeom = false;
  if (!app.curves.length) { setStatus('No streamlines survived — try a larger escape radius or a smaller minimum length.'); return; }
  const s = app.state;
  const t0 = performance.now();
  const opts = {
    h: s.field.domain * s.trace.stepFrac,
    ...s.geom,
    colorMode: s.color.colorMode,
    colorCycles: s.color.colorCycles,
    colorReverse: s.color.colorReverse,
  };
  app.prepared = prepareCurves(app.curves, opts, app.gradient);
  app.chunks = buildMesh(app.prepared, s.geom);
  app.renderer.upload(app.chunks);
  app.dirtyDraw = true;
  const ms = performance.now() - t0;
  setStatus(`${app.prepared.items.length} curves · ${app.prepared.totalSamples.toLocaleString()} samples · `
    + `${app.renderer.stats.vertices.toLocaleString()} vertices · trace ${app.lastTraceMs.toFixed(0)} ms · build ${ms.toFixed(0)} ms`);
}

// ---------------------------------------------------------------- frame loop

let lastT = 0;
function loop(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;

  if (app.tracer) {
    const done = app.tracer.runSlice(14);
    progressBar.style.width = (app.tracer.progress * 100).toFixed(1) + '%';
    if (done) finishTrace();
  }

  const look = app.state.look;
  if (look.autoRotate) { app.camera.yaw += look.autoRotate * dt * 0.35; app.dirtyDraw = true; }
  if (look.flowStrength > 0 && look.flowSpeed !== 0) {
    look.flowPhase += look.flowSpeed * dt;
    app.dirtyDraw = true;
  }

  if (app.dirtyDraw) draw();
  requestAnimationFrame(loop);
}

function viewportSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  return { w: Math.max(1, Math.round(r.width * dpr)), h: Math.max(1, Math.round(r.height * dpr)) };
}

function draw() {
  const { w, h } = viewportSize();
  app.renderer.resize(w, h);
  app.camera.fov = app.state.camera.fov;
  app.camera.update(w / h);
  app.renderer.renderScene(
    { mvp: app.camera.mvp, modelView: app.camera.view, normalMat: app.camera.normalMat },
    app.state.look, w, h,
  );
  app.dirtyDraw = false;
  app.state.camera.yaw = app.camera.yaw;
  app.state.camera.pitch = app.camera.pitch;
  app.state.camera.dist = app.camera.dist;
  app.state.camera.target = app.camera.target.slice();
}

function syncCameraFromState() {
  const c = app.state.camera;
  app.camera.yaw = c.yaw; app.camera.pitch = c.pitch; app.camera.dist = c.dist;
  app.camera.fov = c.fov; app.camera.target = c.target.slice();
  app.dirtyDraw = true;
}

function setStatus(text) { statusEl.textContent = text; }

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
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

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

function savePNG() {
  const scale = Math.max(1, Math.round(app.state.look.supersample));
  const { w, h } = viewportSize();
  const W = w * scale, H = h * scale;
  app.renderer.resize(W, H);
  app.camera.update(W / H);
  app.renderer.renderScene(
    { mvp: app.camera.mvp, modelView: app.camera.view, normalMat: app.camera.normalMat },
    app.state.look, W, H,
  );
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, `flowfield-${stamp()}.png`);
    app.dirtyDraw = true;
  }, 'image/png');
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
