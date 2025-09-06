// pbrRewards.js
// Handles PBR teaser crates (tiers) and redemption crate creation/open animation.
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

const HDRI_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_08_1k.hdr';

let pmremGenerator;
let envLoaded = false;
let envPromise = null;

const crates = []; // teaser crates
const crateByTier = new Map();
let sceneRef, cameraRef, gsapRef;

const TIER_ORDER = ['t3','t2','t1'];

const tierParams = {
  t1: { color: 0x9d632f, emissive: 0x231309, metalness:0.8,  roughness:0.45 },
  t2: { color: 0xbfc4ce, emissive: 0x222a31, metalness:0.9,  roughness:0.32 },
  t3: { color: 0xf7d25c, emissive: 0x362400, metalness:1.0,  roughness:0.25 }
};

function loadEnvironment(renderer){
  if(envLoaded) return Promise.resolve();
  if(envPromise) return envPromise;
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  envPromise = new Promise((resolve,reject)=>{
    new RGBELoader().load(HDRI_URL,(hdr)=>{
      const envMap = pmremGenerator.fromEquirectangular(hdr).texture;
      hdr.dispose();
      envLoaded = true;
      resolve(envMap);
    },undefined,(e)=>reject(e));
  });
  return envPromise;
}

function makeCrateGeometry(){
  // Simple low-poly crate: base + lid separate.
  const body = new THREE.BoxGeometry(1,0.8,1, 2,2,2);
  const lid  = new THREE.BoxGeometry(1,0.25,1, 2,2,2);
  // Frame/edge (thin) using edges + line or separate geometry:
  const edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02,0.82,1.02));
  return { body, lid, edgesGeo };
}

function createCrateMesh(tier, scale=1){
  const params = tierParams[tier] || tierParams.t1;
  const { body, lid, edgesGeo } = makeCrateGeometry();

  const mat = new THREE.MeshStandardMaterial({
    color: params.color,
    metalness: params.metalness,
    roughness: params.roughness,
    emissive: params.emissive,
    emissiveIntensity: 0.25
  });

  const bodyMesh = new THREE.Mesh(body, mat.clone());
  bodyMesh.name = `crateBody_${tier}`;
  const lidMesh  = new THREE.Mesh(lid, mat.clone());
  lidMesh.position.y = 0.8/2 + 0.25/2 - 0.01;
  lidMesh.name = `crateLid_${tier}`;

  // Edges overlay
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent:true, opacity:0.35 });
  const edgeLines = new THREE.LineSegments(edgesGeo, edgeMat);
  edgeLines.position.y = 0;

  const group = new THREE.Group();
  group.add(bodyMesh);
  group.add(lidMesh);
  group.add(edgeLines);
  group.scale.setScalar(scale);
  group.userData = { tier, body: bodyMesh, lid: lidMesh, opened:false };

  return group;
}

function animateTeaserIdle(crate){
  if(!gsapRef) return;
  const tier = crate.userData.tier;
  const floatAmp = tier==='t3'?0.22: tier==='t2'?0.16: 0.12;
  const dur = tier==='t3'?3.8: tier==='t2'?4.4:4.8;
  const startY = crate.position.y;
  gsapRef.to(crate.position,{
    y:startY + floatAmp,
    duration:dur/2,
    ease:'sine.inOut',
    yoyo:true,
    repeat:-1
  });
  // Slow rotation
  gsapRef.to(crate.rotation,{
    y: crate.rotation.y + (tier==='t3'?Math.PI*2:Math.PI),
    duration: tier==='t3'?16:22,
    ease:'linear',
    repeat:-1
  });
  // Pulsing emissive
  const lids = [];
  crate.traverse(o=>{
    if(o.isMesh) lids.push(o);
  });
  lids.forEach(m=>{
    gsapRef.to(m.material,{
      emissiveIntensity: 0.7,
      duration:2.4,
      ease:'sine.inOut',
      yoyo:true,
      repeat:-1
    });
  });
}

export function initPBRTeasers({ scene, camera, renderer, gsap, onCrateClick }){
  sceneRef = scene; cameraRef = camera; gsapRef = gsap;
  loadEnvironment(renderer).then(env=>{
    scene.environment = env;
    scene.background = null;
  }).catch(()=>{});

  // Create crates only once
  if(crates.length===0){
    let idx=0;
    TIER_ORDER.forEach(tier=>{
      const crate = createCrateMesh(tier, 3.2);
      crates.push(crate);
      crateByTier.set(tier, crate);
      scene.add(crate);
      animateTeaserIdle(crate);
      crate.userData.onClick = ()=>onCrateClick?.(tier);
      crate.userData.teaser = true;
      // Scale intro
      crate.scale.multiplyScalar(0.01);
      gsap.fromTo(crate.scale,
        { x:crate.scale.x, y:crate.scale.y, z:crate.scale.z },
        { x:3.2, y:3.2, z:3.2, duration:0.9, ease:'back.out(1.8)', delay:0.15*idx});
      idx++;
    });
  }
  updateTeaserLayout();
}

export function updateTeaserLayout(){
  if(!cameraRef || crates.length===0) return;
  // Position crates along right side vertically stacked.
  // Use camera orthographic extents.
  const right = cameraRef.right;
  const top = cameraRef.top;
  const marginX = 6; // world units
  const baseX = right - marginX;
  const startY = top - 18;
  const gap = 16;

  crates.forEach((c,i)=>{
    c.position.set(baseX, startY - i*gap, 0);
  });
}

export function raycastTeasers(raycaster){
  const hits = raycaster.intersectObjects(crates, true);
  if(!hits.length) return;
  // find crate group
  const first = hits[0].object;
  let g = first;
  while(g && !g.userData?.teaser){
    g = g.parent;
  }
  if(g && g.userData.onClick){
    g.userData.onClick();
    // Click feedback
    gsapRef.to(g.rotation,{x:g.rotation.x+0.6, duration:0.25, ease:'back.out(2)', yoyo:true, repeat:1});
  }
}

/* Redemption crate (ephemeral) */
export function createRedemptionCrate(tier){
  const crate = createCrateMesh(tier, 10);
  crate.userData.teaser = false;
  crate.userData.opened = false;
  // Stronger glow
  crate.traverse(o=>{
    if(o.isMesh){
      o.material.emissiveIntensity = 0.9;
    }
  });
  return crate;
}

export function animateCrateEntrance(crate, gsap){
  crate.scale.multiplyScalar(0.01);
  gsap.to(crate.scale,{
    x:crate.scale.x*100,
    y:crate.scale.y*100,
    z:crate.scale.z*100,
    duration:0.7,
    ease:'back.out(1.8)'
  });
  gsap.fromTo(crate.rotation,{y:crate.rotation.y + Math.PI*2},{y:crate.rotation.y, duration:1.1, ease:'expo.out'});
}

export function openCrate(crate, gsap){
  return new Promise(res=>{
    if(crate.userData.opened){ res(); return; }
    crate.userData.opened=true;
    const lid = crate.userData.lid || crate.children.find(c=>c.name.includes('crateLid'));
    if(!lid){ res(); return; }
    gsap.to(lid.rotation,{
      x:-Math.PI*0.9,
      duration:0.65,
      ease:'back.in(1.1)',
      onComplete:res
    });
  });
}

export function disposeRedemptionCrate(crate, gsap){
  if(!crate) return;
  gsap.to(crate.scale,{
    x:crate.scale.x*0.01,
    y:crate.scale.y*0.01,
    z:crate.scale.z*0.01,
    duration:0.45,
    ease:'power2.in',
    onComplete:()=>{
      crate.parent?.remove(crate);
      crate.traverse(o=>{
        if(o.isMesh){
          o.geometry?.dispose();
          if(o.material?.map) o.material.map.dispose();
          o.material?.dispose();
        }
      });
    }
  });
}