/* app.js — controls, relativistic dynamics, render loop, instruments. */
(function (R) {
  'use strict';

  const { gl: GL, color: COLOR, scene: SCENE, shaders: SH } = R;

  // ---------------------------------------------------------------- state ---
  const S = {
    c: 5 / 3.6,                  // walking pace, in metres per second
    pos: [SCENE.start.x, SCENE.start.y, SCENE.start.z],
    vel: [0, 0, 0],
    yaw: SCENE.start.yaw,
    pitch: SCENE.start.pitch,
    tWorld: 0,                   // clock of the world you are walking through
    tau: 0,                      // your own wristwatch
    fx: { delay: true, aberr: true, doppler: true, beam: true },
    beamExp: 4.0,
    exposure: 1.0,
    groundDetail: 2,        // the floor the user chooses
    groundActive: 2,        // what is actually drawn right now
    groundAdaptive: true,
    eyeAdapt: true,
    adapt: 1.0,                  // current state of the observer's eye
    resScale: 1.0,
    running: false
  };

  const ADAPT_TAU = 0.30;        // seconds for the eye to catch up

  const ACCEL = 1.25;            // proper acceleration, in rapidity per second
  const BRAKE_DECAY = 6.0;
  const BETA_MAX = 0.99999;
  const EYE_MIN = 0.6, EYE_MAX = 400;

  const SUN = norm([-0.44, 0.62, 0.65]);
  const SKY = {
    zenith: [0.17, 0.34, 0.76],
    horizon: [0.66, 0.75, 0.87],
    haze: [0.74, 0.78, 0.82],
    sun: [1.00, 0.95, 0.86]
  };
  const FOG_DENSITY = 0.0009;
  const BEACON_RATE = 1.0;       // blinks per second of world time

  // ------------------------------------------------------------ vec helpers -
  function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function len(v) { return Math.hypot(v[0], v[1], v[2]); }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  /* Einstein velocity addition: v (world frame) combined with u, a velocity
   * given in v's own instantaneous rest frame. Keeps |v| below c no matter how
   * long you hold the key down — you can push forever and never arrive. */
  function addVelocity(v, u, c) {
    const c2 = c * c;
    const v2 = dot(v, v);
    if (v2 < 1e-16) return [u[0], u[1], u[2]];
    const g = 1 / Math.sqrt(Math.max(1e-12, 1 - v2 / c2));
    const vu = dot(v, u);
    const den = 1 + vu / c2;
    const k = (g / (g + 1)) * (vu / c2);
    return [
      (v[0] * (1 + k) + u[0] / g) / den,
      (v[1] * (1 + k) + u[1] / g) / den,
      (v[2] * (1 + k) + u[2] / g) / den
    ];
  }

  function shedRapidity(v, amount, c) {
    const sp = len(v);
    if (sp < 1e-9) return [0, 0, 0];
    const phi = Math.max(0, Math.atanh(Math.min(sp / c, 0.9999999)) - amount);
    const k = (c * Math.tanh(phi)) / sp;
    return [v[0] * k, v[1] * k, v[2] * k];
  }

  // ----------------------------------------------------------------- input --
  const keys = Object.create(null);
  const CODE = {
    KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    KeyQ: 'down', KeyE: 'up', Space: 'brake'
  };

  // One key per effect, rather than one key for all of them: seeing which single
  // piece of the physics you just removed is more instructive than seeing all
  // four go at once.
  const FX_KEYS = { KeyL: 'delay', KeyG: 'aberr', KeyC: 'doppler', KeyB: 'beam' };

  let canvas, glc, hud;

  function setupInput() {
    /* Getting in is deliberately NOT conditional on pointer lock succeeding.
     * Some browsers and embedding contexts refuse the lock, and tying the
     * overlay to it would leave you staring at an undismissable card. */
    const begin = () => {
      hud.overlay.classList.add('is-hidden');
      hud.hint.classList.remove('is-faded');
      if (!document.pointerLockElement && canvas.requestPointerLock) {
        const req = canvas.requestPointerLock();
        if (req && req.catch) req.catch(() => {});   // fall back to drag-to-look
      }
    };
    const overlayUp = () => !hud.overlay.classList.contains('is-hidden');

    addEventListener('keydown', e => {
      if (e.code === 'Escape') { return; }           // the browser releases the lock
      if (e.repeat) { return; }                      // held keys must not flicker toggles

      const fx = FX_KEYS[e.code];
      if (fx) { S.fx[fx] = !S.fx[fx]; syncControls(); return; }

      if (e.code === 'Tab') { e.preventDefault(); togglePanel(); return; }
      if (e.code === 'KeyR') { resetObserver(); return; }
      if (e.code === 'KeyH') { toggleHelp(); return; }
      const a = CODE[e.code];
      if (a) {
        if (overlayUp()) begin();                    // just walking gets you in
        keys[a] = true;
        e.preventDefault();
      }
    });
    addEventListener('keyup', e => { const a = CODE[e.code]; if (a) keys[a] = false; });
    addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

    hud.overlay.addEventListener('click', begin);
    canvas.addEventListener('click', begin);

    // Losing the lock is not an event worth interrupting anyone for: the world
    // keeps running either way, the keys still work, and clicking takes the
    // mouse back. So nothing happens here but tidying the intro away.
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === canvas) {
        hud.overlay.classList.add('is-hidden');
        hud.hint.classList.remove('is-faded');
      }
    });

    const look = (dx, dy) => {
      S.yaw -= dx * 0.0022;
      S.pitch = Math.max(-1.45, Math.min(1.45, S.pitch - dy * 0.0022));
    };
    addEventListener('mousemove', e => {
      if (document.pointerLockElement === canvas) look(e.movementX, e.movementY);
      else if (dragging) look(e.movementX || 0, e.movementY || 0);
    });
    let dragging = false;
    canvas.addEventListener('mousedown', () => { dragging = true; });
    addEventListener('mouseup', () => { dragging = false; });
  }

  function resetObserver() {
    S.pos = [SCENE.start.x, SCENE.start.y, SCENE.start.z];
    S.vel = [0, 0, 0];
    S.yaw = SCENE.start.yaw;
    S.pitch = SCENE.start.pitch;
    S.tWorld = 0;
    S.tau = 0;
  }

  // ---------------------------------------------------------------- physics -
  function step(dt) {
    const c = S.c;
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    const fwdH = [-sy, 0, -cy];
    const rightH = [cy, 0, -sy];

    let d = [0, 0, 0];
    if (keys.fwd) { d[0] += fwdH[0]; d[2] += fwdH[2]; }
    if (keys.back) { d[0] -= fwdH[0]; d[2] -= fwdH[2]; }
    if (keys.right) { d[0] += rightH[0]; d[2] += rightH[2]; }
    if (keys.left) { d[0] -= rightH[0]; d[2] -= rightH[2]; }
    if (keys.up) d[1] += 1;
    if (keys.down) d[1] -= 1;

    const dl = len(d);
    if (keys.brake) {
      S.vel = shedRapidity(S.vel, BRAKE_DECAY * dt, c);
    } else if (dl > 1e-6) {
      const a = ACCEL * dt;
      S.vel = addVelocity(S.vel, [d[0] / dl * a * c, d[1] / dl * a * c, d[2] / dl * a * c], c);
    }
    // No drag term: let go and you keep the velocity you built up. Space is
    // the only way back down, which is also the only honest option — there is
    // nothing here to rub against.

    let sp = len(S.vel);
    if (sp > BETA_MAX * c) {
      const k = (BETA_MAX * c) / sp;
      S.vel = [S.vel[0] * k, S.vel[1] * k, S.vel[2] * k];
      sp = BETA_MAX * c;
    }

    const beta = sp / c;
    const gamma = 1 / Math.sqrt(Math.max(1e-12, 1 - beta * beta));

    // Real time is YOUR time. The world's clock is the one that runs fast.
    const dtWorld = dt * gamma;
    S.tau += dt;
    S.tWorld += dtWorld;
    S.pos = [
      S.pos[0] + S.vel[0] * dtWorld,
      S.pos[1] + S.vel[1] * dtWorld,
      S.pos[2] + S.vel[2] * dtWorld
    ];

    if (S.pos[1] < EYE_MIN) { S.pos[1] = EYE_MIN; if (S.vel[1] < 0) S.vel[1] = 0; }
    if (S.pos[1] > EYE_MAX) { S.pos[1] = EYE_MAX; if (S.vel[1] > 0) S.vel[1] = 0; }

    return { beta, gamma, speed: sp };
  }

  // ---------------------------------------------------------------- renderer
  const R3 = {};

  function variant(src, defs) {
    const nl = src.indexOf('\n');
    return src.slice(0, nl + 1) + defs + src.slice(nl + 1);
  }

  function initGL() {
    glc = canvas.getContext('webgl2', {
      antialias: true, alpha: false, depth: true,
      powerPreference: 'high-performance'
    });
    if (!glc) throw new Error('This simulator needs WebGL 2, which this browser did not provide.');
    const g = glc;

    R3.progWorld = GL.program(g, variant(SH.VERT, '#define MOTION 0\n'), SH.FRAG_WORLD, 'world');
    R3.progSky = GL.program(g, variant(SH.VERT, '#define MOTION 0\n'), SH.FRAG_SKY, 'sky');
    R3.progCar = GL.program(g, variant(SH.VERT, '#define MOTION 1\n'), SH.FRAG_WORLD, 'carousel');
    R3.progShuttle = GL.program(g, variant(SH.VERT, '#define MOTION 2\n'), SH.FRAG_WORLD, 'shuttle');

    R3.mWorld = GL.uploadMesh(g, R3.progWorld, SCENE.buildStatic());
    R3.groundCache = [];
    R3.mGround = groundMesh(S.groundDetail);
    R3.mSky = GL.uploadMesh(g, R3.progSky, SCENE.buildSky());
    R3.mCar = GL.uploadMesh(g, R3.progCar, SCENE.buildCarousel());
    R3.mShuttle = GL.uploadMesh(g, R3.progShuttle, SCENE.buildShuttle());

    R3.lut = COLOR.buildLut(g);
    R3.exposure = S.exposure;
    R3.proj = new Float32Array(16);
    R3.viewRot = new Float32Array(9);

    g.clearColor(0.02, 0.03, 0.05, 1);
    g.disable(g.CULL_FACE);           // Terrell rotation shows you faces that
    g.depthFunc(g.LEQUAL);            // were pointing away; never cull them.
    g.enable(g.DEPTH_TEST);
  }

  function totalVerts() {
    return [R3.mWorld, R3.mGround, R3.mSky, R3.mCar, R3.mShuttle, R3.mModels]
      .reduce((n, m) => n + (m ? m.verts : 0), 0);
  }

  /* Levels are built once and kept. Rebuilding a 650k-vertex disc costs a few
   * hundred milliseconds, which would be a visible hitch every time you crossed
   * a threshold — and you cross them while accelerating, when it shows most. */
  function groundMesh(level) {
    if (!R3.groundCache[level]) {
      R3.groundCache[level] = GL.uploadMesh(glc, R3.progWorld, SCENE.buildGround(level));
    }
    return R3.groundCache[level];
  }

  function useGroundLevel(level) {
    if (level === S.groundActive && R3.mGround) return;
    S.groundActive = level;
    R3.mGround = groundMesh(level);
    const el = document.getElementById('v-verts');
    if (el) el.textContent = (totalVerts() / 1000).toFixed(0) + 'k';
    const note = document.getElementById('opt-ground-now');
    if (note) {
      note.textContent = level === S.groundDetail
        ? '' : 'raised to ' + SCENE.GROUND_LEVELS[level].label + ' by your speed';
    }
  }

  function setGroundFloor(level) {
    S.groundDetail = Math.max(0, Math.min(SCENE.GROUND_LEVELS.length - 1, Math.round(level)));
    useGroundLevel(Math.max(S.groundDetail, S.groundAdaptive ? S.groundActive : 0));
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2) * S.resScale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  const LOG_DEPTH_C = 2.0 / Math.log2(1e7 + 1.0);

  function setCommon(p, kin, betaDir) {
    const g = glc, u = p.u;
    g.useProgram(p.prog);
    g.uniformMatrix4fv(u.uProj, false, R3.proj);
    g.uniformMatrix3fv(u.uViewRot, false, R3.viewRot);
    g.uniform3fv(u.uObsPos, S.pos);
    g.uniform3fv(u.uBetaDir, betaDir);
    g.uniform1f(u.uBetaMag, kin.beta);
    g.uniform1f(u.uGamma, kin.gamma);
    g.uniform1f(u.uC, S.c);
    g.uniform1f(u.uT, S.tWorld);
    g.uniform1f(u.uLogDepthC, LOG_DEPTH_C);
    g.uniform1f(u.uUseDelay, S.fx.delay ? 1 : 0);
    g.uniform1f(u.uUseAberr, S.fx.aberr ? 1 : 0);
    g.uniform3f(u.uOffset, 0, 0, 0);

    g.uniform3fv(u.uSunDir, SUN);
    g.uniform3fv(u.uSunTint, SKY.sun);
    g.uniform3fv(u.uZenith, SKY.zenith);
    g.uniform3fv(u.uHorizon, SKY.horizon);
    g.uniform3fv(u.uHaze, SKY.haze);
    g.uniform1f(u.uFogDensity, FOG_DENSITY);
    g.uniform1f(u.uBeaconRate, BEACON_RATE);
    g.uniform3fv(u.uBandColor, SCENE.BAND_COLOR);
    g.uniform1f(u.uBandWidth, SCENE.BAND_WIDTH);

    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, R3.lut.tex);
    g.uniform1i(u.uLut, 0);
    g.uniform1i(u.uLutN, R3.lut.n);
    g.uniform1f(u.uLutLogMin, R3.lut.logMin);
    g.uniform1f(u.uLutLogMax, R3.lut.logMax);

    g.uniform1f(u.uDopplerOn, S.fx.doppler ? 1 : 0);
    g.uniform1f(u.uBeamOn, S.fx.beam ? 1 : 0);
    g.uniform1f(u.uBeamExp, S.beamExp);
    g.uniform1f(u.uExposure, R3.exposure);
  }

  function drawMesh(m) {
    glc.bindVertexArray(m.vao);
    glc.drawElements(glc.TRIANGLES, m.count, m.type, 0);
  }

  function render(kin, dt) {
    const g = glc;
    resize();
    g.viewport(0, 0, canvas.width, canvas.height);

    GL.perspective(R3.proj, 1.20, canvas.width / canvas.height, 0.05);

    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw);
    const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const fwd = [-sy * cp, sp, -cy * cp];
    const right = [cy, 0, -sy];
    const up = cross([-fwd[0], -fwd[1], -fwd[2]], right);
    const m = R3.viewRot;
    m[0] = right[0]; m[1] = up[0]; m[2] = -fwd[0];
    m[3] = right[1]; m[4] = up[1]; m[5] = -fwd[1];
    m[6] = right[2]; m[7] = up[2]; m[8] = -fwd[2];

    const bd = kin.speed > 1e-9
      ? [S.vel[0] / kin.speed, S.vel[1] / kin.speed, S.vel[2] / kin.speed]
      : [0, 0, 1];

    R3.exposure = adaptedExposure(kin, { right, up, fwd, bd }, dt);

    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);

    // The sky is behind everything at every angle, so it needs no depth at all.
    g.depthMask(false);
    g.disable(g.DEPTH_TEST);
    setCommon(R3.progSky, kin, bd);
    g.uniform1f(R3.progSky.u.uCloudScale, 3.0);
    drawMesh(R3.mSky);

    g.enable(g.DEPTH_TEST);
    g.depthMask(true);

    setCommon(R3.progWorld, kin, bd);
    drawMesh(R3.mWorld);
    if (R3.mModels) drawMesh(R3.mModels);

    // The ground is a tessellation carrier, not scenery: its grid and mottle
    // are computed from world coordinates in the fragment shader, so sliding
    // the mesh along with the eye is invisible — and it keeps the finest
    // rings underfoot however far you have walked from the origin.
    g.uniform3f(R3.progWorld.u.uOffset, S.pos[0], 0, S.pos[2]);
    drawMesh(R3.mGround);
    g.uniform3f(R3.progWorld.u.uOffset, 0, 0, 0);

    const K = SCENE.CAROUSEL;
    const carOmega = (K.beta * S.c) / K.radius;
    setCommon(R3.progCar, kin, bd);
    g.uniform4f(R3.progCar.u.uMotionA, K.cx, 0, K.cz, K.radius);
    g.uniform4f(R3.progCar.u.uMotionB, carOmega, 1 / Math.sqrt(1 - K.beta * K.beta), K.bound, 0);
    drawMesh(R3.mCar);

    const T = SCENE.SHUTTLE;
    setCommon(R3.progShuttle, kin, bd);
    g.uniform4f(R3.progShuttle.u.uMotionA, T.bx, T.by, T.bz, T.amp);
    g.uniform4f(R3.progShuttle.u.uMotionB, (T.beta * S.c) / T.amp, 1, T.bound, 0);
    drawMesh(R3.mShuttle);

    return { fwd, bd };
  }

  /* Eye adaptation.
   *
   * Beaming is a D^4 law, so at a brisk jog the road ahead is ten times its
   * resting brightness and the frame clips to white — which hides the very
   * effects it is supposed to show. A real observer's retina would adapt, so
   * we adapt too: sample the beaming factor across the field of view, take the
   * log-average (the same key value ordinary auto-exposure uses), and let the
   * eye chase it with a time constant. The front-to-back gradient WITHIN the
   * frame is untouched — only the overall level moves. */
  function adaptedExposure(kin, basis, dt) {
    let target = 1;
    if (S.eyeAdapt && S.fx.beam && kin.beta > 1e-6) {
      const ty = Math.tan(0.60);
      const tx = ty * (canvas.width / Math.max(1, canvas.height));
      let logSum = 0, n = 0;
      for (let j = 0; j <= 5; j++) {
        for (let i = 0; i <= 5; i++) {
          const px = tx * ((i / 5) * 2 - 1), py = ty * ((j / 5) * 2 - 1);
          const d = norm([
            basis.right[0] * px + basis.up[0] * py + basis.fwd[0],
            basis.right[1] * px + basis.up[1] * py + basis.fwd[1],
            basis.right[2] * px + basis.up[2] * py + basis.fwd[2]
          ]);
          const cosT = dot(d, basis.bd);
          logSum += Math.log(1 / (kin.gamma * (1 - kin.beta * cosT)));
          n++;
        }
      }
      target = Math.exp(S.beamExp * (logSum / n));
    }
    target = Math.min(1e6, Math.max(1e-4, target));
    S.adapt += (target - S.adapt) * (1 - Math.exp(-dt / ADAPT_TAU));
    return S.exposure / Math.max(S.adapt, 1e-4);
  }

  // -------------------------------------------------------------- instruments
  const SPEC_MIN = 0.18, SPEC_MAX = 5.5;

  function clock(t) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function updateHud(kin, view) {
    const b = kin.beta, g = kin.gamma;

    hud.speed.textContent = (kin.speed * 3.6).toFixed(5);
    hud.beta.textContent = b < 0.999 ? b.toFixed(4) : b.toFixed(6);
    hud.gamma.textContent = g < 100 ? g.toFixed(3) : g.toFixed(0);
    hud.contract.textContent = '× ' + (1 / g).toFixed(4);

    // Doppler factor along the line of sight, expressed in the angle you
    // actually see it at:  D = 1 / (γ (1 − β cos θ')).
    const cosT = b > 1e-9 ? dot(view.fwd, view.bd) : 0;
    const D = 1 / (g * (1 - b * cosT));
    hud.dop.textContent = D.toFixed(3);
    hud.dopWord.textContent = D > 1.008 ? 'blueshift' : (D < 0.992 ? 'redshift' : 'at rest');

    const f = (Math.log(Math.min(SPEC_MAX, Math.max(SPEC_MIN, D))) - Math.log(SPEC_MIN)) /
      (Math.log(SPEC_MAX) - Math.log(SPEC_MIN));
    hud.marker.style.left = (f * 100).toFixed(2) + '%';

    hud.tau.textContent = clock(S.tau);
    hud.tworld.textContent = clock(S.tWorld);
    hud.rate.textContent = '× ' + g.toFixed(3);

    // The bar is drawn in rapidity, so equal effort reads as equal progress.
    const phi = Math.atanh(Math.min(b, 0.999999));
    hud.rapid.style.width = Math.min(100, (phi / 6.1) * 100).toFixed(1) + '%';
  }

  // --------------------------------------------------------------- UI wiring
  function togglePanel() { hud.panel.classList.toggle('is-open'); }
  function toggleHelp() { hud.help.classList.toggle('is-open'); }

  function syncControls() {
    for (const k in S.fx) {
      const el = document.getElementById('fx-' + k);
      if (el) el.checked = S.fx[k];
    }
    // Only the geometry toggle changes what SHAPE the world is, so that is the
    // one worth warning about on screen.
    hud.galilean.classList.toggle('is-on', !S.fx.aberr);
  }

  function bindControls() {
    for (const k of ['delay', 'aberr', 'doppler', 'beam']) {
      document.getElementById('fx-' + k).addEventListener('change', e => {
        S.fx[k] = e.target.checked;
        syncControls();
      });
    }
    const slider = (id, out, apply, fmt) => {
      const el = document.getElementById(id);
      const o = document.getElementById(out);
      const upd = () => { const v = parseFloat(el.value); apply(v); o.textContent = fmt(v); };
      el.addEventListener('input', upd);
      upd();
    };
    slider('opt-c', 'opt-c-out', v => {
      S.c = v / 3.6;
      const m = document.getElementById('v-c');
      if (m) m.textContent = 'c = ' + (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) + ' km/h';
    }, v => v.toFixed(1) + ' km/h');
    slider('opt-exposure', 'opt-exposure-out', v => { S.exposure = v; }, v => v.toFixed(2));
    slider('opt-beam', 'opt-beam-out', v => { S.beamExp = v; }, v => 'D^' + v.toFixed(1));
    slider('opt-res', 'opt-res-out', v => { S.resScale = v; }, v => Math.round(v * 100) + '%');
    document.getElementById('opt-ground-adapt').addEventListener('change', e => {
      S.groundAdaptive = e.target.checked;
      if (!S.groundAdaptive) useGroundLevel(S.groundDetail);
    });
    slider('opt-ground', 'opt-ground-out', setGroundFloor,
      v => SCENE.GROUND_LEVELS[Math.round(v)].label);

    document.getElementById('opt-eye').addEventListener('change', e => {
      S.eyeAdapt = e.target.checked;
      if (!S.eyeAdapt) S.adapt = 1;
    });

    document.getElementById('panel-close').addEventListener('click', togglePanel);
    document.getElementById('help-close').addEventListener('click', toggleHelp);
    document.getElementById('open-panel').addEventListener('click', togglePanel);
    document.getElementById('open-help').addEventListener('click', toggleHelp);
    syncControls();
  }

  function paintSpectrum() {
    const stops = COLOR.spectrumStops(24, SPEC_MIN, SPEC_MAX);
    const css = stops.map(s => s.css + ' ' + (s.f * 100).toFixed(1) + '%').join(', ');
    hud.spectrum.style.background = 'linear-gradient(90deg, ' + css + ')';
  }

  /* Models arrive after the first frame. The park is complete without them, so
   * a missing or malformed STL costs a console line and nothing else. */
  function loadModels() {
    const specs = SCENE.MODELS || [];
    if (!specs.length) return;
    Promise.all(specs.map(spec =>
      R.stl.fetchModel(spec.file)
        .then(buf => ({ spec, pos: R.stl.parse(buf) }))
        .catch(err => {
          console.warn('Skipping ' + spec.file + ': ' + err.message);
          return null;
        })
    )).then(loaded => {
      const mesh = new R.geo.Mesh();
      let placed = 0;
      for (const item of loaded) {
        if (!item) continue;
        try {
          R.stl.addToMesh(mesh, item.pos, item.spec);
          placed++;
        } catch (err) {
          console.warn('Skipping ' + item.spec.file + ': ' + err.message);
        }
      }
      if (!placed) return;
      R3.mModels = GL.uploadMesh(glc, R3.progWorld, mesh);
      const el = document.getElementById('v-verts');
      if (el) el.textContent = (totalVerts() / 1000).toFixed(0) + 'k';
    });
  }

  // --------------------------------------------------------------------- go -
  function boot() {
    canvas = document.getElementById('view');
    hud = {
      overlay: document.getElementById('overlay'),
      hint: document.getElementById('hint'),
      panel: document.getElementById('panel'),
      help: document.getElementById('help'),
      galilean: document.getElementById('galilean'),
      spectrum: document.getElementById('spectrum'),
      marker: document.getElementById('marker'),
      speed: document.getElementById('v-speed'),
      beta: document.getElementById('v-beta'),
      gamma: document.getElementById('v-gamma'),
      contract: document.getElementById('v-contract'),
      dop: document.getElementById('v-dop'),
      dopWord: document.getElementById('v-dopword'),
      tau: document.getElementById('v-tau'),
      tworld: document.getElementById('v-tworld'),
      rate: document.getElementById('v-rate'),
      rapid: document.getElementById('v-rapid'),
      fps: document.getElementById('v-fps')
    };

    try {
      initGL();
      document.getElementById('v-verts').textContent = (totalVerts() / 1000).toFixed(0) + 'k';
    } catch (err) {
      document.getElementById('overlay-title').textContent = 'Cannot start';
      document.getElementById('overlay-body').textContent = err.message;
      console.error(err);
      return;
    }

    paintSpectrum();
    bindControls();
    setupInput();
    loadModels();

    let last = performance.now(), acc = 0, frames = 0, hudAcc = 0;
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frames++; acc += dt; hudAcc += dt;

      const kin = step(dt);
      if (S.groundAdaptive) {
        useGroundLevel(SCENE.adaptiveGroundLevel(kin.gamma, S.groundDetail, S.groundActive));
      }
      const view = render(kin, dt);

      if (hudAcc > 0.08) { updateHud(kin, view); hudAcc = 0; }
      if (acc > 0.5) { hud.fps.textContent = Math.round(frames / acc); frames = 0; acc = 0; }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    setTimeout(() => hud.hint.classList.add('is-faded'), 14000);
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.Rel = window.Rel || {});
