/* FULL game.js with draggable commands panel and updated command list (no !drop card).
   NOTE: Only changes from previous full PBR version:
     - Added commandsPanel query
     - Added initCommandsPanelDrag()
     - Added call to initCommandsPanelDrag() in start()
     - No references to removed !drop card; logic unaffected.
*/
import * as THREE from 'three';
import {
  loadAvatarTexture, buildNameSprite, worldToScreen,
  FXManager2D, initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore
} from './utils.js';
import { ensureRewardModelLoaded, createRewardModelInstance, animateRewardModel } from './rewardModel.js';
import {
  initPBRTeasers, updateTeaserLayout, raycastTeasers,
  createRedemptionCrate, animateCrateEntrance, openCrate, disposeRedemptionCrate
} from './pbrRewards.js';

import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

const { Engine, World, Bodies, Events, Body } = Matter;

(() => {
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

  const BALL_RESTITUTION = 0.06;
  const PEG_RESTITUTION  = 0.02;
  const BALL_FRICTION    = 0.04;
  const BALL_FRICTION_AIR= 0.012;

  const MAX_SPEED = 28;
  const MAX_H_SPEED = 22;

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

  // DOM references
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

  // Settings
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

  devFreeToggle.checked = (localStorage.getItem('plk_dev_free') ?? (DEV_BYPASS_DEFAULT?'true':'false'))==='true';
  devFreeToggle.addEventListener('change',()=>localStorage.setItem('plk_dev_free',devFreeToggle.checked?'true':'false'));

  // Performance
  let perfPanel, perfData={avgMs:0,worstMs:0,frames:0,qualityTier:2};
  const BASE_DEVICE_PR = Math.min(window.devicePixelRatio||1, 1.75);
  let currentPR = Math.min(BASE_DEVICE_PR, 1.5);
  let frameSamples=0, frameAccum=0;

  const sharedBallGeo = new THREE.SphereGeometry(BALL_RADIUS,20,14);
  let sharedBallBaseMaterial = null;
  const avatarTextureCache = new Map();

  const redeemQueue = [];
  let redeemActive = false;
  let activeReward3D = null;
  let activeRewardDisposeFn = null;
  let activeRedemptionCrate = null;

  function enqueueRedemption(evId,tier,username,avatarUrl){
    redeemQueue.push({evId,tier,username,avatarUrl});
    runNextRedemption();
  }
  function runNextRedemption(){
    if(redeemActive) return;
    const item=redeemQueue.shift();
    if(!item) return;
    redeemActive=true;
    playRedemptionAnimation(item).then(()=>{
      redeemActive=false;
      runNextRedemption();
    });
  }

  async function prepare3DModel(){
    try{ await ensureRewardModelLoaded(); return true; }catch{ return false; }
  }

  function attachReward3D(tier){
    if(activeReward3D){
      scene.remove(activeReward3D);
      if(activeRewardDisposeFn) activeRewardDisposeFn();
      activeReward3D=null; activeRewardDisposeFn=null;
    }
    try{
      const model=createRewardModelInstance(tier==='t3'?22:tier==='t2'?19:16);
      model.position.set(0,WORLD_HEIGHT*0.25,15);
      model.renderOrder=999;
      scene.add(model);
      activeReward3D=model;
      activeRewardDisposeFn=animateRewardModel(model, gsap);
      model.scale.multiplyScalar(0.01);
      gsap.to(model.scale,{
        x:model.scale.x*100,y:model.scale.y*100,z:model.scale.z*100,
        duration:.55,ease:'back.out(1.7)'
      });
    }catch{}
  }
  function detachReward3D(){
    if(activeReward3D){
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
  }

  function playRedemptionAnimation({evId,tier,username,avatarUrl}){
    return new Promise(async resolve=>{
      const hud=document.createElement('div');
      hud.className=`redeem-user-card tier-${tier}`;
      hud.innerHTML=`
        <img class="redeem-ava" src="${avatarUrl||''}" alt="">
        <div class="redeem-name">@${username}</div>
        <div class="redeem-tier-label">${REWARD_NAMES[tier]} • -${REWARD_COSTS[tier]||0}</div>
      `;
      redeemLayer.appendChild(hud);
      gsap.to(hud,{opacity:1,y:0,scale:1,duration:.55,ease:'back.out(1.6)'});

      activeRedemptionCrate = createRedemptionCrate(tier);
      activeRedemptionCrate.position.set(0,WORLD_HEIGHT*0.1,10);
      scene.add(activeRedemptionCrate);
      animateCrateEntrance(activeRedemptionCrate, gsap);

      const modelLoaded = await prepare3DModel().catch(()=>false);

      setTimeout(async ()=>{
        await openCrate(activeRedemptionCrate, gsap);
        if(modelLoaded) attachReward3D(tier);
      }, 850);

      setTimeout(()=>{
        gsap.to(hud,{opacity:0,y:20,scale:0.9,duration:.45,ease:'power1.in',onComplete:()=>redeemLayer.removeChild(hud)});
        detachReward3D();
        disposeRedemptionCrate(activeRedemptionCrate, gsap);
        activeRedemptionCrate=null;
        resolve();
      }, 4200);
    });
  }

  function buildSlots(slotCount){
    const center=Math.floor((slotCount-1)/2);
    const mult=d=>d===0?16:d===1?9:d===2?5:d===3?3:1;
    SLOT_MULTIPLIERS=Array.from({length:slotCount},(_,i)=>mult(Math.abs(i-center)));
    SLOT_POINTS=SLOT_MULTIPLIERS.map(m=>m*100);
  }
  function classForMultiplier(m){
    if(m>=16)return'mult-top';
    if(m>=9)return'mult-high';
    if(m>=5)return'mult-mid';
    if(m>=3)return'mult-low';
    return'mult-base';
  }
  function renderSlotLabels(slotCount, framePx){
    slotLabelsEl.innerHTML='';
    SLOT_MULTIPLIERS.forEach(m=>{
      const div=document.createElement('div');
      div.className='slot-label '+classForMultiplier(m);
      div.innerHTML=`<span class="x">x</span><span class="val">${m}</span>`;
      slotLabelsEl.appendChild(div);
    });
    trayDividers.style.setProperty('--slot-width', `${framePx.width / slotCount}px`);
  }

  function getBackendBaseUrl(){ return (localStorage.getItem('backendBaseUrl')||'').trim(); }
  function setBackendBaseUrl(url){
    const clean=String(url||'').trim().replace(/\/+$/,'');
    if(clean) localStorage.setItem('backendBaseUrl',clean); else localStorage.removeItem('backendBaseUrl');
  }
  function adminFetch(path,opt={}){
    const base=getBackendBaseUrl();
    if(!base) throw new Error('Backend URL not set.');
    return fetch(`${base}${path.startsWith('/')?'':'/'}${path}`, opt);
  }

  function loadSettings(){
    const g=Number(localStorage.getItem('plk_gravity') ?? '1'); if(!Number.isNaN(g)) optGravity.value=String(g);
    const ds=Number(localStorage.getItem('plk_dropSpeed') ?? '0.5'); if(!Number.isNaN(ds)) optDropSpeed.value=String(ds);
    const md=Number(localStorage.getItem('plk_multiDrop') ?? '1'); if(!Number.isNaN(md)) optMultiDrop.value=String(md);
    optNeon.checked=(localStorage.getItem('plk_neon') ?? 'true')==='true';
    optParticles.checked=(localStorage.getItem('plk_particles') ?? 'true')==='true';
    const vol=Number(localStorage.getItem('plk_volume') ?? '0.5'); optVolume.value=String(vol); setAudioVolume(vol);
    const savedBase=getBackendBaseUrl(); if(savedBase) backendUrlInput.value=savedBase;
    const tok=localStorage.getItem('adminToken')||''; if(tok) adminTokenInput.value=tok;
    applySettings();
  }
  function applySettings(){
    DROP_SPEED=Number(optDropSpeed.value);
    GRAVITY_MAG=Number(optGravity.value);
    NEON=!!optNeon.checked;
    PARTICLES=!!optParticles.checked;
    localStorage.setItem('plk_dropSpeed',String(DROP_SPEED));
    localStorage.setItem('plk_gravity',String(GRAVITY_MAG));
    localStorage.setItem('plk_multiDrop',String(optMultiDrop.value));
    localStorage.setItem('plk_neon',String(NEON));
    localStorage.setItem('plk_particles',String(PARTICLES));
    if(world) world.gravity.y=-Math.abs(GRAVITY_MAG);
    if(pegsInstanced){
      pegsInstanced.material.emissive.set(NEON?0x00ffff:0x000000);
      pegsInstanced.material.emissiveIntensity=NEON?0.30:0.0;
    }
    if(bloomPass){
      bloomPass.enabled=NEON;
      bloomPass.strength=NEON?0.75:0;
    }
  }
  function showSettings(){ gsap.to(settingsPanel,{x:0,duration:.35,ease:'expo.out'}); settingsPanel.setAttribute('aria-hidden','false'); }
  function hideSettings(){ gsap.to(settingsPanel,{x:'110%',duration:.35,ease:'expo.in'}); settingsPanel.setAttribute('aria-hidden','true'); }

  let pegsInstanced;
  function initThree(){
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.0;
    renderer.setPixelRatio(currentPR);
    renderer.setSize(container.clientWidth,container.clientHeight);
    renderer.setClearColor(0x000000,0);
    container.appendChild(renderer.domElement);

    scene=new THREE.Scene();
    computeWorldSize();
    camera=new THREE.OrthographicCamera(-WORLD_WIDTH/2,WORLD_WIDTH/2,WORLD_HEIGHT/2,-WORLD_HEIGHT/2,0.1,300);
    camera.position.set(0,0,100);

    ambient=new THREE.AmbientLight(0xffffff,0.85);
    dirLight=new THREE.DirectionalLight(0xffffff,1.1);
    dirLight.position.set(-18,30,60);
    scene.add(ambient,dirLight);

    composer=new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene,camera));
    smaaPass=new SMAAPass(renderer.domElement.width,renderer.domElement.height);
    composer.addPass(smaaPass);
    bloomPass=new UnrealBloomPass(new THREE.Vector2(renderer.domElement.width,renderer.domElement.height),0.75,0.6,0.2);
    composer.addPass(bloomPass);

    const ro=new ResizeObserver(onResize); ro.observe(container);
    onResize();

    if(SHOW_PERF_PANEL){
      perfPanel=document.createElement('div');
      perfPanel.id='perf-panel';
      perfPanel.textContent='Perf';
      document.body.appendChild(perfPanel);
    }

    const raycaster=new THREE.Raycaster();
    const pt=new THREE.Vector2();
    renderer.domElement.addEventListener('pointerdown',e=>{
      const rect=renderer.domElement.getBoundingClientRect();
      pt.x=((e.clientX-rect.left)/rect.width)*2 - 1;
      pt.y= -((e.clientY-rect.top)/rect.height)*2 + 1;
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
  }

  function layoutOverlays(){
    const left=-BOARD_WIDTH/2,right=BOARD_WIDTH/2;
    const top=BOARD_HEIGHT/2,bottom=-BOARD_HEIGHT/2;
    const trayTop=bottom+TRAY_HEIGHT;
    const pTopLeft=worldToScreen(new THREE.Vector3(left,top,0),camera,renderer);
    const pBottomRight=worldToScreen(new THREE.Vector3(right,bottom,0),camera,renderer);
    const pTrayTopLeft=worldToScreen(new THREE.Vector3(left,trayTop,0),camera,renderer);
    const frame={
      x:Math.round(pTopLeft.x),
      y:Math.round(pTopLeft.y),
      width:Math.round(pBottomRight.x-pTopLeft.x),
      height:Math.round(pBottomRight.y-pTopLeft.y)
    };
    const tray={
      x:frame.x,
      width:frame.width,
      height:Math.round(pBottomRight.y-pTrayTopLeft.y),
      top:Math.round(pTrayTopLeft.y)
    };
    Object.assign(boardFrame.style,{left:frame.x+'px',top:frame.y+'px',width:frame.width+'px',height:frame.height+'px'});
    Object.assign(slotTray.style,{left:tray.x+'px',top:tray.top+'px',width:tray.width+'px',height:tray.height+'px'});
    boardDivider.style.left=frame.x+'px';
    boardDivider.style.width=frame.width+'px';
    boardDivider.style.top=(pTrayTopLeft.y-1)+'px';
    boardDivider.style.display='block';
    boardTitle.style.left=(frame.x+22)+'px';
    boardTitle.style.top =(frame.y+18)+'px';
    const slotCount=ROWS+1;
    buildSlots(slotCount);
    renderSlotLabels(slotCount, frame);
  }

  function initMatter(){
    engine=Engine.create({enableSleeping:false});
    world=engine.world;
    world.gravity.y=-Math.abs(GRAVITY_MAG);
    engine.positionIterations=8;
    engine.velocityIterations=6;
    engine.constraintIterations=2;
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
        const peg=Bodies.circle(x,y,PEG_RADIUS,{
          isStatic:true,restitution:PEG_RESTITUTION,friction:0.01
        });
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
      color:0x86f7ff,metalness:0.35,roughness:0.35,
      clearcoat:0.6,clearcoatRoughness:0.2,
      emissive:new THREE.Color(0x00ffff),
      emissiveIntensity:0.30
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
          fxMgr.addSparks(p2.x,p2.y,'#00f2ea',12);
        }
      }
      sfxBounce();
    }
    if(b.label==='KILL' && String(a.label||'').startsWith('BALL_')) tryRemoveBall(a);
  }

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
      }else if(avg<15 && currentPR<BASE_DEVICE_PR){
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
      if(target===2){
        bloomPass.enabled=NEON; bloomPass.strength=0.75; smaaPass.enabled=true;
      }else if(target===1){
        bloomPass.enabled=NEON; bloomPass.strength=0.45; smaaPass.enabled=true;
      }else{
        bloomPass.enabled=false; bloomPass.strength=0; smaaPass.enabled=false;
      }
    }
    if(perfPanel && perfData.frames%30===0){
      perfPanel.textContent=`fps:${(1000/perfData.avgMs).toFixed(1)} ms:${perfData.avgMs.toFixed(1)} pR:${currentPR.toFixed(2)} worst:${perfData.worstMs.toFixed(1)} q:${perfData.qualityTier}`;
    }
  }

  function startLoop(){
    let last=performance.now(),acc=0;
    function tick(now){
      const dt=Math.min(250,now-last); last=now; acc+=dt;
      let steps=0;
      const maxSteps=maxStepsForFrame(dt);
      while(acc>=FIXED_DT && steps<maxSteps){
        Engine.update(engine,FIXED_DT);
        acc-=FIXED_DT; steps++;
      }
      clampVelocities();
      fxMgr.update(fxCtx,dt);
      updateThreeFromMatter();
      const t0=performance.now();
      if(bloomPass.enabled || smaaPass.enabled) composer.render(); else renderer.render(scene,camera);
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

  function spawnBallSet({username,avatarUrl}){
    const multi=Math.max(1,Math.min(5,Number(optMultiDrop.value||1)));
    for(let i=0;i<multi;i++) spawnSingle({username,avatarUrl});
  }

  function spawnSingle({username,avatarUrl}){
    const jitter=PEG_SPACING*0.35;
    const dropX=Math.max(-BOARD_WIDTH/2+4,Math.min(BOARD_WIDTH/2-4,(Math.random()-0.5)*jitter));
    const dropY=TOP_ROW_Y + PEG_SPACING*0.8;
    const body=Bodies.circle(dropX,dropY,BALL_RADIUS,{
      restitution:BALL_RESTITUTION,friction:BALL_FRICTION,frictionAir:BALL_FRICTION_AIR,density:0.0018
    });
    body.label=`BALL_${username}`;
    body.plugin={username,avatarUrl,scored:false};
    World.add(world,body);
    dynamicBodies.add(body);
    Body.setVelocity(body,{x:0,y:0});
    Body.setAngularVelocity(body,0);

    if(!sharedBallBaseMaterial){
      sharedBallBaseMaterial=new THREE.MeshPhysicalMaterial({
        color:0xffffff,metalness:0.2,roughness:0.6,
        clearcoat:0.7,clearcoatRoughness:0.25,
        emissive:NEON?new THREE.Color(0x00c6ff):new THREE.Color(0x000000),
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
        if(!prom){
          prom=loadAvatarTexture(avatarUrl,128);
          avatarTextureCache.set(avatarUrl||'',prom);
        }
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
    }catch{}
  }

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

  function handleRedeemEvent(eventId, username, avatarUrl, tier){
    if(processedRedemptions.has(eventId)) return;
    processedRedemptions.add(eventId);
    const cost=REWARD_COSTS[tier];
    if(!cost) return;
    if(devFreeToggle.checked && (leaderboard[username]?.score||0) < cost){
      setPointsLocal(username, avatarUrl, cost);
    }
    if(!deductPoints(username, avatarUrl, cost)) return;
    enqueueRedemption(eventId, tier, username, avatarUrl);
  }

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
        const tier=command.split(':')[1];
        handleRedeemEvent(id,username,avatarUrl,tier);
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
              avatarUrl:entry.avatarUrl||'',
              score:entry.score||0,
              lastUpdate:entry.lastUpdate||0
            };
          }
        }
        refreshLeaderboard();
      } else clearLeaderboardLocal();
    });

    FirebaseREST.onValue('/config',(data)=>{
      const enabled=!!(data && data.spawnEnabled);
      spawnStatusEl.textContent=enabled?'true':'false';
      spawnStatusEl.style.color=enabled?'var(--good)':'var(--danger)';
    });
  }

  function sanitizeUsername(u){
    const s=String(u||'').trim();
    return s ? s.slice(0,24) : 'viewer';
  }

  function initTeasers(){
    initPBRTeasers({
      scene,
      camera,
      renderer,
      gsap,
      onCrateClick:(tier)=>devRedeem(tier,'ClickUser')
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
        else if(act.startsWith('redeem-')){
          devRedeem(act.split('-')[1],'DevUser');
        }
      });
    });
  }

  /* Draggable commands panel */
  function initCommandsPanelDrag(){
    if(!commandsPanel) return;
    const handle = commandsPanel.querySelector('.drag-handle') || commandsPanel;
    let dragging=false;
    let startX=0,startY=0;
    let originLeft=0, originTop=0;
    const overlay = document.getElementById('overlay');

    // Restore position if saved
    const savedX = localStorage.getItem('plk_cmd_left');
    const savedY = localStorage.getItem('plk_cmd_top');
    if(savedX && savedY){
      commandsPanel.classList.add('floating');
      commandsPanel.style.left=savedX+'px';
      commandsPanel.style.top =savedY+'px';
    }

    function pointerDown(e){
      if(e.button!==0) return;
      dragging=true;
      const rect=commandsPanel.getBoundingClientRect();
      const oRect=overlay.getBoundingClientRect();
      startX=e.clientX;
      startY=e.clientY;
      originLeft=rect.left - oRect.left;
      originTop =rect.top  - oRect.top;
      // Convert to floating absolute if not already
      if(!commandsPanel.classList.contains('floating')){
        commandsPanel.classList.add('floating');
        commandsPanel.style.left=originLeft+'px';
        commandsPanel.style.top =originTop +'px';
      }
      commandsPanel.classList.add('dragging');
      e.preventDefault();
    }
    function pointerMove(e){
      if(!dragging) return;
      const dx=e.clientX-startX;
      const dy=e.clientY-startY;
      const oRect=overlay.getBoundingClientRect();
      let newLeft=originLeft+dx;
      let newTop =originTop +dy;
      // Constrain
      const panelRect=commandsPanel.getBoundingClientRect();
      const w=panelRect.width;
      const h=panelRect.height;
      newLeft=Math.max(0,Math.min(oRect.width - w, newLeft));
      newTop =Math.max(0,Math.min(oRect.height - h, newTop));
      commandsPanel.style.left=newLeft+'px';
      commandsPanel.style.top =newTop +'px';
    }
    function pointerUp(){
      if(!dragging) return;
      dragging=false;
      commandsPanel.classList.remove('dragging');
      // Save
      const top=parseFloat(commandsPanel.style.top)||0;
      const left=parseFloat(commandsPanel.style.left)||0;
      localStorage.setItem('plk_cmd_left',String(left));
      localStorage.setItem('plk_cmd_top', String(top));
    }
    handle.addEventListener('pointerdown',pointerDown);
    window.addEventListener('pointermove',pointerMove);
    window.addEventListener('pointerup',pointerUp);
  }

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
      token?localStorage.setItem('adminToken',token):localStorage.removeItem('adminToken');
      alert('Saved admin settings.');
    }catch{ alert('Save failed.'); }
  });

  btnReset.addEventListener('click', async ()=>{
    const token=adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if(!token) return alert('Provide token.');
    try{
      const res=await adminFetch('/admin/reset-leaderboard',{method:'POST',headers:{'x-admin-token':token}});
      if(!res.ok) throw new Error();
      clearLeaderboardLocal();
      alert('Leaderboard reset.');
    }catch{ alert('Reset failed.'); }
  });

  btnToggleSpawn.addEventListener('click', async ()=>{
    const token=adminTokenInput.value || localStorage.getItem('adminToken') || '';
    if(!token) return alert('Provide token.');
    try{
      const curr=spawnStatusEl.textContent==='true';
      const res=await adminFetch(`/admin/spawn-toggle?enabled=${!curr}`,{method:'POST',headers:{'x-admin-token':token}});
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

  function start(){
    loadSettings();
    initThree();
    initMatter();
    listenToEvents();
    initTeasers();
    initDevPanel();
    initCommandsPanelDrag();
    startLoop();
  }
  start();
})();