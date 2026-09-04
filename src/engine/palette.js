// palette.js — editable multi-stop gradients, carried over from the 2D plotter.

export function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return '#' + c(rgb[0]) + c(rgb[1]) + c(rgb[2]);
}

export const GRADIENT_PRESETS = {
  'Ember': ['#12030c', '#5a1240', '#c4374a', '#f08c3a', '#ffe9b0'],
  'Cyanotype': ['#04121f', '#0b3d62', '#1c86a8', '#7fd4d0', '#f2fbf6'],
  'Peacock': ['#07131c', '#0e5d6b', '#28a37a', '#a8d84a', '#f6f3c8'],
  'Ultraviolet': ['#0a0416', '#3b1078', '#7b2bd6', '#d367f0', '#ffd6f5'],
  'Copper wire': ['#140b06', '#4a2412', '#a55427', '#e59b52', '#fbe2bb'],
  'Sea ice': ['#02131a', '#124a5e', '#3f9aa8', '#9fd6c5', '#fdfdfa'],
  'Risograph': ['#1b1b3a', '#e5446d', '#ffb400', '#00a6a6', '#fdf6e3'],
  'Graphite': ['#0c0c0e', '#3a3a40', '#71717a', '#b8b8bf', '#f2f2f4'],
  'Acid': ['#04150a', '#1f6b2b', '#7ac70c', '#e8ff59', '#ffffff'],
  'Rosewater': ['#180a12', '#5c2340', '#b25a75', '#e9a8a0', '#fdf0e2'],
};

export class Gradient {
  constructor(stops) {
    this.stops = stops && stops.length >= 2
      ? stops.map((s) => ({ t: s.t, color: Array.isArray(s.color) ? s.color.slice() : hexToRgb(s.color) }))
      : Gradient.fromPreset('Ember').stops;
    this.sort();
  }

  static fromPreset(name) {
    const cols = GRADIENT_PRESETS[name] || GRADIENT_PRESETS.Ember;
    return new Gradient(cols.map((c, i) => ({ t: i / (cols.length - 1), color: hexToRgb(c) })));
  }

  sort() { this.stops.sort((a, b) => a.t - b.t); }

  clone() { return new Gradient(this.stops); }

  addStop(t, color) {
    this.stops.push({ t: Math.max(0, Math.min(1, t)), color: color.slice() });
    this.sort();
  }

  removeStop(i) { if (this.stops.length > 2) this.stops.splice(i, 1); }

  /** Linear interpolation in sRGB space; matches what the 2D tool did. */
  sample(t, out = [0, 0, 0]) {
    const s = this.stops;
    const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
    if (u <= s[0].t) { out[0] = s[0].color[0]; out[1] = s[0].color[1]; out[2] = s[0].color[2]; return out; }
    const last = s[s.length - 1];
    if (u >= last.t) { out[0] = last.color[0]; out[1] = last.color[1]; out[2] = last.color[2]; return out; }
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      if (u >= a.t && u <= b.t) {
        const f = b.t - a.t < 1e-9 ? 0 : (u - a.t) / (b.t - a.t);
        out[0] = a.color[0] + (b.color[0] - a.color[0]) * f;
        out[1] = a.color[1] + (b.color[1] - a.color[1]) * f;
        out[2] = a.color[2] + (b.color[2] - a.color[2]) * f;
        return out;
      }
    }
    out[0] = last.color[0]; out[1] = last.color[1]; out[2] = last.color[2];
    return out;
  }

  toJSON() { return this.stops.map((s) => ({ t: s.t, color: rgbToHex(s.color) })); }

  cssString() {
    return this.stops.map((s) => `${rgbToHex(s.color)} ${(s.t * 100).toFixed(1)}%`).join(', ');
  }
}
