import type { GameState } from '../game/types';

const DB_NAME = 'worldseed-local';
const STORE_NAME = 'saves';
const SAVE_KEY = 'guest-demo-v1';

function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis))
    return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open the local save database.'));
  });
}

export async function saveGuestGame(state: GameState): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(state, SAVE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Could not save this island.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Island save was interrupted.'));
  });
  db.close();
}

export async function loadGuestGame(): Promise<GameState | null> {
  const db = await openDatabase();
  const result = await new Promise<GameState | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(SAVE_KEY);
    request.onsuccess = () => resolve((request.result as GameState | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not read the local island save.'));
  });
  db.close();
  return result;
}
