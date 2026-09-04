// panel.js — builds the control panel from a schema. Every control declares the
// level of work its change costs (trace > geom > draw) so moving a light slider
// never re-integrates a million samples.

import { FIELDS, SYMMETRIES } from '../engine/fields.js';
import { FOLD_MODES } from '../engine/fractal.js';
import { EXPORT_SIZES } from '../io/exporters.js';
import { SEED_MODES } from '../engine/integrator.js';
import { GEOM_MODES, WIDTH_MODES, COLOR_MODES } from '../engine/geometry.js';

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

const fieldOptions = FIELDS.map((f) => ({ value: f.id, label: `${f.name} — ${f.group}` }));

export const SCHEMA = [
  {
    title: 'Field', open: true, controls: [
      { type: 'select', path: 'field.fieldA', label: 'Field', options: fieldOptions, level: 'trace', rebuildParams: 'A' },
      { type: 'params', slot: 'A' },
      { type: 'slider', path: 'field.domain', label: 'Domain size', min: 0.2, max: 30, step: 0.01, level: 'trace' },
      { type: 'select', path: 'field.symmetry', label: 'Symmetry fold', options: SYMMETRIES, level: 'trace' },
      { type: 'slider', path: 'field.warp', label: 'Domain warp', min: 0, max: 1, step: 0.001, level: 'trace' },
      { type: 'slider', path: 'field.warpScale', label: 'Warp scale', min: 0.1, max: 5, step: 0.01, level: 'trace' },
      { type: 'slider', path: 'field.swirl', label: 'Global swirl', min: -2, max: 2, step: 0.01, level: 'trace' },
      { type: 'slider', path: 'field.drift', label: 'Global drift Z', min: -2, max: 2, step: 0.01, level: 'trace' },
      { type: 'slider', path: 'field.time', label: 'Time', min: 0, max: 20, step: 0.01, level: 'trace' },
      { type: 'slider', path: 'field.noiseSeed', label: 'Noise seed', min: 1, max: 9999, step: 1, level: 'trace' },
    ],
  },
  {
    title: 'Fractal', open: false, controls: [
      { type: 'select', path: 'field.fractal.mode', label: 'Fold', options: FOLD_MODES, level: 'trace' },
      { type: 'slider', path: 'field.fractal.iterations', label: 'Iterations', min: 1, max: 12, step: 1, level: 'trace' },
      { type: 'slider', path: 'field.fractal.scale', label: 'Fold scale', min: -3, max: 3, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.foldLimit', label: 'Fold limit', min: 0.1, max: 3, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.minRadius', label: 'Inner radius', min: 0.05, max: 1.5, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.fixedRadius', label: 'Outer radius', min: 0.1, max: 2.5, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.offsetX', label: 'Offset X', min: -2, max: 2, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.offsetY', label: 'Offset Y', min: -2, max: 2, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.offsetZ', label: 'Offset Z', min: -2, max: 2, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.spin', label: 'Spin per iteration', min: -180, max: 180, step: 0.5, level: 'trace' },
      { type: 'slider', path: 'field.fractal.tumble', label: 'Tumble per iteration', min: -180, max: 180, step: 0.5, level: 'trace' },
      { type: 'slider', path: 'field.fractal.octaves', label: 'Field octaves', min: 1, max: 5, step: 1, level: 'trace' },
      { type: 'slider', path: 'field.fractal.lacunarity', label: 'Octave scale step', min: 1.2, max: 3.5, step: 0.01, level: 'trace' },
      { type: 'slider', path: 'field.fractal.gain', label: 'Octave falloff', min: 0.15, max: 0.9, step: 0.005, level: 'trace' },
      { type: 'slider', path: 'field.fractal.octaveSpin', label: 'Octave twist', min: 0, max: 180, step: 0.5, level: 'trace' },
    ],
  },
  {
    title: 'Second field', open: false, controls: [
      { type: 'slider', path: 'field.blend', label: 'Blend amount', min: 0, max: 1, step: 0.001, level: 'trace' },
      { type: 'select', path: 'field.blendMode', label: 'Blend mode', options: ['Mix', 'Add', 'Cross product'], level: 'trace' },
      { type: 'select', path: 'field.fieldB', label: 'Field', options: fieldOptions, level: 'trace', rebuildParams: 'B' },
      { type: 'params', slot: 'B' },
    ],
  },
  {
    title: 'Streamlines', open: true, controls: [
      { type: 'toggle', path: 'trace.even', label: 'Even spacing', level: 'trace' },
      { type: 'slider', path: 'trace.dSepFrac', label: 'Separation', min: 0.008, max: 0.25, step: 0.001, level: 'trace' },
      { type: 'slider', path: 'trace.dTestRatio', label: 'Stop distance', min: 0.1, max: 1, step: 0.01, level: 'trace' },
      { type: 'select', path: 'trace.seedMode', label: 'Seeding', options: SEED_MODES, level: 'trace' },
      { type: 'slider', path: 'trace.seedCount', label: 'Seed points', min: 20, max: 6000, step: 10, level: 'trace' },
      { type: 'slider', path: 'trace.maxCurves', label: 'Max curves', min: 20, max: 6000, step: 10, level: 'trace' },
      { type: 'slider', path: 'trace.seedRadiusFrac', label: 'Seed radius', min: 0.05, max: 1.5, step: 0.01, level: 'trace' },
      { type: 'slider', path: 'trace.stepFrac', label: 'Step size', min: 0.002, max: 0.05, step: 0.0005, level: 'trace' },
      { type: 'slider', path: 'trace.maxSteps', label: 'Max steps', min: 20, max: 3000, step: 10, level: 'trace' },
      { type: 'slider', path: 'trace.minSteps', label: 'Discard shorter than', min: 2, max: 200, step: 1, level: 'trace' },
      { type: 'toggle', path: 'trace.bidirectional', label: 'Trace both ways', level: 'trace' },
      { type: 'slider', path: 'trace.boundsFrac', label: 'Escape radius', min: 0.5, max: 8, step: 0.05, level: 'trace' },
      { type: 'select', path: 'trace.integrator', label: 'Integrator', options: ['Runge–Kutta 4', 'Euler'], level: 'trace' },
      { type: 'slider', path: 'trace.jitter', label: 'Seed jitter', min: 0, max: 1, step: 0.01, level: 'trace' },
      { type: 'slider', path: 'trace.seed', label: 'Seed', min: 1, max: 99999999, step: 1, level: 'trace' },
    ],
  },
  {
    title: 'Ribbons', open: true, controls: [
      { type: 'select', path: 'geom.geomMode', label: 'Form', options: GEOM_MODES, level: 'geom' },
      { type: 'slider', path: 'geom.width', label: 'Width', min: 0.0005, max: 0.08, step: 0.0005, level: 'geom' },
      { type: 'select', path: 'geom.widthMode', label: 'Width varies', options: WIDTH_MODES, level: 'geom' },
      { type: 'slider', path: 'geom.widthAmount', label: 'Width amount', min: 0, max: 1, step: 0.01, level: 'geom' },
      { type: 'slider', path: 'geom.taperPower', label: 'Taper sharpness', min: 0.05, max: 3, step: 0.01, level: 'geom' },
      { type: 'slider', path: 'geom.twist', label: 'Twist turns', min: -6, max: 6, step: 0.01, level: 'geom' },
      { type: 'slider', path: 'geom.twistNoise', label: 'Twist noise', min: 0, max: 2, step: 0.01, level: 'geom' },
      { type: 'slider', path: 'geom.sides', label: 'Tube sides', min: 3, max: 16, step: 1, level: 'geom' },
      { type: 'slider', path: 'geom.aspect', label: 'Tube flatness', min: 0.05, max: 1, step: 0.01, level: 'geom' },
      { type: 'slider', path: 'geom.smoothIters', label: 'Smoothing passes', min: 0, max: 6, step: 1, level: 'geom' },
      { type: 'slider', path: 'geom.smoothStrength', label: 'Smoothing strength', min: 0, max: 1, step: 0.01, level: 'geom' },
    ],
  },
  {
    title: 'Colour', open: true, controls: [
      { type: 'gradient' },
      { type: 'select', path: 'color.colorMode', label: 'Colour by', options: COLOR_MODES, level: 'geom' },
      { type: 'slider', path: 'color.colorCycles', label: 'Repeats', min: 1, max: 12, step: 1, level: 'geom' },
      { type: 'toggle', path: 'color.colorReverse', label: 'Reverse', level: 'geom' },
    ],
  },
  {
    title: 'Light and air', open: false, controls: [
      { type: 'select', path: 'look.renderMode', label: 'Shading', options: ['Shaded', 'Additive glow', 'Flat'], level: 'draw' },
      { type: 'slider', path: 'look.opacity', label: 'Opacity', min: 0.02, max: 1, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.exposure', label: 'Exposure', min: 0.3, max: 2.5, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.ambient', label: 'Ambient', min: 0, max: 1.5, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.specular', label: 'Specular', min: 0, max: 1.5, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.shininess', label: 'Shininess', min: 1, max: 120, step: 1, level: 'draw' },
      { type: 'slider', path: 'look.rim', label: 'Rim light', min: 0, max: 1.5, step: 0.01, level: 'draw' },
      { type: 'color', path: 'look.lightColor', label: 'Key light', level: 'draw' },
      { type: 'color', path: 'look.skyColor', label: 'Sky bounce', level: 'draw' },
      { type: 'color', path: 'look.groundColor', label: 'Ground bounce', level: 'draw' },
      { type: 'slider', path: 'look.lightDir.0', label: 'Light X', min: -1, max: 1, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.lightDir.1', label: 'Light Y', min: -1, max: 1, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.lightDir.2', label: 'Light Z', min: -1, max: 1, step: 0.01, level: 'draw' },
      { type: 'color', path: 'look.fogColor', label: 'Fog', level: 'draw' },
      { type: 'slider', path: 'look.fogDensity', label: 'Fog density', min: 0, max: 1.2, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.fogStart', label: 'Fog start', min: 0, max: 6, step: 0.01, level: 'draw' },
      { type: 'color', path: 'look.bgTop', label: 'Background top', level: 'draw' },
      { type: 'color', path: 'look.bgBottom', label: 'Background bottom', level: 'draw' },
      { type: 'slider', path: 'look.vignette', label: 'Vignette', min: 0, max: 1.5, step: 0.01, level: 'draw' },
      { type: 'toggle', path: 'look.cull', label: 'Cull back faces', level: 'draw' },
    ],
  },
  {
    title: 'Export', open: false, controls: [
      { type: 'select', path: 'look.exportSize', label: 'PNG size', options: EXPORT_SIZES.map((e) => e.label), level: 'none' },
      { type: 'slider', path: 'look.exportWidth', label: 'Custom width', min: 256, max: 20000, step: 16, level: 'none' },
      { type: 'slider', path: 'look.exportHeight', label: 'Custom height', min: 256, max: 20000, step: 16, level: 'none' },
      { type: 'slider', path: 'look.supersample', label: 'Supersample', min: 1, max: 4, step: 1, level: 'none' },
    ],
  },
  {
    title: 'Motion and camera', open: false, controls: [
      { type: 'slider', path: 'look.flowStrength', label: 'Flow pulse', min: 0, max: 1, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.flowFreq', label: 'Pulse repeats', min: 0.2, max: 20, step: 0.1, level: 'draw' },
      { type: 'slider', path: 'look.flowSpeed', label: 'Pulse speed', min: -3, max: 3, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'look.autoRotate', label: 'Auto-rotate', min: -1, max: 1, step: 0.01, level: 'draw' },
      { type: 'slider', path: 'camera.fov', label: 'Field of view', min: 12, max: 100, step: 1, level: 'draw' },
    ],
  },
];

export class Panel {
  constructor(root, state, opts) {
    this.root = root;
    this.state = state;
    this.opts = opts;                   // { onChange(level), gradientMount }
    this.controls = [];
    this.paramMounts = {};
    this.build();
  }

  build() {
    this.root.innerHTML = '';
    for (const section of SCHEMA) {
      const det = document.createElement('details');
      det.className = 'section';
      if (section.open) det.open = true;
      const sum = document.createElement('summary');
      sum.textContent = section.title;
      det.appendChild(sum);
      const body = document.createElement('div');
      body.className = 'section-body';
      det.appendChild(body);
      for (const c of section.controls) this.addControl(body, c);
      this.root.appendChild(det);
    }
  }

  addControl(parent, c) {
    if (c.type === 'gradient') {
      const mount = document.createElement('div');
      parent.appendChild(mount);
      this.opts.gradientMount(mount);
      return;
    }
    if (c.type === 'params') {
      const mount = document.createElement('div');
      mount.className = 'params';
      parent.appendChild(mount);
      this.paramMounts[c.slot] = mount;
      this.rebuildParams(c.slot);
      return;
    }
    const row = document.createElement('div');
    row.className = 'row control';
    const label = document.createElement('label');
    label.textContent = c.label;
    row.appendChild(label);

    let input, readout;
    if (c.type === 'slider') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.value = getPath(this.state, c.path);
      readout = document.createElement('output');
      readout.textContent = fmt(input.value, c.step);
      input.addEventListener('input', () => {
        setPath(this.state, c.path, parseFloat(input.value));
        readout.textContent = fmt(input.value, c.step);
        this.opts.onChange(c.level, c);
      });
      row.append(input, readout);
    } else if (c.type === 'select') {
      input = document.createElement('select');
      const options = c.options.map((o) => (typeof o === 'string' ? { value: undefined, label: o } : o));
      options.forEach((o, i) => {
        const el = document.createElement('option');
        el.value = o.value === undefined ? i : o.value;
        el.textContent = o.label;
        input.appendChild(el);
      });
      input.value = getPath(this.state, c.path);
      input.addEventListener('change', () => {
        const raw = input.value;
        const v = /^-?\d+(\.\d+)?$/.test(raw) ? parseFloat(raw) : raw;
        setPath(this.state, c.path, v);
        if (c.rebuildParams) this.rebuildParams(c.rebuildParams);
        this.opts.onChange(c.level, c);
      });
      row.appendChild(input);
    } else if (c.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!getPath(this.state, c.path);
      input.addEventListener('change', () => {
        setPath(this.state, c.path, input.checked);
        this.opts.onChange(c.level, c);
      });
      row.appendChild(input);
      row.classList.add('toggle');
    } else if (c.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = getPath(this.state, c.path);
      input.addEventListener('input', () => {
        setPath(this.state, c.path, input.value);
        this.opts.onChange(c.level, c);
      });
      row.appendChild(input);
    }
    this.controls.push({ def: c, input, readout });
    parent.appendChild(row);
  }

  /** Rebuild the parameter sliders for one field slot. */
  rebuildParams(slot) {
    const mount = this.paramMounts[slot];
    if (!mount) return;
    mount.innerHTML = '';
    const fieldId = this.state.field['field' + slot];
    const field = FIELDS.find((f) => f.id === fieldId) || FIELDS[0];
    const params = this.state.field['params' + slot];
    for (const p of field.params) {
      if (params[p.id] === undefined) params[p.id] = p.def;
      const row = document.createElement('div');
      row.className = 'row control';
      const label = document.createElement('label');
      label.textContent = p.label;
      row.appendChild(label);
      if (p.choice) {
        const sel = document.createElement('select');
        p.options.forEach((o, i) => {
          const el = document.createElement('option');
          el.value = i; el.textContent = o;
          sel.appendChild(el);
        });
        sel.value = params[p.id];
        sel.addEventListener('change', () => {
          params[p.id] = parseInt(sel.value, 10);
          this.opts.onChange('trace');
        });
        row.appendChild(sel);
      } else {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = p.min; input.max = p.max; input.step = p.step || 0.001;
        input.value = params[p.id];
        const out = document.createElement('output');
        out.textContent = fmt(input.value, p.step || 0.001);
        input.addEventListener('input', () => {
          params[p.id] = parseFloat(input.value);
          out.textContent = fmt(input.value, p.step || 0.001);
          this.opts.onChange('trace');
        });
        row.append(input, out);
      }
      mount.appendChild(row);
    }
  }

  /** Push state values back into every control (after preset load / randomise). */
  refresh() {
    for (const { def, input, readout } of this.controls) {
      if (!input) continue;
      const v = getPath(this.state, def.path);
      if (def.type === 'toggle') input.checked = !!v;
      else input.value = v;
      if (readout) readout.textContent = fmt(v, def.step);
    }
    this.rebuildParams('A');
    this.rebuildParams('B');
  }
}

function fmt(v, step) {
  const n = parseFloat(v);
  if (!isFinite(n)) return String(v);
  const decimals = step >= 1 ? 0 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
  return n.toFixed(decimals);
}
