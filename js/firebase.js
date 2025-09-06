/* firebase.js
   Lightweight Firebase REST / Realtime emulation layer used by game.js.
   Replace this with your real Firebase implementation if you already have one.

   Exposes a global: window.FirebaseREST with methods:
     onChildAdded(path, callback)
     onValue(path, callback)
     update(path, data) -> Promise
     emitChildAdded(path, object) (test helper)
     emitValue(path, data) (test helper)

   Also exposes LocalEventBus.injectLocalEvent(object) for the existing simGift helper.

   HOW TO REPLACE WITH REAL BACKEND:
     - Delete this file.
     - Implement a module that listens to your realtime DB (Firebase RTDB / Firestore /
       custom WebSocket) and calls the registered callbacks with the same shapes.
*/

(function initFirebaseShim(){
  if(window.FirebaseREST){
    console.info('[FirebaseREST] Existing implementation detected; shim skipped.');
    return;
  }

  const listenersChildAdded = {};
  const listenersValue = {};
  const dbStore = {}; // simple in-memory store for onValue simulation

  function norm(path){
    return path.startsWith('/') ? path : '/' + path;
  }

  function onChildAdded(path, cb){
    path = norm(path);
    (listenersChildAdded[path] ||= []).push(cb);
  }

  function onValue(path, cb){
    path = norm(path);
    (listenersValue[path] ||= []).push(cb);
    // initial fire if we have data
    if(Object.prototype.hasOwnProperty.call(dbStore, path)){
      try{ cb(dbStore[path]); }catch(e){ console.warn('[FirebaseREST] onValue callback error',e); }
    } else {
      cb(null);
    }
  }

  function update(path, data){
    // Emulates a patch; store & fire onValue
    path = norm(path);
    return new Promise(res=>{
      const parts = path.split('/').filter(Boolean);
      if(parts.length>=2 && parts[0] === 'leaderboard'){
        // /leaderboard/<userKey>
        dbStore['/leaderboard'] ||= {};
        dbStore['/leaderboard'][parts[1]] = data;
        emitValue('/leaderboard', dbStore['/leaderboard']);
      } else {
        dbStore[path] = data;
        emitValue(path, data);
      }
      res({ ok:true });
    });
  }

  function emitChildAdded(path, obj){
    path=norm(path);
    const id = obj && obj.id ? obj.id : 'ev_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const arr = listenersChildAdded[path];
    if(arr){
      arr.forEach(cb=>{
        try{ cb(id, obj); }catch(e){ console.warn('[FirebaseREST] childAdded cb error', e); }
      });
    }
  }

  function emitValue(path, data){
    path=norm(path);
    dbStore[path]=data;
    const arr = listenersValue[path];
    if(arr){
      arr.forEach(cb=>{
        try{ cb(data); }catch(e){ console.warn('[FirebaseREST] value cb error', e); }
      });
    }
  }

  // Expose a local test bus compatible with previous code expectations
  const LocalEventBus = {
    injectLocalEvent(obj){
      const enriched = {
        ...obj,
        timestamp: obj.timestamp || Date.now()
      };
      emitChildAdded('/events', enriched);
    }
  };

  window.FirebaseREST = {
    onChildAdded,
    onValue,
    update,
    emitChildAdded,
    emitValue
  };
  window.LocalEventBus = LocalEventBus;

  console.info('[FirebaseREST] Shim initialized. Replace with real backend for production.');
})();