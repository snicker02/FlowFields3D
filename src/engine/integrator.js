// integrator.js — streamline tracing.
//
// Everything is integrated at unit speed (arclength parameterisation): the RK4
// stages normalise the velocity, so a step advances a fixed distance along the
// curve. Orbits are identical to the time-parameterised ones, but samples come
// out evenly spaced, which is what ribbon extrusion wants. Raw |v| is recorded
// per sample so speed can still drive colour and width.

import { SpatialHash } from './spatialhash.js';
import { mulberry32 } from './noise.js';

export const SEED_MODES = [
  'Sphere volume', 'Sphere surface', 'Box', 'Grid', 'Disc', 'Ring', 'Two clusters', 'Axis line',
];

export function makeSeeds(mode, count, radius, seed, jitter) {
  const rnd = mulberry32(seed || 1);
  const out = [];
  const J = () => (rnd() * 2 - 1) * jitter * radius;
  switch (mode) {
    case 1: { // sphere surface
      for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        out.push([radius * s * Math.cos(a) + J(), radius * s * Math.sin(a) + J(), radius * u + J()]);
      }
      break;
    }
    case 2: { // box
      for (let i = 0; i < count; i++) {
        out.push([(rnd() * 2 - 1) * radius, (rnd() * 2 - 1) * radius, (rnd() * 2 - 1) * radius]);
      }
      break;
    }
    case 3: { // grid
      const n = Math.max(2, Math.round(Math.cbrt(count)));
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          for (let k = 0; k < n; k++) {
            out.push([
              ((i + 0.5) / n * 2 - 1) * radius + J(),
              ((j + 0.5) / n * 2 - 1) * radius + J(),
              ((k + 0.5) / n * 2 - 1) * radius + J(),
            ]);
          }
        }
      }
      break;
    }
    case 4: { // disc in XY
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2, r = radius * Math.sqrt(rnd());
        out.push([r * Math.cos(a), r * Math.sin(a), J() * 0.2]);
      }
      break;
    }
    case 5: { // ring
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        out.push([radius * Math.cos(a) + J() * 0.3, radius * Math.sin(a) + J() * 0.3, J() * 0.3]);
      }
      break;
    }
    case 6: { // two clusters
      for (let i = 0; i < count; i++) {
        const s = i % 2 === 0 ? 1 : -1;
        out.push([s * radius * 0.6 + J(), J(), J()]);
      }
      break;
    }
    case 7: { // axis line
      for (let i = 0; i < count; i++) {
        out.push([J() * 0.15, J() * 0.15, ((i + 0.5) / count * 2 - 1) * radius]);
      }
      break;
    }
    default: { // sphere volume
      for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const r = radius * Math.cbrt(rnd());
        out.push([r * s * Math.cos(a), r * s * Math.sin(a), r * u]);
      }
    }
  }
  return out;
}

/** One RK4 step of the unit-speed field. Returns |v| at the start point. */
function rk4Step(evaluate, p, h, out, k1, k2, k3, k4, tmp) {
  evaluate(p[0], p[1], p[2], k1);
  const speed = Math.hypot(k1[0], k1[1], k1[2]);
  if (!(speed > 1e-12) || !isFinite(speed)) return 0;
  const n1 = 1 / speed;
  k1[0] *= n1; k1[1] *= n1; k1[2] *= n1;

  tmp[0] = p[0] + k1[0] * h * 0.5; tmp[1] = p[1] + k1[1] * h * 0.5; tmp[2] = p[2] + k1[2] * h * 0.5;
  evaluate(tmp[0], tmp[1], tmp[2], k2);
  let l = Math.hypot(k2[0], k2[1], k2[2]) || 1e-12; k2[0] /= l; k2[1] /= l; k2[2] /= l;

  tmp[0] = p[0] + k2[0] * h * 0.5; tmp[1] = p[1] + k2[1] * h * 0.5; tmp[2] = p[2] + k2[2] * h * 0.5;
  evaluate(tmp[0], tmp[1], tmp[2], k3);
  l = Math.hypot(k3[0], k3[1], k3[2]) || 1e-12; k3[0] /= l; k3[1] /= l; k3[2] /= l;

  tmp[0] = p[0] + k3[0] * h; tmp[1] = p[1] + k3[1] * h; tmp[2] = p[2] + k3[2] * h;
  evaluate(tmp[0], tmp[1], tmp[2], k4);
  l = Math.hypot(k4[0], k4[1], k4[2]) || 1e-12; k4[0] /= l; k4[1] /= l; k4[2] /= l;

  out[0] = p[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
  out[1] = p[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
  out[2] = p[2] + (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
  return speed;
}

/** Euler / midpoint variants, for the cheap-and-jagged look. */
function eulerStep(evaluate, p, h, out, k1) {
  evaluate(p[0], p[1], p[2], k1);
  const speed = Math.hypot(k1[0], k1[1], k1[2]);
  if (!(speed > 1e-12) || !isFinite(speed)) return 0;
  out[0] = p[0] + k1[0] / speed * h;
  out[1] = p[1] + k1[1] / speed * h;
  out[2] = p[2] + k1[2] / speed * h;
  return speed;
}

export class Tracer {
  /**
   * cfg: { seedMode, seedCount, maxCurves, domain, seedRadiusFrac, stepFrac,
   *        maxSteps, minSteps, bidirectional, boundsFrac, minSpeed, integrator,
   *        even, dSepFrac, dTestRatio, seed, jitter }
   */
  constructor(cfg, evaluate) {
    this.cfg = cfg;
    this.evaluate = evaluate;
    this.curves = [];
    this.rnd = mulberry32((cfg.seed | 0) + 1013);

    const R = cfg.domain * cfg.seedRadiusFrac;
    this.h = cfg.domain * cfg.stepFrac;
    this.bounds = cfg.domain * cfg.boundsFrac;
    this.dSep = cfg.domain * cfg.dSepFrac;
    this.dTest = this.dSep * cfg.dTestRatio;

    // A confinement volume rejects seeds and stops curves at its surface. Seeds
    // are oversampled first, because rejection throws most of them away when
    // the volume is a thin shell.
    this.inside = cfg.inside || null;
    // Image-weighted seeding. A seed is kept with probability equal to the
    // image value raised to a power, using a hash of the position rather than a
    // running generator so the same seed set comes back every trace.
    this.seedWeight = cfg.seedWeight || null;
    let seeds = makeSeeds(cfg.seedMode, cfg.seedCount, R, cfg.seed, cfg.jitter);
    if (this.seedWeight) seeds = seeds.filter((s2) => this._weighted(s2));
    if (this.inside) {
      const kept = seeds.filter((s2) => this.inside(s2[0], s2[1], s2[2]));
      let tries = 0;
      while (kept.length < cfg.seedCount && tries++ < 12) {
        const more = makeSeeds(cfg.seedMode, cfg.seedCount, R, (cfg.seed | 0) + tries * 7919, cfg.jitter);
        for (const s2 of more) {
          if (kept.length >= cfg.seedCount) break;
          if (this.seedWeight && !this._weighted(s2)) continue;
          if (this.inside(s2[0], s2[1], s2[2])) kept.push(s2);
        }
      }
      seeds = kept;
    }
    this.queue = seeds;
    this.qi = 0;
    this.hash = cfg.even ? new SpatialHash(Math.max(this.dSep, this.h * 0.5)) : null;
    this.skip = Math.max(2, Math.ceil(this.dSep / this.h) + 1);

    this._p = [0, 0, 0]; this._q = [0, 0, 0];
    this._k1 = [0, 0, 0]; this._k2 = [0, 0, 0]; this._k3 = [0, 0, 0]; this._k4 = [0, 0, 0];
    this._tmp = [0, 0, 0];
    this.done = false;
  }

  get progress() {
    const a = this.curves.length / this.cfg.maxCurves;
    const b = this.queue.length ? this.qi / this.queue.length : 1;
    return Math.min(1, Math.max(this.cfg.even ? a : b, 0));
  }

  /** Trace for up to `ms` milliseconds. Returns true when finished. */
  runSlice(ms = 16) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    while (!this.done && now() - t0 < ms) {
      for (let i = 0; i < 8 && !this.done; i++) this._one();
    }
    return this.done;
  }

  runAll() {
    let guard = 0;
    while (!this.done && guard++ < 1e7) this._one();
    return this.curves;
  }

  _one() {
    const cfg = this.cfg;
    if (this.curves.length >= cfg.maxCurves || this.qi >= this.queue.length) { this.done = true; return; }
    const s = this.queue[this.qi++];
    if (cfg.even && this.hash.hasWithin(s[0], s[1], s[2], this.dSep)) return;
    const curve = this._trace(s, this.curves.length);
    if (!curve) return;
    this.curves.push(curve);
    if (cfg.even) this._spawnCandidates(curve);
  }

  _trace(seed, curveId) {
    const cfg = this.cfg;
    const fwd = this._integrate(seed, +1, curveId);
    const back = cfg.bidirectional ? this._integrate(seed, -1, curveId) : null;
    const nb = back ? back.n : 0;
    const n = nb + fwd.n;
    if (n < cfg.minSteps) return null;

    const pts = new Float32Array(n * 3);
    const speed = new Float32Array(n);
    for (let i = 0; i < nb; i++) {                    // backward half, reversed
      const j = nb - 1 - i;
      pts[i * 3] = back.pts[j * 3]; pts[i * 3 + 1] = back.pts[j * 3 + 1]; pts[i * 3 + 2] = back.pts[j * 3 + 2];
      speed[i] = back.speed[j];
    }
    for (let i = 0; i < fwd.n; i++) {
      const k = nb + i;
      pts[k * 3] = fwd.pts[i * 3]; pts[k * 3 + 1] = fwd.pts[i * 3 + 1]; pts[k * 3 + 2] = fwd.pts[i * 3 + 2];
      speed[k] = fwd.speed[i];
    }
    return { pts, speed, n, rnd: this.rnd(), id: curveId, length: (n - 1) * this.h };
  }

  _integrate(seed, dir, curveId) {
    const cfg = this.cfg;
    const h = this.h * dir;
    const maxN = cfg.maxSteps;
    const pts = new Float32Array(maxN * 3);
    const speed = new Float32Array(maxN);
    const p = this._p, q = this._q;
    p[0] = seed[0]; p[1] = seed[1]; p[2] = seed[2];
    let n = 0;
    const useEven = cfg.even && this.hash;
    const b2 = this.bounds * this.bounds;

    for (; n < maxN; n++) {
      pts[n * 3] = p[0]; pts[n * 3 + 1] = p[1]; pts[n * 3 + 2] = p[2];
      let sp;
      if (cfg.integrator === 1) sp = eulerStep(this.evaluate, p, h, q, this._k1);
      else sp = rk4Step(this.evaluate, p, h, q, this._k1, this._k2, this._k3, this._k4, this._tmp);
      speed[n] = sp;
      if (sp <= cfg.minSpeed) { n++; break; }
      if (!isFinite(q[0]) || !isFinite(q[1]) || !isFinite(q[2])) { n++; break; }
      if (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] > b2) { n++; break; }
      if (this.inside && !this.inside(q[0], q[1], q[2])) { n++; break; }
      if (useEven && this.hash.hasWithin(q[0], q[1], q[2], this.dTest, curveId, n, this.skip)) { n++; break; }
      if (useEven) this.hash.insert(p[0], p[1], p[2], curveId, n);
      p[0] = q[0]; p[1] = q[1]; p[2] = q[2];
    }
    if (useEven && n > 0) this.hash.insert(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2], curveId, n - 1);
    return { pts, speed, n };
  }

  /** Jobard–Lefebvre candidate seeding, generalised to 3D: offset perpendicular
   *  to the tangent in six directions around the curve. */
  /** Deterministic accept/reject against the weighting field. */
  _weighted(p) {
    const w = this.seedWeight(p[0], p[1], p[2]);
    if (w >= 1) return true;
    if (w <= 0) return false;
    // Hash the position: a running PRNG would give different seeds depending on
    // how many candidates happened to be tested before this one.
    let h = Math.imul(Math.round(p[0] * 8191) ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ Math.round(p[1] * 8191), 0xc2b2ae35);
    h = Math.imul(h ^ Math.round(p[2] * 8191), 0x27d4eb2f);
    h ^= h >>> 15;
    return ((h >>> 8) & 0xffff) / 65536 < w;
  }

  _spawnCandidates(curve) {
    const stride = Math.max(1, Math.round(this.dSep / this.h));
    const p = curve.pts;
    const d = this.dSep * 1.02;
    for (let i = 0; i < curve.n; i += stride) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(curve.n - 1, i + 1);
      let tx = p[i1 * 3] - p[i0 * 3], ty = p[i1 * 3 + 1] - p[i0 * 3 + 1], tz = p[i1 * 3 + 2] - p[i0 * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1e-9;
      tx /= tl; ty /= tl; tz /= tl;
      let ux, uy, uz;
      if (Math.abs(tx) <= Math.abs(ty) && Math.abs(tx) <= Math.abs(tz)) { ux = 0; uy = -tz; uz = ty; }
      else if (Math.abs(ty) <= Math.abs(tz)) { ux = -tz; uy = 0; uz = tx; }
      else { ux = -ty; uy = tx; uz = 0; }
      const ul = Math.hypot(ux, uy, uz) || 1e-9; ux /= ul; uy /= ul; uz /= ul;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const s = Math.SQRT1_2;
      const dirs = [
        [ux, uy, uz], [-ux, -uy, -uz], [vx, vy, vz], [-vx, -vy, -vz],
        [(ux + vx) * s, (uy + vy) * s, (uz + vz) * s], [-(ux - vx) * s, -(uy - vy) * s, -(uz - vz) * s],
      ];
      for (const dv of dirs) {
        const cx = p[i * 3] + dv[0] * d, cy = p[i * 3 + 1] + dv[1] * d, cz = p[i * 3 + 2] + dv[2] * d;
        if (this.inside && !this.inside(cx, cy, cz)) continue;
        if (this.seedWeight && !this._weighted([cx, cy, cz])) continue;
        this.queue.push([cx, cy, cz]);
      }
    }
  }
}
