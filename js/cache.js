// Saved engine results, kept in the browser's IndexedDB so a game is only analysed once.
// Every function degrades to "no cache" if storage is blocked (private windows, etc.).

const DB_NAME = 'chessReview';
const STORE = 'analyses';

/**
 * Open (and create on first use) the database.
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Read one saved analysis.
 * @param {string} key
 * @returns {Promise<object | null>} The stored record, or null if absent or storage is unavailable.
 */
export async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Save one analysis. Failures are ignored; the app works without the cache.
 * @param {object} record Must contain a string `key`.
 * @returns {Promise<void>}
 */
export async function cachePut(record) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable */
  }
}

/**
 * Read every saved analysis (used later for cross-game statistics).
 * @returns {Promise<object[]>}
 */
export async function cacheAll() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
