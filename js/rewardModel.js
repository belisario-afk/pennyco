/* rewardModel.js (Updated to support external GLB prizes, incl. Among Us model for T1)

   Overview:
   - Previously you instantiated a reward model by passing a numeric "seed" (16 / 19 / 22 etc.).
   - This module now supports:
       * Legacy param-based placeholder models (simple generated geometry) so existing tiers still work.
       * GLB-based prizes (loaded via GLTFLoader) with per‑tier weighted random selection.

   New Prize Added:
     Tier 1 now includes the GLB model: amongus_sexy_female.glb
     (Add the file to: ./assets/models/amongus_sexy_female.glb)

   If you prefer to load directly from GitHub instead of bundling locally,
   set USE_REMOTE_ASSET = true and provide RAW_GITHUB_URL below (must allow CORS).

   Exported API (same names kept for game.js compatibility):
     ensureRewardModelLoaded(): Promise<void>  (no-op now, returns immediately)
     createRewardModelInstance(tierOrConfig): THREE.Object3D
     animateRewardModel(model, gsapLib): () => void  (returns a dispose function)

   Integration:
     game.js was updated to call: createRewardModelInstanceForTier(tier) (wrapper inside)
     but we keep createRewardModelInstance for backward compatibility.

   NOTE:
     The model may be large. Consider DRACO / Meshopt compression if performance is an issue.
*/

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/* -----------------------------------
   CONFIG
------------------------------------ */

// If true, we load the Among Us GLB from GitHub raw URL (must be accessible w/ CORS)
// Otherwise we load from local assets folder: ./assets/models/amongus_sexy_female.glb
const USE_REMOTE_ASSET = false;

// Raw GitHub URL (pin to commit for stability)
const RAW_GITHUB_URL = 'https://raw.githubusercontent.com/belisario-afk/try240/8818647213c54a5b2a2437903257bd068ff89d88/amongus_sexy_female.glb';

// Local relative path (place the .glb file here)
const LOCAL_ASSET_PATH = 'assets/models/amongus_sexy_female.glb';

/**
 * Prize catalog defines each tier's randomizable prize entries.
 * Each entry can be one of:
 *   { type:'legacy', seed:16 }
 *   { type:'glb', id:'amongus_female', src:'assets/...glb', baseScale:1, yOffset:0 }
 * You can assign 'weight' for probability (default 1).
 */
const PRIZE_CATALOG = {
  t1: [
    { type: 'legacy', seed: 16, weight: 2 },        // Keep old fallback / standard small prize
    { type: 'glb',
      id: 'amongus_female',
      src: USE_REMOTE_ASSET ? RAW_GITHUB_URL : LOCAL_ASSET_PATH,
      baseScale: 1,
      yOffset: 0,
      weight: 3 }                                   // Slightly higher chance than legacy (adjust as needed)
  ],
  t2: [
    { type: 'legacy', seed: 19, weight: 1 }
  ],
  t3: [
    { type: 'legacy', seed: 22, weight: 1 }
  ]
};

// Cache for loaded GLTF scenes
const gltfCache = new Map();
// Dedicated GLTF loader
const gltfLoader = new GLTFLoader();

/* -----------------------------------
   PUBLIC API (legacy signatures preserved)
------------------------------------ */

/**
 * ensureRewardModelLoaded
 * Previously used to pre-load shared resources.
 * Now it's effectively a no-op but kept for compatibility.
 */
export async function ensureRewardModelLoaded(){
  return;
}

/**
 * Backwards compatibility: old code passed an integer seed (16/19/22).
 * We still accept numbers, or a prize config object.
 */
export function createRewardModelInstance(seedOrConfig){
  if(typeof seedOrConfig === 'object' && seedOrConfig){
    return instantiatePrize(seedOrConfig);
  }
  // Numeric path (legacy)
  return buildLegacySeedModel(seedOrConfig || 16);
}

/**
 * New helper: chooses a random prize for a tier and instantiates it.
 */
export function createRewardModelInstanceForTier(tier='t1'){
  const list = PRIZE_CATALOG[tier] || PRIZE_CATALOG.t1;
  const prizeConfig = weightedRandom(list);
  return instantiatePrize(prizeConfig);
}

/**
 * animateRewardModel
 * Basic bobbing & slow rotation animation for visual flair.
 * Returns: dispose function (stop animation).
 */
export function animateRewardModel(model, gsap){
  if(!gsap || !model) return ()=>{};
  const rotTween = gsap.to(model.rotation,{
    y: model.rotation.y + Math.PI*2,
    duration: 12,
    ease: 'none',
    repeat: -1
  });
  const baseY = model.position.y;
  const bobTween = gsap.to(model.position,{
    y: baseY + 2.2,
    duration: 2.4,
    ease: 'sine.inOut',
    yoyo: true,
    repeat: -1
  });
  return ()=>{
    rotTween?.kill();
    bobTween?.kill();
  };
}

/* -----------------------------------
   INTERNAL HELPERS
------------------------------------ */

function weightedRandom(arr){
  if(!arr || !arr.length) return null;
  const total = arr.reduce((s,a)=>s+(a.weight||1),0);
  let r=Math.random()*total;
  for(const item of arr){
    r -= (item.weight||1);
    if(r<=0) return item;
  }
  return arr[arr.length-1];
}

function instantiatePrize(cfg){
  if(!cfg) return buildLegacySeedModel(16);
  if(cfg.type === 'glb'){
    return buildGLBWrapper(cfg);
  }
  // fallback to legacy
  return buildLegacySeedModel(cfg.seed || 16);
}

/**
 * Legacy seed-based placeholder model.
 * Creates a stylized layered mesh to differentiate tiers by seed number.
 */
function buildLegacySeedModel(seed){
  const group=new THREE.Group();
  group.name='LegacyPrize_'+seed;
  const colorSeed = (seed*9301 + 49297) % 0xFFFFFF;
  const primaryColor = new THREE.Color(colorSeed);
  const secondaryColor = primaryColor.clone().offsetHSL(0.15,0,0.1);

  // Base body
  const coreGeo = new THREE.IcosahedronGeometry(12, 2);
  const coreMat = new THREE.MeshPhysicalMaterial({
    color: primaryColor,
    metalness: 0.55,
    roughness: 0.35,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
    emissive: primaryColor.clone().multiplyScalar(0.2),
    emissiveIntensity: 0.4
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  group.add(core);

  // Rings
  const ringCount = seed % 4 + 2;
  for(let i=0;i<ringCount;i++){
    const rGeo = new THREE.TorusGeometry(14 + i*2.2, 1.1, 12, 48);
    const rMat = new THREE.MeshStandardMaterial({
      color: secondaryColor.clone().offsetHSL(i*0.03,0,0),
      metalness: 0.6,
      roughness: 0.25,
      emissive: secondaryColor.clone().multiplyScalar(0.15),
      emissiveIntensity: 0.4
    });
    const ring=new THREE.Mesh(rGeo,rMat);
    ring.rotation.x = Math.random()*Math.PI;
    ring.rotation.y = Math.random()*Math.PI;
    group.add(ring);
  }

  group.scale.setScalar(0.6);
  return group;
}

/**
 * Wraps a GLB prize in a group (to allow uniform animation regardless of load time).
 * Returns a group immediately; adds placeholder + swaps when model loads.
 */
function buildGLBWrapper(cfg){
  const wrapper = new THREE.Group();
  wrapper.name = 'GLBPrize_'+cfg.id;

  // Placeholder spinner
  const placeholder = buildLoadingPlaceholder();
  wrapper.add(placeholder);

  loadGLBPrize(cfg).then(gltfScene=>{
    if(!gltfScene) return;
    wrapper.remove(placeholder);
    placeholder.traverse(obj=>{
      if(obj.isMesh){
        obj.geometry?.dispose();
        obj.material?.dispose();
      }
    });

    // Center & scale
    normalizeAndApplyConfig(gltfScene, cfg);

    wrapper.add(gltfScene);
  }).catch(()=>{/* ignore load failure, keep placeholder */});

  return wrapper;
}

function buildLoadingPlaceholder(){
  const g=new THREE.Group();
  const geom=new THREE.RingGeometry(4,6,32);
  const mat=new THREE.MeshBasicMaterial({color:0x00f2ea, transparent:true, opacity:0.85});
  const ring=new THREE.Mesh(geom,mat);
  g.add(ring);
  let angle=0;
  // Very lightweight manual spinner (actual rotation handled outside if needed)
  Object.defineProperty(g,'_spinner',{
    value: function spin(dt){
      angle += dt*0.005;
      ring.rotation.z = angle;
    }, writable:false
  });
  return g;
}

async function loadGLBPrize(cfg){
  if(gltfCache.has(cfg.src)) return gltfCache.get(cfg.src).clone(true);
  const scene = await new Promise((resolve,reject)=>{
    gltfLoader.load(
      cfg.src,
      gltf=>{
        // Cache original scene
        gltfCache.set(cfg.src, gltf.scene);
        resolve(gltf.scene.clone(true));
      },
      undefined,
      err=>reject(err)
    );
  });
  return scene;
}

function normalizeAndApplyConfig(scene, cfg){
  // Compute bounding box to normalize scale
  const box=new THREE.Box3().setFromObject(scene);
  const size=new THREE.Vector3();
  box.getSize(size);
  const maxDim=Math.max(size.x,size.y,size.z) || 1;

  // Target nominal size ~ 30 units tall
  const desired=30;
  const scale = (desired / maxDim) * (cfg.baseScale || 1);
  scene.scale.setScalar(scale);

  // Recenter vertically (optional)
  box.setFromObject(scene);
  const center=new THREE.Vector3();
  box.getCenter(center);
  // move so base sits roughly at y=0
  const yOffset = (box.min.y)*scale;
  scene.position.y -= (center.y*scale) + yOffset + (cfg.yOffset||0);

  // Add subtle material tweak (optional emissive if present)
  scene.traverse(obj=>{
    if(obj.isMesh){
      obj.castShadow=false;
      obj.receiveShadow=false;
      if(obj.material && !Array.isArray(obj.material)){
        obj.material.emissive ||= new THREE.Color(0x000000);
        obj.material.emissiveIntensity ||= 0.25;
      }
    }
  });
}
