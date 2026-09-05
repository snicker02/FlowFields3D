// image.js — a user image, used two ways.
//
//   1. As a field. The image is projected into the volume (on a plane, or
//      wrapped on a sphere or cylinder) and its luminance read back at any 3D
//      point. That scalar can weight where seeds land, how wide a ribbon is, or
//      where it sits on the gradient. This is the 3D counterpart of the
//      image-driven density in the 2D plotter.
//
//   2. As a texture, sampled in the fragment shader across the ribbon.
//
// Both read the same file. Nothing here touches the network or the DOM beyond
// the canvas needed to get at the pixels.

export const PROJECTIONS = ['Plane XY', 'Plane XZ', 'Plane YZ', 'Spherical', 'Cylindrical'];

/** Rec. 709 luminance, which matches how the eye weights the channels. */
function luma(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export class ImageSource {
  /** `data` is an ImageData-like { width, height, data }. */
  constructor(data, name) {
    this.width = data.width;
    this.height = data.height;
    this.name = name || 'image';
    // One float per pixel is a quarter of the memory and all we ever read.
    this.lum = new Float32Array(this.width * this.height);
    const px = data.data;
    for (let i = 0, n = this.lum.length; i < n; i++) {
      this.lum[i] = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    }
    this.source = data;
  }

  /** Bilinear luminance at wrapped texture coordinates. */
  at(u, v) {
    const W = this.width, H = this.height;
    let x = (u - Math.floor(u)) * W - 0.5;
    let y = (1 - (v - Math.floor(v))) * H - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const wrap = (i, n) => ((i % n) + n) % n;
    const xa = wrap(x0, W), xb = wrap(x0 + 1, W);
    const ya = wrap(y0, H), yb = wrap(y0 + 1, H);
    const l = this.lum;
    const a = l[ya * W + xa], b = l[ya * W + xb];
    const c = l[yb * W + xa], d = l[yb * W + xb];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
}

/**
 * Project a 3D point to texture coordinates. `scale` is how much of the domain
 * the image spans, so the same settings frame the same way whatever field is
 * loaded.
 */
export function project(mode, x, y, z, domain, scale, offU, offV) {
  const s = 1 / Math.max(1e-6, domain * scale * 2);
  let u, v;
  switch (mode | 0) {
    case 1: u = x * s + 0.5; v = z * s + 0.5; break;                     // XZ
    case 2: u = z * s + 0.5; v = y * s + 0.5; break;                     // YZ
    case 3: {                                                            // spherical
      const r = Math.sqrt(x * x + y * y + z * z) || 1e-9;
      u = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
      v = 1 - Math.acos(Math.max(-1, Math.min(1, y / r))) / Math.PI;
      break;
    }
    case 4: {                                                            // cylindrical
      u = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
      v = y * s + 0.5;
      break;
    }
    default: u = x * s + 0.5; v = y * s + 0.5; break;                    // XY
  }
  return [u + offU, v + offV];
}

/**
 * Build the scalar field the tracer and the mesh builder both read. Returns
 * null when there is no image or the feature is switched off, so callers can
 * skip the work entirely.
 */
export function makeImageField(image, cfg, domain) {
  if (!image || !cfg || !cfg.enabled) return null;
  const mode = cfg.projection | 0;
  const scale = Math.max(0.05, cfg.scale);
  const gamma = Math.max(0.05, cfg.gamma);
  const contrast = cfg.contrast;
  const invert = !!cfg.invert;
  const offU = cfg.offsetU, offV = cfg.offsetV;

  return function sample(x, y, z) {
    const uv = project(mode, x, y, z, domain, scale, offU, offV);
    let l = image.at(uv[0], uv[1]);
    if (invert) l = 1 - l;
    // Contrast around mid grey first, then gamma — the order matters, and this
    // one keeps a flat image flat instead of pushing it off to one end.
    l = (l - 0.5) * (1 + contrast * 3) + 0.5;
    l = Math.max(0, Math.min(1, l));
    return Math.pow(l, gamma);
  };
}

/**
 * WebGL1 only wraps and mipmaps power-of-two textures, so the image is redrawn
 * onto a POT canvas. Without this, `REPEAT` silently gives a black texture on
 * many drivers, which is a miserable thing to debug.
 */
export function toPowerOfTwoCanvas(source, max = 1024) {
  const pot = (n) => {
    let p = 1;
    while (p * 2 <= Math.min(n, max)) p *= 2;
    return Math.max(1, p);
  };
  const w = pot(source.width), h = pot(source.height);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  return c;
}

/** Read a File into an ImageData plus the drawable element the texture needs. */
export async function readImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('that file could not be decoded as an image'));
      el.src = url;
    });
    // Sampling resolution for the field: full size is wasteful and slow to read.
    const maxSide = 512;
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h), element: img, name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}
