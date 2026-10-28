import { describe, expect, it } from 'vitest';
import { MAX_ATTESTED_NATURE_ATOMS, natureAtomsForSettlement } from './natureStatistics';

describe('Rebirth Nature statistics', () => {
  it('preserves zero and fractional Nature at canonical atom precision', () => {
    expect(natureAtomsForSettlement(0n)).toBe(0n);
    expect(natureAtomsForSettlement(1n)).toBe(1n);
    expect(natureAtomsForSettlement(999_999_999_999n)).toBe(999_999_999_999n);
  });

  it('saturates only above uint256 while preserving the exact maximum', () => {
    expect(natureAtomsForSettlement(MAX_ATTESTED_NATURE_ATOMS)).toBe(MAX_ATTESTED_NATURE_ATOMS);
    expect(natureAtomsForSettlement(MAX_ATTESTED_NATURE_ATOMS + 1n)).toBe(
      MAX_ATTESTED_NATURE_ATOMS,
    );
    expect(() => natureAtomsForSettlement(-1n)).toThrow(/cannot be negative/);
  });
});
