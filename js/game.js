// Plinkoo — Calm drops + Neon, fixed leaderboard reset, audio guarded behind user gesture
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';
import {
  loadAvatarTexture, buildNameSprite, worldToScreen,
  FXManager2D, initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore
} from './utils.js';

import { EffectComposer } from 'https://unpkg.com/three@0.157.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.157.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.157.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'https://unpkg.com/three@0.157.0/examples/jsm/postprocessing/SMAAPass.js';

const { Engine, World, Bodies, Events, Body } = Matter;

(() => {
  // Physics and world sizing
  const FIXED_DT = 1000/60;
  const MAX_STEPS = 4;

  const WORLD_HEIGHT = 100; // constant; width adapts to viewport
  let WORLD_WIDTH = 56.25;

  // Board geometry (derived on resize)
  let BOARD_HEIGHT = WORLD_HEIGHT * 0.82;
  let BOARD_WIDTH = 0;
  let PEG_SPACING = 4.2;
  const ROWS = 12;
  const PEG_RADIUS = 0.75;
  const BALL_RADIUS = 1.5;
  const WALL_THICKNESS = 2.0;
  const TRAY_RATIO = 0.22;
  let TRAY_HEIGHT = 0;

  // Calm physics tuning
  let GRAVITY_MAG = 1.0;        // slider adjusts; applied downward (negative y)
  let DROP_SPEED = 0.5;         // kept for UI, no longer pushes ball
  let NEON = true;
  let PARTICLES = true;

  // Very small bounce to avoid sticking
  const BALL_RESTITUTION = 0.06;
  const PEG_RESTITUTION  = 0.02;
  const BALL_FRICTION    = 0.04;
  const BALL_FRICTION_AIR= 0.012;

  // Velocity clamps to prevent rare ricochets
  const MAX_SPEED = 28; // world units/sec
  const MAX_H_SPEED = 22;

  // Runtime state
  let engine, world;
  let scene, camera, renderer, ambient, dirLight, pegsInstanced;
  let composer, bloomPass, smaaPass;
  let slotSensors = [];         // { body, index }
  const dynamicBodies = new Set();
  const meshById = new Map();
  const labelById = new Map();
  const leaderboard = {};       // username -> entry
  const processedEvents = new Set();
  const ballCountForUser = new Map();

  let TOP_ROW_Y = 0;
  const startTime = Date.now();

  // DOM refs
  const container = document.getElementById('game-container');
  const fxCanvas = document.getElementById('fx-canvas');
  const fxCtx = fxCanvas.getContext('2d');
  const boardFrame = document.getElementById('board-frame');
  const boardDivider = document.getElementById('board-divider');
  const slotTray = document.getElementById('slot-tray');
  const trayDividers = document.getElementById('tray-dividers');
  const boardTitle = document.getElementById('board-title');
  const slotLabelsEl = document.getElementById('slot-labels') || (() => {
    const el = document.createElement('div');
    el.id = 'slot-labels';
    slotTray.appendChild(el);
    return el;
  })();
  const leaderboardList = document.getElementById('leaderboard-list');
  const spawnStatusEl = document.getElementById('spawn-status');

  // Settings and Admin
  const btnGear = document.getElementById('btn-gear');
  const settingsPanel = document.getElementById('settings-panel');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const optDropSpeed = document.getElementById('opt-drop-speed');
  const optGravity = document.getElementById('opt-gravity');
  const optMultiDrop = document.getElementById('opt-multidrop');
  const optNeon = document.getElementById('opt-neon');
  const optParticles = document.getElementById('opt-particles');
  const optVolume = document.getElementById('opt-volume');
  const adminTokenInput = document.getElementById('admin-token');
  const backendUrlInput = document.getElementById('backend-url');
  const btnSaveAdmin = document.getElementById('btn-save-admin');
  const btnReset = document.getElementById('btn-reset-leaderboard');
  const btnToggleSpawn = document.getElementById('btn-toggle-spawn');
  const btnSimulate = document.getElementById('btn-simulate');

  // Slots
  let SLOT_POINTS = [];
  let SLOT_MULTIPLIERS = [];
  function buildSlots(slotCount) {
    const center = Math.floor((slotCount - 1) / 2);
    const mult = (d) => (d===0?16:d===1?9:d===2?5:d===3?3:1);
    SLOT_MULTIPLIERS = Array.from({length:slotCount}, (_,i)=>mult(Math.abs(i-center)));
    SLOT_POINTS = SLOT_MULTIPLIERS.map(m => m*100);
  }

  function renderSlotLabels(slotCount, framePx) {
    slotLabelsEl.innerHTML = '';
    SLOT_MULTIPLIERS.forEach((m) => {
      const div = document.createElement('div');
      div.className = 'slot-label';
      div.textContent = `x${m}`;
      slotLabelsEl.appendChild(div);
    });
    const slotWidthPx = framePx.width / slotCount;
    trayDividers.style.setProperty('--slot-width', `${slotWidthPx}px`);
  }

  function getBackendBaseUrl() { return (localStorage.getItem('backendBaseUrl') || '').trim(); }
  function setBackendBaseUrl(url) {
    const clean = String(url || '').trim().replace(/\/+$/, '');
    if (clean) localStorage.setItem('backendBaseUrl', clean); else localStorage.removeItem('backendBaseUrl');
  }
  function adminFetch(path, options = {}) {
    const base = getBackendBaseUrl();
    if (!base) throw new Error('Backend URL not set. Open Settings (gear), set it, then Save.');
    const u = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    return fetch(u, options);
  }

  // Settings persistence
  function loadSettings() {
    const g = Number(localStorage.getItem('plk_gravity') ?? '1'); if(!Number.isNaN(g)) optGravity.value = String(g);
    const ds = Number(localStorage.getItem('plk_dropSpeed') ?? '0.5'); if(!Number.isNaN(ds)) optDropSpeed.value = String(ds);
    const md = Number(localStorage.getItem('plk_multiDrop') ?? '1'); if(!Number.isNaN(md)) optMultiDrop.value = String(md);
    optNeon.checked = (localStorage.getItem('plk_neon') ?? 'true') === 'true';
    optParticles.checked = (localStorage.getItem('plk_particles') ?? 'true') === 'true';
    const vol = Number(localStorage.getItem('plk_volume') ?? '0.5'); optVolume.value = String(vol); setAudioVolume(vol); // does not create AudioContext
    const saved = getBackendBaseUrl(); if (saved) backendUrlInput.value = saved;
    const tok = localStorage.getItem('adminToken') || ''; if (tok) adminTokenInput.value = tok;
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
    if (world) world.gravity.y = -Math.abs(GRAVITY_MAG);
    if (pegsInstanced) {
      pegsInstanced.material.emissive.set(NEON ? 0x00ffff : 0x000000);
      pegsInstanced.material.emissiveIntensity = NEON ? 0.30 : 0.0;
      pegsInstanced.material.needsUpdate = true;
    }
    if (bloomPass) {
      bloomPass.enabled = NEON;
      bloomPass.strength = NEON ? 0.75 : 0.0;
      bloomPass.threshold = 0.2;
      bloomPass.radius = 0.6;
    }
  }

  function showSettings(){ gsap.to(settingsPanel, { x: 0, duration: 0.35, ease: 'expo.out' }); }
  function hideSettings(){ gsap.to(settingsPanel, { x: '110%', duration: 0.35, ease: 'expo.in' }); }

  // Three setup
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    computeWorldSize();
    camera = new THREE.OrthographicCamera(
      -WORLD_WIDTH/2, WORLD_WIDTH/2, WORLD_HEIGHT/2, -WORLD_HEIGHT/2, 0.1, 1000
    );
    camera.position.set(0, 0, 10);

    ambient = new THREE.AmbientLight(0xffffff, 0.9);
    dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(-8, 16, 18);
    scene.add(ambient, dirLight);

    // Postprocessing
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    smaaPass = new SMAAPass(renderer.domElement.width, renderer.domElement.height);
    composer.addPass(smaaPass);
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(renderer.domElement.width, renderer.domElement.height),
      0.75, 0.6, 0.2
    );
    bloomPass.enabled = true;
    composer.addPass(bloomPass);

    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    onResize();
  }

  function computeWorldSize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const aspect = w / h;
    WORLD_WIDTH = WORLD_HEIGHT * aspect;
    BOARD_HEIGHT = WORLD_HEIGHT * 0.82;
    BOARD_WIDTH = Math.min(WORLD_WIDTH * 0.88, BOARD_HEIGHT * 0.9);
    PEG_SPACING = BOARD_WIDTH / (ROWS + 1);
    TRAY_HEIGHT = BOARD_HEIGHT * TRAY_RATIO;
  }

  function onResize() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    composer.setSize(container.clientWidth, container.clientHeight);
    if (smaaPass) smaaPass.setSize(container.clientWidth, container.clientHeight);
    if (bloomPass) bloomPass.setSize(container.clientWidth, container.clientHeight);

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
    layoutOverlays();
  }

  function layoutOverlays() {
    const left = -BOARD_WIDTH/2, right = BOARD_WIDTH/2;
    const top = BOARD_HEIGHT/2, bottom = -BOARD_HEIGHT/2;
    const trayTop = bottom + TRAY_HEIGHT;

    const pTopLeft = worldToScreen(new THREE.Vector3(left, top, 0), camera, renderer);
    const pBottomRight = worldToScreen(new THREE.Vector3(right, bottom, 0), camera, renderer);
    const pTrayTopLeft = worldToScreen(new THREE.Vector3(left, trayTop, 0), camera, renderer);

    const frame = {
      x: Math.round(pTopLeft.x),
      y: Math.round(pTopLeft.y),
      width: Math.round(pBottomRight.x - pTopLeft.x),
      height: Math.round(pBottomRight.y - pTopLeft.y)
    };
    const tray = {
      x: frame.x,
      width: frame.width,
      height: Math.round(pBottomRight.y - pTrayTopLeft.y),
      top: Math.round(pTrayTopLeft.y)
    };

    Object.assign(boardFrame.style, {
      left: frame.x + 'px', top: frame.y + 'px',
      width: frame.width + 'px', height: frame.height + 'px',
      display: 'block'
    });
    Object.assign(slotTray.style, {
      left: tray.x + 'px', top: tray.top + 'px',
      width: tray.width + 'px', height: tray.height + 'px',
      display: 'block'
    });
    Object.assign(boardDivider.style, {
      left: frame.x + 'px',
      width: frame.width + 'px',
      top: (pTrayTopLeft.y - 1) + 'px',
      display: 'block'
    });

    boardTitle.style.left = (frame.x + 22) + 'px';
    boardTitle.style.top = (frame.y + 18) + 'px';

    const slotCount = ROWS + 1;
    buildSlots(slotCount);
    renderSlotLabels(slotCount, frame);
  }

  // Matter setup
  function initMatter() {
    engine = Engine.create({ enableSleeping: false });
    world = engine.world;
    world.gravity.y = -Math.abs(GRAVITY_MAG);
    engine.positionIterations = 8;
    engine.velocityIterations = 6;
    engine.constraintIterations = 2;

    buildBoard();
    bindCollisions();
  }

  function buildBoard() {
    // Walls and kill-floor
    const left = Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const right = Bodies.rectangle(BOARD_WIDTH/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const floor = Bodies.rectangle(0, -BOARD_HEIGHT/2 - 6, BOARD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true, label: 'KILL' });
    World.add(world, [left, right, floor]);

    // Pegs
    const startY = BOARD_HEIGHT/2 - 10; // top row
    TOP_ROW_Y = startY;
    const rowH = PEG_SPACING * 0.9;
    const startX = -((ROWS - 1) * PEG_SPACING) / 2;

    const pegPositions = [];
    for (let r = 0; r < ROWS; r++) {
      const y = startY - r * rowH;
      for (let c = 0; c <= r; c++) {
        const x = startX + c * PEG_SPACING + (ROWS - 1 - r) * (PEG_SPACING/2);
        const peg = Bodies.circle(x, y, PEG_RADIUS, {
          isStatic: true,
          restitution: PEG_RESTITUTION,
          friction: 0.01
        });
        peg.label = 'PEG';
        World.add(world, peg);
        pegPositions.push({ x, y });
      }
    }
    addPegInstancedMesh(pegPositions);

    // Slots (sensors)
    slotSensors = [];
    const slotCount = ROWS + 1;
    const slotWidth = BOARD_WIDTH / slotCount;
    const slotY = -BOARD_HEIGHT/2 + (TRAY_HEIGHT * 0.35);
    for (let i = 0; i < slotCount; i++) {
      const x = -BOARD_WIDTH/2 + slotWidth*(i+0.5);
      const sensor = Bodies.rectangle(x, slotY, slotWidth, 2.6, { isStatic: true, isSensor: true });
      sensor.label = `SLOT_${i}`;
      World.add(world, sensor);
      slotSensors.push({ body: sensor, index: i });
    }
  }

  function addPegInstancedMesh(pegPositions) {
    if (pegsInstanced) { scene.remove(pegsInstanced); pegsInstanced.geometry.dispose(); pegsInstanced.material.dispose(); }
    const geo = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, 1.2, 16);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x86f7ff,
      metalness: 0.35,
      roughness: 0.35,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      emissive: new THREE.Color(0x00ffff),
      emissiveIntensity: 0.30
    });
    const inst = new THREE.InstancedMesh(geo, mat, pegPositions.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), Math.PI/2);
    for (let i=0;i<pegPositions.length;i++) {
      const {x,y} = pegPositions[i];
      m.compose(new THREE.Vector3(x,y,0), q, new THREE.Vector3(1,1,1));
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    pegsInstanced = inst;
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

    // Scoring
    const slot = slotSensors.find(s => s.body.id === b.id);
    if (slot && String(a.label || '').startsWith('BALL_')) {
      const ball = a;
      if (!ball.plugin?.scored) {
        const idx = slot.index;
        const points = SLOT_POINTS[idx] || 100;
        ball.plugin.scored = true;
        awardPoints(ball.plugin.username, ball.plugin.avatarUrl || '', points).catch(console.warn);
        sfxScore(points >= 1600);
        setTimeout(() => tryRemoveBall(ball), 900);
      }
      return;
    }

    // Peg bounce FX
    if (b.label === 'PEG' && String(a.label || '').startsWith('BALL_')) {
      if (PARTICLES) {
        const mesh = meshById.get(a.id);
        if (mesh) {
          const p2 = worldToScreen(mesh.position, camera, renderer);
          fxMgr.addSparks(p2.x, p2.y, '#00f2ea', 12);
        }
      }
      sfxBounce();
    }

    if (b.label === 'KILL' && String(a.label || '').startsWith('BALL_')) {
      tryRemoveBall(a);
    }
  }

  // FX manager
  const fxMgr = new FXManager2D(fxCanvas);

  function startLoop() {
    let last = performance.now(), acc = 0;
    function tick(now) {
      const dt = Math.min(100, now - last); last = now; acc += dt;

      let steps = 0;
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        Engine.update(engine, FIXED_DT);
        acc -= FIXED_DT; steps++;
      }

      clampVelocities();

      fxMgr.update(fxCtx, dt);
      updateThreeFromMatter();
      composer.render();

      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function clampVelocities() {
    for (const b of dynamicBodies) {
      const vx = b.velocity.x, vy = b.velocity.y;
      let sx = vx, sy = vy;
      if (Math.abs(sx) > MAX_H_SPEED) sx = Math.sign(sx) * MAX_H_SPEED;
      const speed = Math.hypot(sx, sy);
      if (speed > MAX_SPEED) { const k = MAX_SPEED / speed; sx *= k; sy *= k; }
      if (sx !== vx || sy !== vy) Body.setVelocity(b, { x: sx, y: sy });
    }
  }

  function updateThreeFromMatter() {
    dynamicBodies.forEach((body) => {
      const mesh = meshById.get(body.id);
      if (mesh) { mesh.position.set(body.position.x, body.position.y, 0); mesh.rotation.z = body.angle; }
      const label = labelById.get(body.id);
      if (label) label.position.set(body.position.x, body.position.y + BALL_RADIUS*2.2, 0);
    });
  }

  async function spawnBall({ username, avatarUrl }) {
    const multi = Math.max(1, Math.min(5, Number(optMultiDrop.value || 1)));
    for (let i=0;i<multi;i++) await spawnSingleBall({ username, avatarUrl }, i);
  }

  async function spawnSingleBall({ username, avatarUrl }, iOffset=0) {
    const count = ballCountForUser.get(username) || 0;
    if (count > 18) return;

    // Spawn centered at the top row, with tiny horizontal jitter
    const jitter = PEG_SPACING * 0.35;
    const dropX = Math.max(-BOARD_WIDTH/2 + 4, Math.min(BOARD_WIDTH/2 - 4, (Math.random()-0.5) * jitter));
    const dropY = TOP_ROW_Y + PEG_SPACING * 0.8; // just above top pegs

    const ball = Bodies.circle(dropX, dropY, BALL_RADIUS, {
      restitution: BALL_RESTITUTION,
      friction: BALL_FRICTION,
      frictionAir: BALL_FRICTION_AIR,
      density: 0.0018
    });
    ball.label = `BALL_${username}`;
    ball.plugin = { username, avatarUrl, scored: false };
    World.add(world, ball);
    dynamicBodies.add(ball);

    // No launch impulse. Start calm.
    Body.setVelocity(ball, { x: 0, y: 0 });
    Body.setAngularVelocity(ball, 0);

    const tex = await loadAvatarTexture(avatarUrl, 128);
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 24, 18);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: tex,
      metalness: 0.25,
      roughness: 0.55,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      sheen: 0.15,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0x88ffff),
      emissive: NEON ? new THREE.Color(0x00ffff) : new THREE.Color(0x000000),
      emissiveIntensity: NEON ? 0.04 : 0.0
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

      const u = body.plugin?.username;
      if (u) ballCountForUser.set(u, Math.max(0, (ballCountForUser.get(u)||1) - 1));
    } catch {}
  }

  async function awardPoints(username, avatarUrl, points) {
    const current = leaderboard[username] || { username, avatarUrl, score: 0 };
    const nextScore = (current.score || 0) + points;
    leaderboard[username] = { username, avatarUrl, score: nextScore, lastUpdate: Date.now() };
    refreshLeaderboard();
    try {
      await FirebaseREST.update(`/leaderboard/${encodeKey(username)}`, {
        username, avatarUrl: avatarUrl || '', score: nextScore, lastUpdate: Date.now()
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
      li.className = 'lb-item';
      const ava = document.createElement('div');
      ava.className = 'lb-ava';
      if (e.avatarUrl) ava.style.backgroundImage = `url(${e.avatarUrl})`;
      const name = document.createElement('div');
      name.className = 'lb-name';
      name.textContent = '@' + (e.username || 'viewer');
      const score = document.createElement('div');
      score.className = 'lb-score';
      score.textContent = e.score.toLocaleString();
      li.appendChild(ava);
      li.appendChild(name);
      li.appendChild(score);
      leaderboardList.appendChild(li);
    }
  }

  // Clear leaderboard immediately in UI
  function clearLeaderboardLocal() {
    for (const k of Object.keys(leaderboard)) delete leaderboard[k];
    refreshLeaderboard();
  }

  // Firebase listeners
  function listenToEvents() {
    FirebaseREST.onChildAdded('/events', (id, obj) => {
      if (!obj || typeof obj !== 'object' || processedEvents.has(id)) return;
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      if (ts && ts < startTime - 60_000) return;
      processedEvents.add(id);
      const username = sanitizeUsername(obj.username || 'viewer');
      const avatarUrl = obj.avatarUrl || '';
      const command = (obj.command || '').toLowerCase();
      if (command.includes('drop') || command.startsWith('gift')) spawnBall({ username, avatarUrl });
    });

    FirebaseREST.onValue('/leaderboard', (data) => {
      if (data && typeof data === 'object' && Object.keys(data).length) {
        // populate from DB
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
      } else {
        // data is null or empty => clear UI immediately
        clearLeaderboardLocal();
        return;
      }
      refreshLeaderboard();
    });

    FirebaseREST.onValue('/config', (data) => {
      const enabled = !!(data && data.spawnEnabled);
      spawnStatusEl.textContent = enabled ? 'true' : 'false';
      spawnStatusEl.style.color = enabled ? 'var(--good)' : 'var(--danger)';
    });
  }

  function sanitizeUsername(u) {
    const s = String(u || '').trim();
    return s ? s.slice(0, 24) : 'viewer';
  }
  function encodeKey(k) { return encodeURIComponent(k.replace(/[.#$[\]]/g, '_')); }

  // Settings bindings + Audio gesture unlock (no repeated attempts)
  btnGear.addEventListener('click', showSettings);
  btnCloseSettings.addEventListener('click', hideSettings);
  let audioBound = false;
  function bindAudioUnlockOnce() {
    if (audioBound) return;
    audioBound = true;
    const unlock = async () => {
      await initAudioOnce();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }
  bindAudioUnlockOnce();

  optDropSpeed.addEventListener('input', applySettings);
  optGravity.addEventListener('input', applySettings);
  optMultiDrop.addEventListener('input', applySettings);
  optNeon.addEventListener('change', applySettings);
  optParticles.addEventListener('change', applySettings);
  optVolume.addEventListener('input', (e)=> setAudioVolume(Number(e.target.value)));

  // Admin actions
  btnSaveAdmin.addEventListener('click', () => {
    try {
      const baseUrl = backendUrlInput.value.trim();
      const token = adminTokenInput.value.trim();
      setBackendBaseUrl(baseUrl);
      if (token) localStorage.setItem('adminToken', token); else localStorage.removeItem('adminToken');
      alert('Saved. Admin calls will use the backend URL you provided.');
    } catch { alert('Failed to save settings.'); }
  });

  btnReset.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      const res = await adminFetch('/admin/reset-leaderboard', { method:'POST', headers:{'x-admin-token': token} });
      if (!res.ok) throw new Error('reset failed');
      // Clear immediately in UI so a new game starts clean, even before RTDB event arrives
      clearLeaderboardLocal();
      alert('Leaderboard reset.');
    } catch {
      alert('Failed to reset leaderboard. Check Backend URL and token.');
    }
  });

  btnToggleSpawn.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      const curr = spawnStatusEl.textContent === 'true';
      const newVal = !curr;
      await adminFetch(`/admin/spawn-toggle?enabled=${newVal?'true':'false'}`, { method:'POST', headers:{'x-admin-token': token} });
      alert(`Spawn set to ${newVal}`);
    } catch { alert('Failed to toggle spawn.'); }
  });

  btnSimulate.addEventListener('click', async () => {
    try {
      const name = 'LocalTester' + Math.floor(Math.random()*1000);
      const res = await adminFetch('/admin/spawn', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ username:name, avatarUrl:'', command:'!drop' }) });
      if (!res.ok) throw new Error('spawn failed');
      alert('Simulated drop sent.');
    } catch { alert('Simulation failed. Check Backend URL and DEV_MODE=true on server.'); }
  });

  // Start
  function start() {
    loadSettings();
    initThree();
    initMatter();
    listenToEvents();
    startLoop();
  }
  start();
})();