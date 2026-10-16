import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { onRequestPost } from '../../functions/api/expedition/candidates';
import type { D1Database, D1PreparedStatement, PagesContext } from '../../functions/_shared/types';

describe('candidate retrieval endpoint', () => {
  it('returns the durable candidate row after wallet proof and rejects challenge replay', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const message = `Worldseed H2 candidate request\nAddress: player\nExpedition: 1 (fresh V2 test environment)\nAction: Issue candidate set\nChallenge: one`;
    const storedPayload = JSON.stringify({
      version: 2,
      expeditionNumber: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      candidates: ['same-set'],
    });
    let challengeConsumed = false;
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first<T>() {
            if (sql.includes('FROM issuance_challenges'))
              return {
                player: account.address.toLowerCase(),
                message,
                expires_at: Math.floor(Date.now() / 1000) + 60,
              } as T;
            if (sql.includes('FROM candidate_sets')) return { payload: storedPayload } as T;
            return null;
          },
          async run() {
            if (sql.startsWith('DELETE FROM issuance_challenges')) {
              if (challengeConsumed) return { meta: { changes: 0 } };
              challengeConsumed = true;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
        };
        return statement as D1PreparedStatement;
      },
      async batch() {
        return [];
      },
    } as D1Database;
    const signature = await account.signMessage({ message });
    const expectedAttester = privateKeyToAccount(`0x${'22'.repeat(32)}`).address;
    const context = async (attesterAddress = expectedAttester): Promise<PagesContext> => ({
      env: {
        WORLDSEED_DB: db,
        ETHEREUM_SEPOLIA_RPC_URL: '',
        HEMI_SEPOLIA_RPC_URL: '',
        WORLDSEED_ATTESTATION_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
        WORLDSEED_V2_CONTRACT_ADDRESS: `0x${'33'.repeat(20)}`,
        WORLDSEED_V2_ATTESTER_ADDRESS: attesterAddress,
      },
      request: new Request('https://worldseed.example/api/expedition/candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ player: account.address, challengeId: 'challenge-one', signature }),
      }),
    });
    const first = await onRequestPost(await context());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      candidateSet: JSON.parse(storedPayload),
      selectedSource: null,
    });
    challengeConsumed = false;
    const mismatch = await onRequestPost(
      await context(privateKeyToAccount(`0x${'44'.repeat(32)}`).address),
    );
    expect(mismatch.status).toBe(503);
    expect(await mismatch.json()).toEqual({
      error: 'The candidate signer does not match the reviewed V2 attester.',
    });
    const replay = await onRequestPost(await context());
    expect(replay.status).toBe(409);
  });
});
