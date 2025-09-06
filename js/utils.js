import * as THREE from 'three';

let audioCtx = null;
let masterGain = null;
let storedVolume = clamp01(Number(localStorage.getItem('plk_volume') ?? '0.5'));
function clamp01(v){ return Math.max(0, Math.min(1, v)); }

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
export function setAudioVolume(v){
  storedVolume = clamp01(Number(v));
  localStorage.setItem('plk_volume', String(storedVolume));
  if (masterGain) masterGain.gain.value = storedVolume;
}
function now(){ return audioCtx ? audioCtx.currentTime : 0; }
function beep(freq, dur, type, gain){
  if(!audioCtx || audioCtx.state!=='running') return;
  const t0=now();
  const o=audioCtx.createOscillator();
  const g=audioCtx.createGain();
  o.type=type; o.frequency.setValueAtTime(freq,t0);
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(gain,t0+0.006);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  o.connect(g).connect(masterGain);
  o.start(t0); o.stop(t0+dur);
}
export function sfxBounce(){ beep(520+Math.random()*80,0.03,'square',0.12); }
export function sfxDrop(){ beep(420,0.05,'triangle',0.18); }
export function sfxScore(big=false){
  if(!audioCtx || audioCtx.state!=='running') return;
  if(big){
    beep(880,0.08,'triangle',0.25);
    setTimeout(()=>beep(1100,0.12,'triangle',0.22),70);
  } else {
    beep(760,0.08,'triangle',0.22);
  }
}

export async function loadAvatarTexture(url, diameter=96){
  return new Promise((resolve)=>{
    const size=Math.max(32, Math.min(256, diameter));
    const canvas=document.createElement('canvas');
    canvas.width=canvas.height=size;
    const ctx=canvas.getContext('2d');
    const done=()=>{
      const tex=new THREE.CanvasTexture(canvas);
      tex.anisotropy=4;
      resolve(tex);
    };
    const img=new Image(); img.crossOrigin='anonymous';
    img.onload=()=>{
      ctx.clearRect(0,0,size,size);
      ctx.save();
      ctx.beginPath(); ctx.arc(size/2,size/2,size/2,0,Math.PI*2); ctx.closePath(); ctx.clip();
      ctx.drawImage(img,0,0,size,size);
      ctx.restore();
      done();
    };
    img.onerror=()=>{
      ctx.fillStyle='#132035';
      ctx.beginPath(); ctx.arc(size/2,size/2,size/2,0,Math.PI*2); ctx.fill();
      ctx.font=`${Math.floor(size*0.6)}px serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('🎯', size/2, size/2+2); done();
    };
    try { img.src=url||''; } catch { img.onerror(); }
  });
}

export function buildNameSprite(username){
  const text=username||'viewer';
  const fontSize=54, padding=16;
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d');
  ctx.font=`900 ${fontSize}px Inter, system-ui, Arial`;
  const w=Math.ceil(ctx.measureText(text).width)+padding*2;
  const h=fontSize+padding*2;
  canvas.width=w; canvas.height=h;
  ctx.fillStyle='rgba(0,0,0,0.35)';
  roundRect(ctx,0,0,w,h,12); ctx.fill();
  ctx.shadowColor='rgba(0,242,234,0.7)'; ctx.shadowBlur=14;
  ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(text, w/2, h/2+4);
  const tex=new THREE.CanvasTexture(canvas);
  const mat=new THREE.SpriteMaterial({ map:tex, transparent:true });
  const sprite=new THREE.Sprite(mat);
  const scale=0.009; sprite.scale.set(w*scale,h*scale,1);
  return sprite;
}
function roundRect(ctx,x,y,w,h,r){const rr=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+rr,y);ctx.arcTo(x+w,y,x+w,y+h,rr);ctx.arcTo(x+w,y+h,x,y+h,rr);ctx.arcTo(x,y+h,x,y,rr);ctx.arcTo(x,y,x+w,y,rr);ctx.closePath();}

export function worldToScreen(vec3,camera,renderer){
  const v=vec3.clone().project(camera);
  const halfW=renderer.domElement.clientWidth/2;
  const halfH=renderer.domElement.clientHeight/2;
  return { x:v.x*halfW+halfW, y:-v.y*halfH+halfH };
}

export class FXManager2D {
  constructor(canvas){ this.canvas=canvas; this.parts=[]; }
  addSparks(x,y,color='#00f2ea',count=16){
    for(let i=0;i<count;i++){
      const a=Math.random()*Math.PI*2, sp=1+Math.random()*2.5;
      this.parts.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:240+Math.random()*160,color,size:2});
    }
  }
  update(ctx,dt){
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    ctx.globalCompositeOperation='lighter';
    for(const p of this.parts){
      p.x+=p.vx; p.y+=p.vy; p.vx*=0.97; p.vy*=0.97; p.life-=dt;
      if(p.life>0){ ctx.fillStyle=p.color; ctx.fillRect(p.x,p.y,p.size,p.size); }
    }
    this.parts=this.parts.filter(p=>p.life>0);
    ctx.globalCompositeOperation='source-over';
  }
}

export function sparks2D(ctx,x,y,color='#00f2ea',count=14){
  const mgr=new FXManager2D(ctx.canvas);
  mgr.addSparks(x,y,color,count);
  let last=performance.now();
  function step(t){
    const dt=t-last; last=t;
    mgr.update(ctx,dt);
    if(mgr.parts.length) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

window.PlinkoUtils = {
  loadAvatarTexture, buildNameSprite, worldToScreen,
  FXManager2D, sparks2D,
  initAudioOnce, setAudioVolume,
  sfxBounce, sfxDrop, sfxScore
};