// ESM Game (smoother physics, anti-tunneling, gentler fall)
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';
import {
  loadAvatarTexture,
  buildNameSprite,
  fireworks,
  createSeededRNG,
  binomialProbabilities,
  computeRTP
} from './utils.js';

(() => {
  const { Engine, World, Bodies, Composite, Events, Body } = Matter;

  // Base board extents (in world units)
  const BASE = { width: 18, height: 32 };

  // Default config (editable in the drawer)
  const Defaults = {
    rows: 12,
    bet: 100,
    timeScale: 0.85,   // a bit slower by default
    gravity: 0.55,     // gentler gravity -> smoother
    air: 0.028,        // a little more air drag
    restitution: 0.18, // less bounce
    risk: 0.5,         // 0..1 (edge bias -> higher risk)
    nudge: 0.00045,    // tiny per-row impulse (guided path)
  };

  // Geometry
  const PEG_SPACING = 1.2;
  const PEG_RADIUS_VIS = 0.18;
  const PEG_RADIUS_PHYS = PEG_RADIUS_VIS * 1.22; // slightly larger hitbox for stable contacts
  const BALL_RADIUS = 0.45;
  const SLOT_HEIGHT = 1.2;
  const WALL_THICKNESS = 1;

  // Render performance caps
  const MAX_FPS = 60;
  const HIDDEN_FPS = 6;
  const PIXEL_RATIO_CAP = 1.5;

  // Physics loop (fixed step + substeps to avoid tunneling)
  const PHYS_HZ = 240;                 // simulate at 240 Hz internally
  const PHYS_DT_MS = 1000 / PHYS_HZ;   // base dt in ms
  const MAX_SUBSTEPS_PER_FRAME = 12;   // clamp per frame

  // Velocity clamps to prevent ballistic jumps through pegs
  const MAX_VEL_X = 8.0;
  const MAX_VEL_Y = 12.0;

  // State
  let cfg = loadConfig();
  let MULTS = generateMultipliers(cfg.rows, cfg.risk, 0.96);
  let scene, camera, renderer;
  let engine, world;

  let pegInstanced = null;
  const slotSensors = []; // { body, index, x, mult }
  const rowY = [];        // y per peg row (for nudging)

  const dynamicBodies = new Set(); // balls
  const meshesById = new Map();    // body.id -> THREE.Mesh
  const labelsById = new Map();    // body.id -> THREE.Sprite

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

  // Drawer controls
  const drawer = document.getElementById('drawer');
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

  // Backend URL management (Render)
  function getBackendBaseUrl() {
    return (localStorage.getItem('backendBaseUrl') || '').trim();
  }
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

  // Config helpers
  function loadConfig() {
    const js = JSON.parse(localStorage.getItem('plinkoo_config') || 'null');
    return Object.assign({}, Defaults, js || {});
  }
  function saveConfig() {
    localStorage.setItem('plinkoo_config', JSON.stringify(cfg));
  }
  function syncUIFromConfig() {
    ctrlRows.value = String(cfg.rows);
    ctrlBet.value = String(cfg.bet);
    ctrlSpeed.value = String(cfg.timeScale);
    ctrlGravity.value = String(cfg.gravity);
    ctrlAir.value = String(cfg.air);
    ctrlRest.value = String(cfg.restitution);
    ctrlRisk.value = String(cfg.risk);
    ctrlNudge.value = String(cfg.nudge);

    outRows.textContent = String(cfg.rows);
    outBet.textContent = String(cfg.bet);
    outSpeed.textContent = Number(cfg.timeScale).toFixed(2);
    outGrav.textContent = Number(cfg.gravity).toFixed(2);
    outAir.textContent = Number(cfg.air).toFixed(3);
    outRest.textContent = Number(cfg.restitution).toFixed(2);
    outRisk.textContent = Number(cfg.risk).toFixed(2);
    outNudge.textContent = Number(cfg.nudge).toFixed(4);

    rowsLabel.textContent = String(cfg.rows);
    betLabel.textContent = `${cfg.bet} pts`;

    MULTS = generateMultipliers(cfg.rows, cfg.risk, 0.96);
    const rtp = computeRTP(MULTS);
    rtpLabel.textContent = `~${Math.round(rtp * 100)}%`;
    renderSlotLabels(MULTS);
  }
  function readConfigFromUI() {
    cfg.rows = Number(ctrlRows.value);
    cfg.bet = Number(ctrlBet.value);
    cfg.timeScale = Number(ctrlSpeed.value);
    cfg.gravity = Number(ctrlGravity.value);
    cfg.air = Number(ctrlAir.value);
    cfg.restitution = Number(ctrlRest.value);
    cfg.risk = Number(ctrlRisk.value);
    cfg.nudge = Number(ctrlNudge.value);
  }

  // Multipliers (symmetric), scaled to target RTP
  function generateMultipliers(rows, risk01, targetRTP = 0.96) {
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
    const mults = base.map(v => Number((A * v).toFixed(2)));
    return mults;
  }

  // Three.js setup
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    boardViewport.appendChild(renderer.domElement);

    // Orthographic for easy auto-fit
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

    // Fit board into viewport
    const aspect = w / h;
    const viewHeight = Math.max(BASE.height, BASE.width / aspect);
    const viewWidth = viewHeight * aspect;

    camera.left = -viewWidth/2;
    camera.right = viewWidth/2;
    camera.top = viewHeight/2;
    camera.bottom = -viewHeight/2;
    camera.updateProjectionMatrix();

    confettiCanvas.width = w;
    confettiCanvas.height = h;
  }

  // Matter.js setup with robust collisions
  function initMatter() {
    engine = Engine.create();
    world = engine.world;

    // Stronger solver to avoid tunneling / missed contacts
    engine.positionIterations = 16;
    engine.velocityIterations = 12;
    engine.constraintIterations = 8;
    engine.enableSleeping = false;

    // Gravity downward on screen
    world.gravity.y = -Math.abs(cfg.gravity);

    rebuildBoard();

    // Scoring collisions
    Events.on(engine, 'collisionStart', (ev) => {
      ev.pairs.forEach(({ bodyA, bodyB }) => {
        handleCollision(bodyA, bodyB);
        handleCollision(bodyB, bodyA);
      });
    });

    // Loops: physics at fixed step, render throttled
    let physAccumulator = 0;
    let lastTime = 0;
    let lastRender = 0;

    function loop(time) {
      requestAnimationFrame(loop);
      if (!lastTime) lastTime = time;
      const rawDelta = time - lastTime;
      lastTime = time;

      // Accumulate and step physics at fixed dt (slowed by cfg.timeScale)
      physAccumulator += rawDelta;
      const effectiveDt = PHYS_DT_MS * cfg.timeScale; // smaller -> slower, smoother
      let substeps = 0;
      while (physAccumulator >= effectiveDt && substeps < MAX_SUBSTEPS_PER_FRAME) {
        Engine.update(engine, effectiveDt);
        physAccumulator -= effectiveDt;
        substeps++;
      }

      // Render throttle
      const targetDelta = 1000 / (document.hidden ? HIDDEN_FPS : MAX_FPS);
      if (time - lastRender < targetDelta) return;
      lastRender = time;

      updateThreeFromMatter();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  }

  function clearWorld() {
    Composite.clear(engine.world, false);

    for (const mesh of meshesById.values()) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      if (mesh.material?.map) mesh.material.map.dispose();
      mesh.material?.dispose?.();
    }
    meshesById.clear();

    for (const lbl of labelsById.values()) {
      scene.remove(lbl);
      lbl.material?.map?.dispose?.();
      lbl.material?.dispose?.();
    }
    labelsById.clear();
    dynamicBodies.clear();

    if (pegInstanced) {
      scene.remove(pegInstanced);
      pegInstanced.geometry.dispose();
      pegInstanced.material?.dispose?.();
      pegInstanced = null;
    }

    slotSensors.length = 0;
    rowY.length = 0;
  }

  function rebuildBoard() {
    clearWorld();

    // Bounds
    const left = Bodies.rectangle(-BASE.width/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BASE.height, {
      isStatic: true, restitution: 0.0, friction: 0.2
    });
    const right = Bodies.rectangle(BASE.width/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BASE.height, {
      isStatic: true, restitution: 0.0, friction: 0.2
    });
    const floor = Bodies.rectangle(0, -BASE.height/2 - 2, BASE.width + WALL_THICKNESS*2, WALL_THICKNESS, {
      isStatic: true, restitution: 0.0, friction: 0.2
    });
    World.add(world, [left, right, floor]);

    // Pegs (upright triangle)
    const rows = cfg.rows;
    const startY = BASE.height/2 - 4;
    const rowHeight = PEG_SPACING;
    const startX = -((rows - 1) * PEG_SPACING) / 2;

    const pegPositions = [];
    rowY.length = 0;
    for (let r = 0; r < rows; r++) {
      const y = startY - r * rowHeight;
      rowY.push(y);
      for (let c = 0; c <= r; c++) {
        const x = startX + c * PEG_SPACING + (rows - 1 - r) * (PEG_SPACING / 2);
        const peg = Bodies.circle(x, y, PEG_RADIUS_PHYS, {
          isStatic: true,
          restitution: 0.0,
          friction: 0.12,
          frictionStatic: 0.0,
          slop: 0.004 // tighter contacts
        });
        World.add(world, peg);
        pegPositions.push({ x, y });
      }
    }
    pegInstanced = addPegInstancedMesh(pegPositions);

    // Slots at bottom (sensors only)
    MULTS = generateMultipliers(cfg.rows, cfg.risk, 0.96);
    renderSlotLabels(MULTS);

    const slotCount = rows + 1;
    const slotWidth = BASE.width / slotCount;
    const slotY = -BASE.height/2 + SLOT_HEIGHT / 2;
    for (let i = 0; i < slotCount; i++) {
      const x = -BASE.width/2 + slotWidth * (i + 0.5);
      const sensor = Bodies.rectangle(x, slotY, slotWidth, SLOT_HEIGHT, { isStatic: true, isSensor: true });
      sensor.label = `SLOT_${i}`;
      World.add(world, sensor);
      slotSensors.push({ body: sensor, index: i, x, mult: MULTS[i] });
    }

    // Labels
    rowsLabel.textContent = String(cfg.rows);
    const rtp = computeRTP(MULTS);
    rtpLabel.textContent = `~${Math.round(rtp * 100)}%`;
    betLabel.textContent = `${cfg.bet} pts`;
  }

  function addPegInstancedMesh(pegPositions) {
    // Visual pegs (match visual radius; physics uses slightly larger radius)
    const geo = new THREE.CylinderGeometry(PEG_RADIUS_VIS, PEG_RADIUS_VIS, 0.4, 12);
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

  // Game loop helpers
  function clampVelocity(body) {
    // Prevent ballistic jumps that can tunnel through pegs
    let { x: vx, y: vy } = body.velocity;
    if (vx > MAX_VEL_X) vx = MAX_VEL_X; else if (vx < -MAX_VEL_X) vx = -MAX_VEL_X;
    if (vy > MAX_VEL_Y) vy = MAX_VEL_Y; else if (vy < -MAX_VEL_Y) vy = -MAX_VEL_Y;
    if (vx !== body.velocity.x || vy !== body.velocity.y) {
      Body.setVelocity(body, { x: vx, y: vy });
    }
  }

  function updateThreeFromMatter() {
    // Very generous OOB bounds so we don't remove early
    const OOB_Y = -BASE.height - 60;
    const OOB_X = BASE.width + 60;

    dynamicBodies.forEach((body) => {
      if (!body || !body.position) return;

      // Soft clamps and damping for smoothness
      clampVelocity(body);
      Body.setAngularVelocity(body, body.angularVelocity * 0.985); // tiny angular damping

      // Remove only far OOB (safety)
      if (Math.abs(body.position.x) > OOB_X || body.position.y < OOB_Y) {
        tryRemoveBody(body);
        return;
      }

      const mesh = meshesById.get(body.id);
      if (mesh) {
        mesh.position.set(body.position.x, body.position.y, 0);
        mesh.rotation.z = body.angle;
      }
      const label = labelsById.get(body.id);
      if (label) {
        // slight smoothing of label follow
        const ly = label.position.y + (body.position.y + BALL_RADIUS * 2 - label.position.y) * 0.6;
        const lx = label.position.x + (body.position.x - label.position.x) * 0.6;
        label.position.set(lx, ly, 0);
      }

      // Guided nudges (tiny and once per row)
      applyGuidedNudges(body);
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
        const fx = (goRight ? 1 : -1) * cfg.nudge;
        Body.applyForce(body, body.position, { x: fx, y: 0 });
        data.lastRowIndex = k;
        break;
      }
    }
  }

  function addBallMesh(ballBody, texture) {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 18, 14);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: texture,
      metalness: 0.08,
      roughness: 0.85
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    meshesById.set(ballBody.id, mesh);
  }

  async function spawnBall({ username, avatarUrl, eventId }) {
    if (!spawnEnabled) return;

    const seedStr = `${eventId || ''}::${username || ''}`;
    const rng = createSeededRNG(seedStr);
    seedLabel.textContent = seedStr.slice(0, 10) + '…';

    // Decisions per row
    const decisions = [];
    for (let i = 0; i < cfg.rows; i++) decisions.push(rng() < 0.5 ? 0 : 1);

    // Drop near top center with small seeded offset
    const centerOffset = (rng() - 0.5) * 2.0;
    const dropX = centerOffset * Math.min(BASE.width/2 - 1, 3.0);
    const dropY = BASE.height/2 - 1;

    const ball = Bodies.circle(dropX, dropY, BALL_RADIUS, {
      restitution: cfg.restitution,
      frictionAir: cfg.air,
      friction: 0.02,
      frictionStatic: 0,
      density: 0.002,
      slop: 0.004
    });
    ball.label = `BALL_${username}`;
    ball.plugin = {
      username,
      avatarUrl,
      scored: false,
      decisions,
      lastRowIndex: -1
    };

    World.add(world, ball);
    dynamicBodies.add(ball);

    const texture = await loadAvatarTexture(avatarUrl, 128);
    addBallMesh(ball, texture);

    const nameSprite = buildNameSprite(username);
    scene.add(nameSprite);
    labelsById.set(ball.id, nameSprite);
  }

  function handleCollision(body, against) {
    // Score only on slot sensors — pegs and walls are solid and do not remove balls
    const sensor = slotSensors.find(s => s.body.id === against?.id);
    if (!sensor) return;
    if (!body || !body.plugin || !String(body.label || '').startsWith('BALL_')) return;
    if (body.plugin.scored) return;

    // Avoid scoring on a grazing pass: ensure ball is below sensor center
    if (body.position.y > sensor.body.position.y + 0.1) return;

    body.plugin.scored = true;
    const username = body.plugin.username;
    const avatarUrl = body.plugin.avatarUrl || '';
    const points = Math.round(cfg.bet * sensor.mult);

    awardPoints(username, avatarUrl, points).catch(console.warn);
    if (sensor.mult >= 3) fireworks(confettiCanvas, 1600);

    // Remove only after scoring
    setTimeout(() => tryRemoveBody(body), 1200);
  }

  function tryRemoveBody(body) {
    try {
      const mesh = meshesById.get(body.id);
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material?.map) mesh.material.map.dispose();
        mesh.material?.dispose?.();
      }
      const lbl = labelsById.get(body.id);
      if (lbl) {
        scene.remove(lbl);
        lbl.material?.map?.dispose?.();
        lbl.material?.dispose?.();
      }
      meshesById.delete(body.id);
      labelsById.delete(body.id);
      dynamicBodies.delete(body);
      World.remove(world, body);
    } catch {}
  }

  async function awardPoints(username, avatarUrl, points) {
    const current = leaderboard[username] || { username, avatarUrl, score: 0 };
    const nextScore = (current.score || 0) + points;
    leaderboard[username] = { username, avatarUrl, score: nextScore, lastUpdate: Date.now() };
    refreshLeaderboard();

    try {
      await FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g, '_'))}`, {
        username,
        avatarUrl: avatarUrl || '',
        score: nextScore,
        lastUpdate: Date.now(),
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

  // Firebase listeners
  function listenToEvents() {
    FirebaseREST.onChildAdded('/events', (id, obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (processedEvents.has(id)) return;

      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      if (ts && ts < startTime - 60_000) return; // skip old backlog

      processedEvents.add(id);

      const username = sanitizeUsername(obj.username || 'viewer');
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
          const entry = data[k];
          if (entry && entry.username) {
            leaderboard[entry.username] = {
              username: entry.username,
              avatarUrl: entry.avatarUrl || '',
              score: entry.score || 0,
              lastUpdate: entry.lastUpdate || 0
            };
          }
        });
        refreshLeaderboard();
      }
    });

    FirebaseREST.onValue('/config', (data) => {
      const enabled = !!(data && data.spawnEnabled);
      spawnEnabled = enabled;
      spawnStatusEl.textContent = enabled ? 'true' : 'false';
      spawnStatusEl.style.color = enabled ? 'var(--good)' : 'var(--bad)';
    });
  }

  // Admin UI
  btnSaveAdmin.addEventListener('click', () => {
    try {
      const baseUrl = backendUrlInput.value.trim();
      const token = adminTokenInput.value.trim();
      if (!/^https?:\/\//i.test(baseUrl)) { alert('Enter a valid Backend URL (https://…)'); return; }
      setBackendBaseUrl(baseUrl);
      if (token) localStorage.setItem('adminToken', token);
      else localStorage.removeItem('adminToken');
      // Optional quick health probe
      fetch(`${baseUrl.replace(/\/+$/,'')}/health`).catch(() => {});
      alert('Saved admin settings.');
    } catch {
      alert('Failed to save admin settings.');
    }
  });

  btnReset.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      await adminFetch('/admin/reset-leaderboard', { method: 'POST', headers: { 'x-admin-token': token } });
      alert('Leaderboard reset.');
    } catch {
      alert('Failed. Check Backend URL.');
    }
  });

  btnToggleSpawn.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      const newVal = !(spawnEnabled);
      await adminFetch(`/admin/spawn-toggle?enabled=${newVal ? 'true':'false'}`, { method: 'POST', headers: { 'x-admin-token': token } });
      alert(`Spawn set to ${newVal}`);
    } catch {
      alert('Failed. Check Backend URL.');
    }
  });

  btnSimulate.addEventListener('click', async () => {
    const base = (localStorage.getItem('backendBaseUrl') || '').trim();
    if (!base) { alert('Backend URL not set. Click Save in Admin.'); return; }
    try {
      const name = 'LocalTester' + Math.floor(Math.random() * 1000);
      const res = await fetch(`${base.replace(/\/+$/,'')}/admin/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, avatarUrl: '', command: '!drop' })
      });
      const text = await res.text();
      if (!res.ok) {
        alert(`Simulate failed: HTTP ${res.status}\n${text}`);
        return;
      }
      alert('Simulated drop sent. Watch for the event and ball.');
    } catch (e) {
      alert(`Simulation failed: ${e?.message || e}`);
    }
  });

  // Drawer (controls)
  function showDrawer(v) { drawer.setAttribute('aria-hidden', v ? 'false' : 'true'); }
  btnGear.addEventListener('click', () => showDrawer(true));
  btnClose.addEventListener('click', () => showDrawer(false));
  drawer.addEventListener('click', (e) => { if (e.target === drawer) showDrawer(false); });

  // Live output updates
  ctrlRows.addEventListener('input', () => outRows.textContent = ctrlRows.value);
  ctrlBet.addEventListener('input', () => outBet.textContent = ctrlBet.value);
  ctrlSpeed.addEventListener('input', () => outSpeed.textContent = Number(ctrlSpeed.value).toFixed(2));
  ctrlGravity.addEventListener('input', () => outGrav.textContent = Number(ctrlGravity.value).toFixed(2));
  ctrlAir.addEventListener('input', () => outAir.textContent = Number(ctrlAir.value).toFixed(3));
  ctrlRest.addEventListener('input', () => outRest.textContent = Number(ctrlRest.value).toFixed(2));
  ctrlRisk.addEventListener('input', () => outRisk.textContent = Number(ctrlRisk.value).toFixed(2));
  ctrlNudge.addEventListener('input', () => outNudge.textContent = Number(ctrlNudge.value).toFixed(4));

  btnApply.addEventListener('click', () => {
    readConfigFromUI();
    world.gravity.y = -Math.abs(cfg.gravity);
    // Rebuild board when rows/mults changed
    rebuildBoard();
    saveConfig();
    showDrawer(false);
  });

  btnResetCfg.addEventListener('click', () => {
    cfg = Object.assign({}, Defaults);
    syncUIFromConfig();
  });
  btnSaveCfg.addEventListener('click', () => {
    readConfigFromUI();
    saveConfig();
    alert('Saved controls locally.');
  });

  // Helpers
  function sanitizeUsername(u) {
    const s = String(u || '').trim();
    return s ? s.slice(0, 24) : 'viewer';
  }

  // Start
  function start() {
    initThree();
    initMatter();
    listenToEvents();
    syncUIFromConfig();
  }
  start();
})();