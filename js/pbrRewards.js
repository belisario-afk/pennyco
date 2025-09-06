// pbrRewards.js - PBR teaser & redemption crates (enhanced, larger & fancier)
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

const HDRI_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_08_1k.hdr';

let pmremGenerator;
let envLoaded = false;
let envPromise = null;

const crates = [];
const crateByTier = new Map();
let sceneRef, cameraRef, gsapRef;

const TIER_ORDER = ['t3','t2','t1'];

const tierParams = {
  t1: { color: 0x995b24, emissive: 0x2a1608, metalness:0.9, roughness:0.48, accent:0xffb271 },
  t2: { color: 0xcad2da, emissive: 0x313a44, metalness:0.95, roughness:0.28, accent:0xffffff },
  t3: { color: 0xf7d25c, emissive: 0x3a2800, metalness:1.00, roughness:0.22, accent:0xfff3c4 }
};

// Larger scale
const TEASER_SCALE = 4.4;

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
  const body = new THREE.BoxGeometry(1,0.85,1,3,3,3);
  const lid  = new THREE.BoxGeometry(1,0.28,1,3,3,3);
  return { body, lid };
}

function createAccentEdges(size=1.02){
  const edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size*0.85, size));
  return edgesGeo;
}

function createCornerPosts(){
  const postGeo = new THREE.CylinderGeometry(0.07,0.07,0.9,10,1);
  return postGeo;
}

function makeLabelCanvas(tier){
  const params = tierParams[tier] || tierParams.t1;
  const canvas=document.createElement('canvas');
  canvas.width=512; canvas.height=256;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,512,256);
  ctx.font='900 120px Inter,Arial,sans-serif';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  // Background glow
  const grad=ctx.createRadialGradient(256,128,10,256,128,260);
  grad.addColorStop(0,'rgba(255,255,255,0.15)');
  grad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=grad;
  ctx.fillRect(0,0,512,256);
  // Stroke
  ctx.lineWidth=8;
  ctx.strokeStyle='rgba(0,0,0,0.6)';
  ctx.strokeText(tier.toUpperCase(),256,128);
  // Fill gradient
  const fill=ctx.createLinearGradient(60,0,452,0);
  if(tier==='t3'){
    fill.addColorStop(0,'#fff4cc');
    fill.addColorStop(0.5,'#f7d25c');
    fill.addColorStop(1,'#ffb23d');
  } else if(tier==='t2'){
    fill.addColorStop(0,'#ffffff');
    fill.addColorStop(0.5,'#d6e0e9');
    fill.addColorStop(1,'#9aa4af');
  } else {
    fill.addColorStop(0,'#ffddb8');
    fill.addColorStop(0.5,'#c97a32');
    fill.addColorStop(1,'#613610');
  }
  ctx.fillStyle=fill;
  ctx.fillText(tier.toUpperCase(),256,128);
  return canvas;
}

function createLabelMesh(tier){
  const canvas=makeLabelCanvas(tier);
  const tex=new THREE.CanvasTexture(canvas);
  tex.anisotropy=4;
  const mat=new THREE.MeshBasicMaterial({
    map:tex,
    transparent:true,
    depthWrite:false,
    side:THREE.DoubleSide
  });
  const geo=new THREE.PlaneGeometry(2.2,2.2*canvas.height/canvas.width);
  const mesh=new THREE.Mesh(geo,mat);
  mesh.position.set(0,1.25,0);
  mesh.renderOrder=1000;
  return mesh;
}

function createCrateMesh(tier, scale=TEASER_SCALE){
  const params=tierParams[tier] || tierParams.t1;
  const { body, lid } = makeCrateGeometry();
  const bodyMat=new THREE.MeshStandardMaterial({
    color:params.color,
    metalness:params.metalness,
    roughness:params.roughness,
    emissive:params.emissive,
    emissiveIntensity:0.3
  });
  const lidMat=bodyMat.clone();
  lidMat.emissiveIntensity=0.45;

  const bodyMesh=new THREE.Mesh(body, bodyMat);
  bodyMesh.name=`crateBody_${tier}`;
  const lidMesh=new THREE.Mesh(lid, lidMat);
  lidMesh.position.y=0.85/2 + 0.28/2 - 0.01;
  lidMesh.name=`crateLid_${tier}`;

  // Accent edges
  const edgesGeo=createAccentEdges();
  const edgeMat=new THREE.LineBasicMaterial({
    color:params.accent,
    transparent:true,
    opacity:0.55
  });
  const edges=new THREE.LineSegments(edgesGeo,edgeMat);

  // Corner posts
  const postsGeo=createCornerPosts();
  const postMat=new THREE.MeshStandardMaterial({
    color:params.accent,
    metalness:1.0,
    roughness:0.25,
    emissive:params.accent,
    emissiveIntensity:0.4
  });
  const postPositions=[
    [0.48,0,0.48],
    [-0.48,0,0.48],
    [0.48,0,-0.48],
    [-0.48,0,-0.48]
  ];
  const postGroup=new THREE.Group();
  postPositions.forEach(p=>{
    const m=new THREE.Mesh(postsGeo,postMat.clone());
    m.position.set(p[0],0,p[2]);
    postGroup.add(m);
  });

  // Base ring
  const ringGeo=new THREE.TorusGeometry(0.95,0.06,14,50);
  const ringMat=new THREE.MeshStandardMaterial({
    color:params.accent,
    metalness:1.0,
    roughness:0.18,
    emissive:params.accent,
    emissiveIntensity:0.25
  });
  const ring=new THREE.Mesh(ringGeo,ringMat);
  ring.rotation.x=Math.PI/2;
  ring.position.y=-0.48;

  const label=createLabelMesh(tier);

  const group=new THREE.Group();
  group.add(ring);
  group.add(bodyMesh);
  group.add(lidMesh);
  group.add(edges);
  group.add(postGroup);
  group.add(label);

  group.scale.setScalar(scale);
  group.userData={ tier, body:bodyMesh, lid:lidMesh, label, teaser:true, opened:false };
  return group;
}

function animateTeaserIdle(crate){
  if(!gsapRef) return;
  const tier=crate.userData.tier;
  const floatAmp=tier==='t3'?0.28: tier==='t2'?0.22: 0.18;
  const dur=tier==='t3'?3.6: tier==='t2'?4.2:4.6;
  const startY=crate.position.y;
  gsapRef.to(crate.position,{
    y:startY + floatAmp,
    duration:dur/2,
    ease:'sine.inOut',
    yoyo:true,
    repeat:-1
  });
  gsapRef.to(crate.rotation,{
    y:crate.rotation.y + (tier==='t3'?Math.PI*2:Math.PI),
    duration:tier==='t3'?14:20,
    ease:'linear',
    repeat:-1
  });
  // Label subtle bob & flicker
  if(crate.userData.label){
    const lbl=crate.userData.label;
    const baseY=lbl.position.y;
    gsapRef.to(lbl.position,{
      y:baseY + 0.2,
      duration:2.4,
      ease:'sine.inOut',
      yoyo:true,
      repeat:-1
    });
    gsapRef.to(lbl.material,{
      opacity:0.65,
      duration:1.8,
      ease:'sine.inOut',
      yoyo:true,
      repeat:-1
    });
  }
  // Pulsing emissive loops
  const allMeshes=[];
  crate.traverse(o=>{ if(o.isMesh && o.material?.emissive) allMeshes.push(o); });
  allMeshes.forEach((m,i)=>{
    gsapRef.to(m.material,{
      emissiveIntensity: m.material.emissiveIntensity*2.2,
      duration: 2.2 + i*0.15,
      ease:'sine.inOut',
      yoyo:true,
      repeat:-1
    });
  });
}

export function initPBRTeasers({scene,camera,renderer,gsap,onCrateClick}){
  sceneRef=scene; cameraRef=camera; gsapRef=gsap;
  loadEnvironment(renderer).then(env=>{
    scene.environment=env;
    scene.background=null;
  }).catch(()=>{});

  if(crates.length===0){
    let idx=0;
    TIER_ORDER.forEach(tier=>{
      const crate=createCrateMesh(tier, TEASER_SCALE);
      crates.push(crate);
      crateByTier.set(tier,crate);
      scene.add(crate);
      animateTeaserIdle(crate);
      crate.userData.onClick=()=>onCrateClick?.(tier);
      // Pop-in
      crate.scale.multiplyScalar(0.01);
      gsap.fromTo(crate.scale,
        { x:crate.scale.x, y:crate.scale.y, z:crate.scale.z },
        { x:TEASER_SCALE, y:TEASER_SCALE, z:TEASER_SCALE,
          duration:1.0,
          ease:'back.out(1.9)',
          delay:0.18*idx
        });
      idx++;
    });
  }
  updateTeaserLayout();
}

export function updateTeaserLayout(){
  if(!cameraRef || crates.length===0) return;
  const right=cameraRef.right;
  const top=cameraRef.top;
  const marginX=8;
  const baseX=right - marginX;
  const startY=top - 14;
  const gap= (TEASER_SCALE * 2.4); // dynamic spacing
  crates.forEach((c,i)=>{
    c.position.set(baseX, startY - i*gap, 0);
  });
}

export function raycastTeasers(raycaster){
  const hits=raycaster.intersectObjects(crates,true);
  if(!hits.length) return;
  let obj=hits[0].object;
  while(obj && !obj.userData?.teaser){
    obj=obj.parent;
  }
  if(obj?.userData?.onClick){
    obj.userData.onClick();
    gsapRef.to(obj.rotation,{
      x:obj.rotation.x+0.55,
      duration:0.25,
      ease:'back.out(2)',
      yoyo:true,
      repeat:1
    });
  }
}

export function createRedemptionCrate(tier){
  const crate=createCrateMesh(tier, 11.5);
  crate.userData.teaser=false;
  crate.userData.opened=false;
  crate.traverse(o=>{
    if(o.isMesh && o.material?.emissive){
      o.material.emissiveIntensity *= 2.2;
    }
  });
  // Static label stays
  return crate;
}

export function animateCrateEntrance(crate, gsap){
  crate.scale.multiplyScalar(0.01);
  gsap.to(crate.scale,{
    x:crate.scale.x*100,
    y:crate.scale.y*100,
    z:crate.scale.z*100,
    duration:0.85,
    ease:'back.out(2)'
  });
  gsap.fromTo(crate.rotation,
    { y:crate.rotation.y + Math.PI*2 },
    { y:crate.rotation.y, duration:1.2, ease:'expo.out' }
  );
}

export function openCrate(crate, gsap){
  return new Promise(res=>{
    if(crate.userData.opened){ res(); return; }
    crate.userData.opened=true;
    const lid=crate.userData.lid || crate.children.find(c=>c.name.includes('crateLid'));
    if(!lid){ res(); return; }
    gsap.to(lid.rotation,{
      x:-Math.PI*0.95,
      duration:0.7,
      ease:'back.in(1.15)',
      onComplete:res
    });
    // Burst scale flash
    gsap.fromTo(crate.scale,
      { x:crate.scale.x*1.0, y:crate.scale.y*1.0, z:crate.scale.z*1.0 },
      { x:crate.scale.x*1.06,y:crate.scale.y*1.06,z:crate.scale.z*1.06,
        duration:0.28,
        yoyo:true,
        repeat:1,
        ease:'sine.inOut'
      });
  });
}

export function disposeRedemptionCrate(crate, gsap){
  if(!crate) return;
  gsap.to(crate.scale,{
    x:crate.scale.x*0.01,
    y:crate.scale.y*0.01,
    z:crate.scale.z*0.01,
    duration:0.55,
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