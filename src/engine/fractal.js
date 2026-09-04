// fractal.js — two different senses of "make it fractal", both of which keep
// the streamlines honest.
//
//   1. FOLD. An iterated map is applied to the sample point before the field is
//      read. Every operation used here is a *similarity* — a reflection, a
//      rotation, a uniform scale, or a sphere inversion, whose Jacobian at a
//      point is a scaled reflection. The composition of similarities is a
//      similarity, so the Jacobian of the whole fold is s·M with M orthogonal,
//      and the velocity pulls back exactly as M^T v. That is the same trick the
//      symmetry folds use, extended to many iterations, so the folded field is
//      genuinely equivariant rather than merely folded-looking.
//
//      Every fold below is also continuous: box folds reflect at the plane they
//      test, sphere folds have k = 1 at the outer radius and match from both
//      sides at the inner one. So streamlines bend at fold surfaces but never
//      jump. A fixed iteration count is what buys this — escape-time iteration
//      would tear the field along the escape boundary.
//
//      Note on the Mandelbox: the real one adds the *original* point each
//      iteration, which makes the Jacobian s·J_fold + I — not a similarity, and
//      the clean pullback is lost. This uses a constant offset instead, which
//      is the Amazing Box / KIFS form and stays exact.
//
//   2. OCTAVES. The field itself is summed over self-similar scales,
//      v(p) = Σ aⁱ Rᵢᵀ f(bⁱ Rᵢ p). This is fBm for a vector field. Because each
//      term is a rotated, scaled pullback, a divergence-free f stays
//      divergence free — curl noise summed this way is still curl noise.
//      It costs one field evaluation per octave.

export const FOLD_MODES = [
  'None', 'Mandelbox', 'Sierpinski', 'Menger cross', 'Kaleidoscopic IFS', 'Apollonian',
];

export function identity3(M) {
  M[0] = 1; M[1] = 0; M[2] = 0;
  M[3] = 0; M[4] = 1; M[5] = 0;
  M[6] = 0; M[7] = 0; M[8] = 1;
  return M;
}

/** M <- (I - 2nn^T) M, for a unit normal n. */
function accReflect(M, nx, ny, nz) {
  for (let c = 0; c < 3; c++) {
    const m0 = M[c], m1 = M[3 + c], m2 = M[6 + c];
    const d = nx * m0 + ny * m1 + nz * m2;
    M[c] = m0 - 2 * d * nx;
    M[3 + c] = m1 - 2 * d * ny;
    M[6 + c] = m2 - 2 * d * nz;
  }
}

/** M <- -M, the orthogonal part of a negative uniform scale. */
function accNegate(M) {
  for (let i = 0; i < 9; i++) M[i] = -M[i];
}

/** M <- R M for a rotation of `ang` about the unit axis (ax, ay, az). */
function accRotate(M, ax, ay, az, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  const r0 = t * ax * ax + c, r1 = t * ax * ay - s * az, r2 = t * ax * az + s * ay;
  const r3 = t * ax * ay + s * az, r4 = t * ay * ay + c, r5 = t * ay * az - s * ax;
  const r6 = t * ax * az - s * ay, r7 = t * ay * az + s * ax, r8 = t * az * az + c;
  for (let col = 0; col < 3; col++) {
    const m0 = M[col], m1 = M[3 + col], m2 = M[6 + col];
    M[col] = r0 * m0 + r1 * m1 + r2 * m2;
    M[3 + col] = r3 * m0 + r4 * m1 + r5 * m2;
    M[6 + col] = r6 * m0 + r7 * m1 + r8 * m2;
  }
}

/** Rotate a point by `ang` about the unit axis, in place. */
function rotatePoint(p, ax, ay, az, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const dot = ax * p[0] + ay * p[1] + az * p[2];
  const cx = ay * p[2] - az * p[1];
  const cy = az * p[0] - ax * p[2];
  const cz = ax * p[1] - ay * p[0];
  p[0] = p[0] * c + cx * s + ax * dot * (1 - c);
  p[1] = p[1] * c + cy * s + ay * dot * (1 - c);
  p[2] = p[2] * c + cz * s + az * dot * (1 - c);
}

/** Reflect p[i] into [-L, L] by a triangle wave — continuous, unlike a modulo. */
function mirrorFold(p, i, L, M) {
  const q = 4 * L;
  let t = (p[i] + L) % q;
  if (t < 0) t += q;
  let flipped = false;
  if (t > 2 * L) { t = q - t; flipped = true; }
  p[i] = t - L;
  if (flipped) accReflect(M, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
}

/** Reflect one axis about the plane at ±L, if it has gone past. */
function boxFoldAxis(p, i, L, M) {
  if (p[i] > L) { p[i] = 2 * L - p[i]; }
  else if (p[i] < -L) { p[i] = -2 * L - p[i]; }
  else return;
  accReflect(M, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
}

/** Invert p through a sphere of radius R, expanding the core to a flat scale. */
function sphereFold(p, rMin, rFix, M) {
  const r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
  if (r2 < 1e-12) return;
  if (r2 < rMin * rMin) {
    const k = (rFix * rFix) / (rMin * rMin);   // uniform scale: no orientation change
    p[0] *= k; p[1] *= k; p[2] *= k;
  } else if (r2 < rFix * rFix) {
    const k = (rFix * rFix) / r2;              // inversion: a scaled reflection in n
    const r = Math.sqrt(r2);
    const nx = p[0] / r, ny = p[1] / r, nz = p[2] / r;
    p[0] *= k; p[1] *= k; p[2] *= k;
    accReflect(M, nx, ny, nz);
  }
}

/** Swap two axes — a reflection in the plane between them. */
function swapAxes(p, i, j, M) {
  const t = p[i]; p[i] = p[j]; p[j] = t;
  const s = Math.SQRT1_2;
  accReflect(M, (i === 0 || j === 0) ? (i === 0 ? s : -s) : 0,
    (i === 1 || j === 1) ? (i === 1 ? s : -s) : 0,
    (i === 2 || j === 2) ? (i === 2 ? s : -s) : 0);
}

/** Negate and swap — the reflection used by the Sierpinski fold. */
function foldPlaneSum(p, i, j, M) {
  if (p[i] + p[j] >= 0) return;
  const t = -p[j];
  p[j] = -p[i];
  p[i] = t;
  const s = Math.SQRT1_2;
  accReflect(M, i === 0 || j === 0 ? s : 0, i === 1 || j === 1 ? s : 0, i === 2 || j === 2 ? s : 0);
}

/** Conditional abs() on one axis — a reflection in that coordinate plane. */
function absAxis(p, i, M) {
  if (p[i] >= 0) return;
  p[i] = -p[i];
  accReflect(M, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
}

const AXIS = 1 / Math.sqrt(3);

/**
 * Fold `p` in place through `cfg.mode`, accumulating the orthogonal part of the
 * Jacobian into `M` (3x3 row-major, which the caller must have initialised —
 * usually to the identity, or to whatever the symmetry fold left behind).
 * The uniform scale part is deliberately dropped: it changes only the length of
 * the pulled-back velocity, and unit-speed integration normalises that away.
 */
export function fractalFold(cfg, p, M) {
  const mode = cfg.mode | 0;
  if (!mode) return p;

  const iters = Math.max(1, Math.min(16, cfg.iterations | 0));
  const s = cfg.scale;
  const L = cfg.foldLimit;
  const ox = cfg.offsetX, oy = cfg.offsetY, oz = cfg.offsetZ;
  const spin = (cfg.spin || 0) * Math.PI / 180;
  const tumble = (cfg.tumble || 0) * Math.PI / 180;

  for (let i = 0; i < iters; i++) {
    if (spin) { rotatePoint(p, 0, 1, 0, spin); accRotate(M, 0, 1, 0, spin); }

    switch (mode) {
      case 1:                                        // Amazing Box
        boxFoldAxis(p, 0, L, M); boxFoldAxis(p, 1, L, M); boxFoldAxis(p, 2, L, M);
        sphereFold(p, cfg.minRadius, cfg.fixedRadius, M);
        break;
      case 2:                                        // Sierpinski tetrahedron
        foldPlaneSum(p, 0, 1, M); foldPlaneSum(p, 0, 2, M); foldPlaneSum(p, 1, 2, M);
        break;
      case 3:                                        // Menger cross
        absAxis(p, 0, M); absAxis(p, 1, M); absAxis(p, 2, M);
        if (p[0] < p[1]) swapAxes(p, 0, 1, M);
        if (p[0] < p[2]) swapAxes(p, 0, 2, M);
        if (p[1] < p[2]) swapAxes(p, 1, 2, M);
        break;
      case 4:                                        // kaleidoscopic IFS
        absAxis(p, 0, M); absAxis(p, 1, M); absAxis(p, 2, M);
        if (p[0] < p[1]) swapAxes(p, 0, 1, M);
        if (p[1] < p[2]) swapAxes(p, 1, 2, M);
        break;
      case 5:                                        // Apollonian: lattice + inversion
        mirrorFold(p, 0, L, M); mirrorFold(p, 1, L, M); mirrorFold(p, 2, L, M);
        sphereFold(p, cfg.minRadius, cfg.fixedRadius, M);
        break;
    }

    if (tumble) { rotatePoint(p, AXIS, AXIS, AXIS, tumble); accRotate(M, AXIS, AXIS, AXIS, tumble); }

    if (mode !== 5) {                                // scale away from the offset
      p[0] = s * p[0] - ox * (s - 1);
      p[1] = s * p[1] - oy * (s - 1);
      p[2] = s * p[2] - oz * (s - 1);
      if (s < 0) accNegate(M);
    }
  }
  return p;
}

/**
 * How much finer the world-space structure is once the fold is applied. A fold
 * that multiplies the point by `scale` every iteration puts the field's
 * features at 1/scale^iterations of their usual size, so the integration step
 * has to shrink by the same factor or the tracer walks straight past the
 * detail it was asked to produce. Capped, because at some point the answer is
 * to trace a smaller region rather than take a million steps.
 */
export function foldStepScale(cfg) {
  if (!cfg || !(cfg.mode | 0)) return 1;
  if ((cfg.mode | 0) === 5) return 1;            // Apollonian has no scale step
  const s = Math.abs(cfg.scale);
  if (!(s > 1)) return 1;
  return Math.min(16, Math.pow(s, Math.max(1, cfg.iterations | 0)));
}

/**
 * Precompute the per-octave rotations for the self-similar field sum. Rotating
 * each octave keeps the scales from lining up into visible axis-aligned banding.
 */
export function octaveRotations(count, spinDeg) {
  const rots = [];
  for (let i = 0; i < count; i++) {
    const M = identity3(new Float64Array(9));
    if (i) accRotate(M, AXIS, AXIS, AXIS, i * spinDeg * Math.PI / 180);
    rots.push(M);
  }
  return rots;
}
