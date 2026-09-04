// shaders.js — GLSL ES 1.00 (WebGL1). Kept as plain strings so the headless
// validator in tools/ can compile the exact source the browser gets.

export const RIBBON_VS = `
precision highp float;

attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec2 aParam;      // x = arclength 0..1, y = per-curve random

uniform mat4 uMVP;
uniform mat4 uModelView;
uniform mat3 uNormalMat;

varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vViewPos;
varying vec2 vParam;

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
varying vec2 vParam;

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

void main() {
  vec3 base = vColor;

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
  }

  float depth = max(0.0, -vViewPos.z - uFogStart);
  float fog = 1.0 - exp(-depth * uFogDensity);
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));
  color *= uExposure;

  gl_FragColor = vec4(color, uOpacity);
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
