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
  update(aspect, tile) {
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
    mat4LookAt(this.eye, this.target, this.up, this.view);
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
      if (!state.drag) return;
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
      if (touches.size === 2) state.pinch = pinchDist(touches);
    });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) touches.set(t.identifier, [t.clientX, t.clientY]);
      if (touches.size === 2 && state.pinch) {
        const d = pinchDist(touches);
        this.dist = Math.max(0.15, Math.min(30, this.dist * (state.pinch / d)));
        state.pinch = d;
        onChange();
        e.preventDefault();
      }
    }, { passive: false });
    const clear = (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); if (touches.size < 2) state.pinch = 0; };
    canvas.addEventListener('touchend', clear);
    canvas.addEventListener('touchcancel', clear);
    return this;
  }
}

function pinchDist(map) {
  const [a, b] = [...map.values()];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
}
