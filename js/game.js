/* game.js (Hotfix: Gift events not spawning balls)
   CHANGES IN THIS PATCH ONLY:
   1. Added comprehensive debug logging + a runtime toggle (window.PLK_DEBUG_GIFTS = true) to inspect gift event flow.
   2. Relaxed / removed the strict timestamp freshness filter (older than 60s) with configurable constants:
        - EVENT_AGE_LIMIT_MS (default 5 minutes)
        - IGNORE_EVENT_AGE (default true to completely ignore age unless you set false)
   3. Added robust fallback detection for gifts (even if properties are oddly named or missing).
      New helper: isLikelyGift(obj) covers more edge cases.
   4. Added developer override ALWAYS_ALLOW_SPAWN (default true) so spawn is never blocked by backend spawn flag while debugging.
      Set to false when you want backend control again.
   5. Added safeguard: if gift is detected but ball count resolves to 0 or NaN, it defaults to 1 and logs a warning.
   6. Added a visual flash (CSS class boardFrame.classList.add('gift-flash')) to show a gift was processed (remove after 150ms).
      (Non-breaking; if you don’t have .gift-flash style defined it will just do nothing.)
   7. Added defensive try/catch around spawnGiftBalls so one bad event does not halt subsequent gifts.
   8. Prevent duplicate suppression for different events that accidentally share an id shape by also hashing JSON if id missing.
   9. Ensured layout is fully rebuilt before first gift spawn (awaitLayoutReady mechanism).
   10. Minor micro-optimizations in deriveBallCountFromGift + added sanity clamp if delay queue gets large.
   11. Tag each spawned ball from gift with body.plugin.source='gift' for later potential analytics.
   12. Moved some previously scattered constants together for clarity (no functional change to previous logic).
   13. Heavy click handler warning (Violation) note added in comments (not code fix yet—likely GSAP + layout rebuild; can optimize separately).
   14. Left the external AmongUs reward + middle finger multi-tier logic from prior version intact (unchanged).
   -----------------------------------------------------------------------------------------
   NOTE: Only this file changed per your request.
   If after verifying gifts work you want the stricter controls back, set:
       ALWAYS_ALLOW_SPAWN = false
       IGNORE_EVENT_AGE = false
       EVENT_AGE_LIMIT_MS = 60000 (or desired)
   -----------------------------------------------------------------------------------------
*/

import * as THREE from 'three';
import {
  loadAvatarTexture, buildNameSprite, worldToScreen,
  FXManager2D, initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore
} from './utils.js';
import {
  ensureRewardModelLoaded, createRewardModelInstance, animateRewardModel
} from './rewardModel.js';
import {
  initPBRTeasers, updateTeaserLayout, raycastTeasers,
  createRedemptionCrate, animateCrateEntrance, openCrate,
  disposeRedemptionCrate, setTeaserScale
} from './pbrRewards.js';
import {
  getLayoutDescriptor, generatePegPositions,
  registerCustomLayout, getAllLayoutIds
} from './boardLayouts.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const { Engine, World, Bodies, Events, Body } = Matter;

(function PlinkooGame(){

/* ---------------- DEBUG / HOTFIX FLAGS ---------------- */
window.PLK_DEBUG_GIFTS = window.PLK_DEBUG_GIFTS ?? true;   // set false to silence logs
const ALWAYS_ALLOW_SPAWN = true;      // ignore backend spawn toggle for gifts while fixing
const IGNORE_EVENT_AGE   = true;      // ignore timestamp age entirely
const EVENT_AGE_LIMIT_MS = 5 * 60_000;// if IGNORE_EVENT_AGE=false, accept gifts up to 5 minutes old
const MAX_GIFT_QUEUE     = 500;       // protective clamp if something floods

/* -------------- EXISTING / PREVIOUS NEW REWARD VARIANTS -------------- */
const MIDDLE_FINGER_MODEL_ID = 22;
const AMONG_US_GLB_URL =
  'https://raw.githubusercontent.com/belisario-afk/try240/main/amongus_sexy_female.glb';

const TIER_REWARD_POOLS = {
  t1: [
    { kind:'external', key:'amongusGirl', weight: 1 },
    { kind:'internal', id:16, weight: 1 },
    { kind:'internal', id:MIDDLE_FINGER_MODEL_ID, weight: 1 }
  ],
  t2: [
    { kind:'internal', id:19, weight: 1 },
    { kind:'internal', id:MIDDLE_FINGER_MODEL_ID, weight: 1 }
  ],
  t3: [
    { kind:'internal', id:22, weight: 1 },
    { kind:'internal', id:MIDDLE_FINGER_MODEL_ID, weight: 1 }
  ]
};

function pickTierRewardVariant(tier){
  const pool=TIER_REWARD_POOLS[tier]||TIER_REWARD_POOLS.t1;
  const total=pool.reduce((a,b)=>a+(b.weight||1),0);
  let roll=Math.random()*total;
  for(const item of pool){
    roll -= (item.weight||1);
    if(roll<=0) return item;
  }
  return pool[pool.length-1];
}

let amongUsModelPromise=null;
function loadAmongUsModel(){
  if(amongUsModelPromise) return amongUsModelPromise;
  amongUsModelPromise = new Promise((resolve,reject)=>{
    const loader=new GLTFLoader();
    loader.load(
      AMONG_US_GLB_URL,
      glb=>{
        const root=glb.scene || glb.scenes?.[0];
        if(!root){ reject(new Error('GLB has no scene')); return; }
        const box=new THREE.Box3().setFromObject(root);
        const size=new THREE.Vector3(); box.getSize(size);
        const targetH=30;
        const scale=targetH/(size.y||1);
        root.scale.setScalar(scale);
        root.traverse(o=>{
          if(o.isMesh && o.material){
            o.material.toneMapped=true;
          }
        });
        resolve(root);
      },
      undefined,
      err=>reject(err)
    );
  });
  return amongUsModelPromise;
}

/* ---------------- CORE CONFIG (unchanged from previous logic) ---------------- */
const REWARD_COSTS = { t1:1000, t2:5000, t3:10000 };
const REWARD_NAMES = { t1:'Tier 1', t2:'Tier 2', t3:'Tier 3' };
const REDEEM_PREFIX = 'redeem:';
const DEV_BYPASS_DEFAULT = true;
const SHOW_PERF_PANEL = true;
const ADAPTIVE_QUALITY = true;

const GIFT_BALL_MAP = {
  'rose':1,'finger heart':1,'finger_heart':1,
  'gg':2,'unicorn':5,'lion':8,'castle':12
};
const COIN_TO_BALL_RATIO = 10;
const MAX_BALLS_PER_GIFT = 25;

const FIXED_DT=1000/60;
const MAX_STEPS_BASE=4;
const maxStepsForFrame=dt => dt>140?1:dt>90?2:MAX_STEPS_BASE;

const WORLD_HEIGHT=100;
let WORLD_WIDTH=56.25;
let BOARD_HEIGHT=WORLD_HEIGHT*0.82;
let BOARD_WIDTH=0;
let TRAY_HEIGHT=0;
const TRAY_RATIO=0.22;

let ROWS=12;
let SLOT_COUNT=ROWS+1;

const PEG_RADIUS=0.75;
const BALL_RADIUS=1.5;
const WALL_THICKNESS=2.0;

/* Anti-stuck values */
const WALL_CLEAR_MARGIN=PEG_RADIUS*2.0+0.6;
const WALL_NUDGE_ZONE=BALL_RADIUS*1.8;
const WALL_NUDGE_FORCE=0.42;
const WALL_DEFLECTOR_DEPTH=6;
const WALL_DEFLECTOR_INSET=PEG_RADIUS*1.3;
const WALL_DEFLECTOR_COUNT=6;
const WALL_DEFLECTOR_ANGLE=0.18;
const LOW_SPEED_THRESHOLD=0.6;
const LOW_SPEED_JIGGLE=0.55;

/* Tunables */
let GRAVITY_MAG=1.0;
let DROP_SPEED=0.5;
let NEON=true;
let PARTICLES=true;
let CRATE_SCALE=4.4;
let VIBRANCE_PULSE=0.4;

const BALL_RESTITUTION=0.06;
const PEG_RESTITUTION=0.02;
const BALL_FRICTION=0.04;
const BALL_FRICTION_AIR=0.012;
const MAX_SPEED=28;
const MAX_H_SPEED=22;

const PEG_MORPH_DURATION=0.85;
const PEG_CROSSFADE_DURATION=0.6;
const PEG_COUNT_DIFF_THRESHOLD=0.30;

/* State */
let engine, world;
let scene, camera, renderer;
let ambient, dirLight;
let composer, bloomPass, smaaPass, fxMgr;
let slotSensors=[];
const dynamicBodies=new Set();
const meshById=new Map();
const labelById=new Map();
const leaderboard={};
const processedEvents=new Set();
const processedEventHashes=new Set(); // fallback hash if no id
let SLOT_POINTS=[];
let SLOT_MULTIPLIERS=[];
let TOP_ROW_Y=0;
const startTime=Date.now();

let currentLayoutId=null;
let currentLayoutDescriptor=null;
const initialRotationOrder=['classic','honeycomb','gaps'];

const baseCamPos=new THREE.Vector3(0,0,100);

let pegInstancedMesh=null;
const pegBodies=[];
let wallBodies=[];
let deflectorBodies=[];
let floorBody=null;

/* Redemption */
const redeemQueue=[];
let redeemActive=false;
let activeReward3D=null;
let activeRewardDisposeFn=null;
let activeRedemptionCrate=null;

/* Performance */
let perfPanel;
const perfData={avgMs:0,worstMs:0,frames:0,qualityTier:2};
const BASE_DEVICE_PR=Math.min(window.devicePixelRatio||1,1.75);
let currentPR=Math.min(BASE_DEVICE_PR,1.5);
let frameSamples=0, frameAccum=0;

const sharedBallGeo=new THREE.SphereGeometry(BALL_RADIUS,20,14);
let sharedBallBaseMaterial=null;
const avatarTextureCache=new Map();

/* DOM refs (unchanged) */
const container=document.getElementById('game-container');
const fxCanvas=document.getElementById('fx-canvas');
const fxCtx=fxCanvas.getContext('2d');
const boardFrame=document.getElementById('board-frame');
const boardDivider=document.getElementById('board-divider');
const slotTray=document.getElementById('slot-tray');
const trayDividers=document.getElementById('tray-dividers');
const boardTitle=document.getElementById('board-title');
const slotLabelsEl=document.getElementById('slot-labels');
const leaderboardList=document.getElementById('leaderboard-list');
const spawnStatusEl=document.getElementById('spawn-status');
const redeemLayer=document.getElementById('redeem-layer');
const devPanel=document.getElementById('dev-panel');
const devFreeToggle=document.getElementById('dev-free-toggle');
const commandsPanel=document.getElementById('commands-panel');
const settingsPanel=document.getElementById('settings-panel');
const btnGear=document.getElementById('btn-gear');
const btnCloseSettings=document.getElementById('btn-close-settings');
const btnResetUI=document.getElementById('btn-reset-ui');
const btnNextLayout=document.getElementById('btn-next-layout');
const optDropSpeed=document.getElementById('opt-drop-speed');
const optGravity=document.getElementById('opt-gravity');
const optCrateScale=document.getElementById('opt-crate-scale');
const optNeon=document.getElementById('opt-neon');
const optParticles=document.getElementById('opt-particles');
const optVibrance=document.getElementById('opt-vibrance');
const optVolume=document.getElementById('opt-volume');
const adminTokenInput=document.getElementById('admin-token');
const backendUrlInput=document.getElementById('backend-url');
const layoutJsonUrlInput=document.getElementById('layout-json-url');
const btnLoadLayouts=document.getElementById('btn-load-layouts');
const btnSaveAdmin=document.getElementById('btn-save-admin');
const btnReset=document.getElementById('btn-reset-leaderboard');
const btnToggleSpawn=document.getElementById('btn-toggle-spawn');
const btnSimulate=document.getElementById('btn-simulate');

/* Utils */
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
function safeInitFirebase(){
  if(window.FirebaseREST) return;
  const listenersAdded={};
  const listenersValue={};
  window.FirebaseREST={
    onChildAdded(p,cb){(listenersAdded[p] ||= []).push(cb);},
    onValue(p,cb){(listenersValue[p] ||= []).push(cb);cb(null);},
    update(){return Promise.resolve({ok:true});},
    emitChildAdded(p,obj){(listenersAdded[p]||[]).forEach(fn=>fn('local_'+Date.now(),obj));},
    emitValue(p,data){(listenersValue[p]||[]).forEach(fn=>fn(data));}
  };
}
safeInitFirebase();
function sanitize(u){
  const s=String(u||'').trim();
  return s ? s.slice(0,24) : 'viewer';
}
function hashEventObject(obj){
  try{
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj).slice(0,500)))); // limit for safety
  }catch{return 'evt_hash_fail_'+Math.random();}
}

/* UI show/hide */
function showSettings(){ settingsPanel?.classList.add('open'); settingsPanel?.setAttribute('aria-hidden','false'); }
function hideSettings(){ settingsPanel?.classList.remove('open'); settingsPanel?.setAttribute('aria-hidden','true'); }
function showSettingsPanel(){ showSettings(); forceCommandsVisible(); }

/* Redemption (modified attachReward3D earlier) */
function enterRedemptionFocus(){ document.body.classList.add('redeem-focus'); forceCommandsVisible(); }
function exitRedemptionFocus(){ document.body.classList.remove('redeem-focus'); }

function enqueueRedemption(evId,tier,username,avatarUrl){
  redeemQueue.push({evId,tier,username,avatarUrl});
  runNextRedemption();
}
function runNextRedemption(){
  if(redeemActive) return;
  const item=redeemQueue.shift();
  if(!item) return;
  redeemActive=true;
  playRedemptionAnimation(item).then(()=>{redeemActive=false;runNextRedemption();});
}
async function attachReward3D(tier){
  if(activeReward3D){
    scene.remove(activeReward3D);
    if(activeRewardDisposeFn) activeRewardDisposeFn();
    activeReward3D=null;activeRewardDisposeFn=null;
  }
  const variant=pickTierRewardVariant(tier);
  if(variant.kind==='external' && variant.key==='amongusGirl'){
    try{
      const base=await loadAmongUsModel();
      const model=base.clone(true);
      model.traverse(o=>{
        if(o.isMesh && o.material) o.material=o.material.clone();
      });
      model.position.set(0,WORLD_HEIGHT*0.27,15);
      model.scale.multiplyScalar(0.01);
      scene.add(model);
      activeReward3D=model;
      gsap.to(model.scale,{x:'+=0.99',y:'+=0.99',z:'+=0.99',duration:.55,ease:'back.out(1.6)'});
      gsap.to(model.rotation,{y:Math.PI*2,duration:8,ease:'none',repeat:-1});
      gsap.to(model.position,{y:model.position.y+4,duration:2.6,yoyo:true,repeat:-1,ease:'sine.inOut'});
      return;
    }catch(e){
      console.warn('[Reward] External GLB failed, fallback internal.', e);
    }
  }
  attachInternalReward(tier, variant.kind==='internal'?variant.id:undefined);
}
function attachInternalReward(tier, explicitId){
  ensureRewardModelLoaded().then(()=>{
    try{
      const modelId = explicitId !== undefined
        ? explicitId
        : (tier==='t3'?22: tier==='t2'?19:16);
      const model=createRewardModelInstance(modelId);
      model.position.set(0,WORLD_HEIGHT*0.27,15);
      scene.add(model);
      activeReward3D=model;
      activeRewardDisposeFn=animateRewardModel(model, gsap);
      model.scale.multiplyScalar(0.01);
      gsap.to(model.scale,{x:model.scale.x*100,y:model.scale.y*100,z:model.scale.z*100,duration:.5,ease:'back.out(1.6)'});
    }catch(e){ console.warn('[Reward] Internal attach failed', e); }
  }).catch(()=>console.warn('[Reward] ensureRewardModelLoaded failed'));
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
      activeReward3D=null;activeRewardDisposeFn=null;
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
    setTimeout(async ()=>{
      await openCrate(activeRedemptionCrate, gsap);
      attachReward3D(tier);
    },700);
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
function buildSlotArrays(slotCount){
  const center=Math.floor((slotCount-1)/2);
  const mult=d=>d===0?16:d===1?9:d===2?5:d===3?3:1;
  SLOT_MULTIPLIERS=Array.from({length:slotCount},(_,i)=>mult(Math.abs(i-center)));
  SLOT_POINTS=SLOT_MULTIPLIERS.map(m=>m*100);
}
function renderSlotLabels(slotCount, framePx){
  slotLabelsEl.innerHTML='';
  SLOT_MULTIPLIERS.forEach(m=>{
    const div=document.createElement('div');
    div.className='slot-label '+(m>=16?'mult-top':m>=9?'mult-high':m>=5?'mult-mid':m>=3?'mult-low':'mult-base');
    div.innerHTML=`<span class="x">x</span><span class="val">${m}</span>`;
    slotLabelsEl.appendChild(div);
  });
  trayDividers.style.setProperty('--slot-width', `${framePx.width/slotCount}px`);
}

/* Layout selection */
function getDayOfYear(d=new Date()){
  const start=new Date(d.getFullYear(),0,0);
  const diff=d - start + (start.getTimezoneOffset()-d.getTimezoneOffset())*60000;
  return Math.floor(diff/86400000);
}
function mergedLayoutRotationList(){
  const custom=getAllLayoutIds().filter(id=>!initialRotationOrder.includes(id));
  return [...initialRotationOrder,...custom];
}
function dailyRotatedLayout(){
  const list=mergedLayoutRotationList();
  return list[getDayOfYear()%list.length];
}
function ensureLayout(layoutId){
  const stored=localStorage.getItem('plk_layout_override');
  const requested=layoutId || stored || dailyRotatedLayout();
  const sanitized = requested==='spiral' ? 'classic' : requested;
  if(sanitized===currentLayoutId) return;
  currentLayoutId=sanitized;
  currentLayoutDescriptor=getLayoutDescriptor(sanitized,'classic');
  animateLayoutTransition();
  localStorage.setItem('plk_layout_override', currentLayoutId);
}
function cycleLayout(){
  const list=mergedLayoutRotationList();
  if(!currentLayoutId){ ensureLayout(null); return; }
  const idx=list.indexOf(currentLayoutId);
  ensureLayout(list[(idx+1)%list.length]);
}

/* Gift detection improvements */
function isLikelyGift(obj){
  if(!obj || typeof obj!=='object') return false;
  if(isGiftEvent(obj)) return true;
  // Additional heuristics
  if('giftId' in obj) return true;
  if('gift_value' in obj) return true;
  if('diamondCount' in obj) return true;
  if(typeof obj.coins === 'number') return true;
  if(/gift/i.test(String(obj.command||''))) return true;
  return false;
}
function isGiftEvent(obj){
  if(!obj || typeof obj!=='object') return false;
  if(obj.type && String(obj.type).toLowerCase().includes('gift')) return true;
  if('giftName' in obj || 'gift' in obj || 'giftId' in obj || 'giftType' in obj) return true;
  if('giftCoins' in obj || 'coins' in obj || 'diamondCount' in obj || 'diamonds' in obj) return true;
  if(String(obj.event||'').toLowerCase()==='gift') return true;
  return false;
}
function resolveGiftName(obj){
  return (obj.giftName||obj.gift||obj.gift_type||obj.giftType||obj.itemName||obj.name||'').toString();
}
function deriveBallCountFromGift(o){
  const raw=resolveGiftName(o).trim().toLowerCase();
  if(raw && GIFT_BALL_MAP[raw]) return clamp(GIFT_BALL_MAP[raw],1,MAX_BALLS_PER_GIFT);
  const coins=o.giftCoins ?? o.coins ?? o.coin ?? o.diamondCount ?? o.diamonds ?? o.value ?? o.gift_value;
  if(typeof coins==='number' && coins>0){
    return clamp(Math.floor(coins/COIN_TO_BALL_RATIO)||1,1,MAX_BALLS_PER_GIFT);
  }
  const rpt=o.repeatCount || o.count || o.quantity;
  if(typeof rpt==='number' && rpt>0){
    return clamp(rpt,1,MAX_BALLS_PER_GIFT);
  }
  return 1;
}

function spawnGiftBalls(username, avatarUrl, giftObj){
  try{
    let count=deriveBallCountFromGift(giftObj);
    if(!Number.isFinite(count) || count<1){
      console.warn('[Gift] Invalid derived count, forcing 1', giftObj);
      count=1;
    }
    if(window.PLK_DEBUG_GIFTS) console.log('[Gift] Spawning', count, 'balls for', username, giftObj);
    const gap=90*DROP_SPEED;
    const safetyCount=Math.min(count, MAX_BALLS_PER_GIFT);
    for(let i=0;i<safetyCount;i++){
      if(i>MAX_GIFT_QUEUE){
        console.warn('[Gift] Aborting spawn, queue too large.', safetyCount);
        break;
      }
      setTimeout(()=>requestAnimationFrame(()=>spawnBallSet({username,avatarUrl,srcGift:true})), i*gap);
    }
    // small visual indicator
    if(boardFrame){
      boardFrame.classList.add('gift-flash');
      setTimeout(()=>boardFrame.classList.remove('gift-flash'),150);
    }
  }catch(e){
    console.error('[Gift] spawnGiftBalls error', e);
  }
}

/* Backend helpers */
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

/* Settings */
devFreeToggle.checked=(localStorage.getItem('plk_dev_free') ?? (DEV_BYPASS_DEFAULT?'true':'false'))==='true';
devFreeToggle.addEventListener('change',()=>localStorage.setItem('plk_dev_free',devFreeToggle.checked?'true':'false'));
function loadSettings(){
  const read=(k,d)=>Number(localStorage.getItem(k) ?? d);
  optGravity.value=read('plk_gravity',1);
  optDropSpeed.value=read('plk_dropSpeed',0.5);
  optCrateScale.value=read('plk_crate_scale',4.4); CRATE_SCALE=Number(optCrateScale.value);
  optVibrance.value=read('plk_vibrance',0.4); VIBRANCE_PULSE=Number(optVibrance.value);
  optNeon.checked=(localStorage.getItem('plk_neon') ?? 'true')==='true';
  optParticles.checked=(localStorage.getItem('plk_particles') ?? 'true')==='true';
  const vol=read('plk_volume',0.5); optVolume.value=vol; setAudioVolume(vol);
  const savedBase=getBackendBaseUrl(); if(savedBase) backendUrlInput.value=savedBase;
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

/* Three init */
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
  // Removed pointer parallax (intentional) - stable camera
}

function computeWorldSize(){
  const w=container.clientWidth||1;
  const h=container.clientHeight||1;
  const aspect=w/h;
  WORLD_WIDTH=WORLD_HEIGHT*aspect;
  BOARD_HEIGHT=WORLD_HEIGHT*0.82;
  BOARD_WIDTH=Math.min(WORLD_WIDTH*0.88, BOARD_HEIGHT*0.9);
  TRAY_HEIGHT=BOARD_HEIGHT*TRAY_RATIO;
}

function onResize(){
  if(!renderer) return;
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
  forceCommandsVisible();
}

function layoutOverlays(){
  const left=-BOARD_WIDTH/2,right=BOARD_WIDTH/2;
  const top=BOARD_HEIGHT/2,bottom=-BOARD_HEIGHT/2;
  const trayTop=bottom+TRAY_HEIGHT;
  const pTopLeft=worldToScreen(new THREE.Vector3(left,top,0),camera,renderer);
  const pBottomRight=worldToScreen(new THREE.Vector3(right,bottom,0),camera,renderer);
  const pTrayTopLeft=worldToScreen(new THREE.Vector3(left,trayTop,0),camera,renderer);
  const frame={x:Math.round(pTopLeft.x),y:Math.round(pTopLeft.y),width:Math.round(pBottomRight.x-pTopLeft.x),height:Math.round(pBottomRight.y-pTopLeft.y)};
  const tray={x:frame.x,width:frame.width,height:Math.round(pBottomRight.y-pTrayTopLeft.y),top:Math.round(pTrayTopLeft.y)};
  Object.assign(boardFrame.style,{left:frame.x+'px',top:frame.y+'px',width:frame.width+'px',height:frame.height+'px'});
  Object.assign(slotTray.style,{left:tray.x+'px',top:tray.top+'px',width:tray.width+'px',height:tray.height+'px'});
  boardDivider.style.left=frame.x+'px';
  boardDivider.style.width=frame.width+'px';
  boardDivider.style.top=(pTrayTopLeft.y-1)+'px';
  boardDivider.style.display='block';
  boardTitle.style.left=(frame.x+22)+'px';
  boardTitle.style.top =(frame.y+18)+'px';
  buildSlotArrays(SLOT_COUNT);
  renderSlotLabels(SLOT_COUNT, frame);
}

/* Matter init */
function initMatter(){
  engine=Engine.create({enableSleeping:false});
  world=engine.world;
  world.gravity.y=-Math.abs(GRAVITY_MAG);
  fxMgr=new FXManager2D(fxCanvas);
  ensureLayout(null);
  bindCollisions();
}

function clearExistingBoardPhysics(){
  slotSensors.forEach(s=>{ try{ World.remove(world,s.body); }catch{} });
  slotSensors=[];
  [...wallBodies,...deflectorBodies].forEach(w=>{ try{ World.remove(world,w);}catch{} });
  wallBodies=[]; deflectorBodies=[];
  if(floorBody){ try{ World.remove(world,floorBody);}catch{} floorBody=null; }
  pegBodies.forEach(pb=>{ try{ World.remove(world,pb);}catch{} });
  pegBodies.length=0;
  if(pegInstancedMesh){
    scene.remove(pegInstancedMesh);
    pegInstancedMesh.geometry.dispose();
    pegInstancedMesh.material.dispose();
    pegInstancedMesh=null;
  }
}

function addWallsSlotsDeflectors(){
  const left=Bodies.rectangle(-BOARD_WIDTH/2 - WALL_THICKNESS/2,0,WALL_THICKNESS,BOARD_HEIGHT,{isStatic:true,label:'WALL'});
  const right=Bodies.rectangle( BOARD_WIDTH/2 + WALL_THICKNESS/2,0,WALL_THICKNESS,BOARD_HEIGHT,{isStatic:true,label:'WALL'});
  wallBodies.push(left,right);
  floorBody=Bodies.rectangle(0,-BOARD_HEIGHT/2 - 6,BOARD_WIDTH + WALL_THICKNESS*2,WALL_THICKNESS,{isStatic:true,label:'KILL'});
  World.add(world,[left,right,floorBody]);
  const segmentHeight=BOARD_HEIGHT/WALL_DEFLECTOR_COUNT;
  const startY=BOARD_HEIGHT/2 - segmentHeight/2;
  for(let i=0;i<WALL_DEFLECTOR_COUNT;i++){
    const y=startY - i*segmentHeight;
    const dl=Bodies.rectangle(-BOARD_WIDTH/2 + WALL_DEFLECTOR_INSET,y,0.8,WALL_DEFLECTOR_DEPTH,{isStatic:true,angle:WALL_DEFLECTOR_ANGLE,label:'DEFLECTOR'});
    const dr=Bodies.rectangle( BOARD_WIDTH/2 - WALL_DEFLECTOR_INSET,y,0.8,WALL_DEFLECTOR_DEPTH,{isStatic:true,angle:-WALL_DEFLECTOR_ANGLE,label:'DEFLECTOR'});
    deflectorBodies.push(dl,dr);
  }
  World.add(world,deflectorBodies);
  slotSensors=[];
  const slotWidth=BOARD_WIDTH/SLOT_COUNT;
  const slotY=-BOARD_HEIGHT/2 + (TRAY_HEIGHT*0.35);
  for(let i=0;i<SLOT_COUNT;i++){
    const x=-BOARD_WIDTH/2 + slotWidth*(i+0.5);
    const sensor=Bodies.rectangle(x,slotY,slotWidth,2.6,{isStatic:true,isSensor:true,label:`SLOT_${i}`});
    World.add(world,sensor);
    slotSensors.push({body:sensor,index:i});
  }
}
function clampPegPositions(pegPositions){
  const minX=-BOARD_WIDTH/2 + WALL_CLEAR_MARGIN;
  const maxX= BOARD_WIDTH/2 - WALL_CLEAR_MARGIN;
  pegPositions.forEach(p=>{
    if(p.x<minX)p.x=minX;
    else if(p.x>maxX)p.x=maxX;
  });
}
function createPegBodies(pegPositions){
  pegPositions.forEach(pp=>{
    const peg=Bodies.circle(pp.x,pp.y,PEG_RADIUS,{
      isStatic:true,
      restitution:PEG_RESTITUTION,
      friction:0.01,
      label:'PEG'
    });
    pegBodies.push(peg);
  });
  World.add(world,pegBodies);
}
function buildPegInstancedMesh(pegPositions){
  const geo=new THREE.CylinderGeometry(PEG_RADIUS,PEG_RADIUS,1.2,16);
  const mat=new THREE.MeshPhysicalMaterial({
    color:0x86f7ff,metalness:0.35,roughness:0.35,
    clearcoat:0.6,clearcoatRoughness:0.2,
    emissive:0x00ffff,emissiveIntensity:0.23,
    transparent:true,opacity:1
  });
  const mesh=new THREE.InstancedMesh(geo,mat,pegPositions.length);
  const m=new THREE.Matrix4();
  const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2);
  for(let i=0;i<pegPositions.length;i++){
    const {x,y}=pegPositions[i];
    m.compose(new THREE.Vector3(x,y,0),q,new THREE.Vector3(1,1,1));
    mesh.setMatrixAt(i,m);
  }
  mesh.instanceMatrix.needsUpdate=true;
  return mesh;
}
function extractPositions(instMesh){
  if(!instMesh) return [];
  const out=[]; const dummy=new THREE.Object3D();
  for(let i=0;i<instMesh.count;i++){
    instMesh.getMatrixAt(i,dummy.matrix);
    dummy.matrix.decompose(dummy.position,dummy.quaternion,dummy.scale);
    out.push({x:dummy.position.x,y:dummy.position.y});
  }
  return out;
}
function animateLayoutTransition(){
  if(!currentLayoutDescriptor) return;
  computeWorldSize();
  const { pegPositions, rows, slotCount }=generatePegPositions(currentLayoutDescriptor, BOARD_WIDTH);
  clampPegPositions(pegPositions);
  ROWS=rows; SLOT_COUNT=slotCount;
  TOP_ROW_Y=ROWS/2 * (BOARD_WIDTH/(ROWS+1));
  const oldMesh=pegInstancedMesh;
  const oldPositions=extractPositions(oldMesh);
  clearExistingBoardPhysics();
  createPegBodies(pegPositions);
  addWallsSlotsDeflectors();
  layoutOverlays();
  const newMesh=buildPegInstancedMesh(pegPositions);
  newMesh.material.opacity=0;
  scene.add(newMesh);
  pegInstancedMesh=newMesh;
  if(!oldMesh){
    gsap.to(newMesh.material,{opacity:1,duration:0.5,ease:'power2.out'});
    layoutReadyResolver?.();
    return;
  }
  const oldCount=oldPositions.length;
  const newCount=pegPositions.length;
  const diffRatio=Math.abs(oldCount-newCount)/Math.max(1,newCount);
  if(diffRatio<=PEG_COUNT_DIFF_THRESHOLD){
    const shared=Math.min(oldCount,newCount);
    const morphData=[];
    for(let i=0;i<shared;i++){
      morphData.push({sx:oldPositions[i].x,sy:oldPositions[i].y,tx:pegPositions[i].x,ty:pegPositions[i].y});
    }
    newMesh.material.opacity=1;
    oldMesh.material.transparent=true;
    gsap.to(oldMesh.material,{opacity:0,duration:PEG_MORPH_DURATION*0.6,ease:'power1.in'});
    const tObj={t:0}; const dummy=new THREE.Object3D();
    const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2);
    gsap.to(tObj,{
      t:1,duration:PEG_MORPH_DURATION,ease:'power2.inOut',
      onUpdate:()=>{
        for(let i=0;i<shared;i++){
          const d=morphData[i];
          dummy.position.set(d.sx+(d.tx-d.sx)*tObj.t, d.sy+(d.ty-d.sy)*tObj.t,0);
          dummy.quaternion.copy(q); dummy.scale.set(1,1,1); dummy.updateMatrix();
          newMesh.setMatrixAt(i,dummy.matrix);
        }
        newMesh.instanceMatrix.needsUpdate=true;
      },
      onComplete:()=>{
        scene.remove(oldMesh);
        oldMesh.geometry.dispose();
        oldMesh.material.dispose();
        layoutReadyResolver?.();
      }
    });
  } else {
    oldMesh.material.transparent=true;
    gsap.to(oldMesh.material,{opacity:0,duration:PEG_CROSSFADE_DURATION,ease:'power1.in'});
    gsap.to(newMesh.material,{opacity:1,duration:PEG_CROSSFADE_DURATION,ease:'power2.out',onComplete:()=>{
      scene.remove(oldMesh);
      oldMesh.geometry.dispose();
      oldMesh.material.dispose();
      layoutReadyResolver?.();
    }});
  }
}

/* Await layout readiness before spawning first gift to avoid dropping above no board */
let layoutReadyResolver=null;
const layoutReadyPromise=new Promise(res=>layoutReadyResolver=res);

/* Collisions */
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
        fxMgr?.addSparks(p.x,p.y,'#00f2ea',10);
      }
    }
    sfxBounce();
  }
  if(b.label==='KILL' && String(a.label||'').startsWith('BALL_')) tryRemoveBall(a);
}

/* Performance adapt */
function adaptQuality(frameMs){
  frameAccum+=frameMs; frameSamples++;
  perfData.frames++;
  perfData.avgMs=perfData.avgMs?perfData.avgMs*0.9+frameMs*0.1:frameMs;
  if(frameMs>perfData.worstMs) perfData.worstMs=frameMs;
  if(frameSamples>=60){
    const avg=frameAccum/frameSamples;
    if(avg>22 && currentPR>0.75){ currentPR=Math.max(0.75,currentPR-0.1); renderer?.setPixelRatio(currentPR); }
    else if(avg<15 && currentPR<BASE_DEVICE_PR){ currentPR=Math.min(BASE_DEVICE_PR,currentPR+0.1); renderer?.setPixelRatio(currentPR); }
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
    perfPanel.textContent=`fps:${(1000/perfData.avgMs).toFixed(1)} ms:${perfData.avgMs.toFixed(1)} pr:${currentPR.toFixed(2)} worst:${perfData.worstMs.toFixed(1)} q:${perfData.qualityTier}`;
  }
}

/* Loop */
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
    antiStuckNudges();
    fxMgr?.update(fxCtx,dt);
    updateThreeFromMatter();
    camera.position.copy(baseCamPos);
    if(NEON){
      vibranceTime+=dt*0.001;
      const pulse=1+Math.sin(vibranceTime*2.1)*0.14*VIBRANCE_PULSE;
      bloomPass.strength=(perfData.qualityTier===0?0.32:0.5)*pulse+(NEON?0.08:0);
      renderer.toneMappingExposure=1.15*(1+0.07*VIBRANCE_PULSE*Math.sin(vibranceTime*1.4+1));
    }
    const t0=performance.now();
    (bloomPass.enabled||smaaPass.enabled)?composer.render():renderer.render(scene,camera);
    adaptQuality(dt+(performance.now()-t0));
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* Anti-stuck */
function antiStuckNudges(){
  const leftZone=-BOARD_WIDTH/2 + WALL_NUDGE_ZONE;
  const rightZone= BOARD_WIDTH/2 - WALL_NUDGE_ZONE;
  dynamicBodies.forEach(b=>{
    if(!b.position) return;
    const vx=b.velocity.x;
    const vy=b.velocity.y;
    if(b.position.x < leftZone){
      if(vx < 0.25) Body.setVelocity(b,{x:vx+WALL_NUDGE_FORCE,y:vy});
    } else if(b.position.x > rightZone){
      if(vx > -0.25) Body.setVelocity(b,{x:vx-WALL_NUDGE_FORCE,y:vy});
    }
    if((b.position.x < leftZone+1 || b.position.x > rightZone-1) &&
       Math.abs(vx) < LOW_SPEED_THRESHOLD &&
       Math.abs(vy) < 4){
      const dir=b.position.x<0?1:-1;
      Body.setVelocity(b,{
        x:dir*(LOW_SPEED_JIGGLE*(0.6+Math.random()*0.4)),
        y:vy + (Math.random()-0.5)*0.8
      });
    }
  });
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

/* Spawning */
function spawnBallSet(o){ spawnSingle(o); }
function spawnSingle({username,avatarUrl,srcGift}){
  const margin=4;
  const dropX=(Math.random()-0.5)*(BOARD_WIDTH - margin*2);
  const dropY=TOP_ROW_Y + PEG_RADIUS*4;
  const body=Bodies.circle(dropX,dropY,BALL_RADIUS,{
    restitution:BALL_RESTITUTION,friction:BALL_FRICTION,frictionAir:BALL_FRICTION_AIR,density:0.0018
  });
  body.label=`BALL_${username}`;
  body.plugin={username,avatarUrl,scored:false,source:srcGift?'gift':'manual'};
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

/* Points / leaderboard */
async function awardPoints(username, avatarUrl, points){
  const cur=leaderboard[username]||{username,avatarUrl,score:0};
  const next=cur.score+points;
  leaderboard[username]={username,avatarUrl,score:next,lastUpdate:Date.now()};
  refreshLeaderboard();
  FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g,'_'))}`,{
    username, avatarUrl: avatarUrl||'', score: next, lastUpdate: Date.now()
  }).catch(()=>{});
}
function setPointsLocal(username, avatarUrl, score){
  leaderboard[username]={username,avatarUrl,score,lastUpdate:Date.now()};
  refreshLeaderboard();
}
function deductPoints(username, avatarUrl, points){
  const cur=leaderboard[username]||{username,avatarUrl,score:0};
  if(cur.score<points) return false;
  const next=cur.score-points;
  leaderboard[username]={username,avatarUrl,score:next,lastUpdate:Date.now()};
  refreshLeaderboard();
  FirebaseREST.update(`/leaderboard/${encodeURIComponent(username.replace(/[.#$[\]]/g,'_'))}`,{
    username, avatarUrl: avatarUrl||'', score: next, lastUpdate: Date.now()
  }).catch(()=>{});
  return true;
}
function refreshLeaderboard(){
  const items=Object.values(leaderboard).sort((a,b)=>b.score-a.score).slice(0,50);
  leaderboardList.innerHTML='';
  for(const e of items){
    const li=document.createElement('li'); li.className='lb-item';
    const ava=document.createElement('div'); ava.className='lb-ava';
    if(e.avatarUrl) ava.style.backgroundImage=`url(${e.avatarUrl})`;
    const name=document.createElement('div'); name.className='lb-name'; name.textContent='@'+e.username;
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

/* Gift event listener & HOTFIX logic */
let giftEventsProcessed=0;
function listenToEvents(){
  if(!window.FirebaseREST){
    console.error('[game.js] FirebaseREST missing.');
    return;
  }
  FirebaseREST.onChildAdded('/events',async (id,obj)=>{
    if(!obj || typeof obj!=='object') return;

    // Unique event identification
    let didHash=false;
    if(!id){
      const h=hashEventObject(obj);
      if(processedEventHashes.has(h)) return;
      processedEventHashes.add(h);
      id=h;
      didHash=true;
    } else if(processedEvents.has(id)){
      return;
    }
    processedEvents.add(id);

    const ts=Number(obj.timestamp)||0;
    if(!IGNORE_EVENT_AGE){
      if(ts && Date.now()-ts > EVENT_AGE_LIMIT_MS){
        if(window.PLK_DEBUG_GIFTS) console.log('[Event] Skipped old event', id, new Date(ts).toISOString());
        return;
      }
    }

    const username=sanitize(obj.username||'viewer');
    const avatarUrl=obj.avatarUrl||'';
    const command=(obj.command||'').toLowerCase();

    const debugInfo = {
      id, hashed:didHash, ts, ageMs: Date.now()-ts,
      keys:Object.keys(obj),
      command,
      giftHeuristic:isLikelyGift(obj),
      giftStrict:isGiftEvent(obj),
      spawnStatus:spawnStatusEl?.textContent
    };
    if(window.PLK_DEBUG_GIFTS) console.log('[Event Received]', debugInfo, obj);

    // Wait until initial layout is ready so spawn coordinates valid
    await layoutReadyPromise.catch(()=>{});

    // Redemption?
    if(command.startsWith(REDEEM_PREFIX)){
      const tier=command.split(':')[1];
      handleRedeemEvent(id,username,avatarUrl,tier);
      return;
    }

    const spawnEnabledText=spawnStatusEl?.textContent || 'true';
    const spawnAllowed = ALWAYS_ALLOW_SPAWN || spawnEnabledText!=='false';

    // Gift?
    if(isLikelyGift(obj)){
      if(!spawnAllowed){
        if(window.PLK_DEBUG_GIFTS) console.warn('[Gift] Spawn blocked by backend flag (override off).');
        return;
      }
      giftEventsProcessed++;
      spawnGiftBalls(username, avatarUrl, obj);
      return;
    }

    // Plain drop commands
    if(command.includes('drop') || command.startsWith('gift')){
      if(spawnAllowed){
        spawnBallSet({username,avatarUrl});
      } else if(window.PLK_DEBUG_GIFTS){
        console.warn('[DropCmd] Spawn blocked by backend flag.');
      }
    }
  });

  FirebaseREST.onValue('/leaderboard',(data)=>{
    if(data && typeof data==='object'){
      for(const k of Object.keys(data)){
        const e=data[k];
        if(e?.username){
          leaderboard[e.username]={
            username:e.username,
            avatarUrl:e.avatarUrl||'',
            score:e.score||0,
            lastUpdate:e.lastUpdate||0
          };
        }
      }
      refreshLeaderboard();
    } else clearLeaderboardLocal();
  });

  FirebaseREST.onValue('/config',(data)=>{
    if(!data) return;
    const enabled=!!data.spawnEnabled;
    spawnStatusEl.textContent=enabled?'true':'false';
    spawnStatusEl.style.color=enabled?'var(--good)':'var(--danger)';
    const layoutId=data.layoutId || data.layout;
    if(layoutId) ensureLayout(layoutId);
  });
}

/* Teasers / dev */
function initTeasers(){
  initPBRTeasers({
    scene,camera,renderer,gsap,
    onCrateClick:(tier)=>devRedeem(tier,'ClickUser'),
    initialScale:CRATE_SCALE
  });
}
function devRedeem(tier='t1',user='DevUser'){ handleRedeemEvent('dev_'+Date.now(),user,'',tier); }
function devDrop(user='DevUser'){ spawnBallSet({username:user,avatarUrl:''}); }
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
    card.addEventListener('click',()=>devDrop(card.dataset.gift||'GiftUser'));
  });
}

/* Draggables (unchanged from hotfix perspective) */
function initDraggables(){
  const panels=[...document.querySelectorAll('[data-drag][data-scale]')];
  panels.forEach(p=>{
    preparePanel(p);
    attachDrag(p);
    attachScale(p);
    ensurePanelOnScreen(p,true);
  });
  window.addEventListener('wheel',e=>{
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
  },{passive:false});
  window.resetAllPanels=()=>{
    panels.forEach(p=>{
      localStorage.removeItem(storageKey(p,'pos'));
      localStorage.removeItem(storageKey(p,'scale'));
      p.dataset.x='40';
      p.dataset.y='120';
      p.dataset.scale='1';
      renderTransform(p);
    });
    forceCommandsVisible();
  };
}
function storageKey(panel,suffix){
  return `plk_${panel.id || panel.dataset.panel || 'panel'}_${suffix}`;
}
function preparePanel(panel){
  panel.classList.add('drag-enabled');
  if(!panel.querySelector('.resize-handle')){
    const h=document.createElement('div');
    h.className='resize-handle';
    h.textContent='↘';
    panel.appendChild(h);
  }
  const posKey=storageKey(panel,'pos');
  const scaleKey=storageKey(panel,'scale');
  let x=40,y=120,scale=1;
  try{
    const posJSON=localStorage.getItem(posKey);
    if(posJSON){
      const p=JSON.parse(posJSON);
      if(typeof p.left==='number') x=p.left;
      if(typeof p.top==='number')  y=p.top;
    }
    const sStr=localStorage.getItem(scaleKey);
    if(sStr) scale=parseFloat(sStr);
  }catch{}
  panel.dataset.x=x;
  panel.dataset.y=y;
  panel.dataset.scale=scale;
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
      dragging=true;
      panel.classList.add('dragging');
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
    if(dragging){
      dragging=false;
      panel.classList.remove('dragging');
      savePanel(panel);
      ensurePanelOnScreen(panel,false);
    }
  });
}
function attachScale(panel){
  const handle=panel.querySelector('.resize-handle');
  if(!handle) return;
  let resizing=false,sx=0,startScale=1;
  handle.addEventListener('pointerdown',e=>{
    e.preventDefault(); e.stopPropagation();
    resizing=true;
    sx=e.clientX;
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
    if(resizing){
      resizing=false;
      panel.classList.remove('dragging');
      savePanel(panel);
      ensurePanelOnScreen(panel,false);
    }
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
  localStorage.setItem(storageKey(panel,'pos'),JSON.stringify({
    left:parseFloat(panel.dataset.x||'0'),
    top:parseFloat(panel.dataset.y||'0')
  }));
  localStorage.setItem(storageKey(panel,'scale'),String(parseFloat(panel.dataset.scale||'1')));
}
function ensurePanelOnScreen(panel, initial){
  const rect=container.getBoundingClientRect();
  const x=parseFloat(panel.dataset.x||'0');
  const y=parseFloat(panel.dataset.y||'0');
  const s=parseFloat(panel.dataset.scale||'1');
  const w=panel.offsetWidth*s;
  const h=panel.offsetHeight*s;
  const margin=30;
  let nx=x,ny=y,changed=false;
  if(x + w < margin){ nx=margin; changed=true; }
  if(y + h < margin){ ny=margin; changed=true; }
  if(x > rect.width - margin){ nx=rect.width - margin - w; changed=true; }
  if(y > rect.height- margin){ ny=rect.height- margin - h; changed=true; }
  if(changed){
    panel.dataset.x=nx; panel.dataset.y=ny;
    if(!initial) savePanel(panel);
    renderTransform(panel);
  }
  if(panel===commandsPanel) forceCommandsVisible();
}

/* Custom layouts (unchanged aside from spiral ignore) */
async function loadCustomLayoutsFromUrl(url){
  if(!url) return alert('Enter a layouts URL.');
  try{
    const res=await fetch(url,{cache:'no-store'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    const json=await res.json();
    if(!json || !Array.isArray(json.layouts)) throw new Error('Malformed JSON expected {layouts:[...]}');
    let count=0;
    for(const lay of json.layouts){
      if(!lay.id) continue;
      if(lay.id==='spiral'){ console.warn('Ignoring spiral layout from remote source'); continue; }
      registerCustomLayout(lay.id, lay);
      count++;
    }
    alert(`Loaded ${count} layout(s).`);
  }catch(e){
    console.warn('Layout load error',e);
    alert('Layout load failed: '+e.message);
  }
}

/* Visibility */
function forceCommandsVisible(){
  if(!commandsPanel) return;
  commandsPanel.style.opacity='1';
  commandsPanel.style.pointerEvents='auto';
}

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

/* UI bindings */
btnGear?.addEventListener('click',showSettingsPanel);
btnCloseSettings?.addEventListener('click',hideSettings);
btnResetUI?.addEventListener('click',()=>{
  if(!commandsPanel)return;
  commandsPanel.dataset.x='40';
  commandsPanel.dataset.y='120';
  commandsPanel.dataset.scale='1';
  renderTransform(commandsPanel);
  savePanel(commandsPanel);
  forceCommandsVisible();
});
optDropSpeed.addEventListener('input',applySettings);
optGravity.addEventListener('input',applySettings);
optCrateScale.addEventListener('input',applySettings);
optNeon.addEventListener('change',applySettings);
optParticles.addEventListener('change',applySettings);
optVibrance.addEventListener('input',applySettings);
optVolume.addEventListener('input',e=>setAudioVolume(Number(e.target.value)));
btnSaveAdmin.addEventListener('click',()=>{
  try{
    const base=backendUrlInput.value.trim();
    const token=adminTokenInput.value.trim();
    setBackendBaseUrl(base);
    token?localStorage.setItem('adminToken',token):localStorage.removeItem('adminToken');
    alert('Admin settings saved.');
  }catch{ alert('Save failed'); }
});
btnReset.addEventListener('click',async()=>{
  const token=adminTokenInput.value || localStorage.getItem('adminToken') || '';
  if(!token) return alert('Provide token.');
  try{
    const res=await adminFetch('/admin/reset-leaderboard',{method:'POST',headers:{'x-admin-token':token}});
    if(!res.ok) throw 0;
    clearLeaderboardLocal();
    alert('Leaderboard reset.');
  }catch{ alert('Reset failed.'); }
});
btnToggleSpawn.addEventListener('click',async()=>{
  const token=adminTokenInput.value || localStorage.getItem('adminToken') || '';
  if(!token) return alert('Provide token.');
  try{
    const curr=spawnStatusEl.textContent==='true';
    const res=await adminFetch(`/admin/spawn-toggle?enabled=${!curr}`,{method:'POST',headers:{'x-admin-token':token}});
    if(!res.ok) throw 0;
    alert('Spawn set to '+(!curr));
  }catch{ alert('Toggle failed'); }
});
btnSimulate.addEventListener('click',async()=>{
  try{
    const name='LocalTester'+Math.floor(Math.random()*1000);
    const res=await adminFetch('/admin/spawn',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({username:name,avatarUrl:'',command:'!drop'})
    });
    if(!res.ok) throw 0;
    alert('Simulated drop sent.');
  }catch{ alert('Simulation failed'); }
});
btnNextLayout?.addEventListener('click',cycleLayout);
btnLoadLayouts?.addEventListener('click',()=>loadCustomLayoutsFromUrl(layoutJsonUrlInput.value.trim()));

window.forceShowCommands=()=>forceCommandsVisible();
window.simGift=(giftName='rose',count=1)=>{
  if(window.LocalEventBus){
    for(let i=0;i<count;i++){
      LocalEventBus.injectLocalEvent({
        username:'SimGifter',giftName,
        giftCoins: giftName.toLowerCase()==='rose'?1:10,
        timestamp:Date.now()
      });
    }
  }else if(window.FirebaseREST){
    for(let i=0;i<count;i++){
      FirebaseREST.emitChildAdded('/events',{
        username:'SimGifter',
        giftName,
        giftCoins: giftName.toLowerCase()==='rose'?1:10,
        timestamp:Date.now()
      });
    }
  }
};

/* Startup */
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

/* Dev helper to dump gift stats */
window.debugGiftStats = () => ({
  giftEventsProcessed,
  processedEvents: processedEvents.size,
  processedEventHashes: processedEventHashes.size
});

/* NOTE ON CLICK HANDLER VIOLATION:
   The 1400ms click warning likely occurs when crate open + layout rebuild + heavy GPU pass overlap.
   After confirming gift fixes, we can profile and chunk heavy GSAP tweens / instanced updates on demand.
*/

})(); // end IIFE