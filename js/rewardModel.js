import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_PATH = './tripo_pbr_model_b12fdae2-6adb-46bb-98bc-ebf0f5cd9e55.glb';
const EXTRA_YAW_DEG = 40;
const EXTRA_YAW_RAD = THREE.MathUtils.degToRad(EXTRA_YAW_DEG);

let loadPromise = null;
let cachedScene = null;
let boundingBox = null;

export function ensureRewardModelLoaded() {
  if (cachedScene) return Promise.resolve(cachedScene);
  if (loadPromise) return loadPromise;
  const loader = new GLTFLoader();
  loadPromise = new Promise((resolve, reject) => {
    loader.load(
      MODEL_PATH,
      (gltf) => {
        cachedScene = gltf.scene || gltf.scenes?.[0];
        if (!cachedScene) { reject(new Error('No scene in GLB')); return; }
        cachedScene.traverse(obj=>{
          if(obj.isMesh){
            obj.castShadow=false;
            obj.receiveShadow=false;
            if(obj.material){
              obj.material.transparent=true;
              obj.material.depthWrite=true;
            }
          }
        });
        boundingBox = new THREE.Box3().setFromObject(cachedScene);
        resolve(cachedScene);
      },
      undefined,
      (err)=>reject(err||new Error('Failed to load GLB'))
    );
  });
  return loadPromise;
}

export function createRewardModelInstance(targetHeight=16){
  if(!cachedScene) throw new Error('Model not loaded yet.');
  const clone = cachedScene.clone(true);
  clone.traverse(o=>{
    if(o.isMesh && o.material){
      o.material = o.material.clone();
      if(o.material.emissive) o.material.emissiveIntensity = 0.6;
    }
  });
  if(boundingBox){
    const size=new THREE.Vector3();
    boundingBox.getSize(size);
    const h=size.y||1;
    const s=targetHeight/h;
    clone.scale.setScalar(s);
    const center=new THREE.Vector3();
    boundingBox.getCenter(center);
    clone.position.y -= center.y * s;
  }
  clone.rotation.y = Math.PI + EXTRA_YAW_RAD;
  return clone;
}

export function animateRewardModel(group, gsapRef){
  const spin=gsapRef.timeline({repeat:-1,defaults:{ease:'linear'}});
  spin.to(group.rotation,{y:group.rotation.y + Math.PI*2, duration:6});
  const bob=gsapRef.timeline({repeat:-1,yoyo:true,defaults:{ease:'sine.inOut'}});
  bob.to(group.position,{y:group.position.y+2,duration:1.3});
  return ()=>{ spin.kill(); bob.kill(); };
}