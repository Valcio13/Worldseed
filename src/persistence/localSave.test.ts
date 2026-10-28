import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameState } from '../game/rules';
import { createEconomyState } from '../incremental/engine';
import { seasonIdAt } from '../incremental/season';
import { valueToNumber } from '../incremental/decimal';
import { GUEST_SAVE_SCHEMA_VERSION, loadGuestSave, restoreGuestProgress } from './localSave';

function installFakeSaveDatabase(entries: Record<string, unknown>) {
  const database = {
    close: vi.fn(),
    transaction: () => ({
      objectStore: () => ({
        get: (key: string) => {
          const request: {
            result: unknown;
            onsuccess: ((event: unknown) => void) | null;
            onerror: (() => void) | null;
          } = {
            result: entries[key],
            onsuccess: null,
            onerror: null,
          };
          void Promise.resolve().then(() => request.onsuccess?.({ target: request }));
          return request;
        },
      }),
    }),
  };
  const factory = {
    open: () => {
      const request: {
        result: typeof database;
        onsuccess: ((event: unknown) => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = {
        result: database,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      void Promise.resolve().then(() => request.onsuccess?.({ target: request }));
      return request;
    },
  };
  vi.stubGlobal('indexedDB', factory as never);
}

afterEach(() => vi.unstubAllGlobals());

describe('guest save version handling', () => {
  it('offers a legacy island without replacing or silently converting it', async () => {
    const oldIsland = createGameState('old-save', true);
    installFakeSaveDatabase({ 'guest-demo-v1': oldIsland });
    const result = await loadGuestSave();
    expect(result).toEqual({ kind: 'legacy', restoration: oldIsland });
  });

  it('leaves an unknown current schema incompatible instead of guessing a migration', async () => {
    installFakeSaveDatabase({ 'guest-incremental-v2': { schemaVersion: 99, savedAt: 1 } });
    expect(await loadGuestSave()).toEqual({ kind: 'incompatible', foundVersion: 99 });
  });

  it('migrates the known V2 save envelope and preserves the older source entry', async () => {
    const prior = {
      schemaVersion: 2,
      savedAt: Date.UTC(2026, 9, 26, 1),
      economy: {
        ...createEconomyState(seasonIdAt(Date.UTC(2026, 9, 26))),
        lifetimeCP: 12,
        lifetimeRebirths: 5,
      },
      restoration: createGameState('prior-season'),
    };
    installFakeSaveDatabase({ 'guest-incremental-v2': prior });
    const loaded = await loadGuestSave();
    expect(loaded.kind).toBe('current');
    if (loaded.kind !== 'current') throw new Error('Expected migrated save.');
    expect(loaded.migrated).toBe(true);
    expect(loaded.save.schemaVersion).toBe(GUEST_SAVE_SCHEMA_VERSION);
    expect(loaded.save.economy.lifetimeCP).toBe(12);
  });

  it('archives the saved active season once after crossing multiple weeks and grants no boundary offline income', async () => {
    const monday = Date.UTC(2026, 9, 26);
    const priorSeason = seasonIdAt(monday);
    const state = {
      ...createEconomyState(priorSeason),
      nature: { mantissa: 5, exponent: 0 },
      lifetimeNature: { mantissa: 50, exponent: 0 },
      lifetimeCP: 8,
      seasonRebirths: 2,
      seasonalCP: 3,
    };
    const save = {
      schemaVersion: GUEST_SAVE_SCHEMA_VERSION,
      savedAt: monday + 1_000,
      economy: state,
      restoration: createGameState('old-island'),
    } as const;
    const now = monday + 3 * 7 * 24 * 60 * 60 * 1000 + 2_000;
    const first = restoreGuestProgress(save, now);
    const repeated = restoreGuestProgress(save, now);
    expect(first.seasonChanged).toBe(true);
    expect(first.secondsApplied).toBe(0);
    expect(first.state.seasonId).toBe(seasonIdAt(now));
    expect(first.state.nature).toEqual({ mantissa: 0, exponent: 0 });
    expect(first.state.lifetimeCP).toBe(8);
    expect(first.state.lifetimeRebirths).toBe(0);
    expect(first.state.lifetimeNature).toEqual(state.lifetimeNature);
    expect(first.state.seasonRecords).toEqual([
      expect.objectContaining({ seasonId: priorSeason, rebirths: 2, communityPoints: 3 }),
    ]);
    expect(repeated.state.seasonRecords).toEqual(first.state.seasonRecords);
    expect(first.restoration.island.seed).toBe(`season-${seasonIdAt(now)}`);
  });

  it('caps offline accrual at eight hours on reload and advances the saved timestamp', async () => {
    const monday = Date.UTC(2026, 9, 26);
    const id = seasonIdAt(monday);
    const save = {
      schemaVersion: GUEST_SAVE_SCHEMA_VERSION,
      savedAt: monday + 1_000,
      economy: {
        ...createEconomyState(id),
        habitats: { water: 1, grass: 0, forest: 0 },
      },
      restoration: createGameState('same-season'),
    } as const;
    const now = monday + 5 * 60 * 60 * 1000;
    const restored = restoreGuestProgress(save, now);
    expect(restored.secondsApplied).toBe(5 * 60 * 60 - 1);
    expect(restored.savedAt).toBe(now);
    expect(valueToNumber(restored.state.nature)).toBeCloseTo(5_399.7, 8);
  });
});
