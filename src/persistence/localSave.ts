import type { EconomyState } from '../incremental/engine';
import {
  applyOfflineProgress,
  resetForNewSeason,
  validateEconomyState,
  type OfflineProgressResult,
} from '../incremental/engine';
import { seasonIdAt } from '../incremental/season';
import {
  BOARD_SIZE,
  REGIONS,
  type GameState,
  type Habitat,
  type RegionId,
  type Terrain,
} from '../game/types';
import { createGameState } from '../game/rules';

const DB_NAME = 'worldseed-local';
const STORE_NAME = 'saves';
const CURRENT_SAVE_KEY = 'guest-incremental-v3';
const PREVIOUS_SAVE_KEY = 'guest-incremental-v2';
const LEGACY_SAVE_KEY = 'guest-demo-v1';
export const GUEST_SAVE_SCHEMA_VERSION = 3 as const;

interface GuestSaveData {
  savedAt: number;
  economy: EconomyState;
  restoration: GameState;
  legacyRestoration?: GameState;
}

export type GuestSaveV2 = GuestSaveData & { schemaVersion: 2 };
export type GuestSaveV3 = GuestSaveData & { schemaVersion: typeof GUEST_SAVE_SCHEMA_VERSION };

export interface RestoredGuestProgress extends OfflineProgressResult {
  restoration: GameState;
  savedAt: number;
  seasonChanged: boolean;
}

export type LoadedGuestSave =
  | { kind: 'empty' }
  | { kind: 'current'; save: GuestSaveV3; migrated: boolean }
  | { kind: 'legacy'; restoration: GameState }
  | { kind: 'incompatible'; foundVersion: unknown };

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

function readValue<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('Could not read the local save.'));
  });
}

export async function loadGuestSave(): Promise<LoadedGuestSave> {
  const db = await openDatabase();
  try {
    const current = await readValue<unknown>(db, CURRENT_SAVE_KEY);
    if (current !== undefined) {
      if (isValidSave(current, GUEST_SAVE_SCHEMA_VERSION))
        return { kind: 'current', save: current, migrated: false };
      return { kind: 'incompatible', foundVersion: foundSchemaVersion(current) };
    }

    const previous = await readValue<unknown>(db, PREVIOUS_SAVE_KEY);
    if (previous !== undefined) {
      if (isValidSave(previous, 2)) {
        return {
          kind: 'current',
          save: { ...previous, schemaVersion: GUEST_SAVE_SCHEMA_VERSION },
          migrated: true,
        };
      }
      return { kind: 'incompatible', foundVersion: foundSchemaVersion(previous) };
    }

    const legacy = await readValue<unknown>(db, LEGACY_SAVE_KEY);
    if (legacy !== undefined && isGameState(legacy)) return { kind: 'legacy', restoration: legacy };
    return legacy === undefined
      ? { kind: 'empty' }
      : { kind: 'incompatible', foundVersion: 'legacy-unrecognized' };
  } finally {
    db.close();
  }
}

function isValidSave<TVersion extends number>(
  candidate: unknown,
  version: TVersion,
): candidate is GuestSaveData & { schemaVersion: TVersion } {
  if (!candidate || typeof candidate !== 'object') return false;
  const save = candidate as Partial<GuestSaveData> & { schemaVersion?: number };
  return Boolean(
    save.schemaVersion === version &&
    Number.isFinite(save.savedAt) &&
    validateEconomyState(save.economy) &&
    isGameState(save.restoration) &&
    (save.legacyRestoration === undefined || isGameState(save.legacyRestoration)),
  );
}

function foundSchemaVersion(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object') return 'unrecognized';
  return (candidate as { schemaVersion?: unknown }).schemaVersion ?? 'unrecognized';
}

/** Resolve old seasons and offline accrual before the app exposes the restored state. */
export function restoreGuestProgress(save: GuestSaveV3, now: number): RestoredGuestProgress {
  const currentSeason = Math.max(seasonIdAt(now), save.economy.seasonId);
  const seasonChanged = currentSeason > save.economy.seasonId;
  if (seasonChanged) {
    return {
      state: resetForNewSeason(save.economy, currentSeason),
      restoration: createFreshSeasonRestoration(currentSeason),
      savedAt: now,
      seasonChanged: true,
      secondsApplied: 0,
    };
  }
  const offline = applyOfflineProgress(save.economy, save.savedAt, now);
  return {
    ...offline,
    restoration: save.restoration,
    // Keep a future checkpoint when the device clock moves backwards. Otherwise a later
    // clock correction can claim the same offline interval again.
    savedAt: Math.max(save.savedAt, now),
    seasonChanged: false,
  };
}

function createFreshSeasonRestoration(seasonId: number): GameState {
  // Importing the game constructor here keeps save restoration's season behavior testable.
  return createGameState(`season-${seasonId}`);
}

export async function saveGuestSave(
  economy: EconomyState,
  restoration: GameState,
  legacyRestoration?: GameState,
  savedAt = Date.now(),
): Promise<void> {
  if (!validateEconomyState(economy)) throw new Error('The incremental save is invalid.');
  if (!Number.isFinite(savedAt)) throw new Error('The save timestamp is invalid.');
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const previousRequest = store.get(CURRENT_SAVE_KEY);
      previousRequest.onsuccess = () => {
        const previous = previousRequest.result;
        const previousSavedAt = isValidSave(previous, GUEST_SAVE_SCHEMA_VERSION)
          ? previous.savedAt
          : Number.NEGATIVE_INFINITY;
        const save: GuestSaveV3 = {
          schemaVersion: GUEST_SAVE_SCHEMA_VERSION,
          savedAt: Math.max(savedAt, previousSavedAt),
          economy,
          restoration,
          ...(legacyRestoration ? { legacyRestoration } : {}),
        };
        store.put(save, CURRENT_SAVE_KEY);
      };
      previousRequest.onerror = () =>
        reject(previousRequest.error ?? new Error('Could not read the existing guest save.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not save the game.'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Game save was interrupted.'));
    });
  } finally {
    db.close();
  }
}

export async function archiveIncompatibleSave(): Promise<void> {
  const db = await openDatabase();
  try {
    const current = await readValue<unknown>(db, CURRENT_SAVE_KEY);
    if (current === undefined) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(current, `guest-incompatible-backup-${Date.now()}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not preserve the older save.'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Save backup was interrupted.'));
    });
  } finally {
    db.close();
  }
}

function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GameState>;
  const island = candidate.island;
  return Boolean(
    candidate.demo === true &&
    island &&
    typeof island.seed === 'string' &&
    (island.generatorVersion === 1 || island.generatorVersion === 2) &&
    Number.isSafeInteger(island.heartIndex) &&
    island.heartIndex >= 0 &&
    island.heartIndex < BOARD_SIZE * BOARD_SIZE &&
    isValidCells(island.cells) &&
    isValidInventory(candidate.inventory) &&
    Number.isSafeInteger(candidate.unlockedThrough) &&
    candidate.unlockedThrough! >= 0 &&
    candidate.unlockedThrough! < REGIONS.length &&
    isValidRegions(candidate.claimedRegions) &&
    Number.isSafeInteger(candidate.actionCount) &&
    candidate.actionCount! >= 0 &&
    typeof candidate.complete === 'boolean' &&
    Array.isArray(candidate.history) &&
    candidate.history.length <= 50 &&
    candidate.history.every(
      (snapshot) =>
        snapshot &&
        isValidCells(snapshot.cells) &&
        isValidInventory(snapshot.inventory) &&
        Number.isSafeInteger(snapshot.unlockedThrough) &&
        snapshot.unlockedThrough >= 0 &&
        snapshot.unlockedThrough < REGIONS.length &&
        isValidRegions(snapshot.claimedRegions),
    ),
  );
}

function isValidCells(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== BOARD_SIZE * BOARD_SIZE) return false;
  const regions = REGIONS.map((region) => region.id);
  const terrains: Terrain[] = ['meadow', 'shore', 'rock', 'heart'];
  const habitats: Array<Habitat | null> = ['water', 'grass', 'forest', null];
  return value.every((cell, index) => {
    if (!cell || typeof cell !== 'object') return false;
    const candidate = cell as {
      x?: unknown;
      y?: unknown;
      region?: unknown;
      terrain?: unknown;
      habitat?: unknown;
      placeable?: unknown;
      witnessCell?: unknown;
    };
    return (
      candidate.x === index % BOARD_SIZE &&
      candidate.y === Math.floor(index / BOARD_SIZE) &&
      regions.includes(candidate.region as RegionId) &&
      terrains.includes(candidate.terrain as Terrain) &&
      habitats.includes(candidate.habitat as Habitat | null) &&
      typeof candidate.placeable === 'boolean' &&
      typeof candidate.witnessCell === 'boolean'
    );
  });
}

function isValidInventory(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const inventory = value as Record<Habitat, unknown>;
  return (['water', 'grass', 'forest'] as const).every(
    (habitat) => Number.isSafeInteger(inventory[habitat]) && (inventory[habitat] as number) >= 0,
  );
}

function isValidRegions(value: unknown): value is RegionId[] {
  if (!Array.isArray(value)) return false;
  const regions = REGIONS.map((region) => region.id);
  return value.every((region) => regions.includes(region as RegionId));
}
