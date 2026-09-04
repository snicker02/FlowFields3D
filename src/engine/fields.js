// fields.js — the 3D vector field library.
//
// Contract: every field writes a velocity into `out` and returns it.
//   fn(x, y, z, P, ctx, out)
//     P   — parameter values keyed by param id
//     ctx — { noise, time, data }  (data is whatever prepare() returned)
// Fields work in their own natural coordinates; `domain` is the radius of the
// region worth seeding, and the tracer scales all lengths by it, so no field
// needs to know about world units. The point cloud is auto-fitted at the
// geometry stage, so Lorenz (span ~60) and a unit gyroid frame identically.

import { curlNoise, mulberry32 } from './noise.js';
import { cross, dot, normalize } from './vecmath.js';

const P_ = (id, label, def, min, max, step = 0.001) => ({ id, label, def, min, max, step });
const CHOICE = (id, label, def, options) => ({ id, label, def, options, choice: true });

const TAU = Math.PI * 2;
const tmpA = [0, 0, 0], tmpB = [0, 0, 0], tmpC = [0, 0, 0];

// ---------------------------------------------------------------- helpers

/** Regularised Biot–Savart of a finite straight segment A→B. */
function segmentInduction(px, py, pz, ax, ay, az, bx, by, bz, core, gamma, out) {
  const a0 = px - ax, a1 = py - ay, a2 = pz - az;
  const b0 = px - bx, b1 = py - by, b2 = pz - bz;
  const la = Math.hypot(a0, a1, a2), lb = Math.hypot(b0, b1, b2);
  const cx = a1 * b2 - a2 * b1, cy = a2 * b0 - a0 * b2, cz = a0 * b1 - a1 * b0;
  const ab = a0 * b0 + a1 * b1 + a2 * b2;
  const denom = la * lb * (la * lb + ab) + core * core * (la * lb + 1e-9);
  if (denom < 1e-12) return out;
  const k = gamma * (la + lb) / (4 * Math.PI * denom);
  out[0] += cx * k; out[1] += cy * k; out[2] += cz * k;
  return out;
}

/** Build the polyline vertices of a filament shape. */
function buildFilaments(P) {
  const shape = P.shape | 0, count = Math.max(1, P.count | 0);
  const rnd = mulberry32((P.fseed | 0) || 1);
  const R = 1, r = P.tuberad;
  const lines = [];
  const SEG = 96;

  for (let c = 0; c < count; c++) {
    const pts = [];
    const phase = count > 1 ? (c / count) * TAU : 0;
    if (shape === 0) {                                   // stacked rings
      const z = count > 1 ? (c / (count - 1) - 0.5) * 1.6 : 0;
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * TAU;
        pts.push(R * Math.cos(a), R * Math.sin(a), z);
      }
    } else if (shape === 1) {                            // torus knot
      const pq = Math.max(1, Math.round(P.pwind)), qq = Math.max(1, Math.round(P.qwind));
      const N = SEG;
      for (let i = 0; i <= N; i++) {
        const s = (i / N) * TAU;
        const rr = R + r * Math.cos(qq * s + phase);
        pts.push(rr * Math.cos(pq * s), rr * Math.sin(pq * s), r * Math.sin(qq * s + phase));
      }
    } else if (shape === 2) {                            // helix pair
      const N = SEG, turns = 3;
      for (let i = 0; i <= N; i++) {
        const s = i / N;
        const a = s * TAU * turns + phase;
        pts.push(R * Math.cos(a), R * Math.sin(a), (s - 0.5) * 3);
      }
    } else if (shape === 3) {                            // linked rings
      const a0 = phase;
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * TAU;
        const x = R * Math.cos(a), y = R * Math.sin(a) * 0.9, z = 0;
        // tilt each ring about x by a0 and offset so they interlock
        const cz = Math.cos(a0), sz = Math.sin(a0);
        pts.push(x + 0.55 * Math.cos(a0), y * cz - z * sz, y * sz + z * cz);
      }
    } else {                                             // random tangle
      const K = 7;
      const ctrl = [];
      for (let i = 0; i < K; i++) {
        ctrl.push([(rnd() * 2 - 1) * 1.3, (rnd() * 2 - 1) * 1.3, (rnd() * 2 - 1) * 1.3]);
      }
      const N = SEG;
      for (let i = 0; i <= N; i++) {                      // closed Catmull-Rom
        const u = (i / N) * K;
        const i0 = Math.floor(u) % K, t = u - Math.floor(u);
        const p0 = ctrl[(i0 - 1 + K) % K], p1 = ctrl[i0], p2 = ctrl[(i0 + 1) % K], p3 = ctrl[(i0 + 2) % K];
        const t2 = t * t, t3 = t2 * t;
        for (let d = 0; d < 3; d++) {
          pts.push(0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t +
            (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 +
            (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3));
        }
      }
    }
    lines.push(new Float64Array(pts));
  }
  return lines;
}

/** Random straight-line vortices / dipoles / charges. */
function randomSites(n, seed, spread) {
  const rnd = mulberry32(seed || 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, a = rnd() * TAU, s = Math.sqrt(1 - u * u);
    out.push({
      c: [(rnd() * 2 - 1) * spread, (rnd() * 2 - 1) * spread, (rnd() * 2 - 1) * spread],
      u: [s * Math.cos(a), s * Math.sin(a), u],
      q: rnd() < 0.5 ? -1 : 1,
      w: 0.5 + rnd(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the library

export const FIELDS = [
  {
    id: 'curl', name: 'Curl noise', group: 'Noise', domain: 1.6,
    params: [P_('scale', 'Noise scale', 1.1, 0.1, 6), P_('octaves', 'Octaves', 3, 1, 5, 1),
    P_('gain', 'Octave gain', 0.5, 0.1, 0.9), P_('drift', 'Drift Z', 0, -1, 1),
    P_('anim', 'Time drift', 0.25, 0, 2)],
    fn(x, y, z, P, ctx, out) {
      const t = ctx.time * P.anim;
      curlNoise(ctx.noise, x + t * 0.7, y - t * 0.4, z + t * 0.9, P.scale, P.octaves | 0, P.gain, out);
      out[2] += P.drift;
      return out;
    },
  },
  {
    id: 'curlshell', name: 'Curl noise on shells', group: 'Noise', domain: 1.6,
    params: [P_('scale', 'Noise scale', 1.4, 0.1, 6), P_('octaves', 'Octaves', 2, 1, 5, 1),
    P_('gain', 'Octave gain', 0.5, 0.1, 0.9), P_('radial', 'Radial leak', 0.05, -0.6, 0.6)],
    fn(x, y, z, P, ctx, out) {
      curlNoise(ctx.noise, x, y, z, P.scale, P.octaves | 0, P.gain, out);
      const r = Math.hypot(x, y, z) || 1e-9;
      const nx = x / r, ny = y / r, nz = z / r;
      const d = out[0] * nx + out[1] * ny + out[2] * nz;
      out[0] += nx * (P.radial - d); out[1] += ny * (P.radial - d); out[2] += nz * (P.radial - d);
      return out;
    },
  },
  {
    id: 'abc', name: 'ABC flow', group: 'Analytic', domain: Math.PI,
    params: [P_('A', 'A', 1.0, 0, 3), P_('B', 'B', 0.7071, 0, 3), P_('C', 'C', 0.5774, 0, 3),
    P_('k', 'Frequency', 1, 0.25, 4)],
    fn(x, y, z, P, ctx, out) {
      const k = P.k;
      out[0] = P.A * Math.sin(k * z) + P.C * Math.cos(k * y);
      out[1] = P.B * Math.sin(k * x) + P.A * Math.cos(k * z);
      out[2] = P.C * Math.sin(k * y) + P.B * Math.cos(k * x);
      return out;
    },
  },
  {
    id: 'taylorgreen', name: 'Taylor–Green vortex', group: 'Analytic', domain: Math.PI,
    params: [P_('k', 'Frequency', 1, 0.25, 4), P_('shear', 'Vertical shear', 0.6, -2, 2),
    P_('skew', 'Skew', 0.0, -1, 1)],
    fn(x, y, z, P, ctx, out) {
      const k = P.k, cz = Math.cos(k * z);
      out[0] = Math.sin(k * x) * Math.cos(k * y) * cz;
      out[1] = -Math.cos(k * x) * Math.sin(k * y) * cz;
      out[2] = P.shear * Math.cos(k * x) * Math.cos(k * y) * Math.sin(k * z) + P.skew * Math.sin(k * y);
      return out;
    },
  },
  {
    id: 'lorenz', name: 'Lorenz', group: 'Attractor', domain: 24,
    params: [P_('sigma', 'Sigma', 10, 1, 20), P_('rho', 'Rho', 28, 1, 60), P_('beta', 'Beta', 2.6667, 0.5, 6)],
    fn(x, y, z, P, ctx, out) {
      out[0] = P.sigma * (y - x);
      out[1] = x * (P.rho - z) - y;
      out[2] = x * y - P.beta * z;
      return out;
    },
  },
  {
    id: 'rossler', name: 'Rössler', group: 'Attractor', domain: 14,
    params: [P_('a', 'a', 0.2, 0.05, 0.55), P_('b', 'b', 0.2, 0.05, 2), P_('c', 'c', 5.7, 1, 18)],
    fn(x, y, z, P, ctx, out) {
      out[0] = -y - z; out[1] = x + P.a * y; out[2] = P.b + z * (x - P.c);
      return out;
    },
  },
  {
    id: 'thomas', name: 'Thomas (cyclic)', group: 'Attractor', domain: 4.5,
    params: [P_('b', 'Damping', 0.19, 0.02, 0.35)],
    fn(x, y, z, P, ctx, out) {
      out[0] = Math.sin(y) - P.b * x;
      out[1] = Math.sin(z) - P.b * y;
      out[2] = Math.sin(x) - P.b * z;
      return out;
    },
  },
  {
    id: 'aizawa', name: 'Aizawa', group: 'Attractor', domain: 1.6,
    params: [P_('a', 'a', 0.95, 0.2, 1.6), P_('b', 'b', 0.7, 0.1, 1.5), P_('c', 'c', 0.6, 0.1, 1.2),
    P_('d', 'd', 3.5, 1, 6), P_('e', 'e', 0.25, 0.05, 0.6), P_('f', 'f', 0.1, 0, 0.4)],
    fn(x, y, z, P, ctx, out) {
      out[0] = (z - P.b) * x - P.d * y;
      out[1] = P.d * x + (z - P.b) * y;
      out[2] = P.c + P.a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + P.e * z) + P.f * z * x * x * x;
      return out;
    },
  },
  {
    id: 'halvorsen', name: 'Halvorsen', group: 'Attractor', domain: 9,
    params: [P_('a', 'a', 1.4, 0.6, 2.2)],
    fn(x, y, z, P, ctx, out) {
      out[0] = -P.a * x - 4 * y - 4 * z - y * y;
      out[1] = -P.a * y - 4 * z - 4 * x - z * z;
      out[2] = -P.a * z - 4 * x - 4 * y - x * x;
      return out;
    },
  },
  {
    id: 'dadras', name: 'Dadras', group: 'Attractor', domain: 12,
    params: [P_('a', 'a', 3, 1, 5), P_('b', 'b', 2.7, 1, 4), P_('c', 'c', 1.7, 0.5, 3),
    P_('d', 'd', 2, 1, 3), P_('e', 'e', 9, 4, 12)],
    fn(x, y, z, P, ctx, out) {
      out[0] = y - P.a * x + P.b * y * z;
      out[1] = P.c * y - x * z + z;
      out[2] = P.d * x * y - P.e * z;
      return out;
    },
  },
  {
    id: 'chenlee', name: 'Chen–Lee', group: 'Attractor', domain: 26,
    params: [P_('a', 'a', 5, 2, 8), P_('b', 'b', -10, -14, -6), P_('c', 'c', -0.38, -1, 0)],
    fn(x, y, z, P, ctx, out) {
      out[0] = P.a * x - y * z;
      out[1] = P.b * y + x * z;
      out[2] = P.c * z + x * y / 3;
      return out;
    },
  },
  {
    id: 'sprott', name: 'Sprott linz-F', group: 'Attractor', domain: 5,
    params: [P_('a', 'a', 0.5, 0.1, 1.2), P_('b', 'b', 1.0, 0.3, 2)],
    fn(x, y, z, P, ctx, out) {
      out[0] = y + z; out[1] = -x + P.a * y; out[2] = x * x - P.b * z;
      return out;
    },
  },
  {
    id: 'fourwing', name: 'Four-wing', group: 'Attractor', domain: 3.2,
    params: [P_('a', 'a', 0.2, 0.05, 0.5), P_('b', 'b', 0.01, 0, 0.1), P_('c', 'c', -0.4, -1, -0.1)],
    fn(x, y, z, P, ctx, out) {
      out[0] = P.a * x + y * z;
      out[1] = P.b * x + P.c * y - x * z;
      out[2] = -z - x * y;
      return out;
    },
  },
  {
    id: 'hopf', name: 'Hopf fibration', group: 'Topology', domain: 2.2,
    params: [P_('twist', 'Fibre twist', 1, -2, 2), P_('breathe', 'Radial breathe', 0, -0.5, 0.5)],
    fn(x, y, z, P, ctx, out) {
      // Lift p to S^3 by inverse stereographic projection, step along the Hopf
      // vector field q*i, project back. Fibres are Villarceau circles.
      const n = x * x + y * y + z * z, k = 1 / (n + 1);
      const a = 2 * x * k, b = 2 * y * k, c = 2 * z * k, d = (n - 1) * k;
      const va = -b, vb = a, vc = d * P.twist, vd = -c * P.twist;
      const e = 1e-4;
      let qa = a + e * va, qb = b + e * vb, qc = c + e * vc, qd = d + e * vd;
      const ln = 1 / Math.hypot(qa, qb, qc, qd);
      qa *= ln; qb *= ln; qc *= ln; qd *= ln;
      const w = 1 / (1 - qd || 1e-9);
      out[0] = (qa * w - x) / e;
      out[1] = (qb * w - y) / e;
      out[2] = (qc * w - z) / e;
      if (P.breathe !== 0) {
        const r = Math.hypot(x, y, z) || 1e-9;
        out[0] += P.breathe * x / r; out[1] += P.breathe * y / r; out[2] += P.breathe * z / r;
      }
      return out;
    },
  },
  {
    id: 'filament', name: 'Vortex filaments', group: 'Topology', domain: 2.0,
    params: [
      CHOICE('shape', 'Filament shape', 0, ['Stacked rings', 'Torus knot', 'Helices', 'Linked rings', 'Random tangle']),
      P_('count', 'Filaments', 2, 1, 6, 1), P_('pwind', 'Knot p', 2, 1, 7, 1), P_('qwind', 'Knot q', 3, 1, 7, 1),
      P_('tuberad', 'Tube radius', 0.4, 0.05, 0.9), P_('core', 'Core size', 0.14, 0.02, 0.6),
      P_('swirl', 'Axial drift', 0.0, -1.5, 1.5), P_('fseed', 'Shape seed', 7, 1, 999, 1)],
    prepare(P) { return { lines: buildFilaments(P) }; },
    fn(x, y, z, P, ctx, out) {
      out[0] = 0; out[1] = 0; out[2] = 0;
      const lines = ctx.data.lines, core = P.core;
      for (let l = 0; l < lines.length; l++) {
        const pts = lines[l];
        for (let i = 0; i + 5 < pts.length; i += 3) {
          segmentInduction(x, y, z, pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5], core, 1, out);
        }
      }
      out[2] += P.swirl;
      return out;
    },
  },
  {
    id: 'dipole', name: 'Magnetic dipoles', group: 'Physical', domain: 2.0,
    params: [P_('count', 'Dipoles', 2, 1, 8, 1), P_('spread', 'Spread', 0.8, 0.1, 2),
    P_('dseed', 'Arrangement seed', 3, 1, 999, 1), P_('swirl', 'Swirl', 0.25, -2, 2),
    P_('soft', 'Softening', 0.12, 0.02, 0.6)],
    prepare(P) { return { sites: randomSites(P.count | 0, P.dseed | 0, P.spread) }; },
    fn(x, y, z, P, ctx, out) {
      out[0] = 0; out[1] = 0; out[2] = 0;
      const s = ctx.data.sites, soft = P.soft * P.soft;
      for (let i = 0; i < s.length; i++) {
        const m = s[i].u, c = s[i].c;
        const rx = x - c[0], ry = y - c[1], rz = z - c[2];
        const r2 = rx * rx + ry * ry + rz * rz + soft;
        const r = Math.sqrt(r2), inv5 = 1 / (r2 * r2 * r);
        const mr = m[0] * rx + m[1] * ry + m[2] * rz;
        const q = s[i].q * s[i].w;
        out[0] += q * (3 * mr * rx - m[0] * r2) * inv5;
        out[1] += q * (3 * mr * ry - m[1] * r2) * inv5;
        out[2] += q * (3 * mr * rz - m[2] * r2) * inv5;
      }
      if (P.swirl !== 0) {
        const l = Math.hypot(out[0], out[1], out[2]) || 1e-9;
        out[0] += P.swirl * (-y) * l * 0.5; out[1] += P.swirl * (x) * l * 0.5;
      }
      return out;
    },
  },
  {
    id: 'gravity', name: 'Orbital wells', group: 'Physical', domain: 2.0,
    params: [P_('count', 'Wells', 3, 1, 10, 1), P_('spread', 'Spread', 0.9, 0.1, 2),
    P_('gseed', 'Arrangement seed', 11, 1, 999, 1), P_('orbit', 'Orbital swirl', 1.1, -3, 3),
    P_('infall', 'Infall', 0.35, -1.5, 1.5), P_('soft', 'Softening', 0.18, 0.03, 0.8)],
    prepare(P) { return { sites: randomSites(P.count | 0, P.gseed | 0, P.spread) }; },
    fn(x, y, z, P, ctx, out) {
      out[0] = 0; out[1] = 0; out[2] = 0;
      const s = ctx.data.sites, soft = P.soft * P.soft;
      for (let i = 0; i < s.length; i++) {
        const c = s[i].c, ax = s[i].u;
        const rx = x - c[0], ry = y - c[1], rz = z - c[2];
        const r2 = rx * rx + ry * ry + rz * rz + soft;
        const inv3 = s[i].w / (r2 * Math.sqrt(r2));
        out[0] -= P.infall * rx * inv3; out[1] -= P.infall * ry * inv3; out[2] -= P.infall * rz * inv3;
        // tangential component: axis x r
        out[0] += P.orbit * (ax[1] * rz - ax[2] * ry) * inv3;
        out[1] += P.orbit * (ax[2] * rx - ax[0] * rz) * inv3;
        out[2] += P.orbit * (ax[0] * ry - ax[1] * rx) * inv3;
      }
      return out;
    },
  },
  {
    id: 'tpms', name: 'Minimal-surface flow', group: 'Lattice', domain: Math.PI * 1.2,
    params: [CHOICE('surface', 'Surface', 0, ['Gyroid', 'Schwarz P', 'Diamond', 'Neovius']),
    P_('k', 'Cell frequency', 1, 0.25, 3), P_('spin', 'Guide spin', 0.35, -1.5, 1.5),
    P_('climb', 'Surface climb', 0.0, -0.6, 0.6)],
    fn(x, y, z, P, ctx, out) {
      const k = P.k, X = x * k, Y = y * k, Z = z * k;
      const sx = Math.sin(X), sy = Math.sin(Y), sz = Math.sin(Z);
      const cx = Math.cos(X), cy = Math.cos(Y), cz = Math.cos(Z);
      let gx, gy, gz, F;
      const s = P.surface | 0;
      if (s === 0) {                                    // gyroid
        F = sx * cy + sy * cz + sz * cx;
        gx = cx * cy - sz * sx; gy = -sx * sy + cy * cz; gz = -sy * sz + cz * cx;
      } else if (s === 1) {                             // Schwarz P
        F = cx + cy + cz; gx = -sx; gy = -sy; gz = -sz;
      } else if (s === 2) {                             // Diamond
        F = sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz;
        gx = cx * sy * sz + cx * cy * cz - sx * sy * cz - sx * cy * sz;
        gy = sx * cy * sz - sx * sy * cz + cx * cy * cz - cx * sy * sz;
        gz = sx * sy * cz - sx * cy * sz - cx * sy * sz + cx * cy * cz;
      } else {                                          // Neovius
        F = 3 * (cx + cy + cz) + 4 * cx * cy * cz;
        gx = -3 * sx - 4 * sx * cy * cz;
        gy = -3 * sy - 4 * cx * sy * cz;
        gz = -3 * sz - 4 * cx * cy * sz;
      }
      // Flow tangent to the level set: grad F x guide keeps a streamline on its surface.
      const ax = Math.sin(P.spin * 2.3), ay = Math.cos(P.spin * 1.7), az = Math.sin(P.spin * 3.1 + 1.0);
      out[0] = gy * az - gz * ay;
      out[1] = gz * ax - gx * az;
      out[2] = gx * ay - gy * ax;
      const gl = gx * gx + gy * gy + gz * gz + 1e-9;
      const climb = P.climb - 0.35 * F;                 // pull back onto F = 0
      out[0] += gx * climb / gl; out[1] += gy * climb / gl; out[2] += gz * climb / gl;
      return out;
    },
  },
  {
    id: 'shear', name: 'Helical shear', group: 'Analytic', domain: 1.8,
    params: [P_('omega', 'Rotation', 1, -3, 3), P_('shear', 'Shear', 0.8, -3, 3),
    P_('rise', 'Rise', 0.4, -2, 2), P_('pinch', 'Pinch', 0.5, -2, 2)],
    fn(x, y, z, P, ctx, out) {
      const r2 = x * x + y * y;
      const w = P.omega * (1 + P.pinch * z);
      out[0] = -w * y + P.shear * z;
      out[1] = w * x;
      out[2] = P.rise * (1 - r2 * 0.5);
      return out;
    },
  },
  {
    id: 'doublegyre', name: 'Double gyre', group: 'Analytic', domain: 1.6,
    params: [P_('amp', 'Amplitude', 1, 0.2, 2), P_('eps', 'Wobble', 0.25, 0, 0.6),
    P_('freq', 'Wobble rate', 1, 0, 3), P_('climb', 'Climb', 0.35, -1.5, 1.5)],
    fn(x, y, z, P, ctx, out) {
      const t = ctx.time * P.freq;
      const a = P.eps * Math.sin(t), b = 1 - 2 * P.eps * Math.sin(t);
      const f = a * x * x + b * x;
      const dfdx = 2 * a * x + b;
      out[0] = -Math.PI * P.amp * Math.sin(Math.PI * f) * Math.cos(Math.PI * y);
      out[1] = Math.PI * P.amp * Math.cos(Math.PI * f) * Math.sin(Math.PI * y) * dfdx;
      out[2] = P.climb * Math.cos(Math.PI * y) * Math.cos(Math.PI * f);
      return out;
    },
  },
  {
    id: 'harmonic', name: 'Spherical harmonic swirl', group: 'Topology', domain: 1.5,
    params: [P_('l', 'Lobes (l)', 3, 1, 8, 1), P_('m', 'Sectors (m)', 2, 0, 8, 1),
    P_('radial', 'Radial pull', 0.1, -0.8, 0.8), P_('spin', 'Spin', 0.5, -2, 2)],
    fn(x, y, z, P, ctx, out) {
      const r = Math.hypot(x, y, z) || 1e-9;
      const th = Math.acos(Math.max(-1, Math.min(1, z / r)));
      const ph = Math.atan2(y, x);
      // Real harmonic-ish scalar; its surface gradient crossed with r-hat swirls the shell.
      const Y = Math.sin(P.l * th) * Math.cos(P.m * ph);
      const dth = P.l * Math.cos(P.l * th) * Math.cos(P.m * ph);
      const dph = -P.m * Math.sin(P.l * th) * Math.sin(P.m * ph);
      const st = Math.sin(th) || 1e-6;
      // spherical basis
      const er = [x / r, y / r, z / r];
      const et = [Math.cos(th) * Math.cos(ph), Math.cos(th) * Math.sin(ph), -Math.sin(th)];
      const ep = [-Math.sin(ph), Math.cos(ph), 0];
      const gt = dth / r, gp = dph / (r * st);
      // v = grad_s Y x r-hat  + spin * e_phi + radial * Y * r-hat
      const gx = et[0] * gt + ep[0] * gp, gy = et[1] * gt + ep[1] * gp, gz = et[2] * gt + ep[2] * gp;
      out[0] = gy * er[2] - gz * er[1] + P.spin * ep[0] + P.radial * Y * er[0];
      out[1] = gz * er[0] - gx * er[2] + P.spin * ep[1] + P.radial * Y * er[1];
      out[2] = gx * er[1] - gy * er[0] + P.spin * ep[2] + P.radial * Y * er[2];
      return out;
    },
  },
  {
    id: 'inversive', name: 'Inversive swirl', group: 'Topology', domain: 2.2,
    params: [P_('radius', 'Inversion radius', 1, 0.3, 2), P_('cx', 'Centre X', 0.45, -1.5, 1.5),
    P_('cy', 'Centre Y', 0, -1.5, 1.5), P_('cz', 'Centre Z', 0, -1.5, 1.5),
    P_('spin', 'Base spin', 1, -2, 2), P_('rise', 'Base rise', 0.3, -1.5, 1.5)],
    fn(x, y, z, P, ctx, out) {
      // Pull back a simple rotation through a sphere inversion. The inversion's
      // Jacobian is conformal — a scaled reflection — so the pulled-back flow is
      // an exact image of the rotation, giving Apollonian-flavoured streamlines.
      const dx = x - P.cx, dy = y - P.cy, dz = z - P.cz;
      const d2 = dx * dx + dy * dy + dz * dz + 1e-9;
      const k = (P.radius * P.radius) / d2;
      const ix = P.cx + dx * k, iy = P.cy + dy * k, iz = P.cz + dz * k;
      const vx = -P.spin * iy, vy = P.spin * ix, vz = P.rise;
      // reflect v about the plane normal to the inversion ray, then scale by k
      const nl = Math.sqrt(d2), nx = dx / nl, ny = dy / nl, nz = dz / nl;
      const vn = vx * nx + vy * ny + vz * nz;
      out[0] = k * (vx - 2 * vn * nx);
      out[1] = k * (vy - 2 * vn * ny);
      out[2] = k * (vz - 2 * vn * nz);
      return out;
    },
  },
];

export const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.id, f]));

export function defaultParams(field) {
  const P = {};
  for (const p of field.params) P[p.id] = p.def;
  return P;
}

// ---------------------------------------------------------------- symmetry

export const SYMMETRIES = [
  'None', 'Mirror X', 'Mirror XY', 'Octant', 'Octahedral', 'Tetrahedral',
  'Rotate 3-fold Y', 'Rotate 5-fold Y', 'Rotate 6-fold Y', 'Sphere inversion',
];

/**
 * Fold a sample point into a fundamental domain, accumulating the orthogonal
 * part of the fold in `M` (3x3 row-major). Streamlines stay tangent to the
 * folded field only if the velocity is mapped back by M^T, which is what
 * evalField does — otherwise the symmetry looks right but the curves shear.
 */
export function foldPoint(mode, p, M, arg) {
  M[0] = 1; M[1] = 0; M[2] = 0; M[3] = 0; M[4] = 1; M[5] = 0; M[6] = 0; M[7] = 0; M[8] = 1;
  if (mode === 0) return p;

  const reflect = (nx, ny, nz) => {
    const d = p[0] * nx + p[1] * ny + p[2] * nz;
    if (d >= 0) return;
    p[0] -= 2 * d * nx; p[1] -= 2 * d * ny; p[2] -= 2 * d * nz;
    // M <- R * M with R = I - 2 n n^T
    for (let c = 0; c < 3; c++) {
      const mc0 = M[c], mc1 = M[3 + c], mc2 = M[6 + c];
      const dd = nx * mc0 + ny * mc1 + nz * mc2;
      M[c] = mc0 - 2 * dd * nx; M[3 + c] = mc1 - 2 * dd * ny; M[6 + c] = mc2 - 2 * dd * nz;
    }
  };
  const rotFold = (n) => {                       // n-fold rotation about Y
    const a = Math.atan2(p[2], p[0]);
    const r = Math.hypot(p[0], p[2]);
    const seg = TAU / n;
    let a2 = a - Math.floor(a / seg + 0.5) * seg;
    const da = a2 - a;
    p[0] = r * Math.cos(a2); p[2] = r * Math.sin(a2);
    const c = Math.cos(da), s = Math.sin(da);    // rotation about +Y by da
    for (let col = 0; col < 3; col++) {
      const m0 = M[col], m2 = M[6 + col];
      M[col] = c * m0 + s * m2;
      M[6 + col] = -s * m0 + c * m2;
    }
  };

  switch (mode) {
    case 1: reflect(1, 0, 0); break;
    case 2: reflect(1, 0, 0); reflect(0, 1, 0); break;
    case 3: reflect(1, 0, 0); reflect(0, 1, 0); reflect(0, 0, 1); break;
    case 4: {                                    // octahedral
      reflect(1, 0, 0); reflect(0, 1, 0); reflect(0, 0, 1);
      const s = Math.SQRT1_2;
      reflect(-s, s, 0); reflect(0, -s, s); reflect(-s, 0, s);
      break;
    }
    case 5: {                                    // tetrahedral (Sierpinski fold)
      const s = Math.SQRT1_2;
      reflect(-s, s, 0); reflect(-s, 0, s); reflect(0, -s, s);
      break;
    }
    case 6: rotFold(3); break;
    case 7: rotFold(5); break;
    case 8: rotFold(6); break;
    case 9: {                                    // sphere inversion (conformal)
      const R = arg || 1;
      const d2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
      if (d2 < R * R && d2 > 1e-12) {
        const k = (R * R) / d2, nl = Math.sqrt(d2);
        const nx = p[0] / nl, ny = p[1] / nl, nz = p[2] / nl;
        p[0] *= k; p[1] *= k; p[2] *= k;
        for (let c = 0; c < 3; c++) {
          const mc0 = M[c], mc1 = M[3 + c], mc2 = M[6 + c];
          const dd = nx * mc0 + ny * mc1 + nz * mc2;
          M[c] = mc0 - 2 * dd * nx; M[3 + c] = mc1 - 2 * dd * ny; M[6 + c] = mc2 - 2 * dd * nz;
        }
      }
      break;
    }
  }
  return p;
}

// ---------------------------------------------------------------- evaluator

/**
 * Full velocity: symmetry fold, optional domain warp, primary field, optional
 * secondary field blend, plus global swirl/drift. Allocation-free.
 */
export function makeEvaluator(cfg, ctx) {
  const fA = FIELD_BY_ID[cfg.fieldA] || FIELDS[0];
  const fB = FIELD_BY_ID[cfg.fieldB] || FIELDS[0];
  const PA = cfg.paramsA, PB = cfg.paramsB;
  const ctxA = { noise: ctx.noise, time: ctx.time, data: fA.prepare ? fA.prepare(PA) : null };
  const ctxB = { noise: ctx.noiseB, time: ctx.time, data: fB.prepare ? fB.prepare(PB) : null };
  const scaleA = cfg.domain / fA.domain;
  const scaleB = cfg.domain / fB.domain;

  const M = new Float64Array(9);
  const p = [0, 0, 0], vA = [0, 0, 0], vB = [0, 0, 0], warp = [0, 0, 0];
  const blend = cfg.blend, mode = cfg.blendMode, sym = cfg.symmetry;
  const useB = blend > 0.0005;

  return function evaluate(x, y, z, out) {
    p[0] = x; p[1] = y; p[2] = z;
    if (sym) foldPoint(sym, p, M, cfg.domain * 0.55);
    let px = p[0], py = p[1], pz = p[2];

    if (cfg.warp > 0.0005) {
      curlNoise(ctx.noise, px * 0.83 + 11.2, py * 0.83 - 4.1, pz * 0.83 + 7.7,
        cfg.warpScale / cfg.domain, 2, 0.5, warp);
      const w = cfg.warp * cfg.domain;
      px += warp[0] * w; py += warp[1] * w; pz += warp[2] * w;
    }

    fA.fn(px / scaleA, py / scaleA, pz / scaleA, PA, ctxA, vA);
    let vx = vA[0], vy = vA[1], vz = vA[2];

    if (useB) {
      fB.fn(px / scaleB, py / scaleB, pz / scaleB, PB, ctxB, vB);
      if (mode === 1) {                                   // add
        vx += vB[0] * blend; vy += vB[1] * blend; vz += vB[2] * blend;
      } else if (mode === 2) {                            // cross product
        const la = Math.hypot(vx, vy, vz) || 1e-9, lb = Math.hypot(vB[0], vB[1], vB[2]) || 1e-9;
        const ax = vx / la, ay = vy / la, az = vz / la;
        const bx = vB[0] / lb, by = vB[1] / lb, bz = vB[2] / lb;
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        vx = vx * (1 - blend) + cx * blend * la;
        vy = vy * (1 - blend) + cy * blend * la;
        vz = vz * (1 - blend) + cz * blend * la;
      } else {                                            // lerp
        const la = Math.hypot(vx, vy, vz) || 1e-9, lb = Math.hypot(vB[0], vB[1], vB[2]) || 1e-9;
        vx = vx * (1 - blend) + vB[0] * (la / lb) * blend;
        vy = vy * (1 - blend) + vB[1] * (la / lb) * blend;
        vz = vz * (1 - blend) + vB[2] * (la / lb) * blend;
      }
    }

    if (sym) {                                            // map velocity back: M^T v
      const ux = M[0] * vx + M[3] * vy + M[6] * vz;
      const uy = M[1] * vx + M[4] * vy + M[7] * vz;
      const uz = M[2] * vx + M[5] * vy + M[8] * vz;
      vx = ux; vy = uy; vz = uz;
    }

    if (cfg.swirl !== 0) {
      const l = Math.hypot(vx, vy, vz) || 1e-9;
      vx += -z * 0 - y * cfg.swirl * l * 0.5;
      vy += x * cfg.swirl * l * 0.5;
    }
    if (cfg.drift !== 0) {
      const l = Math.hypot(vx, vy, vz) || 1e-9;
      vz += cfg.drift * l;
    }

    out[0] = vx; out[1] = vy; out[2] = vz;
    return out;
  };
}
