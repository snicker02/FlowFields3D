// geometry.js — turns traced streamlines into renderable geometry.
//
// Two stages. prepareCurves() does everything independent of how a curve is
// drawn: normalise into a unit ball, smooth, build frames, evaluate colour and
// width per sample. buildMesh() extrudes that into GL buffers, and the SVG
// exporter walks the same prepared data, so vector output and shaded view can
// never disagree about colour or thickness.
//
// Frames come from the double-reflection rotation-minimising frame (Wang,
// Jüttler, Zheng & Liu 2008). A Frenet frame flips its normal at every
// inflection point, which snaps a ribbon through 180 degrees; an RMF has no
// torsion of its own, so any twist you see is twist you asked for.

import { Noise } from './noise.js';

export const GEOM_MODES = ['Ribbon', 'Tube', 'Line', 'Box'];
export const WIDTH_MODES = ['Constant', 'Taper', 'By speed', 'By curvature', 'Random per curve', 'Ramp', 'Noise', 'By image'];
export const COLOR_MODES = ['Along curve', 'Curve index', 'Speed', 'Curvature', 'Height (Y)', 'Depth (Z)',
  'Radius', 'Direction', 'Random per curve', 'Image luminance'];

const MAX_VERTS = 60000;               // stays inside the WebGL1 16-bit index limit
const auxNoise = new Noise(9173);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : (isFinite(v) ? v : 0));

/** Moving-average smoothing; endpoints are pinned. */
export function smoothCurve(pts, n, iterations, strength) {
  const src = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) src[i] = pts[i];
  if (iterations <= 0 || n < 3) return src;
  const dst = new Float32Array(n * 3);
  for (let it = 0; it < iterations; it++) {
    dst.set(src);
    for (let i = 1; i < n - 1; i++) {
      for (let d = 0; d < 3; d++) {
        const avg = (src[(i - 1) * 3 + d] + src[(i + 1) * 3 + d]) * 0.5;
        dst[i * 3 + d] = src[i * 3 + d] + (avg - src[i * 3 + d]) * strength;
      }
    }
    src.set(dst);
  }
  return src;
}

/** Tangents by central difference, normalised. */
export function tangents(pts, n, out = new Float32Array(n * 3)) {
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = pts[b * 3] - pts[a * 3], ty = pts[b * 3 + 1] - pts[a * 3 + 1], tz = pts[b * 3 + 2] - pts[a * 3 + 2];
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-12) { tx = 0; ty = 0; tz = 1; l = 1; }
    out[i * 3] = tx / l; out[i * 3 + 1] = ty / l; out[i * 3 + 2] = tz / l;
  }
  return out;
}

/** Rotation-minimising frame: the normal vector at each sample. */
export function rmfNormals(pts, tan, n, seedAngle = 0, out = new Float32Array(n * 3)) {
  const t0x = tan[0], t0y = tan[1], t0z = tan[2];
  let ux, uy, uz;
  const ax = Math.abs(t0x), ay = Math.abs(t0y), az = Math.abs(t0z);
  if (ax <= ay && ax <= az) { ux = 0; uy = -t0z; uz = t0y; }
  else if (ay <= az) { ux = -t0z; uy = 0; uz = t0x; }
  else { ux = -t0y; uy = t0x; uz = 0; }
  const l0 = Math.hypot(ux, uy, uz) || 1; ux /= l0; uy /= l0; uz /= l0;
  if (seedAngle) {
    const wx = t0y * uz - t0z * uy, wy = t0z * ux - t0x * uz, wz = t0x * uy - t0y * ux;
    const c = Math.cos(seedAngle), s = Math.sin(seedAngle);
    const nx = ux * c + wx * s, ny = uy * c + wy * s, nz = uz * c + wz * s;
    ux = nx; uy = ny; uz = nz;
  }
  out[0] = ux; out[1] = uy; out[2] = uz;

  for (let i = 0; i < n - 1; i++) {
    const i3 = i * 3, j3 = i3 + 3;
    const v1x = pts[j3] - pts[i3], v1y = pts[j3 + 1] - pts[i3 + 1], v1z = pts[j3 + 2] - pts[i3 + 2];
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    let uLx = out[i3], uLy = out[i3 + 1], uLz = out[i3 + 2];
    let tLx = tan[i3], tLy = tan[i3 + 1], tLz = tan[i3 + 2];
    if (c1 > 1e-20) {
      const du = ((v1x * uLx + v1y * uLy + v1z * uLz) * 2) / c1;
      uLx -= du * v1x; uLy -= du * v1y; uLz -= du * v1z;
      const dt = ((v1x * tLx + v1y * tLy + v1z * tLz) * 2) / c1;
      tLx -= dt * v1x; tLy -= dt * v1y; tLz -= dt * v1z;
    }
    const v2x = tan[j3] - tLx, v2y = tan[j3 + 1] - tLy, v2z = tan[j3 + 2] - tLz;
    const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
    let nx = uLx, ny = uLy, nz = uLz;
    if (c2 > 1e-20) {
      const du2 = ((v2x * uLx + v2y * uLy + v2z * uLz) * 2) / c2;
      nx -= du2 * v2x; ny -= du2 * v2y; nz -= du2 * v2z;
    }
    const td = nx * tan[j3] + ny * tan[j3 + 1] + nz * tan[j3 + 2];
    nx -= td * tan[j3]; ny -= td * tan[j3 + 1]; nz -= td * tan[j3 + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    out[j3] = nx / nl; out[j3 + 1] = ny / nl; out[j3 + 2] = nz / nl;
  }
  return out;
}

/** Discrete curvature |dT/ds|. */
export function curvatures(tan, n, h, out = new Float32Array(n)) {
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = tan[b * 3] - tan[a * 3], dy = tan[b * 3 + 1] - tan[a * 3 + 1], dz = tan[b * 3 + 2] - tan[a * 3 + 2];
    const span = (b - a) * h || h;
    out[i] = Math.hypot(dx, dy, dz) / span;
  }
  return out;
}

/** Centre and uniform scale mapping every sample into a unit-radius ball. */
export function fitTransform(curves) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const c of curves) {
    for (let i = 0; i < c.n; i++) {
      const x = c.pts[i * 3], y = c.pts[i * 3 + 1], z = c.pts[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!isFinite(minX)) return { center: [0, 0, 0], scale: 1 };
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2 || 1;
  return { center, scale: 1 / half };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const a = Float32Array.from(values).sort();
  const i = Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))));
  return a[i];
}

/** Global speed / curvature ranges, sampled sparsely so huge sets stay cheap. */
export function analyse(curves, h) {
  const sp = [], cu = [];
  const stride = Math.max(1, Math.floor(curves.length / 400));
  for (let ci = 0; ci < curves.length; ci += stride) {
    const c = curves[ci];
    if (!c || c.n < 2) continue;
    const tan = tangents(c.pts, c.n);
    const k = curvatures(tan, c.n, h);
    const st = Math.max(1, Math.floor(c.n / 40));
    for (let i = 0; i < c.n; i += st) { sp.push(c.speed[i]); cu.push(k[i]); }
  }
  const speedMin = percentile(sp, 0.02), curvMin = percentile(cu, 0.02);
  return {
    speedMin, speedMax: Math.max(percentile(sp, 0.98), speedMin + 1e-9),
    curvMin, curvMax: Math.max(percentile(cu, 0.98), curvMin + 1e-9),
  };
}

/**
 * Stage one: normalise, smooth, frame, colour and size every sample.
 * opts: { h, width, widthMode, widthAmount, taperPower, twist, twistNoise,
 *         smoothIters, smoothStrength, colorMode, colorCycles, colorReverse }
 */
export function prepareCurves(curves, opts, gradient) {
  const imageAt = opts.imageAt || null;
  const fit = fitTransform(curves);
  const { center, scale } = fit;
  const stats = analyse(curves, opts.h);
  const items = [];
  const rgb = [0, 0, 0];
  let totalSamples = 0;

  for (let ci = 0; ci < curves.length; ci++) {
    const c = curves[ci];
    if (!c || c.n < 2) continue;
    const n = c.n;
    const raw = smoothCurve(c.pts, n, opts.smoothIters, opts.smoothStrength);

    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (raw[i * 3] - center[0]) * scale;
      pos[i * 3 + 1] = (raw[i * 3 + 1] - center[1]) * scale;
      pos[i * 3 + 2] = (raw[i * 3 + 2] - center[2]) * scale;
    }
    const tan = tangents(pos, n);
    const nor = rmfNormals(pos, tan, n, c.rnd * Math.PI * 2);
    const curv = curvatures(tan, n, opts.h * scale);
    const col = new Float32Array(n * 3);
    const wid = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const s = n > 1 ? i / (n - 1) : 0;
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
      const spN = clamp01((c.speed[i] - stats.speedMin) / (stats.speedMax - stats.speedMin));
      // Sampled from the fitted position, so the image frames what you see
      // rather than the raw field coordinates.
      const imN = imageAt ? clamp01(imageAt(px, py, pz)) : 0.5;
      const cuN = clamp01((curv[i] * scale - stats.curvMin) / (stats.curvMax - stats.curvMin));

      let w = opts.width;
      switch (opts.widthMode) {
        case 1: w *= Math.pow(Math.max(0, Math.sin(Math.PI * s)), opts.taperPower); break;
        case 2: w *= 1 + opts.widthAmount * (spN * 2 - 1); break;
        case 3: w *= 1 + opts.widthAmount * (cuN * 2 - 1); break;
        case 4: w *= 1 + opts.widthAmount * (c.rnd * 2 - 1); break;
        case 5: w *= 1 + opts.widthAmount * (s * 2 - 1); break;
        case 6: w *= 1 + opts.widthAmount * auxNoise.noise3(px * 2.5, py * 2.5, pz * 2.5 + ci * 0.7); break;
        case 7: w *= 1 + opts.widthAmount * (imN * 2 - 1); break;
        default: break;
      }
      wid[i] = Math.max(w, 1e-6);

      const tw = opts.twist * s * Math.PI * 2
        + (opts.twistNoise ? opts.twistNoise * auxNoise.noise3(px * 1.7 + 5, py * 1.7, pz * 1.7) * Math.PI * 2 : 0);
      if (tw !== 0) {
        const tx = tan[i3], ty = tan[i3 + 1], tz = tan[i3 + 2];
        const ux = nor[i3], uy = nor[i3 + 1], uz = nor[i3 + 2];
        const cs = Math.cos(tw), sn = Math.sin(tw);
        const kx = ty * uz - tz * uy, ky = tz * ux - tx * uz, kz = tx * uy - ty * ux;
        nor[i3] = ux * cs + kx * sn; nor[i3 + 1] = uy * cs + ky * sn; nor[i3 + 2] = uz * cs + kz * sn;
      }

      let ct;
      switch (opts.colorMode) {
        case 1: ct = curves.length > 1 ? ci / (curves.length - 1) : 0; break;
        case 2: ct = spN; break;
        case 3: ct = cuN; break;
        case 4: ct = py * 0.5 + 0.5; break;
        case 5: ct = pz * 0.5 + 0.5; break;
        case 6: ct = Math.min(1, Math.hypot(px, py, pz)); break;
        case 7: ct = Math.atan2(tan[i3 + 1], tan[i3]) / (Math.PI * 2) + 0.5 + tan[i3 + 2] * 0.25; break;
        case 8: ct = c.rnd; break;
        case 9: ct = imN; break;
        default: ct = s;
      }
      ct *= opts.colorCycles;
      ct = ct - Math.floor(ct);
      if (!isFinite(ct)) ct = 0;
      if (opts.colorReverse) ct = 1 - ct;
      gradient.sample(ct, rgb);
      col[i3] = rgb[0]; col[i3 + 1] = rgb[1]; col[i3 + 2] = rgb[2];
    }

    items.push({ pos, tan, nor, col, wid, n, rnd: c.rnd });
    totalSamples += n;
  }
  return { items, fit, stats, totalSamples };
}

class Chunk {
  constructor(mode) {
    this.mode = mode;
    this.positions = []; this.normals = []; this.colors = []; this.params = []; this.indices = [];
    // One entry per curve: where its indices start, how many, and its centroid.
    // Transparent draws reorder these back to front; opaque draws ignore them.
    this.ranges = [];
  }
  get vertexCount() { return this.positions.length / 3; }
  freeze() {
    return {
      mode: this.mode,
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      params: new Float32Array(this.params),
      indices: new Uint16Array(this.indices),
      ranges: this.ranges,
      centroids: new Float32Array(this.ranges.length * 3),
      vertexCount: this.positions.length / 3,
      indexCount: this.indices.length,
    };
  }
}

/** Stage two: extrude prepared curves into GL-ready chunks. */
export function buildMesh(prepared, opts) {
  const mode = opts.geomMode;
  const sides = Math.max(3, Math.min(16, opts.sides | 0));
  // Box duplicates the four corners so each face carries its own flat normal.
  // A 4-sided tube has the same silhouette but shares corner vertices, so its
  // normals are averaged across the seam and it shades like a rounded band
  // rather than a bar with edges.
  const vertsPerSample = mode === 0 ? 2 : mode === 1 ? sides : mode === 3 ? 8 : 1;
  const glMode = mode === 2 ? 'lines' : 'triangles';
  const chunks = [];
  let chunk = new Chunk(glMode);
  const rgb = [0, 0, 0];

  for (const it of prepared.items) {
    const n = it.n;
    const rangeStart = chunk.indices.length;
    if (chunk.vertexCount + n * vertsPerSample > MAX_VERTS && chunk.vertexCount > 0) {
      chunks.push(chunk.freeze());
      chunk = new Chunk(glMode);
    }
    const base = chunk.vertexCount;
    const { pos, tan, nor, col, wid } = it;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const s = n > 1 ? i / (n - 1) : 0;
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
      const tx = tan[i3], ty = tan[i3 + 1], tz = tan[i3 + 2];
      const ux = nor[i3], uy = nor[i3 + 1], uz = nor[i3 + 2];
      const wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
      const w = wid[i];
      rgb[0] = col[i3]; rgb[1] = col[i3 + 1]; rgb[2] = col[i3 + 2];

      if (mode === 0) {
        pushVert(chunk, px - ux * w, py - uy * w, pz - uz * w, wx, wy, wz, rgb, s, it.rnd, 0);
        pushVert(chunk, px + ux * w, py + uy * w, pz + uz * w, wx, wy, wz, rgb, s, it.rnd, 1);
      } else if (mode === 1) {
        const rx = w, ry = Math.max(1e-6, w * opts.aspect);
        for (let k = 0; k < sides; k++) {
          const a = (k / sides) * Math.PI * 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          const ox = ux * ca * rx + wx * sa * ry;
          const oy = uy * ca * rx + wy * sa * ry;
          const oz = uz * ca * rx + wz * sa * ry;
          const nx = (ux * ca) / rx + (wx * sa) / ry;
          const ny = (uy * ca) / rx + (wy * sa) / ry;
          const nz = (uz * ca) / rx + (wz * sa) / ry;
          const nl = Math.hypot(nx, ny, nz) || 1;
          pushVert(chunk, px + ox, py + oy, pz + oz, nx / nl, ny / nl, nz / nl, rgb, s, it.rnd, k / sides);
        }
      } else if (mode === 3) {
        const rx = w, ry = Math.max(1e-6, w * opts.aspect);
        // Corners, then faces between consecutive corners. Each face gets both
        // of its corners with the face normal, so the edges stay crisp.
        const cx = [-ux * rx - wx * ry, ux * rx - wx * ry, ux * rx + wx * ry, -ux * rx + wx * ry];
        const cy = [-uy * rx - wy * ry, uy * rx - wy * ry, uy * rx + wy * ry, -uy * rx + wy * ry];
        const cz = [-uz * rx - wz * ry, uz * rx - wz * ry, uz * rx + wz * ry, -uz * rx + wz * ry];
        const fnx = [-wx, ux, wx, -ux], fny = [-wy, uy, wy, -uy], fnz = [-wz, uz, wz, -uz];
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) & 3;
          const nl = Math.hypot(fnx[k], fny[k], fnz[k]) || 1;
          const nx = fnx[k] / nl, ny = fny[k] / nl, nz = fnz[k] / nl;
          pushVert(chunk, px + cx[k], py + cy[k], pz + cz[k], nx, ny, nz, rgb, s, it.rnd, k / 4);
          pushVert(chunk, px + cx[k2], py + cy[k2], pz + cz[k2], nx, ny, nz, rgb, s, it.rnd, (k + 1) / 4);
        }
      } else {
        pushVert(chunk, px, py, pz, tx, ty, tz, rgb, s, it.rnd, 0.5);
      }
    }

    if (mode === 0) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2, b = a + 1, c2 = a + 2, d = a + 3;
        chunk.indices.push(a, b, c2, b, d, c2);
      }
    } else if (mode === 1) {
      for (let i = 0; i < n - 1; i++) {
        const r0 = base + i * sides, r1 = base + (i + 1) * sides;
        for (let k = 0; k < sides; k++) {
          const k2 = (k + 1) % sides;
          chunk.indices.push(r0 + k, r0 + k2, r1 + k, r0 + k2, r1 + k2, r1 + k);
        }
      }
    } else if (mode === 3) {
      for (let i = 0; i < n - 1; i++) {
        const r0 = base + i * 8, r1 = base + (i + 1) * 8;
        for (let k = 0; k < 4; k++) {
          const a = r0 + k * 2, b = a + 1, c2 = r1 + k * 2, d = c2 + 1;
          chunk.indices.push(a, b, c2, b, d, c2);
        }
      }
    } else {
      for (let i = 0; i < n - 1; i++) chunk.indices.push(base + i, base + i + 1);
    }

    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; }
    chunk.ranges.push({
      start: rangeStart,
      count: chunk.indices.length - rangeStart,
      cx: cx / n, cy: cy / n, cz: cz / n,
    });
  }
  if (chunk.vertexCount > 0) chunks.push(chunk.freeze());
  for (const c of chunks) {
    for (let i = 0; i < c.ranges.length; i++) {
      c.centroids[i * 3] = c.ranges[i].cx;
      c.centroids[i * 3 + 1] = c.ranges[i].cy;
      c.centroids[i * 3 + 2] = c.ranges[i].cz;
    }
  }
  return chunks;
}

function pushVert(chunk, x, y, z, nx, ny, nz, rgb, s, rnd, v) {
  chunk.positions.push(x, y, z);
  chunk.normals.push(nx, ny, nz);
  chunk.colors.push(rgb[0], rgb[1], rgb[2]);
  // s runs along the curve, rnd is a per-curve constant, v runs across the
  // form (edge to edge on a ribbon, around a tube or box). Procedural
  // texturing needs that second coordinate; nothing else uses it.
  chunk.params.push(s, rnd, v);
}
