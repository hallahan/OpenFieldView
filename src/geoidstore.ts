// Geoid models kept on this device, so one is opened once and then used for
// every job that names it. A national grid is tens of megabytes, so they go
// in IndexedDB, in a database of their own beside the feature libraries'.

const DB = 'openfieldview-geoids';
const STORE = 'geoids';

interface StoredGeoid {
  /** File name without its extension, lower case: g18us. */
  name: string;
  bytes: Uint8Array;
  savedAt: string;
}

/** "g18us.GGF" → "g18us", the way a job names its geoid model. */
export function geoidKey(fileName: string): string {
  return fileName.replace(/\.ggf$/i, '').trim().toLowerCase();
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close()) as Promise<T>;
}

/** The stored model's bytes, or undefined if it isn't on this device. */
export async function getGeoid(name: string): Promise<Uint8Array | undefined> {
  try {
    return (await run<StoredGeoid | undefined>('readonly', (s) => s.get(geoidKey(name))))?.bytes;
  } catch {
    return undefined;
  }
}

/** Store a model; false if this browser won't keep it (private mode, quota). */
export async function saveGeoid(name: string, bytes: Uint8Array): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put({ name: geoidKey(name), bytes, savedAt: new Date().toISOString() } satisfies StoredGeoid));
    return true;
  } catch {
    return false;
  }
}
