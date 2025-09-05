// Neon upgrade: sRGB + ACES tone mapping + Bloom, peg spheres, non-dimming FX fade
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';
import { EffectComposer } from 'https://unpkg.com/three@0.157.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.157.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.157.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'https://unpkg.com/three@0.157.0/examples/jsm/environments/RoomEnvironment.js';

import {
  loadAvatarTexture, buildNameSprite, fireworks, sparks2D, worldToScreen,
  initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore
} from './utils.js';

const { Engine, World, Bodies, Events, Body } = Matter;

(() => {
  // Fixed-step physics
  const FIXED_DT = 1000 / 60;
  const MAX_STEPS = 4;

  // World sizing (9:16 friendly)
  const WORLD_HEIGHT = 100;
  let WORLD_WIDTH = 56.25;

  // Board geometry (computed)
  let BOARD_HEIGHT = WORLD_HEIGHT * 0.82;
  let BOARD_WIDTH = 0;
  let PEG_SPACING = 4.2;
  const ROWS = 12;
  const PEG_RADIUS = 0.7;   // smaller studs
  const BALL_RADIUS = 1.5;
  const WALL_THICKNESS = 2.0;
  const TRAY_RATIO = 0.22;
  let TRAY_HEIGHT = 0;

  // Settings
  let GRAVITY_MAG = Number(localStorage.getItem('plk_gravity') ?? '1.0');
  let DROP_SPEED = Number(localStorage.getItem('plk_dropSpeed') ?? '0.5');
  let NEON = (localStorage.getItem('plk_neon') ?? 'true') === 'true';
  let PARTICLES = (localStorage.getItem('plk_particles') ?? 'true') === 'true';

  // Runtime
  let engine, world;
  let scene, camera, renderer, ambient, dirLight;
  let composer, bloomPass;
  let pegsInstanced;
  let slotSensors = [];
  const dynamicBodies = new Set();
  const meshById = new Map();
  const labelById = new Map();
  const leaderboard = {};
  const processedEvents = new Set();
  const ballCountForUser = new Map();
  const startTime = Date.now();

  // DOM
  const container = document.getElementById('game-container');
  const fxCanvas = document.getElementById('fx-canvas');
  const fxCtx = fxCanvas.getContext('2d');
  const boardFrame = document.getElementById('board-frame');
  const boardDivider = document.getElementById('board-divider');
  const slotTray = document.getElementById('slot-tray');
  const trayDividers = document.getElementById('tray-dividers') || (() => {
    const d = document.createElement('div'); d.id = 'tray-dividers'; slotTray.appendChild(d); return d;
  })();
  const boardTitle = document.getElementById('board-title');
  const slotLabelsEl = document.getElementById('slot-labels') || (() => {
    const el = document.createElement('div'); el.id = 'slot-labels'; slotTray.appendChild(el); return el;
  })();
  const leaderboardList = document.getElementById('leaderboard-list');
  const spawnStatusEl = document.getElementById('spawn-status');

  // Settings + Admin
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

  // Slot model
  let SLOT_POINTS = [];
  let SLOT_MULTIPLIERS = [];
  function buildSlots(slotCount) {
    const center = Math.floor((slotCount - 1) / 2);
    const mul = (d) => (d===0?16:d===1?9:d===2?5:d===3?3:1);
    SLOT_MULTIPLIERS = Array.from({length:slotCount}, (_,i)=>mul(Math.abs(i-center)));
    SLOT_POINTS = SLOT_MULTIPLIERS.map(m => m*100);
  }
  function renderSlotLabels(slotCount, framePx) {
    slotLabelsEl.innerHTML = '';
    SLOT_MULTIPLIERS.forEach(m => {
      const div = document.createElement('div');
      div.className = 'slot-label';
      div.textContent = `x${m}`;
      slotLabelsEl.appendChild(div);
    });
    const slotWidthPx = framePx.width / slotCount;
    trayDividers.style.setProperty('--slot-width', `${slotWidthPx}px`);
  }

  // Backend URL helpers
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

  // Settings load/apply
  function loadSettings() {
    if (!Number.isNaN(GRAVITY_MAG)) optGravity.value = String(GRAVITY_MAG);
    if (!Number.isNaN(DROP_SPEED)) optDropSpeed.value = String(DROP_SPEED);
    const md = Number(localStorage.getItem('plk_multiDrop') ?? '1'); if (!Number.isNaN(md)) optMultiDrop.value = String(md);
    optNeon.checked = NEON; optParticles.checked = PARTICLES;
    const vol = Number(localStorage.getItem('plk_volume') ?? '0.5'); optVolume.value = String(vol); setAudioVolume(vol);

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

    // Bloom toggle
    if (bloomPass) bloomPass.enabled = NEON;
    if (pegsInstanced) {
      pegsInstanced.material.emissive.set(NEON ? 0x00ffff : 0x000000);
      pegsInstanced.material.emissiveIntensity = NEON ? 0.22 : 0.0;
      pegsInstanced.material.needsUpdate = true;
    }
  }

  // GSAP panel
  function showSettings(){ gsap.to(settingsPanel, { x: 0, duration: 0.35, ease: 'expo.out' }); }
  function hideSettings(){ gsap.to(settingsPanel, { x: '110%', duration: 0.35, ease: 'expo.in' }); }

  // Three setup with tone mapping + bloom
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.physicallyCorrectLights = true;
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    computeWorldSize();
    camera = new THREE.OrthographicCamera(
      -WORLD_WIDTH/2, WORLD_WIDTH/2, WORLD_HEIGHT/2, -WORLD_HEIGHT/2, 0.1, 1000
    );
    camera.position.set(0, 0, 10);

    ambient = new THREE.AmbientLight(0xffffff, 0.95);
    dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(-12, 18, 16);
    scene.add(ambient, dirLight);

    // Subtle PBR reflections without external HDR
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // Post-processing Bloom
    composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    bloomPass = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.7, 0.4, 0.85);
    bloomPass.enabled = NEON;
    composer.addPass(renderPass);
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
    computeWorldSize();
    camera.left = -WORLD_WIDTH/2;
    camera.right = WORLD_WIDTH/2;
    camera.top = WORLD_HEIGHT/2;
    camera.bottom = -WORLD_HEIGHT/2;
    camera.updateProjectionMatrix();

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

    Object.assign(boardFrame.style, { left: frame.x+'px', top: frame.y+'px', width: frame.width+'px', height: frame.height+'px', display: 'block' });
    Object.assign(slotTray.style, { left: tray.x+'px', top: tray.top+'px', width: tray.width+'px', height: tray.height+'px', display: 'block' });
    Object.assign(boardDivider.style, { left: frame.x+'px', width: frame.width+'px', top: (pTrayTopLeft.y-1)+'px', display: 'block' });

    boardTitle.style.left = (frame.x + 22) + 'px';
    boardTitle.style.top = (frame.y + 18) + 'px';

    const slotCount = ROWS + 1;
    buildSlots(slotCount);
    renderSlotLabels(slotCount, frame);
  }

  // Matter
  function initMatter() {
    engine = Engine.create({ enableSleeping: false });
    world = engine.world;
    world.gravity.y = -Math.abs(GRAVITY_MAG);
    engine.positionIterations = 8;
    engine.velocityIterations = 6;
    engine.constraintIterations = 2;

    buildBoard();
    bindCollisions();
    startLoop();
  }

  function buildBoard() {
    // Walls + kill-floor
    const left = Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const right = Bodies.rectangle(BOARD_WIDTH/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const floor = Bodies.rectangle(0, -BOARD_HEIGHT/2 - 6, BOARD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true, label: 'KILL' });
    World.add(world, [left, right, floor]);

    // Peg studs: spheres (instanced)
    const startY = BOARD_HEIGHT/2 - 10;
    const rowH = PEG_SPACING * 0.9;
    const startX = -((ROWS - 1) * PEG_SPACING) / 2;

    const pegPositions = [];
    for (let r = 0; r < ROWS; r++) {
      const y = startY - r * rowH;
      for (let c = 0; c <= r; c++) {
        const x = startX + c * PEG_SPACING + (ROWS - 1 - r) * (PEG_SPACING/2);
        const peg = Bodies.circle(x, y, PEG_RADIUS, { isStatic: true, restitution: 0.45, friction: 0.02 });
        peg.label = 'PEG';
        World.add(world, peg);
        pegPositions.push({ x, y });
      }
    }
    addPegInstancedMesh(pegPositions);

    // Slots
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
    const geo = new THREE.SphereGeometry(PEG_RADIUS, 24, 16);
    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0x83f3ff),
      metalness: 0.4,
      roughness: 0.35,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      emissive: NEON ? new THREE.Color(0x00ffff) : new THREE.Color(0x000000),
      emissiveIntensity: NEON ? 0.18 : 0.0
    });
    const inst = new THREE.InstancedMesh(geo, mat, pegPositions.length);
    const m = new THREE.Matrix4();
    for (let i=0;i<pegPositions.length;i++) {
      const {x,y} = pegPositions[i];
      m.compose(new THREE.Vector3(x,y,0), new THREE.Quaternion(), new THREE.Vector3(1,1,1));
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

    // Score on slot
    const slot = slotSensors.find(s => s.body.id === b.id);
    if (slot && String(a.label || '').startsWith('BALL_')) {
      const ball = a;
      if (!ball.plugin?.scored) {
        const idx = slot.index;
        const points = SLOT_POINTS[idx] || 100;
        ball.plugin.scored = true;
        awardPoints(ball.plugin.username, ball.plugin.avatarUrl || '', points).catch(console.warn);
        sfxScore(points >= 1600);
        if (points >= 1600) fireworks(fxCanvas, 1600);
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
          sparks2D(fxCtx, p2.x, p2.y, '#00f2ea');
        }
      }
      sfxBounce();
    }

    if (b.label === 'KILL' && String(a.label || '').startsWith('BALL_')) {
      tryRemoveBall(a);
    }
  }

  function startLoop() {
    let last = performance.now(), acc = 0;
    function tick(now) {
      const dt = Math.min(100, now - last); last = now; acc += dt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        Engine.update(engine, FIXED_DT);
        acc -= FIXED_DT; steps++;
      }
      updateThreeFromMatter();
      if (composer) composer.render(); else renderer.render(scene, camera);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    // FX canvas fade: erase particles only (won't darken UI)
    setInterval(() => {
      fxCtx.globalCompositeOperation = 'destination-out';
      fxCtx.fillStyle = 'rgba(0,0,0,0.14)';
      fxCtx.fillRect(0, 0, fxCanvas.width, fxCanvas.height);
      fxCtx.globalCompositeOperation = 'source-over';
    }, 120);
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

    const xNoise = (Math.random()-0.5) * (BOARD_WIDTH * 0.35);
    const dropX = Math.max(-BOARD_WIDTH/2 + 4, Math.min(BOARD_WIDTH/2 - 4, xNoise));
    const dropY = BOARD_HEIGHT/2 - 6;

    const ball = Bodies.circle(dropX, dropY, BALL_RADIUS, {
      restitution: 0.36, friction: 0.02, frictionAir: 0.002, density: 0.0018
    });
    ball.label = `BALL_${username}`;
    ball.plugin = { username, avatarUrl, scored: false };
    World.add(world, ball);
    dynamicBodies.add(ball);

    // Small nudge for variety
    const impulseX = (Math.random()*2-1) * (0.002 + DROP_SPEED*0.004);
    Body.applyForce(ball, ball.position, { x: impulseX, y: 0 });

    const tex = await loadAvatarTexture(avatarUrl, 128);
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 24, 18);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: tex,
      metalness: 0.08,
      roughness: 0.82,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      emissive: NEON ? new THREE.Color(0x00ffff) : new THREE.Color(0x000000),
      emissiveIntensity: NEON ? 0.07 : 0.0
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
    const curr = leaderboard[username] || { username, avatarUrl, score: 0 };
    const next = (curr.score || 0) + points;
    leaderboard[username] = { username, avatarUrl, score: next, lastUpdate: Date.now() };
    refreshLeaderboard();
    try {
      await FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g, '_'))}`, {
        username, avatarUrl: avatarUrl || '', score: next, lastUpdate: Date.now()
      });
    } catch {}
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
      li.appendChild(ava); li.appendChild(name); li.appendChild(score);
      leaderboardList.appendChild(li);
    }
  }

  // Firebase
  function listenToEvents() {
    FirebaseREST.onChildAdded('/events', (id, obj) => {
      if (!obj || typeof obj !== 'object' || processedEvents.has(id)) return;
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      if (ts && ts < startTime - 60_000) return;
      processedEvents.add(id);
      const username = (obj.username || 'viewer').toString().trim().slice(0, 24);
      const avatarUrl = obj.avatarUrl || '';
      const command = (obj.command || '').toLowerCase();
      if (command.includes('drop') || command.startsWith('gift')) spawnBall({ username, avatarUrl });
    });

    FirebaseREST.onValue('/leaderboard', (data) => {
      if (data && typeof data === 'object') {
        for (const k of Object.keys(data)) {
          const e = data[k];
          if (e?.username) leaderboard[e.username] = { username: e.username, avatarUrl: e.avatarUrl || '', score: e.score || 0, lastUpdate: e.lastUpdate || 0 };
        }
        refreshLeaderboard();
      }
    });

    FirebaseREST.onValue('/config', (data) => {
      const el = spawnStatusEl; if (!el) return;
      const enabled = !!(data && data.spawnEnabled);
      el.textContent = enabled ? 'true' : 'false';
      el.style.color = enabled ? 'var(--good)' : 'var(--danger)';
    });
  }

  // Bindings
  btnGear?.addEventListener('click', showSettings);
  btnCloseSettings?.addEventListener('click', hideSettings);
  ;['pointerdown','keydown'].forEach(ev => window.addEventListener(ev, () => initAudioOnce(), { once:true, passive:true }));
  optDropSpeed?.addEventListener('input', applySettings);
  optGravity?.addEventListener('input', applySettings);
  optMultiDrop?.addEventListener('input', applySettings);
  optNeon?.addEventListener('change', applySettings);
  optParticles?.addEventListener('change', applySettings);
  optVolume?.addEventListener('input', (e)=> setAudioVolume(Number(e.target.value)));

  btnSaveAdmin?.addEventListener('click', () => {
    try {
      const baseUrl = backendUrlInput.value.trim();
      const token = adminTokenInput.value.trim();
      setBackendBaseUrl(baseUrl);
      if (token) localStorage.setItem('adminToken', token); else localStorage.removeItem('adminToken');
      alert('Saved. Admin calls will use the backend URL you provided.');
    } catch { alert('Failed to save settings.'); }
  });

  btnReset?.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try { await adminFetch('/admin/reset-leaderboard', { method:'POST', headers:{ 'x-admin-token': token } }); alert('Leaderboard reset.'); }
    catch { alert('Failed to reset leaderboard. Check Backend URL.'); }
  });

  btnToggleSpawn?.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      const curr = spawnStatusEl?.textContent === 'true';
      const newVal = !curr;
      await adminFetch(`/admin/spawn-toggle?enabled=${newVal?'true':'false'}`, { method:'POST', headers:{ 'x-admin-token': token } });
      alert(`Spawn set to ${newVal}`);
    } catch { alert('Failed to toggle spawn. Check Backend URL.'); }
  });

  btnSimulate?.addEventListener('click', async () => {
    try {
      const name = 'LocalTester' + Math.floor(Math.random()*1000);
      const res = await adminFetch('/admin/spawn', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ username:name, avatarUrl:'', command:'!drop' }) });
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
  }
  start();
})();