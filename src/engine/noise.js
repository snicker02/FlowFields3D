// noise.js — seeded 3D simplex noise + fBm + divergence-free curl noise.
// No dependencies. All hot paths are allocation-free.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F3 = 1 / 3, G3 = 1 / 6;

export class Noise {
  constructor(seed = 1) { this.reseed(seed); }

  reseed(seed) {
    this.seed = seed >>> 0;
    const rnd = mulberry32(this.seed || 1);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Classic 3D simplex noise. Range is approximately [-1, 1]. */
  noise3(xin, yin, zin) {
    const perm = this.perm, permMod12 = this.permMod12;
    const s = (xin + yin + zin) * F3;
    let i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    i &= 255; j &= 255; k &= 255;
    let n = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = permMod12[i + perm[j + perm[k]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = permMod12[i + i1 + perm[j + j1 + perm[k + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = permMod12[i + i2 + perm[j + j2 + perm[k + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = permMod12[i + 1 + perm[j + 1 + perm[k + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  }

  /** Fractal sum of simplex noise. */
  fbm3(x, y, z, octaves = 3, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }
}

/**
 * Divergence-free curl noise.
 * Builds a vector potential from three decorrelated fBm samples and returns its
 * curl, computed by central differences. curl(anything) is divergence free, so
 * streamlines neither pile up nor thin out — the reason this is the workhorse field.
 */
const OFF = [0, 0, 0, 31.416, 17.113, 5.928, 73.19, 41.77, 91.55];

/** One component of the vector potential. */
function pot(noise, c, x, y, z, s, octaves, gain) {
  const o = c * 3;
  return noise.fbm3(x * s + OFF[o], y * s + OFF[o + 1], z * s + OFF[o + 2], octaves, 2, gain);
}

export function curlNoise(noise, x, y, z, scale, octaves, gain, out) {
  const s = scale;
  // Finite-difference step, in *noise* space. The discrete curl is divergence
  // free to machine precision with respect to its own stencil at any step, but
  // its true divergence is not: measured against an independent stencil, a
  // step of 0.35 leaves ~400% of |v| as spurious divergence (it low-passes the
  // potential as well), 0.001 leaves ~14%, and 0.01 leaves ~3% — the noise's
  // second-derivative kinks put a floor under it. 0.01 is the measured minimum
  // and costs nothing.
  const e = 1e-2 / s;
  const inv = 1 / (2 * e);

  // Each curl term needs two components of the potential, not all three, so
  // twelve scalar samples do the work of eighteen.
  const p3y1 = pot(noise, 2, x, y + e, z, s, octaves, gain);
  const p3y0 = pot(noise, 2, x, y - e, z, s, octaves, gain);
  const p2z1 = pot(noise, 1, x, y, z + e, s, octaves, gain);
  const p2z0 = pot(noise, 1, x, y, z - e, s, octaves, gain);
  const p1z1 = pot(noise, 0, x, y, z + e, s, octaves, gain);
  const p1z0 = pot(noise, 0, x, y, z - e, s, octaves, gain);
  const p3x1 = pot(noise, 2, x + e, y, z, s, octaves, gain);
  const p3x0 = pot(noise, 2, x - e, y, z, s, octaves, gain);
  const p2x1 = pot(noise, 1, x + e, y, z, s, octaves, gain);
  const p2x0 = pot(noise, 1, x - e, y, z, s, octaves, gain);
  const p1y1 = pot(noise, 0, x, y + e, z, s, octaves, gain);
  const p1y0 = pot(noise, 0, x, y - e, z, s, octaves, gain);

  out[0] = (p3y1 - p3y0) * inv - (p2z1 - p2z0) * inv;
  out[1] = (p1z1 - p1z0) * inv - (p3x1 - p3x0) * inv;
  out[2] = (p2x1 - p2x0) * inv - (p1y1 - p1y0) * inv;
  return out;
}

/** The full vector potential at a point — exposed for tests and tooling. */
export function potentialAt(noise, x, y, z, s, octaves, gain, out) {
  out[0] = pot(noise, 0, x, y, z, s, octaves, gain);
  out[1] = pot(noise, 1, x, y, z, s, octaves, gain);
  out[2] = pot(noise, 2, x, y, z, s, octaves, gain);
  return out;
}
