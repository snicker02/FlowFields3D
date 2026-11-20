// camera.js — orbit camera with pointer, wheel and touch control.

import { mat4LookAt, mat4Perspective, mat4PerspectiveTile, mat4Multiply, mat3FromMat4 } from './vecmath.js';

export class OrbitCamera {
  constructor() {
    this.yaw = 0.7;
    this.pitch = 0.35;
    this.dist = 3.4;
    this.target = [0, 0, 0];
    this.fov = 42;
    this.near = 0.01;
    this.far = 60;
    this.up = [0, 1, 0];
    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.mvp = new Float32Array(16);
    this.normalMat = new Float32Array(9);
    this.eye = [0, 0, 0];
  }

  /**
   * `tile`, when given, is [x0, x1, y0, y1] in 0..1 with y up — the slice of
   * the image being rendered. `aspect` stays the aspect of the whole image.
   */
  update(aspect, tile, jit) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.eye[0] = this.target[0] + this.dist * cp * Math.sin(this.yaw);
    this.eye[1] = this.target[1] + this.dist * sp;
    this.eye[2] = this.target[2] + this.dist * cp * Math.cos(this.yaw);
    if (tile) {
      mat4PerspectiveTile((this.fov * Math.PI) / 180, aspect, this.near, this.far,
        tile[0], tile[1], tile[2], tile[3], this.proj);
    } else {
      mat4Perspective((this.fov * Math.PI) / 180, aspect, this.near, this.far, this.proj);
    }
    // Sub-pixel offset, in clip space. Averaged over samples this is exact
    // anti-aliasing of every edge in the image, not a post-process guess.
    if (jit && jit.ndc) { this.proj[8] += jit.ndc[0]; this.proj[9] += jit.ndc[1]; }
    // Camera basis, before any lens offset: the sky background rebuilds a view
    // ray from it, and depth of field needs it to move the eye sideways.
    let fx = this.target[0] - this.eye[0], fy = this.target[1] - this.eye[1], fz = this.target[2] - this.eye[2];
    const fl0 = Math.hypot(fx, fy, fz) || 1;
    fx /= fl0; fy /= fl0; fz /= fl0;
    let rx = fy * this.up[2] - fz * this.up[1];
    let ry = fz * this.up[0] - fx * this.up[2];
    let rz = fx * this.up[1] - fy * this.up[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    this.right = [rx, ry, rz];
    this.upVec = [-ux, -uy, -uz];
    this.fwd = [fx, fy, fz];

    const eye = [this.eye[0], this.eye[1], this.eye[2]];
    let aim = this.target;
    if (jit && jit.aperture > 0) {
      // Thin lens. The eye slides across the aperture and re-aims at the focus
      // plane, so everything at that distance stays put while everything else
      // smears across samples — real defocus, converging rather than blurred.
      const a = jit.aperture;
      const du = jit.lens[0] * a, dv = jit.lens[1] * a;
      const dist = jit.focus > 0 ? jit.focus : this.dist;
      aim = [eye[0] + fx * dist, eye[1] + fy * dist, eye[2] + fz * dist];
      eye[0] += rx * du + this.upVec[0] * dv;
      eye[1] += ry * du + this.upVec[1] * dv;
      eye[2] += rz * du + this.upVec[2] * dv;
    }
    mat4LookAt(eye, aim, this.up, this.view);
    this.eyeJittered = eye;
    // World-space forward, for depth sorting. Same vector as the basis above.
    this.viewDir = [fx, fy, fz];
    mat4Multiply(this.proj, this.view, this.mvp);
    mat3FromMat4(this.view, this.normalMat);
    return this;
  }

  attach(canvas, onChange) {
    const state = { drag: 0, x: 0, y: 0, pinch: 0 };
    const PITCH = Math.PI / 2 - 0.01;

    const down = (e) => {
      state.drag = e.button === 2 || e.shiftKey ? 2 : 1;
      state.x = e.clientX; state.y = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!state.drag || state.pinch) return;   // a second finger hands over to pinch / pan
      const dx = e.clientX - state.x, dy = e.clientY - state.y;
      state.x = e.clientX; state.y = e.clientY;
      if (state.drag === 1) {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-PITCH, Math.min(PITCH, this.pitch + dy * 0.006));
      } else {
        const s = this.dist * 0.0016;
        const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
        this.target[0] -= dx * s * rx;
        this.target[2] -= dx * s * rz;
        this.target[1] += dy * s;
      }
      onChange();
    };
    const up = (e) => { state.drag = 0; try { canvas.releasePointerCapture(e.pointerId); } catch (_) { } };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(0.15, Math.min(30, this.dist * Math.exp(e.deltaY * 0.0012)));
      onChange();
    }, { passive: false });

    // pinch zoom
    const touches = new Map();
    canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) touches.set(t.identifier, [t.clientX, t.clientY]);
      if (touches.size === 2) { state.pinch = pinchDist(touches); state.mid = pinchMid(touches); state.drag = 0; }
    });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) touches.set(t.identifier, [t.clientX, t.clientY]);
      if (touches.size === 2 && state.pinch) {
        const d = pinchDist(touches);
        this.dist = Math.max(0.15, Math.min(30, this.dist * (state.pinch / d)));
        state.pinch = d;
        // two fingers moving together pan, like shift-drag
        const m = pinchMid(touches);
        if (state.mid) {
          const dx = m[0] - state.mid[0], dy = m[1] - state.mid[1];
          const s = this.dist * 0.0016, rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
          this.target[0] -= dx * s * rx; this.target[2] -= dx * s * rz; this.target[1] += dy * s;
        }
        state.mid = m;
        onChange();
        e.preventDefault();
      }
    }, { passive: false });
    const clear = (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); if (touches.size < 2) { state.pinch = 0; state.mid = null; } };
    canvas.addEventListener('touchend', clear);
    canvas.addEventListener('touchcancel', clear);
    return this;
  }
}

function pinchMid(map) {
  const [a, b] = [...map.values()];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function pinchDist(map) {
  const [a, b] = [...map.values()];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
}
