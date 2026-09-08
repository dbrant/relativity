/* glutil.js — thin WebGL2 helpers. No dependencies. */
(function (R) {
  'use strict';

  function compile(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const numbered = src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n');
      throw new Error('Shader compile failed (' + label + '):\n' + log + '\n' + numbered);
    }
    return sh;
  }

  // Builds a program and eagerly caches every active uniform/attribute location.
  function program(gl, vsSrc, fsSrc, label) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, label + '.vert'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + '.frag'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link failed (' + label + '): ' + gl.getProgramInfoLog(p));
    }
    const u = Object.create(null), a = Object.create(null);
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) {
      const info = gl.getActiveAttrib(p, i);
      a[info.name] = gl.getAttribLocation(p, info.name);
    }
    return { prog: p, u: u, a: a, label: label };
  }

  // Interleaved layout shared by every mesh in the sim.
  // pos(3) normal(3) color(3) mat(3) uv(2)  =  14 floats
  const STRIDE = 14;

  function uploadMesh(gl, prog, mesh) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.verts), gl.STATIC_DRAW);

    const bytes = STRIDE * 4;
    const bind = (name, size, offsetFloats) => {
      const loc = prog.a[name];
      if (loc === undefined || loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offsetFloats * 4);
    };
    bind('aPos', 3, 0);
    bind('aNormal', 3, 3);
    bind('aColor', 3, 6);
    bind('aMat', 3, 9);
    bind('aUV', 2, 12);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    const big = mesh.verts.length / STRIDE > 65535;
    const idx = big ? new Uint32Array(mesh.tris) : new Uint16Array(mesh.tris);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    return {
      vao: vao,
      vbo: vbo,
      ibo: ibo,
      count: mesh.tris.length,
      type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      verts: mesh.verts.length / STRIDE
    };
  }

  function disposeMesh(gl, m) {
    if (!m) return;
    gl.deleteVertexArray(m.vao);
    gl.deleteBuffer(m.vbo);
    gl.deleteBuffer(m.ibo);
  }

  function perspective(out, fovyRad, aspect, near) {
    // Infinite-far projection; depth is remapped logarithmically in the shader.
    const f = 1 / Math.tan(fovyRad / 2);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = -1; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = -2 * near; out[15] = 0;
    return out;
  }

  R.gl = { program, uploadMesh, disposeMesh, perspective, STRIDE };
})(window.Rel = window.Rel || {});
