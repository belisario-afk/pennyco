/* game.js – Gift Spam Enhancement + Coin Mapping + Per-Gift Panel (FULL)
   Additions in this version:
   - Precise coin -> ball mapping table (5,10,20,30,99,500)
   - Each gift event now produces at least 1 mapping batch (no silent merge).
   - Streak logic improved: delta <=0 falls back to 1 gift.
   - Small consecutive gifts (2–3) no longer merged into a single drop.
   - Gift value panel (index.html) + spam mode checkbox already integrated.
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

/* ============ CONFIG ============ */
const REWARD_COSTS  = { t1:1000, t2:5000, t3:10000 };
const REWARD_NAMES  = { t1:'Tier 1', t2:'Tier 2', t3:'Tier 3' };
const REDEEM_PREFIX = 'redeem:';
const DEV_BYPASS_DEFAULT = true;
const SHOW_PERF_PANEL = true;
const ADAPTIVE_QUALITY = true;

/* Gift -> base balls mapping by name */
const GIFT_BALL_MAP = {
  'rose': 1,
  'finger heart': 1,
  'finger_heart': 1,
  'gg': 2,
  'unicorn': 5,
  'lion': 8,
  'castle': 12
};

/* Explicit coin mapping (exact price) */
const COIN_MAPPING_TABLE = [
  { coins:5,   balls:2 },
  { coins:10,  balls:3 },
  { coins:20,  balls:4 },
  { coins:30,  balls:5 },
  { coins:99,  balls:10 },
  { coins:500, balls:60 },
];

/* Fallback ratios */
const NORMAL_MAX_BALLS_PER_GIFT = 25;
const COIN_TO_BALL_RATIO_NORMAL = 10;

let SPAM_MODE = (localStorage.getItem('plk_spam_mode') || 'false') === 'true';
const SPAM_MAX_BALLS_PER_EVENT   = 400;
const COIN_TO_BALL_RATIO_SPAM    = 4;
const SPAWN_PER_FRAME            = 40;
const SPAM_GLOBAL_WINDOW_MS      = 10_000;
const SPAM_GLOBAL_WINDOW_MAX     = 6000;  // Set Infinity to remove safety cap

function setSpamMode(on){
  SPAM_MODE = !!on;
  localStorage.setItem('plk_spam_mode', SPAM_MODE ? 'true':'false');
  console.log('[SpamMode]', SPAM_MODE ? 'ENABLED' : 'DISABLED');
  const cb=document.getElementById('opt-spam-mode');
  if(cb) cb.checked=SPAM_MODE;
}
window.enableSpam  = ()=>setSpamMode(true);
window.disableSpam = ()=>setSpamMode(false);
window.toggleSpam  = ()=>setSpamMode(!SPAM_MODE);
window.isSpamMode  = ()=>SPAM_MODE;

/* Physics / World dims */
const FIXED_DT = 1000/60;
const MAX_STEPS_BASE = 4;
const maxStepsForFrame = dt => dt > 140 ? 1 : dt > 90 ? 2 : MAX_STEPS_BASE;

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

let GRAVITY_MAG   = 1.0;
let DROP_SPEED    = 0.5;
let NEON          = true;
let PARTICLES     = true;
let CRATE_SCALE   = 4.4;
let VIBRANCE_PULSE= 0.4;

const BALL_RESTITUTION = 0.06;
const PEG_RESTITUTION  = 0.02;
const BALL_FRICTION    = 0.04;
const BALL_FRICTION_AIR= 0.012;
const MAX_SPEED        = 28;
const MAX_H_SPEED      = 22;

/* State */
let engine, world;
let scene, camera, renderer;
let ambient, dirLight;
let composer, bloomPass, smaaPass, fxMgr;
let slotSensors = [];
const dynamicBodies = new Set();
const meshById = new Map();
const labelById = new Map();
const leaderboard = {};
const processedEvents = new Set();
const processedRedemptions = new Set();
let SLOT_POINTS=[], SLOT_MULTIPLIERS=[], TOP_ROW_Y=0;
const startTime = Date.now();

const targetCamOffset = new THREE.Vector3();
const baseCamPos      = new THREE.Vector3(0,0,100);

/* DOM */
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
const redeemLayer     = document.getElementById('redeem-layer');
const devPanel        = document.getElementById('dev-panel');
const devFreeToggle   = document.getElementById('dev-free-toggle');
const commandsPanel   = document.getElementById('commands-panel');
const settingsPanel   = document.getElementById('settings-panel');
const btnGear         = document.getElementById('btn-gear');
const btnCloseSettings= document.getElementById('btn-close-settings');
const btnResetUI      = document.getElementById('btn-reset-ui');
const giftValuePanel  = document.getElementById('gift-value-panel');

/* Settings fields */
const optDropSpeed    = document.getElementById('opt-drop-speed');
const optGravity      = document.getElementById('opt-gravity');
const optCrateScale   = document.getElementById('opt-crate-scale');
const optNeon         = document.getElementById('opt-neon');
const optParticles    = document.getElementById('opt-particles');
const optVibrance     = document.getElementById('opt-vibrance');
const optVolume       = document.getElementById('opt-volume');
const optSpamMode     = document.getElementById('opt-spam-mode');
const adminTokenInput = document.getElementById('admin-token');
const backendUrlInput = document.getElementById('backend-url');
const btnSaveAdmin    = document.getElementById('btn-save-admin');
const btnReset        = document.getElementById('btn-reset-leaderboard');
const btnToggleSpawn  = document.getElementById('btn-toggle-spawn');
const btnSimulate     = document.getElementById('btn-simulate');

/* Show / hide settings */
function showSettings(){
  settingsPanel?.classList.add('open');
  settingsPanel?.setAttribute('aria-hidden','false');
}
function hideSettings(){
  settingsPanel?.classList.remove('open');
  settingsPanel?.setAttribute('aria-hidden','true');
}

/* Helpers */
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const safeNum=(v,f)=>{ const n=parseFloat(v); return Number.isFinite(n)?n:f; };

/* Performance */
let perfPanel;
const perfData={avgMs:0,worstMs:0,frames:0,qualityTier:2};
const BASE_DEVICE_PR = Math.min(window.devicePixelRatio||1, 1.75);
let currentPR = Math.min(BASE_DEVICE_PR, 1.5);
let frameSamples=0, frameAccum=0;

const sharedBallGeo = new THREE.SphereGeometry(BALL_RADIUS,20,14);
let sharedBallBaseMaterial=null;
const avatarTextureCache=new Map();

/* Redemption queue */
const redeemQueue=[];
let redeemActive=false;
let activeReward3D=null;
let activeRewardDisposeFn=null;
let activeRedemptionCrate=null;

function enterRedemptionFocus(){ document.body.classList.add('redeem-focus'); forceCommandsVisible(); }
function exitRedemptionFocus(){ document.body.classList.remove('redeem-focus'); }

function enqueueRedemption(evId,tier,username,avatarUrl){
  redeemQueue.push({evId,tier,username,avatarUrl});
  runNextRedemption();
}
function runNextRedemption(){
  if(redeemActive) return;
  const next=redeemQueue.shift();
  if(!next) return;
  redeemActive=true;
  playRedemptionAnimation(next).then(()=>{redeemActive=false;runNextRedemption();});
}
async function prepare3DModel(){ try{ await ensureRewardModelLoaded(); return true; }catch{return false;} }

function attachReward3D(tier){
  if(activeReward3D){
    scene.remove(activeReward3D);
    if(activeRewardDisposeFn) activeRewardDisposeFn();
    activeReward3D=null; activeRewardDisposeFn=null;
  }
  try{
    const model=createRewardModelInstance(tier==='t3'?22:tier==='t2'?19:16);
    model.position.set(0,WORLD_HEIGHT*0.27,15);
    scene.add(model);
    activeReward3D=model;
    activeRewardDisposeFn=animateRewardModel(model, gsap);
    model.scale.multiplyScalar(0.01);
    gsap.to(model.scale,{x:model.scale.x*100,y:model.scale.y*100,z:model.scale.z*100,duration:.5,ease:'back.out(1.6)'});
  }catch{}
}
function detachReward3D(){
  if(!activeReward3D) return;
  gsap.to(activeReward3D.scale,{
    x:activeReward3D.scale.x*0.01,
    y:activeReward3D.scale.y*0.01,
    z:activeReward3D.scale.z*0.01,
    duration:.35,ease:'power2.in',
    onComplete:()=>{
      if(activeReward3D) scene.remove(activeReward3D);
      if(activeRewardDisposeFn) activeRewardDisposeFn();
      activeReward3D=null; activeRewardDisposeFn=null;
    }
  });
}
function playRedemptionAnimation({tier,username,avatarUrl}){
  return new Promise(async resolve=>{
    enterRedemptionFocus();
    const hud=document.createElement('div');
    hud.className=`redeem-user-card tier-${tier}`;
    hud.innerHTML=`<img class="redeem-ava" src="${avatarUrl||''}" alt="">
      <div class="redeem-name">@${username}</div>
      <div class="redeem-tier-label">${REWARD_NAMES[tier]} • -${REWARD_COSTS[tier]||0}</div>`;
    redeemLayer.appendChild(hud);
    gsap.to(hud,{opacity:1,y:0,scale:1,duration:.45,ease:'back.out(1.5)'});

    activeRedemptionCrate=createRedemptionCrate(tier);
    activeRedemptionCrate.position.set(0,WORLD_HEIGHT*0.05,12);
    scene.add(activeRedemptionCrate);
    animateCrateEntrance(activeRedemptionCrate, gsap);

    const modelLoaded=await prepare3DModel().catch(()=>false);
    setTimeout(async ()=>{ await openCrate(activeRedemptionCrate, gsap); if(modelLoaded) attachReward3D(tier); },700);

    setTimeout(()=>{
      gsap.to(hud,{opacity:0,y:24,scale:0.85,duration:.35,ease:'power1.in',onComplete:()=>redeemLayer.removeChild(hud)});
      detachReward3D();
      disposeRedemptionCrate(activeRedemptionCrate, gsap);
      activeRedemptionCrate=null;
      exitRedemptionFocus();
      resolve();
    },3600);
  });
}

/* Slots */
function buildSlots(count){
  const center=Math.floor((count-1)/2);
  const mult=d=>d===0?16:d===1?9:d===2?5:d===3?3:1;
  SLOT_MULTIPLIERS=Array.from({length:count},(_,i)=>mult(Math.abs(i-center)));
  SLOT_POINTS=SLOT_MULTIPLIERS.map(m=>m*100);
}
function renderSlotLabels(count, framePx){
  slotLabelsEl.innerHTML='';
  SLOT_MULTIPLIERS.forEach(m=>{
    const div=document.createElement('div');
    div.className='slot-label '+(m>=16?'mult-top':m>=9?'mult-high':m>=5?'mult-mid':m>=3?'mult-low':'mult-base');
    div.innerHTML=`<span class="x">x</span><span class="val">${m}</span>`;
    slotLabelsEl.appendChild(div);
  });
  trayDividers.style.setProperty('--slot-width', `${framePx.width/count}px`);
}

/* Backend base */
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

/* Settings persistence */
devFreeToggle.checked=(localStorage.getItem('plk_dev_free') ?? (DEV_BYPASS_DEFAULT?'true':'false'))==='true';
devFreeToggle.addEventListener('change',()=>localStorage.setItem('plk_dev_free',devFreeToggle.checked?'true':'false'));

function loadSettings(){
  const read=(k,d)=>Number(localStorage.getItem(k) ?? d);
  optGravity.value = read('plk_gravity',1);
  optDropSpeed.value= read('plk_dropSpeed',0.5);
  optCrateScale.value=read('plk_crate_scale',4.4); CRATE_SCALE=parseFloat(optCrateScale.value);
  optVibrance.value=read('plk_vibrance',0.4); VIBRANCE_PULSE=parseFloat(optVibrance.value);
  optNeon.checked=(localStorage.getItem('plk_neon') ?? 'true')==='true';
  optParticles.checked=(localStorage.getItem('plk_particles') ?? 'true')==='true';
  const vol=read('plk_volume',0.5); optVolume.value=vol; setAudioVolume(vol);
  const base=getBackendBaseUrl(); if(base) backendUrlInput.value=base;
  const tok=localStorage.getItem('adminToken')||''; if(tok) adminTokenInput.value=tok;
  if(optSpamMode) optSpamMode.checked=SPAM_MODE;
  applySettings();
}
function applySettings(){
  DROP_SPEED=Number(optDropSpeed.value);
  GRAVITY_MAG=Number(optGravity.value);
  NEON=!!optNeon.checked;
  PARTICLES=!!optParticles.checked;
  CRATE_SCALE=Number(optCrateScale.value);
  VIBRANCE_PULSE=Number(optVibrance.value);
  localStorage.setItem('plk_dropSpeed',DROP_SPEED);
  localStorage.setItem('plk_gravity',GRAVITY_MAG);
  localStorage.setItem('plk_crate_scale',CRATE_SCALE);
  localStorage.setItem('plk_neon',NEON);
  localStorage.setItem('plk_particles',PARTICLES);
  localStorage.setItem('plk_vibrance',VIBRANCE_PULSE);
  if(world) world.gravity.y=-Math.abs(GRAVITY_MAG);
  setTeaserScale(CRATE_SCALE);
  if(bloomPass){
    bloomPass.enabled=NEON;
    bloomPass.strength=NEON?0.6:0;
  }
}

/* Three.js init */
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

  new ResizeObserver(onResize).observe(container);
  onResize();

  if(SHOW_PERF_PANEL){
    perfPanel=document.createElement('div');
    perfPanel.id='perf-panel';
    document.body.appendChild(perfPanel);
  }

  const rectTarget={w:0,h:0};
  function updateRect(){ const r=renderer.domElement.getBoundingClientRect(); rectTarget.w=r.width; rectTarget.h=r.height; }
  updateRect();
  window.addEventListener('resize',updateRect);

  renderer.domElement.addEventListener('pointermove',e=>{
    const xNorm=(e.clientX/rectTarget.w)*2 - 1;
    const yNorm=(e.clientY/rectTarget.h)*2 - 1;
    targetCamOffset.x = xNorm * 2.5;
    targetCamOffset.y = yNorm * 1.8;
  });

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
  if(!renderer) return;
  renderer.setSize(container.clientWidth,container.clientHeight);
  composer.setSize(container.clientWidth,container.clientHeight);
  smaaPass.setSize(container.clientWidth,container.clientHeight);
  bloomPass.setSize(container.clientWidth,container.clientHeight);
  computeWorldSize();
  camera.left=-WORLD_WIDTH/2; camera.right=WORLD_WIDTH/2;
  camera.top=WORLD_HEIGHT/2; camera.bottom=-WORLD_HEIGHT/2;
  camera.updateProjectionMatrix();
  fxCanvas.width=container.clientWidth;
  fxCanvas.height=container.clientHeight;
  layoutOverlays();
  updateTeaserLayout();
  forceCommandsVisible();
}
function layoutOverlays(){
  const left=-BOARD_WIDTH/2,right=BOARD_WIDTH/2;
  const top=BOARD_HEIGHT/2,bottom=-BOARD_HEIGHT/2;
  const trayTop=bottom+TRAY_HEIGHT;
  const pTL=worldToScreen(new THREE.Vector3(left,top,0),camera,renderer);
  const pBR=worldToScreen(new THREE.Vector3(right,bottom,0),camera,renderer);
  const pTrayTL=worldToScreen(new THREE.Vector3(left,trayTop,0),camera,renderer);
  const frame={x:Math.round(pTL.x),y:Math.round(pTL.y),width:Math.round(pBR.x-pTL.x),height:Math.round(pBR.y-pTL.y)};
  const tray={x:frame.x,width:frame.width,height:Math.round(pBR.y-pTrayTL.y),top:Math.round(pTrayTL.y)};
  Object.assign(boardFrame.style,{left:frame.x+'px',top:frame.y+'px',width:frame.width+'px',height:frame.height+'px'});
  Object.assign(slotTray.style,{left:tray.x+'px',top:tray.top+'px',width:tray.width+'px',height:tray.height+'px'});
  boardDivider.style.left=frame.x+'px'; boardDivider.style.width=frame.width+'px';
  boardDivider.style.top=(pTrayTL.y-1)+'px'; boardDivider.style.display='block';
  boardTitle.style.left=(frame.x+22)+'px'; boardTitle.style.top=(frame.y+18)+'px';
  const slotCount=ROWS+1;
  buildSlots(slotCount);
  renderSlotLabels(slotCount, frame);
}

/* Matter.js */
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
  const pegs=[];
  for(let r=0;r<ROWS;r++){
    const y=startY - r*rowH;
    for(let c=0;c<=r;c++){
      const x=startX + c*PEG_SPACING + (ROWS-1-r)*(PEG_SPACING/2);
      const peg=Bodies.circle(x,y,PEG_RADIUS,{isStatic:true,restitution:PEG_RESTITUTION,friction:0.01});
      peg.label='PEG';
      World.add(world,peg);
      pegs.push({x,y});
    }
  }
  addPegInstancedMesh(pegs);
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
function addPegInstancedMesh(list){
  const geo=new THREE.CylinderGeometry(PEG_RADIUS,PEG_RADIUS,1.2,16);
  const mat=new THREE.MeshPhysicalMaterial({
    color:0x86f7ff,metalness:0.35,roughness:0.35,
    clearcoat:0.6,clearcoatRoughness:0.2,
    emissive:0x00ffff,emissiveIntensity:0.23
  });
  const inst=new THREE.InstancedMesh(geo,mat,list.length);
  const m=new THREE.Matrix4();
  const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2);
  list.forEach(({x,y},i)=>{
    m.compose(new THREE.Vector3(x,y,0),q,new THREE.Vector3(1,1,1));
    inst.setMatrixAt(i,m);
  });
  inst.instanceMatrix.needsUpdate=true;
  scene.add(inst);
}
function bindCollisions(){
  Events.on(engine,'collisionStart',ev=>{
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
    if(!a.plugin?.scored){
      const idx=slot.index;
      const points=SLOT_POINTS[idx]||100;
      a.plugin.scored=true;
      awardPoints(a.plugin.username,a.plugin.avatarUrl||'',points).catch(console.warn);
      sfxScore(points>=1600);
      setTimeout(()=>tryRemoveBall(a),900);
    }
    return;
  }
  if(b.label==='PEG' && String(a.label||'').startsWith('BALL_')){
    if(PARTICLES){
      const mesh=meshById.get(a.id);
      if(mesh){
        const p=worldToScreen(mesh.position,camera,renderer);
        fxMgr.addSparks(p.x,p.y,'#00f2ea',10);
      }
    }
    sfxBounce();
  }
  if(b.label==='KILL' && String(a.label||'').startsWith('BALL_')) tryRemoveBall(a);
}

/* Loop */
function adaptQuality(frameMs){
  frameAccum+=frameMs; frameSamples++;
  perfData.frames++;
  perfData.avgMs=perfData.avgMs?perfData.avgMs*0.9+frameMs*0.1:frameMs;
  if(frameMs>perfData.worstMs) perfData.worstMs=frameMs;
  if(frameSamples>=60){
    const avg=frameAccum/frameSamples;
    if(avg>22 && currentPR>0.75){ currentPR=Math.max(0.75,currentPR-0.1); renderer.setPixelRatio(currentPR); }
    else if(avg<15 && currentPR<BASE_DEVICE_PR){ currentPR=Math.min(BASE_DEVICE_PR,currentPR+0.1); renderer.setPixelRatio(currentPR); }
    frameSamples=0; frameAccum=0;
  }
  if(!ADAPTIVE_QUALITY) return;
  const avg=perfData.avgMs;
  let target=2;
  if(avg>30) target=0; else if(avg>23) target=1;
  if(target!==perfData.qualityTier){
    perfData.qualityTier=target;
    if(target===2){ bloomPass.enabled=NEON; bloomPass.strength=0.6; smaaPass.enabled=true; }
    else if(target===1){ bloomPass.enabled=NEON; bloomPass.strength=0.38; smaaPass.enabled=true; }
    else { bloomPass.enabled=false; smaaPass.enabled=false; }
  }
  if(perfPanel && perfData.frames%30===0){
    perfPanel.textContent=`fps:${(1000/perfData.avgMs).toFixed(1)} ms:${perfData.avgMs.toFixed(1)} pR:${currentPR.toFixed(2)} worst:${perfData.worstMs.toFixed(1)} q:${perfData.qualityTier}`;
  }
}

let vibranceTime=0;
function startLoop(){
  let last=performance.now(), acc=0;
  function tick(now){
    const dt=Math.min(250, now-last); last=now; acc+=dt;
    let steps=0;
    while(acc>=FIXED_DT && steps<maxStepsForFrame(dt)){
      Engine.update(engine,FIXED_DT);
      acc-=FIXED_DT; steps++;
    }
    clampVelocities();
    fxMgr.update(fxCtx,dt);
    updateThreeFromMatter();
    drainSpawnQueue();

    camera.position.x += (baseCamPos.x + targetCamOffset.x - camera.position.x)*0.06;
    camera.position.y += (baseCamPos.y + targetCamOffset.y - camera.position.y)*0.06;

    if(NEON){
      vibranceTime+=dt*0.001;
      const pulse=1+Math.sin(vibranceTime*2.1)*0.14*VIBRANCE_PULSE;
      bloomPass.strength=(perfData.qualityTier===0?0.32:0.5)*pulse+(NEON?0.08:0);
      renderer.toneMappingExposure=1.15*(1+0.07*VIBRANCE_PULSE*Math.sin(vibranceTime*1.4+1));
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

/* Spawn */
const spawnQueue=[];
let spawnInLastWindow=[];
function queueBall(username, avatarUrl){ spawnQueue.push({username,avatarUrl}); }
function drainSpawnQueue(){
  const now=performance.now();
  spawnInLastWindow=spawnInLastWindow.filter(t=>now-t<SPAM_GLOBAL_WINDOW_MS);
  let allowed=Infinity;
  if(SPAM_MODE){
    const remain=SPAM_GLOBAL_WINDOW_MAX - spawnInLastWindow.length;
    if(remain<=0) return;
    allowed=remain;
  }
  const batch=Math.min(spawnQueue.length,SPAWN_PER_FRAME,allowed);
  for(let i=0;i<batch;i++){
    const item=spawnQueue.shift();
    spawnBallSet(item);
    spawnInLastWindow.push(now);
  }
}

function spawnBallSet(o){ spawnSingle(o); }
function spawnSingle({username,avatarUrl}){
  const jitter=PEG_SPACING*0.35;
  const dropX=Math.max(-BOARD_WIDTH/2+4,Math.min(BOARD_WIDTH/2-4,(Math.random()-0.5)*jitter));
  const dropY=TOP_ROW_Y + PEG_SPACING*0.8;
  const body=Bodies.circle(dropX,dropY,BALL_RADIUS,{
    restitution:BALL_RESTITUTION,friction:BALL_FRICTION,
    frictionAir:BALL_FRICTION_AIR,density:0.0018
  });
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
      emissive:NEON?0x00b8e8:0x000000,
      emissiveIntensity:NEON?0.04:0
    });
  }
  const mesh=new THREE.Mesh(sharedBallGeo,sharedBallBaseMaterial.clone());
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
      if(live){ live.material.map=tex; live.material.needsUpdate=true; }
    }catch{}
  };
  ('requestIdleCallback' in window)?requestIdleCallback(applyTex,{timeout:600}):setTimeout(applyTex,0);
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

/* Leaderboard */
async function awardPoints(username, avatarUrl, points){
  const current=leaderboard[username] || { username, avatarUrl, score:0 };
  const next=current.score+points;
  leaderboard[username]={ username, avatarUrl, score:next, lastUpdate:Date.now() };
  refreshLeaderboard();
  FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g,'_'))}`,{
    username, avatarUrl:avatarUrl||'', score:next, lastUpdate:Date.now()
  }).catch(()=>{});
}
function setPointsLocal(username, avatarUrl, score){
  leaderboard[username]={ username, avatarUrl, score, lastUpdate:Date.now() };
  refreshLeaderboard();
}
function deductPoints(username, avatarUrl, points){
  const current=leaderboard[username] || { username, avatarUrl, score:0 };
  if(current.score < points) return false;
  const next=current.score - points;
  leaderboard[username]={ username, avatarUrl, score: next, lastUpdate:Date.now() };
  refreshLeaderboard();
  FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g,'_'))}`,{
    username, avatarUrl:avatarUrl||'', score:next, lastUpdate:Date.now()
  }).catch(()=>{});
  return true;
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
    li.append(ava,name,score);
    leaderboardList.appendChild(li);
  }
}
function clearLeaderboardLocal(){
  Object.keys(leaderboard).forEach(k=>delete leaderboard[k]);
  leaderboardList.innerHTML='';
}
function handleRedeemEvent(id, username, avatarUrl, tier){
  if(processedRedemptions.has(id)) return;
  processedRedemptions.add(id);
  const cost=REWARD_COSTS[tier];
  if(!cost) return;
  if(devFreeToggle.checked && (leaderboard[username]?.score||0)<cost){
    setPointsLocal(username,avatarUrl,cost);
  }
  if(!deductPoints(username,avatarUrl,cost)) return;
  enqueueRedemption(id,tier,username,avatarUrl);
}

/* Gift / streak logic */
const giftStreakMap=new Map(); // key => last repeatCount

function resolveGiftName(o){
  return (o.giftName || o.gift || o.gift_type || o.giftType || o.itemName || o.name || '').toString();
}
function coinMapping(coins){
  if(!Number.isFinite(coins) || coins<=0) return null;
  const exact=COIN_MAPPING_TABLE.find(e=>e.coins===coins);
  return exact ? exact.balls : null;
}

/* Derive base balls (one event, before repeat scaling) */
function deriveBaseBallsForGift(obj){
  const name=resolveGiftName(obj).trim().toLowerCase();
  const coins = obj.giftCoins ?? obj.coins ?? obj.coin ?? obj.diamondCount ?? obj.diamonds ?? obj.value;

  // 1) Exact coin mapping first
  const mappedExact = coinMapping(coins);
  if(mappedExact!=null){
    return mappedExact;
  }

  // 2) Name mapping
  if(name && GIFT_BALL_MAP[name]) return GIFT_BALL_MAP[name];

  // 3) Coin fallback ratio
  if(Number.isFinite(coins) && coins>0){
    if(SPAM_MODE){
      return clamp(Math.floor(coins/COIN_TO_BALL_RATIO_SPAM) || 1, 1, SPAM_MAX_BALLS_PER_EVENT);
    }
    return clamp(Math.floor(coins/COIN_TO_BALL_RATIO_NORMAL) || 1, 1, NORMAL_MAX_BALLS_PER_GIFT);
  }

  // 4) Default
  return SPAM_MODE ? 3 : 1;
}

/* Compute total balls for one event (handles repeatCount delta) */
function computeEventBallCount(username,obj){
  const base = deriveBaseBallsForGift(obj);
  const repeatRaw = obj.repeatCount ?? obj.count ?? obj.quantity;
  const giftName = resolveGiftName(obj).toLowerCase();
  const key = username+'::'+giftName;

  // If no repeat info treat each event as single unit
  if(!Number.isFinite(repeatRaw) || repeatRaw<=0){
    return base;
  }

  // Streak delta
  const prev = giftStreakMap.get(key) || 0;
  let delta = repeatRaw - prev;

  // If streaming backend sends only final repeat at end (so events produce same repeat),
  // ensure delta at least 1 to avoid merging small bursts
  if(delta <= 0) delta = 1;

  // Update last count
  giftStreakMap.set(key, repeatRaw);

  // Multiply base by delta
  let total = base * delta;

  // Clamp
  if(SPAM_MODE){
    total = clamp(total, 1, SPAM_MAX_BALLS_PER_EVENT);
  }else{
    total = clamp(total, 1, NORMAL_MAX_BALLS_PER_GIFT);
  }

  return total;
}

function finalizeStreakIfEnded(username,obj){
  if(obj.repeatEnd || obj.streakEnd || obj.streakEnded){
    const giftName=resolveGiftName(obj).toLowerCase();
    giftStreakMap.delete(username+'::'+giftName);
  }
}

function isGiftEvent(obj){
  if(!obj || typeof obj!=='object') return false;
  if(obj.type && String(obj.type).toLowerCase().includes('gift')) return true;
  if('giftName' in obj || 'gift' in obj || 'giftId' in obj || 'giftType' in obj) return true;
  if('giftCoins' in obj || 'coins' in obj || 'diamondCount' in obj || 'diamonds' in obj) return true;
  if(String(obj.event||'').toLowerCase()==='gift') return true;
  return false;
}

function spawnGiftBalls(username, avatarUrl, obj){
  const total = computeEventBallCount(username,obj);
  for(let i=0;i<total;i++){
    queueBall(username,avatarUrl);
  }
  finalizeStreakIfEnded(username,obj);
}

/* Firebase events */
function listenToEvents(){
  FirebaseREST.onChildAdded('/events',(id,obj)=>{
    if(!obj || typeof obj!=='object' || processedEvents.has(id)) return;
    const ts=Number(obj.timestamp)||0;
    if(ts && ts < startTime - 60_000) return;
    processedEvents.add(id);

    const username=sanitize(obj.username||'viewer');
    const avatarUrl=obj.avatarUrl||'';
    const command=(obj.command||'').toLowerCase();

    if(command.startsWith(REDEEM_PREFIX)){
      const tier=command.split(':')[1];
      handleRedeemEvent(id,username,avatarUrl,tier);
      return;
    }

    if(isGiftEvent(obj)){
      const spawnEnabled = spawnStatusEl?.textContent !== 'false';
      if(!spawnEnabled && !devFreeToggle.checked) return;
      spawnGiftBalls(username,avatarUrl,obj);
      return;
    }

    if(command.includes('drop') || command.startsWith('gift')){
      queueBall(username,avatarUrl);
    }
  });

  FirebaseREST.onValue('/leaderboard',(data)=>{
    if(data && typeof data==='object'){
      Object.keys(data).forEach(k=>{
        const e=data[k];
        if(e?.username){
          leaderboard[e.username]={
            username:e.username,
            avatarUrl:e.avatarUrl||'',
            score:e.score||0,
            lastUpdate:e.lastUpdate||0
          };
        }
      });
      refreshLeaderboard();
    } else clearLeaderboardLocal();
  });

  FirebaseREST.onValue('/config',(data)=>{
    const enabled=!!(data && data.spawnEnabled);
    spawnStatusEl.textContent=enabled?'true':'false';
    spawnStatusEl.style.color=enabled?'var(--good)':'var(--danger)';
  });
}

function sanitize(u){
  const s=String(u||'').trim();
  return s ? s.slice(0,24) : 'viewer';
}

/* Teasers & Dev */
function initTeasers(){
  initPBRTeasers({
    scene,camera,renderer,gsap,
    onCrateClick:(tier)=>devRedeem(tier,'ClickUser'),
    initialScale:CRATE_SCALE
  });
}
function devRedeem(tier='t1',user='DevUser'){
  const id='dev_'+Date.now()+'_'+Math.random().toString(36).slice(2);
  handleRedeemEvent(id,user,'',tier);
}
function devDrop(user='DevUser'){ queueBall(user,''); }
window.devRedeem=devRedeem;
window.devDrop=devDrop;

/* Dev Panel */
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

/* Gift grid test */
function initGiftCards(){
  document.querySelectorAll('.gift-card').forEach(card=>{
    card.addEventListener('click',()=>{
      // Simulate coin-based mapping (just queue one base gift)
      queueBall(card.dataset.gift||'GiftUser','');
    });
  });
}

/* Draggables */
function initDraggables(){
  const panels=[...document.querySelectorAll('[data-drag][data-scale]')];
  panels.forEach(p=>{
    preparePanel(p); attachDrag(p); attachScale(p); ensurePanelOnScreen(p,true);
  });

  window.addEventListener('wheel', e=>{
    if(!e.altKey) return;
    const el=e.target.closest('[data-drag][data-scale]');
    if(!el) return;
    e.preventDefault();
    let s=parseFloat(el.dataset.scale||'1');
    s += -Math.sign(e.deltaY)*0.08;
    s=clamp(s,0.45,3.5);
    el.dataset.scale=s;
    renderTransform(el);
    savePanel(el);
    if(el===commandsPanel) forceCommandsVisible();
  }, { passive:false });

  window.resetAllPanels=()=>{
    panels.forEach(p=>{
      localStorage.removeItem(storageKey(p,'pos'));
      localStorage.removeItem(storageKey(p,'scale'));
      p.dataset.x='40'; p.dataset.y='120'; p.dataset.scale='1';
      renderTransform(p);
    });
    forceCommandsVisible();
  };
}
function storageKey(panel,suffix){ return `plk_${panel.id || panel.dataset.panel || 'panel'}_${suffix}`; }

function preparePanel(panel){
  panel.classList.add('drag-enabled');
  if(!panel.querySelector('.resize-handle')){
    const h=document.createElement('div');
    h.className='resize-handle'; h.textContent='↘';
    panel.appendChild(h);
  }
  const posKey=storageKey(panel,'pos'), scaleKey=storageKey(panel,'scale');
  let x=40,y=120,scale=1;
  try{
    const posJSON=localStorage.getItem(posKey);
    if(posJSON){
      const p=JSON.parse(posJSON);
      if(typeof p.left==='number') x=p.left;
      if(typeof p.top==='number')  y=p.top;
    }
    const sStr=localStorage.getItem(scaleKey); if(sStr) scale=parseFloat(sStr);
  }catch{}
  panel.dataset.x=x; panel.dataset.y=y; panel.dataset.scale=scale;
  renderTransform(panel);
}
function attachDrag(panel){
  const handles=panel.querySelectorAll('.drag-bar,.cmd-title,.drag-handle');
  const dragEls=handles.length?handles:[panel];
  let dragging=false,sx=0,sy=0,startX=0,startY=0;
  dragEls.forEach(h=>{
    h.style.cursor='grab';
    h.addEventListener('pointerdown',e=>{
      if(e.button!==0) return;
      if(e.target.closest('.resize-handle')) return;
      dragging=true; panel.classList.add('dragging');
      sx=e.clientX; sy=e.clientY;
      startX=parseFloat(panel.dataset.x||'0');
      startY=parseFloat(panel.dataset.y||'0');
      e.preventDefault();
    });
  });
  window.addEventListener('pointermove',e=>{
    if(!dragging) return;
    panel.dataset.x=startX+(e.clientX-sx);
    panel.dataset.y=startY+(e.clientY-sy);
    renderTransform(panel);
  });
  window.addEventListener('pointerup',()=>{
    if(!dragging) return;
    dragging=false;
    panel.classList.remove('dragging');
    savePanel(panel);
    ensurePanelOnScreen(panel,false);
  });
}
function attachScale(panel){
  const handle=panel.querySelector('.resize-handle');
  if(!handle) return;
  let resizing=false,sx=0,startScale=1;
  handle.addEventListener('pointerdown',e=>{
    e.preventDefault(); e.stopPropagation();
    resizing=true; sx=e.clientX;
    startScale=parseFloat(panel.dataset.scale||'1');
    panel.classList.add('dragging');
  });
  window.addEventListener('pointermove',e=>{
    if(!resizing) return;
    let sc=startScale + (e.clientX - sx)/240;
    sc=clamp(sc,0.45,3.5);
    panel.dataset.scale=sc;
    renderTransform(panel);
  });
  window.addEventListener('pointerup',()=>{
    if(!resizing) return;
    resizing=false;
    panel.classList.remove('dragging');
    savePanel(panel);
    ensurePanelOnScreen(panel,false);
  });
}
function renderTransform(panel){
  const x=parseFloat(panel.dataset.x||'0');
  const y=parseFloat(panel.dataset.y||'0');
  const s=parseFloat(panel.dataset.scale||'1');
  panel.style.transform=`translate(${x}px,${y}px) scale(${s})`;
  if(panel===commandsPanel) forceCommandsVisible();
}
function savePanel(panel){
  const posKey=storageKey(panel,'pos'), scaleKey=storageKey(panel,'scale');
  const x=parseFloat(panel.dataset.x||'0'), y=parseFloat(panel.dataset.y||'0'), s=parseFloat(panel.dataset.scale||'1');
  localStorage.setItem(posKey,JSON.stringify({left:x,top:y}));
  localStorage.setItem(scaleKey,String(s));
}
function ensurePanelOnScreen(panel,initial){
  const rect=container.getBoundingClientRect();
  const x=parseFloat(panel.dataset.x||'0'), y=parseFloat(panel.dataset.y||'0');
  const s=parseFloat(panel.dataset.scale||'1');
  const w=panel.offsetWidth*s, h=panel.offsetHeight*s;
  const margin=30;
  let changed=false, nx=x, ny=y;
  if(x + w < margin){ nx=margin; changed=true; }
  if(y + h < margin){ ny=margin; changed=true; }
  if(x > rect.width - margin){ nx=rect.width - margin - w; changed=true; }
  if(y > rect.height - margin){ ny=rect.height - margin - h; changed=true; }
  if(changed){
    panel.dataset.x=nx; panel.dataset.y=ny;
    if(!initial) savePanel(panel);
    renderTransform(panel);
  }
  if(panel===commandsPanel) forceCommandsVisible();
}
function forceCommandsVisible(){
  if(!commandsPanel) return;
  commandsPanel.style.opacity='1';
  commandsPanel.style.pointerEvents='auto';
}

/* UI / Audio events */
btnGear?.addEventListener('click',()=>{ showSettings(); forceCommandsVisible(); });
btnCloseSettings?.addEventListener('click', hideSettings);
btnResetUI?.addEventListener('click',()=>{
  if(!commandsPanel) return;
  commandsPanel.dataset.x='40';
  commandsPanel.dataset.y='120';
  commandsPanel.dataset.scale='1';
  renderTransform(commandsPanel);
  savePanel(commandsPanel);
  forceCommandsVisible();
});

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

/* Settings handlers */
optDropSpeed.addEventListener('input', applySettings);
optGravity.addEventListener('input', applySettings);
optCrateScale.addEventListener('input', applySettings);
optNeon.addEventListener('change', applySettings);
optParticles.addEventListener('change', applySettings);
optVibrance.addEventListener('input', applySettings);
optVolume.addEventListener('input', e=>setAudioVolume(Number(e.target.value)));
optSpamMode?.addEventListener('change',()=>setSpamMode(optSpamMode.checked));

btnSaveAdmin.addEventListener('click',()=>{
  try{
    const base=backendUrlInput.value.trim();
    const tok=adminTokenInput.value.trim();
    setBackendBaseUrl(base);
    tok?localStorage.setItem('adminToken',tok):localStorage.removeItem('adminToken');
    alert('Saved admin settings.');
  }catch{ alert('Save failed.'); }
});
btnReset.addEventListener('click', async ()=>{
  const tok=adminTokenInput.value || localStorage.getItem('adminToken') || '';
  if(!tok) return alert('Provide token.');
  try{
    const res=await adminFetch('/admin/reset-leaderboard',{method:'POST',headers:{'x-admin-token':tok}});
    if(!res.ok) throw new Error();
    clearLeaderboardLocal();
    alert('Leaderboard reset.');
  }catch{ alert('Reset failed.'); }
});
btnToggleSpawn.addEventListener('click', async ()=>{
  const tok=adminTokenInput.value || localStorage.getItem('adminToken') || '';
  if(!tok) return alert('Provide token.');
  try{
    const curr=spawnStatusEl.textContent==='true';
    const res=await adminFetch(`/admin/spawn-toggle?enabled=${!curr}`,{method:'POST',headers:{'x-admin-token':tok}});
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
      body:JSON.stringify({ username:name, avatarUrl:'', command:'!drop' })
    });
    if(!res.ok) throw new Error();
    alert('Simulated drop sent.');
  }catch{ alert('Simulation failed.'); }
});

/* Console helpers */
window.forceShowCommands=()=>forceCommandsVisible();
window.simGift=(coins=5,count=1)=>{
  for(let i=0;i<count;i++){
    const evt={
      username:'SimGifter',
      avatarUrl:'',
      giftName:'coinGift',
      giftCoins:coins,
      repeatCount:i+1,
      timestamp:Date.now()
    };
    spawnGiftBalls(evt.username,evt.avatarUrl,evt);
  }
};

/* Start */
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
  startLoop();
  forceCommandsVisible();
}
start();