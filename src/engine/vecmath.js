// vecmath.js — tiny dependency-free linear algebra (column-major mat4, like OpenGL).

export function v3(x = 0, y = 0, z = 0) { return [x, y, z]; }

export function add(a, b, o = [0, 0, 0]) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; }
export function sub(a, b, o = [0, 0, 0]) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; }
export function scale(a, s, o = [0, 0, 0]) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; }
export function addScaled(a, b, s, o = [0, 0, 0]) { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; }
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a, b, o = [0, 0, 0]) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  o[0] = x; o[1] = y; o[2] = z; return o;
}
export function len(a) { return Math.hypot(a[0], a[1], a[2]); }
export function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export function normalize(a, o = [0, 0, 0]) {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l < 1e-20) { o[0] = 0; o[1] = 0; o[2] = 0; return o; }
  o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o;
}
export function lerp3(a, b, t, o = [0, 0, 0]) {
  o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o;
}
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Any unit vector perpendicular to t. */
export function perpendicular(t, o = [0, 0, 0]) {
  const ax = Math.abs(t[0]), ay = Math.abs(t[1]), az = Math.abs(t[2]);
  let ux, uy, uz;
  if (ax <= ay && ax <= az) { ux = 0; uy = -t[2]; uz = t[1]; }
  else if (ay <= az) { ux = -t[2]; uy = 0; uz = t[0]; }
  else { ux = -t[1]; uy = t[0]; uz = 0; }
  return normalize([ux, uy, uz], o);
}

/** Rotate v about unit axis k by angle a (Rodrigues). */
export function rotateAxis(v, k, a, o = [0, 0, 0]) {
  const c = Math.cos(a), s = Math.sin(a);
  const kd = dot(k, v);
  const kx = k[1] * v[2] - k[2] * v[1];
  const ky = k[2] * v[0] - k[0] * v[2];
  const kz = k[0] * v[1] - k[1] * v[0];
  o[0] = v[0] * c + kx * s + k[0] * kd * (1 - c);
  o[1] = v[1] * c + ky * s + k[1] * kd * (1 - c);
  o[2] = v[2] * c + kz * s + k[2] * kd * (1 - c);
  return o;
}

// ---------- mat4 (column-major, 16 floats) ----------

export function mat4Identity(o = new Float32Array(16)) {
  o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o;
}

export function mat4Perspective(fovyRad, aspect, near, far, o = new Float32Array(16)) {
  const f = 1 / Math.tan(fovyRad / 2);
  o.fill(0);
  o[0] = f / aspect; o[5] = f; o[11] = -1;
  o[10] = (far + near) / (near - far);
  o[14] = (2 * far * near) / (near - far);
  return o;
}

/**
 * The same perspective frustum restricted to a sub-rectangle of the image,
 * given in 0..1 with y up. Rendering each tile through its own slice of the one
 * frustum is what makes tiled export seamless: the tiles are not separate
 * cameras, they are windows onto the same one.
 */
export function mat4PerspectiveTile(fovyRad, aspect, near, far, x0, x1, y0, y1, o = new Float32Array(16)) {
  const t = near * Math.tan(fovyRad / 2), b = -t;
  const r = t * aspect, l = -r;
  const l2 = l + (r - l) * x0, r2 = l + (r - l) * x1;
  const b2 = b + (t - b) * y0, t2 = b + (t - b) * y1;
  o.fill(0);
  o[0] = (2 * near) / (r2 - l2);
  o[5] = (2 * near) / (t2 - b2);
  o[8] = (r2 + l2) / (r2 - l2);
  o[9] = (t2 + b2) / (t2 - b2);
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}

export function mat4LookAt(eye, target, up, o = new Float32Array(16)) {
  const z = normalize(sub(eye, target));
  let x = cross(up, z);
  if (len(x) < 1e-9) { x = cross([0, 0, 1], z); }
  normalize(x, x);
  const y = cross(z, x);
  o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
  o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
  o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
  o[12] = -dot(x, eye); o[13] = -dot(y, eye); o[14] = -dot(z, eye); o[15] = 1;
  return o;
}

export function mat4Multiply(a, b, o = new Float32Array(16)) {
  const r = o === a || o === b ? new Float32Array(16) : o;
  for (let c = 0; c < 4; c++) {
    for (let rr = 0; rr < 4; rr++) {
      r[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
    }
  }
  if (r !== o) o.set(r);
  return o;
}

/** Transform a point (w=1); returns [x,y,z,w] in clip space. */
export function mat4TransformPoint(m, p, o = [0, 0, 0, 0]) {
  const [x, y, z] = p;
  o[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  o[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  o[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  o[3] = m[3] * x + m[7] * y + m[11] * z + m[15];
  return o;
}

/** Upper-left 3x3 of a mat4, as a mat3 (column-major, 9 floats). */
export function mat3FromMat4(m, o = new Float32Array(9)) {
  o[0] = m[0]; o[1] = m[1]; o[2] = m[2];
  o[3] = m[4]; o[4] = m[5]; o[5] = m[6];
  o[6] = m[8]; o[7] = m[9]; o[8] = m[10];
  return o;
}
