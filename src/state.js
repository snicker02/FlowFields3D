// state.js — one flat, JSON-serialisable object holds everything. Presets,
// .json save/load and the URL hash all round-trip through this, so any new
// control only has to be added here once.

import { FIELD_BY_ID, defaultParams } from './engine/fields.js';
import { GRADIENT_PRESETS } from './engine/palette.js';

export const STATE_VERSION = 1;

export function defaultState() {
  return {
    version: STATE_VERSION,

    field: {
      fieldA: 'curl',
      paramsA: defaultParams(FIELD_BY_ID.curl),
      fieldB: 'shear',
      paramsB: defaultParams(FIELD_BY_ID.shear),
      blend: 0,
      blendMode: 0,           // 0 lerp, 1 add, 2 cross
      symmetry: 0,
      fractal: {
        mode: 0,              // see FOLD_MODES
        iterations: 3,
        scale: 1.2,
        foldLimit: 1,
        minRadius: 0.5,
        fixedRadius: 1,
        offsetX: 1, offsetY: 1, offsetZ: 1,
        spin: 0,
        tumble: 0,
        octaves: 1,           // self-similar summation of the field itself
        lacunarity: 2,
        gain: 0.5,
        octaveSpin: 37,
      },
      volume: {
        shape: 0,             // see VOLUME_SHAPES
        size: 0.75,           // fraction of the domain
        thickness: 0.25,
        round: 0.1,
        frequency: 4,
        invert: false,
      },
      warp: 0,
      warpScale: 1.2,
      swirl: 0,
      drift: 0,
      domain: 1.6,
      time: 0,
      noiseSeed: 1337,
    },

    trace: {
      seedMode: 0,
      seedCount: 700,
      maxCurves: 900,
      seedRadiusFrac: 0.9,
      stepFrac: 0.012,
      maxSteps: 380,
      minSteps: 14,
      bidirectional: true,
      boundsFrac: 2.4,
      minSpeed: 1e-5,
      integrator: 0,          // 0 RK4, 1 Euler
      even: true,
      dSepFrac: 0.055,
      dTestRatio: 0.55,
      seed: 20260903,
      jitter: 0.2,
    },

    geom: {
      geomMode: 0,            // 0 ribbon, 1 tube, 2 line, 3 box
      width: 0.012,
      widthMode: 1,
      widthAmount: 0.6,
      taperPower: 0.45,
      twist: 0.6,
      twistNoise: 0,
      sides: 6,
      aspect: 0.4,
      smoothIters: 1,
      smoothStrength: 0.5,
    },

    color: {
      colorMode: 0,
      colorCycles: 1,
      colorReverse: false,
      preset: 'Ember',
      gradient: GRADIENT_PRESETS.Ember.map((c, i, a) => ({ t: i / (a.length - 1), color: c })),
    },

    look: {
      bgTop: '#0d1017',
      bgBottom: '#04050a',
      vignette: 0.55,
      lightDir: [0.4, 0.75, 0.55],
      lightColor: '#fff2df',
      skyColor: '#8fb6ff',
      groundColor: '#2a1c2e',
      ambient: 0.55,
      specular: 0.35,
      shininess: 28,
      rim: 0.35,
      fogColor: '#05070c',
      fogDensity: 0.16,
      fogStart: 1.2,
      flowFreq: 3,
      flowStrength: 0,
      flowSpeed: 0.35,
      flowPhase: 0,
      opacity: 1,
      exposure: 1.05,
      renderMode: 0,          // 0 shaded, 1 additive, 2 flat
      cull: false,
      autoRotate: 0,
      sortDepth: true,
      material: 0,            // 0 satin, 1 mirror, 2 glass
      texMode: 0,             // 0 none, 1 bands, 2 stripes, 3 checker, 4 weave, 5 dots, 6 grain, 7 hatch
      texScale: 12,
      texRepeat: 3,
      texAmount: 0.5,
      texSoft: 0.35,
      videoFormat: 'auto',    // auto | mp4 | webm-vp9 | webm-vp8
      videoSeconds: 8,
      videoFps: 30,
      videoTurns: 1,          // camera revolutions across the clip
      videoFlowCycles: 2,     // flow-highlight cycles across the clip
      videoQuality: 16,       // Mbit/s
      exportSize: 1,          // index into EXPORT_SIZES
      exportWidth: 6000,
      exportHeight: 4000,
      supersample: 2,
    },

    camera: { yaw: 0.75, pitch: 0.3, dist: 3.2, fov: 42, target: [0, 0, 0] },
  };
}

/** Deep merge that never introduces keys the defaults do not have. */
export function mergeState(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      mergeState(base[k], v);
    } else if (v !== undefined) {
      base[k] = Array.isArray(v) ? v.slice() : v;
    }
  }
  return base;
}

/** Ensure params objects match the currently selected fields. */
export function reconcileFieldParams(state) {
  for (const slot of ['A', 'B']) {
    const f = FIELD_BY_ID[state.field['field' + slot]];
    if (!f) { state.field['field' + slot] = 'curl'; }
    const field = FIELD_BY_ID[state.field['field' + slot]];
    const cur = state.field['params' + slot] || {};
    const next = defaultParams(field);
    for (const k of Object.keys(next)) if (typeof cur[k] === 'number') next[k] = cur[k];
    state.field['params' + slot] = next;
  }
  return state;
}
