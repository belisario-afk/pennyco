// Utility helpers for Plinkoo

/**
 * Simple deterministic color from string.
 */
function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

/**
 * Create a round-cropped canvas texture for a given image URL with fallback.
 */
async function loadAvatarTexture(url, diameter = 64) {
  return new Promise((resolve) => {
    const size = Math.max(32, Math.min(256, diameter));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    const finalize = () => {
      const texture = new THREE.CanvasTexture(canvas);
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
      // Fallback: draw an emoji on a colored circle
      const bg = '#1b2740';
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();

      ctx.font = `${Math.floor(size * 0.6)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎲', size/2, size/2 + 2);
      finalize();
    };
    try {
      img.src = url || '';
    } catch (e) {
      img.onerror();
    }
  });
}

/**
 * Build a Three.js sprite showing a username above a body.
 */
function buildNameSprite(username) {
  const text = username || 'viewer';
  const fontSize = 48;
  const padding = 16;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  ctx.font = `bold ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  const textMetrics = ctx.measureText(text);
  const w = Math.ceil(textMetrics.width) + padding * 2;
  const h = fontSize + padding * 2;

  canvas.width = w;
  canvas.height = h;

  // Background bubble
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, 0, 0, w, h, 12);
  ctx.fill();

  // Text
  ctx.font = `bold ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'white';
  ctx.fillText(text, w / 2, h / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const scaleFactor = 0.008; // pixels to world units
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

/**
 * Small confetti celebration on jackpot.
 */
function fireworks(canvas, durationMs = 1200) {
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

window.PlinkoUtils = {
  colorFromString,
  loadAvatarTexture,
  buildNameSprite,
  fireworks,
};