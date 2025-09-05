// Utilities + Provably-fair RNG helpers
import * as THREE from 'https://unpkg.com/three@0.157.0/build/three.module.js';

export function loadAvatarTexture(url, diameter = 64) {
  return new Promise((resolve) => {
    const size = Math.max(32, Math.min(256, diameter));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    const finalize = () => resolve(new THREE.CanvasTexture(canvas));

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
      ctx.fillStyle = '#152238';
      ctx.beginPath();
      ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.font = `${Math.floor(size * 0.6)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔵', size/2, size/2 + 2);
      finalize();
    };
    try { img.src = url || ''; } catch { img.onerror(); }
  });
}

export function buildNameSprite(username) {
  const text = username || 'viewer';
  const fontSize = 46;
  const padding = 14;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  ctx.font = `800 ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  const textMetrics = ctx.measureText(text);
  const w = Math.ceil(textMetrics.width) + padding * 2;
  const h = fontSize + padding * 2;

  canvas.width = w;
  canvas.height = h;

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, 0, 0, w, h, 12); ctx.fill();

  ctx.font = `800 ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'white';
  ctx.fillText(text, w / 2, h / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const scaleFactor = 0.008; // px -> world units
  sprite.scale.set(w * scaleFactor, h * scaleFactor, 1);
  sprite.userData = { username: text };
  return sprite;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width/2, height/2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export function fireworks(canvas, durationMs = 1200) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth;
  const H = canvas.height = canvas.clientHeight;
  const parts = Array.from({ length: 120 }, () => ({
    x: Math.random() * W,
    y: H + Math.random() * 80,
    vx: (Math.random() - 0.5) * 6,
    vy: -Math.random() * 8 - 5,
    g: 0.18 + Math.random() * 0.1,
    color: `hsl(${Math.floor(Math.random()*360)}, 80%, 65%)`,
    size: 2 + Math.random() * 3
  }));
  let raf;
  const step = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.vy += p.g; p.y += p.vy;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  setTimeout(() => { cancelAnimationFrame(raf); ctx.clearRect(0,0,W,H); }, durationMs);
}

/* Provably-fair RNG */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function createSeededRNG(seedString) {
  const s = xmur3(seedString)();
  return mulberry32(s);
}
export function binomialProbabilities(n) {
  const probs = [];
  const denom = Math.pow(2, n);
  let c = 1;
  for (let k = 0; k <= n; k++) {
    if (k > 0) c = (c * (n - k + 1)) / k;
    probs.push(c / denom);
  }
  return probs;
}
export function computeRTP(multipliers) {
  const n = multipliers.length - 1;
  const probs = binomialProbabilities(n);
  let rtp = 0;
  for (let i = 0; i <= n; i++) rtp += probs[i] * multipliers[i];
  return rtp;
}

// Debug expose
window.PlinkoUtils = {
  loadAvatarTexture, buildNameSprite, fireworks,
  createSeededRNG, binomialProbabilities, computeRTP
};