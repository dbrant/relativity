/* geometry.js — mesh builders.
 *
 * Everything is heavily tessellated on purpose. The relativistic transform is
 * applied per vertex and is strongly non-linear, so straight edges genuinely
 * bend. A cube drawn with 8 vertices would stay a cube at 0.9c, which is a lie.
 */
(function (R) {
  'use strict';

  const STRIDE = 14; // pos3 normal3 color3 mat3 uv2

  function Mesh() { this.verts = []; this.tris = []; }

  /* mat is [kind, motionPhase, blinkPhase]; the last two default to zero so
   * ordinary scenery can keep passing a pair. Keeping motion and blink apart
   * matters: sharing one slot once put a lamp on a different oscillation phase
   * from the vehicle carrying it, and it drifted off into the air. */
  Mesh.prototype.push = function (p, n, c, m, uv) {
    this.verts.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2],
                    m[0], m[1] || 0, m[2] || 0,
                    uv ? uv[0] : 0, uv ? uv[1] : 0);
    return this.verts.length / STRIDE - 1;
  };
  Mesh.prototype.quad = function (a, b, c, d) {
    this.tris.push(a, b, c, a, c, d);
  };
  Mesh.prototype.count = function () { return this.verts.length / STRIDE; };

  /* A subdivided parametric patch. fn(u, v) -> [position, normal].
   *
   * Winding is derived from the normals rather than trusted to the caller. When
   * it was a caller's argument, cylinders, the ground and the hills all came out
   * wound backwards and the box disagreed with itself on two of six faces —
   * which inverted gl_FrontFacing and lit those surfaces from the wrong side.
   * Nothing caught it because culling is off. Derived, it cannot drift. */
  function patch(mesh, nu, nv, color, mat, fn, uvx) {
    const su = uvx ? uvx[0] : 1, sv = uvx ? uvx[1] : 1;
    const ou = uvx ? uvx[2] : 0, ov = uvx ? uvx[3] : 0;
    const base = mesh.count();
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv;
        const r = fn(u, v);
        mesh.push(r[0], r[1], color, mat, [u * su + ou, v * sv + ov]);
      }
    }

    // Does corner order (a,b,c) turn the same way its normal points? Sampling
    // starts at the middle of the patch, furthest from the poles and axis
    // singularities where the cross product collapses to zero.
    const corner = k => (base + k) * STRIDE;
    let flip = false;
    search:
    for (let dj = 0; dj < nv; dj++) {
      const j = ((nv >> 1) + dj) % nv;
      for (let di = 0; di < nu; di++) {
        const i = ((nu >> 1) + di) % nu;
        const a = j * (nu + 1) + i;
        const oa = corner(a), ob = corner(a + 1), oc = corner(a + nu + 2);
        const v = mesh.verts;
        const ux = v[ob] - v[oa], uy = v[ob + 1] - v[oa + 1], uz = v[ob + 2] - v[oa + 2];
        const wx = v[oc] - v[oa], wy = v[oc + 1] - v[oa + 1], wz = v[oc + 2] - v[oa + 2];
        const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
        const dot = cx * v[oa + 3] + cy * v[oa + 4] + cz * v[oa + 5];
        if (Math.abs(dot) > 1e-12) { flip = dot < 0; break search; }
      }
    }

    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1, c = a + nu + 2, d = a + nu + 1;
        if (flip) mesh.quad(a, d, c, b); else mesh.quad(a, b, c, d);
      }
    }
  }

  /* Tessellation density, as a multiplier on the default target edge length.
   *
   * The movers need far more of it than static scenery. The light cone stretches
   * a moving object's image along its motion by up to 1/(1 - beta): at 0.78 that
   * is 4.55x, so a 0.55 m edge gets drawn up to 2.5 m long. The stretch is real
   * — parts of a moving body genuinely are seen at different moments — but a mesh
   * cut for its rest size cannot draw it, and the long thin triangles read as
   * spikes tearing out of the hull. Same principle as the ground: the transform
   * is applied per vertex, so the mesh has to be fine enough to follow the curve
   * it bends into. */
  let detail = 1;
  function setDetail(k) { detail = k; }
  const seg = (len, target) =>
    Math.max(1, Math.min(220, Math.round((len * detail) / (target || 0.55))));

  /* Axis-aligned box, centre (cx,cy,cz), full extents (sx,sy,sz).
   * tint(x,y,z) may return a per-vertex colour (used for striped rods). */
  /* uvAspect, when given, lays the texture on each face as a centred decal of
   * that width:height ratio, scaled to fit. Stretching one image across faces of
   * different proportions distorts it differently on each; fitting does not.
   *
   * uvAxis restricts the decal to the faces whose normal runs along that axis
   * ('x', 'y' or 'z'). The rest get UVs outside the unit square, which the
   * shader already reads as "no decal here" — so this needs no shader support. */
  function box(mesh, cx, cy, cz, sx, sy, sz, color, mat, tint, uvAspect, uvAxis) {
    const AXIS = { x: 0, y: 1, z: 2 };
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const ni = seg(sx), nj = seg(sy), nk = seg(sz);
    const faces = [
      [[1, 0, 0], hx, [0, 0, 1], [0, 1, 0], nk, nj],
      [[-1, 0, 0], hx, [0, 0, 1], [0, 1, 0], nk, nj],
      [[0, 1, 0], hy, [1, 0, 0], [0, 0, 1], ni, nk],
      [[0, -1, 0], hy, [1, 0, 0], [0, 0, 1], ni, nk],
      [[0, 0, 1], hz, [1, 0, 0], [0, 1, 0], ni, nj],
      [[0, 0, -1], hz, [1, 0, 0], [0, 1, 0], ni, nj]
    ];
    for (const [n, off, ua, va, nu, nv] of faces) {
      const uh = [ua[0] * hx, ua[1] * hy, ua[2] * hz];
      const vh = [va[0] * hx, va[1] * hy, va[2] * hz];
      let uvx = null;
      if (uvAspect) {
        if (uvAxis !== undefined && Math.abs(n[AXIS[uvAxis]]) < 0.5) {
          uvx = [1, 1, 5, 5];   // parked outside [0,1]: this face carries none
        } else {
          const fw = 2 * (ua[0] * hx + ua[1] * hy + ua[2] * hz);
          const fh = 2 * (va[0] * hx + va[1] * hy + va[2] * hz);
          const dh = Math.min(fh, fw / uvAspect);
          const su = fw / (dh * uvAspect), sv = fh / dh;
          uvx = [su, sv, (1 - su) / 2, (1 - sv) / 2];
        }
      }
      patch(mesh, nu, nv, color, mat, (u, v) => {
        const s = (u - 0.5) * 2, t = (v - 0.5) * 2;
        const p = [
          cx + n[0] * off + uh[0] * s + vh[0] * t,
          cy + n[1] * off + uh[1] * s + vh[1] * t,
          cz + n[2] * off + uh[2] * s + vh[2] * t
        ];
        return [p, n];
      }, uvx);
      if (tint) {
        // Re-colour the vertices just written.
        const v = mesh.verts;
        for (let k = v.length - (nu + 1) * (nv + 1) * STRIDE; k < v.length; k += STRIDE) {
          const c = tint(v[k], v[k + 1], v[k + 2]);
          v[k + 6] = c[0]; v[k + 7] = c[1]; v[k + 8] = c[2];
        }
      }
    }
  }

  function cylinder(mesh, cx, cy, cz, radius, height, color, mat, radial) {
    const nu = radial || 20, nv = seg(height, 0.7);
    patch(mesh, nu, nv, color, mat, (u, v) => {
      const a = u * Math.PI * 2;
      const n = [Math.cos(a), 0, Math.sin(a)];
      return [[cx + n[0] * radius, cy + v * height, cz + n[2] * radius], n];
    });
    // top cap
    patch(mesh, nu, 3, color, mat, (u, v) => {
      const a = u * Math.PI * 2;
      return [[cx + Math.cos(a) * radius * v, cy + height, cz + Math.sin(a) * radius * v], [0, 1, 0]];
    });
  }

  function sphere(mesh, cx, cy, cz, radius, color, mat, nu, nv) {
    nu = nu || 24; nv = nv || 16;
    patch(mesh, nu, nv, color, mat, (u, v) => {
      const a = u * Math.PI * 2, b = v * Math.PI;
      const n = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
      return [[cx + n[0] * radius, cy + n[1] * radius, cz + n[2] * radius], n];
    });
  }

  /* Torus standing upright in the XY plane (an arch you can walk through). */
  function torusXY(mesh, cx, cy, cz, major, minor, color, mat, nu, nv) {
    nu = nu || 64; nv = nv || 14;
    patch(mesh, nu, nv, color, mat, (u, v) => {
      const a = u * Math.PI * 2, b = v * Math.PI * 2;
      const dir = [Math.cos(a), Math.sin(a), 0];
      const n = [dir[0] * Math.cos(b), dir[1] * Math.cos(b), Math.sin(b)];
      return [[
        cx + dir[0] * major + n[0] * minor,
        cy + dir[1] * major + n[1] * minor,
        cz + n[2] * minor
      ], n];
    });
  }

  /* Ground plane as an exponentially graded polar disc: dense underfoot, coarse
   * at the horizon, so the bending of the ground stays smooth wherever you look. */
  function groundDisc(mesh, rMin, rMax, rings, sectors, color, mat) {
    const k = Math.log(rMax / rMin) / rings;
    patch(mesh, sectors, rings, color, mat, (u, v) => {
      const a = u * Math.PI * 2;
      const r = rMin * Math.exp(k * v * rings);
      return [[Math.cos(a) * r, 0, Math.sin(a) * r], [0, 1, 0]];
    });
    // Fill the disc at the centre, where the exponential grading cannot reach.
    patch(mesh, sectors, 6, color, mat, (u, v) => {
      const a = u * Math.PI * 2;
      return [[Math.cos(a) * rMin * v, 0, Math.sin(a) * rMin * v], [0, 1, 0]];
    });
  }

  function skyDome(mesh, radius, nu, nv) {
    // Extends well below the horizon so nothing shows through at the edge of the world.
    const vMax = 0.62;
    patch(mesh, nu, nv, [1, 1, 1], [4, 0], (u, v) => {
      const a = u * Math.PI * 2, b = v * vMax * Math.PI;
      const d = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
      return [[d[0] * radius, d[1] * radius, d[2] * radius], [-d[0], -d[1], -d[2]]];
    });
  }

  /* A ridgeline of hills on the horizon: a displaced annulus. Gives the eye
   * something distant to judge aberration against. */
  function mountainRing(mesh, rInner, rOuter, sectors, color, mat, seed) {
    let s = seed || 1;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const h = [];
    for (let i = 0; i < sectors; i++) h.push(rnd());
    const noise = t => {
      const x = t * sectors, i = Math.floor(x), f = x - i;
      const a = h[i % sectors], b = h[(i + 1) % sectors];
      const w = f * f * (3 - 2 * f);
      return a + (b - a) * w;
    };
    const height = t => (noise(t) * 0.55 + noise(t * 3.7 + 0.31) * 0.3 + noise(t * 9.1 + 0.77) * 0.15);
    patch(mesh, sectors, 10, color, mat, (u, v) => {
      const a = u * Math.PI * 2;
      const r = rInner + (rOuter - rInner) * Math.pow(v, 0.75);
      const crest = 40 + 340 * Math.pow(height(u), 1.9);
      const y = crest * Math.sin(Math.pow(v, 0.8) * Math.PI * 0.5) * (1 - v * 0.15);
      // Tilted toward the ring centre: the park is inside this ring, so this is
      // the side that faces the observer and therefore the side that is lit.
      const n = [-Math.cos(a) * 0.35, 0.9, -Math.sin(a) * 0.35];
      const len = Math.hypot(n[0], n[1], n[2]);
      return [[Math.cos(a) * r, y, Math.sin(a) * r], [n[0] / len, n[1] / len, n[2] / len]];
    });
  }

  R.geo = { Mesh, patch, box, cylinder, sphere, torusXY, groundDisc, skyDome, mountainRing,
            seg, setDetail, STRIDE };
})(window.Rel = window.Rel || {});
