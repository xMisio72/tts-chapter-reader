/**
 * Tiny IndexedDB helper shared by the plugin (main thread) and the TTS worker.
 *
 * Everything the plugin stores outside data.json lives here: the downloaded
 * voice engine files and the recorded chapter audio. IndexedDB belongs to the
 * app, not to the vault, so nothing large ends up in the vault folder (or in
 * whatever syncs it) and one download serves every vault on the device.
 */

export const DB_NAME = 'tts-chapter-reader';
const DB_VERSION = 2;

/** Engine files (model, runtime, voices): key → ArrayBuffer */
export const STORE_FILES = 'files';
/** Recorded audio: content hash → ArrayBuffer (MP3) */
export const STORE_AUDIO = 'audio';
/** Small per-recording records, so listing never loads the audio itself */
export const STORE_AUDIO_META = 'audioMeta';
/** Translated chapter text: hash of (translator + source text) → string */
export const STORE_TRANSLATIONS = 'translations';

/** Where one piece of a recording ends (seconds) and which text segment it started with. */
export interface SegmentMark {
  end: number;
  segment: number;
}

export interface AudioMeta {
  hash: string;
  bytes: number;
  duration: number;
  created: number;
  lastUsed: number;
  label: string;
  /** Piece boundaries, for following the reading in the note. Missing on old recordings. */
  marks?: SegmentMark[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [STORE_FILES, STORE_AUDIO, STORE_AUDIO_META, STORE_TRANSLATIONS]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => {
        // Another window upgrading the schema must not be blocked by this one.
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error('Could not open the audio database.'));
      };
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Database request failed.'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Database write failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Database write was aborted.'));
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function idbHas(store: string, key: string): Promise<boolean> {
  const db = await openDb();
  const found = await wrap(db.transaction(store, 'readonly').objectStore(store).getKey(key));
  return found !== undefined;
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await done(tx);
}

/** Several writes in one transaction: all land or none does. */
export async function idbWriteMany(ops: { store: string; key?: string; value?: unknown; op: 'put' | 'delete' | 'clear' }[]): Promise<void> {
  const db = await openDb();
  const stores = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(stores, 'readwrite');
  for (const o of ops) {
    const store = tx.objectStore(o.store);
    if (o.op === 'put') store.put(o.value, o.key);
    else if (o.op === 'delete') store.delete(o.key!);
    else store.clear();
  }
  await done(tx);
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function idbKeys(store: string): Promise<string[]> {
  const db = await openDb();
  const keys = await wrap(db.transaction(store, 'readonly').objectStore(store).getAllKeys());
  return keys.filter((k): k is string => typeof k === 'string');
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function idbClear(store: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await done(tx);
}
