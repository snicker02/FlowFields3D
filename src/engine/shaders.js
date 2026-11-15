// shaders.js — GLSL ES 1.00 (WebGL1). Kept as plain strings so the headless
// validator in tools/ can compile the exact source the browser gets.


// Shared GLSL, pasted into more than one program so the sky the background
// draws, the sky a mirror reflects, and the sky that lights the geometry are
// the same function rather than three that drift apart.
const SKY_GLSL = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundCol;
uniform vec3 uSunDir;        // world space, normalised
uniform vec3 uSunColor;
uniform float uSunSize;      // angular radius, degrees
uniform float uSunIntensity;
uniform float uHaze;         // how far the horizon band bleeds into the sky

vec3 skyRadiance(vec3 dir) {
  float y = clamp(dir.y, -1.0, 1.0);
  // Horizon band, widened by haze. pow() on the upper half keeps the gradient
  // tight near the horizon and slow toward the zenith, which is how a real sky
  // reads; a plain mix looks like a backdrop.
  float up = pow(clamp(y, 0.0, 1.0), max(0.05, 1.0 - uHaze * 0.85));
  vec3 col = mix(uHorizon, uZenith, up);
  float down = clamp(-y / max(0.05, 0.35 + uHaze * 0.4), 0.0, 1.0);
  col = mix(col, uGroundCol, down);

  // Sun disc with a soft limb, plus a wide forward-scattering halo.
  float cosA = dot(dir, uSunDir);
  float r = cos(radians(max(0.05, uSunSize)));
  float disc = smoothstep(r - 0.0015, r + 0.0015, cosA);
  float halo = pow(max(cosA, 0.0), 180.0) * 0.5 + pow(max(cosA, 0.0), 8.0) * 0.06;
  col += uSunColor * (disc * uSunIntensity + halo * uSunIntensity * 0.35);
  return col;
}
`;

// Depth packed into RGBA8. WEBGL_depth_texture is not universal in WebGL1 and
// a missing extension here would mean no shadows at all on those machines, so
// the depth goes into an ordinary colour target instead.
const PACK_GLSL = `
vec4 packDepth(float d) {
  vec4 enc = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * d);
  enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return enc;
}
float unpackDepth(vec4 c) {
  return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
`;

// Visibility from a packed-depth shadow map. The geometry is auto-fitted into
// the unit ball before it is drawn, so the light's orthographic box is always
// the same known size — no cascades, no fitting, no surprises.
const SHADOW_GLSL = `
float shadowVis(sampler2D map, mat4 lightVP, vec3 world, float bias) {
  vec4 c = lightVP * vec4(world, 1.0);
  vec3 q = c.xyz / c.w * 0.5 + 0.5;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0 || q.z > 1.0) return 1.0;
  float d = unpackDepth(texture2D(map, q.xy));
  return q.z - bias <= d ? 1.0 : 0.0;
}
`;

export const RIBBON_VS = `
precision highp float;

attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec4 aParam;      // x = arclength 0..1, y = per-curve random, z = across the form 0..1, w = occlusion
attribute vec3 aTangent;    // the curve direction, for the strand highlight

uniform mat4 uMVP;
uniform mat4 uModelView;
uniform mat3 uNormalMat;

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vViewPos;
varying vec4 vParam;
varying vec3 vWorld;
varying vec3 vTangent;

void main() {
  vNormal = uNormalMat * aNormal;
  vec4 mv = uModelView * vec4(aPos, 1.0);
  vViewPos = mv.xyz;
  vColor = aColor;
  vParam = aParam;
  vTangent = uNormalMat * aTangent;
  vWorld = aPos;        // the model matrix is identity: positions are already world
  gl_Position = uMVP * vec4(aPos, 1.0);
}
`;

export const RIBBON_FS = `
precision highp float;
${PACK_GLSL}
${SHADOW_GLSL}
${SKY_GLSL}

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vViewPos;
varying vec4 vParam;
varying vec3 vWorld;
varying vec3 vTangent;

// Shared with the vertex stage: the mirror needs it to get back to world space.
uniform mat3 uNormalMat;
uniform vec3 uLightDir;      // view space, pointing at the light
uniform vec3 uLightColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform float uSpecular;
uniform float uShininess;
uniform float uRim;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogStart;
uniform float uFlowPhase;
uniform float uFlowFreq;
uniform float uFlowStrength;
uniform float uOpacity;
uniform float uFlat;         // 1.0 = unlit (line / ink mode)
uniform float uExposure;
uniform float uMaterial;     // 0 satin, 1 mirror, 2 glass
uniform float uTexMode;      // 0 none, then bands / stripes / checker / weave / dots / grain / hatch
uniform float uTexScale;     // repeats along the curve
uniform float uTexRepeat;    // repeats across the form
uniform float uTexAmount;
uniform float uTexSoft;
uniform sampler2D uTexImage;
uniform float uTexHasImage;

// Ray-traced lighting. Each accumulated sample jitters the sun inside its own
// angular size and picks one direction for the sky, so soft shadows and
// ambient occlusion converge from real visibility tests rather than being
// faked with a blur or a screen-space guess.
uniform float uSunShadow;    // 0 off, 1 on
uniform mat4 uSunVP;
uniform sampler2D uSunMap;
uniform float uSkyLight;     // 0 off, 1 on
uniform mat4 uSkyVP;
uniform sampler2D uSkyMap;
uniform vec3 uSkyDir;        // the one direction sampled this pass, world space
uniform float uShadowBias;
uniform float uEnvMode;      // 0 flat colours, 1 the sky model
uniform vec3 uCamPos;        // world, for the view ray the in-scatter needs
uniform float uInscatter;

// Strand shading. A ribbon traced along a streamline is a fibre, and a fibre's
// highlight runs along its length, not around a surface normal — the normal of
// a thin strand is barely defined in the direction that matters. Kajiya-Kay
// replaces the half-vector term with one built from the tangent, which is why
// hair and brushed metal look like hair and brushed metal rather than plastic
// tubing. The shift gives the second, offset highlight that reads as sheen.
uniform float uStrand;       // 0 plain Blinn-Phong, 1 fully anisotropic
uniform float uStrandExp;
uniform float uStrandShift;
uniform float uStrandSheen;
uniform float uStrandDiffuse;
uniform float uOcclusion;    // how hard the baked occlusion bites
uniform float uTravelMode;   // 0 off, 1 comet, 2 dashes, 3 wipe
uniform float uTravelLen;    // fraction of the curve that is lit
uniform float uTravelPhase;
uniform float uTravelSoft;
uniform float uTravelStagger;
uniform float uTravelCount;  // dashes per curve
uniform float uTravelGlow;   // extra brightness at the leading edge
// 0 = draw the whole window in one pass. 1 = the opaque core only. 2 = the
// soft fringe only. A long soft tail cannot be drawn correctly in one pass:
// with depth writes on, the half-transparent fringe occludes whatever is
// behind it; with them off, a curve paints over itself. Splitting the two
// lets the core write depth and the fringe blend against it.
uniform float uTravelPass;
uniform float uDither;        // 1 = stochastic cutout instead of blending

// Interleaved gradient noise (Jimenez). A dither threshold with no lookup
// table and no integer bit operations, neither of which GLSL ES 1.0 offers.
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// Deliberately built from sines and smoothstep rather than step() and fwidth():
// derivatives need GL_OES_standard_derivatives, which WebGL1 does not promise,
// and a hard step on a ribbon a few pixels wide aliases into noise.
float band(float x, float soft) {
  return smoothstep(-soft, soft, sin(x * 6.2831853));
}

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

float patternAt(float u, float w) {
  float soft = max(0.02, uTexSoft);
  if (uTexMode < 1.5) return band(u, soft);                                  // cross bands
  if (uTexMode < 2.5) return band(w, soft);                                  // lengthwise stripes
  if (uTexMode < 3.5) return band(u, soft) * band(w, soft)                   // checker
                           + (1.0 - band(u, soft)) * (1.0 - band(w, soft));
  if (uTexMode < 4.5) {                                                      // weave
    float a = band(u, soft), b = band(w, soft);
    return mix(a, b, 0.5) * 0.6 + abs(a - b) * 0.4;
  }
  if (uTexMode < 5.5) {                                                      // dots
    vec2 g = vec2(fract(u) - 0.5, fract(w) - 0.5);
    return smoothstep(0.34, 0.34 - soft * 0.5, length(g));
  }
  if (uTexMode < 6.5) return valueNoise(vec2(u, w) * 3.0);                   // grain
  return band(u + w, soft);                                                  // diagonal hatch
}

void main() {
  float alpha = uOpacity;
  vec3 base = vColor;

  // Travel: reveal a moving window of each curve rather than the whole thing.
  // A streamline is the path a particle takes through the field, so walking a
  // window along it is not a decoration — it is the motion the field describes,
  // and it costs one uniform per frame because the geometry never changes.
  float head = 0.0;
  float lit = 1.0;
  if (uTravelMode > 0.5) {
    float phase = uTravelPhase + vParam.y * uTravelStagger;
    float len = max(0.004, uTravelLen);
    if (uTravelMode < 1.5) {                       // comet: one head, one tail
      float behind = fract(fract(phase) - vParam.x + 1.0);
      lit = 1.0 - smoothstep(len * (1.0 - uTravelSoft), len, behind);
      head = 1.0 - clamp(behind / len, 0.0, 1.0);
    } else if (uTravelMode < 2.5) {                // dashes marching along
      float b = fract((vParam.x - phase) * max(1.0, uTravelCount));
      lit = 1.0 - smoothstep(len * (1.0 - uTravelSoft), len, b);
      head = 1.0 - clamp(b / len, 0.0, 1.0);
    } else {                                       // wipe: draws itself, repeats
      float front = fract(phase);
      lit = 1.0 - smoothstep(front, front + max(0.002, uTravelSoft * 0.25), vParam.x);
      head = 1.0 - clamp((front - vParam.x) / len, 0.0, 1.0);
    }
    if (lit < 0.02) discard;                       // keeps the depth buffer clean
    if (uDither > 0.5) {
      alpha *= lit;                                // resolved at the end
    } else if (uTravelPass > 1.5) {                // fringe pass
      if (lit > 0.999) discard;
      alpha *= lit;
    } else if (uTravelPass > 0.5) {                // opaque core pass
      if (lit <= 0.999) discard;
    } else {
      alpha *= lit;
    }
  }

  if (uTexMode > 7.5 && uTexHasImage > 0.5 && uTexAmount > 0.001) {
    // A loaded image, wrapped along and across the ribbon.
    vec2 uv = vec2(vParam.x * uTexScale + vParam.y * 3.7, vParam.z * uTexRepeat);
    vec3 tex = texture2D(uTexImage, uv).rgb;
    base = mix(base, base * tex * 2.0, uTexAmount);
  } else if (uTexMode > 0.5 && uTexMode < 7.5 && uTexAmount > 0.001) {
    // The per-curve random offsets the pattern so neighbouring ribbons do not
    // line up into a single sheet.
    float u = vParam.x * uTexScale + vParam.y * 3.7;
    float w = vParam.z * uTexRepeat;
    float m = clamp(patternAt(u, w), 0.0, 1.0);
    base *= 1.0 - uTexAmount * (1.0 - m);
  }

  // travelling highlight along each curve — cheap animation that needs no retrace
  if (uFlowStrength > 0.0) {
    float m = 0.5 + 0.5 * cos((vParam.x * uFlowFreq - uFlowPhase + vParam.y) * 6.2831853);
    base *= mix(1.0, 0.25 + 1.5 * m, uFlowStrength);
  }

  vec3 color;
  if (uFlat > 0.5) {
    color = base;
  } else {
    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(-vViewPos);
    vec3 L = normalize(uLightDir);
    vec3 H = normalize(L + V);

    float ndl = max(dot(N, L), 0.0);

    // Kajiya-Kay. sin of the angle between the tangent and the light, and the
    // same for the view: their combination is cos of the angle between the
    // reflected cone and the eye, which is the highlight.
    vec3 T = normalize(vTangent);
    vec3 Tsh = normalize(T + N * uStrandShift);
    float tdl = dot(Tsh, L), tdv = dot(Tsh, V);
    float sinTL = sqrt(max(0.0, 1.0 - tdl * tdl));
    float sinTV = sqrt(max(0.0, 1.0 - tdv * tdv));
    float aniso = pow(max(0.0, tdl * tdv + sinTL * sinTV), max(1.0, uStrandExp));
    // A second lobe shifted the other way, tinted by the strand's own colour,
    // is the cheap stand-in for light that went through the fibre and came back.
    vec3 Tsh2 = normalize(T - N * uStrandShift * 1.6);
    float tdl2 = dot(Tsh2, L), tdv2 = dot(Tsh2, V);
    float aniso2 = pow(max(0.0, tdl2 * tdv2
      + sqrt(max(0.0, 1.0 - tdl2 * tdl2)) * sqrt(max(0.0, 1.0 - tdv2 * tdv2))),
      max(1.0, uStrandExp * 0.35));
    // Strand diffuse: brightest side-on to the light, which is how a cylinder
    // actually scatters, and it does not collapse where the normal is unreliable.
    float strandDiff = sinTL;
    vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
    float spec = pow(max(dot(N, H), 0.0), uShininess) * uSpecular;
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5) * uRim;

    // Sun visibility. One shadow test against a map rendered from the sun's
    // jittered direction: over many samples the penumbra is the real one, the
    // width set by the sun's angular size rather than by a filter kernel.
    float sunVis = 1.0;
    if (uSunShadow > 0.5) sunVis = shadowVis(uSunMap, uSunVP, vWorld, uShadowBias);

    // Sky light. Directions are sampled uniformly over the whole sphere, so one
    // map serves every surface orientation; the cosine and the factor of four
    // are the estimator, and it averages to 1 for an unoccluded white sky,
    // which is exactly what the hemisphere term it replaces gives.
    vec3 ambientTerm = base * uAmbient * hemi;
    if (uSkyLight > 0.5) {
      vec3 sdv = normalize(uNormalMat * uSkyDir);
      float cosNS = max(dot(N, sdv), 0.0);
      float skyVis = shadowVis(uSkyMap, uSkyVP, vWorld, uShadowBias);
      vec3 sky = uEnvMode > 0.5 ? skyRadiance(uSkyDir) : mix(uGroundColor, uSkyColor, uSkyDir.y * 0.5 + 0.5);
      ambientTerm = base * uAmbient * sky * 4.0 * cosNS * skyVis;
    }

    // Baked occlusion, measured from the geometry itself rather than from a
    // shadow map or the screen. It darkens the ambient only, which is what
    // occlusion physically is.
    float ao = 1.0 - uOcclusion * vParam.w;
    ambientTerm *= ao;

    float diff = mix(ndl, strandDiff, uStrand * uStrandDiffuse);
    color = ambientTerm + base * diff * uLightColor * sunVis;
    vec3 strandSpec = uLightColor * aniso + base * uSpecular * aniso2 * uStrandSheen;
    color += mix(spec * uLightColor, strandSpec * uSpecular * 2.0, uStrand) * sunVis;
    color += rim * mix(base, uSkyColor, 0.5);

    if (uMaterial > 0.5) {
      // No cube map and no scene sampling in a WebGL1 single pass, so the
      // environment is the same sky/ground the ambient term already uses,
      // sampled along the reflected view vector. Multiplying by uNormalMat on
      // the right transposes it, taking the reflection back into world space so
      // the mirror stays put while the camera orbits.
      vec3 R = reflect(-V, N);
      vec3 wR = R * uNormalMat;
      vec3 env = uEnvMode > 0.5
        ? skyRadiance(wR)
        : mix(uGroundColor, uSkyColor, clamp(wR.y * 0.5 + 0.5, 0.0, 1.0))
          + uLightColor * pow(max(dot(R, L), 0.0), 96.0) * 2.0;
      float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);

      if (uMaterial < 1.5) {
        vec3 chrome = env * mix(base, vec3(1.0), 0.45);
        color = mix(chrome, env, fres * 0.8) + spec * uLightColor;
      } else {
        vec3 through = base * (uAmbient * hemi + ndl * uLightColor) * 0.55;
        color = through + env * (0.15 + 0.85 * fres) + spec * uLightColor * 1.5;
        alpha *= mix(0.16, 1.0, fres);
      }
    }
  }

  if (uTravelMode > 0.5 && uTravelGlow > 0.0) {
    color += color * head * head * uTravelGlow;
  }

  float depth = max(0.0, -vViewPos.z - uFogStart);
  float fog = 1.0 - exp(-depth * uFogDensity);
  vec3 fogCol = uFogColor;
  if (uEnvMode > 0.5) {
    // In-scatter: haze looking toward the sun is brighter and takes the sun's
    // colour, which is what gives distance its depth instead of a flat wash.
    vec3 vdir = normalize(vWorld - uCamPos);
    float toSun = max(dot(vdir, uSunDir), 0.0);
    fogCol = mix(uFogColor, uSunColor * uSunIntensity * 0.35 + uHorizon, pow(toSun, 3.0) * uInscatter);
  }
  color = mix(color, fogCol, clamp(fog, 0.0, 1.0));
  color *= uExposure;

  // Stochastic cutout: keep or drop the whole fragment against a dither
  // threshold instead of blending it. Every surviving fragment is opaque, so
  // depth writes stay on and nothing depends on draw order — no self-overlap,
  // no sorting, no culling, no passes. Translucency dissolves into a stipple
  // that resolves to a smooth result under antialiasing or supersampling.
  if (uDither > 0.5) {
    if (alpha < ign(gl_FragCoord.xy)) discard;
    alpha = 1.0;
  }

  gl_FragColor = vec4(color, alpha);
}
`;

export const BG_VS = `
precision highp float;
attribute vec2 aXY;
varying vec2 vUV;
// Which part of the finished image this draw covers: xy = offset, zw = size.
// (0,0,1,1) for the live view; a sub-rectangle when a big export is being
// rendered in tiles, so the gradient and vignette span the whole picture
// instead of restarting in every tile.
uniform vec4 uUVRect;
void main() {
  vUV = (aXY * 0.5 + 0.5) * uUVRect.zw + uUVRect.xy;
  gl_Position = vec4(aXY, 0.999, 1.0);
}
`;

export const BG_FS = `
precision highp float;
${SKY_GLSL}
varying vec2 vUV;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uVignette;
uniform float uEnvMode;      // 0 the old vertical gradient, 1 the sky model
// Camera basis, so a view ray can be rebuilt per pixel without an inverse
// matrix. vUV is already the coordinate of the whole image, so this stays
// correct when a big export is rendered one tile at a time.
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;

void main() {
  vec3 c;
  if (uEnvMode > 0.5) {
    vec2 ndc = vUV * 2.0 - 1.0;
    vec3 dir = normalize(uCamFwd
      + uCamRight * ndc.x * uTanHalfFov * uAspect
      + uCamUp * ndc.y * uTanHalfFov);
    c = skyRadiance(dir);
  } else {
    c = mix(uBottom, uTop, vUV.y);
  }
  vec2 d = vUV - 0.5;
  float v = 1.0 - uVignette * dot(d, d) * 2.0;
  gl_FragColor = vec4(c * clamp(v, 0.0, 1.0), 1.0);
}
`;

// Shadow pass. Depth only, packed into RGBA8.
export const DEPTH_VS = `
precision highp float;
attribute vec3 aPos;
uniform mat4 uLightVP;
void main() { gl_Position = uLightVP * vec4(aPos, 1.0); }
`;

export const DEPTH_FS = `
precision highp float;
${PACK_GLSL}
void main() { gl_FragColor = packDepth(gl_FragCoord.z); }
`;

// Full-screen pass, shared by the accumulator and the presenter.
export const QUAD_VS = `
precision highp float;
attribute vec2 aXY;
varying vec2 vUV;
void main() {
  vUV = aXY * 0.5 + 0.5;
  gl_Position = vec4(aXY, 0.0, 1.0);
}
`;

// Running mean of every sample so far. Weighting by 1/(n+1) rather than
// summing keeps the buffer in range without needing a float target, which
// WebGL1 cannot promise. The dither is there because an 8-bit buffer quantises
// the increment to nothing once n gets large, and without it the image stops
// converging in flat areas and bands instead.
export const ACCUM_FS = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uPrev;
uniform sampler2D uSample;
uniform float uWeight;
uniform float uDitherAmt;

float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  vec3 prev = texture2D(uPrev, vUV).rgb;
  vec3 cur = texture2D(uSample, vUV).rgb;
  vec3 outc = mix(prev, cur, uWeight);
  outc += (ign(gl_FragCoord.xy) - 0.5) * uDitherAmt;
  gl_FragColor = vec4(outc, 1.0);
}
`;

// Present. Tone mapping happens here, after accumulation, so highlights are
// averaged in linear light and compressed once rather than clipped per sample.
export const PRESENT_FS = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uExposureOut;
uniform float uToneMap;      // 0 none, 1 filmic (ACES fit), 2 Reinhard

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 col = texture2D(uTex, vUV).rgb * uExposureOut;
  if (uToneMap > 1.5) col = col / (1.0 + col);
  else if (uToneMap > 0.5) col = aces(col);
  gl_FragColor = vec4(col, 1.0);
}
`;
