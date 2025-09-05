(() => {
  const { Engine, Render, Runner, World, Bodies, Body, Composite, Events } = Matter;

  // Config
  const BOARD_WIDTH = 18;  // world units
  const BOARD_HEIGHT = 32;
  const BOARD_ROWS = 12;
  const PEG_SPACING = 1.2;
  const PEG_RADIUS = 0.18;
  const BALL_RADIUS = 0.45;
  const SLOT_HEIGHT = 1.2;
  const WALL_THICKNESS = 1;
  const GRAVITY_Y = 1.0;
  const DROP_X_NOISE = 2.5;

  // Scoring slots (built from rows+1)
  let SLOT_POINTS = [];
  function buildSlotPoints(slotCount) {
    const center = Math.floor((slotCount - 1) / 2);
    const arr = [];
    for (let i = 0; i < slotCount; i++) {
      const d = Math.abs(i - center);
      const val = d === 0 ? 500 : d === 1 ? 200 : d === 2 ? 100 : 50;
      arr.push(val);
    }
    SLOT_POINTS = arr;
  }

  // State
  let scene, camera, renderer, ambient, dirLight;
  let engine, runner, world;
  let threeObjects = new Map(); // body.id -> mesh
  let labels = new Map(); // body.id -> sprite
  let slotSensors = []; // { body, index, x, points }
  let spawnEnabled = true;

  const leaderboard = {}; // username -> { username, avatarUrl, score }
  const processedEvents = new Set();
  const ballCountForUser = new Map();
  const startTime = Date.now();

  // DOM
  const container = document.getElementById('game-container');
  const confettiCanvas = document.getElementById('confetti-canvas');
  const slotLabelsEl = document.getElementById('slot-labels');
  const leaderboardList = document.getElementById('leaderboard-list');
  const spawnStatusEl = document.getElementById('spawn-status');

  // Admin elements
  const adminTokenInput = document.getElementById('admin-token');
  const backendUrlInput = document.getElementById('backend-url');
  const btnSaveAdmin = document.getElementById('btn-save-admin');
  const btnReset = document.getElementById('btn-reset-leaderboard');
  const btnToggleSpawn = document.getElementById('btn-toggle-spawn');
  const btnSimulate = document.getElementById('btn-simulate');

  // Backend URL management (Render)
  function getBackendBaseUrl() {
    const v = (localStorage.getItem('backendBaseUrl') || '').trim();
    return v;
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

  // Initialize admin inputs from storage
  (function initAdminInputs() {
    const saved = getBackendBaseUrl();
    if (saved) backendUrlInput.value = saved;
    const savedToken = localStorage.getItem('adminToken') || '';
    if (savedToken) adminTokenInput.value = savedToken;
  })();

  function initThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    resizeRenderer();
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = null;

    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(46, aspect, 0.1, 1000);
    camera.position.set(0, 0, 35);

    ambient = new THREE.AmbientLight(0xffffff, 0.9);
    dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(-10, 20, 20);
    scene.add(ambient, dirLight);

    window.addEventListener('resize', () => {
      resizeRenderer();
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      confettiCanvas.width = container.clientWidth;
      confettiCanvas.height = container.clientHeight;
    });
    confettiCanvas.width = container.clientWidth;
    confettiCanvas.height = container.clientHeight;
  }

  function resizeRenderer() {
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  function initMatter() {
    engine = Engine.create();
    world = engine.world;
    world.gravity.y = GRAVITY_Y;

    runner = Runner.create();
    Runner.run(runner, engine);

    // Walls
    const left = Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true, friction: 0.2, restitution: 0.4 });
    const right = Bodies.rectangle(BOARD_WIDTH/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic: true, friction: 0.2, restitution: 0.4 });
    const floor = Bodies.rectangle(0, -BOARD_HEIGHT/2 - 2, BOARD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true });
    World.add(world, [left, right, floor]);

    // Pegs in upright triangle (pyramid pointing up)
    const rows = BOARD_ROWS;
    const startY = BOARD_HEIGHT/2 - 4; // top space for drops
    const rowHeight = PEG_SPACING;
    const startX = -((rows - 1) * PEG_SPACING) / 2;

    for (let r = 0; r < rows; r++) {
      const y = startY - r * rowHeight;
      for (let c = 0; c <= r; c++) {
        const x = startX + c * PEG_SPACING + (rows - 1 - r) * (PEG_SPACING / 2);
        const peg = Bodies.circle(x, y, PEG_RADIUS, {
          isStatic: true,
          restitution: 0.4,
          friction: 0.05
        });
        World.add(world, peg);
        addPegMesh(peg);
      }
    }

    // Slots at bottom (sensors)
    const slotCount = rows + 1;
    buildSlotPoints(slotCount);
    renderSlotLabels(slotCount);

    const slotWidth = BOARD_WIDTH / slotCount;
    const slotY = -BOARD_HEIGHT/2 + SLOT_HEIGHT / 2;

    for (let i = 0; i < slotCount; i++) {
      const x = -BOARD_WIDTH/2 + slotWidth * (i + 0.5);
      const body = Bodies.rectangle(x, slotY, slotWidth, SLOT_HEIGHT, { isStatic: true, isSensor: true });
      body.label = `SLOT_${i}`;
      World.add(world, body);
      slotSensors.push({
        body, index: i, x, points: SLOT_POINTS[i]
      });
    }

    // Render loop
    const animate = () => {
      requestAnimationFrame(animate);
      updateThreeFromMatter();
      renderer.render(scene, camera);
    };
    animate();

    // Collision handling
    Events.on(engine, 'collisionStart', (ev) => {
      ev.pairs.forEach(({ bodyA, bodyB }) => {
        handleCollision(bodyA, bodyB);
        handleCollision(bodyB, bodyA);
      });
    });
  }

  function addPegMesh(pegBody) {
    const geo = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, 0.4, 12);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4f5c78, metalness: 0.4, roughness: 0.6 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    scene.add(mesh);
    threeObjects.set(pegBody.id, mesh);
  }

  function addBallMesh(ballBody, texture) {
    const geo = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: texture,
      metalness: 0.1,
      roughness: 0.8
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    threeObjects.set(ballBody.id, mesh);
  }

  function updateThreeFromMatter() {
    Composite.allBodies(world).forEach((body) => {
      const mesh = threeObjects.get(body.id);
      if (mesh) {
        mesh.position.set(body.position.x, body.position.y, 0);
        mesh.rotation.z = body.angle;
      }
      const label = labels.get(body.id);
      if (label) {
        label.position.set(body.position.x, body.position.y + BALL_RADIUS * 2, 0);
      }
    });
  }

  async function spawnBall({ username, avatarUrl }) {
    if (!spawnEnabled) return;

    const count = ballCountForUser.get(username) || 0;
    if (count > 18) return; // avoid too many

    const xNoise = (Math.random() - 0.5) * DROP_X_NOISE;
    const dropX = Math.max(-BOARD_WIDTH/2 + 1, Math.min(BOARD_WIDTH/2 - 1, xNoise));
    const dropY = BOARD_HEIGHT/2 - 1;
    const ball = Bodies.circle(dropX, dropY, BALL_RADIUS, {
      restitution: 0.35,
      friction: 0.02,
      density: 0.002,
    });
    ball.label = `BALL_${username}`;
    ball.plugin = { username, avatarUrl, scored: false };
    World.add(world, ball);

    const texture = await PlinkoUtils.loadAvatarTexture(avatarUrl, 128);
    addBallMesh(ball, texture);

    const nameSprite = PlinkoUtils.buildNameSprite(username);
    scene.add(nameSprite);
    labels.set(ball.id, nameSprite);

    ballCountForUser.set(username, count + 1);
  }

  function handleCollision(body, against) {
    // Detect sensor hit: ball entering a slot
    const sensor = slotSensors.find(s => s.body.id === against.id);
    if (!sensor) return;
    if (!body || !body.plugin || !String(body.label || '').startsWith('BALL_')) return;
    if (body.plugin.scored) return;

    const vy = body.velocity.y;
    if (body.position.y < sensor.body.position.y + 0.2 && vy < 1.0) {
      body.plugin.scored = true;
      const username = body.plugin.username;
      const avatarUrl = body.plugin.avatarUrl || '';

      const points = sensor.points;
      awardPoints(username, avatarUrl, points).catch(console.warn);

      if (points >= 500) {
        const canvas = document.getElementById('confetti-canvas');
        PlinkoUtils.fireworks(canvas, 1600);
      }

      setTimeout(() => {
        tryRemoveBody(body);
      }, 1500);
    }
  }

  function tryRemoveBody(body) {
    try {
      const mesh = threeObjects.get(body.id);
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        if (mesh.material && mesh.material.map) mesh.material.map.dispose();
        if (mesh.material) mesh.material.dispose();
      }
      const lbl = labels.get(body.id);
      if (lbl) {
        scene.remove(lbl);
        if (lbl.material && lbl.material.map) lbl.material.map.dispose();
        if (lbl.material) lbl.material.dispose();
      }
      threeObjects.delete(body.id);
      labels.delete(body.id);
      World.remove(world, body);

      const username = body.plugin?.username;
      if (username) {
        const c = ballCountForUser.get(username) || 1;
        ballCountForUser.set(username, Math.max(0, c - 1));
      }
    } catch (e) {
      // noop
    }
  }

  async function awardPoints(username, avatarUrl, points) {
    const current = leaderboard[username] || { username, avatarUrl, score: 0 };
    const nextScore = (current.score || 0) + points;
    leaderboard[username] = { username, avatarUrl, score: nextScore, lastUpdate: Date.now() };
    refreshLeaderboard();
    // Write to leaderboard (allowed by demo rules)
    try {
      await FirebaseREST.update(`/leaderboard/${encodeKey(username)}`, {
        username,
        avatarUrl: avatarUrl || '',
        score: nextScore,
        lastUpdate: Date.now(),
      });
    } catch (e) {
      console.warn('Leaderboard write failed (client rules?)', e);
    }
  }

  function refreshLeaderboard() {
    const entries = Object.values(leaderboard).sort((a, b) => b.score - a.score).slice(0, 50);
    leaderboardList.innerHTML = '';
    entries.forEach((e) => {
      const li = document.createElement('li');
      li.textContent = `${e.username}: ${e.score}`;
      leaderboardList.appendChild(li);
    });
  }

  // Firebase listeners
  function listenToEvents() {
    FirebaseREST.onChildAdded('/events', (id, obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (processedEvents.has(id)) return;

      // Skip historical backlog older than page load (1 minute buffer)
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      if (ts && ts < startTime - 60_000) return;

      processedEvents.add(id);

      // Event shape: { username, command, avatarUrl, timestamp }
      const username = sanitizeUsername(obj.username || 'viewer');
      const avatarUrl = obj.avatarUrl || '';
      const command = (obj.command || '').toLowerCase();

      if (!spawnEnabled) return;
      if (command.includes('drop') || command.startsWith('gift')) {
        spawnBall({ username, avatarUrl });
      }
    });

    FirebaseREST.onValue('/leaderboard', (data) => {
      if (data && typeof data === 'object') {
        Object.keys(data).forEach((k) => {
          const entry = data[k];
          if (entry && entry.username) {
            leaderboard[entry.username] = { username: entry.username, avatarUrl: entry.avatarUrl || '', score: entry.score || 0, lastUpdate: entry.lastUpdate || 0 };
          }
        });
        refreshLeaderboard();
      }
    });

    FirebaseREST.onValue('/config', (data) => {
      const enabled = !!(data && data.spawnEnabled);
      spawnEnabled = enabled;
      spawnStatusEl.textContent = enabled ? 'true' : 'false';
      spawnStatusEl.style.color = enabled ? 'var(--success)' : 'var(--danger)';
    });
  }

  function renderSlotLabels(slotCount) {
    slotLabelsEl.innerHTML = '';
    for (let i = 0; i < slotCount; i++) {
      const label = document.createElement('div');
      label.className = 'slot-label';
      label.textContent = `${SLOT_POINTS[i]}`;
      slotLabelsEl.appendChild(label);
    }
  }

  // Helpers
  function sanitizeUsername(u) {
    const s = String(u || '').trim();
    if (!s) return 'viewer';
    return s.slice(0, 24);
  }

  function encodeKey(k) {
    // Firebase keys cannot contain ., $, #, [, ]
    return encodeURIComponent(k.replace(/[.#$[\]]/g, '_'));
  }

  // Admin UI actions
  btnSaveAdmin.addEventListener('click', () => {
    try {
      const baseUrl = backendUrlInput.value.trim();
      const token = adminTokenInput.value.trim();
      setBackendBaseUrl(baseUrl);
      if (token) localStorage.setItem('adminToken', token);
      else localStorage.removeItem('adminToken');
      alert('Saved. Admin calls will use the backend URL you provided.');
    } catch (e) {
      alert('Failed to save settings.');
    }
  });

  btnReset.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      await adminFetch('/admin/reset-leaderboard', { method: 'POST', headers: { 'x-admin-token': token } });
      alert('Leaderboard reset.');
    } catch (e) {
      alert('Failed to reset leaderboard. Check Backend URL.');
    }
  });

  btnToggleSpawn.addEventListener('click', async () => {
    const token = adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if (!token) return alert('Provide admin token.');
    try {
      const newVal = !spawnEnabled;
      await adminFetch(`/admin/spawn-toggle?enabled=${newVal ? 'true' : 'false'}`, { method: 'POST', headers: { 'x-admin-token': token } });
      alert(`Spawn set to ${newVal}`);
    } catch (e) {
      alert('Failed to toggle spawn. Check Backend URL.');
    }
  });

  btnSimulate.addEventListener('click', async () => {
    try {
      const name = 'LocalTester' + Math.floor(Math.random() * 1000);
      await adminFetch('/admin/spawn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, avatarUrl: '', command: '!drop' })
      });
      alert('Simulated drop sent.');
    } catch (e) {
      alert('Simulation failed. Check Backend URL.');
    }
  });

  // Start
  function start() {
    initThree();
    initMatter();
    listenToEvents();

    // Do NOT try to write /config here; server manages it.
    // FirebaseREST.update('/config', { spawnEnabled: true }).catch(() => {});
  }

  start();
})();