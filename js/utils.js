// Utilities: audio (gesture-gated), textures, labels, projections, helpers for neon frame and normal maps
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';

let audioCtx = null;
let masterGain = null;
let storedVolume = clamp01(Number(localStorage.getItem('plk_volume') ?? '0.5'));

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Create or resume AudioContext ONLY after a user gesture
export async function initAudioOnce() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = storedVolume;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch {}
}

export function setAudioVolume(v) {
  storedVolume = clamp01(Number(v));
  localStorage.setItem('plk_volume', String(storedVolume));
  if (masterGain) masterGain.gain.value = storedVolume;
}

function now() { return audioCtx ? audioCtx.currentTime : 0; }
function beep(freq, dur, type, gain) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = now();
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(masterGain);
  o.start(t0); o.stop(t0 + dur);
}
export function sfxBounce() { beep(520 + Math.random()*80, 0.03, 'square', 0.12); }
export function sfxDrop()   { beep(420, 0.05, 'triangle', 0.18); }
export function sfxScore(big=false) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  if (big) { beep(880, 0.08, 'triangle', 0.25); setTimeout(() => beep(1100, 0.12, 'triangle', 0.22), 70); }
  else { beep(760, 0.08, 'triangle', 0.22); }
}

export async function loadAvatarTexture(url, diameter = 96) {
  return new Promise((resolve) => {
    const size = Math.max(32, Math.min(256, diameter));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    const done = () => {
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      resolve(tex);
    };

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.clearRect(0,0,size,size);
      ctx.save();
      ctx.beginPath(); ctx.arc(size/2,size/2,size/2,0,Math.PI*2); ctx.closePath(); ctx.clip();
      ctx.drawImage(img,0,0,size,size);
      ctx.restore();
      done();
    };
    img.onerror = () => {
      ctx.fillStyle = '#132035';
      ctx.beginPath(); ctx.arc(size/2,size/2,size/2,0,Math.PI*2); ctx.fill();
      ctx.font = `${Math.floor(size*0.6)}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('🎯', size/2, size/2+2); done();
    };
    try { img.src = url || ''; } catch { img.onerror(); }
  });
}

export function buildNameSprite(username) {
  const text = username || 'viewer';
  const fontSize = 54, padding = 16;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `900 ${fontSize}px Inter, system-ui, Arial`;
  const w = Math.ceil(ctx.measureText(text).width) + padding*2;
  const h = fontSize + padding*2;
  canvas.width = w; canvas.height = h;

  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  roundRect(ctx,0,0,w,h,12); ctx.fill();
  ctx.shadowColor = 'rgba(0,242,234,0.9)'; ctx.shadowBlur = 18;
  ctx.fillStyle = '#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(text, w/2, h/2+4);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.009; sprite.scale.set(w*scale, h*scale, 1);
  return sprite;
}
function roundRect(ctx,x,y,w,h,r){const rr=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+rr,y);ctx.arcTo(x+w,y,x+w,y+h,rr);ctx.arcTo(x+w,y+h,x,y+h,rr);ctx.arcTo(x,y+h,x,y,rr);ctx.arcTo(x,y,x+w,y,rr);ctx.closePath();}

export function worldToScreen(vec3, camera, renderer) {
  const v = vec3.clone().project(camera);
  const halfW = renderer.domElement.clientWidth / 2;
  const halfH = renderer.domElement.clientHeight / 2;
  return { x: v.x*halfW + halfW, y: -v.y*halfH + halfH };
}

/* Geometry helper: rounded-rectangle ring (frame) */
export function makeRoundedRectRing(width, height, radius, thickness, curveSegments = 24) {
  const outer = roundedRectShape(width, height, radius);
  const inner = roundedRectShape(width - thickness*2, height - thickness*2, Math.max(0, radius - thickness));
  const shape = outer;
  shape.holes.push(inner);
  const geom = new THREE.ShapeGeometry(shape, curveSegments);
  return geom;
}
function roundedRectShape(w, h, r) {
  const x = -w/2, y = -h/2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/* Procedural radial normal map (for pegs) */
export function createRadialNormalMap(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size/2, cy = size/2, rMax = size/2 - 1;
  const img = ctx.createImageData(size, size);
  for (let y=0; y<size; y++) {
    for (let x=0; x<size; x++) {
      const dx = (x + 0.5 - cx) / rMax;
      const dy = (y + 0.5 - cy) / rMax;
      const r2 = dx*dx + dy*dy;
      let nx=0, ny=0, nz=1;
      if (r2 <= 1.0) {
        const z = Math.sqrt(1.0 - r2);
        const invLen = 1.0 / Math.sqrt(dx*dx + dy*dy + z*z);
        nx = dx * invLen; ny = dy * invLen; nz = z * invLen;
      }
      // Pack normal in RGB [0..255]
      const R = Math.round((nx * 0.5 + 0.5) * 255);
      const G = Math.round((ny * 0.5 + 0.5) * 255);
      const B = Math.round((nz * 0.5 + 0.5) * 255);
      const idx = (y*size + x) * 4;
      img.data[idx] = R; img.data[idx+1] = G; img.data[idx+2] = B; img.data[idx+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  return tex;
}

/* Simple gradient shader material for tray */
export function makeTrayMaterial(topColor = new THREE.Color(0xff0050), bottomColor = new THREE.Color(0x550018), alpha = 0.55) {
  const uniforms = {
    uTop: { value: topColor },
    uBottom: { value: bottomColor },
    uAlpha: { value: alpha },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform float uAlpha;
      void main(){
        vec3 col = mix(uTop, uBottom, clamp(vUv.y, 0.0, 1.0));
        gl_FragColor = vec4(col, uAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  return mat;
}

window.PlinkoUtils = {
  initAudioOnce, setAudioVolume, sfxBounce, sfxDrop, sfxScore,
  loadAvatarTexture, buildNameSprite, worldToScreen,
  makeRoundedRectRing, createRadialNormalMap, makeTrayMaterial
};