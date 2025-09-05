// ESM Utilities: textures, labels, audio synth, particles, projections
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';

let audioCtx = null;
let masterGain = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = Number(localStorage.getItem('plk_volume') ?? '0.5');
    masterGain.connect(audioCtx.destination);
  }
}
function setVolume(v) {
  ensureAudio();
  masterGain.gain.value = Math.max(0, Math.min(1, v));
  localStorage.setItem('plk_volume', String(masterGain.gain.value));
}

function now() { return audioCtx ? audioCtx.currentTime : 0; }

function playBeep(freq = 600, dur = 0.06, type = 'sine', gain = 0.2) {
  if (!audioCtx) return;
  const t0 = now();
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur);
}

function playChime(success = true) {
  if (!audioCtx) return;
  const base = success ? 880 : 660;
  playBeep(base, 0.08, 'triangle', 0.25);
  setTimeout(() => playBeep(base * 1.25, 0.12, 'triangle', 0.22), 70);
}

export function initAudioOnce() {
  ensureAudio();
}

export function setAudioVolume(v) { setVolume(v); }

export function sfxBounce() {
  ensureAudio();
  playBeep(520 + Math.random()*80, 0.03, 'square', 0.12);
}
export function sfxDrop() {
  ensureAudio();
  playBeep(420, 0.05, 'triangle', 0.18);
}
export function sfxScore(jackpot = false) {
  ensureAudio();
  if (jackpot) playChime(true);
  else playBeep(760, 0.08, 'triangle', 0.22);
}

/**
 * Deterministic hue based on string.
 */
export function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

/**
 * Load an avatar and produce a round-cropped CanvasTexture.
 */
export async function loadAvatarTexture(url, diameter = 96) {
  return new Promise((resolve) => {
    const size = Math.max(32, Math.min(256, diameter));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    const finalize = () => {
      const texture = new THREE.CanvasTexture(canvas);
      texture.anisotropy = 4;
      resolve(texture);
    };

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, 0, 0, size, size);
      ctx.restore();
      finalize();
    };
    img.onerror = () => {
      // Fallback emoji
      ctx.fillStyle = '#1b2740';
      ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2); ctx.fill();
      ctx.font = `${Math.floor(size * 0.6)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🟢', size/2, size/2 + 2);
      finalize();
    };
    try { img.src = url || ''; } catch { img.onerror(); }
  });
}

/**
 * Build a name sprite (billboard) above the ball.
 */
export function buildNameSprite(username) {
  const text = username || 'viewer';
  const fontSize = 54;
  const padding = 16;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  ctx.font = `900 ${fontSize}px Inter, system-ui, Arial`;
  const textMetrics = ctx.measureText(text);
  const w = Math.ceil(textMetrics.width) + padding * 2;
  const h = fontSize + padding * 2;

  canvas.width = w;
  canvas.height = h;

  // Neon bubble
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, 0, 0, w, h, 12);
  ctx.fill();

  ctx.shadowColor = 'rgba(0,242,234,0.9)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.009; // pixels to world units
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.userData = { username: text };
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Project world position to screen (pixel coords) for a given camera/renderer.
 */
export function worldToScreen(vec3, camera, renderer) {
  const v = vec3.clone().project(camera);
  const halfW = renderer.domElement.clientWidth / 2;
  const halfH = renderer.domElement.clientHeight / 2;
  return {
    x: (v.x * halfW) + halfW,
    y: (-v.y * halfH) + halfH
  };
}

/**
 * Sparks particle burst on collisions (drawn on a 2D overlay canvas).
 */
export function sparks2D(canvasCtx, x, y, color = '#00f2ea', count = 14) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1 + Math.random() * 2.5;
    parts.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 20 + Math.random() * 16
    });
  }
  let id = 0;
  function step() {
    id++;
    canvasCtx.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life--;
    }
    // draw
    for (const p of parts) {
      if (p.life <= 0) continue;
      canvasCtx.fillStyle = color;
      canvasCtx.fillRect(p.x, p.y, 2, 2);
    }
    if (id < 18) requestAnimationFrame(step);
  }
  step();
}

/**
 * Confetti fireworks celebration.
 */
export function fireworks(canvas, durationMs = 1200) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth;
  const H = canvas.height = canvas.clientHeight;
  const count = 120;
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push({
      x: Math.random() * W,
      y: H + Math.random() * 80,
      vx: (Math.random() - 0.5) * 6,
      vy: -Math.random() * 8 - 5,
      g: 0.18 + Math.random() * 0.1,
      color: `hsl(${Math.floor(Math.random()*360)}, 80%, 65%)`,
      size: 2 + Math.random() * 3
    });
  }
  let start = performance.now();
  let raf;
  const step = (t) => {
    const dt = Math.min(32, t - start);
    start = t;
    ctx.clearRect(0, 0, W, H);
    parts.forEach(p => {
      p.x += p.vx;
      p.vy += p.g;
      p.y += p.vy;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    });
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  setTimeout(() => {
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, W, H);
  }, durationMs);
}

// Also expose for non-module references (optional)
window.PlinkoUtils = {
  colorFromString,
  loadAvatarTexture,
  buildNameSprite,
  fireworks,
  sparks2D,
  worldToScreen,
  initAudioOnce,
  setAudioVolume,
  sfxBounce,
  sfxDrop,
  sfxScore,
};