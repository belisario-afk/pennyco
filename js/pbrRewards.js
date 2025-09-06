/* Matte crates (unchanged from last matte update except no logic changes) */
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { sfxCrateOpen } from './utils.js';

const HDRI_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_08_1k.hdr';

let pmremGenerator;
let envLoaded = false;
let envPromise = null;

const crates = [];
const crateByTier = new Map();
let sceneRef, cameraRef, gsapRef;

const TIER_ORDER = ['t3','t2','t1'];
let teaserScale = 4.4;

const tierParams = {
  t1: { color: 0x855024, emissive: 0x1c1006, metalness:0.15, roughness:0.86, accent:0xd08c54 },
  t2: { color: 0xb2bac2, emissive: 0x202830, metalness:0.12, roughness:0.88, accent:0xcfdae2 },
  t3: { color: 0xd8b750, emissive: 0x1e1400, metalness:0.18, roughness:0.84, accent:0xe7d8a7 }
};

export function setTeaserScale(s){
  teaserScale = Math.max(1.5, Math.min(10, s));
  crates.forEach(c => c.scale.setScalar(teaserScale));
  updateTeaserLayout();
}

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
  return new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size*0.85, size));
}
function createCornerPosts(){
  return new THREE.CylinderGeometry(0.065,0.065,0.9,10,1);
}

function makeLabelCanvas(tier){
  const canvas=document.createElement('canvas');
  canvas.width=512; canvas.height=256;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,512,256);
  ctx.font='900 118px Inter,Arial,sans-serif';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  const grad=ctx.createRadialGradient(256,128,10,256,128,230);
  grad.addColorStop(0,'rgba(255,255,255,0.05)');
  grad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=grad;
  ctx.fillRect(0,0,512,256);
  ctx.lineWidth=4;
  ctx.strokeStyle='rgba(0,0,0,0.35)';
  ctx.strokeText(tier.toUpperCase(),256,128);
  const fill=ctx.createLinearGradient(80,0,432,0);
  if(tier==='t3'){
    fill.addColorStop(0,'#f5e7bf'); fill.addColorStop(0.5,'#d8b750'); fill.addColorStop(1,'#c39235');
  }else if(tier==='t2'){
    fill.addColorStop(0,'#ffffff'); fill.addColorStop(0.5,'#d0d8de'); fill.addColorStop(1,'#88949f');
  }else{
    fill.addColorStop(0,'#edc79d'); fill.addColorStop(0.5,'#a9632b'); fill.addColorStop(1,'#44240f');
  }
  ctx.fillStyle=fill;
  ctx.fillText(tier.toUpperCase(),256,128);
  return canvas;
}
function createLabelMesh(tier){
  const canvas=makeLabelCanvas(tier);
  const tex=new THREE.CanvasTexture(canvas);
  tex.anisotropy=4;
  const mat=new THREE.MeshBasicMaterial({ map:tex, transparent:true, depthWrite:false, opacity:0.78 });
  const geo=new THREE.PlaneGeometry(2.05,2.05*canvas.height/canvas.width);
  const mesh=new THREE.Mesh(geo,mat);
  mesh.position.set(0,1.18,0);
  mesh.renderOrder=40;
  return mesh;
}

function createCrateMesh(tier, scale=teaserScale){
  const p=tierParams[tier] || tierParams.t1;
  const { body, lid }=makeCrateGeometry();

  const bodyMat=new THREE.MeshStandardMaterial({
    color:p.color,
    metalness:p.metalness,
    roughness:p.roughness,
    emissive:p.emissive,
    emissiveIntensity:0.035,
    envMapIntensity:0.25
  });
  const lidMat=bodyMat.clone();
  lidMat.emissiveIntensity=0.045;
  lidMat.roughness = Math.min(0.95, lidMat.roughness + 0.05);

  const bodyMesh=new THREE.Mesh(body, bodyMat);
  bodyMesh.name=`crateBody_${tier}`;
  const lidMesh=new THREE.Mesh(lid, lidMat);
  lidMesh.position.y=0.85/2 + 0.28/2 - 0.01;
  lidMesh.name=`crateLid_${tier}`;

  const edgesGeo=createAccentEdges();
  const edgeMat=new THREE.LineBasicMaterial({ color:p.accent, transparent:true, opacity:0.18 });
  const edges=new THREE.LineSegments(edgesGeo,edgeMat);

  const postsGeo=createCornerPosts();
  const postMat=new THREE.MeshStandardMaterial({
    color:p.accent,
    metalness:0.12,
    roughness:0.9,
    emissive:p.accent,
    emissiveIntensity:0.03,
    envMapIntensity:0.2
  });
  const postPositions=[[0.48,0,0.48],[-0.48,0,0.48],[0.48,0,-0.48],[-0.48,0,-0.48]];
  const postGroup=new THREE.Group();
  postPositions.forEach(pos=>{
    const mesh=new THREE.Mesh(postsGeo,postMat.clone());
    mesh.position.set(pos[0],0,pos[2]);
    postGroup.add(mesh);
  });

  const ringGeo=new THREE.TorusGeometry(0.92,0.04,10,36);
  const ringMat=new THREE.MeshStandardMaterial({
    color:p.accent,
    metalness:0.15,
    roughness:0.88,
    emissive:p.accent,
    emissiveIntensity:0.025,
    envMapIntensity:0.2
  });
  const ring=new THREE.Mesh(ringGeo,ringMat);
  ring.rotation.x=Math.PI/2;
  ring.position.y=-0.48;

  const label=createLabelMesh(tier);

  const group=new THREE.Group();
  group.add(ring,bodyMesh,lidMesh,edges,postGroup,label);
  group.scale.setScalar(scale);
  group.userData={ tier, body:bodyMesh, lid:lidMesh, label, teaser:true, opened:false };

  return group;
}

function animateTeaserIdle(crate){
  if(!gsapRef) return;
  const tier=crate.userData.tier;
  const floatAmp=tier==='t3'?0.16: tier==='t2'?0.14: 0.12;
  const dur=tier==='t3'?5.8: tier==='t2'?6.2:6.6;
  const startY=crate.position.y;
  gsapRef.to(crate.position,{
    y:startY+floatAmp,duration:dur/2,ease:'sine.inOut',repeat:-1,yoyo:true
  });
  gsapRef.to(crate.rotation,{
    y:crate.rotation.y + (tier==='t3'?Math.PI:Math.PI*0.75),
    duration:tier==='t3'?34:40,ease:'linear',repeat:-1
  });
}

export function initPBRTeasers({scene,camera,renderer,gsap,onCrateClick,initialScale}){
  sceneRef=scene; cameraRef=camera; gsapRef=gsap;
  if(typeof initialScale==='number') teaserScale=initialScale;
  loadEnvironment(renderer).then(env=>{
    scene.environment=env;
    scene.background=null;
  }).catch(()=>{});
  if(crates.length===0){
    let i=0;
    TIER_ORDER.forEach(tier=>{
      const crate=createCrateMesh(tier, teaserScale);
      crates.push(crate);
      crateByTier.set(tier,crate);
      scene.add(crate);
      animateTeaserIdle(crate);
      crate.userData.onClick=()=>onCrateClick?.(tier);
      crate.scale.multiplyScalar(0.01);
      gsap.fromTo(crate.scale,
        {x:crate.scale.x,y:crate.scale.y,z:crate.scale.z},
        {x:teaserScale,y:teaserScale,z:teaserScale,
         duration:0.7,ease:'back.out(1.5)',delay:0.10*i});
      i++;
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
  const gap=(teaserScale*2.2);
  crates.forEach((c,i)=>c.position.set(baseX, startY - i*gap, 0));
}

export function raycastTeasers(raycaster){
  const hits=raycaster.intersectObjects(crates,true);
  if(!hits.length) return;
  let o=hits[0].object;
  while(o && !o.userData?.teaser) o=o.parent;
  if(o?.userData?.onClick){
    o.userData.onClick();
    gsapRef.to(o.rotation,{
      x:o.rotation.x+0.35,duration:0.25,ease:'back.out(2)',yoyo:true,repeat:1
    });
  }
}

function bringCrateToFront(crate){
  crate.position.z = 40;
  crate.traverse(obj=>{
    if(obj.isMesh){
      obj.renderOrder = 2000;
      obj.material.depthTest = false;
      obj.material.depthWrite = false;
      obj.material.transparent = true;
      if(obj.material.emissiveIntensity){
        obj.material.emissiveIntensity = Math.min(0.07, obj.material.emissiveIntensity);
      }
      obj.material.envMapIntensity = 0.18;
    }
    if(obj.isLineSegments){
      obj.renderOrder = 2001;
    }
  });
  if(crate.userData?.label){
    crate.userData.label.renderOrder = 2100;
  }
}

export function createRedemptionCrate(tier){
  const crate=createCrateMesh(tier, teaserScale * 2.4);
  crate.userData.teaser=false;
  crate.userData.opened=false;
  bringCrateToFront(crate);
  return crate;
}
export function animateCrateEntrance(crate,gsap){
  crate.scale.multiplyScalar(0.01);
  gsap.to(crate.scale,{
    x:crate.scale.x*100,y:crate.scale.y*100,z:crate.scale.z*100,
    duration:0.6,ease:'back.out(2)'
  });
  gsap.fromTo(crate.rotation,
    {y:crate.rotation.y + Math.PI*1.4},
    {y:crate.rotation.y,duration:0.85,ease:'expo.out'}
  );
}
export function openCrate(crate,gsap){
  return new Promise(res=>{
    if(crate.userData.opened){ res(); return; }
    crate.userData.opened=true;
    const lid=crate.userData.lid || crate.children.find(c=>c.name.includes('crateLid'));
    if(!lid){ res(); return; }
    sfxCrateOpen();
    gsap.to(lid.rotation,{
      x:-Math.PI*0.83,duration:0.5,ease:'back.in(1.05)',onComplete:res
    });
    gsap.fromTo(crate.scale,
      {x:crate.scale.x,y:crate.scale.y,z:crate.scale.z},
      {x:crate.scale.x*1.03,y:crate.scale.y*1.03,z:crate.scale.z*1.03,
       duration:0.20,yoyo:true,repeat:1,ease:'sine.inOut'});
  });
}
export function disposeRedemptionCrate(crate,gsap){
  if(!crate) return;
  gsap.to(crate.scale,{
    x:crate.scale.x*0.01,y:crate.scale.y*0.01,z:crate.scale.z*0.01,
    duration:0.4,ease:'power2.in',
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