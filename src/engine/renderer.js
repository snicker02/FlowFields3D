// renderer.js — WebGL1 renderer. Everything draws through renderScene(), the
// single entry point, so PNG export and the live view can never drift apart.

import {
  RIBBON_VS, RIBBON_FS, BG_VS, BG_FS, DEPTH_VS, DEPTH_FS, QUAD_VS, ACCUM_FS, PRESENT_FS,
} from './shaders.js';
import { createTarget, destroyTarget, lightMatrix } from './rt.js';
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
      tan: gl.getAttribLocation(this.prog, 'aTangent'),
    };
    this.uni = uniforms(gl, this.prog, ['uMVP', 'uModelView', 'uNormalMat', 'uLightDir', 'uLightColor',
      'uSkyColor', 'uGroundColor', 'uAmbient', 'uSpecular', 'uShininess', 'uRim', 'uFogColor',
      'uFogDensity', 'uFogStart', 'uFlowPhase', 'uFlowFreq', 'uFlowStrength', 'uOpacity', 'uFlat', 'uExposure',
      'uMaterial', 'uTexMode', 'uTexScale', 'uTexRepeat', 'uTexAmount', 'uTexSoft',
      'uTravelMode', 'uTravelLen', 'uTravelPhase', 'uTravelSoft', 'uTravelStagger',
      'uTravelCount', 'uTravelGlow', 'uTravelPass', 'uDither', 'uTexImage', 'uTexHasImage',
      'uSunShadow', 'uSunVP', 'uSunMap', 'uSkyLight', 'uSkyVP', 'uSkyMap', 'uSkyDir',
      'uShadowBias', 'uEnvMode', 'uCamPos', 'uInscatter',
      'uStrand', 'uStrandExp', 'uStrandShift', 'uStrandSheen', 'uStrandDiffuse', 'uOcclusion',
      'uZenith', 'uHorizon', 'uGroundCol', 'uSunDir', 'uSunColor', 'uSunSize', 'uSunIntensity', 'uHaze']);

    this.bgProg = link(gl, BG_VS, BG_FS, 'Background');
    this.bgAttr = gl.getAttribLocation(this.bgProg, 'aXY');
    this.bgUni = uniforms(gl, this.bgProg, ['uTop', 'uBottom', 'uVignette', 'uUVRect', 'uEnvMode',
      'uCamRight', 'uCamUp', 'uCamFwd', 'uTanHalfFov', 'uAspect',
      'uZenith', 'uHorizon', 'uGroundCol', 'uSunDir', 'uSunColor', 'uSunSize', 'uSunIntensity', 'uHaze']);
    this.depthProg = link(gl, DEPTH_VS, DEPTH_FS, 'Shadow depth');
    this.depthAttr = gl.getAttribLocation(this.depthProg, 'aPos');
    this.depthUni = uniforms(gl, this.depthProg, ['uLightVP']);

    this.accumProg = link(gl, QUAD_VS, ACCUM_FS, 'Accumulate');
    this.accumAttr = gl.getAttribLocation(this.accumProg, 'aXY');
    this.accumUni = uniforms(gl, this.accumProg, ['uPrev', 'uSample', 'uWeight', 'uDitherAmt']);

    this.presentProg = link(gl, QUAD_VS, PRESENT_FS, 'Present');
    this.presentAttr = gl.getAttribLocation(this.presentProg, 'aXY');
    this.presentUni = uniforms(gl, this.presentProg, ['uTex', 'uExposureOut', 'uToneMap']);

    this.rt = { sample: null, accum: [null, null], read: 0, sun: null, sky: null, shadowSize: 0, ok: true };
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
        tanb: mk(c.tangents),
        idx: mk(c.indices, gl.ELEMENT_ARRAY_BUFFER),
        count: c.indexCount,
        mode: c.mode,
        closed: !!c.closed,
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
    gl.uniform1f(this.bgUni.uEnvMode, style.envMode === 1 ? 1 : 0);
    gl.uniform3fv(this.bgUni.uCamRight, look.camRight || [1, 0, 0]);
    gl.uniform3fv(this.bgUni.uCamUp, look.camUp || [0, 1, 0]);
    gl.uniform3fv(this.bgUni.uCamFwd, look.camFwd || [0, 0, -1]);
    gl.uniform1f(this.bgUni.uTanHalfFov, look.tanHalfFov || 0.4);
    gl.uniform1f(this.bgUni.uAspect, width / Math.max(1, height));
    gl.uniform3fv(this.bgUni.uZenith, hexToRgb(style.skyZenith));
    gl.uniform3fv(this.bgUni.uHorizon, hexToRgb(style.skyHorizon));
    gl.uniform3fv(this.bgUni.uGroundCol, hexToRgb(style.skyGround));
    gl.uniform3fv(this.bgUni.uSunDir, normalise(style.lightDir));
    gl.uniform3fv(this.bgUni.uSunColor, hexToRgb(style.sunColor));
    gl.uniform1f(this.bgUni.uSunSize, style.sunSize);
    gl.uniform1f(this.bgUni.uSunIntensity, style.sunIntensity);
    gl.uniform1f(this.bgUni.uHaze, style.haze);
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
    // One switch for every kind of translucency this renderer produces. A
    // dithered fragment is opaque or absent, so the whole class of
    // ordering artifacts — a curve blending through itself, a fringe hiding
    // what is behind it, sorting that can only work between curves and not
    // within one — stops existing rather than being compensated for.
    const dither = style.dither !== false;
    const travelling = (style.travelMode | 0) > 0;
    const travelSoft = travelling && !dither && style.travelSoft > 0.001;
    // Additive blending is commutative, so it never needed sorting; it gives up
    // depth writes on purpose. Everything else is order-dependent only when it
    // actually blends.
    const alphaBlended = !dither && (glass || style.opacity < 0.999);
    const seeThrough = alphaBlended || additive;
    const needsSort = !!style.sortDepth && !!look.viewDir && (alphaBlended || travelSoft);
    if (additive) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
    } else if (alphaBlended) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    }
    // A soft tail over opaque material is drawn in two passes instead; the
    // state for each is set below, at the draw.
    const twoPass = travelSoft && !seeThrough;

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
    // Fog has to be measured from the scene, not from the world origin. The
    // geometry is auto-fitted into the unit ball, so the near edge of whatever
    // is on screen sits at (camera distance - 1) whichever field is loaded and
    // however far out the camera is. An absolute start distance meant the
    // nearest ribbon already carried some fog — a flat wash over everything,
    // with only the remainder left to act as a depth cue — and that it meant
    // something different at every zoom level. fogBegin is now a fraction of
    // the scene's own two-unit depth, so 0 always starts the fade exactly at
    // the front of the subject and the control behaves the same at any zoom.
    const camPos = look.camPos || [0, 0, 3];
    const nearEdge = Math.max(0, Math.hypot(camPos[0], camPos[1], camPos[2]) - 1);
    gl.uniform1f(u.uFogStart, nearEdge + (style.fogBegin || 0) * 2);
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
    gl.uniform1f(u.uTravelPass, 0);

    // Sky model, shared with the background and with the mirror material.
    const env = style.envMode === 1 ? 1 : 0;
    gl.uniform1f(u.uEnvMode, env);
    gl.uniform1f(u.uInscatter, style.inscatter == null ? 0.6 : style.inscatter);
    gl.uniform1f(u.uStrand, style.strand == null ? 0 : style.strand);
    gl.uniform1f(u.uStrandExp, style.strandExp == null ? 48 : style.strandExp);
    gl.uniform1f(u.uStrandShift, style.strandShift == null ? 0.12 : style.strandShift);
    gl.uniform1f(u.uStrandSheen, style.strandSheen == null ? 0.6 : style.strandSheen);
    gl.uniform1f(u.uStrandDiffuse, style.strandDiffuse == null ? 0.5 : style.strandDiffuse);
    gl.uniform1f(u.uOcclusion, style.occlusion == null ? 0 : style.occlusion);
    gl.uniform3fv(u.uCamPos, look.camPos || [0, 0, 3]);
    gl.uniform3fv(u.uZenith, hexToRgb(style.skyZenith));
    gl.uniform3fv(u.uHorizon, hexToRgb(style.skyHorizon));
    gl.uniform3fv(u.uGroundCol, hexToRgb(style.skyGround));
    gl.uniform3fv(u.uSunDir, normalise(style.lightDir));
    gl.uniform3fv(u.uSunColor, hexToRgb(style.sunColor));
    gl.uniform1f(u.uSunSize, style.sunSize);
    gl.uniform1f(u.uSunIntensity, style.sunIntensity);
    gl.uniform1f(u.uHaze, style.haze);

    // Ray-traced visibility. Present only while a sample is being accumulated;
    // the live preview between refinements runs without it.
    const rt = look.rt || null;
    gl.uniform1f(u.uSunShadow, rt && rt.sunVP ? 1 : 0);
    gl.uniform1f(u.uSkyLight, rt && rt.skyVP ? 1 : 0);
    gl.uniform1f(u.uShadowBias, rt ? rt.bias : 0.002);
    if (rt && rt.sunVP) {
      gl.uniformMatrix4fv(u.uSunVP, false, rt.sunVP);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.rt.sun.tex);
      gl.uniform1i(u.uSunMap, 1);
    }
    if (rt && rt.skyVP) {
      gl.uniformMatrix4fv(u.uSkyVP, false, rt.skyVP);
      gl.uniform3fv(u.uSkyDir, rt.skyDir);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.rt.sky.tex);
      gl.uniform1i(u.uSkyMap, 2);
    }
    gl.activeTexture(gl.TEXTURE0);

    if (needsSort) this.sortForView(look.viewDir);

    const drawAll = () => {
      if (style.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
      else gl.disable(gl.CULL_FACE);
      for (const b of this.buffers) {
        bind(gl, b.pos, this.attr.pos, 3);
        bind(gl, b.nor, this.attr.nor, 3);
        bind(gl, b.col, this.attr.col, 3);
        bind(gl, b.par, this.attr.par, 4);
        bind(gl, b.tanb, this.attr.tan, 3);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
        gl.drawElements(b.mode === 'lines' ? gl.LINES : gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0);
      }
    };

    if (twoPass) {
      // Core first: fully opaque, writes depth, no blending. Then the fringe,
      // blended against it with depth test on but depth writes off, so a
      // half-transparent tail neither hides what is behind it nor lets the
      // curve paint over itself.
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1f(u.uTravelPass, 1);
      drawAll();

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(u.uTravelPass, 2);
      // Not culled. Forcing back-face culling here looked like the right fix
      // for a closed form blending through itself, and it introduced a worse
      // artifact: the side quads are non-planar wherever the frame rotates, so
      // seen nearly edge-on one of each quad's two triangles faces away and
      // gets culled while its twin survives — a sawtooth along the whole form.
      // Dither mode is the answer to self-overlap; culling is not.
      drawAll();
    } else {
      gl.uniform1f(u.uTravelPass, 0);
      drawAll();
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

/**
 * Allocate the offscreen targets. Returns false if the driver will not give us
 * a complete framebuffer, which is the caller's cue to fall back to drawing
 * straight to the canvas rather than showing a black screen.
 */
Renderer.prototype.ensureTargets = function ensureTargets(width, height, shadowSize) {
  const gl = this.gl, r = this.rt;
  const sizeChanged = !r.sample || r.sample.width !== width || r.sample.height !== height;
  if (sizeChanged) {
    destroyTarget(gl, r.sample);
    destroyTarget(gl, r.accum[0]);
    destroyTarget(gl, r.accum[1]);
    r.sample = createTarget(gl, width, height, true);
    r.accum[0] = createTarget(gl, width, height, false);
    r.accum[1] = createTarget(gl, width, height, false);
    r.read = 0;
  }
  if (shadowSize && r.shadowSize !== shadowSize) {
    destroyTarget(gl, r.sun);
    destroyTarget(gl, r.sky);
    r.sun = createTarget(gl, shadowSize, shadowSize, true);
    r.sky = createTarget(gl, shadowSize, shadowSize, true);
    r.shadowSize = shadowSize;
  }
  r.ok = !!(r.sample && r.sample.ok && r.accum[0].ok && r.accum[1].ok
    && (!shadowSize || (r.sun.ok && r.sky.ok)));
  return r.ok;
};

/** Depth-only pass from one direction, packed into a colour target. */
Renderer.prototype.renderShadow = function renderShadow(target, lightVP) {
  const gl = this.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
  gl.viewport(0, 0, target.width, target.height);
  gl.disable(gl.BLEND);
  // Cleared to the far plane, so anything the light never reached counts as lit
  // rather than as shadowed.
  gl.clearColor(1, 1, 1, 1);
  gl.depthMask(true);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  // Back faces cast: a closed tube's far wall is the surface the light hits
  // first, and using it moves the depth comparison away from the lit surface,
  // which is most of what stops a ribbon shadowing itself into stripes.
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.FRONT);

  gl.useProgram(this.depthProg);
  gl.uniformMatrix4fv(this.depthUni.uLightVP, false, lightVP);
  for (const b of this.buffers) {
    if (b.mode === 'lines') continue;              // no thickness, casts nothing
    bind(gl, b.pos, this.depthAttr, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0);
  }
  gl.disableVertexAttribArray(this.depthAttr);
  gl.disable(gl.CULL_FACE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
};

Renderer.prototype.drawQuad = function drawQuad(prog, attr) {
  const gl = this.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
  gl.enableVertexAttribArray(attr);
  gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disableVertexAttribArray(attr);
};

/** Fold one rendered sample into the running mean. */
Renderer.prototype.accumulate = function accumulate(sampleIndex) {
  const gl = this.gl, r = this.rt;
  const src = r.accum[r.read], dst = r.accum[1 - r.read];
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
  gl.viewport(0, 0, dst.width, dst.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(this.accumProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src.tex);
  gl.uniform1i(this.accumUni.uPrev, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, r.sample.tex);
  gl.uniform1i(this.accumUni.uSample, 1);
  gl.uniform1f(this.accumUni.uWeight, 1 / (sampleIndex + 1));
  // Only needed once the 1/(n+1) step is smaller than a code value.
  gl.uniform1f(this.accumUni.uDitherAmt, sampleIndex > 8 ? 1 / 255 : 0);
  this.drawQuad(this.accumProg, this.accumAttr);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  r.read = 1 - r.read;
};

/** Tone map the accumulated image onto whatever framebuffer is bound. */
Renderer.prototype.present = function present(style, width, height) {
  const gl = this.gl, r = this.rt;
  gl.viewport(0, 0, width, height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(this.presentProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, r.accum[r.read].tex);
  gl.uniform1i(this.presentUni.uTex, 0);
  gl.uniform1f(this.presentUni.uExposureOut, style.outExposure == null ? 1 : style.outExposure);
  gl.uniform1f(this.presentUni.uToneMap, style.toneMap | 0);
  this.drawQuad(this.presentProg, this.presentAttr);
};

/**
 * One refinement step: shadow maps from this sample's directions, the scene
 * into the sample target, then fold it into the mean. `look` must already
 * carry this sample's jitter.
 */
Renderer.prototype.renderSample = function renderSample(look, style, width, height, sampleIndex, rtCfg, uvRect) {
  const gl = this.gl;
  const lk = { ...look, rt: null };

  if (rtCfg.sunShadow || rtCfg.skyLight) {
    const rt = { bias: rtCfg.bias, sunVP: null, skyVP: null, skyDir: rtCfg.skyDir };
    if (rtCfg.sunShadow) {
      rt.sunVP = lightMatrix(rtCfg.sunDir);
      this.renderShadow(this.rt.sun, rt.sunVP);
    }
    if (rtCfg.skyLight) {
      rt.skyVP = lightMatrix(rtCfg.skyDir);
      this.renderShadow(this.rt.sky, rt.skyVP);
    }
    lk.rt = rt;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.sample.fb);
  this.renderScene(lk, style, width, height, uvRect);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  this.accumulate(sampleIndex);
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

function normalise(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function bind(gl, buf, loc, size) {
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}
