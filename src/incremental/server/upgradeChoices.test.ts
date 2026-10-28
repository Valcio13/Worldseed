import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import vectors from '../v3TestVectors.json';
import {
  hashUpgradeChoices,
  encodeUpgradeChoices,
  toSolidityUpgradeChoices,
} from './upgradeChoices';

const choices = [
  { upgradeId: 'growth' as const, quantity: 2 },
  { upgradeId: 'awakening' as const, quantity: 1 },
];

describe('Solidity PP upgrade commitment encoding', () => {
  it('matches abi.encode(tuple[] (uint8,uint16)) and Keccak-256', () => {
    const expected = encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'upgradeId', type: 'uint8' },
            { name: 'quantity', type: 'uint16' },
          ],
        },
      ],
      [
        [
          { upgradeId: 0, quantity: 2 },
          { upgradeId: 2, quantity: 1 },
        ],
      ],
    );
    expect(encodeUpgradeChoices(choices)).toBe(expected);
    expect(hashUpgradeChoices(choices)).toBe(keccak256(expected));
    expect(expected).toBe(vectors.upgradeCommitment.encoded);
    expect(hashUpgradeChoices(choices)).toBe(vectors.upgradeCommitment.keccak256);
  });

  it('rejects unsorted, duplicate, unknown, zero, and oversized choices', () => {
    expect(() => toSolidityUpgradeChoices([...choices].reverse())).toThrow(/sorted/);
    expect(() => toSolidityUpgradeChoices([choices[0]!, choices[0]!])).toThrow(/sorted/);
    expect(() => toSolidityUpgradeChoices([{ upgradeId: 'growth', quantity: 0 }])).toThrow(
      /positive/,
    );
    expect(() => toSolidityUpgradeChoices([{ upgradeId: 'growth', quantity: 65_536 }])).toThrow(
      /uint16/,
    );
  });

  it('rejects the verified Rebirth upgrade because it currently has no benefit', () => {
    expect(() => toSolidityUpgradeChoices([{ upgradeId: 'rebirth', quantity: 1 }])).toThrow(
      /disabled/,
    );
  });
});
