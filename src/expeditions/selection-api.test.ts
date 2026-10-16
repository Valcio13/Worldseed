import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { onRequestPost } from '../../functions/api/expedition/selection';
import type { D1Database, D1PreparedStatement, PagesContext } from '../../functions/_shared/types';

describe('candidate selection endpoint', () => {
  it('locks one source in D1 and rejects a later different selection', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const commitment = `0x${'44'.repeat(32)}`;
    const payload = JSON.stringify({
      version: 2,
      commitment,
      candidates: [{ source: 'ethereum' }, { source: 'hemi' }, { source: 'bitcoin' }],
    });
    let selectedSource: string | null = null;
    let challengeMessage = '';
    let challengeConsumed = false;
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) {
            values = args;
            return statement;
          },
          async first<T>() {
            if (sql.includes('FROM issuance_challenges'))
              return {
                player: account.address.toLowerCase(),
                message: challengeMessage,
                expires_at: Math.floor(Date.now() / 1000) + 60,
              } as T;
            if (sql.includes('FROM candidate_sets'))
              return { payload, selected_source: selectedSource } as T;
            return null;
          },
          async run() {
            if (sql.startsWith('DELETE FROM issuance_challenges')) {
              if (challengeConsumed) return { meta: { changes: 0 } };
              challengeConsumed = true;
            }
            if (sql.startsWith('UPDATE candidate_sets')) selectedSource ??= String(values[0]);
            return { meta: { changes: 1 } };
          },
        };
        return statement as D1PreparedStatement;
      },
      async batch() {
        return [];
      },
    } as D1Database;
    const call = async (source: string) => {
      const challengeId = `challenge-${source}`;
      challengeMessage = [
        'Worldseed H2 candidate request',
        `Address: ${account.address.toLowerCase()}`,
        'Expedition: 1 (fresh V2 test environment)',
        'Action: Select island',
        `Commitment: ${commitment}`,
        `Source: ${source}`,
      ].join('\n');
      challengeConsumed = false;
      const signature = await account.signMessage({ message: challengeMessage });
      const request = new Request('https://worldseed.example/api/expedition/selection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          player: account.address,
          expeditionNumber: 1,
          challengeId,
          signature,
          commitment,
          source,
        }),
      });
      const context: PagesContext = {
        request,
        env: {
          WORLDSEED_DB: db,
          ETHEREUM_SEPOLIA_RPC_URL: '',
          HEMI_SEPOLIA_RPC_URL: '',
          WORLDSEED_ATTESTATION_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
          WORLDSEED_V2_CONTRACT_ADDRESS: `0x${'33'.repeat(20)}`,
          WORLDSEED_V2_ATTESTER_ADDRESS: privateKeyToAccount(`0x${'22'.repeat(32)}`).address,
        },
      };
      return onRequestPost(context);
    };

    const first = await call('ethereum');
    expect(first.status).toBe(200);
    expect(selectedSource).toBe('ethereum');
    const second = await call('hemi');
    expect(second.status).toBe(409);
    expect(selectedSource).toBe('ethereum');
  });
});
