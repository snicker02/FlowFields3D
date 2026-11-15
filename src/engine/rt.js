// rt.js — progressive refinement.
//
// The geometry here is a mesh of millions of triangles, so it is rasterised,
// not ray traced. What makes a ray traced image look the way it does is mostly
// not the ray casting: it is that lighting, lens and anti-aliasing are all
// *integrals*, estimated by averaging many randomised samples rather than
// approximated in one pass. That part transfers exactly.
//
// Each sample jitters the pixel, the lens aperture, the sun's position inside
// its angular size, and the direction the sky is sampled from. Averaging them
// converges to true anti-aliasing, true depth of field with correct bokeh
// ordering, real penumbrae, and ambient occlusion from actual visibility
// tests. The visibility comes from a shadow map rather than a cast ray, which
// is the one place the analogy stops — and because the scene is auto-fitted
// into the unit ball before it is drawn, that map's orthographic box is always
// the same known size, with no cascades or fitting to get wrong.

import { mat4LookAt, mat4Ortho, mat4Multiply } from './vecmath.js';

/** Radical inverse in `base` — the Halton sequence. */
export function halton(index, base) {
  let f = 1, r = 0, i = index + 1;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** A point in the unit disc, for the lens. Concentric so it stays uniform. */
export function diskSample(index) {
  const r = Math.sqrt(halton(index, 2));
  const a = halton(index, 3) * Math.PI * 2;
  return [r * Math.cos(a), r * Math.sin(a)];
}

/**
 * A direction uniform on the sphere. Uniform rather than cosine-weighted about
 * the surface normal because one map has to serve every normal in the scene at
 * once: a single pass cannot be biased toward each surface separately.
 */
export function sphereSample(index) {
  const u = halton(index, 5) * 2 - 1;
  const t = halton(index, 7) * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - u * u));
  return [r * Math.cos(t), u, r * Math.sin(t)];
}

/** Perturb a direction inside a cone of `degrees`, for the sun's angular size. */
export function coneSample(dir, index, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const cosMax = Math.cos(rad);
  const u = halton(index, 11), v = halton(index, 13);
  const cosT = 1 - u * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = v * Math.PI * 2;

  let ax = 0, ay = 0, az = 0;
  if (Math.abs(dir[0]) <= Math.abs(dir[1]) && Math.abs(dir[0]) <= Math.abs(dir[2])) ax = 1;
  else if (Math.abs(dir[1]) <= Math.abs(dir[2])) ay = 1;
  else az = 1;
  let tx = ay * dir[2] - az * dir[1];
  let ty = az * dir[0] - ax * dir[2];
  let tz = ax * dir[1] - ay * dir[0];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = dir[1] * tz - dir[2] * ty;
  const by = dir[2] * tx - dir[0] * tz;
  const bz = dir[0] * ty - dir[1] * tx;

  const cp = Math.cos(phi) * sinT, sp = Math.sin(phi) * sinT;
  const x = dir[0] * cosT + tx * cp + bx * sp;
  const y = dir[1] * cosT + ty * cp + by * sp;
  const z = dir[2] * cosT + tz * cp + bz * sp;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * The light's view-projection. `radius` covers the unit ball the geometry is
 * fitted into, with a little margin so a wide ribbon at the edge still casts.
 */
export function lightMatrix(dir, radius = 1.35, out = new Float32Array(16)) {
  const d = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const eye = [(dir[0] / d) * radius * 2, (dir[1] / d) * radius * 2, (dir[2] / d) * radius * 2];
  const up = Math.abs(dir[1] / d) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const view = mat4LookAt(eye, [0, 0, 0], up);
  const proj = mat4Ortho(-radius, radius, -radius, radius, 0.01, radius * 4);
  return mat4Multiply(proj, view, out);
}

/** A colour target with an optional depth buffer. */
export function createTarget(gl, width, height, withDepth) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  // No mipmaps and clamped edges: the sizes here are arbitrary, not powers of
  // two, and WebGL1 samples anything else as black.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  let rb = null;
  if (withDepth) {
    rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }

  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { fb, tex, rb, width, height, ok };
}

export function destroyTarget(gl, t) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fb);
  if (t.rb) gl.deleteRenderbuffer(t.rb);
}
