// presets.js — starting points. Each entry is a patch merged onto defaultState().
// They exist mainly so the wilder fields are discoverable: several of them only
// look right with matching step size, separation and geometry settings.

import { GRADIENT_PRESETS } from './engine/palette.js';

const grad = (name) => ({
  preset: name,
  gradient: GRADIENT_PRESETS[name].map((c, i, a) => ({ t: i / (a.length - 1), color: c })),
});

export const PRESETS = [
  {
    name: 'Silk ribbons',
    patch: {
      field: { fieldA: 'curl', paramsA: { scale: 1.05, octaves: 3, gain: 0.5, drift: 0.1 }, domain: 1.6 },
      trace: { even: true, dSepFrac: 0.05, maxCurves: 900, stepFrac: 0.011, maxSteps: 380, seedMode: 0 },
      geom: { geomMode: 0, width: 0.014, widthMode: 1, taperPower: 0.4, twist: 0.7, smoothIters: 1 },
      color: { colorMode: 0, ...grad('Ember') },
      look: { renderMode: 0, ambient: 0.55, rim: 0.4, fogDensity: 0.18 },
    },
  },
  {
    name: 'Lorenz tape',
    patch: {
      field: { fieldA: 'lorenz', paramsA: { sigma: 10, rho: 28, beta: 2.6667 }, domain: 24 },
      trace: { even: false, seedMode: 6, seedCount: 200, maxCurves: 200, stepFrac: 0.005, maxSteps: 900, bidirectional: false, seedRadiusFrac: 0.25 },
      geom: { geomMode: 1, sides: 4, aspect: 0.18, width: 0.006, widthMode: 0, twist: 1.4, smoothIters: 0 },
      color: { colorMode: 2, colorCycles: 1, ...grad('Cyanotype') },
      look: { renderMode: 0, specular: 0.5, rim: 0.5, fogDensity: 0.1, bgTop: '#0a1219', bgBottom: '#02040a' },
      camera: { dist: 3.0, pitch: 0.12 },
    },
  },
  {
    name: 'Hopf weave',
    patch: {
      field: { fieldA: 'hopf', paramsA: { twist: 1, breathe: 0 }, domain: 2.2 },
      trace: { even: false, seedMode: 1, seedCount: 300, maxCurves: 300, seedRadiusFrac: 0.75, stepFrac: 0.008, maxSteps: 820, bidirectional: false, boundsFrac: 3 },
      geom: { geomMode: 1, sides: 5, aspect: 1, width: 0.008, widthMode: 0, twist: 0, smoothIters: 0 },
      color: { colorMode: 6, ...grad('Ultraviolet') },
      look: { renderMode: 0, ambient: 0.45, specular: 0.6, rim: 0.5, fogDensity: 0.12 },
    },
  },
  {
    name: 'Knot smoke',
    patch: {
      field: { fieldA: 'filament', paramsA: { shape: 1, count: 1, pwind: 2, qwind: 3, tuberad: 0.4, core: 0.12, swirl: 0 }, domain: 2.0 },
      trace: { even: false, seedMode: 0, seedCount: 600, maxCurves: 600, seedRadiusFrac: 0.9, stepFrac: 0.008, maxSteps: 220, minSteps: 20, bidirectional: false },
      geom: { geomMode: 2, width: 0.004, widthMode: 0, smoothIters: 1 },
      color: { colorMode: 7, colorCycles: 1, ...grad('Peacock') },
      look: { renderMode: 1, opacity: 0.22, exposure: 1.3, fogDensity: 0.25, bgTop: '#05070d', bgBottom: '#01010400' },
    },
  },
  {
    name: 'Gyroid lattice',
    patch: {
      field: { fieldA: 'tpms', paramsA: { surface: 0, k: 1, spin: 0.35, climb: 0 }, domain: 3.8 },
      trace: { even: true, dSepFrac: 0.045, maxCurves: 1100, stepFrac: 0.008, maxSteps: 520, seedMode: 2, seedRadiusFrac: 0.8 },
      geom: { geomMode: 0, width: 0.01, widthMode: 1, taperPower: 0.35, twist: 0.25 },
      color: { colorMode: 4, ...grad('Peacock') },
      look: { renderMode: 0, ambient: 0.6, rim: 0.3, fogDensity: 0.2 },
    },
  },
  {
    name: 'Kaleido bloom',
    patch: {
      field: { fieldA: 'curl', paramsA: { scale: 1.6, octaves: 2, gain: 0.5 }, symmetry: 4, domain: 1.6, swirl: 0.25 },
      trace: { even: true, dSepFrac: 0.042, maxCurves: 1400, stepFrac: 0.01, maxSteps: 420, seedMode: 0 },
      geom: { geomMode: 0, width: 0.011, widthMode: 1, taperPower: 0.5, twist: 1.1 },
      color: { colorMode: 6, colorCycles: 2, ...grad('Rosewater') },
      look: { renderMode: 0, rim: 0.45, fogDensity: 0.15 },
    },
  },
  {
    name: 'Magnetic wool',
    patch: {
      field: { fieldA: 'dipole', paramsA: { count: 3, spread: 0.8, dseed: 3, swirl: 0.15, soft: 0.1 }, domain: 2.0 },
      trace: { even: true, dSepFrac: 0.04, maxCurves: 1200, stepFrac: 0.008, maxSteps: 600, seedMode: 0, seedRadiusFrac: 0.8 },
      geom: { geomMode: 1, sides: 5, aspect: 1, width: 0.005, widthMode: 3, widthAmount: 0.7, smoothIters: 1 },
      color: { colorMode: 3, ...grad('Copper wire') },
      look: { renderMode: 0, specular: 0.55, shininess: 44, rim: 0.35, fogDensity: 0.18 },
    },
  },
  {
    name: 'Apollonian drift',
    patch: {
      field: { fieldA: 'inversive', paramsA: { radius: 1, cx: 0.45, cy: 0, cz: 0, spin: 1, rise: 0.3 }, domain: 2.2, symmetry: 1 },
      trace: { even: true, dSepFrac: 0.035, maxCurves: 1500, stepFrac: 0.007, maxSteps: 500, seedMode: 0 },
      geom: { geomMode: 0, width: 0.008, widthMode: 1, taperPower: 0.6, twist: 0.4 },
      color: { colorMode: 6, colorCycles: 3, ...grad('Ultraviolet') },
      look: { renderMode: 0, rim: 0.5, fogDensity: 0.22 },
    },
  },
  {
    name: 'Thomas web',
    patch: {
      field: { fieldA: 'thomas', paramsA: { b: 0.19 }, domain: 4.5 },
      trace: { even: false, seedMode: 2, seedCount: 1200, maxCurves: 1200, stepFrac: 0.005, maxSteps: 700, bidirectional: false, seedRadiusFrac: 0.9 },
      geom: { geomMode: 2, width: 0.003, widthMode: 0, smoothIters: 0 },
      color: { colorMode: 8, ...grad('Acid') },
      look: { renderMode: 1, opacity: 0.16, exposure: 1.25, fogDensity: 0.14 },
    },
  },
  {
    name: 'Halo shells',
    patch: {
      field: { fieldA: 'curlshell', paramsA: { scale: 1.5, octaves: 2, gain: 0.5, radial: 0.03 }, domain: 1.6 },
      trace: { even: true, dSepFrac: 0.045, maxCurves: 1100, stepFrac: 0.009, maxSteps: 460, seedMode: 0, seedRadiusFrac: 0.95 },
      geom: { geomMode: 0, width: 0.012, widthMode: 1, taperPower: 0.5, twist: 0.9 },
      color: { colorMode: 5, ...grad('Sea ice') },
      look: { renderMode: 0, ambient: 0.65, rim: 0.4, fogDensity: 0.2, bgTop: '#0b1a20', bgBottom: '#02070b' },
    },
  },
  {
    name: 'Ink plot',
    patch: {
      field: { fieldA: 'curl', paramsA: { scale: 0.9, octaves: 2, gain: 0.55 }, domain: 1.6 },
      trace: { even: true, dSepFrac: 0.06, maxCurves: 700, stepFrac: 0.012, maxSteps: 340, seedMode: 0 },
      geom: { geomMode: 2, width: 0.004, widthMode: 0, smoothIters: 2 },
      color: { colorMode: 1, ...grad('Graphite'), colorReverse: true },
      look: {
        renderMode: 2, opacity: 0.85, fogDensity: 0.05, vignette: 0.1,
        bgTop: '#f7f5ef', bgBottom: '#e9e6dc', exposure: 0.9,
      },
    },
  },
  {
    name: 'Aurora',
    patch: {
      field: { fieldA: 'harmonic', paramsA: { l: 4, m: 3, radial: 0.05, spin: 0.4 }, domain: 1.5, blend: 0.35, blendMode: 1, fieldB: 'curl', paramsB: { scale: 1.8, octaves: 2, gain: 0.5 } },
      trace: { even: true, dSepFrac: 0.04, maxCurves: 1300, stepFrac: 0.008, maxSteps: 500, seedMode: 1, seedRadiusFrac: 0.8 },
      geom: { geomMode: 0, width: 0.009, widthMode: 1, taperPower: 0.7, twist: 0.5 },
      color: { colorMode: 0, colorCycles: 2, ...grad('Risograph') },
      look: { renderMode: 1, opacity: 0.5, exposure: 1.15, fogDensity: 0.2 },
    },
  },
  {
    name: 'Boxfold weave',
    patch: {
      field: {
        fieldA: 'curl', paramsA: { scale: 0.9, octaves: 2, gain: 0.5, drift: 0.15 }, domain: 1.6,
        fractal: { mode: 1, iterations: 3, scale: 1.3, foldLimit: 1, minRadius: 0.45, fixedRadius: 1.05, offsetX: 1, offsetY: 1, offsetZ: 1, spin: 0, tumble: 11 },
      },
      trace: { even: true, dSepFrac: 0.035, maxCurves: 1200, seedCount: 1400, stepFrac: 0.012, maxSteps: 900, seedMode: 0, seedRadiusFrac: 0.85 },
      geom: { geomMode: 0, width: 0.011, widthMode: 1, taperPower: 0.5, twist: 0.4, smoothIters: 1 },
      color: { colorMode: 6, colorCycles: 1, ...grad('Copper wire') },
      look: { renderMode: 0, ambient: 0.5, rim: 0.45, specular: 0.4, fogDensity: 0.2 },
    },
  },
  {
    name: 'Sierpinski smoke',
    patch: {
      field: {
        fieldA: 'abc', paramsA: { A: 1.2, B: 0.9, C: 0.7, k: 1 }, domain: Math.PI,
        fractal: { mode: 2, iterations: 4, scale: 1.35, offsetX: 1, offsetY: 1, offsetZ: 1, spin: 6, tumble: 0 },
      },
      trace: { even: true, dSepFrac: 0.03, maxCurves: 1400, seedCount: 1800, stepFrac: 0.014, maxSteps: 520, seedMode: 2, seedRadiusFrac: 0.9 },
      geom: { geomMode: 0, width: 0.008, widthMode: 2, widthAmount: 0.7, twist: 0.3, smoothIters: 1 },
      color: { colorMode: 3, colorCycles: 1, ...grad('Ultraviolet') },
      look: { renderMode: 1, opacity: 0.55, exposure: 1.2, fogDensity: 0.22 },
    },
  },
  {
    name: 'Turbulent silk',
    patch: {
      field: {
        fieldA: 'curl', paramsA: { scale: 0.75, octaves: 2, gain: 0.5, drift: 0.05 }, domain: 1.6,
        fractal: { mode: 0, octaves: 3, lacunarity: 2.2, gain: 0.55, octaveSpin: 41 },
      },
      trace: { even: true, dSepFrac: 0.042, maxCurves: 800, seedCount: 1000, stepFrac: 0.009, maxSteps: 420, seedMode: 0 },
      geom: { geomMode: 0, width: 0.013, widthMode: 1, taperPower: 0.45, twist: 0.8, smoothIters: 1 },
      color: { colorMode: 0, colorCycles: 1, ...grad('Sea ice') },
      look: { renderMode: 0, ambient: 0.6, rim: 0.4, fogDensity: 0.16 },
    },
  },
  {
    name: 'Girder lattice',
    patch: {
      field: {
        fieldA: 'abc', paramsA: { A: 1, B: 0.7071, C: 0.5774, k: 1 }, domain: Math.PI,
        fractal: { mode: 3, iterations: 3, scale: 1.25, offsetX: 1, offsetY: 1, offsetZ: 1, spin: 0, tumble: 0 },
      },
      trace: { even: true, dSepFrac: 0.05, maxCurves: 700, seedCount: 900, stepFrac: 0.012, maxSteps: 520, seedMode: 2, seedRadiusFrac: 0.85 },
      geom: { geomMode: 3, aspect: 1, width: 0.009, widthMode: 0, twist: 0, smoothIters: 1 },
      color: { colorMode: 4, colorCycles: 1, ...grad('Graphite') },
      look: { renderMode: 0, ambient: 0.42, rim: 0.3, specular: 0.55, shininess: 48, fogDensity: 0.18 },
    },
  },
];
