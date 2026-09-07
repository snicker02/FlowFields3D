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
    this.texture = null;

    this.prog = link(gl, RIBBON_VS, RIBBON_FS, 'Ribbon');
    this.attr = {
      pos: gl.getAttribLocation(this.prog, 'aPos'),
      nor: gl.getAttribLocation(this.prog, 'aNormal'),
      col: gl.getAttribLocation(this.prog, 'aColor'),
      par: gl.getAttribLocation(this.prog, 'aParam'),
    };
    this.uni = uniforms(gl, this.prog, ['uMVP', 'uModelView', 'uNormalMat', 'uLightDir', 'uLightColor',
      'uSkyColor', 'uGroundColor', 'uAmbient', 'uSpecular', 'uShininess', 'uRim', 'uFogColor',
      'uFogDensity', 'uFogStart', 'uFlowPhase', 'uFlowFreq', 'uFlowStrength', 'uOpacity', 'uFlat', 'uExposure',
      'uMaterial', 'uTexMode', 'uTexScale', 'uTexRepeat', 'uTexAmount', 'uTexSoft',
      'uTravelMode', 'uTravelLen', 'uTravelPhase', 'uTravelSoft', 'uTravelStagger',
      'uTravelCount', 'uTravelGlow', 'uTexImage', 'uTexHasImage']);

    this.bgProg = link(gl, BG_VS, BG_FS, 'Background');
    this.bgAttr = gl.getAttribLocation(this.bgProg, 'aXY');
    this.bgUni = uniforms(gl, this.bgProg, ['uTop', 'uBottom', 'uVignette', 'uUVRect']);
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
        // Kept on the CPU so transparent draws can reorder the curves back to
        // front without rebuilding the geometry.
        srcIndices: c.indices,
        ranges: c.ranges || [],
        centroids: c.centroids || new Float32Array(0),
        scratch: null,
        order: null,
        sortKey: '',
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
   * uvRect: optional [x, y, w, h] in 0..1 naming which part of the finished
   *   image this pass covers, so a tiled export gets one continuous background.
   */
  renderScene(look, style, width, height, uvRect) {
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
    if (uvRect) gl.uniform4f(this.bgUni.uUVRect, uvRect[0], uvRect[1], uvRect[2], uvRect[3]);
    else gl.uniform4f(this.bgUni.uUVRect, 0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(this.bgAttr);

    if (!this.buffers.length) return;

    // geometry
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const additive = style.renderMode === 1;
    // Glass sets its own alpha from the Fresnel term, so it needs blending even
    // when opacity is 1. Without sorted geometry the ordering is approximate;
    // leaving the depth buffer read-only is what keeps it from looking wrong.
    const glass = style.renderMode === 0 && (style.material | 0) === 2;
    // Travel is a *cutout*, not a transparency: the window is fully opaque
    // through its middle and the shader discards everything outside it. Only
    // the tail edge is partial. Treating it like glass — depth writes off —
    // meant a curve's own far side painted over its near side in index order,
    // and per-curve sorting cannot help inside a single curve. On a coiled tube
    // that shows as fine combing where it crosses itself. So travel keeps depth
    // writes on, and blends only when the tail is soft.
    const travelling = (style.travelMode | 0) > 0;
    const travelSoft = travelling && style.travelSoft > 0.001;
    const seeThrough = glass || additive || style.opacity < 0.999;
    const needsSort = !!style.sortDepth && !!look.viewDir && (seeThrough || travelSoft);
    if (additive) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
    } else if (glass || style.opacity < 0.999) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    } else if (travelSoft) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(true);
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
    gl.uniform1f(u.uMaterial, style.renderMode === 0 ? (style.material | 0) : 0);
    gl.uniform1f(u.uTexMode, style.texMode | 0);
    gl.uniform1f(u.uTexScale, style.texScale);
    gl.uniform1f(u.uTexRepeat, style.texRepeat);
    gl.uniform1f(u.uTexAmount, style.texAmount);
    gl.uniform1f(u.uTexSoft, style.texSoft);
    gl.uniform1f(u.uTexHasImage, this.texture ? 1 : 0);
    if (this.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(u.uTexImage, 0);
    }
    gl.uniform1f(u.uTravelMode, style.travelMode | 0);
    gl.uniform1f(u.uTravelLen, style.travelLength);
    gl.uniform1f(u.uTravelPhase, style.travelPhase);
    gl.uniform1f(u.uTravelSoft, style.travelSoft);
    gl.uniform1f(u.uTravelStagger, style.travelStagger);
    gl.uniform1f(u.uTravelCount, style.travelCount);
    gl.uniform1f(u.uTravelGlow, style.travelGlow);

    if (needsSort) this.sortForView(look.viewDir);

    for (const b of this.buffers) {
      bind(gl, b.pos, this.attr.pos, 3);
      bind(gl, b.nor, this.attr.nor, 3);
      bind(gl, b.col, this.attr.col, 3);
      bind(gl, b.par, this.attr.par, 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
      gl.drawElements(b.mode === 'lines' ? gl.LINES : gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0);
    }

    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
}

/**
 * Reorder each chunk's indices so its curves are drawn far to near. Curves are
 * sorted, not triangles: a per-triangle sort is the correct answer and far too
 * slow to do every frame, while leaving the order alone makes overlapping glass
 * ribbons pick a winner arbitrarily. Sorting whole curves fixes the case that
 * actually shows — one ribbon in front of another — and leaves the
 * self-overlap of a single curve to the depth buffer.
 */
/**
 * Upload a drawable (canvas or image) as the ribbon texture. It must already be
 * power-of-two: WebGL1 will not REPEAT or mipmap anything else, and most drivers
 * express that by sampling black rather than by complaining.
 */
Renderer.prototype.setTexture = function setTexture(drawable) {
  const gl = this.gl;
  if (this.texture) { gl.deleteTexture(this.texture); this.texture = null; }
  if (!drawable) return;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawable);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  this.texture = tex;
};

Renderer.prototype.sortForView = function sortForView(viewDir) {
  const gl = this.gl;
  // Quantised so a slow orbit does not rebuild the buffers every frame.
  const key = `${viewDir[0].toFixed(2)},${viewDir[1].toFixed(2)},${viewDir[2].toFixed(2)}`;
  for (const b of this.buffers) {
    if (!b.ranges.length || b.sortKey === key) continue;
    b.sortKey = key;
    if (!b.order) b.order = b.ranges.map((_, i) => i);
    if (!b.scratch) b.scratch = new Uint16Array(b.srcIndices.length);

    const c = b.centroids;
    const depth = new Float32Array(b.ranges.length);
    for (let i = 0; i < b.ranges.length; i++) {
      depth[i] = c[i * 3] * viewDir[0] + c[i * 3 + 1] * viewDir[1] + c[i * 3 + 2] * viewDir[2];
    }
    b.order.sort((a, d) => depth[a] - depth[d]);   // most negative (farthest) first

    let w = 0;
    const src = b.srcIndices, dst = b.scratch;
    for (const i of b.order) {
      const r = b.ranges[i];
      for (let k = 0; k < r.count; k++) dst[w++] = src[r.start + k];
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, dst);
  }
};

function bind(gl, buf, loc, size) {
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}
