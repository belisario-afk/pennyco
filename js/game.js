// ESM Game (vertical TikTok layout + provably-fair Plinko)
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';
import {
  loadAvatarTexture,
  buildNameSprite,
  fireworks,
  createSeededRNG,
  computeRTP
} from './utils.js';

(() => {
  const { Engine, Runner, World, Bodies, Composite, Events, Body } = Matter;

  // World config tuned for vertical portrait and smooth, slower drops
  const BOARD_HEIGHT = 32;         // world units (y extent roughly -16..+16)
  const BOARD_WIDTH = 18;          // narrower width to match 9:16 portrait
  const ROWS = 12;                 // peg rows
  const PEG_SPACING = 1.2;
  const PEG_RADIUS = 0.18;
  const BALL_RADIUS = 0.45;
  const SLOT_HEIGHT = 1.2;
  const WALL_THICKNESS = 1;

  // Physics tuning
  const GRAVITY_MAG = 0.7;         // magnitude; inverted (negative) so balls fall down on screen
  const RESTITUTION = 0.25;        // bounciness
  const FRICTION_AIR = 0.02;       // air resistance (slows the ball)
  const TIME_SCALE = 0.9;          // slow motion slightly

  // “Bet” base and multipliers (symmetrical). Target RTP ≈ 0.96 with p=0.5 (rows=12)
  // Derived from binomial weights — center low, edges high.
  const BET_POINTS = 100;
  const MULTS = [6.5, 3.25, 2.2, 1.6, 1.3, 0.86, 0.22, 0.86, 1.3, 1.6, 2.2, 3.25, 6.5]; // length ROWS+1
  const THEORETICAL_RTP = computeRTP(MULTS); // ~0.96

  // Guided path impulses (provably-fair left/right decisions per row)
  const NUDGE_FORCE = 0.0005;      // small horizontal impulse per peg layer
  const NUDGE_ZONE = 0.20;         // distance window near each peg layer to apply impulse once

  // Render performance caps
  const MAX_FPS = 60;
  const HIDDEN_FPS = 6;
  const PIXEL_RATIO_CAP = 1.5;

  // State
  let scene, camera, renderer;
  let engine, world, runner;

  // Sensors for scoring
  const slotSensors = []; // { body, index, x, mult }

  // Animated entities
  const dynamicBodies = new Set();          // Set<Matter.Body> for balls
  const meshesById = new Map();             // body.id -> THREE.Mesh (ball)
  const labelsById = new Map();             // body.id -> THREE.Sprite (name)

  // Peg row Y coordinates (for nudging) computed from layout
  const rowY = [];

  // Frontend state
  let spawnEnabled = true;
  const leaderboard = {};                   // username -> { username, avatarUrl, score }
  const processedEvents = new Set();
  const startTime = Date.now();

  // DOM
  const container = document.getElementById('game-container');
  const confettiCanvas = document.getElementById('confetti-canvas');
  const slotLabelsEl = document.getElementById('slot-labels');
  const leaderboardList = document.getElementById('leaderboard-list');
  const spawnStatusEl = document.getElementById('spawn-status');
  const rtpLabel = document.getElementById('rtp-label');
  const seedLabel = document.getElementById('seed-label');

  // Admin controls
  const adminTokenInput = document.getElementById('admin-token');
  const backendUrlInput = document.getElementById('backend-url');
  const btnSaveAdmin = document.getElementById('btn-save-admin');
  const btnReset = document.getElementById('btn-reset-leaderboard');
  const btnToggleSpawn = document.getElementById('btn-toggle-spawn');
  const btnSimulate = document.getElementById('btn-simulate');

  // Backend URL storage helpers
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
    if (!base) throw new Error('Backend URL not set. Enter it in the Admin panel and click Save.');
    const u = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    return fetch(u, options);
  }
  // Prefill admin inputs
  (function initAdminInputs() {
    const saved = getBackendBaseUrl();
    if (saved) backendUrlInput.value = saved;
    const savedToken = localStorage.getItem('adminToken') || '';
    if (savedToken) adminTokenInput.value = savedToken;
  })();

  // Layout helpers
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(46, 9/16, 0.1, 1000); // portrait lean
    camera.position.set(0, 0, 35);

    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(-10, 18, 22);
    scene.add(ambient, dir);

    onResize();
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    confettiCanvas.width = w;
    confettiCanvas.height = h;
  }

  function initMatter() {
    engine = Engine.create();
    world = engine.world;
    engine.timing.timeScale = TIME_SCALE;
    world.gravity.y = -Math.abs(GRAVITY_MAG); // negative -> down on screen

    runner = Runner.create();
    Runner.run(runner, engine);

    // Bounds
    const left = Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const right = Bodies.rectangle(BOARD_WIDTH/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const floor = Bodies.rectangle(0, -BOARD_HEIGHT/2 - 2, BOARD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true });
    World.add(world, [left, right, floor]);

    // Pegs: upright triangle (pyramid pointing up)
    const startY = BOARD_HEIGHT/2 - 4;  // near top (positive y)
    const rowHeight = PEG_SPACING;
    const startX = -((ROWS - 1) * PEG_SPACING) / 2;

    // Precompute rowY and place pegs
    const pegPositions = [];
    rowY.length = 0;
    for (let r = 0; r < ROWS; r++) {
      const y = startY - r * rowHeight;
      rowY.push(y);
      for (let c = 0; c <= r; c++) {
        const x = startX + c * PEG_SPACING + (ROWS - 1 - r) * (PEG_SPACING / 2);
        const peg = Bodies.circle(x, y, PEG_RADIUS, {
          isStatic: true,
          restitution: 0.2,
          friction: 0.05
        });
        World.add(world, peg);
        pegPositions.push({ x, y });
      }
    }
    addPegInstancedMesh(pegPositions);

    // Slots at bottom
    const slotCount = ROWS + 1;
    const slotWidth = BOARD_WIDTH / slotCount;
    const slotY = -BOARD_HEIGHT/2 + SLOT_HEIGHT / 2;
    for (let i = 0; i < slotCount; i++) {
      const x = -BOARD_WIDTH/2 + slotWidth * (i + 0.5);
      const sensor = Bodies.rectangle(x, slotY, slotWidth, SLOT_HEIGHT, { isStatic: true, isSensor: true });
      sensor.label = `SLOT_${i}`;
      World.add(world, sensor);
      slotSensors.push({ body: sensor, index: i, x, mult: MULTS[i] });
    }
    renderSlotLabels(MULTS);

    // Collisions
    Events.on(engine, 'collisionStart', (ev) => {
      ev.pairs.forEach(({ bodyA, bodyB }) => {
        handleCollision(bodyA, bodyB);
        handleCollision(bodyB, bodyA);
      });
    });

    // Render loop (throttled)
    let lastRender = 0;
    const animate = (t) => {
      requestAnimationFrame(animate);
      const targetDelta = 1000 / (document.hidden ? HIDDEN_FPS : MAX_FPS);
      if (t - lastRender < targetDelta) return;
      lastRender = t;
      updateThreeFromMatter();
      renderer.render(scene, camera);
    };
    requestAnimationFrame(animate);
  }

  function addPegInstancedMesh(pegPositions) {
    const geo = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, 0.4, 12);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4e5a7a, metalness: 0.35, roughness: 0.65 });
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
  }

  function renderSlotLabels(multArray) {
    slotLabelsEl.innerHTML = '';
    multArray.forEach((m) => {
      const div = document.createElement('div');
      div.className = 'slot-label';
      div.textContent = `x${m}`;
      slotLabelsEl.appendChild(div);
    });
    rtpLabel.textContent = `~${Math.round(THEORETICAL_RTP * 100)}%`;
  }

  function updateThreeFromMatter() {
    dynamicBodies.forEach((body) => {
      const mesh = meshesById.get(body.id);
      if (mesh) {
        mesh.position.set(body.position.x, body.position.y, 0);
        mesh.rotation.z = body.angle;
      }
      const label = labelsById.get(body.id);
      if (label) {
        label.position.set(body.position.x, body.position.y + BALL_RADIUS * 2, 0);
      }
      // Apply per-row guided nudges (provably-fair path)
      applyGuidedNudges(body);
    });
  }

  function applyGuidedNudges(body) {
    const data = body.plugin;
    if (!data || !Array.isArray(data.decisions)) return;

    // Only nudge once per row as the ball passes that y level
    for (let k = data.lastRowIndex + 1; k < rowY.length; k++) {
      const y = rowY[k];
      if (body.position.y < y + NUDGE_ZONE && body.position.y > y - NUDGE_ZONE) {
        const goRight = data.decisions[k] === 1;
        const fx = (goRight ? 1 : -1) * NUDGE_FORCE;
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

  // Spawning with provably-fair seeded path
  async function spawnBall({ username, avatarUrl, eventId }) {
    if (!spawnEnabled) return;

    // Seeded RNG based on event id + username
    const seedStr = `${eventId || ''}::${username || ''}`;
    const rng = createSeededRNG(seedStr);
    seedLabel.textContent = seedStr.slice(0, 10) + '…';

    // Decide left(0)/right(1) at each row using fair p=0.5
    const decisions = [];
    for (let i = 0; i < ROWS; i++) {
      decisions.push(rng() < 0.5 ? 0 : 1);
    }

    // Drop near the top, center with slight seeded offset
    const centerOffset = (rng() - 0.5) * 2.0; // [-1..1]
    const dropX = centerOffset * Math.min(BOARD_WIDTH/2 - 1, 3.0);
    const dropY = BOARD_HEIGHT/2 - 1;

    const ball = Bodies.circle(dropX, dropY, BALL_RADIUS, {
      restitution: RESTITUTION,
      frictionAir: FRICTION_AIR,
      density: 0.002,
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
    const sensor = slotSensors.find(s => s.body.id === against.id);
    if (!sensor) return;
    if (!body || !body.plugin || !String(body.label || '').startsWith('BALL_')) return;
    if (body.plugin.scored) return;

    // When the ball intersects slot sensor, score it.
    body.plugin.scored = true;
    const username = body.plugin.username;
    const avatarUrl = body.plugin.avatarUrl || '';
    const mult = sensor.mult;
    const points = Math.round(mult * BET_POINTS);

    awardPoints(username, avatarUrl, points).catch(console.warn);

    // Jackpot celebration threshold
    if (mult >= 3) fireworks(confettiCanvas, 1600);

    // Cleanup ball after a short delay
    setTimeout(() => tryRemoveBody(body), 1200);
  }

  function tryRemoveBody(body) {
    try {
      const mesh = meshesById.get(body.id);
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material && mesh.material.map) mesh.material.map.dispose();
        if (mesh.material) mesh.material.dispose();
      }
      const lbl = labelsById.get(body.id);
      if (lbl) {
        scene.remove(lbl);
        if (lbl.material && lbl.material.map) lbl.material.map.dispose();
        if (lbl.material) lbl.material.dispose();
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

  // Firebase listeners
  function listenToEvents() {
    FirebaseREST.onChildAdded('/events', (id, obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (processedEvents.has(id)) return;

      // Avoid ancient backlog
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      if (ts && ts < startTime - 60_000) return;

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

  function sanitizeUsername(u) {
    const s = String(u || '').trim();
    return s ? s.slice(0, 24) : 'viewer';
  }
  function encodeKey(k) {
    return encodeURIComponent(k.replace(/[.#$[\]]/g, '_'));
  }

  // Admin UI
  btnSaveAdmin.addEventListener('click', () => {
    try {
      const baseUrl = backendUrlInput.value.trim();
      const token = adminTokenInput.value.trim();
      setBackendBaseUrl(baseUrl);
      if (token) localStorage.setItem('adminToken', token);
      else localStorage.removeItem('adminToken');
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
    try {
      const name = 'LocalTester' + Math.floor(Math.random() * 1000);
      const res = await adminFetch('/admin/spawn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, avatarUrl: '', command: '!drop' })
      });
      const js = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('spawn failed');
      alert('Simulated drop sent.');
    } catch {
      alert('Simulation failed. Ensure Backend URL and DEV_MODE=true on server.');
    }
  });

  function start() {
    initThree();
    initMatter();
    listenToEvents();
  }
  start();
})();