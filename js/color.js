/* color.js — relativistic Doppler shift, computed through CIE colour matching.
 *
 * A surface colour is treated as a real spectrum rather than three numbers.
 * Each sRGB primary is modelled as a Gaussian reflectance lobe over a broad
 * neutral floor, lit by a 5800 K sun — so a blueshifted surface reveals the
 * infrared it was reflecting all along, and a redshifted one its ultraviolet.
 *
 * Redshift ends in black, which is honest: the beaming factor is shrinking too,
 * and radio waves carry nothing to see. Blueshift ends in white, which is a
 * choice — see the overload note below.
 *
 * Because the whole chain (shift, colour matching, XYZ->sRGB) is linear in the
 * three primary weights, the entire effect at a given Doppler factor D collapses
 * to one 3x3 matrix. We tabulate that matrix over log D and hand it to the GPU.
 */
(function (R) {
  'use strict';

  // --- CIE 1931 2-degree colour matching functions -------------------------
  // Multi-lobe analytic fits from Wyman, Sloan & Shirley, JCGT 2 (2013).
  function pg(x, mu, s1, s2) {
    const t = (x - mu) / (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  }
  const xBar = l => 1.056 * pg(l, 599.8, 37.9, 31.0) + 0.362 * pg(l, 442.0, 16.0, 26.7) - 0.065 * pg(l, 501.1, 20.4, 26.2);
  const yBar = l => 0.821 * pg(l, 568.8, 46.9, 40.5) + 0.286 * pg(l, 530.9, 16.3, 31.1);
  const zBar = l => 1.217 * pg(l, 437.0, 11.8, 36.0) + 0.681 * pg(l, 459.0, 26.0, 13.8);

  // --- source spectra for the three primaries ------------------------------
  // A colour is modelled as spectral REFLECTANCE (a Gaussian lobe over a broad
  // neutral floor) lit by a 5800 K solar illuminant. The illuminant's own decline
  // into the infrared and ultraviolet is what eventually starves a heavily
  // shifted object of light — the honest reason things fade to black at speed.
  const LOBE = [
    { mu: 612, sig: 36 },  // R
    { mu: 549, sig: 32 },  // G
    { mu: 464, sig: 26 }   // B
  ];
  const REFLECT_FLOOR = 0.22;
  const SUN_TEMP = 5800;

  function planck(lambdaNm, T) {
    const h = 6.62607e-34, c0 = 2.99792e8, kB = 1.38065e-23;
    const L = lambdaNm * 1e-9;
    return (2 * h * c0 * c0) / (Math.pow(L, 5) * (Math.exp(h * c0 / (L * kB * T)) - 1));
  }
  const SUN_REF = planck(550, SUN_TEMP);

  function sourceSpectrum(ch, lambda) {
    if (lambda < 100 || lambda > 60000) return 0;
    const p = LOBE[ch];
    const t = (lambda - p.mu) / p.sig;
    const reflectance = Math.exp(-0.5 * t * t) + REFLECT_FLOOR;
    return reflectance * (planck(lambda, SUN_TEMP) / SUN_REF);
  }

  const XYZ_TO_RGB = [
    3.2404542, -1.5371385, -0.4985314,
    -0.9692660, 1.8760108, 0.0415560,
    0.0556434, -0.2040259, 1.0572252
  ];

  function mul3(a, b) { // row-major 3x3
    const o = new Float64Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return o;
  }

  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) throw new Error('singular primary matrix');
    const s = 1 / det;
    return new Float64Array([
      A * s, (c * h - b * i) * s, (b * f - c * e) * s,
      B * s, (a * i - c * g) * s, (c * d - a * f) * s,
      C * s, (b * g - a * h) * s, (a * e - b * d) * s
    ]);
  }

  // Columns are the primaries: linear sRGB seen by the observer when the source
  // emits one unit of primary c and everything is shifted by factor D.
  // Observed wavelength L' maps back to emitted wavelength L = L' * D.
  function shiftMatrix(D) {
    const XYZ = new Float64Array(9);
    const LO = 360, HI = 830, STEP = 1;
    for (let ch = 0; ch < 3; ch++) {
      let X = 0, Y = 0, Z = 0;
      for (let lp = LO; lp <= HI; lp += STEP) {
        const s = sourceSpectrum(ch, lp * D);
        X += s * xBar(lp); Y += s * yBar(lp); Z += s * zBar(lp);
      }
      XYZ[0 * 3 + ch] = X * STEP;
      XYZ[1 * 3 + ch] = Y * STEP;
      XYZ[2 * 3 + ch] = Z * STEP;
    }
    return mul3(XYZ_TO_RGB, XYZ);
  }

  /* --- saturation at extreme blueshift ---------------------------------
   *
   * Run the integral honestly to D = 20 and the picture goes violet, then
   * magenta, then black: the visible band is sampling ever deeper into the
   * source's infrared, and there is almost nothing out there. That is a true
   * statement about the eye and a poor one about what is happening. At D = 12
   * only half a percent of the arriving power is still visible — the source's
   * own visible light is landing as X-rays and gamma, and anything looking at
   * it is being flooded, not starved.
   *
   * So once the visible band stops carrying the energy, the response saturates
   * to white rather than fading out. The weight is the share of received power
   * that has left the visible band, shaped by an exponent so that ordinary
   * blueshift keeps its blue and only the extreme end washes out.
   *
   * Blueshift only. Under redshift the beaming factor is shrinking as well, so
   * there is no flood to represent and going dark is the honest answer.
   */
  const OVERLOAD_SHAPE = 12;
  const WHITE = new Float64Array(9).fill(1 / 3);

  function neutralSpectrum(l) {
    return sourceSpectrum(0, l) + sourceSpectrum(1, l) + sourceSpectrum(2, l);
  }

  // Log-spaced, because the band of interest spans 100 nm to 60 microns.
  function power(loNm, hiNm) {
    if (hiNm <= loNm) return 0;
    const n = 2048, a = Math.log(loNm), b = Math.log(hiNm), h = (b - a) / n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const l = Math.exp(a + (i + 0.5) * h);
      sum += neutralSpectrum(l) * l * h;   // dl = l du
    }
    return sum;
  }

  const POWER_ALL = power(100, 60000);
  // Share of received power the eye can still see: observed 360..830 nm comes
  // from source wavelengths 360D..830D.
  const visibleFraction = D => power(360 * D, 830 * D) / POWER_ALL;
  const PHI_REST = visibleFraction(1);

  function overload(D) {
    if (D <= 1) return 0;
    return Math.pow(Math.max(0, 1 - visibleFraction(D) / PHI_REST), OVERLOAD_SHAPE);
  }

  /* The full response at Doppler factor D: the spectral integral, normalised so
   * that rest is exactly the identity, then blended toward white by the
   * out-of-band overload. */
  function responseMatrix(D, restInv) {
    const N = mul3(shiftMatrix(D), restInv);
    const w = overload(D);
    if (w <= 0) return N;
    for (let i = 0; i < 9; i++) N[i] = (1 - w) * N[i] + w * WHITE[i];
    return N;
  }

  const LUT_N = 512;
  const LOG_MIN = Math.log(0.02);
  const LOG_MAX = Math.log(50.0);

  /* Builds a LUT_N x 3 RGBA32F texture. Row j holds row j of the 3x3 matrix.
   * Normalised so that D = 1 is exactly the identity: at rest, colours are
   * untouched, and every deviation you see is a real shift. */
  function buildLut(gl) {
    const restInv = inv3(shiftMatrix(1.0));
    const data = new Float32Array(LUT_N * 3 * 4);
    for (let i = 0; i < LUT_N; i++) {
      const D = Math.exp(LOG_MIN + (LOG_MAX - LOG_MIN) * (i / (LUT_N - 1)));
      const N = responseMatrix(D, restInv);
      for (let row = 0; row < 3; row++) {
        const o = (row * LUT_N + i) * 4;
        data[o] = N[row * 3];
        data[o + 1] = N[row * 3 + 1];
        data[o + 2] = N[row * 3 + 2];
        data[o + 3] = 1;
      }
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, LUT_N, 3, 0, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, n: LUT_N, logMin: LOG_MIN, logMax: LOG_MAX };
  }

  /* CSS gradient stops for the HUD spectrum bar: what a neutral grey surface
   * looks like across the Doppler range. Same maths as the shader path. */
  const BAR_FLOOR = 0.06;   // darkest end of the legend
  const BAR_GAMMA = 1.15;

  function spectrumStops(steps, dMin, dMax) {
    const restInv = inv3(shiftMatrix(1.0));
    const out = [];
    for (let i = 0; i < steps; i++) {
      const f = i / (steps - 1);
      const D = Math.exp(Math.log(dMin) + (Math.log(dMax) - Math.log(dMin)) * f);
      const N = responseMatrix(D, restInv);
      // A neutral grey source: equal parts of all three primaries.
      const r = Math.max(0, (N[0] + N[1] + N[2]) * 0.5);
      const g = Math.max(0, (N[3] + N[4] + N[5]) * 0.5);
      const b2 = Math.max(0, (N[6] + N[7] + N[8]) * 0.5);

      // Hue comes from the spectral response; brightness from a plain monotone
      // ramp across the bar. Using the response's own luminance instead dips in
      // the middle of the blueshift half before the overload restores it — true
      // of the spectrum, but wrong for a legend, which has to read one way.
      const hueMax = Math.max(r, g, b2, 1e-6);
      const level = BAR_FLOOR + (1 - BAR_FLOOR) * Math.pow(f, BAR_GAMMA);
      const enc = v => Math.round(255 * Math.pow(Math.min(1, (v / hueMax) * level), 1 / 2.2));
      out.push({ f, css: 'rgb(' + enc(r) + ',' + enc(g) + ',' + enc(b2) + ')' });
    }
    return out;
  }

  R.color = { buildLut, spectrumStops };
})(window.Rel = window.Rel || {});
