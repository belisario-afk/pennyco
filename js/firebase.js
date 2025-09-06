// Firebase REST polling helper with optional auth + local fallback events
const dbBase = (window.PLINKO_DB_URL || 'https://plinkoo-82abc-default-rtdb.firebaseio.com').replace(/\/+$/,'');
const listeners = [];
const valueListeners = [];
let eventPollTimer = null;
let lastEventKey = null;

function encodePath(p){ return p.replace(/^\//,'') + '.json'; }
function authParam(){
  const tok = localStorage.getItem('adminToken') || '';
  return tok ? `?auth=${encodeURIComponent(tok)}` : '';
}

async function push(path,obj){
  const url = `${dbBase}/${encodePath(path)}${authParam()}`;
  const res = await fetch(url,{method:'POST',body:JSON.stringify(obj)});
  if(!res.ok){
    console.warn('Firebase push failed', res.status);
    if(path==='/events'){
      LocalEventBus.injectLocalEvent(obj);
      throw new Error('PUSH /events failed');
    }
    throw new Error(`PUSH ${path} failed`);
  }
  return res.json();
}
async function update(path,obj){
  const url = `${dbBase}/${encodePath(path)}${authParam()}`;
  const res = await fetch(url,{method:'PATCH',body:JSON.stringify(obj)});
  if(!res.ok) throw new Error(`PATCH ${path} failed`);
  return res.json();
}
async function get(path){
  const url = `${dbBase}/${encodePath(path)}${authParam()}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`GET ${path} failed`);
  return res.json();
}

async function pollEvents(){
  try{
    const data = await get('/events');
    const keys = data ? Object.keys(data).sort() : [];
    for(const k of keys){
      if(!lastEventKey || k > lastEventKey){
        lastEventKey = k;
        const obj = data[k];
        listeners.forEach(l=>l(k,obj));
      }
    }
  }catch{}
  finally {
    eventPollTimer = setTimeout(pollEvents,2500);
  }
}

async function pollValues(){
  for(const v of valueListeners){
    try { v.cb(await get(v.path)); } catch {}
  }
  setTimeout(pollValues,4000);
}

const FirebaseREST = {
  push,
  update,
  onChildAdded(path, cb){
    if(path !== '/events'){ console.warn('Polling only for /events'); }
    listeners.push(cb);
    if(!eventPollTimer) pollEvents();
  },
  onValue(path, cb){
    valueListeners.push({path,cb});
    if(valueListeners.length===1) pollValues();
  }
};
window.FirebaseREST = FirebaseREST;

const LocalEventBus = {
  injectLocalEvent(obj){
    const id='local_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    listeners.forEach(l=>l(id,{...obj,timestamp:obj.timestamp||Date.now()}));
    console.log('[LocalEventBus] injected event', id, obj);
  }
};
window.LocalEventBus = LocalEventBus;