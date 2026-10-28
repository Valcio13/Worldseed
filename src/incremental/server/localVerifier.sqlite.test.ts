// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalRunInput } from '../rulesV1';
import { LocalVerifier, type RunAuthorityReader } from '../localVerifier';
import type { AuthenticatedWalletSession } from '../verifierProtocol';
import { SqliteVerifierStore } from './sqliteVerifierStore';

const monday = 345_600_000;
const session: AuthenticatedWalletSession = {
  wallet: '0x0000000000000000000000000000000000000001',
  chainId: 31_337n,
  verifyingContract: '0x0000000000000000000000000000000000000002',
  sessionId: 'session',
  runId: '42',
  origin: 'https://worldseed.example',
};
const input: CanonicalRunInput = {
  runId: '42',
  seasonId: 0,
  startedAtMs: monday,
  seasonalPP: 0n,
  existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
  seasonRebirths: 0,
  upgradeChoices: [],
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('durable local verifier recovery', () => {
  it('replays and idempotently returns accepted commands after a database reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'worldseed-verifier-recovery-'));
    directories.push(directory);
    const dbPath = join(directory, 'verifier.sqlite');
    const auth = { authenticate: async () => session };
    const authority: RunAuthorityReader = {
      getRunContext: async () => ({
        player: session.wallet,
        chainId: session.chainId,
        verifyingContract: session.verifyingContract,
        active: true,
        currentSeasonId: 0,
        input,
      }),
    };
    const clock = { nowMilliseconds: () => monday + 1_000 };
    const store = new SqliteVerifierStore(dbPath);
    const firstVerifier = new LocalVerifier(auth, authority, store, clock);
    const request = {
      sessionToken: 'test',
      runId: '42',
      commandId: 'durable-click',
      expectedSequence: 0,
      command: { type: 'heart-click' as const },
    };
    const first = await firstVerifier.submit(request);
    expect(first.cursor.sequence).toBe(1);
    store.close();

    const recoveredStore = new SqliteVerifierStore(dbPath);
    const recoveredVerifier = new LocalVerifier(auth, authority, recoveredStore, clock);
    const recovered = await recoveredVerifier.recover('test', '42');
    expect(recovered.cursor.sequence).toBe(1);
    expect(recovered.state.earnedNatureAtoms).toBe(1_000_000_000_000n);
    const duplicate = await recoveredVerifier.submit(request);
    expect(duplicate.cursor.sequence).toBe(1);
    expect(duplicate.state.earnedNatureAtoms).toBe(first.state.earnedNatureAtoms);
    recoveredStore.close();
  });
});
