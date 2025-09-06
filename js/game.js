// Plinkoo Game (import-map friendly) with:
// - Calm physics
// - Instant spawn (avatar texture applied async)
// - Adaptive quality (reduces bloom/SMAA on slow frames)
// - Shared geometries/material caching
// - Performance panel (toggle via SHOW_PERF_PANEL)
// - Accessibility + favicon fixes handled in index.html
import * as THREE from 'three';
import {
  loadAvatarTexture, buildNameSprite, worldToScreen,
  FXManager2D, initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore
} from './utils.js';

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

const { Engine, World, Bodies, Events, Body } = Matter;

(() => {
  // --- Feature toggles ---
  const SHOW_PERF_PANEL = true;
  const ADAPTIVE_QUALITY = true;

  // --- Timing / physics constants ---
  const FIXED_DT = 1000/60;
  const MAX_STEPS_BASE = 4;

  // Adaptive step (limit catch-up loops if frame > 120ms)
  function maxStepsForFrame(dt) {
    return dt > 140 ? 1 : dt > 90 ? 2 : MAX_STEPS_BASE;
  }

  // --- World / board ---
  const WORLD_HEIGHT = 100;
  let WORLD_WIDTH = 56.25;
  let BOARD_HEIGHT = WORLD_HEIGHT * 0.82;
  let BOARD_WIDTH  = 0;
  let PEG_SPACING  = 4.2;
  const ROWS = 12;
  const PEG_RADIUS = 0.75;
  const BALL_RADIUS = 1.5;
  const WALL_THICKNESS = 2.0;
  const TRAY_RATIO = 0.22;
  let TRAY_HEIGHT = 0;

  // Physics tuning
  let GRAVITY_MAG = 1.0;
  let DROP_SPEED   = 0.5; // (retained for UI, not used to push ball)
  let NEON = true;
  let PARTICLES = true;

  const BALL_RESTITUTION = 0.06;
  const PEG_RESTITUTION  = 0.02;
  const BALL_FRICTION    = 0.04;
  const BALL_FRICTION_AIR= 0.012;

  const MAX_SPEED = 28;
  const MAX_H_SPEED = 22;

  // --- Engine / scene state ---
  let engine, world;
  let scene, camera, renderer, ambient, dirLight, pegsInstanced;
  let composer, bloomPass, smaaPass;
  let fxMgr;

  // Entities
  let slotSensors = [];
  const dynamicBodies = new Set();
  const meshById = new Map();
  const labelById = new Map();

  // Leaderboard
  const leaderboard = {};
  const processedEvents = new Set();
  const ballCountForUser = new Map();

  // Slots
  let SLOT_POINTS = [];
  let SLOT_MULTIPLIERS = [];

  // Top row Y
  let TOP_ROW_Y = 0;
  const startTime = Date.now();

  // DOM elements
  const container       = document.getElementById('game-container');
  const fxCanvas        = document.getElementById('fx-canvas');
  const fxCtx           = fxCanvas.getContext('2d');
  const boardFrame      = document.getElementById('board-frame');
  const boardDivider    = document.getElementById('board-divider');
  const slotTray        = document.getElementById('slot-tray');
  const trayDividers    = document.getElementById('tray-dividers');
  const boardTitle      = document.getElementById('board-title');
  const slotLabelsEl    = document.getElementById('slot-labels');
  const leaderboardList = document.getElementById('leaderboard-list');
  const spawnStatusEl   = document.getElementById('spawn-status');

  // Settings / Admin
  const btnGear         = document.getElementById('btn-gear');
  const settingsPanel   = document.getElementById('settings-panel');
  const btnCloseSettings= document.getElementById('btn-close-settings');
  const optDropSpeed    = document.getElementById('opt-drop-speed');
  const optGravity      = document.getElementById('opt-gravity');
  const optMultiDrop    = document.getElementById('opt-multidrop');
  const optNeon         = document.getElementById('opt-neon');
  const optParticles    = document.getElementById('opt-particles');
  const optVolume       = document.getElementById('opt-volume');
  const adminTokenInput = document.getElementById('admin-token');
  const backendUrlInput = document.getElementById('backend-url');
  const btnSaveAdmin    = document.getElementById('btn-save-admin');
  const btnReset        = document.getElementById('btn-reset-leaderboard');
  const btnToggleSpawn  = document.getElementById('btn-toggle-spawn');
  const btnSimulate     = document.getElementById('btn-simulate');

  // Performance panel
  let perfPanel, perfData = {
    frameMs: 0,
    avgMs: 0,
    worstMs: 0,
    frames: 0,
    qualityTier: 2 // 2=full, 1=medium, 0=low
  };

  // Geometry / material caches
  const sharedBallGeo = new THREE.SphereGeometry(BALL_RADIUS, 20, 14);
  let sharedBallBaseMaterial = null; // created on first use

  // Avatar texture caching
  const avatarTextureCache = new Map(); // url -> Promise<Texture>

  // --- Slot Setup ---
  function buildSlots(slotCount) {
    const center = Math.floor((slotCount - 1)/2);
    const mult = (d)=>(d===0?16:d===1?9:d===2?5:d===3?3:1);
    SLOT_MULTIPLIERS = Array.from({length:slotCount}, (_,i)=>mult(Math.abs(i-center)));
    SLOT_POINTS = SLOT_MULTIPLIERS.map(m=>m*100);
  }
  function renderSlotLabels(slotCount, framePx) {
    slotLabelsEl.innerHTML = '';
    SLOT_MULTIPLIERS.forEach(m=>{
      const div=document.createElement('div');
      div.className='slot-label';
      div.textContent=`x${m}`;
      slotLabelsEl.appendChild(div);
    });
    trayDividers.style.setProperty('--slot-width', `${framePx.width / slotCount}px`);
  }

  // --- Backend Helpers ---
  function getBackendBaseUrl(){ return (localStorage.getItem('backendBaseUrl')||'').trim(); }
  function setBackendBaseUrl(url){
    const clean=String(url||'').trim().replace(/\/+$/,'');
    if(clean) localStorage.setItem('backendBaseUrl',clean); else localStorage.removeItem('backendBaseUrl');
  }
  function adminFetch(path, options={}){
    const base=getBackendBaseUrl();
    if(!base) throw new Error('Backend URL not set.');
    return fetch(`${base}${path.startsWith('/')?'':'/'}${path}`, options);
  }

  // --- Settings ---
  function loadSettings(){
    const g = Number(localStorage.getItem('plk_gravity') ?? '1'); if(!Number.isNaN(g)) optGravity.value=String(g);
    const ds = Number(localStorage.getItem('plk_dropSpeed') ?? '0.5'); if(!Number.isNaN(ds)) optDropSpeed.value=String(ds);
    const md = Number(localStorage.getItem('plk_multiDrop') ?? '1'); if(!Number.isNaN(md)) optMultiDrop.value=String(md);
    optNeon.checked      = (localStorage.getItem('plk_neon') ?? 'true') === 'true';
    optParticles.checked = (localStorage.getItem('plk_particles') ?? 'true') === 'true';
    const vol = Number(localStorage.getItem('plk_volume') ?? '0.5'); optVolume.value=String(vol); setAudioVolume(vol);
    const saved = getBackendBaseUrl(); if(saved) backendUrlInput.value=saved;
    const tok = localStorage.getItem('adminToken') || ''; if(tok) adminTokenInput.value=tok;
    applySettings();
  }

  function applySettings(){
    DROP_SPEED  = Number(optDropSpeed.value);
    GRAVITY_MAG = Number(optGravity.value);
    NEON        = !!optNeon.checked;
    PARTICLES   = !!optParticles.checked;
    localStorage.setItem('plk_dropSpeed', String(DROP_SPEED));
    localStorage.setItem('plk_gravity',   String(GRAVITY_MAG));
    localStorage.setItem('plk_multiDrop', String(optMultiDrop.value));
    localStorage.setItem('plk_neon',      String(NEON));
    localStorage.setItem('plk_particles', String(PARTICLES));
    if(world) world.gravity.y = -Math.abs(GRAVITY_MAG);
    if(pegsInstanced){
      pegsInstanced.material.emissive.set(NEON?0x00ffff:0x000000);
      pegsInstanced.material.emissiveIntensity = NEON?0.30:0.0;
      pegsInstanced.material.needsUpdate=true;
    }
    if(bloomPass){
      bloomPass.enabled  = NEON;
      bloomPass.strength = NEON?0.75:0.0;
      bloomPass.threshold=0.2;
      bloomPass.radius   =0.6;
    }
  }

  function showSettings(){ gsap.to(settingsPanel,{ x:0, duration:.35, ease:'expo.out' }); settingsPanel.setAttribute('aria-hidden','false'); }
  function hideSettings(){ gsap.to(settingsPanel,{ x:'110%', duration:.35, ease:'expo.in' }); settingsPanel.setAttribute('aria-hidden','true'); }

  // --- Three.js Setup ---
  function initThree(){
    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping      = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.0;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 1.75));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000,0);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    computeWorldSize();
    camera = new THREE.OrthographicCamera(
      -WORLD_WIDTH/2, WORLD_WIDTH/2, WORLD_HEIGHT/2, -WORLD_HEIGHT/2, 0.1, 1000
    );
    camera.position.set(0,0,10);

    ambient = new THREE.AmbientLight(0xffffff,0.9);
    dirLight= new THREE.DirectionalLight(0xffffff,0.85);
    dirLight.position.set(-8,16,18);
    scene.add(ambient, dirLight);

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene,camera));
    smaaPass = new SMAAPass(renderer.domElement.width, renderer.domElement.height);
    composer.addPass(smaaPass);
    bloomPass= new UnrealBloomPass(
      new THREE.Vector2(renderer.domElement.width, renderer.domElement.height),
      0.75, 0.6, 0.2
    );
    composer.addPass(bloomPass);

    const ro=new ResizeObserver(onResize);
    ro.observe(container);
    onResize();

    if(SHOW_PERF_PANEL){
      perfPanel=document.createElement('div');
      perfPanel.id='perf-panel';
      perfPanel.textContent='Perf...';
      document.body.appendChild(perfPanel);
    }
  }

  function computeWorldSize(){
    const w=container.clientWidth||1;
    const h=container.clientHeight||1;
    const aspect=w/h;
    WORLD_WIDTH  = WORLD_HEIGHT * aspect;
    BOARD_HEIGHT = WORLD_HEIGHT * 0.82;
    BOARD_WIDTH  = Math.min(WORLD_WIDTH*0.88, BOARD_HEIGHT*0.9);
    PEG_SPACING  = BOARD_WIDTH / (ROWS + 1);
    TRAY_HEIGHT  = BOARD_HEIGHT * TRAY_RATIO;
  }

  function onResize(){
    renderer.setSize(container.clientWidth, container.clientHeight);
    composer.setSize(container.clientWidth, container.clientHeight);
    smaaPass.setSize(container.clientWidth, container.clientHeight);
    bloomPass.setSize(container.clientWidth, container.clientHeight);

    computeWorldSize();
    camera.left   = -WORLD_WIDTH/2;
    camera.right  =  WORLD_WIDTH/2;
    camera.top    =  WORLD_HEIGHT/2;
    camera.bottom = -WORLD_HEIGHT/2;
    camera.updateProjectionMatrix();

    fxCanvas.width  = container.clientWidth;
    fxCanvas.height = container.clientHeight;

    layoutOverlays();
  }

  function layoutOverlays(){
    const left=-BOARD_WIDTH/2,right=BOARD_WIDTH/2;
    const top=BOARD_HEIGHT/2,bottom=-BOARD_HEIGHT/2;
    const trayTop= bottom + TRAY_HEIGHT;

    const pTopLeft     = worldToScreen(new THREE.Vector3(left,top,0),camera,renderer);
    const pBottomRight = worldToScreen(new THREE.Vector3(right,bottom,0),camera,renderer);
    const pTrayTopLeft = worldToScreen(new THREE.Vector3(left,trayTop,0),camera,renderer);

    const frame = {
      x:Math.round(pTopLeft.x),
      y:Math.round(pTopLeft.y),
      width:Math.round(pBottomRight.x - pTopLeft.x),
      height:Math.round(pBottomRight.y - pTopLeft.y)
    };
    const tray = {
      x:frame.x,
      width:frame.width,
      height:Math.round(pBottomRight.y - pTrayTopLeft.y),
      top:Math.round(pTrayTopLeft.y)
    };

    Object.assign(boardFrame.style,{left:frame.x+'px',top:frame.y+'px',width:frame.width+'px',height:frame.height+'px',display:'block'});
    Object.assign(slotTray.style,{left:tray.x+'px',top:tray.top+'px',width:tray.width+'px',height:tray.height+'px',display:'block'});
    Object.assign(boardDivider.style,{left:frame.x+'px',width:frame.width+'px',top:(pTrayTopLeft.y-1)+'px',display:'block'});
    boardTitle.style.left=(frame.x+22)+'px';
    boardTitle.style.top =(frame.y+18)+'px';

    const slotCount= ROWS + 1;
    buildSlots(slotCount);
    renderSlotLabels(slotCount, frame);
  }

  // --- Matter.js ---
  function initMatter(){
    engine = Engine.create({ enableSleeping:false });
    world  = engine.world;
    world.gravity.y = -Math.abs(GRAVITY_MAG);
    engine.positionIterations=8;
    engine.velocityIterations=6;
    engine.constraintIterations=2;
    buildBoard();
    bindCollisions();
    fxMgr = new FXManager2D(fxCanvas);
  }

  function buildBoard(){
    const left = Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic:true });
    const right= Bodies.rectangle( BOARD_WIDTH/2 + WALL_THICKNESS/2, 0, WALL_THICKNESS, BOARD_HEIGHT, { isStatic:true });
    const floor= Bodies.rectangle(0, -BOARD_HEIGHT/2 - 6, BOARD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic:true, label:'KILL' });
    World.add(world, [left,right,floor]);

    const startY = BOARD_HEIGHT/2 - 10;
    TOP_ROW_Y = startY;
    const rowH= PEG_SPACING*0.9;
    const startX = -((ROWS -1)*PEG_SPACING)/2;
    const pegPositions=[];
    for(let r=0;r<ROWS;r++){
      const y=startY - r*rowH;
      for(let c=0;c<=r;c++){
        const x = startX + c*PEG_SPACING + (ROWS-1-r)*(PEG_SPACING/2);
        const peg = Bodies.circle(x,y,PEG_RADIUS,{
          isStatic:true,
          restitution: PEG_RESTITUTION,
          friction:0.01
        });
        peg.label='PEG';
        World.add(world, peg);
        pegPositions.push({x,y});
      }
    }
    addPegInstancedMesh(pegPositions);

    slotSensors=[];
    const slotCount=ROWS+1;
    const slotWidth=BOARD_WIDTH/slotCount;
    const slotY=-BOARD_HEIGHT/2 + (TRAY_HEIGHT * 0.35);
    for(let i=0;i<slotCount;i++){
      const x = -BOARD_WIDTH/2 + slotWidth*(i+0.5);
      const sensor = Bodies.rectangle(x, slotY, slotWidth, 2.6, { isStatic:true, isSensor:true });
      sensor.label=`SLOT_${i}`;
      World.add(world, sensor);
      slotSensors.push({ body:sensor, index:i });
    }
  }

  function addPegInstancedMesh(pegPositions){
    if(pegsInstanced){
      scene.remove(pegsInstanced);
      pegsInstanced.geometry.dispose();
      pegsInstanced.material.dispose();
    }
    const geo = new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, 1.2, 16);
    const mat = new THREE.MeshPhysicalMaterial({
      color:0x86f7ff,
      metalness:0.35,
      roughness:0.35,
      clearcoat:0.6,
      clearcoatRoughness:0.2,
      emissive:new THREE.Color(0x00ffff),
      emissiveIntensity:0.30
    });
    const inst = new THREE.InstancedMesh(geo, mat, pegPositions.length);
    const m=new THREE.Matrix4();
    const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), Math.PI/2);
    for(let i=0;i<pegPositions.length;i++){
      const {x,y}=pegPositions[i];
      m.compose(new THREE.Vector3(x,y,0), q, new THREE.Vector3(1,1,1));
      inst.setMatrixAt(i,m);
    }
    inst.instanceMatrix.needsUpdate=true;
    pegsInstanced=inst;
    scene.add(inst);
  }

  function bindCollisions(){
    Events.on(engine,'collisionStart', ev=>{
      for(const { bodyA, bodyB } of ev.pairs){
        handlePair(bodyA, bodyB);
        handlePair(bodyB, bodyA);
      }
    });
  }

  function handlePair(a,b){
    if(!a||!b) return;
    const slot=slotSensors.find(s=>s.body.id===b.id);
    if(slot && String(a.label||'').startsWith('BALL_')){
      const ball=a;
      if(!ball.plugin?.scored){
        const idx=slot.index;
        const points = SLOT_POINTS[idx] || 100;
        ball.plugin.scored=true;
        awardPoints(ball.plugin.username, ball.plugin.avatarUrl||'', points).catch(console.warn);
        sfxScore(points >= 1600);
        setTimeout(()=>tryRemoveBall(ball), 900);
      }
      return;
    }
    if(b.label==='PEG' && String(a.label||'').startsWith('BALL_')){
      if(PARTICLES){
        const mesh=meshById.get(a.id);
        if(mesh){
          const p2=worldToScreen(mesh.position,camera,renderer);
            fxMgr.addSparks(p2.x,p2.y,'#00f2ea',12);
        }
      }
      sfxBounce();
    }
    if(b.label==='KILL' && String(a.label||'').startsWith('BALL_')){
      tryRemoveBall(a);
    }
  }

  // --- Adapt Quality ---
  function adaptQuality(frameMs){
    perfData.frameMs = frameMs;
    perfData.frames++;
    // Exponential moving average
    perfData.avgMs = perfData.avgMs ? perfData.avgMs*0.9 + frameMs*0.1 : frameMs;
    if(frameMs > perfData.worstMs) perfData.worstMs = frameMs;

    if(!ADAPTIVE_QUALITY) return;

    // Quality tiers:
    // 2: Full (bloom strength 0.75, SMAA on)
    // 1: Medium (bloom 0.45, SMAA on)
    // 0: Low (bloom 0.25, SMAA off)
    const avg = perfData.avgMs;
    let targetTier = 2;
    if(avg > 28) targetTier = 0;
    else if(avg > 22) targetTier = 1;

    if(targetTier !== perfData.qualityTier){
      perfData.qualityTier = targetTier;
      if(targetTier === 2){
        if(bloomPass){ bloomPass.strength=0.75; bloomPass.enabled=NEON; }
        if(smaaPass) smaaPass.enabled=true;
      } else if(targetTier === 1){
        if(bloomPass){ bloomPass.strength=0.45; bloomPass.enabled=NEON; }
        if(smaaPass) smaaPass.enabled=true;
      } else {
        if(bloomPass){ bloomPass.strength=0.25; bloomPass.enabled=NEON; }
        if(smaaPass) smaaPass.enabled=false;
      }
    }

    if(perfPanel && perfData.frames % 30 === 0){
      perfPanel.textContent =
        `fps:${(1000/avg).toFixed(1)} ms:${avg.toFixed(1)} worst:${perfData.worstMs.toFixed(1)} tier:${perfData.qualityTier}`;
    }
  }

  // --- Main Loop ---
  function startLoop(){
    let last=performance.now(), acc=0;
    function tick(now){
      const dt=Math.min(200, now-last);
      last=now;
      acc+=dt;
      let steps=0;
      const maxSteps = maxStepsForFrame(dt);
      while(acc >= FIXED_DT && steps < maxSteps){
        Engine.update(engine, FIXED_DT);
        acc -= FIXED_DT;
        steps++;
      }

      clampVelocities();
      fxMgr.update(fxCtx, dt);
      updateThreeFromMatter();

      const t0 = performance.now();
      composer.render();
      const renderCost = performance.now() - t0;

      adaptQuality(dt + renderCost);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function clampVelocities(){
    for(const b of dynamicBodies){
      const vx=b.velocity.x, vy=b.velocity.y;
      let sx=vx, sy=vy;
      if(Math.abs(sx)>MAX_H_SPEED) sx = Math.sign(sx)*MAX_H_SPEED;
      const speed=Math.hypot(sx,sy);
      if(speed>MAX_SPEED){
        const k=MAX_SPEED/speed; sx*=k; sy*=k;
      }
      if(sx!==vx || sy!==vy) Body.setVelocity(b,{x:sx,y:sy});
    }
  }

  function updateThreeFromMatter(){
    dynamicBodies.forEach(body=>{
      const mesh=meshById.get(body.id);
      if(mesh){
        mesh.position.set(body.position.x, body.position.y, 0);
        mesh.rotation.z = body.angle;
      }
      const label=labelById.get(body.id);
      if(label){
        label.position.set(body.position.x, body.position.y + BALL_RADIUS*2.2, 0);
      }
    });
  }

  // --- Spawning ---
  async function spawnBallSet({ username, avatarUrl }){
    const multi=Math.max(1, Math.min(5, Number(optMultiDrop.value||1)));
    for(let i=0;i<multi;i++) spawnSingle({ username, avatarUrl });
  }

  function spawnSingle({ username, avatarUrl }){
    const jitter = PEG_SPACING * 0.35;
    const dropX = Math.max(-BOARD_WIDTH/2+4, Math.min(BOARD_WIDTH/2-4, (Math.random()-0.5)*jitter));
    const dropY = TOP_ROW_Y + PEG_SPACING * 0.8;

    const body = Bodies.circle(dropX, dropY, BALL_RADIUS, {
      restitution: BALL_RESTITUTION,
      friction: BALL_FRICTION,
      frictionAir: BALL_FRICTION_AIR,
      density: 0.0018
    });
    body.label = `BALL_${username}`;
    body.plugin = { username, avatarUrl, scored:false };
    World.add(world, body);
    dynamicBodies.add(body);
    Body.setVelocity(body,{x:0,y:0});
    Body.setAngularVelocity(body,0);

    if(!sharedBallBaseMaterial){
      sharedBallBaseMaterial = new THREE.MeshPhysicalMaterial({
        color:0xffffff,
        metalness:0.2,
        roughness:0.6,
        clearcoat:0.7,
        clearcoatRoughness:0.25,
        emissive: NEON ? new THREE.Color(0x00c6ff) : new THREE.Color(0x000000),
        emissiveIntensity: NEON ? 0.04 : 0.0
      });
    }
    const mat = sharedBallBaseMaterial.clone();
    const mesh = new THREE.Mesh(sharedBallGeo, mat);
    scene.add(mesh);
    meshById.set(body.id, mesh);

    const nameSprite=buildNameSprite(username);
    scene.add(nameSprite);
    labelById.set(body.id, nameSprite);

    // Async avatar texture (defer so spawn is instant)
    const applyTex = async () => {
      try{
        let prom = avatarTextureCache.get(avatarUrl||'');
        if(!prom){
          prom = loadAvatarTexture(avatarUrl, 128);
          avatarTextureCache.set(avatarUrl||'', prom);
        }
        const tex = await prom;
        const live = meshById.get(body.id);
        if(live && live.material){
          live.material.map = tex;
          live.material.needsUpdate = true;
        }
      }catch{}
    };
    if ('requestIdleCallback' in window){
      requestIdleCallback(applyTex, { timeout: 600 });
    } else {
      setTimeout(applyTex, 0);
    }

    sfxDrop();
  }

  function tryRemoveBall(body){
    try{
      const mesh=meshById.get(body.id);
      if(mesh){
        scene.remove(mesh);
        mesh.geometry.dispose(); // shared geometry? (we used sharedBallGeo) -> keep. So omit disposing geometry
        // Only dispose material clone
        if(mesh.material?.map) mesh.material.map.dispose();
        mesh.material?.dispose();
      }
      const lbl=labelById.get(body.id);
      if(lbl){
        scene.remove(lbl);
        if(lbl.material?.map) lbl.material.map.dispose();
        lbl.material?.dispose();
      }
      meshById.delete(body.id);
      labelById.delete(body.id);
      dynamicBodies.delete(body);
      World.remove(world, body);
      const u=body.plugin?.username;
      if(u) ballCountForUser.set(u, Math.max(0,(ballCountForUser.get(u)||1)-1));
    }catch{}
  }

  async function awardPoints(username, avatarUrl, points){
    const current=leaderboard[username] || { username, avatarUrl, score:0 };
    const nextScore=(current.score||0)+points;
    leaderboard[username]={ username, avatarUrl, score:nextScore, lastUpdate:Date.now() };
    refreshLeaderboard();
    try{
      await FirebaseREST.update(`/leaderboard/${encodeKey(username)}`, {
        username, avatarUrl:avatarUrl||'', score:nextScore, lastUpdate:Date.now()
      });
    }catch(e){ console.warn('Leaderboard write failed', e); }
  }

  function refreshLeaderboard(){
    const entries=Object.values(leaderboard).sort((a,b)=>b.score-a.score).slice(0,50);
    leaderboardList.innerHTML='';
    for(const e of entries){
      const li=document.createElement('li'); li.className='lb-item';
      const ava=document.createElement('div'); ava.className='lb-ava';
      if(e.avatarUrl) ava.style.backgroundImage=`url(${e.avatarUrl})`;
      const name=document.createElement('div'); name.className='lb-name'; name.textContent='@'+(e.username||'viewer');
      const score=document.createElement('div'); score.className='lb-score'; score.textContent=e.score.toLocaleString();
      li.appendChild(ava); li.appendChild(name); li.appendChild(score);
      leaderboardList.appendChild(li);
    }
  }
  function clearLeaderboardLocal(){
    for(const k of Object.keys(leaderboard)) delete leaderboard[k];
    leaderboardList.innerHTML='';
  }

  // --- Firebase Listeners ---
  function listenToEvents(){
    FirebaseREST.onChildAdded('/events',(id,obj)=>{
      if(!obj || typeof obj!=='object' || processedEvents.has(id)) return;
      const ts = typeof obj.timestamp==='number'?obj.timestamp:0;
      if(ts && ts < startTime - 60_000) return;
      processedEvents.add(id);
      const username = sanitizeUsername(obj.username||'viewer');
      const avatarUrl = obj.avatarUrl||'';
      const command = (obj.command||'').toLowerCase();
      if(command.includes('drop') || command.startsWith('gift')) spawnBallSet({ username, avatarUrl });
    });

    FirebaseREST.onValue('/leaderboard',(data)=>{
      if(data && typeof data==='object' && Object.keys(data).length){
        for(const k of Object.keys(data)){
          const entry=data[k];
          if(entry?.username){
            leaderboard[entry.username]={
              username:entry.username,
              avatarUrl:entry.avatarUrl||'',
              score:entry.score||0,
              lastUpdate:entry.lastUpdate||0
            };
          }
        }
        refreshLeaderboard();
      } else {
        clearLeaderboardLocal();
      }
    });

    FirebaseREST.onValue('/config',(data)=>{
      const enabled=!!(data && data.spawnEnabled);
      spawnStatusEl.textContent= enabled ? 'true':'false';
      spawnStatusEl.style.color= enabled ? 'var(--good)' : 'var(--danger)';
    });
  }

  function sanitizeUsername(u){
    const s=String(u||'').trim();
    return s ? s.slice(0,24) : 'viewer';
  }
  function encodeKey(k){ return encodeURIComponent(k.replace(/[.#$[\]]/g,'_')); }

  // --- UI Events & Audio Unlock ---
  btnGear.addEventListener('click', showSettings);
  btnCloseSettings.addEventListener('click', hideSettings);

  let audioBound=false;
  function bindAudioUnlockOnce(){
    if(audioBound) return;
    audioBound=true;
    const unlock=async()=>{
      await initAudioOnce();
      window.removeEventListener('pointerdown',unlock,true);
      window.removeEventListener('keydown',unlock,true);
    };
    window.addEventListener('pointerdown',unlock,true);
    window.addEventListener('keydown',unlock,true);
  }
  bindAudioUnlockOnce();

  optDropSpeed.addEventListener('input', applySettings);
  optGravity.addEventListener('input', applySettings);
  optMultiDrop.addEventListener('input', applySettings);
  optNeon.addEventListener('change', applySettings);
  optParticles.addEventListener('change', applySettings);
  optVolume.addEventListener('input', e=>setAudioVolume(Number(e.target.value)));

  btnSaveAdmin.addEventListener('click',()=>{
    try{
      const baseUrl=backendUrlInput.value.trim();
      const token=adminTokenInput.value.trim();
      setBackendBaseUrl(baseUrl);
      if(token) localStorage.setItem('adminToken', token);
      else localStorage.removeItem('adminToken');
      alert('Saved admin settings.');
    }catch{ alert('Save failed.'); }
  });

  btnReset.addEventListener('click', async ()=>{
    const token=adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if(!token) return alert('Provide admin token.');
    try{
      const res=await adminFetch('/admin/reset-leaderboard',{ method:'POST', headers:{'x-admin-token': token} });
      if(!res.ok) throw new Error();
      clearLeaderboardLocal();
      alert('Leaderboard reset.');
    }catch{ alert('Reset failed.'); }
  });

  btnToggleSpawn.addEventListener('click', async ()=>{
    const token=adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if(!token) return alert('Provide admin token.');
    try{
      const curr=spawnStatusEl.textContent==='true';
      const res=await adminFetch(`/admin/spawn-toggle?enabled=${!curr}`, { method:'POST', headers:{'x-admin-token': token} });
      if(!res.ok) throw new Error();
      alert(`Spawn set to ${!curr}`);
    }catch{ alert('Toggle failed.'); }
  });

  btnSimulate.addEventListener('click', async ()=>{
    try{
      const name='LocalTester'+Math.floor(Math.random()*1000);
      const res=await adminFetch('/admin/spawn',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ username:name, avatarUrl:'', command:'!drop' })
      });
      if(!res.ok) throw new Error();
      alert('Simulated drop sent.');
    }catch{ alert('Simulation failed.'); }
  });

  // --- Init ---
  function start(){
    loadSettings();
    initThree();
    initMatter();
    listenToEvents();
    startLoop();
  }
  start();
})();