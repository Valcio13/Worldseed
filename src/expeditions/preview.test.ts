import { describe, expect, it } from 'vitest';
import type { IslandCandidate } from './model';
import { getCandidatePreview } from './preview';

const candidate: IslandCandidate = {
  source: 'ethereum',
  sourceName: 'Ethereum Sepolia',
  seed: `0x${'12'.repeat(32)}`,
  transaction: {
    source: 'ethereum',
    networkId: 'eip155:11155111',
    networkName: 'Ethereum Sepolia',
    txHash: `0x${'34'.repeat(32)}`,
    blockHash: `0x${'56'.repeat(32)}`,
    blockNumber: '1',
    transactionIndex: 0,
    confirmations: 12,
    requiredConfirmations: 12,
    providerId: 'test',
    observedAt: 1,
  },
  description: 'Ethereum Sepolia transaction seed · generator 2',
};

describe('candidate previews and selection persistence', () => {
  it('previews the exact 49-cell candidate generator output deterministically', () => {
    const first = getCandidatePreview(candidate);
    expect(first.cells).toHaveLength(49);
    expect(getCandidatePreview(candidate)).toEqual(first);
    expect(first.cells.filter((cell) => cell.witnessCell).length).toBeGreaterThan(0);
  });
});
