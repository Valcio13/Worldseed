import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buyFertileSoil,
  buyHabitatProductionUpgrade,
  buyTemporaryUpgrade,
  buyTimeBloom,
  createEconomyState,
  MAX_OFFLINE_SECONDS,
  performRebirth,
} from '../incremental/engine';
import { valueToNumber } from '../incremental/decimal';
import { seasonIdAt } from '../incremental/season';
import { createGameState } from '../game/rules';
import { loadGuestSave, restoreGuestProgress, saveGuestSave } from './localSave';

function installFakeSaveDatabase(entries: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(entries));
  const database = {
    close: vi.fn(),
    createObjectStore: vi.fn(),
    transaction: () => {
      const transaction = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
      };
      return {
        get oncomplete() {
          return transaction.oncomplete;
        },
        set oncomplete(value: (() => void) | null) {
          transaction.oncomplete = value;
        },
        get onerror() {
          return transaction.onerror;
        },
        set onerror(value: (() => void) | null) {
          transaction.onerror = value;
        },
        get onabort() {
          return transaction.onabort;
        },
        set onabort(value: (() => void) | null) {
          transaction.onabort = value;
        },
        objectStore: () => ({
          get: (key: string) => {
            const request: { result: unknown; onsuccess: (() => void) | null } = {
              result: values.get(key),
              onsuccess: null,
            };
            void Promise.resolve().then(() => request.onsuccess?.());
            return request;
          },
          put: (value: unknown, key: string) => {
            values.set(key, value);
            void Promise.resolve().then(() => transaction.oncomplete?.());
          },
        }),
      };
    },
  };
  const factory = {
    open: () => {
      const request: {
        result: typeof database;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = { result: database, onsuccess: null, onerror: null, onupgradeneeded: null };
      void Promise.resolve().then(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  vi.stubGlobal('indexedDB', factory as never);
  return { values, database };
}

afterEach(() => vi.unstubAllGlobals());

describe('guest local save recovery', () => {
  it('persists and restores guest economy and island state from the local save', async () => {
    const { values } = installFakeSaveDatabase();
    const now = Date.UTC(2026, 9, 27, 12);
    const economy = {
      ...createEconomyState(seasonIdAt(now)),
      nature: { mantissa: 2.5, exponent: 2 },
      habitats: { water: 3, grass: 1, forest: 0 },
    };
    const restoration = createGameState('guest-persistence');

    await saveGuestSave(economy, restoration, undefined, now);
    const loaded = await loadGuestSave();

    expect(values.has('guest-incremental-v3')).toBe(true);
    expect(loaded.kind).toBe('current');
    if (loaded.kind !== 'current') throw new Error('Expected a current guest save.');
    expect(loaded.save.economy).toEqual(economy);
    expect(loaded.save.restoration).toEqual(restoration);
    expect(loaded.save.savedAt).toBe(now);
  });

  it('persists and restores the completed guest Rebirth and its PP/CP rewards', async () => {
    installFakeSaveDatabase();
    const now = Date.UTC(2026, 9, 27, 12);
    const base = createEconomyState(seasonIdAt(now));
    const eligible = {
      ...base,
      nature: { mantissa: 2, exponent: 3 },
      runNature: { mantissa: 2, exponent: 3 },
      habitats: { water: 4, grass: 2, forest: 1 },
    };
    const rebirthed = performRebirth(eligible).state;

    await saveGuestSave(rebirthed, createGameState('rebirth-round-trip'), undefined, now);
    const loaded = await loadGuestSave();
    if (loaded.kind !== 'current') throw new Error('Expected a current guest save.');
    const restored = restoreGuestProgress(loaded.save, now).state;

    expect(restored).toEqual(rebirthed);
    expect(restored.seasonalPP).toBe(1);
    expect(restored.seasonalCP).toBe(1);
    expect(restored.lifetimeCP).toBe(1);
    expect(restored.seasonRebirths).toBe(1);
    expect(restored.lifetimeRebirths).toBe(1);
    expect(restored.habitats).toEqual({
      water: 0,
      grass: 0,
      forest: 0,
      mountain: 0,
      'crystal-cavern': 0,
      'ancient-grove': 0,
    });
  });

  it('persists and recovers habitat production upgrades across a local save reload', async () => {
    installFakeSaveDatabase();
    const now = Date.UTC(2026, 9, 27, 12);
    const base = createEconomyState(seasonIdAt(now));
    const bought = buyHabitatProductionUpgrade(
      {
        ...base,
        nature: { mantissa: 1, exponent: 3 },
        habitats: { ...base.habitats, water: 10 },
      },
      'water',
    );
    expect(bought.error).toBeUndefined();

    await saveGuestSave(bought.state, createGameState('habitat-upgrade-round-trip'), undefined, now);
    const loaded = await loadGuestSave();
    if (loaded.kind !== 'current') throw new Error('Expected a current guest save.');
    expect(loaded.save.economy.habitatProductionUpgrades?.water).toBe(1);
    expect(restoreGuestProgress(loaded.save, now).state.habitatProductionUpgrades?.water).toBe(1);
  });

  it('persists and restores Nature Boost purchases, timers, and run limits', async () => {
    installFakeSaveDatabase();
    const now = Date.UTC(2026, 9, 27, 12);
    const base = createEconomyState(seasonIdAt(now));
    const funded = {
      ...base,
      nature: { mantissa: 2, exponent: 4 },
      habitats: { ...base.habitats, water: 1 },
    };
    const fertile = buyFertileSoil(funded);
    const surge = buyTemporaryUpgrade(fertile.state, 'nature-surge');
    const bloom = buyTimeBloom(surge.state);
    expect(fertile.error).toBeUndefined();
    expect(surge.error).toBeUndefined();
    expect(bloom.error).toBeUndefined();

    await saveGuestSave(bloom.state, createGameState('nature-boost-round-trip'), undefined, now);
    const loaded = await loadGuestSave();
    if (loaded.kind !== 'current') throw new Error('Expected a current guest save.');
    const restored = restoreGuestProgress(loaded.save, now).state;

    expect(restored.fertileSoilLevel).toBe(1);
    expect(restored.timeBloomUsed).toBe(true);
    expect(restored.temporaryUpgrades['nature-surge']).toBe(30);
    expect(restored).toEqual(bloom.state);
  });

  it('treats a null or malformed current save as recoverable incompatible data', async () => {
    installFakeSaveDatabase({ 'guest-incremental-v3': null });
    expect(await loadGuestSave()).toEqual({ kind: 'incompatible', foundVersion: 'unrecognized' });

    installFakeSaveDatabase({ 'guest-incremental-v3': 'corrupt payload' });
    expect(await loadGuestSave()).toEqual({ kind: 'incompatible', foundVersion: 'unrecognized' });

    const now = Date.UTC(2026, 9, 27);
    const restoration = createGameState('corrupt-board');
    const malformedSave = {
      schemaVersion: 3,
      savedAt: now,
      economy: createEconomyState(seasonIdAt(now)),
      restoration: {
        ...restoration,
        island: { ...restoration.island, cells: Array(49).fill(null) },
      },
    };
    installFakeSaveDatabase({ 'guest-incremental-v3': malformedSave });
    expect(await loadGuestSave()).toEqual({ kind: 'incompatible', foundVersion: 3 });
  });

  it('applies at most eight offline hours and does not reapply them after saving and reloading', async () => {
    installFakeSaveDatabase();
    const monday = Date.UTC(2026, 9, 26);
    const savedAt = monday + 1_000;
    const economy = {
      ...createEconomyState(seasonIdAt(monday)),
      habitats: { water: 1, grass: 0, forest: 0 },
    };
    const restoration = createGameState('offline-reload');
    await saveGuestSave(economy, restoration, undefined, savedAt);

    const firstLoad = await loadGuestSave();
    if (firstLoad.kind !== 'current') throw new Error('Expected the initial guest save.');
    const now = savedAt + 11 * 60 * 60 * 1000;
    const firstRestore = restoreGuestProgress(firstLoad.save, now);
    expect(firstRestore.secondsApplied).toBe(MAX_OFFLINE_SECONDS);
    expect(valueToNumber(firstRestore.state.nature)).toBeCloseTo(0.3 * MAX_OFFLINE_SECONDS, 8);
    await saveGuestSave(
      firstRestore.state,
      firstRestore.restoration,
      undefined,
      firstRestore.savedAt,
    );

    const reloaded = await loadGuestSave();
    if (reloaded.kind !== 'current') throw new Error('Expected the saved offline progress.');
    const secondRestore = restoreGuestProgress(reloaded.save, now);
    expect(secondRestore.secondsApplied).toBe(0);
    expect(secondRestore.state.nature).toEqual(firstRestore.state.nature);
  });

  it('keeps a future save checkpoint when the device clock moves backwards', () => {
    const savedAt = Date.UTC(2026, 9, 27, 12);
    const economy = {
      ...createEconomyState(seasonIdAt(savedAt)),
      nature: { mantissa: 4, exponent: 3 },
      habitats: { water: 1, grass: 0, forest: 0 },
    };
    const save = {
      schemaVersion: 3 as const,
      savedAt,
      economy,
      restoration: createGameState('clock-rollback'),
    };

    const restored = restoreGuestProgress(save, savedAt - 60 * 60 * 1000);

    expect(restored.savedAt).toBe(savedAt);
    expect(restored.secondsApplied).toBe(0);
    expect(restored.state).toEqual(economy);
    expect(valueToNumber(restored.state.nature)).toBeCloseTo(4_000, 8);
  });

  it('does not move a persisted offline checkpoint backwards during clock rollback', async () => {
    const { values } = installFakeSaveDatabase();
    const savedAt = Date.UTC(2026, 9, 27, 12);
    const economy = createEconomyState(seasonIdAt(savedAt));
    const restoration = createGameState('monotonic-checkpoint');
    await saveGuestSave(economy, restoration, undefined, savedAt);

    await saveGuestSave(economy, restoration, undefined, savedAt - 60 * 60 * 1000);

    expect((values.get('guest-incremental-v3') as { savedAt: number }).savedAt).toBe(savedAt);
  });
});
