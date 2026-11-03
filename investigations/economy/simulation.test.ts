import { describe, expect, it } from 'vitest';
import { simulateAllStrategies, simulateStrategy } from './simulation';

describe('incremental economy simulation', () => {
  it('reaches first production and rebirth near five minutes with balanced active play', () => {
    const result = simulateStrategy('balanced-roi');
    expect(result.firstHabitatAt).toBeGreaterThan(0);
    expect(result.firstHabitatAt).toBeLessThan(30);
    expect(result.firstProductionAt).toBe(result.firstHabitatAt);
    expect(result.firstRebirthAt).toBeGreaterThanOrEqual(240);
    expect(result.firstRebirthAt).toBeLessThanOrEqual(360);
    expect(result.snapshots.map(({ second }) => second)).toEqual([300, 600, 1800, 3600]);
    expect(result.invalidValues).toEqual([]);
    expect(result.stalledAt).toBeNull();
  });

  it('accelerates subsequent balanced rebirths through Growth investment', () => {
    const result = simulateStrategy('balanced-roi');
    expect(result.rebirthTimes.length).toBeGreaterThan(1);
    expect(result.rebirthTimes[1]! - result.rebirthTimes[0]!).toBeLessThanOrEqual(
      result.rebirthTimes[0]!,
    );
  });

  it('keeps all purchasing strategies finite and detects a no-click stall', () => {
    for (const result of simulateAllStrategies()) expect(result.invalidValues).toEqual([]);
    expect(simulateStrategy('balanced-roi', { seconds: 120, clicksPerSecond: 0 }).stalledAt).toBe(
      60,
    );
  });
});
