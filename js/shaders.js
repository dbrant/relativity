/* shaders.js — GLSL for the relativistic renderer.
 *
 * The vertex shader answers one question per vertex: light that is arriving at
 * my eye right now, from this piece of the world — which direction did it come
 * from, and what happened to it on the way?
 *
 *   1. Walk back down the past light cone to find WHEN the light left (the
 *      retarded time). For static scenery that is just distance / c; for the
 *      moving props it needs a short Newton solve.
 *   2. Take the null 4-vector (-r/c, r) from that emission event to the eye and
 *      Lorentz-boost it into the observer's instantaneous rest frame. Everything
 *      visual falls out of this one step: aberration, Lorentz contraction, and
 *      Terrell rotation (which is not really a rotation — it is what light
 *      delay does to a contracted object, and you get it for free here).
 *   3. The boost also rescales that null vector, and the ratio IS the Doppler
 *      factor. No separate formula needed.
 */
(function (R) {
  'use strict';

  const VERT = `#version 300 es
precision highp float;

in vec3 aPos;      // rest-frame position (world position for static geometry)
in vec3 aNormal;
in vec3 aColor;
in vec3 aMat;      // x = material kind, y = motion phase, z = blink phase
in vec2 aUV;

uniform mat4  uProj;
uniform mat3  uViewRot;
uniform vec3  uObsPos;     // observer position, world frame, at observation time
uniform vec3  uBetaDir;    // unit vector along the observer's velocity
uniform float uBetaMag;    // |v| / c
uniform float uGamma;      // Lorentz factor
uniform float uC;          // speed of light, m/s
uniform float uT;          // world-frame time of observation
uniform float uLogDepthC;
uniform float uUseDelay;   // 1 = finite light speed, 0 = see everything instantly
uniform float uUseAberr;   // 1 = boost apparent positions into the moving frame
uniform vec3  uOffset;     // rigid shift, so the ground disc can follow the eye

uniform vec4 uMotionA;     // carousel (cx,cy,cz, trackRadius) | shuttle (bx,by,bz, amplitude)
uniform vec4 uMotionB;     // (omega, restGamma, boundRadius, -)

out vec3  vWorldPos;
out vec3  vNormal;
out vec3  vColor;
out vec3  vMat;
out vec2  vUV;
out vec3  vViewDir;
out float vD;
out float vTEmit;
out float vDist;
out float vLogZ;

/* Where this vertex is, and how fast it is going, at world time t. */
#if MOTION == 0
void motionAt(float t, out vec3 p, out vec3 v, out vec3 n) {
  p = aPos + uOffset; v = vec3(0.0); n = aNormal;
}
#elif MOTION == 1
// Carousel. aPos is the car-local offset: x along the track, y up, z outward.
void motionAt(float t, out vec3 p, out vec3 v, out vec3 n) {
  float om = uMotionB.x, Rt = uMotionA.w, g = uMotionB.y;
  float th = om * t + aMat.y;
  vec3 rdl = vec3(cos(th), 0.0, sin(th));
  vec3 tng = vec3(-sin(th), 0.0, cos(th));
  // Each car is length-contracted along its own motion in the world frame.
  vec3 loc = vec3(aPos.x / g, aPos.y, aPos.z);
  p = uMotionA.xyz + Rt * rdl + tng * loc.x + vec3(0.0, loc.y, 0.0) + rdl * loc.z;
  v = om * (tng * (Rt + loc.z) - rdl * loc.x);
  n = tng * aNormal.x + vec3(0.0, aNormal.y, 0.0) + rdl * aNormal.z;
}
#else
// Shuttle: slides back and forth along world X. Its contraction breathes with
// its speed, which is the whole point of watching it.
void motionAt(float t, out vec3 p, out vec3 v, out vec3 n) {
  float om = uMotionB.x, A = uMotionA.w;
  float ph = om * t + aMat.y;
  float s  = A * sin(ph);
  float sd = A * om * cos(ph);
  float b  = clamp(abs(sd) / uC, 0.0, 0.99999);
  float g  = inversesqrt(max(1.0 - b * b, 1e-10));
  p = uMotionA.xyz + vec3(s + aPos.x / g, aPos.y, aPos.z);
  v = vec3(sd, 0.0, 0.0);
  n = aNormal;
}
#endif

/* Solve  g(a) = a - |p(t - a) - eye| / c = 0  for the light-travel delay.
 *
 * Newton on its own is not safe here. g'(a) = 1 + (v.n)/c, and the corners of a
 * carousel car travel at 0.857c — faster than the track, because the car has
 * width — so g' can fall to 0.14. One step then flings the iterate most of the
 * way around the orbit, and since every vertex solves independently, neighbours
 * land on completely different revolutions. That is what the dancing triangles
 * were.
 *
 * So bracket it. Every point of a mover stays within uMotionB.z of its reference
 * point, which traps the delay in [(d - bound)/c, (d + bound)/c]; and g is
 * strictly increasing because |v| < c always. Bisection therefore cannot fail,
 * and Newton is used only when it lands inside the bracket, to make it quick.
 */
float solveDelay() {
  vec3 p, v, n;
#if MOTION == 0
  motionAt(uT, p, v, n);
  return length(p - uObsPos) / uC;
#else
  float d  = length(uMotionA.xyz - uObsPos);
  float lo = max(0.0, (d - uMotionB.z) / uC);
  float hi = (d + uMotionB.z) / uC;
  float a = 0.5 * (lo + hi);
  float best = a, bestErr = 1e30;
  for (int i = 0; i < 24; ++i) {
    motionAt(uT - a, p, v, n);
    vec3 r = p - uObsPos;
    float rl = max(length(r), 1e-5);
    float g = a - rl / uC;

    // Keep the best point we have actually EVALUATED. Returning the next
    // candidate instead meant returning a number no one had checked.
    if (abs(g) < bestErr) { bestErr = abs(g); best = a; }

    if (g > 0.0) hi = a; else lo = a;
    float gp = 1.0 + dot(v, r / rl) / uC;
    float an = a - g / max(gp, 0.05);

    // Bounds inclusive. Once Newton converges its candidate IS the bracket
    // endpoint it just set, and a strict test rejected it there and bisected a
    // bracket whose far end had never moved — throwing a converged answer away
    // and landing seconds off, which is what tore the mesh into spikes.
    a = (an >= lo && an <= hi) ? an : 0.5 * (lo + hi);
  }
  return max(best, 0.0);
#endif
}

void main() {
  float a = solveDelay() * uUseDelay;

  vec3 p, v, n;
  motionAt(uT - a, p, v, n);

  vec3  r  = p - uObsPos;
  float rl = max(length(r), 1e-4);
  vec3  rh = r / rl;

  // Doppler contributed by the source's own motion.
  float dSrc = 1.0;
#if MOTION != 0
  float b2 = clamp(dot(v, v) / (uC * uC), 0.0, 0.9999);
  float gu = inversesqrt(1.0 - b2);
  dSrc = 1.0 / max(gu * (1.0 + dot(v, rh) / uC), 1e-3);
#endif

  // Boost the null vector (ct, r), with ct = -rl, into the observer's frame.
  vec3  rObs = r;
  float dObs = 1.0;
  if (uBetaMag > 1e-6) {
    float rPar  = dot(r, uBetaDir);
    vec3  rPerp = r - rPar * uBetaDir;
    float rParN = uGamma * (rPar + uBetaMag * rl);
    float rlN   = uGamma * (rl   + uBetaMag * rPar);
    dObs = rlN / rl;
    if (uUseAberr > 0.5) rObs = rPerp + rParN * uBetaDir;
  }

  vWorldPos = p;
  vNormal   = n;
  vColor    = aColor;
  vMat      = aMat;
  vUV       = aUV;
  vViewDir  = -rh;
  vD        = dObs * dSrc;
  vTEmit    = uT - a;
  vDist     = rl;

  gl_Position = uProj * vec4(uViewRot * rObs, 1.0);

  /* Logarithmic depth, because the apparent scene spans metres to tens of
   * kilometres. Written here for clipping, but RESOLVED PER FRAGMENT: log2 is
   * strongly curved, and interpolating it from the corners is only right while
   * triangles are shallow. The retarded image of a fast mover seen close up has
   * triangles spanning metres of depth, where the interpolation error reaches
   * 7e-3 in NDC — about a hundred thousand times what a 24-bit buffer resolves —
   * and near and far surfaces of the same object get ordered wrongly. That is
   * what let wedges of the far side punch out through the near flank.
   *
   * w is linear in eye space, so a perspective-correct varying recovers it
   * exactly at each fragment. */
  vLogZ = 1.0 + gl_Position.w;
  gl_Position.z = (log2(max(1e-6, vLogZ)) * uLogDepthC - 1.0) * gl_Position.w;
}
`;

  /* Shared fragment prelude: Doppler recolouring, beaming, tone mapping. */
  const FRAG_COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec3  vWorldPos;
in vec3  vNormal;
in vec3  vColor;
in vec3  vMat;
in vec2  vUV;
in vec3  vViewDir;
in float vD;
in float vTEmit;
in float vDist;
in float vLogZ;

uniform vec3  uObsPos;
uniform vec3  uSunDir;
uniform vec3  uSunTint;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uHaze;
uniform float uFogDensity;

uniform sampler2D uLut;
uniform int   uLutN;
uniform float uLutLogMin;
uniform float uLutLogMax;

uniform float uDopplerOn;
uniform float uBeamOn;
uniform float uBeamExp;
uniform float uExposure;
uniform float uBeaconRate;
uniform float uLogDepthC;
uniform vec3  uBandColor;
uniform float uBandWidth;
uniform sampler2D uTex;
uniform float uTexReady;

out vec4 fragColor;

/* The tabulated colour transform: what a surface's spectrum looks like after a
 * Doppler shift by D, integrated against the CIE colour matching functions. */
mat3 dopplerMatrix(float D) {
  float u = (log(max(D, 1e-6)) - uLutLogMin) / (uLutLogMax - uLutLogMin) * float(uLutN - 1);
  u = clamp(u, 0.0, float(uLutN - 1));
  int i0 = int(floor(u));
  int i1 = min(i0 + 1, uLutN - 1);
  float f = u - float(i0);
  mat3 m;
  for (int j = 0; j < 3; ++j) {
    vec3 row = mix(texelFetch(uLut, ivec2(i0, j), 0).rgb,
                   texelFetch(uLut, ivec2(i1, j), 0).rgb, f);
    m[0][j] = row.x; m[1][j] = row.y; m[2][j] = row.z;
  }
  return m;
}

vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/* Radiance leaving the source -> pixel on screen. */
vec4 present(vec3 radiance) {
  vec3 col = radiance;
  if (uDopplerOn > 0.5) col = dopplerMatrix(vD) * col;
  // Relativistic beaming: bolometric intensity goes as D^4.
  if (uBeamOn > 0.5) col *= pow(max(vD, 1e-4), uBeamExp);
  col = max(col, vec3(0.0)) * uExposure;
  return vec4(pow(acesFilm(col), vec3(1.0 / 2.2)), 1.0);
}

float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; ++i) { s += a * vnoise(p); p = p * 2.03 + 19.7; a *= 0.5; }
  return s;
}
`;

  const FRAG_WORLD = FRAG_COMMON + `
/* Stripes measured in world metres, so both staves are banded identically and
 * every edge is sharp and every band the same width. Vertex colours could not do
 * that: a band edge only landed where a vertex happened to be, and interpolation
 * then smeared it across a whole segment — 42% of a band.
 *
 * The width of the smoothstep is one screen pixel via fwidth, so the edge stays
 * crisp up close and averages to flat colour far away instead of shimmering. */
float bandMask(float u) {
  float t = u / uBandWidth;
  float w = max(fwidth(t), 1e-5);
  float s = abs(fract(t * 0.5) - 0.5) * 2.0;
  return smoothstep(0.5 - w, 0.5 + w, s);
}

/* Antialiased grid lines, measured in real metres on the ground. */
float gridLine(vec2 p, float step) {
  vec2 c = p / step;
  vec2 w = max(fwidth(c), 1e-5);
  vec2 d = abs(fract(c - 0.5) - 0.5) / w;
  float fade = clamp(1.4 - max(w.x, w.y) * 1.1, 0.0, 1.0);
  return (1.0 - clamp(min(d.x, d.y), 0.0, 1.0)) * fade;
}

void main() {
  /* A surface emits only into the hemisphere its normal faces, so one that was
   * turned away from you when it emitted sent you nothing to see.
   *
   * But it is still THERE, and still opaque. Each face is imaged at its own
   * retarded time, so a fast mover's faces stop sharing a silhouette and a face
   * can turn away partway across itself — over the 1.9 s its light takes to
   * cross, the shuttle can pass you. Discarding such a face let the world show
   * straight through the hull, which is a worse lie than any shading error: the
   * light is missing, the object is not.
   *
   * So it is drawn as what it is — the unlit inside of a solid thing: ambient
   * only, no sun, no livery. Keyed on the line of sight rather than
   * gl_FrontFacing, which also covers imported meshes whose winding is a
   * convention rather than a guarantee. */
  vec3 N = normalize(vNormal);
  bool interior = dot(N, vViewDir) < 0.0;
  if (interior) N = -N;

  float kind = vMat.x;
  vec3 base = vColor;
  bool beacon = (kind > 1.5 && kind < 2.5);

  // A beacon's lamp glass is nearly black when it is dark, so the flash reads
  // as a flash rather than as a bright object getting slightly brighter. Its
  // vertex colour is kept for the light it emits, not for the glass.
  if (beacon) base = vec3(0.012);

  /* A decal, mapped once per face with its aspect preserved, so it reads as a
   * panel applied to the vehicle rather than a skin stretched over it. Sampled
   * outside the branch: texture() needs uniform control flow to keep its
   * implicit derivatives, and therefore its mip level, well defined. */
  vec3 decal = texture(uTex, vec2(vUV.x, 1.0 - vUV.y)).rgb;
  if (kind > 8.5 && kind < 9.5 && uTexReady > 0.5 && !interior) {
    vec2 g = step(vec2(0.0), vUV) * step(vUV, vec2(1.0));
    base = mix(base, decal, g.x * g.y);
  }

  // Surveyor's banding, along X or along Z.
  if (kind > 4.5 && kind < 6.5) {
    base = mix(base, uBandColor, bandMask(kind < 5.5 ? vWorldPos.x : vWorldPos.z));
  }

  if (kind > 0.5 && kind < 1.5) {
    base *= fbm(vWorldPos.xz * 0.035) * 0.22 + 0.89;
    base = mix(base, vec3(0.52, 0.57, 0.60), gridLine(vWorldPos.xz, 1.0) * 0.38);
    base = mix(base, vec3(0.86, 0.83, 0.66), gridLine(vWorldPos.xz, 10.0) * 0.80);
  }

  float ndl = interior ? 0.0 : max(dot(N, uSunDir), 0.0);
  vec3 ambient = mix(uHaze * 0.55, uZenith, 0.5 + 0.5 * N.y);
  vec3 radiance = base * (uSunTint * ndl * 1.50 + ambient * (interior ? 0.22 : 0.70));

  if (kind > 2.5 && kind < 3.5) {
    vec3 H = normalize(uSunDir + vViewDir);
    radiance += uSunTint * pow(max(dot(N, H), 0.0), 48.0) * 0.9;
  }

  // Beacons blink on a fixed world-frame schedule. Because that schedule is
  // evaluated at the EMISSION time, their apparent rate is Doppler shifted for
  // free — walk toward one and watch it speed up.
  if (beacon) {
    float ph = vTEmit * uBeaconRate + vMat.z;
    float pulse = pow(0.5 + 0.5 * sin(6.28318530718 * ph), 14.0);
    radiance += vColor * (0.015 + 34.0 * pulse);
  }

  // The hills sit 1.5 to 2.9 km out, where full haze leaves them almost pure
  // sky. They keep a third of it, so they read as distant rather than dissolved.
  float fogWeight = (kind > 7.5) ? 0.32 : 0.94;
  float fog = 1.0 - exp(-vDist * uFogDensity);
  radiance = mix(radiance, uHaze * 1.05, fog * fogWeight);

  gl_FragDepth = log2(vLogZ) * uLogDepthC * 0.5;
  fragColor = present(radiance);
}
`;

  const FRAG_SKY = FRAG_COMMON + `
uniform float uCloudScale;

void main() {
  vec3 d = normalize(vWorldPos - uObsPos);
  float h = d.y;

  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.45));
  col = mix(col, uHaze, smoothstep(0.035, -0.14, h));

  float cd = clamp(dot(d, uSunDir), -1.0, 1.0);
  col += uSunTint * (pow(max(cd, 0.0), 1500.0) * 7.0 + pow(max(cd, 0.0), 20.0) * 0.26);
  col += uSunTint * (1.0 - smoothstep(0.0044, 0.0070, acos(cd))) * 40.0;

  if (h > 0.02) {
    // Project onto a flat cloud deck. Drift is evaluated at the emission time,
    // so even the weather is something you are seeing late.
    vec2 q = d.xz / max(h, 0.05) * uCloudScale + vec2(vTEmit * 0.0009, vTEmit * 0.0004);
    float n = fbm(q);
    float cover = smoothstep(0.48, 0.86, n);
    float thick = smoothstep(0.42, 0.97, n);
    vec3 cloud = mix(vec3(0.58, 0.63, 0.72), vec3(1.45, 1.41, 1.33), thick)
               + uSunTint * pow(max(cd, 0.0), 7.0) * 0.55;
    col = mix(col, cloud, cover * 0.92 * smoothstep(0.03, 0.30, h));
  }

  fragColor = present(col);
}
`;

  R.shaders = { VERT, FRAG_WORLD, FRAG_SKY };
})(window.Rel = window.Rel || {});
