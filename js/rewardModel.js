// rewardModel.js
// Loads and caches the GLB 3D "middle finger" model for reward reveals.
// Exports helpers to ensure model is loaded and to create per-redeem instances.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_PATH = './tripo_pbr_model_b12fdae2-6adb-46bb-98bc-ebf0f5cd9e55.glb';

let loadPromise = null;
let cachedScene = null;
let boundingBox = null;

/**
 * Loads the GLB once. Returns a promise that resolves when cachedScene is ready.
 */
export function ensureRewardModelLoaded() {
  if (cachedScene) return Promise.resolve(cachedScene);
  if (loadPromise) return loadPromise;

  const loader = new GLTFLoader();
  loadPromise = new Promise((resolve, reject) => {
    loader.load(
      MODEL_PATH,
      (gltf) => {
        cachedScene = gltf.scene || gltf.scenes?.[0];
        if (!cachedScene) {
          reject(new Error('No scene in GLB'));
          return;
        }

        // Normalize orientation & scale
        cachedScene.traverse(obj => {
          if (obj.isMesh) {
            obj.castShadow = false;
            obj.receiveShadow = false;
            if (obj.material) {
              obj.material.transparent = true;
              obj.material.depthWrite = true;
            }
          }
        });

        boundingBox = new THREE.Box3().setFromObject(cachedScene);
        resolve(cachedScene);
      },
      undefined,
      (err) => reject(err || new Error('Failed to load GLB'))
    );
  });

  return loadPromise;
}

/**
 * Creates a fresh clone of the model, scaled to targetHeight world units.
 * @param {number} targetHeight
 * @returns {THREE.Group}
 */
export function createRewardModelInstance(targetHeight = 16) {
  if (!cachedScene) throw new Error('Model not loaded yet. Call ensureRewardModelLoaded first.');
  const clone = cachedScene.clone(true);
  // Deep clone materials (to allow per-instance emissive pulses if needed)
  clone.traverse(obj => {
    if (obj.isMesh && obj.material) {
      obj.material = obj.material.clone();
      if (obj.material.emissive) {
        obj.material.emissiveIntensity = 0.6;
      }
    }
  });

  if (boundingBox) {
    const size = new THREE.Vector3();
    boundingBox.getSize(size);
    const h = size.y || 1;
    const scale = targetHeight / h;
    clone.scale.setScalar(scale);
    // Re-center vertically
    const center = new THREE.Vector3();
    boundingBox.getCenter(center);
    clone.position.y -= (center.y * scale);
  }

  // Initial state for animation
  clone.rotation.y = Math.PI; // face front-ish
  return clone;
}

/**
 * Animate a reward model (spin + bob). Returns a disposer function.
 */
export function animateRewardModel(group, gsapRef) {
  const spinTL = gsapRef.timeline({ repeat: -1, defaults: { ease: 'linear' } });
  spinTL.to(group.rotation, { y: group.rotation.y + Math.PI * 2, duration: 6 });
  const bobTL = gsapRef.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut' } });
  bobTL.to(group.position, { y: group.position.y + 2.0, duration: 1.3 });
  return () => {
    spinTL.kill();
    bobTL.kill();
  };
}