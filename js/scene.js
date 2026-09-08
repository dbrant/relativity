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
    ground: rgb('#79828C'),
    stone: rgb('#CFC7B4'),
    stoneDark: rgb('#9A9384'),
    basalt: rgb('#31363C'),
    copper: rgb('#B4703A'),
    staveA: rgb('#EDE7D8'),
    staveB: rgb('#B03A2E'),
    hills: rgb('#5C6B70'),
    beacon: rgb('#FFD9A0'),
    shuttle: rgb('#E9EDF0'),
    shuttleTrim: rgb('#2E5E8C'),
    rail: rgb('#7E858C')
  };
  const CUBES = ['#C05F3C', '#D2A03C', '#7C9068', '#3E7C82', '#6B4A6E', '#D9D3C4', '#8C5A4A'].map(rgb);

  const MATTE = [0, 0], GROUND = [1, 0], POLISH = [3, 0];
  const beaconMat = phase => [2, phase];

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
    }, true);
  }

  /* A surveyor's levelling stave: alternating half-metre bands, so its length is
   * something you can literally count off. */
  function stave(mesh, cx, cy, cz, length, axis, band) {
    const along = axis === 'z' ? 2 : 0;
    const sx = axis === 'z' ? 0.9 : length;
    const sz = axis === 'z' ? length : 0.9;
    const origin = axis === 'z' ? cz : cx;
    geo.box(mesh, cx, cy, cz, sx, 0.9, sz, C.staveA, MATTE, (x, y, z) => {
      const t = ((along === 2 ? z : x) - origin + length / 2) / band;
      return (Math.floor(t + 1e-4) & 1) ? C.staveB : C.staveA;
    });
    // Posts holding it up.
    const n = Math.max(2, Math.round(length / 12));
    for (let i = 0; i <= n; i++) {
      const d = -length / 2 + (length * i) / n;
      const px = axis === 'z' ? cx : cx + d;
      const pz = axis === 'z' ? cz + d : cz;
      geo.cylinder(mesh, px, 0, pz, 0.13, cy - 0.45, C.rail, MATTE, 10);
    }
  }

  function buildStatic() {
    const m = new geo.Mesh();

    geo.mountainRing(m, 1500, 2900, 200, C.hills, MATTE, 7);

    // Colonnade down the Z axis.
    for (let i = -10; i <= 10; i++) {
      const z = i * 8;
      for (const x of [-8, 8]) {
        geo.cylinder(m, x, 0, z, 0.42, 6.0, C.stone, MATTE, 22);
        geo.box(m, x, 6.25, z, 1.3, 0.5, 1.3, C.stoneDark, MATTE);
        geo.box(m, x, 0.14, z, 1.5, 0.28, 1.5, C.stoneDark, MATTE);
      }
    }

    // Arches over the colonnade.
    for (const z of [24, 0, -24]) {
      geo.torusXY(m, 0, 0, z, 9.0, 0.42, C.copper, POLISH, 96, 14);
    }

    // The matched pair of staves. Identical, one along each axis.
    stave(m, -22, 2.3, 0, 60, 'z', 2.0);
    stave(m, 0, 2.3, -46, 60, 'x', 2.0);

    // Obelisk, banded horizontally, closing the corridor.
    geo.box(m, 0, 0, -96, 3.4, 34, 3.4, C.basalt, MATTE,
      (x, y) => (Math.floor(y / 2.5) & 1) ? C.basalt : C.stone);
    geo.box(m, 0, 0, -96, 5.2, 0.9, 5.2, C.stoneDark, MATTE);

    // Scattered blocks for parallax.
    const r = rng(20250907);
    for (let i = 0; i < 74; i++) {
      const x = (r() - 0.5) * 150;
      const z = (r() - 0.5) * 190;
      if (Math.abs(x) < 13 || (Math.abs(x - 30) < 12 && Math.abs(z - 6) < 12)) continue;
      const s = 0.7 + r() * 2.1;
      geo.box(m, x, s / 2, z, s, s, s * (0.7 + r() * 0.7), CUBES[(r() * CUBES.length) | 0], MATTE);
    }

    // Beacons, in front of you and behind, near and far.
    BEACONS.forEach((b, i) => {
      geo.cylinder(m, b[0], 0, b[1], 0.11, b[2], C.rail, MATTE, 10);
      geo.sphere(m, b[0], b[2] + 0.34, b[1], 0.34, C.beacon, beaconMat(i * 0.11), 20, 14);
    });

    // Carousel track and hub, left standing still for comparison with its cars.
    flatRing(m, CAROUSEL.cx, CAROUSEL.cz, CAROUSEL.radius - 1.1, CAROUSEL.radius + 1.1, 0.06, C.stoneDark, MATTE);
    geo.cylinder(m, CAROUSEL.cx, 0, CAROUSEL.cz, 1.0, 3.2, C.stone, MATTE, 20);

    // Shuttle rail.
    geo.box(m, SHUTTLE.bx, 0.12, SHUTTLE.bz, SHUTTLE.amp * 2 + 16, 0.24, 2.8, C.stoneDark, MATTE);

    return m;
  }

  const BEACONS = [
    [3.2, 22, 3.0], [3.2, -4, 3.0], [3.2, -34, 3.0], [3.2, -70, 3.0],
    [-3.2, 46, 3.0], [-3.2, 84, 3.0], [-3.2, 132, 3.0]
  ];

  const CAROUSEL = { cx: 30, cz: 6, radius: 6.0, cars: 8, beta: 0.74 };
  const SHUTTLE = { bx: 0, by: 0, bz: -62, amp: 11, beta: 0.88 };

  /* Carousel cars in car-local coordinates: +x along the track, +y up,
   * +z radially outward. The shader spins and contracts them. */
  function buildCarousel() {
    const m = new geo.Mesh();
    for (let i = 0; i < CAROUSEL.cars; i++) {
      const ph = (i / CAROUSEL.cars) * Math.PI * 2;
      const body = CUBES[i % CUBES.length];
      geo.box(m, 0, 1.15, 0, 3.2, 1.5, 1.5, body, [0, ph]);
      geo.box(m, 0, 2.05, 0, 2.4, 0.35, 1.3, C.stone, [3, ph]);
      geo.box(m, 0, 0.28, 0, 3.4, 0.24, 1.7, C.basalt, [0, ph]);
      geo.sphere(m, 1.3, 2.42, 0, 0.20, C.beacon, [2, ph], 14, 10);
    }
    return m;
  }

  /* The shuttle in its own rest frame: 14 m of clearly-marked length. */
  function buildShuttle() {
    const m = new geo.Mesh();
    geo.box(m, 0, 1.9, 0, 14, 2.6, 2.4, C.shuttle, [0, 0],
      (x) => (Math.floor((x + 7) / 1.75) & 1) ? C.shuttle : C.shuttleTrim);
    geo.box(m, 0, 3.32, 0, 13.2, 0.28, 2.6, C.shuttleTrim, [3, 0]);
    geo.box(m, 0, 0.5, 0, 13.6, 0.5, 2.0, C.basalt, [0, 0]);
    geo.sphere(m, 7.0, 3.6, 0, 0.26, C.beacon, [2, 0], 16, 12);
    geo.sphere(m, -7.0, 3.6, 0, 0.26, C.beacon, [2, 0.5], 16, 12);
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
    { label: 'Very high', rings: 780, sectors: 600 }
  ];

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
    buildStatic, buildCarousel, buildShuttle, buildSky, buildGround, GROUND_LEVELS,
    CAROUSEL, SHUTTLE, BEACONS,
    start: { x: 0, y: 1.7, z: 46, yaw: 0, pitch: -0.02 }
  };
})(window.Rel = window.Rel || {});
