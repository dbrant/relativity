/* stl.js — load STL models into the sim's mesh format.
 *
 * Three things have to happen that a normal STL loader would not bother with:
 *
 *   WELD    STL stores every triangle's three corners independently, so a
 *           closed model arrives as loose facets. Welding by position gives an
 *           indexed mesh and lets us average normals into smooth shading.
 *
 *   SUBDIVIDE  The relativistic transform is applied per vertex and bends
 *           straight edges into curves, so a long edge is drawn as a chord of
 *           the curve it should be. Uniform 4-way splitting keeps shared edges
 *           splitting identically, so no T-junctions open up at speed.
 *
 *   FIT     STL carries no units and no agreed up-axis. Blender writes Z-up,
 *           and these models arrive about 86 units tall. Everything is
 *           auto-fitted to a real height in metres and stood on the ground.
 */
(function (R) {
  'use strict';

  /* Binary STL is 84 + 50n bytes exactly; anything else claiming to be STL is
   * treated as ASCII. Checking the length beats sniffing for "solid", which
   * binary files also start with often enough to matter. */
  function parse(buffer) {
    const dv = new DataView(buffer);
    if (buffer.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (buffer.byteLength === 84 + n * 50) return parseBinary(dv, n);
    }
    return parseAscii(new TextDecoder().decode(buffer));
  }

  function parseBinary(dv, n) {
    const pos = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50;
      for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
    }
    return pos;
  }

  function parseAscii(text) {
    const out = [];
    const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
    let m;
    while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
    if (out.length < 9) throw new Error('no triangles found');
    return new Float32Array(out.slice(0, Math.floor(out.length / 9) * 9));
  }

  /* Weld to an indexed mesh and average facet normals at each vertex. */
  function weld(pos) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (pos[i + a] < lo[a]) lo[a] = pos[i + a];
        if (pos[i + a] > hi[a]) hi[a] = pos[i + a];
      }
    }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    const q = 1 / (diag * 1e-5);

    const map = new Map();
    const verts = [], normals = [], index = [];
    const key = (x, y, z) =>
      Math.round(x * q) + ',' + Math.round(y * q) + ',' + Math.round(z * q);

    for (let t = 0; t < pos.length; t += 9) {
      const ax = pos[t], ay = pos[t + 1], az = pos[t + 2];
      const bx = pos[t + 3], by = pos[t + 4], bz = pos[t + 5];
      const cx = pos[t + 6], cy = pos[t + 7], cz = pos[t + 8];
      // Facet normal weighted by area, which falls out of the un-normalised cross
      // product — so slivers do not sway the average as much as real faces.
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

      for (let k = 0; k < 3; k++) {
        const x = pos[t + k * 3], y = pos[t + k * 3 + 1], z = pos[t + k * 3 + 2];
        const kk = key(x, y, z);
        let id = map.get(kk);
        if (id === undefined) {
          id = verts.length / 3;
          map.set(kk, id);
          verts.push(x, y, z);
          normals.push(0, 0, 0);
        }
        normals[id * 3] += nx; normals[id * 3 + 1] += ny; normals[id * 3 + 2] += nz;
        index.push(id);
      }
    }
    return { verts, normals, index, lo, hi };
  }

  /* One uniform 4-way split. Midpoints are cached per edge, so neighbouring
   * triangles reuse the same new vertex and the surface stays watertight. */
  function subdivide(m) {
    const mid = new Map();
    const midpoint = (a, b) => {
      const k = a < b ? a + ',' + b : b + ',' + a;
      let id = mid.get(k);
      if (id !== undefined) return id;
      id = m.verts.length / 3;
      for (let c = 0; c < 3; c++) {
        m.verts.push((m.verts[a * 3 + c] + m.verts[b * 3 + c]) * 0.5);
        m.normals.push(m.normals[a * 3 + c] + m.normals[b * 3 + c]);
      }
      mid.set(k, id);
      return id;
    };
    const out = [];
    for (let i = 0; i < m.index.length; i += 3) {
      const a = m.index[i], b = m.index[i + 1], c = m.index[i + 2];
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    m.index = out;
    return m;
  }

  function longestEdge(m) {
    let e = 0;
    for (let i = 0; i < m.index.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = m.index[i + k] * 3, b = m.index[i + (k + 1) % 3] * 3;
        const d = Math.hypot(m.verts[a] - m.verts[b],
                             m.verts[a + 1] - m.verts[b + 1],
                             m.verts[a + 2] - m.verts[b + 2]);
        if (d > e) e = d;
      }
    }
    return e;
  }

  const MAX_EDGE = 0.22;      // metres, before the boost starts showing chords
  const TRI_BUDGET = 60000;   // per model, so a coarse STL cannot run away

  /* spec: { file, x, z, height, yaw, color, mat, zUp } */
  function addToMesh(mesh, pos, spec) {
    const m = weld(pos);

    // Blender writes Z-up. Rotate into the sim's Y-up before measuring, so
    // "height" means what it says.
    const zUp = spec.zUp !== false;
    const n = m.verts.length / 3;
    if (zUp) {
      for (let i = 0; i < n; i++) {
        const y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
        m.verts[i * 3 + 1] = z; m.verts[i * 3 + 2] = -y;
        const ny = m.normals[i * 3 + 1], nz = m.normals[i * 3 + 2];
        m.normals[i * 3 + 1] = nz; m.normals[i * 3 + 2] = -ny;
      }
    }

    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.verts.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (m.verts[i + a] < lo[a]) lo[a] = m.verts[i + a];
        if (m.verts[i + a] > hi[a]) hi[a] = m.verts[i + a];
      }
    }
    const scale = spec.height / Math.max(hi[1] - lo[1], 1e-9);
    const cx = (lo[0] + hi[0]) * 0.5, cz = (lo[2] + hi[2]) * 0.5;
    const cosY = Math.cos(spec.yaw || 0), sinY = Math.sin(spec.yaw || 0);

    for (let i = 0; i < m.verts.length; i += 3) {
      const x = (m.verts[i] - cx) * scale;
      const y = (m.verts[i + 1] - lo[1]) * scale;
      const z = (m.verts[i + 2] - cz) * scale;
      m.verts[i] = spec.x + x * cosY + z * sinY;
      m.verts[i + 1] = (spec.y || 0) + y;
      m.verts[i + 2] = spec.z - x * sinY + z * cosY;
      const nx = m.normals[i], nz2 = m.normals[i + 2];
      m.normals[i] = nx * cosY + nz2 * sinY;
      m.normals[i + 2] = -nx * sinY + nz2 * cosY;
    }

    while (longestEdge(m) > MAX_EDGE && m.index.length / 3 * 4 <= TRI_BUDGET) {
      subdivide(m);
    }

    const base = mesh.count();
    const color = spec.color, mat = spec.mat || [0, 0, 0];
    for (let i = 0; i < m.verts.length; i += 3) {
      const nx = m.normals[i], ny = m.normals[i + 1], nz = m.normals[i + 2];
      const len = Math.hypot(nx, ny, nz) || 1;
      mesh.push([m.verts[i], m.verts[i + 1], m.verts[i + 2]],
                [nx / len, ny / len, nz / len], color, mat);
    }
    for (let i = 0; i < m.index.length; i++) mesh.tris.push(base + m.index[i]);

    return { verts: m.verts.length / 3, tris: m.index.length / 3 };
  }

  /* Straight off the server, as the file sits on disk. Drop a new STL into
   * objects/, name it in scene.js, reload — there is no build step to forget. */
  function fetchModel(file) {
    return fetch('objects/' + file).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    });
  }

  R.stl = { parse, addToMesh, fetchModel };
})(window.Rel = window.Rel || {});
