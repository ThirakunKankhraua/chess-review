// Service worker that makes the computer page (pc.html) cross-origin isolated.
//
// The multi-threaded engine needs SharedArrayBuffer, which browsers only allow on a page that is
// "cross-origin isolated": every response must carry the headers below. GitHub Pages cannot add
// custom headers, so this worker adds them.
//
// It is registered for the whole app folder, because the engine's worker scripts live outside
// pc.html and browsers match worker scripts by their own URL. It only changes responses that
// belong to the computer page or the engine; the phone page (index.html) passes through untouched.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/**
 * Whether a request belongs to the computer page or the engine, and so needs the headers.
 * @param {FetchEvent} event
 * @returns {Promise<boolean>}
 */
async function needsIsolation(event) {
  const request = event.request;
  const path = new URL(request.url).pathname;
  if (request.mode === 'navigate') return path.endsWith('/pc.html');
  if (path.includes('/vendor/stockfish/')) return true; // engine scripts, wasm and its thread workers
  if (!event.clientId) return false;
  const client = await self.clients.get(event.clientId);
  return Boolean(client && new URL(client.url).pathname.endsWith('/pc.html'));
}

/**
 * Copy a response with the cross-origin isolation headers added.
 * @param {Response} response
 * @returns {Response}
 */
function withIsolationHeaders(response) {
  if (response.status === 0) return response; // opaque responses cannot be modified
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Engine files are large (the full engine is 99 MB) and the browser's normal cache did not keep
 * them: a reload took about 7 s to fetch the file again. Keep them in the Cache API instead.
 * File names carry the engine version, so a cached copy never goes stale; a new engine version
 * means a new file name and a new cache entry. Bump ENGINE_CACHE to drop old copies.
 */
const ENGINE_CACHE = 'chess-review-engine-v1';

/**
 * Serve an engine file from the cache, fetching and storing it the first time.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function engineFile(event) {
  const cache = await caches.open(ENGINE_CACHE);
  const hit = await cache.match(event.request.url);
  if (hit) return hit;
  const response = await fetch(event.request);
  if (response.ok) event.waitUntil(cache.put(event.request.url, response.clone()));
  return response;
}

self.addEventListener('activate', (event) => {
  // Remove engine caches from older versions of this worker.
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith('chess-review-engine-') && k !== ENGINE_CACHE).map((k) => caches.delete(k)),
  )));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // A known Chrome quirk: this combination throws if passed to fetch().
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const isEngine = request.method === 'GET' && new URL(request.url).pathname.includes('/vendor/stockfish/');
  event.respondWith((async () => {
    const isolate = await needsIsolation(event);
    const response = isEngine ? await engineFile(event) : await fetch(request);
    return isolate ? withIsolationHeaders(response) : response;
  })());
});
