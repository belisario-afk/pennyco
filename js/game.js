/* game.js (Performance Optimized Build)
   Includes:
   - Previous gift hotfix + external AmongUs GLB reward + middle-finger multi-tier reward pool
   - Frame budget manager (physics/render decoupling, throttled expensive passes)
   - Gift spawn coalescing (rate-limited per frame)
   - Reduced per-frame dynamic material changes
   - Instrumentation overlay (toggle F9)
   - Visibility pause
   - Optional ball cap
   NOTE: If you previously modified this file after my last patch, let me know so I can merge diffs instead of overwriting.
*/

/* ===================== CONFIG & TOGGLES ===================== */
const PERF_CONFIG = {
  targetFPS: 60,
  maxPhysicsStepMs: 8,          // budget for physics integration slice each frame
  adaptQualityInterval: 12,     // frames between adaptQuality evaluations
  vibranceInterval: 2,          // frames between neon exposure tweaks
  spawnBallsPerFrameMax: 5,     // gift queue throttle
  maxLiveBalls: 350,            // cap to prevent runaway physics
  skipBloomAboveMs: 26,         // disable / degrade bloom if avg frame > this
  skipPassesAboveMs: 32,        // disable most post passes if above this
  freezePhysicsWhenHidden: true
};

window.PLK_DEBUG_GIFTS = window.PLK_DEBUG_GIFTS ?? false;
const ALWAYS_ALLOW_SPAWN = true;
const IGNORE_EVENT_AGE   = true;
const EVENT_AGE_LIMIT_MS = 5 * 60_000;

/* (All prior constants & reward pools retained — omitted for brevity) */
/* For space and clarity, only new or modified sections are annotated.
   The rest of the logic mirrors your last provided version but reorganized.
   ---- IF you need the entire expanded file with every unchanged line again,
   request "full expanded full file" and I'll dump the fully verbose version. ----
*/

/* ===================== IMPORTS ===================== */
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

/* ===================== SECTION 1: Rewards / Models (unchanged logic) ===================== */
const MIDDLE_FINGER_MODEL_ID = 22;
const AMONG_US_GLB_URL =
  'https://raw.githubusercontent.com/belisario-afk/try240/main/amongus_sexy_female.glb';
const TIER_REWARD_POOLS = {
  t1: [
    { kind:'external', key:'amongusGirl', weight:1 },
    { kind:'internal', id:16, weight:1 },
    { kind:'internal', id:MIDDLE_FINGER_MODEL_ID, weight:1 }
  ],
  t2: [
    { kind:'internal', id:19, weight:1 },
    { kind:'internal', id:MIDDLE_FINGER_MODEL_ID, weight:1 }
  ],
  t3: [
    { kind:'internal', id:22, weight:1 },
    { kind:'internal', id:MIDDLE_FINGER_MODEL_ID, weight:1 }
  ]
};
function pickTierRewardVariant(tier){
  const pool=TIER_REWARD_POOLS[tier]||TIER_REWARD_POOLS.t1;
  const total=pool.reduce((a,b)=>a+(b.weight||1),0);
  let r=Math.random()*total;
  for(const p of pool){ r -= (p.weight||1); if(r<=0) return p; }
  return pool[pool.length-1];
}
let amongUsModelPromise=null;
function loadAmongUsModel(){
  if(amongUsModelPromise) return amongUsModelPromise;
  amongUsModelPromise = new Promise((resolve,reject)=>{
    new GLTFLoader().load(
      AMONG_US_GLB_URL,
      glb=>{
        const root=glb.scene||glb.scenes?.[0];
        if(!root){ reject(new Error('No root in GLB')); return; }
        const box=new THREE.Box3().setFromObject(root);
        const size=new THREE.Vector3(); box.getSize(size);
        const scale=30/(size.y||1);
        root.scale.setScalar(scale);
        root.traverse(o=>{
          if(o.isMesh && o.material) o.material=o.material.clone();
        });
        resolve(root);
      },
      undefined, err=>reject(err)
    );
  });
  return amongUsModelPromise;
}

/* ===================== SECTION 2: Core constants (trimmed, same values as before) ===================== */
const REWARD_COSTS={ t1:1000, t2:5000, t3:10000 };
const REWARD_NAMES={ t1:'Tier 1', t2:'Tier 2', t3:'Tier 3' };
const REDEEM_PREFIX='redeem:';
const DEV_BYPASS_DEFAULT=true;
const SHOW_PERF_PANEL=true;
const ADAPTIVE_QUALITY=true;

const GIFT_BALL_MAP={
  'rose':1,'finger heart':1,'finger_heart':1,
  'gg':2,'unicorn':5,'lion':8,'castle':12
};
const COIN_TO_BALL_RATIO=10;
const MAX_BALLS_PER_GIFT=25;

const FIXED_DT=1000/60;
const MAX_STEPS_BASE=4;
const maxStepsForFrame=dt=>dt>140?1:dt>90?2:MAX_STEPS_BASE;

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

/* Anti-wedge */
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

/* ===================== SECTION 3: State ===================== */
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
const processedEventHashes=new Set();
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

const redeemQueue=[];
let redeemActive=false;
let activeReward3D=null;
let activeRewardDisposeFn=null;
let activeRedemptionCrate=null;

let perfPanel;
const perfData={avgMs:0,worstMs:0,frames:0,qualityTier:2};
const BASE_DEVICE_PR=Math.min(window.devicePixelRatio||1,1.75);
let currentPR=Math.min(BASE_DEVICE_PR,1.5);
let frameSamples=0,frameAccum=0;

const sharedBallGeo=new THREE.SphereGeometry(BALL_RADIUS,16,12); // slightly reduced detail
let sharedBallBaseMaterial=null;
const avatarTextureCache=new Map();

/* Gift spawn queue (throttled) */
const giftSpawnQueue=[];

/* Layout readiness */
let layoutReadyResolver=null;
const layoutReadyPromise=new Promise(r=>layoutReadyResolver=r);

/* Instrumentation overlay */
let instPanel=null;
let instrumentationEnabled=false;
function toggleInstrumentation(){
  instrumentationEnabled=!instrumentationEnabled;
  if(instrumentationEnabled){
    if(!instPanel){
      instPanel=document.createElement('div');
      instPanel.id='inst-panel';
      Object.assign(instPanel.style,{
        position:'fixed',top:'4px',right:'6px',background:'rgba(0,0,0,0.55)',
        color:'#0ff',font:'12px/1.3 monospace',padding:'6px 8px',
        zIndex:99999,whiteSpace:'pre',border:'1px solid #0ff',borderRadius:'4px'
      });
      document.body.appendChild(instPanel);
    }
  } else if(instPanel){
    instPanel.remove();
    instPanel=null;
  }
}
window.addEventListener('keydown',e=>{
  if(e.key==='F9'){ toggleInstrumentation(); }
});

/* ===================== SECTION 4: Firebase Shim ===================== */
function safeInitFirebase(){
  if(window.FirebaseREST) return;
  const listenersAdded={}, listenersValue={};
  window.FirebaseREST={
    onChildAdded(p,cb){ (listenersAdded[p] ||= []).push(cb); },
    onValue(p,cb){ (listenersValue[p] ||= []).push(cb); cb(null); },
    update(){ return Promise.resolve({ok:true}); },
    emitChildAdded(p,obj){ (listenersAdded[p]||[]).forEach(fn=>fn('local_'+Date.now(),obj)); },
    emitValue(p,data){ (listenersValue[p]||[]).forEach(fn=>fn(data)); }
  };
}
safeInitFirebase();

/* ===================== SECTION 5: Helpers ===================== */
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
function sanitize(u){
  const s=String(u||'').trim();
  return s ? s.slice(0,24) : 'viewer';
}
function hashEventObject(obj){
  try{ return btoa(unescape(encodeURIComponent(JSON.stringify(obj).slice(0,400)))); }
  catch{return 'evt_'+Math.random();}
}

/* ===================== SECTION 6: Reward Attachment (as before with variant) ===================== */
async function attachReward3D(tier){
  if(activeReward3D){
    scene.remove(activeReward3D);
    if(activeRewardDisposeFn) activeRewardDisposeFn();
    activeReward3D=null; activeRewardDisposeFn=null;
  }
  const variant=pickTierRewardVariant(tier);
  if(variant.kind==='external'){
    try{
      const base=await loadAmongUsModel();
      const model=base.clone(true);
      model.traverse(o=>{ if(o.isMesh && o.material) o.material=o.material.clone(); });
      model.position.set(0,WORLD_HEIGHT*0.27,15);
      model.scale.multiplyScalar(0.01);
      scene.add(model);
      activeReward3D=model;
      gsap.to(model.scale,{x:'+=0.99', y:'+=0.99', z:'+=0.99', duration:.55, ease:'back.out(1.6)'});
      gsap.to(model.rotation,{y:Math.PI*2,duration:9,ease:'none',repeat:-1});
      return;
    }catch(e){
      console.warn('[Reward] External load failed, fallback internal', e);
    }
  }
  attachInternalReward(tier, variant.kind==='internal'?variant.id:undefined);
}
function attachInternalReward(tier, explicit){
  ensureRewardModelLoaded().then(()=>{
    try{
      const modelId = explicit !== undefined
        ? explicit
        : (tier==='t3'?22: tier==='t2'?19:16);
      const model=createRewardModelInstance(modelId);
      model.position.set(0,WORLD_HEIGHT*0.27,15);
      scene.add(model);
      activeReward3D=model;
      activeRewardDisposeFn=animateRewardModel(model, gsap);
      model.scale.multiplyScalar(0.01);
      gsap.to(model.scale,{
        x:model.scale.x*100,y:model.scale.y*100,z:model.scale.z*100,
        duration:.5,ease:'back.out(1.6)'
      });
    }catch(e){ console.warn('[Reward] internal failed', e); }
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
      activeReward3D=null; activeRewardDisposeFn=null;
    }
  });
}

/* ===================== SECTION 7: Redemption Animation ===================== */
const redeemQueue=[];
let redeemActive=false;
let activeRedemptionCrate=null;
function enqueueRedemption(id,tier,user,ava){
  redeemQueue.push({id,tier,user,ava});
  runNextRedemption();
}
function runNextRedemption(){
  if(redeemActive) return;
  const itm=redeemQueue.shift(); if(!itm) return;
  redeemActive=true;
  playRedemption(itm).then(()=>{redeemActive=false; runNextRedemption();});
}
function playRedemption({tier,user,ava}){
  return new Promise(resolve=>{
    enterRedemptionFocus();
    const hud=document.createElement('div');
    hud.className=`redeem-user-card tier-${tier}`;
    hud.innerHTML=`<img class="redeem-ava" src="${ava||''}">
      <div class="redeem-name">@${user}</div>
      <div class="redeem-tier-label">${REWARD_NAMES[tier]} • -${REWARD_COSTS[tier]||0}</div>`;
    redeemLayer.appendChild(hud);
    gsap.to(hud,{opacity:1,y:0,scale:1,duration:.45,ease:'back.out(1.5)'});
    activeRedemptionCrate=createRedemptionCrate(tier);
    activeRedemptionCrate.position.set(0,WORLD_HEIGHT*0.05,12);
    scene.add(activeRedemptionCrate);
    animateCrateEntrance(activeRedemptionCrate, gsap);
    setTimeout(()=>openCrate(activeRedemptionCrate, gsap).then(()=>attachReward3D(tier)),700);
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
function enterRedemptionFocus(){ document.body.classList.add('redeem-focus'); }
function exitRedemptionFocus(){ document.body.classList.remove('redeem-focus'); }

/* ===================== SECTION 8: Slots & Layout ===================== */
function buildSlotArrays(n){
  const center=Math.floor((n-1)/2);
  const mult=d=>d===0?16:d===1?9:d===2?5:d===3?3:1;
  SLOT_MULTIPLIERS=Array.from({length:n},(_,i)=>mult(Math.abs(i-center)));
  SLOT_POINTS=SLOT_MULTIPLIERS.map(m=>m*100);
}
function renderSlotLabels(n, framePx){
  slotLabelsEl.innerHTML='';
  SLOT_MULTIPLIERS.forEach(m=>{
    const d=document.createElement('div');
    d.className='slot-label '+(m>=16?'mult-top':m>=9?'mult-high':m>=5?'mult-mid':m>=3?'mult-low':'mult-base');
    d.innerHTML=`<span class="x">x</span><span class="val">${m}</span>`;
    slotLabelsEl.appendChild(d);
  });
  trayDividers.style.setProperty('--slot-width', `${framePx.width/n}px`);
}
function getDayOfYear(d=new Date()){
  const start=new Date(d.getFullYear(),0,0);
  return Math.floor((d - start + (start.getTimezoneOffset()-d.getTimezoneOffset())*60000)/86400000);
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
  const req=layoutId || stored || dailyRotatedLayout();
  const id=req==='spiral'?'classic':req;
  if(id===currentLayoutId) return;
  currentLayoutId=id;
  currentLayoutDescriptor=getLayoutDescriptor(id,'classic');
  animateLayoutTransition();
  localStorage.setItem('plk_layout_override', id);
}
function cycleLayout(){
  const list=mergedLayoutRotationList();
  if(!currentLayoutId){ ensureLayout(null); return; }
  const idx=list.indexOf(currentLayoutId);
  ensureLayout(list[(idx+1)%list.length]);
}

/* ===================== SECTION 9: Gift Detection & Queue ===================== */
function resolveGiftName(o){
  return (o.giftName||o.gift||o.gift_type||o.giftType||o.itemName||o.name||'').toString();
}
function isGiftEvent(o){
  if(!o||typeof o!=='object') return false;
  if(o.type && /gift/i.test(o.type)) return true;
  if('giftName' in o || 'gift' in o || 'giftId' in o || 'giftType' in o) return true;
  if('giftCoins' in o || 'coins' in o || 'diamondCount' in o || 'diamonds' in o || 'gift_value' in o) return true;
  if(String(o.event||'').toLowerCase()==='gift') return true;
  return false;
}
function isLikelyGift(o){
  return isGiftEvent(o) ||
    'giftId' in o ||
    'gift_value' in o ||
    'diamondCount' in o ||
    typeof o.coins==='number' ||
    /gift/i.test(String(o.command||''));
}
function deriveBallCount(o){
  const key=resolveGiftName(o).trim().toLowerCase();
  if(key && GIFT_BALL_MAP[key]) return clamp(GIFT_BALL_MAP[key],1,MAX_BALLS_PER_GIFT);
  const coins=o.giftCoins ?? o.coins ?? o.coin ?? o.diamondCount ?? o.diamonds ?? o.value ?? o.gift_value;
  if(typeof coins==='number' && coins>0) return clamp(Math.floor(coins/COIN_TO_BALL_RATIO)||1,1,MAX_BALLS_PER_GIFT);
  const rpt=o.repeatCount||o.count||o.quantity;
  if(typeof rpt==='number'&&rpt>0) return clamp(rpt,1,MAX_BALLS_PER_GIFT);
  return 1;
}
function queueGiftSpawn(username, avatarUrl, raw){
  let cnt = deriveBallCount(raw);
  if(!Number.isFinite(cnt)||cnt<1){ cnt=1; }
  giftSpawnQueue.push({username,avatarUrl,count:cnt});
}
function processGiftQueueSlice(){
  let capacity=PERF_CONFIG.spawnBallsPerFrameMax;
  while(capacity>0 && giftSpawnQueue.length){
    const g=giftSpawnQueue[0];
    if(g.count<=0){
      giftSpawnQueue.shift();
      continue;
    }
    if(dynamicBodies.size >= PERF_CONFIG.maxLiveBalls){
      giftSpawnQueue.length=0;
      console.warn('[GiftQueue] Cleared due to ball cap.');
      break;
    }
    spawnBallSet({username:g.username,avatarUrl:g.avatarUrl,srcGift:true});
    g.count--;
    capacity--;
  }
}

/* ===================== SECTION 10: Firebase Event Listening ===================== */
function hashOrId(id,obj){
  if(id) return id;
  const h=hashEventObject(obj);
  if(processedEventHashes.has(h)) return null;
  processedEventHashes.add(h);
  return h;
}
function listenToEvents(){
  if(!window.FirebaseREST){
    console.error('[game.js] FirebaseREST missing.');
    return;
  }
  FirebaseREST.onChildAdded('/events', async (id,obj)=>{
    if(!obj||typeof obj!=='object') return;
    const realId=hashOrId(id,obj);
    if(!realId) return;
    if(processedEvents.has(realId)) return;
    processedEvents.add(realId);
    const ts=Number(obj.timestamp)||0;
    if(!IGNORE_EVENT_AGE && ts && Date.now()-ts>EVENT_AGE_LIMIT_MS) return;
    const username=sanitize(obj.username||'viewer');
    const avatarUrl=obj.avatarUrl||'';
    const command=(obj.command||'').toLowerCase();

    await layoutReadyPromise.catch(()=>{});

    if(command.startsWith(REDEEM_PREFIX)){
      const tier=command.split(':')[1];
      handleRedeemEvent(realId,username,avatarUrl,tier);
      return;
    }

    const spawnEnabledText=spawnStatusEl?.textContent || 'true';
    const spawnAllowed=ALWAYS_ALLOW_SPAWN || spawnEnabledText!=='false';

    if(isLikelyGift(obj)){
      if(!spawnAllowed) return;
      queueGiftSpawn(username,avatarUrl,obj);
      if(window.PLK_DEBUG_GIFTS) console.log('[GiftQueued]', {realId, queueSize:giftSpawnQueue.length});
      return;
    }
    if((command.includes('drop')||command.startsWith('gift')) && spawnAllowed){
      spawnBallSet({username,avatarUrl});
    }
  });

  FirebaseREST.onValue('/leaderboard',(data)=>{
    if(data && typeof data==='object'){
      for(const k of Object.keys(data)){
        const e=data[k];
        if(e?.username){
          leaderboard[e.username]={
            username:e.username, avatarUrl:e.avatarUrl||'', score:e.score||0, lastUpdate:e.lastUpdate||0
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

/* ===================== SECTION 11: Matter / Layout Build (optimized) ===================== */
function initMatter(){
  engine=Engine.create({enableSleeping:true});
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
  const segH=BOARD_HEIGHT/WALL_DEFLECTOR_COUNT;
  const startY=BOARD_HEIGHT/2 - segH/2;
  for(let i=0;i<WALL_DEFLECTOR_COUNT;i++){
    const y=startY - i*segH;
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
      isStatic:true,restitution:PEG_RESTITUTION,friction:0.01,label:'PEG'
    });
    pegBodies.push(peg);
  });
  World.add(world,pegBodies);
}
function buildPegInstancedMesh(pegPositions){
  const geo=new THREE.CylinderGeometry(PEG_RADIUS,PEG_RADIUS,1.2,12); // sides reduced from 16 to 12
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
    const p=pegPositions[i];
    m.compose(new THREE.Vector3(p.x,p.y,0),q,new THREE.Vector3(1,1,1));
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
    gsap.to(newMesh.material,{opacity:1,duration:0.45,ease:'power2.out'});
    layoutReadyResolver?.();
    return;
  }
  const diffRatio=Math.abs(oldPositions.length-pegPositions.length)/Math.max(1,pegPositions.length);
  if(diffRatio<=PEG_COUNT_DIFF_THRESHOLD){
    const shared=Math.min(oldPositions.length,pegPositions.length);
    const morph=[];
    for(let i=0;i<shared;i++){
      morph.push({
        sx:oldPositions[i].x,sy:oldPositions[i].y,
        tx:pegPositions[i].x,ty:pegPositions[i].y
      });
    }
    newMesh.material.opacity=1;
    oldMesh.material.transparent=true;
    gsap.to(oldMesh.material,{opacity:0,duration:PEG_MORPH_DURATION*0.55,ease:'power1.in'});
    const tObj={t:0};
    const dummy=new THREE.Object3D();
    const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2);
    gsap.to(tObj,{
      t:1,duration:PEG_MORPH_DURATION,ease:'power2.inOut',
      onUpdate:()=>{
        for(let i=0;i<shared;i++){
          const d=morph[i];
          dummy.position.set(d.sx+(d.tx-d.sx)*tObj.t,d.sy+(d.ty-d.sy)*tObj.t,0);
          dummy.quaternion.copy(q);
          dummy.scale.set(1,1,1);
          dummy.updateMatrix();
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
  }else{
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

/* ===================== SECTION 12: Physics & Rendering Loop (Frame Budget) ===================== */
let lastFrameTime=performance.now();
let accumulatedTime=0;
let frameIndex=0;
const targetFrameMs=1000/PERF_CONFIG.targetFPS;

function physicsStep(dtMs){
  let physicsTimeStart=performance.now();
  let steps=0;
  while(accumulatedTime >= FIXED_DT && steps<maxStepsForFrame(dtMs)){
    Engine.update(engine,FIXED_DT);
    accumulatedTime -= FIXED_DT;
    steps++;
    if(performance.now()-physicsTimeStart > PERF_CONFIG.maxPhysicsStepMs){
      break; // over budget
    }
  }
}

function renderFrame(dtMs){
  // Process a slice of gift spawns before moving objects
  processGiftQueueSlice();

  clampVelocities();
  antiStuckNudges();
  fxMgr?.update(fxCtx,dtMs);
  updateThreeFromMatter();

  // Adaptive - only every N frames
  if(frameIndex % PERF_CONFIG.adaptQualityInterval === 0){
    adaptQuality(dtMs);
  }

  // Throttle neon adjustments
  if(NEON && (frameIndex % PERF_CONFIG.vibranceInterval === 0)){
    vibranceTime += dtMs*0.001;
    const pulse=1+Math.sin(vibranceTime*2.1)*0.14*VIBRANCE_PULSE;
    if(bloomPass.enabled){
      bloomPass.strength=(perfData.qualityTier===0?0.32:0.5)*pulse + (NEON?0.08:0);
    }
    renderer.toneMappingExposure=1.15*(1+0.07*VIBRANCE_PULSE*Math.sin(vibranceTime*1.4+1));
  }

  // Frame budget quality toggles
  if(perfData.avgMs > PERF_CONFIG.skipBloomAboveMs){
    bloomPass.enabled=false;
  } else if(perfData.qualityTier>0 && NEON){
    bloomPass.enabled=true;
  }
  if(perfData.avgMs > PERF_CONFIG.skipPassesAboveMs){
    smaaPass.enabled=false;
  } else if(perfData.qualityTier>1){
    smaaPass.enabled=true;
  }

  const t0=performance.now();
  (bloomPass.enabled||smaaPass.enabled)?composer.render():renderer.render(scene,camera);
  const renderCost=performance.now()-t0;

  if(instrumentationEnabled && instPanel){
    instPanel.textContent =
      `frame:${frameIndex}\n`+
      `dt:${dtMs.toFixed(1)}ms avg:${perfData.avgMs.toFixed(1)} worst:${perfData.worstMs.toFixed(1)}\n`+
      `balls:${dynamicBodies.size} giftsQ:${giftSpawnQueue.length}\n`+
      `qualityTier:${perfData.qualityTier} bloom:${bloomPass.enabled} smaa:${smaaPass.enabled}\n`+
      `renderCost:${renderCost.toFixed(2)}ms`;
  }
}

let vibranceTime=0;
function adaptQuality(lastDt){
  frameAccum+=lastDt; frameSamples++;
  perfData.frames++;
  perfData.avgMs = perfData.avgMs? perfData.avgMs*0.9 + lastDt*0.1 : lastDt;
  if(lastDt>perfData.worstMs) perfData.worstMs=lastDt;
  if(frameSamples>=60){
    const avg=frameAccum/frameSamples;
    if(avg>22 && currentPR>0.75){
      currentPR=Math.max(0.75,currentPR-0.1); renderer?.setPixelRatio(currentPR);
    } else if(avg<15 && currentPR<BASE_DEVICE_PR){
      currentPR=Math.min(BASE_DEVICE_PR,currentPR+0.1); renderer?.setPixelRatio(currentPR);
    }
    frameSamples=0; frameAccum=0;
  }
  if(!ADAPTIVE_QUALITY) return;
  const avg=perfData.avgMs;
  let tier=2;
  if(avg>30) tier=0;
  else if(avg>23) tier=1;
  if(tier!==perfData.qualityTier){
    perfData.qualityTier=tier;
    if(tier===2){
      if(NEON) bloomPass.enabled=true;
      smaaPass.enabled=true;
    } else if(tier===1){
      if(NEON) bloomPass.enabled=true;
      smaaPass.enabled=true;
    } else {
      bloomPass.enabled=false;
      smaaPass.enabled=false;
    }
  }
  if(SHOW_PERF_PANEL && perfPanel && perfData.frames%30===0){
    perfPanel.textContent = `fps:${(1000/perfData.avgMs).toFixed(1)} ms:${perfData.avgMs.toFixed(1)} pr:${currentPR.toFixed(2)} q:${perfData.qualityTier}`;
  }
}

function mainLoop(now){
  if(PERF_CONFIG.freezePhysicsWhenHidden && document.hidden){
    lastFrameTime=now;
    requestAnimationFrame(mainLoop);
    return;
  }
  const dt=Math.min(250, now - lastFrameTime);
  lastFrameTime=now;
  accumulatedTime += dt;
  physicsStep(dt);
  renderFrame(dt);
  frameIndex++;
  requestAnimationFrame(mainLoop);
}

/* ===================== SECTION 13: Physics Utility ===================== */
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
function antiStuckNudges(){
  const leftZone=-BOARD_WIDTH/2 + WALL_NUDGE_ZONE;
  const rightZone= BOARD_WIDTH/2 - WALL_NUDGE_ZONE;
  dynamicBodies.forEach(b=>{
    if(!b.position) return;
    const vx=b.velocity.x;
    const vy=b.velocity.y;
    if(b.position.x < leftZone && vx < 0.25){
      Body.setVelocity(b,{x:vx+WALL_NUDGE_FORCE,y:vy});
    } else if(b.position.x > rightZone && vx > -0.25){
      Body.setVelocity(b,{x:vx-WALL_NUDGE_FORCE,y:vy});
    }
    if((b.position.x < leftZone+1 || b.position.x > rightZone-1) &&
       Math.abs(vx)<LOW_SPEED_THRESHOLD && Math.abs(vy)<4){
      const dir=b.position.x<0?1:-1;
      Body.setVelocity(b,{
        x:dir*(LOW_SPEED_JIGGLE*(0.6+Math.random()*0.4)),
        y:vy + (Math.random()-0.5)*0.8
      });
    }
  });
}
function updateThreeFromMatter(){
  dynamicBodies.forEach(body=>{
    const mesh=meshById.get(body.id);
    if(mesh){
      mesh.position.set(body.position.x,body.position.y,0);
      mesh.rotation.z=body.angle;
    }
    const label=labelById.get(body.id);
    if(label){
      label.position.set(body.position.x,body.position.y + BALL_RADIUS*2.2,0);
    }
  });
}

/* ===================== SECTION 14: Spawning Balls ===================== */
function spawnBallSet(o){
  spawnSingle(o);
}
function spawnSingle({username,avatarUrl,srcGift}){
  if(dynamicBodies.size >= PERF_CONFIG.maxLiveBalls) return;
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
  scene.add(mesh); meshById.set(body.id,mesh);
  const sprite=buildNameSprite(username);
  scene.add(sprite); labelById.set(body.id,sprite);
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

/* ===================== SECTION 15: Points / Leaderboard (unchanged) ===================== */
const leaderboard={};
async function awardPoints(u,a,p){
  const cur=leaderboard[u]||{username:u,avatarUrl:a,score:0};
  const next=cur.score+p;
  leaderboard[u]={username:u,avatarUrl:a,score:next,lastUpdate:Date.now()};
  refreshLeaderboard();
  FirebaseREST.update(`/leaderboard/${encodeURIComponent(u.replace(/[.#$[\]]/g,'_'))}`,{
    username:u,avatarUrl:a||'',score:next,lastUpdate:Date.now()
  }).catch(()=>{});
}
function setPointsLocal(u,a,s){
  leaderboard[u]={username:u,avatarUrl:a,score:s,lastUpdate:Date.now()};
  refreshLeaderboard();
}
function deductPoints(u,a,p){
  const cur=leaderboard[u]||{username:u,avatarUrl:a,score:0};
  if(cur.score<p) return false;
  const next=cur.score-p;
  leaderboard[u]={username:u,avatarUrl:a,score:next,lastUpdate:Date.now()};
  refreshLeaderboard();
  FirebaseREST.update(`/leaderboard/${encodeURIComponent(u.replace(/[.#$[\]]/g,'_'))}`,{
    username:u,avatarUrl:a||'',score:next,lastUpdate:Date.now()
  }).catch(()=>{});
  return true;
}
function refreshLeaderboard(){
  const list=Object.values(leaderboard).sort((a,b)=>b.score-a.score).slice(0,50);
  leaderboardList.innerHTML='';
  for(const e of list){
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
function handleRedeemEvent(id,u,a,tier){
  if(processedEvents.has(id+'_redeem')) return;
  processedEvents.add(id+'_redeem');
  const cost=REWARD_COSTS[tier];
  if(!cost) return;
  if(devFreeToggle.checked && (leaderboard[u]?.score||0)<cost){
    setPointsLocal(u,a,cost);
  }
  if(!deductPoints(u,a,cost)) return;
  enqueueRedemption(id,tier,u,a);
}

/* ===================== SECTION 16: UI & Audio (reused) ===================== */
/* (Identical to previous patch – omitted for brevity; includes settings, panel dragging, etc.) */
/* ... (If you need the entire UI section verbatim, request full expanded) ... */

/* Minimal essential UI binding for this performance patch: */
const btnGear=document.getElementById('btn-gear');
const settingsPanel=document.getElementById('settings-panel');
const btnCloseSettings=document.getElementById('btn-close-settings');
const optDropSpeed=document.getElementById('opt-drop-speed');
const optGravity=document.getElementById('opt-gravity');
const optCrateScale=document.getElementById('opt-crate-scale');
const optNeon=document.getElementById('opt-neon');
const optParticles=document.getElementById('opt-particles');
const optVibrance=document.getElementById('opt-vibrance');
const optVolume=document.getElementById('opt-volume');
const devFreeToggle=document.getElementById('dev-free-toggle');
const spawnStatusEl=document.getElementById('spawn-status');
const backendUrlInput=document.getElementById('backend-url');
const adminTokenInput=document.getElementById('admin-token');
const btnSaveAdmin=document.getElementById('btn-save-admin');
const btnReset=document.getElementById('btn-reset-leaderboard');
const btnToggleSpawn=document.getElementById('btn-toggle-spawn');
const btnSimulate=document.getElementById('btn-simulate');
const btnNextLayout=document.getElementById('btn-next-layout');
const layoutJsonUrlInput=document.getElementById('layout-json-url');
const btnLoadLayouts=document.getElementById('btn-load-layouts');
const leaderboardList=document.getElementById('leaderboard-list');
const redeemLayer=document.getElementById('redeem-layer');
const commandsPanel=document.getElementById('commands-panel');
const boardFrame=document.getElementById('board-frame');
const trayDividers=document.getElementById('tray-dividers');
const slotLabelsEl=document.getElementById('slot-labels');
const boardDivider=document.getElementById('board-divider');
const slotTray=document.getElementById('slot-tray');
const boardTitle=document.getElementById('board-title');
const fxCanvas=document.getElementById('fx-canvas');
const fxCtx=fxCanvas.getContext('2d');
const container=document.getElementById('game-container');

function showSettings(){ settingsPanel?.classList.add('open'); }
function hideSettings(){ settingsPanel?.classList.remove('open'); }
btnGear?.addEventListener('click',showSettings);
btnCloseSettings?.addEventListener('click',hideSettings);
optDropSpeed?.addEventListener('input',()=>{ DROP_SPEED=Number(optDropSpeed.value); });
optGravity?.addEventListener('input',()=>{ GRAVITY_MAG=Number(optGravity.value); if(world) world.gravity.y=-Math.abs(GRAVITY_MAG); });
optCrateScale?.addEventListener('input',()=>{ CRATE_SCALE=Number(optCrateScale.value); setTeaserScale(CRATE_SCALE); });
optNeon?.addEventListener('change',()=>{ NEON=!!optNeon.checked; if(bloomPass) bloomPass.enabled=NEON; });
optParticles?.addEventListener('change',()=>{ PARTICLES=!!optParticles.checked; });
optVibrance?.addEventListener('input',()=>{ VIBRANCE_PULSE=Number(optVibrance.value); });
optVolume?.addEventListener('input',e=>setAudioVolume(Number(e.target.value)));
btnNextLayout?.addEventListener('click',cycleLayout);
btnLoadLayouts?.addEventListener('click',()=>loadCustomLayoutsFromUrl(layoutJsonUrlInput.value.trim()));

/* ===================== SECTION 17: Startup ===================== */
function initThree(){
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.22;
  renderer.setPixelRatio(currentPR);
  renderer.setSize(container.clientWidth,container.clientHeight);
  renderer.setClearColor(0,0);
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
  bloomPass=new UnrealBloomPass(new THREE.Vector2(renderer.domElement.width,renderer.domElement.height),0.55,0.5,0.25);
  composer.addPass(bloomPass);
  new ResizeObserver(onResize).observe(container);
  onResize();
  if(SHOW_PERF_PANEL){
    perfPanel=document.createElement('div');
    perfPanel.id='perf-panel';
    perfPanel.style.cssText='position:fixed;left:6px;top:4px;background:rgba(0,0,0,.45);color:#0f0;font:12px monospace;padding:4px 6px;z-index:9999;border:1px solid #0f0;border-radius:3px;';
    document.body.appendChild(perfPanel);
  }
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
let resizeRaf=null;
function onResize(){
  if(resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf=requestAnimationFrame(()=>{
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
  });
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

function start(){
  initThree();
  initMatter();
  listenToEvents();
  initTeasers();
  startLoop();
  loadSettingsMinimal();
}
function startLoop(){ lastFrameTime=performance.now(); requestAnimationFrame(mainLoop); }

function loadSettingsMinimal(){
  try{
    DROP_SPEED=Number(localStorage.getItem('plk_dropSpeed')||DROP_SPEED);
    GRAVITY_MAG=Number(localStorage.getItem('plk_gravity')||GRAVITY_MAG);
  }catch{}
}

/* Minimal audio unlock */
let audioBound=false;
function bindAudioUnlockOnce(){
  if(audioBound) return;
  audioBound=true;
  const unlock=()=>{ initAudioOnce().catch(()=>{}); window.removeEventListener('pointerdown',unlock,true); window.removeEventListener('keydown',unlock,true); };
  window.addEventListener('pointerdown',unlock,true);
  window.addEventListener('keydown',unlock,true);
}
bindAudioUnlockOnce();

/* Expose dev helpers */
window.cycleLayout=cycleLayout;
window.simGift=(gift='Rose',count=1)=>{
  if(window.FirebaseREST){
    for(let i=0;i<count;i++){
      FirebaseREST.emitChildAdded('/events',{
        username:'SimGifter', giftName:gift, giftCoins: gift.toLowerCase()==='rose'?1:10, timestamp:Date.now()
      });
    }
  }
};

start();

})(); // end IIFE