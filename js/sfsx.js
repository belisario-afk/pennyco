// Tiny SFX manager with WebAudio (no assets needed)
export class SFX {
  constructor() {
    this.enabled = JSON.parse(localStorage.getItem('plinkoo_sfx_enabled') || 'true');
    this.ctx = null;
  }
  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  toggle(on) {
    this.enabled = !!on;
    localStorage.setItem('plinkoo_sfx_enabled', JSON.stringify(this.enabled));
  }
  blip(f = 440, dur = 0.045, type = 'sine', gain = 0.06) {
    if (!this.enabled) return;
    this.ensureCtx();
    const t0 = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0);
    o.stop(t0 + dur);
  }
  peg() { this.blip(520 + Math.random()*120, 0.03, 'triangle', 0.045); }
  wall() { this.blip(320, 0.04, 'sawtooth', 0.04); }
  score() { this.blip(880, 0.12, 'sine', 0.08); }
}
export const sfx = new SFX();