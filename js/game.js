// Game core: smoother physics, anti-tunneling, neon UI, seeded pathing, controls
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';
import { loadAvatarTexture, buildNameSprite, fireworks, createSeededRNG, binomialProbabilities, computeRTP } from './utils.js';
import { sfx } from './sfx.js';

(() => {
  const { Engine, World, Bodies, Composite, Events, Body } = Matter;

  // Board extents (world units)
  const BASE = { width: 18, height: 32 };

  // Defaults (overridable in drawer)
  const Defaults = {
    rows: 12,
    bet: 100,
    timeScale: 0.85,     // base smoothness/speed factor
    gravity: 0.55,       // gentle gravity for smooth falls
    air: 0.028,          // more air drag -> slower & smoother
    restitution: 0.18,   // less bouncy -> realistic
    risk: 0.5,           // payout shape
    nudge: 0.00045,      // guided path influence
    jitter: 0.00025,     // micro randomness on peg contact
    maxBalls: 8,         // concurrent balls limit
    vfx: true,           // confetti
    sfx: true            // sounds
  };

  // Geometry
  const PEG_SPACING = 1.2;
  const PEG_R_VIS = 0.18;
  const PEG_R_PHYS = PEG_R_VIS * 1.24; // slightly bigger hitbox for reliable contacts
  const BALL_R = 0.45;
  const SLOT_H = 1.2;
  const WALL_THK = 1;

  // Render caps
  const MAX_FPS = 60;
  const HIDDEN_FPS = 6;
  const PIXEL_RATIO_CAP = 1.5;

  // Physics loop constants
  const PHYS_HZ = 240;
  const PHYS_DT_MS = 1000 / PHYS_HZ;
  const MAX_SUBSTEPS = 12;
  const MAX_VEL_X = 7.5;
  const MAX_VEL_Y = 11.0;

  // Runtime state
  let cfg = loadConfig();
  let MULTS = genMultipliers(cfg.rows, cfg.risk, 0.96);

  let scene, camera, renderer;
  let engine, world;

  let pegInstanced = null;
  const slotSensors = []; // { body, index, x, mult }
  const rowY = [];

  const balls = new Set();      // Set<Matter.Body> active balls
  const meshes = new Map();     // id -> THREE.Mesh
  const labels = new Map();     // id -> THREE.Sprite

  let spawnEnabled = true;
  const leaderboard = {};
  const processedEvents = new Set();
  const startTime = Date.now();

  // DOM
  const boardViewport = document.getElementById('board-viewport');
  const confettiCanvas = document.getElementById('confetti-canvas');
  const slotLabelsEl = document.getElementById('slot-labels');
  const leaderboardList = document.getElementById('leaderboard-list');
  const spawnStatusEl = document.getElementById('spawn-status');
  const rowsLabel = document.getElementById('rows-label');
  const rtpLabel = document.getElementById('rtp-label');
  const seedLabel = document.getElementById('seed-label');
  const betLabel = document.getElementById('bet-label');

  // Drawer / controls
  const drawer = document.getElementById('drawer') || createDrawer(); // safety
  const btnGear = document.getElementById('btn-gear');
  const btnClose = document.getElementById('drawer-close');
  const ctrlRows = document.getElementById('ctrl-rows');
  const ctrlBet = document.getElementById('ctrl-bet');
  const ctrlSpeed = document.getElementById('ctrl-speed');
  const ctrlGravity = document.getElementById('ctrl-gravity');
  const ctrlAir = document.getElementById('ctrl-air');
  const ctrlRest = document.getElementById('ctrl-rest');
  const ctrlRisk = document.getElementById('ctrl-risk');
  const ctrlNudge = document.getElementById('ctrl-nudge');
  // New controls:
  const ctrlJitter = createRange('ctrl-jitter', 0, 0.0015, 0.00005, cfg.jitter);
  const ctrlMaxBalls = createRange('ctrl-max-balls', 1, 20, 1, cfg.maxBalls);
  const ctrlVfx = createCheckbox('ctrl-vfx', cfg.vfx);
  const ctrlSfx = createCheckbox('ctrl-sfx', cfg.sfx);
  addDrawerExtras();

  const outRows = document.getElementById('rows-out');
  const outBet = document.getElementById('bet-out');
  const outSpeed = document.getElementById('speed-out');
  const outGrav = document.getElementById('grav-out');
  const outAir = document.getElementById('air-out');
  const outRest = document.getElementById('rest-out');
  const outRisk = document.getElementById('risk-out');
  const outNudge = document.getElementById('nudge-out');
  const btnApply = document.getElementById('btn-apply');
  const btnResetCfg = document.getElementById('btn-reset');
  const btnSaveCfg = document.getElementById('btn-save');

  // Admin elements
  const adminTokenInput = document.getElementById('admin-token');
  const backendUrlInput = document.getElementById('backend-url');
  const btnSaveAdmin = document.getElementById('btn-save-admin');
  const btnReset = document.getElementById('btn-reset-leaderboard');
  const btnToggleSpawn = document.getElementById('btn-toggle-spawn');
  const btnSimulate = document.getElementById('btn-simulate');

  // Backend URL management
  function getBackendBaseUrl() { return (localStorage.getItem('backendBaseUrl') || '').trim(); }
  function setBackendBaseUrl(url) {
    const clean = String(url || '').trim().replace(/\/+$/, '');
    if (clean) localStorage.setItem('backendBaseUrl', clean);
    else localStorage.removeItem('backendBaseUrl');
  }
  function adminFetch(path, options = {}) {
    const base = getBackendBaseUrl();
    if (!base) throw new Error('Backend URL not set. Enter it in Admin > Save.');
    const u = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    return fetch(u, options);
  }
  (function initAdminInputs() {
    const saved = getBackendBaseUrl();
    if (saved) backendUrlInput.value = saved;
    const savedToken = localStorage.getItem('adminToken') || '';
    if (savedToken) adminTokenInput.value = savedToken;
  })();

  // Config
  function loadConfig() {
    const js = JSON.parse(localStorage.getItem('plinkoo_config') || 'null');
    return Object.assign({}, Defaults, js || {});
  }
  function saveConfig() { localStorage.setItem('plinkoo_config', JSON.stringify(cfg)); }

  function genMultipliers(rows, risk01, targetRTP = 0.96) {
    const n = rows;
    const center = n / 2;
    const baseScale = 0.18 + (0.42 * risk01);
    const base = [];
    for (let k = 0; k <= n; k++) {
      const dist = Math.abs(k - center);
      base.push(Math.exp(baseScale * dist));
    }
    const probs = binomialProbabilities(n);
    let denom = 0;
    for (let k = 0; k <= n; k++) denom += probs[k] * base[k];
    const A = targetRTP / denom;
    return base.map(v => Number((A * v).toFixed(2)));
  }

  // Three
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    boardViewport.appendChild(renderer.domElement);

    // Orthographic for perfect auto-scale
    camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);

    scene = new THREE.Scene();
    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(-10, 18, 22);
    scene.add(ambient, dir);

    onResize();
    window.addEventListener('resize', onResize);
  }
  function onResize() {
    const w = boardViewport.clientWidth;
    const h = boardViewport.clientHeight;
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));

    // Fit board into viewport without distortion
    const aspect = w / h;
    const viewHeight = Math.max(BASE.height, BASE.width / aspect);
    const viewWidth = viewHeight * aspect;
    camera.left = -viewWidth/2; camera.right = viewWidth/2;
    camera.top = viewHeight/2; camera.bottom = -viewHeight/2;
    camera.updateProjectionMatrix();

    confettiCanvas.width = w;
    confettiCanvas.height = h;
  }

  // Matter (robust)
  function initMatter() {
    engine = Engine.create();
    world = engine.world;

    engine.positionIterations = 18;
    engine.velocityIterations = 14;
    engine.constraintIterations = 8;
    engine.enableSleeping = false;

    world.gravity.y = -Math.abs(cfg.gravity);

    rebuildBoard();

    // Contacts
    Events.on(engine, 'collisionStart', (ev) => {
      ev.pairs.forEach(({ bodyA, bodyB, collision }) => {
        onCollision(bodyA, bodyB, collision);
        onCollision(bodyB, bodyA, collision);
      });
    });

    // Loop: physics fixed-step + render throttle
    let physAcc = 0;
    let lastTime = 0;
    let lastRender = 0;

    function loop(time) {
      requestAnimationFrame(loop);
      if (!lastTime) lastTime = time;
      const delta = time - lastTime;
      lastTime = time;

      // Physics at fixed dt, slowed by cfg.timeScale for smoothness
      physAcc += delta;
      const effDt = PHYS_DT_MS * cfg.timeScale;
      let steps = 0;
      while (physAcc >= effDt && steps < MAX_SUBSTEPS) {
        Engine.update(engine, effDt);
        physAcc -= effDt;
        steps++;
      }

      // Render
      const targetDelta = 1000 / (document.hidden ? HIDDEN_FPS : MAX_FPS);
      if (time - lastRender < targetDelta) return;
      lastRender = time;

      updateScene();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  }

  function rebuildBoard() {
    // Clear everything (but not engine)
    Composite.clear(engine.world, false);
    for (const m of meshes.values()) {
      scene.remove(m); m.geometry.dispose(); m.material?.map?.dispose?.(); m.material?.dispose?.();
    }
    for (const l of labels.values()) { scene.remove(l); l.material?.map?.dispose?.(); l.material?.dispose?.(); }
    meshes.clear(); labels.clear(); balls.clear();
    if (pegInstanced) { scene.remove(pegInstanced); pegInstanced.geometry.dispose(); pegInstanced.material?.dispose?.(); pegInstanced = null; }
    slotSensors.length = 0; rowY.length = 0;

    // Walls/floor
    const left = Bodies.rectangle(-BASE.width/2 - WALL_THK/2, 0, WALL_THK, BASE.height, { isStatic: true, restitution: 0.0, friction: 0.2, label: 'WALL' });
    const right = Bodies.rectangle(BASE.width/2 + WALL_THK/2, 0, WALL_THK, BASE.height, { isStatic: true, restitution: 0.0, friction: 0.2, label: 'WALL' });
    const floor = Bodies.rectangle(0, -BASE.height/2 - 2, BASE.width + WALL_THK*2, WALL_THK, { isStatic: true, restitution: 0.0, friction: 0.2, label: 'FLOOR' });
    World.add(world, [left, right, floor]);

    // Pegs (upright triangle)
    const rows = cfg.rows;
    const startY = BASE.height/2 - 4;
    const rowH = PEG_SPACING;
    const startX = -((rows - 1) * PEG_SPACING) / 2;

    const pegPositions = [];
    for (let r = 0; r < rows; r++) {
      const y = startY - r * rowH;
      rowY.push(y);
      for (let c = 0; c <= r; c++) {
        const x = startX + c * PEG_SPACING + (rows - 1 - r) * (PEG_SPACING / 2);
        const peg = Bodies.circle(x, y, PEG_R_PHYS, { isStatic: true, restitution: 0.0, friction: 0.12, frictionStatic: 0.0, slop: 0.003, label: 'PEG' });
        World.add(world, peg);
        pegPositions.push({ x, y });
      }
    }
    pegInstanced = addPegInstanced(pegPositions);

    // Slots (sensors)
    MULTS = genMultipliers(cfg.rows, cfg.risk, 0.96);
    renderSlotLabels(MULTS);
    const slotCount = rows + 1;
    const slotW = BASE.width / slotCount;
    const slotY = -BASE.height/2 + SLOT_H / 2;
    for (let i = 0; i < slotCount; i++) {
      const x = -BASE.width/2 + slotW * (i + 0.5);
      const sensor = Bodies.rectangle(x, slotY, slotW, SLOT_H, { isStatic: true, isSensor: true, label: `SLOT_${i}` });
      World.add(world, sensor);
      slotSensors.push({ body: sensor, index: i, x, mult: MULTS[i] });
    }

    // Labels
    rowsLabel.textContent = String(cfg.rows);
    rtpLabel.textContent = `~${Math.round(computeRTP(MULTS) * 100)}%`;
    betLabel.textContent = `${cfg.bet} pts`;
  }

  function addPegInstanced(pegPositions) {
    const geo = new THREE.CylinderGeometry(PEG_R_VIS, PEG_R_VIS, 0.4, 12);
    const mat = new THREE.MeshStandardMaterial({ color: 0xdfe6f2, metalness: 0.25, roughness: 0.7 });
    const inst = new THREE.InstancedMesh(geo, mat, pegPositions.length);
    const m = new THREE.Matrix4();
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI/2);
    for (let i = 0; i < pegPositions.length; i++) {
      const { x, y } = pegPositions[i];
      m.compose(new THREE.Vector3(x, y, 0), rot, new THREE.Vector3(1,1,1));
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    return inst;
  }

  function renderSlotLabels(multArray) {
    slotLabelsEl.innerHTML = '';
    multArray.forEach((m) => {
      const div = document.createElement('div');
      div.className = 'slot-label';
      div.textContent = `x${m}`;
      slotLabelsEl.appendChild(div);
    });
  }

  // Physics helpers
  function clampVelocity(body) {
    let { x: vx, y: vy } = body.velocity;
    vx = Math.max(-MAX_VEL_X, Math.min(MAX_VEL_X, vx));
    vy = Math.max(-MAX_VEL_Y, Math.min(MAX_VEL_Y, vy));
    if (vx !== body.velocity.x || vy !== body.velocity.y) Body.setVelocity(body, { x: vx, y: vy });
  }

  function updateScene() {
    const OOB_Y = -BASE.height - 80;
    const OOB_X = BASE.width + 80;

    balls.forEach((b) => {
      if (!b || !b.position) return;

      // Extra safety against “teleport” tunneling
      clampVelocity(b);
      Body.setAngularVelocity(b, b.angularVelocity * 0.985);

      if (Math.abs(b.position.x) > OOB_X || b.position.y < OOB_Y) {
        // Far off-screen -> remove
        tryRemove(b);
        return;
      }

      const mesh = meshes.get(b.id);
      if (mesh) {
        mesh.position.set(b.position.x, b.position.y, 0);
        mesh.rotation.z = b.angle;
      }
      const lbl = labels.get(b.id);
      if (lbl) {
        const ly = lbl.position.y + (b.position.y + BALL_R * 2 - lbl.position.y) * 0.6;
        const lx = lbl.position.x + (b.position.x - lbl.position.x) * 0.6;
        lbl.position.set(lx, ly, 0);
      }

      applyGuidedNudges(b);
    });
  }

  function applyGuidedNudges(body) {
    const data = body.plugin;
    if (!data || !Array.isArray(data.decisions)) return;

    const zone = 0.22;
    for (let k = data.lastRowIndex + 1; k < rowY.length; k++) {
      const y = rowY[k];
      if (body.position.y < y + zone && body.position.y > y - zone) {
        const goRight = data.decisions[k] === 1;
        Body.applyForce(body, body.position, { x: (goRight ? 1 : -1) * cfg.nudge, y: 0 });
        data.lastRowIndex = k;
        break;
      }
    }
  }

  function onCollision(ball, other, collision) {
    if (!ball || !ball.plugin || !String(ball.label || '').startsWith('BALL_')) return;

    // Slot scoring
    const sens = slotSensors.find(s => s.body.id === other?.id);
    if (sens && !ball.plugin.scored) {
      if (ball.position.y > sens.body.position.y + 0.1) return; // avoid graze
      scoreBall(ball, sens);
      return;
    }

    // Peg or wall contact: add micro randomness + sfx, never remove
    if (other && (other.label === 'PEG' || other.label === 'WALL' || other.label === 'FLOOR')) {
      if (cfg.jitter > 0) {
        const n = collision.normal; // unit normal
        // Tangential direction (perpendicular to normal) for subtle sideways variance
        const tx = -n.y, ty = n.x;
        const mag = (Math.random() - 0.5) * 2 * cfg.jitter;
        Body.applyForce(ball, collision.supports[0] || ball.position, { x: tx * mag, y: ty * mag });
      }
      if (cfg.sfx) {
        if (other.label === 'PEG') sfx.peg();
        else sfx.wall();
      }
    }
  }

  async function scoreBall(body, sens) {
    body.plugin.scored = true;
    const username = body.plugin.username;
    const avatarUrl = body.plugin.avatarUrl || '';
    const points = Math.round(cfg.bet * sens.mult);

    try {
      await awardPoints(username, avatarUrl, points);
    } finally {
      if (cfg.vfx && sens.mult >= 3) fireworks(confettiCanvas, 1600);
      if (cfg.sfx) sfx.score();
      setTimeout(() => tryRemove(body), 1100);
    }
  }

  function tryRemove(body) {
    try {
      const m = meshes.get(body.id);
      if (m) {
        scene.remove(m);
        m.geometry.dispose();
        m.material?.map?.dispose?.();
        m.material?.dispose?.();
      }
      const l = labels.get(body.id);
      if (l) {
        scene.remove(l);
        l.material?.map?.dispose?.();
        l.material?.dispose?.();
      }
    } catch {}
    meshes.delete(body.id); labels.delete(body.id);
    balls.delete(body);
    try { World.remove(world, body); } catch {}
  }

  function addBallMesh(ballBody, texture) {
    const geo = new THREE.SphereGeometry(BALL_R, 18, 14);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, metalness: 0.08, roughness: 0.85 });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    meshes.set(ballBody.id, mesh);
  }

  async function spawnBall({ username, avatarUrl, eventId }) {
    if (!spawnEnabled) return;
    if (balls.size >= cfg.maxBalls) return; // respect limit

    const seedStr = `${eventId || ''}::${username || ''}`;
    const rng = createSeededRNG(seedStr);
    seedLabel.textContent = seedStr.slice(0, 10) + '…';

    const decisions = [];
    for (let i = 0; i < cfg.rows; i++) decisions.push(rng() < 0.5 ? 0 : 1);

    const centerOffset = (rng() - 0.5) * 2.0;
    const dropX = centerOffset * Math.min(BASE.width/2 - 1, 3.0);
    const dropY = BASE.height/2 - 1;

    const ball = Bodies.circle(dropX, dropY, BALL_R, {
      restitution: cfg.restitution,
      frictionAir: cfg.air,
      friction: 0.02,
      frictionStatic: 0,
      density: 0.002,
      slop: 0.003,
      label: `BALL_${username}`
    });
    // Reduce inertia a touch -> smoother, less spinny
    Body.setInertia(ball, ball.inertia * 0.85);

    ball.plugin = { username, avatarUrl, scored: false, decisions, lastRowIndex: -1 };
    World.add(world, ball);
    balls.add(ball);

    const texture = await loadAvatarTexture(avatarUrl, 128);
    addBallMesh(ball, texture);

    const nameSprite = buildNameSprite(username);
    scene.add(nameSprite);
    labels.set(ball.id, nameSprite);
  }

  async function awardPoints(username, avatarUrl, points) {
    const current = leaderboard[username] || { username, avatarUrl, score: 0 };
    const nextScore = (current.score || 0) + points;
    leaderboard[username] = { username, avatarUrl, score: nextScore, lastUpdate: Date.now() };
    refreshLeaderboard();

    try {
      await FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g, '_'))}`, {
        username, avatarUrl: avatarUrl || '', score: nextScore, lastUpdate: Date.now(),
      });
    } catch (e) {
      console.warn('Leaderboard write failed (rules?)', e);
    }
  }

  function refreshLeaderboard() {
    const entries = Object.values(leaderboard).sort((a, b) => b.score - a.score).slice(0, 50);
    leaderboardList.innerHTML = '';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const li = document.createElement('li');
      li.textContent = `${i+1}. ${e.username}: ${e.score}`;
      leaderboardList.appendChild(li);
    }
  }

  // Firebase
  function listenToEvents() {
    FirebaseREST.onChildAdded('/events', (id, obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (processedEvents.has(id)) return;
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      if (ts && ts < startTime - 60_000) return; // ignore old backlog
      processedEvents.add(id);

      const username = sanitize(obj.username || 'viewer');
      const avatarUrl = obj.avatarUrl || '';
      const command = (obj.command || '').toLowerCase();

      if (!spawnEnabled) return;
      if (command.includes('drop') || command.startsWith('gift')) {
        spawnBall({ username, avatarUrl, eventId: id });
      }
    });
    FirebaseREST.onValue('/leaderboard', (data) => {
      if (data && typeof data === 'object') {
        Object.keys(data).forEach((k) => {
          const e = data[k];
          if (e && e.username) leaderboard[e.username] = { username: e.username, avatarUrl: e.avatarUrl || '', score: e.score || 0, lastUpdate: e.lastUpdate || 0 };
        });
        refreshLeaderboard();
      }
    });
    FirebaseREST.onValue('/config', (data) => {
      spawnEnabled = !!(data && data.spawnEnabled);
      spawnStatusEl.textContent = spawnEnabled ? 'true' : 'false';
      spawnStatusEl.style.color = spawnEnabled ? 'var(--good)' : 'var(--bad)';
    });
  }

  // Admin UI
  btnSaveAdmin.addEventListener('click', () => {
    try {
      const baseUrl = backendUrlInput.value.trim();
      const token = adminTokenInput.value.trim();
      if (!/^https?:\/\//i.test(baseUrl)) { alert('Enter a valid Backend URL (https://…)'); return; }
      setBackendBaseUrl(baseUrl);
      if (token) localStorage.setItem('adminToken', token); else localStorage.removeItem('adminToken');
      fetch(`${baseUrl.replace(/\/+$/,'')}/health`).catch(() => {});
      alert('Saved admin settings.');
    } catch { alert('Failed to save admin settings.'); }
  });
  btnReset.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      await adminFetch('/admin/reset-leaderboard', { method: 'POST', headers: { 'x-admin-token': token } });
      alert('Leaderboard reset.');
    } catch { alert('Failed. Check Backend URL.'); }
  });
  btnToggleSpawn.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      const newVal = !(spawnEnabled);
      await adminFetch(`/admin/spawn-toggle?enabled=${newVal ? 'true':'false'}`, { method: 'POST', headers: { 'x-admin-token': token } });
      alert(`Spawn set to ${newVal}`);
    } catch { alert('Failed. Check Backend URL.'); }
  });
  btnSimulate.addEventListener('click', async () => {
    const base = (localStorage.getItem('backendBaseUrl') || '').trim();
    if (!base) { alert('Backend URL not set. Click Save in Admin.'); return; }
    try {
      const name = 'LocalTester' + Math.floor(Math.random() * 1000);
      const res = await fetch(`${base.replace(/\/+$/,'')}/admin/spawn`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, avatarUrl: '', command: '!drop' })
      });
      const text = await res.text();
      if (!res.ok) { alert(`Simulate failed: HTTP ${res.status}\n${text}`); return; }
      alert('Simulated drop sent.');
    } catch (e) { alert(`Simulation failed: ${e?.message || e}`); }
  });

  // Drawer
  function showDrawer(v) { drawer.setAttribute('aria-hidden', v ? 'false' : 'true'); }
  btnGear.addEventListener('click', () => showDrawer(true));
  btnClose.addEventListener('click', () => showDrawer(false));
  drawer.addEventListener('click', (e) => { if (e.target === drawer) showDrawer(false); });

  // Live outputs
  ctrlRows.addEventListener('input', () => outRows.textContent = ctrlRows.value);
  ctrlBet.addEventListener('input', () => outBet.textContent = ctrlBet.value);
  ctrlSpeed.addEventListener('input', () => outSpeed.textContent = Number(ctrlSpeed.value).toFixed(2));
  ctrlGravity.addEventListener('input', () => outGrav.textContent = Number(ctrlGravity.value).toFixed(2));
  ctrlAir.addEventListener('input', () => outAir.textContent = Number(ctrlAir.value).toFixed(3));
  ctrlRest.addEventListener('input', () => outRest.textContent = Number(ctrlRest.value).toFixed(2));
  ctrlRisk.addEventListener('input', () => outRisk.textContent = Number(ctrlRisk.value).toFixed(2));
  ctrlNudge.addEventListener('input', () => outNudge.textContent = Number(ctrlNudge.value).toFixed(4));
  ctrlJitter.addEventListener('input', () => document.getElementById('jitter-out').textContent = Number(ctrlJitter.value).toFixed(5));
  ctrlMaxBalls.addEventListener('input', () => document.getElementById('maxballs-out').textContent = ctrlMaxBalls.value);
  ctrlVfx.addEventListener('change', () => {});
  ctrlSfx.addEventListener('change', () => { sfx.toggle(ctrlSfx.checked); });

  btnApply.addEventListener('click', () => {
    cfg = readConfigFromUI();
    sfx.toggle(cfg.sfx);
    world.gravity.y = -Math.abs(cfg.gravity);
    rebuildBoard(); // rows/mults changed -> rebuild
    saveConfig();
    showDrawer(false);
  });
  btnResetCfg.addEventListener('click', () => { cfg = { ...Defaults }; syncUI(); });
  btnSaveCfg.addEventListener('click', () => { cfg = readConfigFromUI(); saveConfig(); alert('Saved controls locally.'); });

  function readConfigFromUI() {
    const next = {
      rows: Number(ctrlRows.value),
      bet: Number(ctrlBet.value),
      timeScale: Number(ctrlSpeed.value),
      gravity: Number(ctrlGravity.value),
      air: Number(ctrlAir.value),
      restitution: Number(ctrlRest.value),
      risk: Number(ctrlRisk.value),
      nudge: Number(ctrlNudge.value),
      jitter: Number(ctrlJitter.value),
      maxBalls: Number(ctrlMaxBalls.value),
      vfx: !!ctrlVfx.checked,
      sfx: !!ctrlSfx.checked
    };
    return (cfg = next);
  }
  function syncUI() {
    ctrlRows.value = String(cfg.rows);
    ctrlBet.value = String(cfg.bet);
    ctrlSpeed.value = String(cfg.timeScale);
    ctrlGravity.value = String(cfg.gravity);
    ctrlAir.value = String(cfg.air);
    ctrlRest.value = String(cfg.restitution);
    ctrlRisk.value = String(cfg.risk);
    ctrlNudge.value = String(cfg.nudge);
    ctrlJitter.value = String(cfg.jitter);
    ctrlMaxBalls.value = String(cfg.maxBalls);
    ctrlVfx.checked = !!cfg.vfx;
    ctrlSfx.checked = !!cfg.sfx;

    outRows.textContent = String(cfg.rows);
    outBet.textContent = String(cfg.bet);
    outSpeed.textContent = Number(cfg.timeScale).toFixed(2);
    outGrav.textContent = Number(cfg.gravity).toFixed(2);
    outAir.textContent = Number(cfg.air).toFixed(3);
    outRest.textContent = Number(cfg.restitution).toFixed(2);
    outRisk.textContent = Number(cfg.risk).toFixed(2);
    outNudge.textContent = Number(cfg.nudge).toFixed(4);
    document.getElementById('jitter-out').textContent = Number(cfg.jitter).toFixed(5);
    document.getElementById('maxballs-out').textContent = String(cfg.maxBalls);

    MULTS = genMultipliers(cfg.rows, cfg.risk, 0.96);
    renderSlotLabels(MULTS);
    rtpLabel.textContent = `~${Math.round(computeRTP(MULTS) * 100)}%`;
    betLabel.textContent = `${cfg.bet} pts`;
  }

  // Drawer dynamic controls (adds missing controls if not in HTML)
  function createRange(id, min, max, step, initial) {
    const el = document.getElementById(id);
    if (el) return el;
    const c = document.createElement('input');
    c.type = 'range'; c.min = String(min); c.max = String(max); c.step = String(step); c.value = String(initial);
    c.id = id;
    // Inject into drawer
    const content = document.querySelector('#drawer .drawer-content');
    const wrap = document.createElement('div'); wrap.className = 'control';
    const label = document.createElement('label'); label.innerHTML = `${id.replace('ctrl-','').replace('-', ' ')} <span id="${id.replace('ctrl','').slice(1)}-out">${initial}</span>`;
    wrap.appendChild(label); wrap.appendChild(c);
    content?.appendChild(wrap);
    return c;
  }
  function createCheckbox(id, initial) {
    const el = document.getElementById(id);
    if (el) return el;
    const c = document.createElement('input'); c.type = 'checkbox'; c.id = id; c.checked = !!initial;
    const content = document.querySelector('#drawer .drawer-content');
    const wrap = document.createElement('div'); wrap.className = 'control toggle';
    const label = document.createElement('label'); label.textContent = id.replace('ctrl-','').toUpperCase();
    wrap.appendChild(label); wrap.appendChild(c);
    content?.appendChild(wrap);
    return c;
  }
  function addDrawerExtras() {
    // Labels for dynamic controls
    const jitterOut = document.getElementById('jitter-out') || (() => {
      const span = document.createElement('span'); span.id = 'jitter-out'; span.textContent = Number(cfg.jitter).toFixed(5);
      ctrlJitter.previousElementSibling?.appendChild(span);
      return span;
    })();
    const mbOut = document.getElementById('maxballs-out') || (() => {
      const span = document.createElement('span'); span.id = 'maxballs-out'; span.textContent = String(cfg.maxBalls);
      ctrlMaxBalls.previousElementSibling?.appendChild(span);
      return span;
    })();
    void jitterOut; void mbOut;
  }
  function createDrawer() {
    // Safety: if index.html was not updated, we add a minimal drawer container
    const d = document.createElement('div'); d.id = 'drawer'; d.setAttribute('aria-hidden','true');
    d.innerHTML = `
      <div class="drawer-content">
        <div class="drawer-header">
          <h3>Game Controls</h3>
          <button id="drawer-close" aria-label="Close">✖</button>
        </div>
        <div class="drawer-actions"><button id="btn-apply">Apply</button><button id="btn-reset">Reset Defaults</button><button id="btn-save">Save (Local)</button></div>
      </div>`;
    document.body.appendChild(d);
    return d;
  }

  // Helpers
  function sanitize(u) { const s = String(u || '').trim(); return s ? s.slice(0, 24) : 'viewer'; }

  // Boot
  function start() {
    sfx.toggle(cfg.sfx);
    initThree();
    initMatter();
    listenToEvents();
    syncUI();
  }
  start();
})();