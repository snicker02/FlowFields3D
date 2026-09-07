// shaders.js — GLSL ES 1.00 (WebGL1). Kept as plain strings so the headless
// validator in tools/ can compile the exact source the browser gets.

export const RIBBON_VS = `
precision highp float;

attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec3 aParam;      // x = arclength 0..1, y = per-curve random, z = across the form 0..1

uniform mat4 uMVP;
uniform mat4 uModelView;
uniform mat3 uNormalMat;

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vViewPos;
varying vec3 vParam;

void main() {
  vNormal = uNormalMat * aNormal;
  vec4 mv = uModelView * vec4(aPos, 1.0);
  vViewPos = mv.xyz;
  vColor = aColor;
  vParam = aParam;
  gl_Position = uMVP * vec4(aPos, 1.0);
}
`;

export const RIBBON_FS = `
precision highp float;

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vViewPos;
varying vec3 vParam;

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
    if (uTravelPass > 1.5) {                       // fringe pass
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
    vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
    float spec = pow(max(dot(N, H), 0.0), uShininess) * uSpecular;
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5) * uRim;

    color = base * (uAmbient * hemi + ndl * uLightColor);
    color += spec * uLightColor;
    color += rim * mix(base, uSkyColor, 0.5);

    if (uMaterial > 0.5) {
      // No cube map and no scene sampling in a WebGL1 single pass, so the
      // environment is the same sky/ground the ambient term already uses,
      // sampled along the reflected view vector. Multiplying by uNormalMat on
      // the right transposes it, taking the reflection back into world space so
      // the mirror stays put while the camera orbits.
      vec3 R = reflect(-V, N);
      vec3 wR = R * uNormalMat;
      vec3 env = mix(uGroundColor, uSkyColor, clamp(wR.y * 0.5 + 0.5, 0.0, 1.0));
      env += uLightColor * pow(max(dot(R, L), 0.0), 96.0) * 2.0;
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
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));
  color *= uExposure;

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
varying vec2 vUV;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform float uVignette;
void main() {
  vec3 c = mix(uBottom, uTop, vUV.y);
  vec2 d = vUV - 0.5;
  float v = 1.0 - uVignette * dot(d, d) * 2.0;
  gl_FragColor = vec4(c * clamp(v, 0.0, 1.0), 1.0);
}
`;
