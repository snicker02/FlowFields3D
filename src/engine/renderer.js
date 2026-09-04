// renderer.js — WebGL1 renderer. Everything draws through renderScene(), the
// single entry point, so PNG export and the live view can never drift apart.

import { RIBBON_VS, RIBBON_FS, BG_VS, BG_FS } from './shaders.js';
import { hexToRgb } from './palette.js';

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`${label} failed to compile:\n${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc, label) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, label + ' vertex shader'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + ' fragment shader'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${label} failed to link:\n${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function uniforms(gl, prog, names) {
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(prog, n);
  return u;
}

export class Renderer {
  constructor(canvas) {
    const opts = { antialias: true, alpha: false, depth: true, preserveDrawingBuffer: true, premultipliedAlpha: false };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('This browser could not create a WebGL context.');
    this.gl = gl;
    this.canvas = canvas;

    this.prog = link(gl, RIBBON_VS, RIBBON_FS, 'Ribbon');
    this.attr = {
      pos: gl.getAttribLocation(this.prog, 'aPos'),
      nor: gl.getAttribLocation(this.prog, 'aNormal'),
      col: gl.getAttribLocation(this.prog, 'aColor'),
      par: gl.getAttribLocation(this.prog, 'aParam'),
    };
    this.uni = uniforms(gl, this.prog, ['uMVP', 'uModelView', 'uNormalMat', 'uLightDir', 'uLightColor',
      'uSkyColor', 'uGroundColor', 'uAmbient', 'uSpecular', 'uShininess', 'uRim', 'uFogColor',
      'uFogDensity', 'uFogStart', 'uFlowPhase', 'uFlowFreq', 'uFlowStrength', 'uOpacity', 'uFlat', 'uExposure']);

    this.bgProg = link(gl, BG_VS, BG_FS, 'Background');
    this.bgAttr = gl.getAttribLocation(this.bgProg, 'aXY');
    this.bgUni = uniforms(gl, this.bgProg, ['uTop', 'uBottom', 'uVignette']);
    this.bgBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.buffers = [];
    this.stats = { chunks: 0, vertices: 0, indices: 0 };
  }

  dispose() {
    const gl = this.gl;
    for (const b of this.buffers) {
      gl.deleteBuffer(b.pos); gl.deleteBuffer(b.nor); gl.deleteBuffer(b.col);
      gl.deleteBuffer(b.par); gl.deleteBuffer(b.idx);
    }
    this.buffers = [];
    this.stats = { chunks: 0, vertices: 0, indices: 0 };
  }

  upload(chunks) {
    const gl = this.gl;
    this.dispose();
    for (const c of chunks) {
      const mk = (data, target = gl.ARRAY_BUFFER) => {
        const b = gl.createBuffer();
        gl.bindBuffer(target, b);
        gl.bufferData(target, data, gl.STATIC_DRAW);
        return b;
      };
      this.buffers.push({
        pos: mk(c.positions), nor: mk(c.normals), col: mk(c.colors), par: mk(c.params),
        idx: mk(c.indices, gl.ELEMENT_ARRAY_BUFFER),
        count: c.indexCount,
        mode: c.mode,
      });
      this.stats.vertices += c.vertexCount;
      this.stats.indices += c.indexCount;
    }
    this.stats.chunks = chunks.length;
  }

  resize(width, height) {
    const c = this.canvas;
    if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
  }

  /**
   * The single draw entry point.
   * look: { mvp, modelView, normalMat }
   * style: see state.js `look` block.
   */
  renderScene(look, style, width, height) {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // background
    gl.useProgram(this.bgProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.enableVertexAttribArray(this.bgAttr);
    gl.vertexAttribPointer(this.bgAttr, 2, gl.FLOAT, false, 0, 0);
    gl.uniform3fv(this.bgUni.uTop, hexToRgb(style.bgTop));
    gl.uniform3fv(this.bgUni.uBottom, hexToRgb(style.bgBottom));
    gl.uniform1f(this.bgUni.uVignette, style.vignette);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(this.bgAttr);

    if (!this.buffers.length) return;

    // geometry
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const additive = style.renderMode === 1;
    if (additive) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
    } else if (style.opacity < 0.999) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    }
    if (style.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); } else gl.disable(gl.CULL_FACE);

    const p = this.prog, u = this.uni;
    gl.useProgram(p);
    gl.uniformMatrix4fv(u.uMVP, false, look.mvp);
    gl.uniformMatrix4fv(u.uModelView, false, look.modelView);
    gl.uniformMatrix3fv(u.uNormalMat, false, look.normalMat);
    gl.uniform3fv(u.uLightDir, style.lightDir);
    gl.uniform3fv(u.uLightColor, hexToRgb(style.lightColor));
    gl.uniform3fv(u.uSkyColor, hexToRgb(style.skyColor));
    gl.uniform3fv(u.uGroundColor, hexToRgb(style.groundColor));
    gl.uniform1f(u.uAmbient, style.ambient);
    gl.uniform1f(u.uSpecular, style.specular);
    gl.uniform1f(u.uShininess, Math.max(1, style.shininess));
    gl.uniform1f(u.uRim, style.rim);
    gl.uniform3fv(u.uFogColor, hexToRgb(style.fogColor));
    gl.uniform1f(u.uFogDensity, style.fogDensity);
    gl.uniform1f(u.uFogStart, style.fogStart);
    gl.uniform1f(u.uFlowPhase, style.flowPhase);
    gl.uniform1f(u.uFlowFreq, style.flowFreq);
    gl.uniform1f(u.uFlowStrength, style.flowStrength);
    gl.uniform1f(u.uOpacity, additive ? style.opacity : Math.max(0.02, style.opacity));
    gl.uniform1f(u.uFlat, style.renderMode === 2 || style.renderMode === 1 ? 1 : 0);
    gl.uniform1f(u.uExposure, style.exposure);

    for (const b of this.buffers) {
      bind(gl, b.pos, this.attr.pos, 3);
      bind(gl, b.nor, this.attr.nor, 3);
      bind(gl, b.col, this.attr.col, 3);
      bind(gl, b.par, this.attr.par, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
      gl.drawElements(b.mode === 'lines' ? gl.LINES : gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0);
    }

    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
}

function bind(gl, buf, loc, size) {
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}
