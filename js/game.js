/* game.js (Syntax fix + commands panel visibility hardening)
   Fixes:
   - Removed stray / duplicated closing braces that caused SyntaxError.
   - Wrapped code in a single IIFE and ensured one final closing "})();".
   - Added null guards for DOM refs before adding listeners.
   - Added safeForceCommandsVisible() call after initial layout & after resize.
   - Admin form wrapper added in index.html to silence password field console warning.
*/

import * as THREE from 'three';
import {
  loadAvatarTexture, buildNameSprite, worldToScreen,
  FXManager2D, initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore
} from './utils.js';
import { ensureRewardModelLoaded, createRewardModelInstance, animateRewardModel } from './rewardModel.js';
import {
  initPBRTeasers, updateTeaserLayout, raycastTeasers,
  createRedemptionCrate, animateCrateEntrance, openCrate,
  disposeRedemptionCrate, setTeaserScale
} from './pbrRewards.js';

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

const { Engine, World, Bodies, Events, Body } = Matter;

(() => {
/* ---------------- Config / constants ---------------- */
const REWARD_COSTS = { t1:1000, t2:5000, t3:10000 };
const REWARD_NAMES = { t1:'Tier 1', t2:'Tier 2', t3:'Tier 3' };
const REDEEM_PREFIX = 'redeem:';
const DEV_BYPASS_DEFAULT = true;
const SHOW_PERF_PANEL = true;
const ADAPTIVE_QUALITY = true;
const FIXED_DT = 1000/60;
const MAX_STEPS_BASE = 4;
function maxStepsForFrame(dt){ return dt > 140 ? 1 : dt > 90 ? 2 : MAX_STEPS_BASE; }

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

let GRAVITY_MAG = 1.0;
let DROP_SPEED   = 0.5;
let NEON = true;
let PARTICLES = true;
let CRATE_SCALE = 4.4;
let VIBRANCE_PULSE = 0.4;

const BALL_RESTITUTION = 0.06;
const PEG_RESTITUTION  = 0.02;
const BALL_FRICTION    = 0.04;
const BALL_FRICTION_AIR= 0.012;
const MAX_SPEED = 28;
const MAX_H_SPEED = 22;

/* ---------------- State ---------------- */
let engine, world;
let scene, camera, renderer;
let ambient, dirLight;
let composer, bloomPass, smaaPass;
let fxMgr;
let slotSensors = [];
const dynamicBodies = new Set();
const meshById = new Map();
const labelById = new Map();
const leaderboard = {};
const processedEvents = new Set();
const processedRedemptions = new Set();
let SLOT_POINTS = [];
let SLOT_MULTIPLIERS = [];
let TOP_ROW_Y = 0;
const startTime = Date.now();

/* ---------------- DOM refs ---------------- */
const container       = document.getElementById('game-container');
const fxCanvas        = document.getElementById('fx-canvas');
const fxCtx           = fxCanvas?.getContext('2d');
const slotLabelsEl    = document.getElementById('slot-labels');
const trayDividers    = document.getElementById('tray-dividers');
const leaderboardList = document.getElementById('leaderboard-list');
const spawnStatusEl   = document.getElementById('spawn-status');
const redeemLayer     = document.getElementById('redeem-layer');
const devPanel        = document.getElementById('dev-panel');
const devFreeToggle   = document.getElementById('dev-free-toggle');
const commandsPanel   = document.getElementById('commands-panel');
const settingsPanel   = document.getElementById('settings-panel');
const btnGear         = document.getElementById('btn-gear');
const btnCloseSettings= document.getElementById('btn-close-settings');
const btnResetUI      = document.getElementById('btn-reset-ui');
const btnShowCommands = document.getElementById('btn-show-commands');
const btnHideCommands = document.getElementById('btn-hide-commands');
const btnForceCommands= document.getElementById('btn-force-commands');
const btnPanicCommands= document.getElementById('btn-panic-commands');

const optDropSpeed    = document.getElementById('opt-drop-speed');
const optGravity      = document.getElementById('opt-gravity');
const optMultiDrop    = document.getElementById('opt-multidrop');
const optCrateScale   = document.getElementById('opt-crate-scale');
const optNeon         = document.getElementById('opt-neon');
const optParticles    = document.getElementById('opt-particles');
const optVibrance     = document.getElementById('opt-vibrance');
const optVolume       = document.getElementById('opt-volume');
const adminTokenInput = document.getElementById('admin-token');
const backendUrlInput = document.getElementById('backend-url');
const btnSaveAdmin    = document.getElementById('btn-save-admin');
const btnReset        = document.getElementById('btn-reset-leaderboard');
const btnToggleSpawn  = document.getElementById('btn-toggle-spawn');
const btnSimulate     = document.getElementById('btn-simulate');

/* ---------------- Performance ---------------- */
let perfPanel;
const perfData={avgMs:0,worstMs:0,frames:0,qualityTier:2};
const BASE_DEVICE_PR = Math.min(window.devicePixelRatio||1, 1.75);
let currentPR = Math.min(BASE_DEVICE_PR, 1.5);
let frameSamples=0, frameAccum=0;

/* ---------------- Shared resources ---------------- */
const sharedBallGeo = new THREE.SphereGeometry(BALL_RADIUS,20,14);
let sharedBallBaseMaterial = null;
const avatarTextureCache = new Map();

/* ---------------- Redemption ---------------- */
const redeemQueue = [];
let redeemActive = false;
let activeReward3D = null;
let activeRewardDisposeFn = null;
let activeRedemptionCrate = null;

function enterRedemptionFocus(){
  document.body.classList.add('redeem-focus');
  setTimeout(()=>document.body.classList.remove('redeem-focus'),6000);
}
function exitRedemptionFocus(){
  document.body.classList.remove('redeem-focus');
}

/* ---------------- Commands panel helpers ---------------- */
function safeForceCommandsVisible(hard=false){
  if(!commandsPanel) return;
  commandsPanel.classList.remove('hidden-soft');
  commandsPanel.style.display='block';
  commandsPanel.style.visibility='visible';
  commandsPanel.style.opacity='1';
  commandsPanel.classList.add('force-front');
  if(hard){
    commandsPanel.dataset.x='';
    commandsPanel.dataset.y='';
    commandsPanel.dataset.scale='1';
    commandsPanel.style.position='fixed';
    commandsPanel.style.left='50%';
    commandsPanel.style.top='50%';
    commandsPanel.style.transform='translate(-50%, -50%) scale(1)';
  }else if(commandsPanel.style.position!=='fixed'){
    const x=parseFloat(commandsPanel.dataset.x||'0');
    const y=parseFloat(commandsPanel.dataset.y||'0');
    const s=parseFloat(commandsPanel.dataset.scale||'1');
    commandsPanel.style.transform=`translate(${x}px,${y}px) scale(${s})`;
  }
}
function toggleCommands(){
  if(!commandsPanel) return;
  if(commandsPanel.classList.contains('hidden-soft')) safeForceCommandsVisible(true);
  else commandsPanel.classList.add('hidden-soft');
}

/* ---------------- Slots ---------------- */
function buildSlots(slotCount){
  const center=Math.floor((slotCount-1)/2);
  const mult=d=>d===0?16:d===1?9:d===2?5:d===3?3:1;
  SLOT_MULTIPLIERS=Array.from({length:slotCount},(_,i)=>mult(Math.abs(i-center)));
  SLOT_POINTS=SLOT_MULTIPLIERS.map(m=>m*100);
}
function classForMultiplier(m){
  if(m>=16)return'mult-top'; if(m>=9)return'mult-high'; if(m>=5)return'mult-mid'; if(m>=3)return'mult-low'; return'mult-base';
}
function renderSlotLabels(slotCount, framePx){
  if(!slotLabelsEl) return;
  slotLabelsEl.innerHTML='';
  SLOT_MULTIPLIERS.forEach(m=>{
    const div=document.createElement('div');
    div.className='slot-label '+classForMultiplier(m);
    div.innerHTML=`<span class="x">x</span><span class="val">${m}</span>`;
    slotLabelsEl.appendChild(div);
  });
  if(trayDividers) trayDividers.style.setProperty('--slot-width', `${framePx.width/slotCount}px`);
}

/* ---------------- Backend helpers ---------------- */
function getBackendBaseUrl(){ return (localStorage.getItem('backendBaseUrl')||'').trim(); }
function setBackendBaseUrl(url){
  const clean=String(url||'').trim().replace(/\/+$/,'');
  if(clean) localStorage.setItem('backendBaseUrl',clean); else localStorage.removeItem('backendBaseUrl');
}
function adminFetch(path,opt={}){
  const base=getBackendBaseUrl();
  if(!base) throw new Error('Backend URL not set.');
  return fetch(`${base}${path.startsWith('/')?'':'/'}${path}`,opt);
}

/* ---------------- Settings load/save ---------------- */
devFreeToggle && (devFreeToggle.checked = (localStorage.getItem('plk_dev_free') ?? (DEV_BYPASS_DEFAULT?'true':'false'))==='true');
devFreeToggle?.addEventListener('change',()=>localStorage.setItem('plk_dev_free',devFreeToggle.checked?'true':'false'));

function loadSettings(){
  const g=Number(localStorage.getItem('plk_gravity') ?? '1'); if(!Number.isNaN(g) && optGravity) optGravity.value=g;
  const ds=Number(localStorage.getItem('plk_dropSpeed') ?? '0.5'); if(!Number.isNaN(ds) && optDropSpeed) optDropSpeed.value=ds;
  const md=Number(localStorage.getItem('plk_multiDrop') ?? '1'); if(!Number.isNaN(md) && optMultiDrop) optMultiDrop.value=md;
  const cs=Number(localStorage.getItem('plk_crate_scale') ?? '4.4'); if(!Number.isNaN(cs) && optCrateScale){ optCrateScale.value=cs; CRATE_SCALE=cs; }
  const vb=Number(localStorage.getItem('plk_vibrance') ?? '0.4'); if(!Number.isNaN(vb) && optVibrance){ optVibrance.value=vb; VIBRANCE_PULSE=vb; }
  if(optNeon) optNeon.checked=(localStorage.getItem('plk_neon') ?? 'true')==='true';
  if(optParticles) optParticles.checked=(localStorage.getItem('plk_particles') ?? 'true')==='true';
  const vol=Number(localStorage.getItem('plk_volume') ?? '0.5'); if(optVolume) { optVolume.value=vol; setAudioVolume(vol); }
  const savedBase=getBackendBaseUrl(); if(savedBase && backendUrlInput) backendUrlInput.value=savedBase;
  const tok=localStorage.getItem('adminToken')||''; if(tok && adminTokenInput) adminTokenInput.value=tok;
  applySettings();
}

function applySettings(){
  DROP_SPEED=Number(optDropSpeed?.value ?? DROP_SPEED);
  GRAVITY_MAG=Number(optGravity?.value ?? GRAVITY_MAG);
  NEON=!!optNeon?.checked;
  PARTICLES=!!optParticles?.checked;
  CRATE_SCALE=Number(optCrateScale?.value ?? CRATE_SCALE);
  VIBRANCE_PULSE=Number(optVibrance?.value ?? VIBRANCE_PULSE);
  localStorage.setItem('plk_dropSpeed',String(DROP_SPEED));
  localStorage.setItem('plk_gravity',String(GRAVITY_MAG));
  localStorage.setItem('plk_multiDrop',String(optMultiDrop?.value ?? '1'));
  localStorage.setItem('plk_crate_scale',String(CRATE_SCALE));
  localStorage.setItem('plk_neon',String(NEON));
  localStorage.setItem('plk_particles',String(PARTICLES));
  localStorage.setItem('plk_vibrance',String(VIBRANCE_PULSE));
  if(world) world.gravity.y=-Math.abs(GRAVITY_MAG);
  setTeaserScale(CRATE_SCALE);
  if(bloomPass){
    bloomPass.enabled=NEON;
    bloomPass.strength=NEON?0.6:0;
  }
}

/* ---------------- Three.js init ---------------- */
let pegsInstanced;
let baseCamPos=new THREE.Vector3(0,0,100);
let targetCamOffset=new THREE.Vector3();

function initThree(){
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.22;
  renderer.setPixelRatio(currentPR);
  renderer.setSize(container.clientWidth,container.clientHeight);
  renderer.setClearColor(0x000000,0);
  container.appendChild(renderer.domElement);

  scene=new THREE.Scene();
  computeWorldSize();
  camera=new THREE.OrthographicCamera(-WORLD_WIDTH/2,WORLD_WIDTH/2,WORLD_HEIGHT/2,-WORLD_HEIGHT/2,0.1,300);
  camera.position.copy(baseCamPos);

  ambient=new THREE.AmbientLight(0xffffff,1.0);
  dirLight=new THREE.DirectionalLight(0xffffff,1.05);
  dirLight.position.set(-18,30,60);
  scene.add(ambient,dirLight);

  composer=new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene,camera));
  smaaPass=new SMAAPass(renderer.domElement.width,renderer.domElement.height);
  composer.addPass(smaaPass);
  bloomPass=new UnrealBloomPass(new THREE.Vector2(renderer.domElement.width,renderer.domElement.height),0.6,0.5,0.25);
  composer.addPass(bloomPass);

  const ro=new ResizeObserver(onResize); ro.observe(container);
  onResize();

  if(SHOW_PERF_PANEL){
    perfPanel=document.createElement('div');
    perfPanel.id='perf-panel';
    perfPanel.textContent='Perf';
    document.body.appendChild(perfPanel);
  }

  const rectTarget={w:0,h:0};
  function updateRect(){ const r=renderer.domElement.getBoundingClientRect(); rectTarget.w=r.width; rectTarget.h=r.height; }
  updateRect();
  window.addEventListener('resize',updateRect,{passive:true});
  renderer.domElement.addEventListener('pointermove',e=>{
    const xNorm=(e.clientX/rectTarget.w)*2 - 1;
    const yNorm=(e.clientY/rectTarget.h)*2 - 1;
    targetCamOffset.x = xNorm * 2.5;
    targetCamOffset.y = yNorm * 1.8;
  },{passive:true});

  const raycaster=new THREE.Raycaster();
  const pt=new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown',e=>{
    const rect=renderer.domElement.getBoundingClientRect();
    pt.x=((e.clientX-rect.left)/rect.width)*2 -1;
    pt.y=-((e.clientY-rect.top)/rect.height)*2 +1;
    raycaster.setFromCamera(pt,camera);
    raycastTeasers(raycaster);
  });
}

function computeWorldSize(){
  const w=container.clientWidth||1;
  const h=container.clientHeight||1;
  const aspect=w/h;
  WORLD_WIDTH=WORLD_HEIGHT*aspect;
  BOARD_HEIGHT=WORLD_HEIGHT*0.82;
  BOARD_WIDTH=Math.min(WORLD_WIDTH*0.88, BOARD_HEIGHT*0.9);
  PEG_SPACING=BOARD_WIDTH/(ROWS+1);
  TRAY_HEIGHT=BOARD_HEIGHT*TRAY_RATIO;
}

function onResize(){
  renderer.setSize(container.clientWidth,container.clientHeight);
  composer.setSize(container.clientWidth,container.clientHeight);
  smaaPass.setSize(container.clientWidth,container.clientHeight);
  bloomPass.setSize(container.clientWidth,container.clientHeight);
  computeWorldSize();
  camera.left=-WORLD_WIDTH/2;
  camera.right=WORLD_WIDTH/2;
  camera.top=WORLD_HEIGHT/2;
  camera.bottom=-WORLD_HEIGHT/2;
  camera.updateProjectionMatrix();
  fxCanvas.width=container.clientWidth;
  fxCanvas.height=container.clientHeight;
  layoutOverlays();
  updateTeaserLayout();
  ensureVisiblePanels();
  safeForceCommandsVisible(); // reassert
}

/* ---------------- Overlay layout ---------------- */
function layoutOverlays(){
  const left=-BOARD_WIDTH/2,right=BOARD_WIDTH/2;
  const top=BOARD_HEIGHT/2,bottom=-BOARD_HEIGHT/2;
  const trayTop=bottom+TRAY_HEIGHT;
  const pTopLeft=worldToScreen(new THREE.Vector3(left,top,0),camera,renderer);
  const pBottomRight=worldToScreen(new THREE.Vector3(right,bottom,0),camera,renderer);
  const pTrayTopLeft=worldToScreen(new THREE.Vector3(left,trayTop,0),camera,renderer);
  const frame={x:Math.round(pTopLeft.x),y:Math.round(pTopLeft.y),width:Math.round(pBottomRight.x-pTopLeft.x),height:Math.round(pBottomRight.y-pTopLeft.y)};
  const tray={x:frame.x,width:frame.width,height:Math.round(pBottomRight.y-pTrayTopLeft.y),top:Math.round(pTrayTopLeft.y)};
  const boardFrame=document.getElementById('board-frame');
  const slotTray=document.getElementById('slot-tray');
  const boardDivider=document.getElementById('board-divider');
  const boardTitle=document.getElementById('board-title');
  if(boardFrame) Object.assign(boardFrame.style,{left:frame.x+'px',top:frame.y+'px',width:frame.width+'px',height:frame.height+'px'});
  if(slotTray) Object.assign(slotTray.style,{left:tray.x+'px',top:tray.top+'px',width:tray.width+'px',height:tray.height+'px'});
  if(boardDivider){ boardDivider.style.left=frame.x+'px'; boardDivider.style.width=frame.width+'px'; boardDivider.style.top=(pTrayTopLeft.y-1)+'px'; boardDivider.style.display='block'; }
  if(boardTitle){ boardTitle.style.left=(frame.x+22)+'px'; boardTitle.style.top =(frame.y+18)+'px'; }
  const slotCount=ROWS+1;
  buildSlots(slotCount);
  renderSlotLabels(slotCount, frame);
}

/* ---------------- Matter init ---------------- */
function initMatter(){
  engine=Engine.create({enableSleeping:false});
  world=engine.world;
  world.gravity.y=-Math.abs(GRAVITY_MAG);
  buildBoard();
  bindCollisions();
  fxMgr=new FXManager2D(fxCanvas);
}

function buildBoard(){
  const left=Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2,0,WALL_THICKNESS,BOARD_HEIGHT,{isStatic:true});
  const right=Bodies.rectangle( BOARD_WIDTH/2 + WALL_THICKNESS/2,0,WALL_THICKNESS,BOARD_HEIGHT,{isStatic:true});
  const floor=Bodies.rectangle(0,-BOARD_HEIGHT/2 - 6,BOARD_WIDTH + WALL_THICKNESS*2,WALL_THICKNESS,{isStatic:true,label:'KILL'});
  World.add(world,[left,right,floor]);
  const startY=BOARD_HEIGHT/2 - 10;
  TOP_ROW_Y=startY;
  const rowH=PEG_SPACING*0.9;
  const startX=-((ROWS-1)*PEG_SPACING)/2;
  const pegPositions=[];
  for(let r=0;r<ROWS;r++){
    const y=startY - r*rowH;
    for(let c=0;c<=r;c++){
      const x=startX + c*PEG_SPACING + (ROWS-1-r)*(PEG_SPACING/2);
      const peg=Bodies.circle(x,y,PEG_RADIUS,{isStatic:true,restitution:PEG_RESTITUTION,friction:0.01});
      peg.label='PEG';
      World.add(world,peg);
      pegPositions.push({x,y});
    }
  }
  addPegInstancedMesh(pegPositions);
  slotSensors=[];
  const slotCount=ROWS+1;
  const slotWidth=BOARD_WIDTH/slotCount;
  const slotY=-BOARD_HEIGHT/2 + (TRAY_HEIGHT*0.35);
  for(let i=0;i<slotCount;i++){
    const x=-BOARD_WIDTH/2 + slotWidth*(i+0.5);
    const sensor=Bodies.rectangle(x,slotY,slotWidth,2.6,{isStatic:true,isSensor:true});
    sensor.label=`SLOT_${i}`;
    World.add(world,sensor);
    slotSensors.push({body:sensor,index:i});
  }
}

function addPegInstancedMesh(pegPositions){
  if(pegsInstanced){
    scene.remove(pegsInstanced);
    pegsInstanced.geometry.dispose();
    pegsInstanced.material.dispose();
  }
  const geo=new THREE.CylinderGeometry(PEG_RADIUS,PEG_RADIUS,1.2,16);
  const mat=new THREE.MeshPhysicalMaterial({
    color:0x86f7ff,metalness:0.25,roughness:0.55,
    clearcoat:0.25,clearcoatRoughness:0.6,
    emissive:new THREE.Color(0x00ffff),
    emissiveIntensity:0.18
  });
  const inst=new THREE.InstancedMesh(geo,mat,pegPositions.length);
  const m=new THREE.Matrix4();
  const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2);
  for(let i=0;i<pegPositions.length;i++){
    const {x,y}=pegPositions[i];
    m.compose(new THREE.Vector3(x,y,0),q,new THREE.Vector3(1,1,1));
    inst.setMatrixAt(i,m);
  }
  inst.instanceMatrix.needsUpdate=true;
  pegsInstanced=inst;
  scene.add(inst);
}

function bindCollisions(){
  Events.on(engine,'collisionStart', ev=>{
    for(const {bodyA,bodyB} of ev.pairs){
      handlePair(bodyA,bodyB);
      handlePair(bodyB,bodyA);
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
      const points=SLOT_POINTS[idx]||100;
      ball.plugin.scored=true;
      awardPoints(ball.plugin.username, ball.plugin.avatarUrl||'', points).catch(console.warn);
      sfxScore(points >= 1600);
      setTimeout(()=>tryRemoveBall(ball),900);
    }
    return;
  }
  if(b.label==='PEG' && String(a.label||'').startsWith('BALL_')){
    if(PARTICLES){
      const mesh=meshById.get(a.id);
      if(mesh){
        const p2=worldToScreen(mesh.position,camera,renderer);
        fxMgr.addSparks(p2.x,p2.y,'#00f2ea',10);
      }
    }
    sfxBounce();
  }
  if(b.label==='KILL' && String(a.label||'').startsWith('BALL_')) tryRemoveBall(a);
}

/* ---------------- Performance loop ---------------- */
function adaptQuality(frameMs){
  frameAccum+=frameMs;
  frameSamples++;
  perfData.frames++;
  perfData.avgMs=perfData.avgMs?perfData.avgMs*0.9+frameMs*0.1:frameMs;
  if(frameMs>perfData.worstMs) perfData.worstMs=frameMs;
  if(frameSamples>=60){
    const avg=frameAccum/frameSamples;
    if(avg>22 && currentPR>0.75){
      currentPR=Math.max(0.75,currentPR-0.1);
      renderer.setPixelRatio(currentPR);
    } else if(avg<15 && currentPR<BASE_DEVICE_PR){
      currentPR=Math.min(BASE_DEVICE_PR,currentPR+0.1);
      renderer.setPixelRatio(currentPR);
    }
    frameAccum=0; frameSamples=0;
  }
  if(!ADAPTIVE_QUALITY) return;
  const avg=perfData.avgMs;
  let target=2;
  if(avg>30) target=0; else if(avg>23) target=1;
  if(target!==perfData.qualityTier){
    perfData.qualityTier=target;
    if(target===2){ bloomPass.enabled=NEON; bloomPass.strength=0.6; smaaPass.enabled=true; }
    else if(target===1){ bloomPass.enabled=NEON; bloomPass.strength=0.38; smaaPass.enabled=true; }
    else { bloomPass.enabled=false; bloomPass.strength=0; smaaPass.enabled=false; }
  }
  if(perfPanel && perfData.frames%30===0){
    perfPanel.textContent=`fps:${(1000/perfData.avgMs).toFixed(1)} ms:${perfData.avgMs.toFixed(1)} pR:${currentPR.toFixed(2)} worst:${perfData.worstMs.toFixed(1)} q:${perfData.qualityTier}`;
  }
}

let vibranceTime=0;
function startLoop(){
  let last=performance.now(), acc=0;
  function tick(now){
    const dt=Math.min(250,now-last); last=now; acc+=dt;
    let steps=0;
    while(acc>=FIXED_DT && steps<maxStepsForFrame(dt)){
      Engine.update(engine,FIXED_DT);
      acc-=FIXED_DT; steps++;
    }
    clampVelocities();
    fxMgr.update(fxCtx,dt);
    updateThreeFromMatter();
    camera.position.x += (0 + targetCamOffset.x - camera.position.x)*0.06;
    camera.position.y += (0 + targetCamOffset.y - camera.position.y)*0.06;
    if(NEON){
      vibranceTime += dt*0.001;
      const pulse = 1 + Math.sin(vibranceTime*2.1)*0.14*VIBRANCE_PULSE;
      bloomPass.strength = (perfData.qualityTier===0?0.32:0.5)*pulse + (NEON?0.08:0);
      renderer.toneMappingExposure = 1.15 * (1 + 0.07*VIBRANCE_PULSE*Math.sin(vibranceTime*1.4+1));
    }
    const t0=performance.now();
    (bloomPass.enabled || smaaPass.enabled)?composer.render():renderer.render(scene,camera);
    adaptQuality(dt + (performance.now()-t0));
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function clampVelocities(){
  for(const b of dynamicBodies){
    let {x,y}=b.velocity;
    if(Math.abs(x)>MAX_H_SPEED) x=Math.sign(x)*MAX_H_SPEED;
    const speed=Math.hypot(x,y);
    if(speed>MAX_SPEED){
      const k=MAX_SPEED/speed; x*=k; y*=k;
    }
    Body.setVelocity(b,{x,y});
  }
}

function updateThreeFromMatter(){
  dynamicBodies.forEach(body=>{
    const mesh=meshById.get(body.id);
    if(mesh){
      mesh.position.set(body.position.x,body.position.y,0);
      mesh.rotation.z=body.angle;
    }
    const label=labelById.get(body.id);
    if(label) label.position.set(body.position.x,body.position.y + BALL_RADIUS*2.2,0);
  });
}

/* ---------------- Spawning ---------------- */
function spawnBallSet({username,avatarUrl}){
  const multi=Math.max(1,Math.min(5,Number(optMultiDrop?.value||1)));
  for(let i=0;i<multi;i++) spawnSingle({username,avatarUrl});
}
function spawnSingle({username,avatarUrl}){
  const jitter=PEG_SPACING*0.35;
  const dropX=Math.max(-BOARD_WIDTH/2+4,Math.min(BOARD_WIDTH/2-4,(Math.random()-0.5)*jitter));
  const dropY=TOP_ROW_Y + PEG_SPACING*0.8;
  const body=Bodies.circle(dropX,dropY,BALL_RADIUS,{restitution:BALL_RESTITUTION,friction:BALL_FRICTION,frictionAir:BALL_FRICTION_AIR,density:0.0018});
  body.label=`BALL_${username}`;
  body.plugin={username,avatarUrl,scored:false};
  World.add(world,body);
  dynamicBodies.add(body);
  Body.setVelocity(body,{x:0,y:0});
  Body.setAngularVelocity(body,0);
  if(!sharedBallBaseMaterial){
    sharedBallBaseMaterial=new THREE.MeshPhysicalMaterial({
      color:0xffffff,metalness:0.25,roughness:0.5,
      clearcoat:0.7,clearcoatRoughness:0.25,
      emissive:NEON?new THREE.Color(0x00b8e8):new THREE.Color(0x000000),
      emissiveIntensity:NEON?0.04:0
    });
  }
  const mat=sharedBallBaseMaterial.clone();
  const mesh=new THREE.Mesh(sharedBallGeo,mat);
  scene.add(mesh);
  meshById.set(body.id,mesh);
  const sprite=buildNameSprite(username);
  scene.add(sprite);
  labelById.set(body.id,sprite);
  const applyTex=async()=>{
    try{
      let prom=avatarTextureCache.get(avatarUrl||'');
      if(!prom){ prom=loadAvatarTexture(avatarUrl,128); avatarTextureCache.set(avatarUrl||'',prom); }
      const tex=await prom;
      const live=meshById.get(body.id);
      if(live && live.material){
        live.material.map=tex;
        live.material.needsUpdate=true;
      }
    }catch{}
  };
  if('requestIdleCallback' in window) requestIdleCallback(applyTex,{timeout:600}); else setTimeout(applyTex,0);
  sfxDrop();
}

function tryRemoveBall(body){
  try{
    const mesh=meshById.get(body.id);
    if(mesh){
      scene.remove(mesh);
      mesh.material?.map?.dispose();
      mesh.material?.dispose();
    }
    const lbl=labelById.get(body.id);
    if(lbl){
      scene.remove(lbl);
      lbl.material?.map?.dispose();
      lbl.material?.dispose();
    }
    meshById.delete(body.id);
    labelById.delete(body.id);
    dynamicBodies.delete(body);
    World.remove(world, body);
  }catch{}
}

/* ---------------- Leaderboard / points ---------------- */
async function awardPoints(username, avatarUrl, points){
  const current=leaderboard[username] || { username, avatarUrl, score:0 };
  const next=(current.score||0)+points;
  leaderboard[username]={ username, avatarUrl, score:next, lastUpdate:Date.now() };
  refreshLeaderboard();
  try{
    await FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g,'_'))}`, {
      username, avatarUrl: avatarUrl||'', score: next, lastUpdate: Date.now()
    });
  }catch{}
}

function setPointsLocal(username, avatarUrl, score){
  leaderboard[username]={ username, avatarUrl, score, lastUpdate:Date.now() };
  refreshLeaderboard();
}

function deductPoints(username, avatarUrl, points){
  const current=leaderboard[username] || { username, avatarUrl, score:0 };
  if((current.score||0) < points) return false;
  const next=current.score - points;
  leaderboard[username]={ username, avatarUrl, score: next, lastUpdate:Date.now() };
  refreshLeaderboard();
  FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g,'_'))}`, {
    username, avatarUrl: avatarUrl||'', score: next, lastUpdate: Date.now()
  }).catch(()=>{});
  return true;
}

function refreshLeaderboard(){
  if(!leaderboardList) return;
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
  if(leaderboardList) leaderboardList.innerHTML='';
}

/* ---------------- Redemption events ---------------- */
function handleRedeemEvent(eventId, username, avatarUrl, tier){
  if(processedRedemptions.has(eventId)) return;
  processedRedemptions.add(eventId);
  const cost=REWARD_COSTS[tier];
  if(!cost) return;
  if(devFreeToggle?.checked && (leaderboard[username]?.score||0) < cost){
    setPointsLocal(username, avatarUrl, cost);
  }
  if(!deductPoints(username, avatarUrl, cost)) return;
  enqueueRedemption(eventId, tier, username, avatarUrl);
}

/* ---------------- Firebase event listeners ---------------- */
function listenToEvents(){
  FirebaseREST.onChildAdded('/events',(id,obj)=>{
    if(!obj || typeof obj!=='object' || processedEvents.has(id)) return;
    const ts=typeof obj.timestamp==='number'?obj.timestamp:0;
    if(ts && ts < startTime - 60_000) return;
    processedEvents.add(id);
    const username=sanitizeUsername(obj.username||'viewer');
    const avatarUrl=obj.avatarUrl||'';
    const command=(obj.command||'').toLowerCase();
    if(command.startsWith(REDEEM_PREFIX)){
      handleRedeemEvent(id, username, avatarUrl, command.split(':')[1]);
      return;
    }
    if(command.includes('drop') || command.startsWith('gift')){
      spawnBallSet({ username, avatarUrl });
    }
  });
  FirebaseREST.onValue('/leaderboard',(data)=>{
    if(data && typeof data==='object'){
      for(const k of Object.keys(data)){
        const entry=data[k];
        if(entry?.username){
          leaderboard[entry.username]={
            username:entry.username,
            avatarUrl: entry.avatarUrl||'',
            score: entry.score||0,
            lastUpdate: entry.lastUpdate||0
          };
        }
      }
      refreshLeaderboard();
    } else clearLeaderboardLocal();
  });
  FirebaseREST.onValue('/config',(data)=>{
    if(!spawnStatusEl) return;
    const enabled=!!(data && data.spawnEnabled);
    spawnStatusEl.textContent=enabled?'true':'false';
    spawnStatusEl.style.color=enabled?'var(--good)':'var(--danger)';
  });
}

function sanitizeUsername(u){
  const s=String(u||'').trim();
  return s ? s.slice(0,24) : 'viewer';
}

/* ---------------- Teasers & dev ---------------- */
function initTeasers(){
  initPBRTeasers({
    scene,
    camera,
    renderer,
    gsap,
    onCrateClick:(tier)=>devRedeem(tier,'ClickUser'),
    initialScale: CRATE_SCALE
  });
}
function devRedeem(tier='t1', user='DevUser'){
  const id='dev_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  handleRedeemEvent(id,user,'',tier);
}
function devDrop(user='DevUser'){ spawnBallSet({ username:user, avatarUrl:'' }); }
window.devRedeem=devRedeem;
window.devDrop=devDrop;

function initDevPanel(){
  if(!devPanel) return;
  devPanel.querySelectorAll('button[data-act]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const act=btn.dataset.act;
      if(act==='drop') devDrop('DevDrop');
      else if(act.startsWith('redeem-')) devRedeem(act.split('-')[1],'DevUser');
    });
  });
}

function initGiftCards(){
  document.querySelectorAll('.gift-card').forEach(card=>{
    card.addEventListener('click',()=>{
      devDrop(card.dataset.gift || 'GiftUser');
    });
  });
}

/* ---------------- Drag / Scale ---------------- */
function initDraggables(){
  const overlay=document.getElementById('overlay');
  const panels=[...document.querySelectorAll('[data-drag][data-scale]')];
  panels.forEach(panel=>{
    preparePanel(panel, overlay);
    attachDrag(panel);
    attachScale(panel);
  });
  window.addEventListener('wheel', e=>{
    if(!e.altKey) return;
    const el=e.target.closest?.('[data-drag][data-scale]');
    if(!el) return;
    e.preventDefault();
    const key=storageKey(el,'scale');
    let s=parseFloat(localStorage.getItem(key) || '1');
    s += -Math.sign(e.deltaY)*0.08;
    s=Math.min(3.5,Math.max(0.4,s));
    el.dataset.scale=String(s);
    renderTransform(el);
    saveState(el);
  },{passive:false});
  setTimeout(()=>safeForceCommandsVisible(true),250);
  setTimeout(()=>safeForceCommandsVisible(),1200);
}

function computeDefaultPosition(panel, overlay){
  const oRect=overlay.getBoundingClientRect();
  const defaults={
    'commands-panel':{x:oRect.width-380,y:120},
    'leaderboard':{x:14,y:120},
    'reward-teasers':{x:oRect.width-380,y:14},
    'settings-panel':{x:oRect.width-400,y:80},
    'controls-panel':{x:oRect.width-300,y:14}
  };
  const d=defaults[panel.id];
  return d ? {left:d.x,top:d.y} : {left:40,top:80};
}
function preparePanel(panel, overlay){
  panel.style.position='absolute';
  if(!panel.querySelector('.resize-handle')){
    const h=document.createElement('div'); h.className='resize-handle'; h.textContent='↘'; panel.appendChild(h);
  }
  const posKey=storageKey(panel,'pos');
  const scaleKey=storageKey(panel,'scale');
  const posJSON=localStorage.getItem(posKey);
  const scaleStr=localStorage.getItem(scaleKey);
  let { left, top } = posJSON? JSON.parse(posJSON): computeDefaultPosition(panel, overlay);
  let scale = scaleStr? parseFloat(scaleStr): 1;
  panel.dataset.x=left; panel.dataset.y=top; panel.dataset.scale=scale;
  renderTransform(panel);
}
function attachDrag(panel){
  const handles=panel.querySelectorAll('.drag-bar,.cmd-title,.drag-handle');
  let dragging=false,startX=0,startY=0,startL=0,startT=0;
  (handles.length?handles:[panel]).forEach(h=>{
    h.style.cursor='grab';
    h.addEventListener('pointerdown',e=>{
      if(e.button!==0 || e.target.closest('.resize-handle')) return;
      dragging=true;
      startX=e.clientX; startY=e.clientY;
      startL=parseFloat(panel.dataset.x||'0');
      startT=parseFloat(panel.dataset.y||'0');
      panel.classList.add('dragging');
      e.preventDefault();
    });
  });
  window.addEventListener('pointermove',e=>{
    if(!dragging) return;
    const dx=e.clientX-startX, dy=e.clientY-startY;
    panel.dataset.x=startL+dx;
    panel.dataset.y=startT+dy;
    renderTransform(panel);
  });
  window.addEventListener('pointerup',()=>{
    if(!dragging) return;
    dragging=false;
    panel.classList.remove('dragging');
    saveState(panel);
    if(panel===commandsPanel) safeForceCommandsVisible();
  });
}
function attachScale(panel){
  const h=panel.querySelector('.resize-handle'); if(!h) return;
  let resizing=false,startX=0,startScale=1;
  h.addEventListener('pointerdown',e=>{
    e.preventDefault(); e.stopPropagation();
    resizing=true; startX=e.clientX;
    startScale=parseFloat(panel.dataset.scale||'1');
    panel.classList.add('dragging');
  });
  window.addEventListener('pointermove',e=>{
    if(!resizing) return;
    const dx=e.clientX-startX;
    let ns=startScale + dx/240;
    ns=Math.min(3.5,Math.max(0.4,ns));
    panel.dataset.scale=ns;
    renderTransform(panel);
  });
  window.addEventListener('pointerup',()=>{
    if(!resizing) return;
    resizing=false;
    panel.classList.remove('dragging');
    saveState(panel);
    if(panel===commandsPanel) safeForceCommandsVisible();
  });
}
function renderTransform(panel){
  if(panel.style.position==='fixed') return;
  const x=parseFloat(panel.dataset.x||'0');
  const y=parseFloat(panel.dataset.y||'0');
  const s=parseFloat(panel.dataset.scale||'1');
  panel.style.transform=`translate(${x}px,${y}px) scale(${s})`;
}
function saveState(panel){
  const posKey=storageKey(panel,'pos');
  const scaleKey=storageKey(panel,'scale');
  localStorage.setItem(posKey,JSON.stringify({left:parseFloat(panel.dataset.x||'0'),top:parseFloat(panel.dataset.y||'0')}));
  localStorage.setItem(scaleKey,String(panel.dataset.scale||'1'));
}
function storageKey(panel,suffix){ return `plk_${panel.id||'panel'}_${suffix}`; }

function ensureVisiblePanels(){
  const overlay=document.getElementById('overlay');
  if(!overlay) return;
  const oRect=overlay.getBoundingClientRect();
  document.querySelectorAll('[data-drag][data-scale]').forEach(panel=>{
    if(panel.style.position==='fixed') return;
    const prect=panel.getBoundingClientRect();
    let x=parseFloat(panel.dataset.x||'0');
    let y=parseFloat(panel.dataset.y||'0');
    let changed=false;
    if(prect.right < 20){ x=8; changed=true; }
    if(prect.bottom< 20){ y=8; changed=true; }
    if(prect.left  > oRect.width - 40){ x=oRect.width - prect.width - 16; changed=true; }
    if(prect.top   > oRect.height- 40){ y=oRect.height - prect.height - 16; changed=true; }
    if(changed){
      panel.dataset.x=x;
      panel.dataset.y=y;
      renderTransform(panel);
      saveState(panel);
    }
  });
  if(!commandsPanel) return;
  const r=commandsPanel.getBoundingClientRect();
  if(r.width===0 || r.height===0){
    safeForceCommandsVisible(true);
  }
}

/* ---------------- UI / Audio events ---------------- */
btnGear?.addEventListener('click', showSettings);
btnCloseSettings?.addEventListener('click', hideSettings);
btnShowCommands?.addEventListener('click', ()=>safeForceCommandsVisible(true));
btnHideCommands?.addEventListener('click', ()=>commandsPanel?.classList.add('hidden-soft'));
btnForceCommands?.addEventListener('click', ()=>safeForceCommandsVisible(true));
btnPanicCommands?.addEventListener('click', ()=>safeForceCommandsVisible(true));

window.addEventListener('keydown',e=>{
  if(e.key==='c' || e.key==='C') toggleCommands();
  if((e.ctrlKey||e.metaKey) && e.shiftKey && (e.key==='c' || e.key==='C')) safeForceCommandsVisible(true);
});

/* Reset UI */
btnResetUI?.addEventListener('click', ()=>{
  Object.keys(localStorage).filter(k=>k.startsWith('plk_')&&(k.endsWith('_pos')||k.endsWith('_scale'))).forEach(k=>localStorage.removeItem(k));
  document.querySelectorAll('[data-drag][data-scale]').forEach(p=>{
    p.dataset.x=''; p.dataset.y=''; p.dataset.scale='1';
    p.style.transform='';
    if(p!==commandsPanel) p.style.position='absolute';
  });
  safeForceCommandsVisible(true);
  ensureVisiblePanels();
  alert('UI panels reset & commands centered.');
});

/* Audio unlock */
let audioBound=false;
function bindAudioUnlockOnce(){
  if(audioBound) return;
  audioBound=true;
  const unlock=async()=>{
    await initAudioOnce().catch(()=>{});
    window.removeEventListener('pointerdown',unlock,true);
    window.removeEventListener('keydown',unlock,true);
  };
  window.addEventListener('pointerdown',unlock,true);
  window.addEventListener('keydown',unlock,true);
}
bindAudioUnlockOnce();

/* Settings listeners */
optDropSpeed?.addEventListener('input', applySettings);
optGravity?.addEventListener('input', applySettings);
optMultiDrop?.addEventListener('input', applySettings);
optCrateScale?.addEventListener('input', applySettings);
optNeon?.addEventListener('change', applySettings);
optParticles?.addEventListener('change', applySettings);
optVibrance?.addEventListener('input', applySettings);
optVolume?.addEventListener('input', e=>setAudioVolume(Number(e.target.value)));

btnSaveAdmin?.addEventListener('click',()=>{
  try{
    const baseUrl=backendUrlInput?.value.trim();
    const token=adminTokenInput?.value.trim();
    if(baseUrl) setBackendBaseUrl(baseUrl);
    token?localStorage.setItem('adminToken',token):localStorage.removeItem('adminToken');
    alert('Saved admin settings.');
  }catch{ alert('Save failed.'); }
});
btnReset?.addEventListener('click', async ()=>{
  const token=adminTokenInput?.value || localStorage.getItem('adminToken') || '';
  if(!token) return alert('Provide token.');
  try{
    const res=await adminFetch('/admin/reset-leaderboard',{method:'POST',headers:{'x-admin-token':token}});
    if(!res.ok) throw new Error();
    clearLeaderboardLocal();
    alert('Leaderboard reset.');
  }catch{ alert('Reset failed.'); }
});
btnToggleSpawn?.addEventListener('click', async ()=>{
  const token=adminTokenInput?.value || localStorage.getItem('adminToken') || '';
  if(!token) return alert('Provide token.');
  try{
    const curr=spawnStatusEl?.textContent==='true';
    const res=await adminFetch(`/admin/spawn-toggle?enabled=${!curr}`,{method:'POST',headers:{'x-admin-token':token}});
    if(!res.ok) throw new Error();
    alert(`Spawn set to ${!curr}`);
  }catch{ alert('Toggle failed.'); }
});
btnSimulate?.addEventListener('click', async ()=>{
  try{
    const name='LocalTester'+Math.floor(Math.random()*1000);
    const res=await adminFetch('/admin/spawn',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({ username:name, avatarUrl:'', command:'!drop' })
    });
    if(!res.ok) throw new Error();
    alert('Simulated drop sent.');
  }catch{ alert('Simulation failed.'); }
});

/* ---------------- Start up ---------------- */
function start(){
  loadSettings();
  initThree();
  initMatter();
  listenToEvents();
  initTeasers();
  initDevPanel();
  initGiftCards();
  initDraggables();
  setTeaserScale(CRATE_SCALE);
  safeForceCommandsVisible(true);
  startLoop();
}
start();

})(); // <--- single closing IIFE (SyntaxError resolved)