import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { candidateTypedData, issueCandidateSet } from './issuer';
import type { SourceId, SourceTransaction } from './model';

const key = `0x${'11'.repeat(32)}` as const;
const sources: SourceId[] = ['ethereum', 'hemi', 'bitcoin'];
const makeSources = () =>
  Object.fromEntries(
    sources.map((source, index) => [
      source,
      {
        source,
        networkId:
          source === 'bitcoin'
            ? 'bitcoin:testnet4'
            : `eip155:${source === 'hemi' ? 743111 : 11155111}`,
        networkName: source,
        txHash: `0x${String(index + 1).repeat(64)}`,
        blockHash: `0x${String(index + 4).repeat(64)}`,
        blockNumber: String(100 + index),
        transactionIndex: index,
        confirmations: source === 'bitcoin' ? 6 : 12,
        requiredConfirmations: source === 'bitcoin' ? 6 : 12,
        providerId: 'fixture',
        observedAt: 1_700_000_000,
      } satisfies SourceTransaction,
    ]),
  ) as Record<SourceId, SourceTransaction>;

describe('candidate attestations', () => {
  it('derives three stable seeds and signs the set in the Hemi Sepolia contract domain', async () => {
    const account = privateKeyToAccount(key);
    const input = {
      player: account.address,
      expeditionNumber: 1,
      sourceTransactions: makeSources(),
      hemiContractAddress: `0x${'22'.repeat(20)}` as const,
      signingPrivateKey: key,
      now: () => 1_700_000_000_000,
    };
    const first = await issueCandidateSet(input);
    const retry = await issueCandidateSet(input);
    expect(first.candidates.map(({ seed }) => seed)).toEqual(
      retry.candidates.map(({ seed }) => seed),
    );
    expect(first.commitment).toBe(retry.commitment);
    expect(first.signature).toBe(retry.signature);
    expect(first.candidates.map(({ source }) => source)).toEqual(sources);
    expect(
      await verifyTypedData({
        ...candidateTypedData(first, input.hemiContractAddress),
        address: account.address,
        signature: first.signature,
      }),
    ).toBe(true);
  });

  it('supports sequential expedition numbers and finite seven-day expiry', async () => {
    const now = 1_700_000_000_000;
    const set = await issueCandidateSet({
      player: privateKeyToAccount(key).address,
      expeditionNumber: 2,
      sourceTransactions: makeSources(),
      hemiContractAddress: `0x${'22'.repeat(20)}`,
      signingPrivateKey: key,
      now: () => now,
    });
    expect(set.expeditionNumber).toBe(2);
    expect(set.issuedAt).toBe(now / 1000);
    expect(set.expiresAt - set.issuedAt).toBe(7 * 24 * 60 * 60);
  });

  it('rejects a source record that does not meet its confirmation policy', async () => {
    const input = makeSources();
    input.bitcoin.confirmations = 5;
    await expect(
      issueCandidateSet({
        player: privateKeyToAccount(key).address,
        expeditionNumber: 1,
        sourceTransactions: input,
        hemiContractAddress: `0x${'22'.repeat(20)}`,
        signingPrivateKey: key,
      }),
    ).rejects.toThrow(/insufficiently confirmed/);
  });
});
