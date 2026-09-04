// tools/test.mjs — headless checks for everything that does not need a GPU.
// Run: node tools/test.mjs
//
// The engine modules are deliberately DOM-free so they can be tested here; only
// src/main.js and src/ui/* touch the document, and those are syntax-checked by
// tools/check.sh instead.

import { Noise, curlNoise, mulberry32 } from '../src/engine/noise.js';
import * as VM from '../src/engine/vecmath.js';
import { FIELDS, FIELD_BY_ID, defaultParams, makeEvaluator, foldPoint, SYMMETRIES } from '../src/engine/fields.js';
import { Tracer, makeSeeds, SEED_MODES } from '../src/engine/integrator.js';
import { SpatialHash } from '../src/engine/spatialhash.js';
import { tangents, rmfNormals, prepareCurves, buildMesh, fitTransform, smoothCurve } from '../src/engine/geometry.js';
import { Gradient, hexToRgb, rgbToHex, GRADIENT_PRESETS } from '../src/engine/palette.js';
import { defaultState, mergeState, reconcileFieldParams } from '../src/state.js';
import { PRESETS } from '../src/presets.js';
import { fractalFold, identity3, foldStepScale, octaveRotations, FOLD_MODES } from '../src/engine/fractal.js';
import { chunksToOBJ, preparedToSVG, EXPORT_SIZES, resolveExportSize } from '../src/io/exporters.js';
import { SCHEMA, getPath, setPath } from '../src/ui/panel.js';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function near(name, a, b, tol, detail = '') {
  ok(name, Math.abs(a - b) <= tol, detail || `got ${a}, expected ${b} +/- ${tol}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// ---------------------------------------------------------------- vecmath
section('vecmath');
{
  const p = VM.mat4Perspective(Math.PI / 2, 1, 0.1, 100);
  near('perspective f', p[0], 1, 1e-6);
  near('perspective w row', p[11], -1, 1e-12);

  const v = VM.mat4LookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
  const eyeClip = VM.mat4TransformPoint(v, [0, 0, 0]);
  near('lookAt puts target at -dist', eyeClip[2], -5, 1e-6);

  const mvp = VM.mat4Multiply(p, v);
  const c = VM.mat4TransformPoint(mvp, [0, 0, 0]);
  near('centre projects to x=0', c[0] / c[3], 0, 1e-6);
  near('centre projects to y=0', c[1] / c[3], 0, 1e-6);

  // multiply against a hand-rolled reference
  const A = new Float32Array(16), B = new Float32Array(16);
  const rnd = mulberry32(4);
  for (let i = 0; i < 16; i++) { A[i] = rnd() * 2 - 1; B[i] = rnd() * 2 - 1; }
  const R = VM.mat4Multiply(A, B);
  let worst = 0;
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[k * 4 + row] * B[col * 4 + k];
      worst = Math.max(worst, Math.abs(s - R[col * 4 + row]));
    }
  }
  ok('mat4Multiply matches reference', worst < 1e-5, `worst ${worst}`);

  const t = VM.normalize([0.3, -0.9, 0.2]);
  const perp = VM.perpendicular(t);
  near('perpendicular is unit', VM.len(perp), 1, 1e-6);
  near('perpendicular is orthogonal', VM.dot(perp, t), 0, 1e-6);

  const rot = VM.rotateAxis([1, 0, 0], [0, 0, 1], Math.PI / 2);
  near('rotateAxis 90deg x->y', rot[1], 1, 1e-6);
}

// ---------------------------------------------------------------- noise
section('noise');
{
  const n = new Noise(1234);
  let min = Infinity, max = -Infinity, sum = 0;
  const N = 120000;
  for (let i = 0; i < N; i++) {
    const v = n.noise3(i * 0.013, Math.sin(i) * 3.1, i * 0.0071);
    min = Math.min(min, v); max = Math.max(max, v); sum += v;
  }
  ok('simplex stays in range', min > -1.05 && max < 1.05, `min ${min.toFixed(3)} max ${max.toFixed(3)}`);
  ok('simplex uses its range', max > 0.5 && min < -0.5, `min ${min.toFixed(3)} max ${max.toFixed(3)}`);
  near('simplex is centred', sum / N, 0, 0.02);

  let maxJump = 0;
  for (let i = 0; i < 20000; i++) {
    const x = i * 0.011, y = i * 0.007, z = i * 0.017;
    maxJump = Math.max(maxJump, Math.abs(n.noise3(x, y, z) - n.noise3(x + 1e-4, y, z)));
  }
  ok('simplex is continuous', maxJump < 1e-2, `max jump ${maxJump}`);

  const a = new Noise(77), b = new Noise(77), c = new Noise(78);
  ok('same seed, same noise', a.noise3(1.3, 2.2, 3.1) === b.noise3(1.3, 2.2, 3.1));
  ok('different seed, different noise', a.noise3(1.3, 2.2, 3.1) !== c.noise3(1.3, 2.2, 3.1));

  // Curl noise must be divergence free, or streamlines pile up and thin out.
  // Two checks: exact cancellation on the stencil the implementation uses, and
  // a bound on the true divergence measured with an independent stencil.
  const out = [0, 0, 0], o2 = [0, 0, 0];
  const scale = 1.2;
  const measure = (k) => {
    let meanDiv = 0, meanMag = 0, samples = 0;
    for (let i = 0; i < 400; i++) {
      const x = (mulberry32(i + 1)() * 2 - 1) * 2;
      const y = (mulberry32(i + 91)() * 2 - 1) * 2;
      const z = (mulberry32(i + 771)() * 2 - 1) * 2;
      let div = 0;
      for (let d = 0; d < 3; d++) {
        const p1 = [x, y, z], p2 = [x, y, z];
        p1[d] += k; p2[d] -= k;
        curlNoise(a, p1[0], p1[1], p1[2], scale, 2, 0.5, out);
        curlNoise(a, p2[0], p2[1], p2[2], scale, 2, 0.5, o2);
        div += (out[d] - o2[d]) / (2 * k);
      }
      curlNoise(a, x, y, z, scale, 2, 0.5, out);
      meanMag += Math.hypot(out[0], out[1], out[2]);
      meanDiv += Math.abs(div);
      samples++;
    }
    return { div: meanDiv / samples, mag: meanMag / samples };
  };

  const matched = measure(1e-2 / scale);          // the implementation's own step
  ok('curl noise cancels exactly on its own stencil', matched.div < 1e-8,
    `mean |div| ${matched.div.toExponential(2)}`);
  const independent = measure(0.01);
  ok('curl noise has little true divergence', independent.div < 0.1 * independent.mag,
    `mean |div| ${independent.div.toFixed(4)} vs mean |v| ${independent.mag.toFixed(4)}`);
  ok('curl noise is non-trivial', independent.mag > 0.05, `mean |v| ${independent.mag}`);
}

// ---------------------------------------------------------------- fields
section('fields');
{
  ok('field ids are unique', new Set(FIELDS.map((f) => f.id)).size === FIELDS.length);
  for (const f of FIELDS) {
    const P = defaultParams(f);
    const ctx = { noise: new Noise(5), time: 0.3, data: f.prepare ? f.prepare(P) : null };
    const out = [0, 0, 0];
    let finite = true, maxMag = 0;
    const R = f.domain;
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        for (let k = 0; k < 12; k++) {
          const x = ((i + 0.5) / 12 * 2 - 1) * R, y = ((j + 0.5) / 12 * 2 - 1) * R, z = ((k + 0.5) / 12 * 2 - 1) * R;
          f.fn(x, y, z, P, ctx, out);
          if (!isFinite(out[0]) || !isFinite(out[1]) || !isFinite(out[2])) { finite = false; }
          maxMag = Math.max(maxMag, Math.hypot(out[0], out[1], out[2]));
        }
      }
    }
    ok(`${f.id}: finite over its domain`, finite);
    ok(`${f.id}: produces motion`, maxMag > 1e-6, `max |v| ${maxMag}`);
    ok(`${f.id}: params have sane ranges`, f.params.every((p) => p.choice || (p.def >= p.min && p.def <= p.max)));
  }

  // every choice option of a multi-shape field must build
  const fil = FIELD_BY_ID.filament;
  for (let s = 0; s < 5; s++) {
    const P = { ...defaultParams(fil), shape: s };
    const data = fil.prepare(P);
    ok(`filament shape ${s} builds`, data.lines.length > 0 && data.lines.every((l) => l.length >= 6));
  }
}

section('symmetry');
{
  // Mirror X: the folded field must be equivariant, v(-x,y,z) = R v(x,y,z).
  const cfg = {
    fieldA: 'curl', paramsA: defaultParams(FIELD_BY_ID.curl),
    fieldB: 'shear', paramsB: defaultParams(FIELD_BY_ID.shear),
    blend: 0, blendMode: 0, symmetry: 1, warp: 0, warpScale: 1, swirl: 0, drift: 0, domain: 1.6,
  };
  const ctx = { noise: new Noise(11), noiseB: new Noise(12), time: 0 };
  const ev = makeEvaluator(cfg, ctx);
  const a = [0, 0, 0], b = [0, 0, 0];
  let worst = 0, mag = 0;
  const rnd = mulberry32(3);
  for (let i = 0; i < 300; i++) {
    const x = (rnd() * 2 - 1) * 1.4, y = (rnd() * 2 - 1) * 1.4, z = (rnd() * 2 - 1) * 1.4;
    ev(x, y, z, a);
    ev(-x, y, z, b);
    worst = Math.max(worst, Math.hypot(b[0] + a[0], b[1] - a[1], b[2] - a[2]));
    mag = Math.max(mag, Math.hypot(a[0], a[1], a[2]));
  }
  ok('mirror fold is equivariant', worst < 1e-4 * Math.max(1, mag), `worst ${worst.toExponential(2)} vs |v| ${mag.toFixed(3)}`);

  // every fold must stay finite and keep the accumulated matrix orthogonal
  const M = new Float64Array(9);
  let orthoWorst = 0;
  for (let mode = 0; mode < SYMMETRIES.length; mode++) {
    for (let i = 0; i < 200; i++) {
      const p = [(rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2];
      foldPoint(mode, p, M, 1);
      ok(`fold ${mode} stays finite`, p.every(isFinite));
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = 0; k < 3; k++) s += M[r * 3 + k] * M[c * 3 + k];
          orthoWorst = Math.max(orthoWorst, Math.abs(s - (r === c ? 1 : 0)));
        }
      }
    }
  }
  ok('fold matrices stay orthogonal', orthoWorst < 1e-9, `worst deviation ${orthoWorst.toExponential(2)}`);
}

// ---------------------------------------------------------------- tiled export
section('tiled export');
{
  // A tile must be an exact window onto the full frustum. If this drifts, a big
  // PNG comes out with visible seams or doubled geometry at the tile edges.
  const fov = 42 * Math.PI / 180, aspect = 16 / 9, near = 0.01, far = 60;
  const full = VM.mat4Perspective(fov, aspect, near, far);
  const tiles = [[0, 0.5, 0, 0.5], [0.5, 1, 0, 0.5], [0, 0.5, 0.5, 1], [0.5, 1, 0.5, 1],
    [0.25, 0.4, 0.6, 0.85], [0, 1, 0, 1]];

  let worst = 0, tested = 0;
  for (const t of tiles) {
    const sub = VM.mat4PerspectiveTile(fov, aspect, near, far, t[0], t[1], t[2], t[3]);
    for (let i = 0; i < 200; i++) {
      const p = [
        (mulberry32(i + 2)() * 2 - 1) * 2,
        (mulberry32(i + 22)() * 2 - 1) * 2,
        -(0.5 + mulberry32(i + 222)() * 6),
      ];
      const ah = VM.mat4TransformPoint(full, p);
      const bh = VM.mat4TransformPoint(sub, p);
      if (ah[3] <= 1e-6 || bh[3] <= 1e-6) continue;          // behind the eye
      const a = [ah[0] / ah[3], ah[1] / ah[3], ah[2] / ah[3]];
      const b = [bh[0] / bh[3], bh[1] / bh[3], bh[2] / bh[3]];
      // NDC to image UV under the full projection, then into the tile's frame.
      const u = (a[0] + 1) / 2, v = (a[1] + 1) / 2;
      const eu = ((u - t[0]) / (t[1] - t[0])) * 2 - 1;
      const ev = ((v - t[2]) / (t[3] - t[2])) * 2 - 1;
      if (!isFinite(eu) || !isFinite(ev)) continue;
      worst = Math.max(worst, Math.abs(b[0] - eu), Math.abs(b[1] - ev));
      // Depth must be untouched, or tiles would z-fight differently.
      worst = Math.max(worst, Math.abs(b[2] - a[2]));
      tested++;
    }
  }
  ok('tiles are exact windows onto the full frustum', worst < 1e-5, `worst ${worst.toExponential(2)} over ${tested} points`);

  const whole = VM.mat4PerspectiveTile(fov, aspect, near, far, 0, 1, 0, 1);
  let same = 0;
  for (let i = 0; i < 16; i++) same = Math.max(same, Math.abs(whole[i] - full[i]));
  ok('the whole-image tile is the plain projection', same < 1e-6, `worst ${same.toExponential(2)}`);

  // Tiles must cover the image exactly once — the walk main.js does.
  for (const [W, H, tileT] of [[3840, 2160, 512], [7680, 4320, 1024], [1000, 1000, 333], [200, 100, 512]]) {
    const cols = Math.ceil(W / tileT), rows = Math.ceil(H / tileT);
    let area = 0, overflow = false;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const x = tx * tileT, y = ty * tileT;
        const tw = Math.min(tileT, W - x), th = Math.min(tileT, H - y);
        if (tw <= 0 || th <= 0 || x + tw > W || y + th > H) overflow = true;
        area += tw * th;
      }
    }
    ok(`tiles cover ${W}x${H} exactly once`, area === W * H && !overflow, `covered ${area} of ${W * H}`);
  }

  // Size table
  ok('every export size resolves', EXPORT_SIZES.every((_, i) => {
    const r = resolveExportSize({ exportSize: i, exportWidth: 6000, exportHeight: 4000 }, 1600, 900);
    return r.w >= 16 && r.h >= 16 && isFinite(r.w) && isFinite(r.h);
  }));
  {
    const r = resolveExportSize({ exportSize: 0, exportWidth: 1, exportHeight: 1 }, 1600, 900);
    ok('"Screen" is the viewport', r.w === 1600 && r.h === 900, `${r.w}x${r.h}`);
  }
  {
    const r = resolveExportSize({ exportSize: 2, exportWidth: 1, exportHeight: 1 }, 1600, 900);
    ok('"4x screen" multiplies the viewport', r.w === 6400 && r.h === 3600, `${r.w}x${r.h}`);
  }
  {
    const i = EXPORT_SIZES.findIndex((e) => e.custom);
    const r = resolveExportSize({ exportSize: i, exportWidth: 9000, exportHeight: 5000 }, 1600, 900);
    ok('"Custom" uses the custom size', r.w === 9000 && r.h === 5000, `${r.w}x${r.h}`);
  }
  {
    const r = resolveExportSize({ exportSize: 999, exportWidth: 1, exportHeight: 1 }, 800, 600);
    ok('an unknown size falls back to the screen', r.w === 800 && r.h === 600, `${r.w}x${r.h}`);
  }
  ok('sizes stay inside the browser canvas limit',
    EXPORT_SIZES.every((e) => !e.w || e.w * e.h <= 300e6));
}

// ---------------------------------------------------------------- fractal
section('fractal');
{
  const M = new Float64Array(9);
  const base = {
    iterations: 4, scale: 1.3, foldLimit: 1, minRadius: 0.5, fixedRadius: 1,
    offsetX: 1, offsetY: 1, offsetZ: 1, spin: 13, tumble: 7,
  };
  const doFold = (cfg, q) => {
    const p = q.slice();
    identity3(M);
    fractalFold(cfg, p, M);
    return { p, M: Float64Array.from(M) };
  };

  for (let mode = 1; mode < FOLD_MODES.length; mode++) {
    const cfg = { ...base, mode };
    const label = FOLD_MODES[mode];
    let orth = 0, jac = 0, equiv = 0, det = 0, moved = 0;

    for (let i = 0; i < 300; i++) {
      const q = [
        (mulberry32(i + 1)() * 2 - 1) * 1.6,
        (mulberry32(i + 55)() * 2 - 1) * 1.6,
        (mulberry32(i + 900)() * 2 - 1) * 1.6,
      ];
      const { p, M: A } = doFold(cfg, q);
      if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) { moved = NaN; break; }
      moved = Math.max(moved, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));

      // The accumulated Jacobian must be orthogonal, or the velocity pullback
      // shears the streamlines instead of folding them.
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          let d = 0;
          for (let k = 0; k < 3; k++) d += A[r * 3 + k] * A[c * 3 + k];
          orth = Math.max(orth, Math.abs(d - (r === c ? 1 : 0)));
        }
      }
      const d3 = A[0] * (A[4] * A[8] - A[5] * A[7])
        - A[1] * (A[3] * A[8] - A[5] * A[6])
        + A[2] * (A[3] * A[7] - A[4] * A[6]);
      det = Math.max(det, Math.abs(Math.abs(d3) - 1));

      // Continuity: a fold that tore would show an unbounded local Jacobian.
      const e = 1e-6;
      const { p: p2 } = doFold(cfg, [q[0] + e, q[1], q[2]]);
      jac = Math.max(jac, Math.hypot(p2[0] - p[0], p2[1] - p[1], p2[2] - p[2]) / e);

      // Equivariance, the property the whole thing rests on: stepping the world
      // point along M^T u must move the folded point along u. If this holds, a
      // streamline traced in world space is exactly the preimage of a
      // streamline of the unfolded field.
      const u = [0.3, -0.5, 0.81], ul = Math.hypot(u[0], u[1], u[2]);
      const w = [
        A[0] * u[0] + A[3] * u[1] + A[6] * u[2],
        A[1] * u[0] + A[4] * u[1] + A[7] * u[2],
        A[2] * u[0] + A[5] * u[1] + A[8] * u[2],
      ];
      const h = 1e-7;
      const { p: p3 } = doFold(cfg, [q[0] + h * w[0], q[1] + h * w[1], q[2] + h * w[2]]);
      const dx = p3[0] - p[0], dy = p3[1] - p[1], dz = p3[2] - p[2];
      const dl = Math.hypot(dx, dy, dz);
      if (dl > 1e-14) equiv = Math.max(equiv, 1 - (dx * u[0] + dy * u[1] + dz * u[2]) / (dl * ul));
    }

    ok(`${label}: stays finite`, isFinite(moved) && moved > 1e-6, `max displacement ${moved}`);
    ok(`${label}: Jacobian is orthogonal`, orth < 1e-9, `worst ${orth.toExponential(2)}`);
    ok(`${label}: determinant is +/-1`, det < 1e-9, `worst ${det.toExponential(2)}`);
    ok(`${label}: fold is continuous`, jac < 1e5, `local Jacobian ${jac.toExponential(2)}`);
    ok(`${label}: velocity pullback is exact`, equiv < 1e-6, `worst 1-cos ${equiv.toExponential(2)}`);
  }

  // Mode 0 must be a no-op, matrix included.
  {
    const { p, M: A } = doFold({ ...base, mode: 0 }, [0.3, -0.7, 1.1]);
    ok('fold "None" leaves the point alone', p[0] === 0.3 && p[1] === -0.7 && p[2] === 1.1);
    ok('fold "None" leaves the matrix at identity', A[0] === 1 && A[4] === 1 && A[8] === 1 && A[1] === 0);
  }

  // Determinism: the same point must fold the same way every time, or the
  // tracer would get a different field on the second pass of a curve.
  {
    const cfg = { ...base, mode: 1 };
    const a = doFold(cfg, [0.4, 0.2, -0.9]);
    const b = doFold(cfg, [0.4, 0.2, -0.9]);
    ok('folding is deterministic', a.p.every((v, i) => v === b.p[i]) && a.M.every((v, i) => v === b.M[i]));
  }

  // Step compensation
  ok('step scale is 1 when folding is off', foldStepScale({ mode: 0, scale: 2, iterations: 6 }) === 1);
  ok('step scale grows with iterations',
    foldStepScale({ mode: 1, scale: 1.5, iterations: 3 }) > foldStepScale({ mode: 1, scale: 1.5, iterations: 2 }));
  ok('step scale is capped', foldStepScale({ mode: 1, scale: 3, iterations: 12 }) <= 16);
  ok('step scale ignores a shrinking fold', foldStepScale({ mode: 1, scale: 0.8, iterations: 5 }) === 1);

  // Octave rotations must be genuine rotations, or the summed field would be
  // sheared rather than rotated and the divergence-free property would go.
  {
    const rots = octaveRotations(4, 41);
    let worst = 0;
    for (const R of rots) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          let d = 0;
          for (let k = 0; k < 3; k++) d += R[r * 3 + k] * R[c * 3 + k];
          worst = Math.max(worst, Math.abs(d - (r === c ? 1 : 0)));
        }
      }
    }
    ok('octave rotations are orthogonal', worst < 1e-12, `worst ${worst.toExponential(2)}`);
    ok('the first octave is unrotated', rots[0][0] === 1 && rots[0][4] === 1 && rots[0][8] === 1);
  }

  // One octave must reproduce the plain field exactly.
  {
    const st = defaultState();
    const cfgFor = (fractal) => ({
      fieldA: st.field.fieldA, paramsA: st.field.paramsA, fieldB: st.field.fieldB, paramsB: st.field.paramsB,
      blend: 0, blendMode: 0, symmetry: 0, fractal, warp: 0, warpScale: 1.2, swirl: 0, drift: 0, domain: st.field.domain,
    });
    const plain = makeEvaluator(cfgFor({ mode: 0, octaves: 1 }), { noise: new Noise(1337), noiseB: new Noise(7), time: 0 });
    const one = makeEvaluator(cfgFor({ mode: 0, octaves: 1, lacunarity: 2, gain: 0.5, octaveSpin: 37 }),
      { noise: new Noise(1337), noiseB: new Noise(7), time: 0 });
    const a = [0, 0, 0], b = [0, 0, 0];
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const x = (mulberry32(i + 3)() * 2 - 1), y = (mulberry32(i + 33)() * 2 - 1), z = (mulberry32(i + 333)() * 2 - 1);
      plain(x, y, z, a); one(x, y, z, b);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    ok('one octave is the plain field', worst < 1e-12, `worst ${worst.toExponential(2)}`);
  }

  // The summed field must stay divergence free when the base field is. This is
  // the whole reason each octave is a rotated pullback rather than a plain
  // rotation of the output: div(a R^T f(b R p)) = ab * (div f)(bRp).
  //
  // ABC flow is used rather than curl noise because its divergence is
  // analytically zero, so anything left over is the summation's fault. Curl
  // noise carries its own small finite-difference residual, and the higher
  // octaves would amplify that by the square of their frequency and drown the
  // property being tested.
  {
    const st = defaultState();
    const ev = makeEvaluator({
      fieldA: 'abc', paramsA: defaultParams(FIELD_BY_ID.abc), fieldB: 'shear', paramsB: defaultParams(FIELD_BY_ID.shear),
      blend: 0, blendMode: 0, symmetry: 0,
      fractal: { mode: 0, octaves: 4, lacunarity: 2, gain: 0.5, octaveSpin: 41 },
      warp: 0, warpScale: 1.2, swirl: 0, drift: 0, domain: st.field.domain,
    }, { noise: new Noise(1337), noiseB: new Noise(7), time: 0 });
    const o1 = [0, 0, 0], o2 = [0, 0, 0], o3 = [0, 0, 0];
    let meanDiv = 0, meanMag = 0, n = 0;
    const k = 0.01;
    for (let i = 0; i < 200; i++) {
      const q = [
        (mulberry32(i + 5)() * 2 - 1) * 1.2,
        (mulberry32(i + 50)() * 2 - 1) * 1.2,
        (mulberry32(i + 500)() * 2 - 1) * 1.2,
      ];
      let div = 0;
      for (let d = 0; d < 3; d++) {
        const a = q.slice(), b = q.slice();
        a[d] += k; b[d] -= k;
        ev(a[0], a[1], a[2], o1); ev(b[0], b[1], b[2], o2);
        div += (o1[d] - o2[d]) / (2 * k);
      }
      ev(q[0], q[1], q[2], o3);
      meanMag += Math.hypot(o3[0], o3[1], o3[2]);
      meanDiv += Math.abs(div);
      n++;
    }
    meanDiv /= n; meanMag /= n;
    ok('summed octaves stay divergence free', meanDiv < 0.01 * meanMag,
      `mean |div| ${meanDiv.toFixed(4)} vs mean |v| ${meanMag.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------- integrator
section('integrator');
{
  // Rigid rotation: unit-speed integration must trace a perfect circle.
  const R = 1.0;
  const rot = (x, y, z, out) => { out[0] = -y; out[1] = x; out[2] = 0; return out; };
  // Curves are stored as float32, so accuracy below ~1e-7 is unmeasurable here.
  // Order is checked separately, at steps coarse enough for truncation error to
  // dominate that floor.
  const errors = [];
  for (const stepFrac of [0.02, 0.01]) {
    const cfg = {
      seedMode: 0, seedCount: 1, maxCurves: 1, domain: 1, seedRadiusFrac: 1, stepFrac,
      maxSteps: Math.round((Math.PI * 2) / stepFrac) + 1, minSteps: 2, bidirectional: false,
      boundsFrac: 4, minSpeed: 1e-9, integrator: 0, even: false, dSepFrac: 0.1, dTestRatio: 0.5,
      seed: 1, jitter: 0,
    };
    const tr = new Tracer(cfg, rot);
    tr.queue = [[R, 0, 0]];
    tr.qi = 0;
    const curves = tr.runAll();
    ok('rotation traced', curves.length === 1 && curves[0].n > 10);
    const c = curves[0];
    let maxRadiusError = 0;
    for (let i = 0; i < c.n; i++) {
      maxRadiusError = Math.max(maxRadiusError, Math.abs(Math.hypot(c.pts[i * 3], c.pts[i * 3 + 1]) - R));
    }
    errors.push(maxRadiusError);
    ok(`RK4 stays on the circle at h=${stepFrac}`, maxRadiusError < 1e-6, `error ${maxRadiusError.toExponential(2)}`);
    ok('z never drifts', Math.abs(c.pts[(c.n - 1) * 3 + 2]) < 1e-12);
    // arclength parameterisation: consecutive samples are h apart
    let worstSpacing = 0;
    for (let i = 1; i < c.n; i++) {
      const d = Math.hypot(c.pts[i * 3] - c.pts[(i - 1) * 3], c.pts[i * 3 + 1] - c.pts[(i - 1) * 3 + 1]);
      worstSpacing = Math.max(worstSpacing, Math.abs(d - stepFrac));
    }
    ok(`samples are evenly spaced at h=${stepFrac}`, worstSpacing < stepFrac * 1e-3, `worst ${worstSpacing.toExponential(2)}`);
  }
  ok('fine steps stay at the float32 floor', errors.every((e) => e < 1e-6),
    errors.map((e) => e.toExponential(2)).join(' / '));

  const coarse = [];
  for (const stepFrac of [0.4, 0.2, 0.1]) {
    const cfg = {
      seedMode: 0, seedCount: 1, maxCurves: 1, domain: 1, seedRadiusFrac: 1, stepFrac,
      maxSteps: Math.round((Math.PI * 2) / stepFrac) + 1, minSteps: 2, bidirectional: false,
      boundsFrac: 4, minSpeed: 1e-9, integrator: 0, even: false, dSepFrac: 0.1, dTestRatio: 0.5,
      seed: 1, jitter: 0,
    };
    const tr = new Tracer(cfg, rot);
    tr.queue = [[R, 0, 0]]; tr.qi = 0;
    const c = tr.runAll()[0];
    let e = 0;
    for (let i = 0; i < c.n; i++) e = Math.max(e, Math.abs(Math.hypot(c.pts[i * 3], c.pts[i * 3 + 1]) - R));
    coarse.push(e);
  }
  const r1 = coarse[0] / coarse[1], r2 = coarse[1] / coarse[2];
  ok('RK4 converges at fourth order', r1 > 8 && r2 > 8,
    `error ${coarse.map((e) => e.toExponential(2)).join(' -> ')} (ratios ${r1.toFixed(1)}, ${r2.toFixed(1)})`);

  // Euler must be visibly worse than RK4 at the same step
  const eulerCfg = {
    seedMode: 0, seedCount: 1, maxCurves: 1, domain: 1, seedRadiusFrac: 1, stepFrac: 0.2,
    maxSteps: Math.round((Math.PI * 2) / 0.2) + 1, minSteps: 2, bidirectional: false,
    boundsFrac: 4, minSpeed: 1e-9, integrator: 1, even: false, dSepFrac: 0.1, dTestRatio: 0.5,
    seed: 1, jitter: 0,
  };
  const te = new Tracer(eulerCfg, rot);
  te.queue = [[R, 0, 0]]; te.qi = 0;
  const ce = te.runAll()[0];
  let ee = 0;
  for (let i = 0; i < ce.n; i++) ee = Math.max(ee, Math.abs(Math.hypot(ce.pts[i * 3], ce.pts[i * 3 + 1]) - R));
  ok('Euler is looser than RK4', ee > coarse[1] * 10, `Euler ${ee.toExponential(2)} vs RK4 ${coarse[1].toExponential(2)}`);

  // escape radius must terminate
  const outward = (x, y, z, out) => { out[0] = x || 1; out[1] = y; out[2] = z; return out; };
  const cfg2 = {
    seedMode: 0, seedCount: 4, maxCurves: 4, domain: 1, seedRadiusFrac: 0.1, stepFrac: 0.02,
    maxSteps: 5000, minSteps: 2, bidirectional: false, boundsFrac: 2, minSpeed: 1e-12,
    integrator: 0, even: false, dSepFrac: 0.1, dTestRatio: 0.5, seed: 9, jitter: 0,
  };
  const tr2 = new Tracer(cfg2, outward);
  const cs2 = tr2.runAll();
  let maxR = 0;
  for (const c of cs2) for (let i = 0; i < c.n; i++) maxR = Math.max(maxR, Math.hypot(c.pts[i * 3], c.pts[i * 3 + 1], c.pts[i * 3 + 2]));
  ok('escape radius stops the trace', maxR <= 2 + 0.05 && cs2.every((c) => c.n < 5000), `max radius ${maxR.toFixed(3)}`);

  // seeding modes all produce points inside the requested radius
  for (let m = 0; m < SEED_MODES.length; m++) {
    const seeds = makeSeeds(m, 200, 1, 5, 0.1);
    ok(`seed mode "${SEED_MODES[m]}" produces points`, seeds.length > 0);
    ok(`seed mode "${SEED_MODES[m]}" stays bounded`, seeds.every((s) => s.every(isFinite) && Math.hypot(...s) < 2.2));
  }

  // even spacing: no two curves should come closer than the stop distance
  const noise = new Noise(3);
  const ev = makeEvaluator({
    fieldA: 'curl', paramsA: defaultParams(FIELD_BY_ID.curl), fieldB: 'curl',
    paramsB: defaultParams(FIELD_BY_ID.curl), blend: 0, blendMode: 0, symmetry: 0,
    warp: 0, warpScale: 1, swirl: 0, drift: 0, domain: 1.6,
  }, { noise, noiseB: noise, time: 0 });
  const dSepFrac = 0.08, domain = 1.6;
  const cfg3 = {
    seedMode: 0, seedCount: 200, maxCurves: 120, domain, seedRadiusFrac: 0.9, stepFrac: 0.012,
    maxSteps: 260, minSteps: 10, bidirectional: true, boundsFrac: 2.4, minSpeed: 1e-6,
    integrator: 0, even: true, dSepFrac, dTestRatio: 0.55, seed: 42, jitter: 0.2,
  };
  const tr3 = new Tracer(cfg3, ev);
  const curves3 = tr3.runAll();
  ok('even spacing produced curves', curves3.length > 5, `${curves3.length} curves`);

  const dTest = domain * dSepFrac * 0.55;
  let violations = 0, checks = 0;
  const sample = curves3.slice(0, 40);
  for (let a = 0; a < sample.length; a++) {
    for (let b = a + 1; b < sample.length; b++) {
      const ca = sample[a], cb = sample[b];
      for (let i = 0; i < ca.n; i += 3) {
        for (let j = 0; j < cb.n; j += 3) {
          const d = Math.hypot(ca.pts[i * 3] - cb.pts[j * 3], ca.pts[i * 3 + 1] - cb.pts[j * 3 + 1], ca.pts[i * 3 + 2] - cb.pts[j * 3 + 2]);
          checks++;
          if (d < dTest * 0.5) violations++;
        }
      }
    }
  }
  ok('even spacing keeps curves apart', violations / checks < 0.002,
    `${violations} close pairs of ${checks} (${((violations / checks) * 100).toFixed(3)}%)`);
}

// ---------------------------------------------------------------- spatial hash
section('spatial hash');
{
  const rnd = mulberry32(17);
  const h = new SpatialHash(0.1);
  const pts = [];
  for (let i = 0; i < 3000; i++) {
    const p = [(rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2];
    pts.push(p);
    h.insert(p[0], p[1], p[2], i, 0);
  }
  let mismatches = 0;
  for (let q = 0; q < 400; q++) {
    const p = [(rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2, (rnd() * 2 - 1) * 2];
    const d = 0.05 + rnd() * 0.25;
    const brute = pts.some((o) => Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) < d);
    if (brute !== h.hasWithin(p[0], p[1], p[2], d)) mismatches++;
  }
  ok('hash queries match brute force', mismatches === 0, `${mismatches} mismatches`);
  ok('hash exclusion window works',
    h.hasWithin(pts[0][0], pts[0][1], pts[0][2], 0.01, 0, 0, 0) === false);
}

// ---------------------------------------------------------------- geometry
section('geometry');
{
  // frames on a helix
  const n = 400;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 6;
    pts[i * 3] = Math.cos(t); pts[i * 3 + 1] = Math.sin(t); pts[i * 3 + 2] = t * 0.12;
  }
  const tan = tangents(pts, n);
  const nor = rmfNormals(pts, tan, n);
  let worstDot = 0, worstLen = 0, worstTan = 0;
  for (let i = 0; i < n; i++) {
    const d = tan[i * 3] * nor[i * 3] + tan[i * 3 + 1] * nor[i * 3 + 1] + tan[i * 3 + 2] * nor[i * 3 + 2];
    worstDot = Math.max(worstDot, Math.abs(d));
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]) - 1));
    worstTan = Math.max(worstTan, Math.abs(Math.hypot(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]) - 1));
  }
  ok('tangents are unit length', worstTan < 1e-6, `worst ${worstTan.toExponential(2)}`);
  ok('frame normal stays perpendicular', worstDot < 1e-6, `worst dot ${worstDot.toExponential(2)}`);
  ok('frame normal stays unit length', worstLen < 1e-6, `worst ${worstLen.toExponential(2)}`);

  // an RMF on a straight line must not rotate at all
  const m = 200;
  const line = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) { line[i * 3] = i * 0.01; line[i * 3 + 1] = 0; line[i * 3 + 2] = 0; }
  const lt = tangents(line, m);
  const ln = rmfNormals(line, lt, m);
  let drift = 0;
  for (let i = 1; i < m; i++) {
    drift = Math.max(drift, Math.hypot(ln[i * 3] - ln[0], ln[i * 3 + 1] - ln[1], ln[i * 3 + 2] - ln[2]));
  }
  ok('RMF does not twist on a straight line', drift < 1e-6, `drift ${drift.toExponential(2)}`);

  // smoothing keeps the endpoints and shortens the curve
  const noisy = new Float32Array(n * 3);
  const rnd = mulberry32(8);
  for (let i = 0; i < n * 3; i++) noisy[i] = pts[i] + (rnd() * 2 - 1) * 0.02;
  const sm = smoothCurve(noisy, n, 3, 0.5);
  near('smoothing pins the first point', sm[0], noisy[0], 1e-9);
  near('smoothing pins the last point', sm[(n - 1) * 3], noisy[(n - 1) * 3], 1e-9);
  const lenOf = (a) => { let L = 0; for (let i = 1; i < n; i++) L += Math.hypot(a[i * 3] - a[(i - 1) * 3], a[i * 3 + 1] - a[(i - 1) * 3 + 1], a[i * 3 + 2] - a[(i - 1) * 3 + 2]); return L; };
  ok('smoothing shortens a noisy curve', lenOf(sm) < lenOf(noisy));

  // fit + mesh
  const curves = [];
  for (let c = 0; c < 30; c++) {
    const cn = 120;
    const p = new Float32Array(cn * 3);
    const sp = new Float32Array(cn);
    for (let i = 0; i < cn; i++) {
      const t = i * 0.05 + c;
      p[i * 3] = Math.cos(t) * (2 + c * 0.1);
      p[i * 3 + 1] = Math.sin(t) * (2 + c * 0.1);
      p[i * 3 + 2] = t * 0.1 - 3;
      sp[i] = 1 + 0.5 * Math.sin(t);
    }
    curves.push({ pts: p, speed: sp, n: cn, rnd: c / 30, id: c });
  }
  const fit = fitTransform(curves);
  ok('fit produces a finite transform', fit.scale > 0 && fit.center.every(isFinite));

  const gradient = Gradient.fromPreset('Ember');
  for (let geomMode = 0; geomMode < 3; geomMode++) {
    for (let colorMode = 0; colorMode < 9; colorMode++) {
      const opts = {
        h: 0.05, width: 0.02, widthMode: colorMode % 7, widthAmount: 0.5, taperPower: 0.5,
        twist: 0.7, twistNoise: 0.2, sides: 6, aspect: 0.4, smoothIters: 1, smoothStrength: 0.5,
        colorMode, colorCycles: 2, colorReverse: false, geomMode,
      };
      const prep = prepareCurves(curves, opts, gradient);
      const chunks = buildMesh(prep, opts);
      let inRange = true, colorsOk = true, normalsOk = true;
      for (const ch of chunks) {
        if (ch.vertexCount > 65535) inRange = false;
        for (let i = 0; i < ch.indices.length; i++) if (ch.indices[i] >= ch.vertexCount) inRange = false;
        for (let i = 0; i < ch.colors.length; i++) if (!(ch.colors[i] >= 0 && ch.colors[i] <= 1)) colorsOk = false;
        for (let i = 0; i < ch.normals.length; i += 3) {
          const l = Math.hypot(ch.normals[i], ch.normals[i + 1], ch.normals[i + 2]);
          if (!(l > 0.5 && l < 1.5)) normalsOk = false;
        }
      }
      ok(`mesh mode ${geomMode} colour ${colorMode}: indices in range`, inRange);
      ok(`mesh mode ${geomMode} colour ${colorMode}: colours in [0,1]`, colorsOk);
      ok(`mesh mode ${geomMode} colour ${colorMode}: normals are unit`, normalsOk);
      const expected = geomMode === 0 ? 2 : geomMode === 1 ? 6 : 1;
      const totalVerts = chunks.reduce((s, c) => s + c.vertexCount, 0);
      ok(`mesh mode ${geomMode}: vertex count matches form`, totalVerts === prep.totalSamples * expected,
        `${totalVerts} vs ${prep.totalSamples * expected}`);
    }
  }

  // chunking must split before the 16-bit limit
  const big = [];
  for (let c = 0; c < 400; c++) {
    const cn = 300;
    const p = new Float32Array(cn * 3), sp = new Float32Array(cn).fill(1);
    for (let i = 0; i < cn; i++) { p[i * 3] = i * 0.01; p[i * 3 + 1] = c * 0.01; p[i * 3 + 2] = Math.sin(i * 0.1); }
    big.push({ pts: p, speed: sp, n: cn, rnd: 0.5, id: c });
  }
  const bigOpts = {
    h: 0.01, width: 0.01, widthMode: 0, widthAmount: 0, taperPower: 1, twist: 0, twistNoise: 0,
    sides: 12, aspect: 1, smoothIters: 0, smoothStrength: 0, colorMode: 0, colorCycles: 1,
    colorReverse: false, geomMode: 1,
  };
  const bigPrep = prepareCurves(big, bigOpts, gradient);
  const bigChunks = buildMesh(bigPrep, bigOpts);
  ok('large meshes split into chunks', bigChunks.length > 1, `${bigChunks.length} chunks`);
  ok('every chunk fits 16-bit indices', bigChunks.every((c) => c.vertexCount <= 65535));
}

// ---------------------------------------------------------------- palette
section('palette');
{
  ok('hex round-trips', rgbToHex(hexToRgb('#3a7fd5')) === '#3a7fd5');
  ok('short hex expands', Math.abs(hexToRgb('#fff')[0] - 1) < 1e-9);
  const g = Gradient.fromPreset('Cyanotype');
  const a = g.sample(0), b = g.sample(1);
  ok('gradient endpoints match the preset', rgbToHex(a) === GRADIENT_PRESETS.Cyanotype[0].toLowerCase()
    && rgbToHex(b) === GRADIENT_PRESETS.Cyanotype[4].toLowerCase(), `${rgbToHex(a)} / ${rgbToHex(b)}`);
  let monotone = true;
  for (let i = 0; i <= 100; i++) {
    const c = g.sample(i / 100);
    if (!c.every((v) => v >= 0 && v <= 1)) monotone = false;
  }
  ok('gradient stays in gamut', monotone);
  ok('clamps outside 0..1', rgbToHex(g.sample(-5)) === rgbToHex(g.sample(0)));
  const g2 = new Gradient(g.toJSON());
  ok('gradient serialises and reloads', rgbToHex(g2.sample(0.37)) === rgbToHex(g.sample(0.37)));
  const g3 = Gradient.fromPreset('Ember');
  const before = g3.stops.length;
  g3.addStop(0.5, [0, 0, 0]);
  ok('adding a stop works', g3.stops.length === before + 1);
  g3.removeStop(0);
  ok('removing a stop works', g3.stops.length === before);
  const tiny = new Gradient([{ t: 0, color: '#000' }, { t: 1, color: '#fff' }]);
  tiny.removeStop(0); tiny.removeStop(0);
  ok('a gradient keeps at least two stops', tiny.stops.length === 2);
}

// ---------------------------------------------------------------- state and presets
section('state and presets');
{
  const s = defaultState();
  ok('default state has every block', ['field', 'trace', 'geom', 'color', 'look', 'camera'].every((k) => s[k]));
  ok('default field exists', !!FIELD_BY_ID[s.field.fieldA]);

  for (const p of PRESETS) {
    const st = reconcileFieldParams(mergeState(defaultState(), p.patch));
    ok(`preset "${p.name}": field A exists`, !!FIELD_BY_ID[st.field.fieldA], st.field.fieldA);
    ok(`preset "${p.name}": field B exists`, !!FIELD_BY_ID[st.field.fieldB], st.field.fieldB);
    const f = FIELD_BY_ID[st.field.fieldA];
    const known = new Set(f.params.map((x) => x.id));
    const patched = Object.keys((p.patch.field && p.patch.field.paramsA) || {});
    ok(`preset "${p.name}": only sets real parameters`, patched.every((k) => known.has(k)),
      patched.filter((k) => !known.has(k)).join(', '));
    ok(`preset "${p.name}": parameters within range`,
      f.params.every((x) => x.choice || (st.field.paramsA[x.id] >= x.min && st.field.paramsA[x.id] <= x.max)));
    ok(`preset "${p.name}": gradient parses`, new Gradient(st.color.gradient).stops.length >= 2);
    ok(`preset "${p.name}": colour mode is valid`, st.color.colorMode >= 0 && st.color.colorMode < 9);
    ok(`preset "${p.name}": geometry mode is valid`, st.geom.geomMode >= 0 && st.geom.geomMode < 3);
  }

  // switching fields must not leave stale parameters behind
  const st = defaultState();
  st.field.fieldA = 'lorenz';
  reconcileFieldParams(st);
  ok('field switch rebuilds parameters', 'sigma' in st.field.paramsA && !('scale' in st.field.paramsA));

  // round trip through JSON
  const json = JSON.parse(JSON.stringify(defaultState()));
  const back = mergeState(defaultState(), json);
  ok('state survives a JSON round trip', JSON.stringify(back) === JSON.stringify(defaultState()));
}

// ---------------------------------------------------------------- panel schema
section('panel schema');
{
  const st = defaultState();
  let bad = [];
  for (const sec of SCHEMA) {
    for (const c of sec.controls) {
      if (!c.path) continue;
      const v = getPath(st, c.path);
      if (v === undefined) bad.push(c.path);
      if (c.type === 'slider' && typeof v === 'number' && (v < c.min || v > c.max)) {
        bad.push(`${c.path} default ${v} outside [${c.min}, ${c.max}]`);
      }
      if (c.type === 'select' && typeof v === 'number' && (v < 0 || v >= c.options.length)) {
        bad.push(`${c.path} index ${v} outside options`);
      }
    }
  }
  ok('every control binds to a real state value in range', bad.length === 0, bad.join('; '));

  setPath(st, 'look.lightDir.1', 0.25);
  near('setPath writes into arrays', st.look.lightDir[1], 0.25, 1e-12);
}

// ---------------------------------------------------------------- exporters
section('exporters');
{
  const curves = [];
  for (let c = 0; c < 6; c++) {
    const cn = 60;
    const p = new Float32Array(cn * 3), sp = new Float32Array(cn).fill(1);
    for (let i = 0; i < cn; i++) {
      p[i * 3] = Math.cos(i * 0.1 + c); p[i * 3 + 1] = Math.sin(i * 0.1 + c); p[i * 3 + 2] = i * 0.02 - 0.6;
    }
    curves.push({ pts: p, speed: sp, n: cn, rnd: c / 6, id: c });
  }
  const opts = {
    h: 0.02, width: 0.02, widthMode: 1, widthAmount: 0.5, taperPower: 0.5, twist: 0.5,
    twistNoise: 0, sides: 6, aspect: 0.4, smoothIters: 0, smoothStrength: 0.5,
    colorMode: 1, colorCycles: 1, colorReverse: false, geomMode: 0,
  };
  const prep = prepareCurves(curves, opts, Gradient.fromPreset('Peacock'));
  const chunks = buildMesh(prep, opts);

  const obj = chunksToOBJ(chunks);
  const vCount = (obj.match(/^v /gm) || []).length;
  const fLines = obj.match(/^f .*/gm) || [];
  ok('OBJ writes vertices', vCount === chunks.reduce((s, c) => s + c.vertexCount, 0));
  ok('OBJ writes faces', fLines.length > 0);
  let objIndicesOk = true;
  for (const l of fLines) {
    for (const tok of l.slice(2).trim().split(/\s+/)) {
      const i = parseInt(tok.split('//')[0], 10);
      if (!(i >= 1 && i <= vCount)) objIndicesOk = false;
    }
  }
  ok('OBJ indices are 1-based and in range', objIndicesOk);
  ok('OBJ has no NaN', !/NaN/.test(obj));

  const proj = VM.mat4Perspective(Math.PI / 4, 1.6, 0.01, 60);
  const view = VM.mat4LookAt([2, 1.5, 2.6], [0, 0, 0], [0, 1, 0]);
  const mvp = VM.mat4Multiply(proj, view);
  const svg = preparedToSVG(prep, {
    width: 900, height: 560, mvp, fovScale: 1 / Math.tan(Math.PI / 8), strokeScale: 280,
    strokeMul: 1, perspectiveWidth: true, depthFade: 0.5, nearW: 1, farW: 5,
    quantise: 6, background: '#101018',
  });
  ok('SVG has a root element', svg.includes('<svg') && svg.trim().endsWith('</svg>'));
  ok('SVG contains paths', (svg.match(/<path /g) || []).length > 0);
  ok('SVG has no NaN', !/NaN|Infinity/.test(svg));
  ok('SVG groups paths into colour layers', (svg.match(/<g /g) || []).length > 0);
  const opens = (svg.match(/<g /g) || []).length, closes = (svg.match(/<\/g>/g) || []).length;
  ok('SVG groups are balanced', opens === closes, `${opens} open, ${closes} close`);

  // a camera looking away should drop everything rather than emit garbage
  const behind = VM.mat4Multiply(proj, VM.mat4LookAt([0, 0, 3], [0, 0, 9], [0, 1, 0]));
  const svg2 = preparedToSVG(prep, {
    width: 200, height: 200, mvp: behind, fovScale: 2, strokeScale: 100, strokeMul: 1,
    perspectiveWidth: true, depthFade: 0, nearW: 1, farW: 5, quantise: 0, background: null,
  });
  ok('SVG handles geometry behind the camera', !/NaN/.test(svg2) && (svg2.match(/<path /g) || []).length === 0);
}

// ---------------------------------------------------------------- end to end
section('presets end to end');
{
  // Run each preset through the real pipeline at a reduced budget. This is what
  // catches a preset whose escape radius, minimum length or step size quietly
  // produces an empty screen.
  for (const p of PRESETS) {
    const st = reconcileFieldParams(mergeState(defaultState(), p.patch));
    const noise = new Noise(st.field.noiseSeed | 0);
    const ev = makeEvaluator({
      fieldA: st.field.fieldA, paramsA: st.field.paramsA,
      fieldB: st.field.fieldB, paramsB: st.field.paramsB,
      blend: st.field.blend, blendMode: st.field.blendMode, symmetry: st.field.symmetry,
      fractal: st.field.fractal,
      warp: st.field.warp, warpScale: st.field.warpScale, swirl: st.field.swirl,
      drift: st.field.drift, domain: st.field.domain,
    }, { noise, noiseB: new Noise(7), time: st.field.time });

    const cfg = {
      ...st.trace, domain: st.field.domain,
      stepFrac: st.trace.stepFrac / foldStepScale(st.field.fractal),
      maxCurves: Math.min(st.trace.maxCurves, 60),
      seedCount: Math.min(st.trace.seedCount, 120),
      maxSteps: Math.min(st.trace.maxSteps, 240),
    };
    const t0 = Date.now();
    const curves = new Tracer(cfg, ev).runAll();
    const traceMs = Date.now() - t0;

    ok(`preset "${p.name}": traces curves`, curves.length >= 5, `${curves.length} curves`);
    if (!curves.length) continue;
    const meanLen = curves.reduce((s, c) => s + c.n, 0) / curves.length;
    ok(`preset "${p.name}": curves have length`, meanLen > 12, `mean ${meanLen.toFixed(1)} samples`);
    ok(`preset "${p.name}": samples are finite`,
      curves.every((c) => {
        for (let i = 0; i < c.n * 3; i++) if (!isFinite(c.pts[i])) return false;
        return true;
      }));

    const opts = {
      h: st.field.domain * st.trace.stepFrac, ...st.geom,
      colorMode: st.color.colorMode, colorCycles: st.color.colorCycles, colorReverse: st.color.colorReverse,
    };
    const prep = prepareCurves(curves, opts, new Gradient(st.color.gradient));
    const chunks = buildMesh(prep, st.geom);
    ok(`preset "${p.name}": builds a mesh`, chunks.length > 0 && chunks[0].indexCount > 0);
    let bounded = true;
    for (const ch of chunks) {
      for (let i = 0; i < ch.positions.length; i++) {
        if (!isFinite(ch.positions[i]) || Math.abs(ch.positions[i]) > 3) bounded = false;
      }
    }
    ok(`preset "${p.name}": mesh fits the unit ball`, bounded);
    console.log(`  ${p.name.padEnd(18)} ${String(curves.length).padStart(4)} curves`
      + ` · ${String(prep.totalSamples).padStart(6)} samples · ${String(traceMs).padStart(5)} ms (at 1/15 budget)`);
  }
}

// ---------------------------------------------------------------- report
console.log('');
if (fail) {
  console.log(`\x1b[31m${fail} failed\x1b[0m, ${pass} passed`);
  for (const f of failures) console.log(`  \u2717 ${f}`);
  process.exit(1);
} else {
  console.log(`\x1b[32mall ${pass} checks passed\x1b[0m`);
}
