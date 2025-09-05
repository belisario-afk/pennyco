// Plinkoo — True neon frame in WebGL, theme presets, peg normal map, ball Fresnel rim, toggleable Bloom/SMAA/Quality
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';
import {
  initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore,
  loadAvatarTexture, buildNameSprite, worldToScreen,
  makeRoundedRectRing, createRadialNormalMap, makeTrayMaterial
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

  // Physics tuning (calm)
  let GRAVITY_MAG = 1.0;
  let DROP_SPEED = 0.5; // no longer applies force; kept for UI consistency
  let NEON = true;
  let PARTICLES = true;

  const BALL_RESTITUTION = 0.06;
  const PEG_RESTITUTION  = 0.02;
  const BALL_FRICTION    = 0.04;
  const BALL_FRICTION_AIR= 0.012;

  const MAX_SPEED = 28;
  const MAX_H_SPEED = 22;

  // Themes
  const THEMES = {
    cyan:   { neon: 0x00f2ea, accent: 0xff0050, rim: 0x82ffff, trayTop: 0xff2a7a, trayBottom: 0x2a0010 },
    magenta:{ neon: 0xff0050, accent: 0x00f2ea, rim: 0xff99c0, trayTop: 0x00e6db, trayBottom: 0x001a19 },
    mono:   { neon: 0xffffff, accent: 0xffffff, rim: 0xffffff, trayTop: 0xffffff, trayBottom: 0x222222 },
  };
  let THEME_KEY = localStorage.getItem('plk_theme') || 'cyan';
  let QUALITY = localStorage.getItem('plk_quality') || 'medium';
  let BLOOM_ENABLED = (localStorage.getItem('plk_bloom') ?? 'true') === 'true';
  let BLOOM_STRENGTH = Number(localStorage.getItem('plk_bloom_strength') ?? '0.75');
  let SMAA_ENABLED = (localStorage.getItem('plk_smaa') ?? 'true') === 'true';

  // Runtime state
  let engine, world;
  let scene, camera, renderer, ambient, dirLight;
  let composer, bloomPass, smaaPass;
  let pegsInstanced, pegNormalTex;
  let neonFrameMesh, trayMesh, titleSprite;
  let slotSensors = [];         // { body, index }
  const dynamicBodies = new Set();
  const meshById = new Map();
  const labelById = new Map();
  const leaderboard = {};
  const processedEvents = new Set();
  const ballCountForUser = new Map();

  let TOP_ROW_Y = 0;
  const startTime = Date.now();

  // DOM refs
  const container = document.getElementById('game-container');
  const fxCanvas = document.getElementById('fx-canvas');
  const fxCtx = fxCanvas.getContext('2d');
  const slotLabelsEl = document.getElementById('slot-labels') || (() => {
    const el = document.createElement('div');
    el.id = 'slot-labels';
    document.getElementById('overlay').appendChild(el);
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
  const optNeon = document.getElementById('opt-neon'); // legacy, kept for compatibility (hidden/not present OK)
  const optParticles = document.getElementById('opt-particles');
  const optVolume = document.getElementById('opt-volume');

  const optTheme = document.getElementById('opt-theme');
  const optQuality = document.getElementById('opt-quality');
  const optBloom = document.getElementById('opt-bloom');
  const optBloomStrength = document.getElementById('opt-bloom-strength');
  const optSMAA = document.getElementById('opt-smaa');

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

  function renderSlotLabels(slotCount) {
    slotLabelsEl.innerHTML = '';
    SLOT_MULTIPLIERS.forEach((m) => {
      const div = document.createElement('div');
      div.className = 'slot-label';
      div.textContent = `x${m}`;
      slotLabelsEl.appendChild(div);
    });
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
    const parts = (localStorage.getItem('plk_particles') ?? 'true') === 'true';
    optParticles.checked = parts;

    // Theme/quality/post FX
    optTheme.value = THEME_KEY;
    optQuality.value = QUALITY;
    optBloom.checked = BLOOM_ENABLED;
    optBloomStrength.value = String(BLOOM_STRENGTH);
    optSMAA.checked = SMAA_ENABLED;

    const vol = Number(localStorage.getItem('plk_volume') ?? '0.5'); optVolume.value = String(vol); setAudioVolume(vol);
    const saved = getBackendBaseUrl(); if (saved) backendUrlInput.value = saved;
    const tok = localStorage.getItem('adminToken') || ''; if (tok) adminTokenInput.value = tok;
    applySettings();
  }

  function applySettings() {
    DROP_SPEED = Number(optDropSpeed.value);
    GRAVITY_MAG = Number(optGravity.value);
    PARTICLES = !!optParticles.checked;

    THEME_KEY = optTheme.value;
    QUALITY = optQuality.value;
    BLOOM_ENABLED = !!optBloom.checked;
    BLOOM_STRENGTH = Number(optBloomStrength.value);
    SMAA_ENABLED = !!optSMAA.checked;

    localStorage.setItem('plk_dropSpeed', String(DROP_SPEED));
    localStorage.setItem('plk_gravity', String(GRAVITY_MAG));
    localStorage.setItem('plk_multiDrop', String(optMultiDrop.value));
    localStorage.setItem('plk_particles', String(PARTICLES));

    localStorage.setItem('plk_theme', THEME_KEY);
    localStorage.setItem('plk_quality', QUALITY);
    localStorage.setItem('plk_bloom', String(BLOOM_ENABLED));
    localStorage.setItem('plk_bloom_strength', String(BLOOM_STRENGTH));
    localStorage.setItem('plk_smaa', String(SMAA_ENABLED));

    if (world) world.gravity.y = -Math.abs(GRAVITY_MAG);

    // Renderer quality
    if (renderer) {
      const cap = QUALITY === 'high' ? 2.0 : QUALITY === 'low' ? 1.1 : 1.5;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    }
    if (bloomPass) {
      bloomPass.enabled = BLOOM_ENABLED;
      bloomPass.strength = BLOOM_STRENGTH;
      bloomPass.threshold = 0.18;
      bloomPass.radius = 0.55;
    }
    if (smaaPass) smaaPass.enabled = SMAA_ENABLED;

    // Update theme colors on materials/meshes
    updateVisualTheme();
  }

  function showSettings(){ gsap.to(settingsPanel, { x: 0, duration: 0.35, ease: 'expo.out' }); }
  function hideSettings(){ gsap.to(settingsPanel, { x: '110%', duration: 0.35, ease: 'expo.in' }); }

  // Three setup
  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
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
      BLOOM_STRENGTH, 0.6, 0.18
    );
    bloomPass.enabled = BLOOM_ENABLED;
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

    rebuildBoardVisuals();
  }

  // Build/refresh frame + tray + title in WebGL
  function rebuildBoardVisuals() {
    // Cleanup old
    [neonFrameMesh, trayMesh, titleSprite].forEach(m => { if (!m) return; scene.remove(m); if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose?.(); });
    neonFrameMesh = null; trayMesh = null; titleSprite = null;

    const theme = THEMES[THEME_KEY];

    // Neon frame ring
    const frameGeom = makeRoundedRectRing(BOARD_WIDTH, BOARD_HEIGHT, Math.min(BOARD_WIDTH, BOARD_HEIGHT)*0.04, /*thickness*/ 1.8, 32);
    const frameMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(theme.neon),
      transparent: true,
      opacity: 1.0
    });
    neonFrameMesh = new THREE.Mesh(frameGeom, frameMat);
    neonFrameMesh.position.set(0, 0, -0.5);
    scene.add(neonFrameMesh);

    // Magenta/cyan tray gradient
    const trayW = BOARD_WIDTH, trayH = TRAY_HEIGHT;
    const trayGeo = new THREE.PlaneGeometry(trayW, trayH, 1, 1);
    const trayTop = new THREE.Color(theme.trayTop);
    const trayBot = new THREE.Color(theme.trayBottom);
    const trayMat = makeTrayMaterial(trayTop, trayBot, 0.55);
    trayMesh = new THREE.Mesh(trayGeo, trayMat);
    trayMesh.position.set(0, -BOARD_HEIGHT/2 + trayH/2, -0.6);
    scene.add(trayMesh);

    // Title sprite
    titleSprite = buildTitleSprite('PLINKO', theme.neon);
    titleSprite.position.set(-BOARD_WIDTH/2 + 3.0, BOARD_HEIGHT/2 - 4.0, -0.4);
    scene.add(titleSprite);

    // Rebuild slot labels row text
    const slotCount = ROWS + 1;
    buildSlots(slotCount);
    renderSlotLabels(slotCount);

    // Update pegs frame color after rebuild
    updateVisualTheme();
  }

  function buildTitleSprite(text, neonHex) {
    const t = String(text || 'PLINKO');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fs = 120;
    ctx.font = `900 ${fs}px Inter, system-ui, Arial`;
    const w = Math.ceil(ctx.measureText(t).width) + 40;
    const h = fs + 30;
    canvas.width = w; canvas.height = h;
    ctx.shadowColor = '#ffffffaa';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, 0, h/2 + 6);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, color: new THREE.Color(neonHex) });
    const spr = new THREE.Sprite(mat);
    const scale = 0.009;
    spr.scale.set(w*scale, h*scale, 1);
    return spr;
  }

  function updateVisualTheme() {
    const theme = THEMES[THEME_KEY];

    // Frame/tray
    if (neonFrameMesh) neonFrameMesh.material.color.set(theme.neon);
    if (trayMesh) {
      const mat = trayMesh.material;
      mat.uniforms.uTop.value.set(theme.trayTop);
      mat.uniforms.uBottom.value.set(theme.trayBottom);
      mat.needsUpdate = true;
    }
    if (titleSprite) titleSprite.material.color.set(theme.neon);

    // Pegs emissive/normal
    if (pegsInstanced) {
      const pm = pegsInstanced.material;
      pm.emissive.set(theme.neon);
      pm.emissiveIntensity = 0.30;
      pm.needsUpdate = true;
    }

    // Ball rim color update (future spawns will use theme)
  }

  // Matter setup
  function initMatter() {
    engine = Engine.create({ enableSleeping: false });
    world = engine.world;
    world.gravity.y = -Math.abs(GRAVITY_MAG);
    engine.positionIterations = 8;
    engine.velocityIterations = 6;
    engine.constraintIterations = 2;

    buildBoardPhysics();
    bindCollisions();
  }

  function buildBoardPhysics() {
    // Walls and kill-floor
    const left = Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const right = Bodies.rectangle(BOARD_WIDTH/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true });
    const floor = Bodies.rectangle(0, -BOARD_HEIGHT/2 - 6, BOARD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true, label: 'KILL' });
    World.add(world, [left, right, floor]);

    // Pegs instanced
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
    if (!pegNormalTex) pegNormalTex = createRadialNormalMap(64);

    const geo = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, 1.2, 20);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x86f7ff,
      metalness: 0.35,
      roughness: 0.35,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      emissive: new THREE.Color(THEMES[THEME_KEY].neon),
      emissiveIntensity: 0.30,
      normalMap: pegNormalTex,
      normalScale: new THREE.Vector2(0.35, 0.35)
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
          // simple spark: draw small circles on fx canvas (handled by external manager previously)
          fxCtx.fillStyle = '#00f2ea';
          fxCtx.beginPath(); fxCtx.arc(p2.x, p2.y, 1.6, 0, Math.PI*2); fxCtx.fill();
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

      clampVelocities();

      // Clear FX canvas each frame
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);

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

  // Fresnel rim injection for a MeshPhysicalMaterial
  function addFresnelRim(material, rimHex = THEMES[THEME_KEY].rim, power = 2.0, intensity = 0.35) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRimColor = { value: new THREE.Color(rimHex) };
      shader.uniforms.uRimPower = { value: power };
      shader.uniforms.uRimIntensity = { value: intensity };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // Fresnel rim (view-angle dependent)
         vec3 V = normalize(vViewPosition);
         vec3 N = normalize(geometryNormal);
         float rim = pow(clamp(1.0 - dot(V, N), 0.0, 1.0), uRimPower);
         totalEmissiveRadiance += uRimColor * (rim * uRimIntensity);
        `
      );
    };
    material.needsUpdate = true;
  }

  // Texture cache for avatars
  const avatarTextureCache = new Map();

  async function spawnBall({ username, avatarUrl }) {
    const multi = Math.max(1, Math.min(5, Number(optMultiDrop.value || 1)));
    for (let i=0;i<multi;i++) spawnSingle({ username, avatarUrl });
  }

  async function spawnSingle({ username, avatarUrl }) {
    const count = ballCountForUser.get(username) || 0;
    if (count > 18) return;

    const jitter = PEG_SPACING * 0.35;
    const dropX = Math.max(-BOARD_WIDTH/2 + 4, Math.min(BOARD_WIDTH/2 - 4, (Math.random()-0.5) * jitter));
    const dropY = TOP_ROW_Y + PEG_SPACING * 0.8;

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

    Body.setVelocity(ball, { x: 0, y: 0 });
    Body.setAngularVelocity(ball, 0);

    // Mesh with fresnel rim
    const theme = THEMES[THEME_KEY];
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 24, 18);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.25,
      roughness: 0.55,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 0.0
    });
    addFresnelRim(mat, theme.rim, 2.0, 0.35);
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    meshById.set(ball.id, mesh);

    // Name sprite
    const nameSprite = buildNameSprite(username);
    scene.add(nameSprite);
    labelById.set(ball.id, nameSprite);

    // Async avatar map swap
    try {
      let texPromise = avatarTextureCache.get(avatarUrl || '');
      if (!texPromise) {
        texPromise = loadAvatarTexture(avatarUrl, 128);
        avatarTextureCache.set(avatarUrl || '', texPromise);
      }
      const tex = await texPromise;
      const liveMesh = meshById.get(ball.id);
      if (liveMesh && liveMesh.material) {
        liveMesh.material.map = tex;
        liveMesh.material.needsUpdate = true;
      }
    } catch {}

    ballCountForUser.set(username, count + 1);
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

  function clearLeaderboardLocal() {
    for (const k of Object.keys(leaderboard)) delete leaderboard[k];
    leaderboardList.innerHTML = '';
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
      } else {
        clearLeaderboardLocal();
      }
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

  // Settings bindings + Audio unlock
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
  if (optNeon) optNeon.addEventListener('change', applySettings);
  optParticles.addEventListener('change', applySettings);
  optVolume.addEventListener('input', (e)=> setAudioVolume(Number(e.target.value)));

  optTheme.addEventListener('change', () => { applySettings(); rebuildBoardVisuals(); });
  optQuality.addEventListener('change', applySettings);
  optBloom.addEventListener('change', applySettings);
  optBloomStrength.addEventListener('input', applySettings);
  optSMAA.addEventListener('change', applySettings);

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