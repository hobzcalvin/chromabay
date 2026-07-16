// Offline firmware cache.
//
// The OTA flow normally fetches firmware (.bin + .sig) from gh-pages at update time, so
// a device can't be updated without internet. This module proactively stores the latest
// firmware image on the device (IndexedDB — persists across launches, works in both the
// browser and the iOS WKWebView, no native plugin needed) so a later OTA can run fully
// offline (e.g. a friend's phone joined to a device with no internet).
//
// IndexedDB stores ArrayBuffers natively, so ~900 KB images are fine (Preferences /
// UserDefaults would not be).

export interface CachedFirmware {
  version: string;
  date: string;
  bin: ArrayBuffer;
  sig: ArrayBuffer;
  cachedAt: number;
}

const DB_NAME = 'chromabay-firmware';
const STORE = 'images';
const DB_VERSION = 1;
// Keep only the few newest images so the cache can't grow unbounded.
const MAX_CACHED = 3;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'version' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Store one firmware image, then prune to the MAX_CACHED newest by cachedAt. */
export async function putFirmware(fw: CachedFirmware): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, 'readwrite', (s) => s.put(fw));
    await prune(db);
  } finally {
    db.close();
  }
}

/** Return the cached image for a version, or null if not cached. */
export async function getFirmware(version: string): Promise<CachedFirmware | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null; // no IndexedDB (e.g. private mode) -> behave as "not cached"
  }
  try {
    const fw = await tx<CachedFirmware | undefined>(db, 'readonly', (s) => s.get(version));
    return fw ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Lightweight list of what's cached (version + date), newest first. No binaries. */
export async function listCachedFirmware(): Promise<{ version: string; date: string; cachedAt: number }[]> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  try {
    const all = await tx<CachedFirmware[]>(db, 'readonly', (s) => s.getAll());
    return all
      .map(({ version, date, cachedAt }) => ({ version, date, cachedAt }))
      .sort((a, b) => b.cachedAt - a.cachedAt);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function prune(db: IDBDatabase): Promise<void> {
  const all = await tx<CachedFirmware[]>(db, 'readonly', (s) => s.getAll());
  if (all.length <= MAX_CACHED) return;
  const toDelete = all.sort((a, b) => b.cachedAt - a.cachedAt).slice(MAX_CACHED);
  for (const fw of toDelete) {
    await tx(db, 'readwrite', (s) => s.delete(fw.version));
  }
}
