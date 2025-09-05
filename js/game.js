// Plinkoo — Orthographic, fixed timestep physics, GSAP UI, particles and SFX
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';
import {
  loadAvatarTexture,
  buildNameSprite,
  fireworks,
  sparks2D,
  worldToScreen,
  initAudioOnce,
  setAudioVolume,
  sfxBounce,
  sfxDrop,
  sfxScore
} from './utils.js';

const { Engine, World, Bodies, Composite, Events } = Matter;

(() => {
  // Physics constants (tunable at runtime by settings)
  let GRAVITY_MAG = 1.0;       // Adjusted by settings
  const FIXED_DT = 1000 / 60;  // ms per physics step at 60Hz
  const MAX_STEPS = 4;         // prevent spiral of death

  // World sizing for 9:16: height stable, width from aspect
  const WORLD_HEIGHT = 100;    // world units
  let WORLD_WIDTH = 56.25;     // updated on resize (WORLD_HEIGHT * aspect)

  // Board dims (relative to world)
  let BOARD_HEIGHT = WORLD_HEIGHT * 0.82;
  let BOARD_WIDTH = 0; // computed from aspect
  let PEG_SPACING = 4.2; // world units (auto-tuned with board width)
  const PEG_RADIUS = 0.75;
  const BALL_RADIUS = 1.5;
  const SLOT_HEIGHT = 3.0;
  const WALL_THICKNESS = 2.0;
  const ROWS = 12;

  const DROP_X_NOISE = 10; // horizontal spawn jitter amplitude
  let DROP_SPEED = 0.5;    // UI slider (0-1)

  // Visual toggles
  let NEON = true;
  let PARTICLES = true;

  // State
  let engine, world;
  let scene, camera, renderer, ambient, dirLight;
  let slotSensors = [];     // { body, index, points }
  let dynamicBodies = new Set(); // balls only
  let meshById = new Map(); // Matter body id -> THREE mesh
  let labelById = new Map(); // Matter body id -> THREE.Sprite
  let pegBodies = [];       // tag pegs to identify bounce
  const leaderboard = {};   // username -> {username, avatarUrl, score}
  const processedEvents = new Set();
  const ballCountForUser = new Map();

  const startTime = Date.now();
  const container = document.getElementById('game-container');
  const fxCanvas = document.getElementById('fx-canvas');
  const fxCtx = fxCanvas.getContext('2d');
  const slotLabelsEl = document.getElementById('slot-labels');
  const leaderboardList = document.getElementById('leaderboard-list');
  const spawnStatusEl = document.getElementById('spawn-status');

  // Settings UI
  const btnGear = document.getElementById('btn-gear');
  const settingsPanel = document.getElementById('settings-panel');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const optDropSpeed = document.getElementById('opt-drop-speed');
  const optGravity = document.getElementById('opt-gravity');
  const optMultiDrop = document.getElementById('opt-multidrop');
  const optNeon = document.getElementById('opt-neon');
  const optParticles = document.getElementById('opt-particles');
  const optVolume = document.getElementById('opt-volume');

  // Admin
  const adminTokenInput = document.getElementById('admin-token');
  const backendUrlInput = document.getElementById('backend-url');
  const btnSaveAdmin = document.getElementById('btn-save-admin');
  const btnReset = document.getElementById('btn-reset-leaderboard');
  const btnToggleSpawn = document.getElementById('btn-toggle-spawn');
  const btnSimulate = document.getElementById('btn-simulate');

  // Slot points middle-biased
  let SLOT_POINTS = [];
  function buildSlotPoints(count) {
    const center = Math.floor((count - 1) / 2);
    const res = [];
    for (let i = 0; i < count; i++) {
      const d = Math.abs(i - center);
      res.push(d === 0 ? 500 : d === 1 ? 200 : d === 2 ? 100 : 50);
    }
    SLOT_POINTS = res;
  }

  // Backend URL management
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
    if (!base) throw new Error('Backend URL not set. Open Settings (gear), set it, then Save.');
    const u = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    return fetch(u, options);
  }

  // Persistence of settings
  function loadSettings() {
    const g = Number(localStorage.getItem('plk_gravity') ?? '1');
    if (!Number.isNaN(g)) optGravity.value = String(g);
    const ds = Number(localStorage.getItem('plk_dropSpeed') ?? '0.5');
    if (!Number.isNaN(ds)) optDropSpeed.value = String(ds);
    const md = Number(localStorage.getItem('plk_multiDrop') ?? '1');
    if (!Number.isNaN(md)) optMultiDrop.value = String(md);
    const neon = (localStorage.getItem('plk_neon') ?? 'true') === 'true';
    optNeon.checked = neon;
    const parts = (localStorage.getItem('plk_particles') ?? 'true') === 'true';
    optParticles.checked = parts;

    const saved = getBackendBaseUrl();
    if (saved) backendUrlInput.value = saved;
    const tok = localStorage.getItem('adminToken') || '';
    if (tok) adminTokenInput.value = tok;

    const vol = Number(localStorage.getItem('plk_volume') ?? '0.5');
    optVolume.value = String(vol);
    setAudioVolume(vol);

    applySettings();
  }
  function applySettings() {
    DROP_SPEED = Number(optDropSpeed.value);
    GRAVITY_MAG = Number(optGravity.value);
    NEON = !!optNeon.checked;
    PARTICLES = !!optParticles.checked;

    localStorage.setItem('plk_dropSpeed', String(DROP_SPEED));
    localStorage.setItem('plk_gravity', String(GRAVITY_MAG));
    localStorage.setItem('plk_multiDrop', String(optMultiDrop.value));
    localStorage.setItem('plk_neon', String(NEON));
    localStorage.setItem('plk_particles', String(PARTICLES));

    // Apply gravity sign (negative to fall down on screen)
    if (world) world.gravity.y = -Math.abs(GRAVITY_MAG);
  }

  // GSAP panel in/out
  function showSettings() {
    gsap.to(settingsPanel, { x: 0, duration: 0.35, ease: 'expo.out' });
  }
  function hideSettings() {
    gsap.to(settingsPanel, { x: '110%', duration: 0.35, ease: 'expo.in' });
  }

  // Three: Orthographic camera + responsive world
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = null;

    computeWorldSize();
    camera = new THREE.OrthographicCamera(
      -WORLD_WIDTH/2, WORLD_WIDTH/2,
      WORLD_HEIGHT/2, -WORLD_HEIGHT/2,
      0.1, 1000
    );
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);

    ambient = new THREE.AmbientLight(0xffffff, 0.95);
    dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(-10, 20, 20);
    scene.add(ambient, dirLight);

    window.addEventListener('resize', onResize);
    onResize();
  }

  function computeWorldSize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const aspect = w / Math.max(1, h);
    WORLD_WIDTH = WORLD_HEIGHT * aspect;
    BOARD_HEIGHT = WORLD_HEIGHT * 0.82;
    BOARD_WIDTH = Math.min(WORLD_WIDTH * 0.88, BOARD_HEIGHT * 0.9); // keep board within view
    PEG_SPACING = BOARD_WIDTH / (ROWS + 1); // denser/looser based on width
  }

  function onResize() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    computeWorldSize();
    if (camera) {
      camera.left = -WORLD_WIDTH/2;
      camera.right = WORLD_WIDTH/2;
      camera.top = WORLD_HEIGHT/2;
      camera.bottom = -WORLD_HEIGHT/2;
      camera.updateProjectionMatrix();
    }
    fxCanvas.width = container.clientWidth;
    fxCanvas.height = container.clientHeight;
  }

  // Matter: fixed-step engine
  function initMatter() {
    engine = Engine.create({
      enableSleeping: false
    });
    world = engine.world;
    world.gravity.y = -Math.abs(GRAVITY_MAG); // Make balls fall down (screen)
    engine.positionIterations = 8;
    engine.velocityIterations = 6;
    engine.constraintIterations = 2;

    buildBoard();
    bindCollisions();
    startLoops();
  }

  function buildBoard() {
    // Clear old if any
    slotSensors = [];
    dynamicBodies.clear();
    meshById.clear();
    labelById.clear();
    pegBodies = [];

    // Bounds and walls
    const left = Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const right = Bodies.rectangle(BOARD_WIDTH/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const floor = Bodies.rectangle(0, -BOARD_HEIGHT/2 - 4, BOARD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true }); // kill plane below
    World.add(world, [left, right, floor]);

    // Pegs: upright triangle (pyramid pointing up)
    const startY = BOARD_HEIGHT/2 - 10; // top space
    const rowHeight = PEG_SPACING * 0.9;
    const startX = -((ROWS - 1) * PEG_SPACING) / 2;

    const pegPositions = [];
    for (let r = 0; r < ROWS; r++) {
      const y = startY - r * rowHeight;
      for (let c = 0; c <= r; c++) {
        const x = startX + c * PEG_SPACING + (ROWS - 1 - r) * (PEG_SPACING/2);
        const peg = Bodies.circle(x, y, PEG_RADIUS, {
          isStatic: true,
          restitution: 0.45,
          friction: 0.02,
        });
        peg.label = 'PEG';
        pegPositions.push({ x, y });
        pegBodies.push(peg);
        World.add(world, peg);
      }
    }
    addPegInstancedMesh(pegPositions);

    // Slots
    const slotCount = ROWS + 1;
    buildSlotPoints(slotCount);
    renderSlotLabels(slotCount);

    const slotWidth = BOARD_WIDTH / slotCount;
    const slotY = -BOARD_HEIGHT/2 + SLOT_HEIGHT / 2;

    for (let i = 0; i < slotCount; i++) {
      const x = -BOARD_WIDTH/2 + slotWidth * (i + 0.5);
      const body = Bodies.rectangle(x, slotY, slotWidth, SLOT_HEIGHT, { isStatic: true, isSensor: true });
      body.label = `SLOT_${i}`;
      World.add(world, body);
      slotSensors.push({ body, index: i, points: SLOT_POINTS[i] });
    }
  }

  function addPegInstancedMesh(pegPositions) {
    // Remove any existing instanced mesh pegs? For simplicity, rebuild the scene only at init.
    const geo = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, 1.2, 12);
    const mat = new THREE.MeshStandardMaterial({
      color: NEON ? 0x7deaff : 0x4f5c78,
      emissive: NEON ? 0x0ffff0 : 0x000000,
      emissiveIntensity: NEON ? 0.25 : 0.0,
      metalness: 0.4,
      roughness: 0.6
    });
    const inst = new THREE.InstancedMesh(geo, mat, pegPositions.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const rotX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    for (let i = 0; i < pegPositions.length; i++) {
      const { x, y } = pegPositions[i];
      q.copy(rotX);
      m.compose(new THREE.Vector3(x, y, 0), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }

  function bindCollisions() {
    Events.on(engine, 'collisionStart', (ev) => {
      for (const { bodyA, bodyB } of ev.pairs) {
        handlePair(bodyA, bodyB);
        handlePair(bodyB, bodyA);
      }
    });
  }

  function handlePair(a, b) {
    if (!a || !b) return;

    // Slot scoring
    const slot = slotSensors.find(s => s.body.id === b.id);
    if (slot && String(a.label || '').startsWith('BALL_')) {
      const ball = a;
      if (!ball.plugin?.scored) {
        ball.plugin.scored = true;
        const username = ball.plugin.username;
        const avatarUrl = ball.plugin.avatarUrl || '';
        const points = slot.points;
        awardPoints(username, avatarUrl, points).catch(console.warn);
        sfxScore(points >= 500);
        if (points >= 500) fireworks(fxCanvas, 1600);
        // Delay removal to let it settle visually
        setTimeout(() => tryRemoveBall(ball), 1000);
      }
      return;
    }

    // Peg bounce particle and sound
    if (b.label === 'PEG' && String(a.label || '').startsWith('BALL_')) {
      // Particle spark at contact
      if (PARTICLES) {
        const mesh = meshById.get(a.id);
        if (mesh) {
          const p2 = worldToScreen(mesh.position, camera, renderer);
          sparks2D(fxCtx, p2.x, p2.y, '#00f2ea');
        }
      }
      sfxBounce();
    }
  }

  function startLoops() {
    // Fixed-step physics and render interpolation
    let last = performance.now();
    let acc = 0;

    function loop(now) {
      const dt = Math.min(100, now - last);
      last = now;
      acc += dt;

      let steps = 0;
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        Engine.update(engine, FIXED_DT);
        acc -= FIXED_DT;
        steps++;
      }

      updateThreeFromMatter();
      renderer.render(scene, camera);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // Kill-plane cleanup to avoid disappearing balls (only below screen)
    setInterval(() => {
      const killY = -BOARD_HEIGHT/2 - 6;
      for (const body of Array.from(dynamicBodies)) {
        if (body.position.y < killY) {
          tryRemoveBall(body);
        }
      }
      // Clear 2D fx canvas gradually
      fxCtx.globalCompositeOperation = 'source-over';
      fxCtx.fillStyle = 'rgba(0,0,0,0.12)';
      fxCtx.fillRect(0, 0, fxCanvas.width, fxCanvas.height);
      fxCtx.globalCompositeOperation = 'source-over';
    }, 120);
  }

  function updateThreeFromMatter() {
    for (const body of dynamicBodies) {
      const mesh = meshById.get(body.id);
      if (mesh) {
        mesh.position.set(body.position.x, body.position.y, 0);
        mesh.rotation.z = body.angle;
      }
      const label = labelById.get(body.id);
      if (label) {
        label.position.set(body.position.x, body.position.y + BALL_RADIUS * 2.2, 0);
      }
    }
  }

  async function spawnBall({ username, avatarUrl }) {
    const multi = Math.max(1, Math.min(5, Number(optMultiDrop.value || 1)));
    for (let i = 0; i < multi; i++) {
      await spawnSingleBall({ username, avatarUrl }, i);
    }
  }

  async function spawnSingleBall({ username, avatarUrl }, iOffset = 0) {
    const count = ballCountForUser.get(username) || 0;
    if (count > 18) return;

    // Drop near top, with slight horizontal variance
    const xNoise = (Math.random() - 0.5) * DROP_X_NOISE;
    const dropX = Math.max(-BOARD_WIDTH/2 + 4, Math.min(BOARD_WIDTH/2 - 4, xNoise));
    const dropY = BOARD_HEIGHT/2 - 5;

    const ball = Bodies.circle(dropX, dropY, BALL_RADIUS, {
      restitution: 0.36,
      friction: 0.02,
      frictionAir: 0.002,
      density: 0.0018
    });
    ball.label = `BALL_${username}`;
    ball.plugin = { username, avatarUrl, scored: false };
    World.add(world, ball);
    dynamicBodies.add(ball);

    // Initial tiny push to avoid dead-centre symmetry; uses DROP_SPEED
    const impulseX = (Math.random() * 2 - 1) * (0.002 + DROP_SPEED * 0.004);
    Matter.Body.applyForce(ball, ball.position, { x: impulseX, y: 0 });

    // 3D mesh
    const texture = await loadAvatarTexture(avatarUrl, 128);
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 20, 14);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: texture,
      metalness: 0.08,
      roughness: 0.85,
      emissive: NEON ? new THREE.Color(0x00ffff) : new THREE.Color(0x000000),
      emissiveIntensity: NEON ? 0.12 : 0.0
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    meshById.set(ball.id, mesh);

    const nameSprite = buildNameSprite(username);
    scene.add(nameSprite);
    labelById.set(ball.id, nameSprite);

    ballCountForUser.set(username, count + 1 + iOffset);
    sfxDrop();
  }

  function tryRemoveBall(body) {
    try {
      const mesh = meshById.get(body.id);
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material?.map) mesh.material.map.dispose();
        mesh.material?.dispose();
      }
      const lbl = labelById.get(body.id);
      if (lbl) {
        scene.remove(lbl);
        if (lbl.material?.map) lbl.material.map.dispose();
        lbl.material?.dispose();
      }
      meshById.delete(body.id);
      labelById.delete(body.id);
      dynamicBodies.delete(body);
      World.remove(world, body);

      const username = body.plugin?.username;
      if (username) {
        const c = ballCountForUser.get(username) || 1;
        ballCountForUser.set(username, Math.max(0, c - 1));
      }
    } catch (e) {
      // ignore
    }
  }

  async function awardPoints(username, avatarUrl, points) {
    const current = leaderboard[username] || { username, avatarUrl, score: 0 };
    const nextScore = (current.score || 0) + points;
    leaderboard[username] = { username, avatarUrl, score: nextScore, lastUpdate: Date.now() };
    refreshLeaderboard();
    try {
      await FirebaseREST.update(`/leaderboard/${encodeKey(username)}`, {
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
    for (const e of entries) {
      const li = document.createElement('li');
      li.textContent = `${e.username}: ${e.score}`;
      leaderboardList.appendChild(li);
    }
  }

  function renderSlotLabels(slotCount) {
    slotLabelsEl.innerHTML = '';
    for (let i = 0; i < slotCount; i++) {
      const div = document.createElement('div');
      div.className = 'slot-label';
      div.textContent = `${SLOT_POINTS[i]}`;
      slotLabelsEl.appendChild(div);
    }
  }

  // Firebase listeners
  function listenToEvents() {
    FirebaseREST.get('/config').then(() => {
      console.log('[Firebase] Connected (GET /config ok)');
    }).catch((e) => {
      console.warn('[Firebase] GET /config failed', e);
    });

    FirebaseREST.onChildAdded('/events', (id, obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (processedEvents.has(id)) return;

      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      if (ts && ts < startTime - 60_000) return;

      processedEvents.add(id);
      console.log('[Firebase] Event received', id, obj);

      const username = sanitizeUsername(obj.username || 'viewer');
      const avatarUrl = obj.avatarUrl || '';
      const command = (obj.command || '').toLowerCase();

      if (command.includes('drop') || command.startsWith('gift')) {
        spawnBall({ username, avatarUrl });
      }
    });

    FirebaseREST.onValue('/leaderboard', (data) => {
      if (data && typeof data === 'object') {
        for (const k of Object.keys(data)) {
          const entry = data[k];
          if (entry?.username) {
            leaderboard[entry.username] = {
              username: entry.username,
              avatarUrl: entry.avatarUrl || '',
              score: entry.score || 0,
              lastUpdate: entry.lastUpdate || 0
            };
          }
        }
        refreshLeaderboard();
      }
    });

    FirebaseREST.onValue('/config', (data) => {
      const enabled = !!(data && data.spawnEnabled);
      spawnStatusEl.textContent = enabled ? 'true' : 'false';
      spawnStatusEl.style.color = enabled ? 'var(--good)' : 'var(--danger)';
    });
  }

  // Helpers
  function sanitizeUsername(u) {
    const s = String(u || '').trim();
    if (!s) return 'viewer';
    return s.slice(0, 24);
  }
  function encodeKey(k) {
    return encodeURIComponent(k.replace(/[.#$[\]]/g, '_'));
  }

  // Settings actions
  btnGear.addEventListener('click', () => {
    showSettings();
  });
  btnCloseSettings.addEventListener('click', () => {
    hideSettings();
  });

  // Ensure Audio context is unlocked after user gesture
  ['pointerdown', 'keydown'].forEach(ev =>
    window.addEventListener(ev, () => {
      initAudioOnce();
    }, { once: true, passive: true })
  );

  // Bind settings
  optDropSpeed.addEventListener('input', applySettings);
  optGravity.addEventListener('input', applySettings);
  optMultiDrop.addEventListener('input', applySettings);
  optNeon.addEventListener('change', applySettings);
  optParticles.addEventListener('change', applySettings);
  optVolume.addEventListener('input', (e) => setAudioVolume(Number(e.target.value)));

  // Admin handlers
  btnSaveAdmin.addEventListener('click', () => {
    try {
      const baseUrl = backendUrlInput.value.trim();
      const token = adminTokenInput.value.trim();
      setBackendBaseUrl(baseUrl);
      if (token) localStorage.setItem('adminToken', token);
      else localStorage.removeItem('adminToken');
      alert('Saved. Admin calls will use the backend URL you provided.');
    } catch {
      alert('Failed to save settings.');
    }
  });

  btnReset.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      await adminFetch('/admin/reset-leaderboard', { method: 'POST', headers: { 'x-admin-token': token } });
      alert('Leaderboard reset.');
    } catch {
      alert('Failed to reset leaderboard. Check Backend URL.');
    }
  });

  btnToggleSpawn.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      const curr = spawnStatusEl.textContent === 'true';
      const newVal = !curr;
      await adminFetch(`/admin/spawn-toggle?enabled=${newVal ? 'true' : 'false'}`, { method: 'POST', headers: { 'x-admin-token': token } });
      alert(`Spawn set to ${newVal}`);
    } catch {
      alert('Failed to toggle spawn. Check Backend URL.');
    }
  });

  btnSimulate.addEventListener('click', async () => {
    try {
      const name = 'LocalTester' + Math.floor(Math.random() * 1000);
      const res = await adminFetch('/admin/spawn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, avatarUrl: '', command: '!drop' })
      });
      const js = await res.json().catch(() => ({}));
      console.log('[Admin] /admin/spawn response', res.status, js);
      if (!res.ok) throw new Error('spawn failed');
      alert('Simulated drop sent.');
    } catch {
      alert('Simulation failed. Check Backend URL and DEV_MODE=true on server.');
    }
  });

  // Boot
  function start() {
    loadSettings();
    initThree();
    initMatter();
    listenToEvents();
  }
  start();
})();