// volume.js — a signed distance field that decides where streamlines are
// allowed to exist. Seeds are rejected outside it and curves stop at its
// surface, so the flow takes the shape of the container rather than filling a
// ball and being cropped by the camera.
//
// Everything here is a distance *estimate*, not an exact distance, which is
// fine: the tracer only ever asks for the sign. Sizes are fractions of the
// field domain so a volume means the same thing whichever field is loaded.

export const VOLUME_SHAPES = [
  'None', 'Sphere', 'Box', 'Rounded box', 'Cylinder', 'Torus', 'Capsule',
  'Octahedron', 'Cone', 'Gyroid shell', 'Schwarz shell',
];

function sdSphere(x, y, z, r) {
  return Math.sqrt(x * x + y * y + z * z) - r;
}

function sdBox(x, y, z, bx, by, bz, round) {
  const qx = Math.abs(x) - bx, qy = Math.abs(y) - by, qz = Math.abs(z) - bz;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - round;
}

function sdCylinder(x, y, z, r, halfH) {
  const dx = Math.sqrt(x * x + z * z) - r, dy = Math.abs(y) - halfH;
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ax * ax + ay * ay);
}

function sdTorus(x, y, z, R, r) {
  const q = Math.sqrt(x * x + z * z) - R;
  return Math.sqrt(q * q + y * y) - r;
}

function sdCapsule(x, y, z, halfH, r) {
  const yy = y - Math.max(-halfH, Math.min(halfH, y));
  return Math.sqrt(x * x + yy * yy + z * z) - r;
}

function sdOctahedron(x, y, z, s) {
  // The cheap bound rather than the exact form — the sign is what matters.
  return (Math.abs(x) + Math.abs(y) + Math.abs(z) - s) * 0.57735027;
}

function sdCone(x, y, z, r, h) {
  // Apex up at +h, base radius r at -h.
  const q = Math.sqrt(x * x + z * z);
  const t = (y + h) / (2 * h);                       // 0 at base, 1 at apex
  const rr = r * (1 - Math.max(0, Math.min(1, t)));
  return Math.max(q - rr, Math.abs(y) - h);
}

/** Gyroid: sin x cos y + sin y cos z + sin z cos x. Zero set is the surface. */
function gyroid(x, y, z, f) {
  const X = x * f, Y = y * f, Z = z * f;
  return Math.sin(X) * Math.cos(Y) + Math.sin(Y) * Math.cos(Z) + Math.sin(Z) * Math.cos(X);
}

/** Schwarz P: cos x + cos y + cos z. */
function schwarz(x, y, z, f) {
  return Math.cos(x * f) + Math.cos(y * f) + Math.cos(z * f);
}

/**
 * Build the test the tracer uses. Returns null when no volume is selected, so
 * the caller can skip the check entirely rather than pay for a function call
 * per step.
 *
 * cfg: { shape, size, thickness, round, frequency, invert, clipToSphere }
 * `domain` scales everything, so a volume is the same shape at any field scale.
 */
export function makeVolume(cfg, domain) {
  const shape = cfg && (cfg.shape | 0);
  if (!shape) return null;

  const S = domain * Math.max(0.05, cfg.size);
  const thick = domain * Math.max(0.005, cfg.thickness);
  const round = domain * Math.max(0, cfg.round);
  const f = Math.max(0.2, cfg.frequency) / domain;
  const invert = !!cfg.invert;
  // A shell has no outer bound of its own, so it gets one.
  const outer = domain * Math.max(0.05, cfg.size);

  let sdf;
  switch (shape) {
    case 1: sdf = (x, y, z) => sdSphere(x, y, z, S); break;
    case 2: sdf = (x, y, z) => sdBox(x, y, z, S, S, S, 0); break;
    case 3: sdf = (x, y, z) => sdBox(x, y, z, S - round, S - round, S - round, round); break;
    case 4: sdf = (x, y, z) => sdCylinder(x, y, z, S, S); break;
    case 5: sdf = (x, y, z) => sdTorus(x, y, z, S, Math.max(1e-4, thick)); break;
    case 6: sdf = (x, y, z) => sdCapsule(x, y, z, S, Math.max(1e-4, thick)); break;
    case 7: sdf = (x, y, z) => sdOctahedron(x, y, z, S); break;
    case 8: sdf = (x, y, z) => sdCone(x, y, z, S, S); break;
    case 9: sdf = (x, y, z) => Math.max(Math.abs(gyroid(x, y, z, f)) - cfg.thickness * 2.2, sdSphere(x, y, z, outer)); break;
    default: sdf = (x, y, z) => Math.max(Math.abs(schwarz(x, y, z, f)) - cfg.thickness * 2.2, sdSphere(x, y, z, outer)); break;
  }

  const inside = invert
    ? (x, y, z) => sdf(x, y, z) > 0
    : (x, y, z) => sdf(x, y, z) <= 0;

  inside.sdf = sdf;
  inside.radius = shape === 9 || shape === 10 ? outer : S * 1.8;
  return inside;
}
