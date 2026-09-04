// exporters.js — PNG / OBJ / SVG / JSON output.
//
// The SVG path walks the same prepared curves the mesh is built from, so a
// plotted line and a shaded ribbon always follow the same centreline. Paths are
// grouped into colour layers, the way the 2D plotter labelled pen layers.

import { mat4TransformPoint } from '../engine/vecmath.js';
import { rgbToHex } from '../engine/palette.js';

/**
 * Export sizes. `mul` multiplies the current viewport; `w`/`h` are absolute.
 * Print sizes are the pixel counts for 300 dpi, which is what a lab wants.
 */
export const EXPORT_SIZES = [
  { label: 'Screen', mul: 1 },
  { label: '2x screen', mul: 2 },
  { label: '4x screen', mul: 4 },
  { label: '4K  3840 x 2160', w: 3840, h: 2160 },
  { label: '6K  6144 x 3456', w: 6144, h: 3456 },
  { label: '8K  7680 x 4320', w: 7680, h: 4320 },
  { label: '12K  11520 x 6480', w: 11520, h: 6480 },
  { label: 'Square 4096', w: 4096, h: 4096 },
  { label: 'Square 8192', w: 8192, h: 8192 },
  { label: 'A3 at 300dpi  4961 x 3508', w: 4961, h: 3508 },
  { label: 'A2 at 300dpi  7016 x 4961', w: 7016, h: 4961 },
  { label: '16 x 20in at 300dpi  4800 x 6000', w: 4800, h: 6000 },
  { label: 'Custom', custom: true },
];

/** Resolve a size choice against the current viewport. */
export function resolveExportSize(state, viewW, viewH) {
  const entry = EXPORT_SIZES[state.exportSize | 0] || EXPORT_SIZES[0];
  let w, h;
  if (entry.custom) { w = state.exportWidth; h = state.exportHeight; }
  else if (entry.mul) { w = viewW * entry.mul; h = viewH * entry.mul; }
  else { w = entry.w; h = entry.h; }
  return { w: Math.max(16, Math.round(w)), h: Math.max(16, Math.round(h)), label: entry.label };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- OBJ

export function chunksToOBJ(chunks, name = 'flowfield') {
  const out = [`# ${name} — exported from Flow Fields 3D`, `o ${name}`];
  let offset = 1;
  for (const c of chunks) {
    const p = c.positions, nrm = c.normals;
    for (let i = 0; i < c.vertexCount; i++) {
      out.push(`v ${p[i * 3].toFixed(5)} ${p[i * 3 + 1].toFixed(5)} ${p[i * 3 + 2].toFixed(5)}`);
    }
    for (let i = 0; i < c.vertexCount; i++) {
      out.push(`vn ${nrm[i * 3].toFixed(4)} ${nrm[i * 3 + 1].toFixed(4)} ${nrm[i * 3 + 2].toFixed(4)}`);
    }
    const idx = c.indices;
    if (c.mode === 'lines') {
      for (let i = 0; i < idx.length; i += 2) out.push(`l ${idx[i] + offset} ${idx[i + 1] + offset}`);
    } else {
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] + offset, b = idx[i + 1] + offset, cc = idx[i + 2] + offset;
        out.push(`f ${a}//${a} ${b}//${b} ${cc}//${cc}`);
      }
    }
    offset += c.vertexCount;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- SVG

/**
 * Project prepared curves to a 2D SVG.
 * opts: { width, height, mvp, view, fovScale, background, strokeScale,
 *         perspectiveWidth, depthFade, layers, quantise }
 */
export function preparedToSVG(prepared, opts) {
  const W = opts.width, H = opts.height;
  const clip = [0, 0, 0, 0];
  const layers = new Map();
  const order = [];

  for (const it of prepared.items) {
    const n = it.n;
    // view-space depth of the curve, for painter ordering
    let zsum = 0, zcount = 0;
    const screen = new Float32Array(n * 3);   // x, y, viewZ
    let visible = false;
    for (let i = 0; i < n; i++) {
      const x = it.pos[i * 3], y = it.pos[i * 3 + 1], z = it.pos[i * 3 + 2];
      mat4TransformPoint(opts.mvp, [x, y, z], clip);
      const w = clip[3];
      if (w > 1e-6) {
        screen[i * 3] = (clip[0] / w * 0.5 + 0.5) * W;
        screen[i * 3 + 1] = (1 - (clip[1] / w * 0.5 + 0.5)) * H;
        screen[i * 3 + 2] = w;
        zsum += w; zcount++;
        visible = true;
      } else {
        screen[i * 3 + 2] = -1;
      }
    }
    if (!visible) continue;
    const meanW = zsum / Math.max(1, zcount);

    // colour: sampled at the curve midpoint, optionally quantised into pen layers
    const mid = Math.floor(n / 2) * 3;
    let rgb = [it.col[mid], it.col[mid + 1], it.col[mid + 2]];
    if (opts.quantise > 0) {
      const q = opts.quantise;
      rgb = rgb.map((v) => Math.round(v * (q - 1)) / (q - 1));
    }
    const hex = rgbToHex(rgb);

    // build path data, breaking at points behind the camera
    let d = '';
    let pen = false;
    for (let i = 0; i < n; i++) {
      const w = screen[i * 3 + 2];
      if (w <= 0) { pen = false; continue; }
      const sx = screen[i * 3].toFixed(2), sy = screen[i * 3 + 1].toFixed(2);
      d += (pen ? 'L' : 'M') + sx + ' ' + sy + ' ';
      pen = true;
    }
    if (!d) continue;

    const wWorld = it.wid[Math.floor(n / 2)] * 2;
    let strokePx = wWorld * opts.strokeScale;
    if (opts.perspectiveWidth) strokePx = (wWorld * opts.fovScale * H * 0.5) / Math.max(0.05, meanW);
    strokePx = Math.max(0.15, Math.min(40, strokePx * opts.strokeMul));

    const fade = opts.depthFade > 0
      ? Math.max(0.05, 1 - opts.depthFade * Math.min(1, Math.max(0, (meanW - opts.nearW) / Math.max(1e-6, opts.farW - opts.nearW))))
      : 1;

    if (!layers.has(hex)) { layers.set(hex, []); order.push(hex); }
    layers.get(hex).push({ d, strokePx, fade, meanW });
  }

  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  ];
  if (opts.background) parts.push(`<rect width="${W}" height="${H}" fill="${opts.background}"/>`);

  for (const hex of order) {
    const paths = layers.get(hex);
    paths.sort((a, b) => b.meanW - a.meanW);            // far to near
    parts.push(`<g id="pen-${hex.replace('#', '')}" inkscape:label="pen ${hex}" stroke="${hex}" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
    for (const p of paths) {
      const op = p.fade < 0.999 ? ` stroke-opacity="${p.fade.toFixed(3)}"` : '';
      parts.push(`<path d="${p.d.trim()}" stroke-width="${p.strokePx.toFixed(2)}"${op}/>`);
    }
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- JSON

export function stateToJSON(state) {
  return JSON.stringify(state, null, 2);
}

export function parseStateJSON(text) {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object') throw new Error('That file does not contain a settings object.');
  return obj;
}
