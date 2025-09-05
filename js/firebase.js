// Lightweight Firebase Realtime Database REST client with SSE streaming.
// No Firebase SDK needed. Works with public-readable rules.

(function () {
  const DATABASE_URL = 'https://plinkoo-82abc-default-rtdb.firebaseio.com';

  function pathUrl(path) {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${DATABASE_URL.replace(/\/$/, '')}${p}.json`;
  }

  async function get(path) {
    const res = await fetch(pathUrl(path), { method: 'GET' });
    if (!res.ok) throw new Error(`GET ${path} failed`);
    return res.json();
  }

  async function set(path, value) {
    const res = await fetch(pathUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`SET ${path} failed`);
    return res.json();
  }

  async function update(path, value) {
    const res = await fetch(pathUrl(path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`UPDATE ${path} failed`);
    return res.json();
  }

  async function push(path, value) {
    const res = await fetch(pathUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`PUSH ${path} failed`);
    return res.json(); // { name: "-N123abc..." }
  }

  // SSE stream: calls onPut({ path, data }), onPatch({ path, data })
  function listenRaw(path, { onPut, onPatch, onError, onOpen } = {}) {
    const url = pathUrl(path);
    const sse = new EventSource(url);
    sse.addEventListener('open', () => onOpen && onOpen());
    sse.addEventListener('error', (e) => {
      onError && onError(e);
    });
    sse.addEventListener('put', (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        onPut && onPut(payload);
      } catch (e) {
        console.error('SSE put parse error', e);
      }
    });
    sse.addEventListener('patch', (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        onPatch && onPatch(payload);
      } catch (e) {
        console.error('SSE patch parse error', e);
      }
    });
    return () => sse.close();
  }

  // Higher-level child-added handler
  function onChildAdded(path, cb) {
    const seen = new Set();
    const unlisten = listenRaw(path, {
      onOpen: () => {
        // console.log('SSE connected:', path);
      },
      onPut: ({ path: ssePath, data }) => {
        // Initial full data comes with path "/"
        if (ssePath === '/' || ssePath === '') {
          if (data && typeof data === 'object') {
            Object.keys(data).forEach((key) => {
              if (!seen.has(key)) {
                seen.add(key);
                cb(key, data[key]);
              }
            });
          }
        } else {
          // A new child or replacement: path like "/-Nabc123"
          const key = ssePath.replace(/^\//, '');
          if (!seen.has(key)) {
            seen.add(key);
            cb(key, data);
          }
        }
      },
      onPatch: ({ data }) => {
        // Patch may contain multiple children
        if (data && typeof data === 'object') {
          Object.keys(data).forEach((key) => {
            if (!seen.has(key)) {
              seen.add(key);
              cb(key, data[key]);
            }
          });
        }
      },
      onError: (e) => {
        console.warn('SSE error on', path, e);
      }
    });
    return unlisten;
  }

  // onValue listener mirrors snapshots for entire node
  function onValue(path, cb) {
    const unlisten = listenRaw(path, {
      onPut: ({ data }) => cb(data || {}),
      onPatch: ({ data }) => cb(data || {}),
      onError: (e) => console.warn('SSE error', e),
    });
    return unlisten;
  }

  window.FirebaseREST = {
    get,
    set,
    update,
    push,
    onChildAdded,
    onValue,
    DATABASE_URL,
  };
})();