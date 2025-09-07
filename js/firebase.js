/* firebase.js (Enhanced Polling Version)
   Purpose: Reliable lightweight REST-based emulation of Firebase Realtime DB listeners
   Improvements over previous version:
     - Separate registries for child-added vs value paths
     - Better error handling + optional debug logging
     - Auth fallback (retry without token on 401/403 for read)
     - lastEventKey updated after processing batch (clearer, safer)
     - Optional forced anonymous read (localStorage plk_force_anon_read=1)
     - Debug controls: localStorage plk_debug_firebase=1
     - No silent failures
     - Per-path state (allows future extension)
*/

(function(){
  if(window.FirebaseREST){
    console.warn('[FirebaseREST] Already initialized.');
    return;
  }

  const DEFAULT_DB = 'https://plinkoo-82abc-default-rtdb.firebaseio.com';
  const dbBase = (window.PLINKO_DB_URL || DEFAULT_DB).replace(/\/+$/,'');
  const EVENT_POLL_INTERVAL = 1500;
  const VALUE_POLL_INTERVAL = 4000;

  let DEBUG = false;
  try { DEBUG = localStorage.getItem('plk_debug_firebase') === '1'; }catch{}
  function log(...a){ if(DEBUG) console.log('[FirebaseREST]',...a); }

  function encodePath(p){
    return (p||'').replace(/^\//,'') + '.json';
  }

  function currentToken(){
    if(localStorage.getItem('plk_force_anon_read') === '1') return '';
    return localStorage.getItem('adminToken') || '';
  }

  function authQuery(token){
    return token ? `?auth=${encodeURIComponent(token)}` : '';
  }

  async function fetchWithFallback(url, haveToken, isGet){
    // Try with token first; if 401/403 AND isGet, retry without token
    let res;
    try {
      res = await fetch(url);
    } catch(err){
      throw new Error('Network error: '+err.message);
    }
    if(isGet && haveToken && (res.status === 401 || res.status === 403)){
      log('Auth GET failed, retrying without token', url);
      const cleanUrl = url.replace(/\?auth=[^&]+/,'');
      res = await fetch(cleanUrl);
    }
    return res;
  }

  async function push(path,obj){
    const token = currentToken();
    const url = `${dbBase}/${encodePath(path)}${authQuery(token)}`;
    const res = await fetch(url,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(obj)
    });
    if(!res.ok){
      console.warn('[FirebaseREST] PUSH failed', path, res.status);
      if(path==='/events'){
        // fallback local injection so front-end still reacts
        LocalEventBus.injectLocalEvent(obj);
        throw new Error('PUSH /events failed (local fallback injected)');
      }
      throw new Error(`PUSH ${path} failed status=${res.status}`);
    }
    return res.json();
  }

  async function update(path,obj){
    const token=currentToken();
    const url=`${dbBase}/${encodePath(path)}${authQuery(token)}`;
    const res=await fetch(url,{
      method:'PATCH',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(obj)
    });
    if(!res.ok) throw new Error(`PATCH ${path} failed status=${res.status}`);
    return res.json();
  }

  async function get(path){
    const token=currentToken();
    const baseUrl=`${dbBase}/${encodePath(path)}`;
    const url=baseUrl + authQuery(token);
    const res=await fetchWithFallback(url, !!token, true);
    if(!res.ok) throw new Error(`GET ${path} failed status=${res.status}`);
    try { return await res.json(); } catch { return null; }
  }

  // Child-added watchers: { path -> { callbacks:Set<fn>, lastKey:string|null } }
  const childWatchers = new Map();
  // Value watchers: { path -> { callbacks:Set<fn> } }
  const valueWatchers = new Map();

  let eventPollTimer=null;
  let valuePollTimer=null;

  function scheduleEventPoll(){
    if(eventPollTimer) return;
    eventPollTimer=setTimeout(pollChildPaths, EVENT_POLL_INTERVAL);
  }

  function scheduleValuePoll(){
    if(valuePollTimer) return;
    valuePollTimer=setTimeout(pollValuePaths, VALUE_POLL_INTERVAL);
  }

  async function pollChildPaths(){
    eventPollTimer=null;
    for(const [path,state] of childWatchers.entries()){
      try{
        // Simple approach: fetch entire node
        const data = await get(path);
        if(!data || typeof data!=='object'){
          continue;
        }
        const keys=Object.keys(data).sort(); // Firebase-style keys sort chronologically
        let newKeys;
        if(state.lastKey){
          newKeys = keys.filter(k=>k > state.lastKey);
        }else{
          newKeys = keys; // first poll: deliver all (game code filters by timestamp if needed)
        }
        if(newKeys.length){
          for(const k of newKeys){
            const obj=data[k];
            state.callbacks.forEach(cb=>{
              try{ cb(k,obj); }catch(e){ console.warn('[FirebaseREST] childAdded cb error', e); }
            });
          }
          state.lastKey = newKeys[newKeys.length-1];
        }
      }catch(err){
        console.warn('[FirebaseREST] poll child path error', path, err.message);
      }
    }
    if(childWatchers.size) scheduleEventPoll();
  }

  async function pollValuePaths(){
    valuePollTimer=null;
    for(const [path,state] of valueWatchers.entries()){
      try{
        const val = await get(path);
        state.callbacks.forEach(cb=>{
          try{ cb(val); }catch(e){ console.warn('[FirebaseREST] value cb error', e); }
        });
      }catch(err){
        console.warn('[FirebaseREST] poll value path error', path, err.message);
      }
    }
    if(valueWatchers.size) scheduleValuePoll();
  }

  function onChildAdded(path, cb){
    if(typeof cb!=='function') return;
    if(!childWatchers.has(path)){
      childWatchers.set(path,{callbacks:new Set(), lastKey:null});
    }
    childWatchers.get(path).callbacks.add(cb);
    scheduleEventPoll();
    if(path !== '/events'){
      console.warn('[FirebaseREST] onChildAdded used for non-/events path:', path);
    }
  }

  function offChildAdded(path, cb){
    const st=childWatchers.get(path);
    if(!st) return;
    st.callbacks.delete(cb);
    if(!st.callbacks.size) childWatchers.delete(path);
  }

  function onValue(path, cb){
    if(typeof cb!=='function') return;
    if(!valueWatchers.has(path)){
      valueWatchers.set(path,{callbacks:new Set()});
    }
    valueWatchers.get(path).callbacks.add(cb);
    scheduleValuePoll();
  }

  function offValue(path, cb){
    const st=valueWatchers.get(path);
    if(!st) return;
    st.callbacks.delete(cb);
    if(!st.callbacks.size) valueWatchers.delete(path);
  }

  async function once(path){
    return get(path);
  }

  // Local Event Bus (for simulation)
  const LocalEventBus = {
    injectLocalEvent(obj,path='/events'){
      const id='local_'+Date.now()+'_'+Math.random().toString(36).slice(2);
      const st=childWatchers.get(path);
      if(st){
        st.callbacks.forEach(cb=>{
          try{ cb(id,{...obj,timestamp:obj.timestamp||Date.now()}); }catch(e){ console.warn(e); }
        });
        if(!st.lastKey || id > st.lastKey) st.lastKey=id;
      }
      log('[LocalEventBus] injected', path, id, obj);
    }
  };

  function __debugDump(){
    console.log('[FirebaseREST debug] childWatchers', childWatchers);
    console.log('[FirebaseREST debug] valueWatchers', valueWatchers);
  }

  const FirebaseREST = {
    push,
    update,
    get,
    once,
    onChildAdded,
    offChildAdded,
    onValue,
    offValue,
    __debugDump,
    setDebug(v){
      DEBUG=!!v;
      console.log('[FirebaseREST] debug=',DEBUG);
    }
  };

  window.FirebaseREST = FirebaseREST;
  window.LocalEventBus = LocalEventBus;
  console.log('[FirebaseREST] Initialized (REST polling mode).');
})();