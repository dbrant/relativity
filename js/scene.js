/* scene.js — the world.
 *
 * Everything is sized in real metres and laid out so that specific relativistic
 * effects have something to happen TO:
 *
 *   the colonnade        the classic corridor — aberration bends it into a tunnel
 *   the paired staves    one lying along Z, one along X, identical otherwise;
 *                        run down Z and only one of them shortens
 *   the arches           closed loops, so you can watch a circle become an ellipse
 *   the beacons          all blink once a second in world time; their apparent
 *                        rate is your Doppler readout, in front of you and behind
 *   the carousel         cars contracted by their OWN motion, seen at different
 *                        retarded times around the ring
 *   the shuttle          slides along X, so its contraction breathes in and out
 *   the Ferris wheel     gondolas hanging level, so each is in pure translation
 *                        and its contraction axis sweeps around with the ride;
 *                        broadside to the corridor, so running past it puts you
 *                        alongside the cars at the top and head-on to those at
 *                        the bottom
 */
(function (R) {
  'use strict';

  const geo = R.geo;

  /* Colours are authored as sRGB hex and stored linear — the shader gamma-encodes
   * once at the very end, after Doppler and beaming have had their say. */
  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
  }

  const C = {
    ground: rgb('#506062'),
    stone: rgb('#CFC7B4'),
    stoneDark: rgb('#9A9384'),
    basalt: rgb('#31363C'),
    copper: rgb('#B4703A'),
    staveA: rgb('#EDE7D8'),
    staveB: rgb('#B03A2E'),
    hills: rgb('#3D5B41'),
    beacon: rgb('#FFD9A0'),
    shuttle: rgb('#E9EDF0'),
    shuttleTrim: rgb('#2E5E8C'),
    rail: rgb('#7E858C')
  };
  const CUBES = ['#C05F3C', '#D2A03C', '#7C9068', '#3E7C82', '#6B4A6E', '#D9D3C4', '#8C5A4A'].map(rgb);

  // [kind, motionPhase, blinkPhase]
  const MATTE = [0, 0, 0], GROUND = [1, 0, 0], POLISH = [3, 0, 0];
  // Banding is drawn per fragment from world position; 5 measures along X, 6
  // along Z. 8 is distant terrain, which takes less of the haze.
  const BAND_X = [5, 0, 0], BAND_Z = [6, 0, 0], HILLS = [8, 0, 0];
  const BAND_WIDTH = 2.0;
  const TEXTURE_FILE = 'texture1.jpg';
  const TEXTURE_ASPECT = 1200 / 499;
  const beaconMat = blink => [2, 0, blink];

  /* Deterministic scatter so the layout is the same every time you load it. */
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function flatRing(mesh, cx, cz, rInner, rOuter, y, color, mat) {
    geo.patch(mesh, 128, 3, color, mat, (u, v) => {
      const a = u * Math.PI * 2;
      const r = rInner + (rOuter - rInner) * v;
      return [[cx + Math.cos(a) * r, y, cz + Math.sin(a) * r], [0, 1, 0]];
    });
  }

  /* A surveyor's levelling stave: alternating half-metre bands, so its length is
   * something you can literally count off. */
  function stave(mesh, cx, cy, cz, length, axis) {
    geo.setDetail(SLENDER_DETAIL);
    const sx = axis === 'z' ? 0.5 : length;
    const sz = axis === 'z' ? length : 0.5;
    geo.box(mesh, cx, cy, cz, sx, 0.5, sz, C.staveA, axis === 'z' ? BAND_Z : BAND_X);
    // Posts holding it up.
    const n = Math.max(2, Math.round(length / 12));
    for (let i = 0; i <= n; i++) {
      const d = -length / 2 + (length * i) / n;
      const px = axis === 'z' ? cx : cx + d;
      const pz = axis === 'z' ? cz + d : cz;
      geo.cylinder(mesh, px, 0, pz, 0.10, cy - 0.25, C.rail, MATTE, 18);
    }
    geo.setDetail(1);
  }

  function buildStatic() {
    const m = new geo.Mesh();

    geo.mountainRing(m, 1500, 2900, 200, C.hills, HILLS, 7);

    // Colonnade down the Z axis.
    geo.setDetail(SLENDER_DETAIL);
    for (let i = -10; i <= 10; i++) {
      const z = i * 8;
      for (const x of [-8, 8]) {
        geo.cylinder(m, x, 0, z, 0.42, 6.0, C.stone, MATTE, 40);
        geo.box(m, x, 6.25, z, 1.3, 0.5, 1.3, C.stoneDark, MATTE);
        geo.box(m, x, 0.14, z, 1.5, 0.28, 1.5, C.stoneDark, MATTE);
      }
    }
    geo.setDetail(1);

    // Arches over the colonnade, standing in the GAPS between columns. The arch
    // passes y = 4.1 m where it crosses x = 8, which is halfway up a column, so
    // sharing a z with one buries it in the stonework.
    for (const z of [44, 20, -4, -28]) {
      geo.torus(m, 0, 0, z, 9.0, 0.42, C.copper, POLISH, 96, 14);
    }

    // The matched pair of staves. Identical, one along each axis.
    stave(m, -22, 1.0, 0, 60, 'z');
    stave(m, 0, 1.0, -46, 60, 'x');

    // Obelisk, banded horizontally, closing the corridor.
    geo.box(m, 0, 0, -96, 3.4, 34, 3.4, C.basalt, MATTE,
      (x, y) => (Math.floor(y / 2.5) & 1) ? C.basalt : C.stone);
    geo.box(m, 0, 0, -96, 5.2, 0.9, 5.2, C.stoneDark, MATTE);

    // Scattered blocks for parallax, kept out of the corridor and off the rides.
    const r = rng(20250907);
    const clear = (x, z, cx, cz, half) => Math.abs(x - cx) < half && Math.abs(z - cz) < half;
    for (let i = 0; i < 74; i++) {
      const x = (r() - 0.5) * 150;
      const z = (r() - 0.5) * 190;
      if (Math.abs(x) < 13) continue;
      if (clear(x, z, CAROUSEL.cx, CAROUSEL.cz, 12)) continue;
      if (clear(x, z, WHEEL.cx, WHEEL.cz, 13)) continue;
      if (MODELS.some(o => Math.hypot(x - o.x, z - o.z) < 4)) continue;
      const s = 0.7 + r() * 2.1;
      geo.box(m, x, s / 2, z, s, s, s * (0.7 + r() * 0.7), CUBES[(r() * CUBES.length) | 0], MATTE);
    }

    // Beacons, in front of you and behind, near and far.
    geo.setDetail(SLENDER_DETAIL);
    BEACONS.forEach((b, i) => {
      geo.cylinder(m, b[0], 0, b[1], 0.11, b[2], C.rail, MATTE, 20);
      geo.sphere(m, b[0], b[2] + 0.34, b[1], 0.34, C.beacon, beaconMat(i * 0.11), 32, 22);
    });
    geo.setDetail(1);

    // Carousel track and hub, left standing still for comparison with its cars.
    flatRing(m, CAROUSEL.cx, CAROUSEL.cz, CAROUSEL.radius - 1.1, CAROUSEL.radius + 1.1, 0.06, C.stoneDark, MATTE);
    geo.setDetail(SLENDER_DETAIL);
    geo.cylinder(m, CAROUSEL.cx, 0, CAROUSEL.cz, 1.0, 3.2, C.stone, MATTE, 40);
    geo.setDetail(1);

    // The Ferris wheel's tower: two A-frames straddling the wheel, and the axle
    // they carry. All of it stands still, so it measures the ride against
    // something at rest — and the legs pass OUTSIDE the rims, as a real one's
    // do, which is what leaves the wheel free to turn between them.
    geo.setDetail(SLENDER_DETAIL);
    for (const sx of [-1, 1]) {
      const x = WHEEL.cx + sx * WHEEL.legX;
      const top = [x, WHEEL.cy, WHEEL.cz];
      for (const sz of [-1, 1]) {
        const foot = [x, 0, WHEEL.cz + sz * WHEEL.legZ];
        geo.tube(m, foot, top, 0.30, C.rail, MATTE, 20);
        geo.box(m, foot[0], 0.16, foot[2], 1.3, 0.32, 1.3, C.stoneDark, MATTE);
      }
      // Tie beam across each A-frame, spanning it at 55% of the way up, where
      // the legs have already leaned in to 45% of their spread.
      const ty = WHEEL.cy * 0.55, tz = WHEEL.legZ * 0.45;
      geo.tube(m, [x, ty, WHEEL.cz - tz], [x, ty, WHEEL.cz + tz], 0.12, C.rail, MATTE, 14);
    }
    const ax = WHEEL.legX + 0.4;
    geo.tube(m, [WHEEL.cx - ax, WHEEL.cy, WHEEL.cz], [WHEEL.cx + ax, WHEEL.cy, WHEEL.cz],
      0.30, C.stoneDark, POLISH, 28);
    geo.setDetail(1);
    // Boarding platform, under the lowest car.
    geo.box(m, WHEEL.cx, 0.15, WHEEL.cz, 5.4, 0.30, 4.2, C.stoneDark, MATTE);

    // Plinths for the sculptures, so they read as objects placed in a park
    // rather than dropped on the pavement.
    for (const s of MODELS) {
      geo.box(m, s.x, s.y / 2, s.z, 1.9, s.y, 1.9, C.stone, MATTE);
      geo.box(m, s.x, s.y + 0.06, s.z, 2.25, 0.12, 2.25, C.stoneDark, MATTE);
      geo.box(m, s.x, 0.07, s.z, 2.4, 0.14, 2.4, C.stoneDark, MATTE);
    }

    // Shuttle rail.
    geo.box(m, SHUTTLE.bx, 0.12, SHUTTLE.bz, SHUTTLE.amp * 2 + 16, 0.24, 2.8, C.stoneDark, MATTE);

    return m;
  }

  const BEACONS = [
    [3.2, 22, 3.0], [3.2, -4, 3.0], [3.2, -34, 3.0], [3.2, -70, 3.0],
    [-3.2, 46, 3.0], [-3.2, 84, 3.0], [-3.2, 132, 3.0]
  ];

  /* STL sculptures, one either side of the colonnade. Loaded asynchronously and
   * auto-fitted to a height in metres, so the park stands up before they arrive.
   * Materials include: [0, 0, 0] (matte), [3, 0, 0] (shiny), etc. */
  const MODELS = [
    { file: 'bunny.stl', x: -17, z: 4, y: 1.1, height: 2.6, yaw: 2.1,
      color: rgb('#9AA0A0'), mat: [3, 0, 0] },
    { file: 'dragon.stl', x: 17, z: 4, y: 1.1, height: 2.2, yaw: -1.9,
      color: rgb('#9C7A46'), mat: [3, 0, 0] }
  ];

  const CAROUSEL = { cx: 30, cz: 6, radius: 6.0, cars: 8, beta: 0.75, bound: 8.0 };
  const SHUTTLE = { bx: 0, by: 0, bz: -62, amp: 11, beta: 0.75, halfLen: 7, bound: 20.0 };

  /* The Ferris wheel, facing the carousel across the park. Its axle runs along
   * X, so the wheel stands BROADSIDE to the corridor — which is the whole point
   * of putting it here. Run down Z at speed and the cars at the top of the wheel
   * are moving the way you are, while the cars at the bottom are coming the
   * other way: Einstein velocity addition, side by side in one object. At 0.75c
   * each way the top cars nearly stop relative to you, and the bottom cars pass
   * at 0.96c.
   *
   * `radius` is the circle the PIVOTS ride; the cars hang below it. */
  const WHEEL = {
    cx: -30, cy: 12.0, cz: 6,
    radius: 9.0, cars: 10, beta: 0.75,
    hang: 1.30,            // pivot down to the centre of a car
    car: [1.8, 1.7, 2.0],  // along the axle, up, along the corridor
    // The rims sit either side of the centreline, and the cars swing BETWEEN
    // them: a car hung from a pivot up on the shoulder of the wheel sweeps well
    // inside the rim circle, so anything narrower than the car would be sliced
    // through by it. Everything below is spaced off this one number.
    halfWidth: 1.4,
    legX: 2.2, legZ: 7.0,  // where the A-frames stand, clear of the rims
    bound: 12.0
  };

  /* The shuttle is contracted about its centre by its INSTANTANEOUS gamma, which
   * is not a legal rigid motion: while it accelerates its ends move relative to
   * its centre, and past a certain speed they exceed c. That matters here for a
   * specific reason. A vertex at c has a worldline tangent to the light cone, so
   * g'(a) = 1 + (v.n)/c goes to zero and the retarded time stops being a
   * well-conditioned function of position: neighbouring vertices solve to wildly
   * different moments and the mesh tears into spikes. At beta = 0.88 the ends
   * reached 1.076c and it did.
   *
   * The model is only valid while the ends stay comfortably subluminal, so the
   * parameters are chosen for that. The figure is independent of the speed of
   * light setting, since omega scales with c too. */
  function shuttleEndSpeed(S) {
    const cRef = 1.389, om = (S.beta * cRef) / S.amp;
    const gamAt = t => {
      const b = Math.min(Math.abs(S.amp * om * Math.cos(om * t)) / cRef, 0.999999);
      return 1 / Math.sqrt(1 - b * b);
    };
    const at = (t, x) => S.amp * Math.sin(om * t) + x / gamAt(t);
    const h = 1e-6, period = 2 * Math.PI / om;
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const t = (i / 4000) * period;
      worst = Math.max(worst, Math.abs((at(t + h, S.halfLen) - at(t - h, S.halfLen)) / (2 * h)) / cRef);
    }
    return worst;
  }

  const SHUTTLE_END_BETA = shuttleEndSpeed(SHUTTLE);
  if (SHUTTLE_END_BETA > 0.93) {
    console.warn('Shuttle ends reach ' + SHUTTLE_END_BETA.toFixed(3) +
      'c. The retarded-time solve will be ill-conditioned and the mesh will tear. ' +
      'Lower SHUTTLE.beta or SHUTTLE.halfLen, or raise SHUTTLE.amp.');
  }

  /* Movers are cut finer than anything static, by roughly their own stretch
   * factor 1/(1 - beta), so their retarded images stay smooth. */
  const MOVER_DETAIL = 4;

  /* Slender uprights are where the boost's curvature is most obvious: a column
   * is a straight line six metres long, and the transform bends it into an arc.
   * Cut at the scenery default it would climb in visible chords. These get their
   * own budget, in height segments and around the circumference both. */
  const SLENDER_DETAIL = 3;

  /* Carousel cars in car-local coordinates: +x along the track, +y up,
   * +z radially outward. The shader spins and contracts them. */
  function buildCarousel() {
    const m = new geo.Mesh();
    geo.setDetail(MOVER_DETAIL);
    for (let i = 0; i < CAROUSEL.cars; i++) {
      const ph = (i / CAROUSEL.cars) * Math.PI * 2;
      const body = CUBES[i % CUBES.length];
      geo.box(m, 0, 1.15, 0, 3.2, 1.5, 1.5, body, [0, ph, 0]);
      geo.box(m, 0, 2.05, 0, 2.4, 0.35, 1.3, C.stone, [3, ph, 0]);
      geo.box(m, 0, 0.28, 0, 3.4, 0.24, 1.7, C.basalt, [0, ph, 0]);
      geo.sphere(m, 1.3, 2.32, 0, 0.20, C.beacon, [2, ph, ph], 28, 20);
    }
    geo.setDetail(1);
    return m;
  }

  /* The wheel's structure, in hub-local coordinates at phase zero: x along the
   * axle, y up, z along the corridor. The shader turns the whole thing rigidly.
   *
   * Two rims rather than one, braced across, because a single ring gives the eye
   * nothing to judge the wheel's tilt by — and at speed the two rims are seen at
   * measurably different retarded times, which shears them apart. */
  function buildWheel() {
    const m = new geo.Mesh();
    const R = WHEEL.radius, X = WHEEL.halfWidth;
    geo.setDetail(MOVER_DETAIL);
    // 384 segments around, not the torus default of 64: the rim is 57 m of
    // circumference travelling at 0.76c, and the light cone stretches its image
    // along its motion by 1/(1 - beta), so a chord cut for its rest size gets
    // drawn four times longer than it was meant to be. This puts the segments
    // at 15 cm, which is what MOVER_DETAIL asks of everything else here.
    for (const x of [-X, X]) geo.torus(m, x, 0, 0, R, 0.16, C.rail, POLISH, 384, 12, 'x');
    for (let i = 0; i < WHEEL.cars; i++) {
      // A pair of spokes out to each pivot...
      const a = (i / WHEEL.cars) * Math.PI * 2;
      const ry = Math.cos(a) * R, rz = Math.sin(a) * R;
      for (const x of [-X, X]) geo.tube(m, [x, 0, 0], [x, ry, rz], 0.07, C.rail, MATTE, 12);
      // ...and the bracing between the rims halfway BETWEEN the pivots, which
      // keeps the centreline clear for the gondolas' masts. Rotor and cars turn
      // at one rate, so that half-spacing holds for good.
      const b = a + Math.PI / WHEEL.cars;
      const by = Math.cos(b) * R, bz = Math.sin(b) * R;
      geo.tube(m, [-X, by, bz], [X, by, bz], 0.09, C.rail, MATTE, 12);
    }
    // The drum turning on the axle inside it.
    geo.tube(m, [-X - 0.1, 0, 0], [X + 0.1, 0, 0], 0.80, C.stone, POLISH, 40);
    geo.setDetail(1);
    return m;
  }

  /* The gondolas, each in its own rest frame, positioned relative to its pivot.
   * They hang level and never turn over, so a car is in pure translation: every
   * point of it shares one velocity, and the contraction is a single squash
   * along a direction that rotates once per revolution. */
  function buildGondolas() {
    const m = new geo.Mesh();
    const [sx, sy, sz] = WHEEL.car, cy = -WHEEL.hang;
    geo.setDetail(MOVER_DETAIL);
    for (let i = 0; i < WHEEL.cars; i++) {
      const ph = (i / WHEEL.cars) * Math.PI * 2;
      const body = CUBES[(i * 3) % CUBES.length];
      geo.box(m, 0, cy, 0, sx, sy, sz, body, [0, ph, 0]);
      geo.box(m, 0, cy + sy / 2 + 0.08, 0, sx + 0.2, 0.16, sz + 0.2, C.stone, [3, ph, 0]);
      // Mast, from the roof up past the pivot. It runs along the centreline,
      // between the two rims, which is why the bracing is not put there.
      geo.tube(m, [0, cy + sy / 2 + 0.16, 0], [0, 0.28, 0], 0.09, C.rail, MATTE, 14);
      // A lamp on top of each mast, each on its own blink phase: ten Doppler
      // readouts going round, and the ones climbing toward you flash faster
      // than the ones falling away.
      geo.sphere(m, 0, 0.28, 0, 0.18, C.beacon, [2, ph, i * 0.1], 26, 18);
    }
    geo.setDetail(1);
    return m;
  }

  /* Worst vertex speed anywhere on the wheel, for the same reason the shuttle
   * has one: the retarded-time solve loses conditioning as a vertex approaches
   * c, and a mesh that tears is the symptom. A gondola's own points would all
   * share its 0.75c if the contraction axis held still, but it turns with the
   * car, and that carries the far corners round a little faster.
   *
   * |v| = omega * hypot(R + k * pr, k * pu) with k = 1 - 1/gamma, which over a
   * corner at fixed distance from the pivot is largest when the corner is
   * straight out along the radius. */
  function wheelPeakBeta(W) {
    const g = 1 / Math.sqrt(1 - W.beta * W.beta);
    const reach = Math.hypot(W.hang + W.car[1] / 2, W.car[2] / 2);
    return (W.beta * (W.radius + (1 - 1 / g) * reach)) / W.radius;
  }

  const WHEEL_PEAK_BETA = wheelPeakBeta(WHEEL);
  if (WHEEL_PEAK_BETA > 0.93) {
    console.warn('Ferris wheel corners reach ' + WHEEL_PEAK_BETA.toFixed(3) +
      'c. Shorten WHEEL.hang or the car, or widen WHEEL.radius.');
  }

  /* The shuttle in its own rest frame: 14 m of clearly-marked length. */
  function buildShuttle() {
    const m = new geo.Mesh();
    geo.setDetail(MOVER_DETAIL);
    /* Livery panel rather than stripes: kind 9 samples the decal texture, and
     * only the long sides carry it. The end caps are 2.4 m deep along a typical
     * line of sight, so light takes long enough to cross them that the shuttle
     * can pass you meanwhile and the face turns away partway across itself. The
     * boundary that leaves is real, but a photograph draped over it advertises
     * the seam; plain colour wears it far better. */
    geo.box(m, 0, 1.9, 0, 14, 2.6, 2.4, C.shuttle, [9, 0, 0], null, TEXTURE_ASPECT, 'z');
    geo.box(m, 0, 3.32, 0, 13.2, 0.28, 2.6, C.shuttleTrim, [3, 0, 0]);
    geo.box(m, 0, 0.5, 0, 13.6, 0.5, 2.0, C.basalt, [0, 0, 0]);
    // Both lamps ride the shuttle: motion phase 0, alternating blink phases.
    geo.sphere(m, 6.5, 3.62, 0, 0.26, C.beacon, [2, 0, 0.0], 32, 24);
    geo.sphere(m, -6.5, 3.62, 0, 0.26, C.beacon, [2, 0, 0.5], 32, 24);
    geo.setDetail(1);
    return m;
  }

  /* The ground is the one surface the relativistic transform really punishes.
   * Its quads are straight lines in world space that the boost bends into
   * curves, and the faceting error goes as the square of the angular step —
   * so it gets its own budget, and its own control.
   *
   * The radial step is the one that matters: at the old 210x256 it was 1.8x
   * coarser than the tangential step, which is where the facets came from.
   * These pairs keep the quads roughly square, and start at 1.2 m rather than
   * 0.3 m so no rings are wasted on the ground between your feet.
   */
  const GROUND_R_MIN = 1.2, GROUND_R_MAX = 4000;
  const GROUND_LEVELS = [
    { label: 'Low', rings: 200, sectors: 160 },
    { label: 'Medium', rings: 340, sectors: 264 },
    { label: 'High', rings: 520, sectors: 400 },
    { label: 'Very high', rings: 700, sectors: 540 },
    { label: 'Extreme', rings: 920, sectors: 700 }
  ];

  /* Aberration magnifies the rear of the view by gamma(1 + beta), so that is
   * where straight edges bend hardest and where the tessellation has to keep
   * up. Two steps of headroom above whatever floor the user has chosen, with
   * hysteresis so a wobble around a threshold cannot thrash the rebuild. */
  const GROUND_STEP_UP = [1.6, 3.0];
  const GROUND_STEP_DOWN = [1.45, 2.7];

  function adaptiveGroundLevel(gamma, floor, current) {
    let boost = 0;
    for (let i = 0; i < GROUND_STEP_UP.length; i++) {
      const already = current > floor + i;
      if (gamma >= (already ? GROUND_STEP_DOWN[i] : GROUND_STEP_UP[i])) boost = i + 1;
    }
    return Math.min(GROUND_LEVELS.length - 1, floor + boost);
  }

  function buildGround(level) {
    const L = GROUND_LEVELS[Math.max(0, Math.min(GROUND_LEVELS.length - 1, level | 0))];
    const m = new geo.Mesh();
    geo.groundDisc(m, GROUND_R_MIN, GROUND_R_MAX, L.rings, L.sectors, C.ground, GROUND);
    return m;
  }

  function buildSky() {
    const m = new geo.Mesh();
    geo.skyDome(m, 6000, 180, 90);
    return m;
  }

  R.scene = {
    buildStatic, buildCarousel, buildShuttle, buildWheel, buildGondolas,
    buildSky, buildGround, GROUND_LEVELS, MODELS,
    BAND_COLOR: C.staveB, BAND_WIDTH, TEXTURE_FILE,
    adaptiveGroundLevel,
    CAROUSEL, SHUTTLE, WHEEL, BEACONS,
    start: { x: 0, y: 2.0, z: 46, yaw: 0, pitch: -0.02 }
  };
})(window.Rel = window.Rel || {});
