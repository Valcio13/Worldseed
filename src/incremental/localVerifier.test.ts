import { describe, expect, it } from 'vitest';
import {
  LocalVerifier,
  MemoryVerifierPersistence,
  commandReceiptToWire,
  type RunAuthorityReader,
  type VerifierClock,
  type VerifierPersistence,
  type WalletSessionAuthenticator,
} from './localVerifier';
import { VerifierError, type CommandRequest } from './verifierProtocol';

const MONDAY_EPOCH_MS = 4 * 24 * 60 * 60 * 1_000;
const session = {
  wallet: '0x0000000000000000000000000000000000000001',
  chainId: 31_337n,
  verifyingContract: '0x0000000000000000000000000000000000000002',
  sessionId: 'session-1',
  runId: '42',
  origin: 'https://worldseed.example',
};

class TestClock implements VerifierClock {
  now = MONDAY_EPOCH_MS + 1_000;
  nowMilliseconds(): number {
    return this.now;
  }
}

class TestAuthority implements RunAuthorityReader {
  currentSeasonId = 0;
  active = true;
  rulesVersion?: number;
  readonly input = {
    runId: '42',
    seasonId: 0,
    startedAtMs: MONDAY_EPOCH_MS,
    seasonalPP: 0n,
    existingUpgrades: { growth: 0, efficiency: 0, awakening: 0, rebirth: 0 },
    seasonRebirths: 0,
    upgradeChoices: [],
  } as const;
  async getRunContext() {
    return {
      player: session.wallet,
      chainId: session.chainId,
      verifyingContract: session.verifyingContract,
      active: this.active,
      currentSeasonId: this.currentSeasonId,
      rulesVersion: this.rulesVersion,
      input: this.input,
    };
  }
}

const auth: WalletSessionAuthenticator = {
  async authenticate(token) {
    return token === 'valid' ? session : null;
  },
};

function setup(persistence = new MemoryVerifierPersistence()) {
  const clock = new TestClock();
  const authority = new TestAuthority();
  const verifier = new LocalVerifier(auth, authority, persistence, clock);
  return { verifier, clock, authority, persistence };
}

function request(
  commandId: string,
  expectedSequence: number,
  command: CommandRequest['command'] = { type: 'heart-click' },
): CommandRequest {
  return {
    sessionToken: 'valid',
    runId: '42',
    commandId,
    expectedSequence,
    command,
    clientTimestampMs: -9_999_999,
  };
}

describe('local command verifier', () => {
  it('requires an authenticated wallet session and binds run lookup to that identity', async () => {
    const { verifier } = setup();
    await expect(
      verifier.submit({ ...request('x', 0), sessionToken: 'bad' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const wrongAuthority: RunAuthorityReader = {
      async getRunContext() {
        return null;
      },
    };
    const wrong = new LocalVerifier(
      auth,
      wrongAuthority,
      new MemoryVerifierPersistence(),
      new TestClock(),
    );
    await expect(wrong.submit(request('x', 0))).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('reuses a wallet session from the previous run after the next run is verified on chain', async () => {
    const priorRunSession = { ...session, runId: '41' };
    const reusableAuth: WalletSessionAuthenticator = {
      async authenticate(token) {
        return token === 'valid' ? priorRunSession : null;
      },
    };
    const { clock, authority, persistence } = setup();
    const verifier = new LocalVerifier(reusableAuth, authority, persistence, clock);

    await expect(verifier.submit(request('next-run-heart', 0))).resolves.toMatchObject({
      accepted: true,
      cursor: { runId: '42', sequence: 1 },
    });
  });

  it('accepts a command once and returns the prior result for an exact retry', async () => {
    const { verifier } = setup();
    const first = await verifier.submit(request('cmd-1', 0));
    const retry = await verifier.submit(request('cmd-1', 0));
    expect(first.cursor.sequence).toBe(1);
    expect(retry).toEqual(first);
    expect(retry.state.earnedNatureAtoms).toBe(1_000_000_000_000n);
    expect(commandReceiptToWire(first).creditedAtoms).toBe('1000000000000');
    expect(JSON.parse(commandReceiptToWire(first).canonicalState).earnedNatureAtoms).toBe(
      '1000000000000',
    );
  });

  it('rejects command-ID reuse with altered content, sequence gaps, and stale cursors', async () => {
    const { verifier } = setup();
    await verifier.submit(request('cmd-1', 0));
    await expect(verifier.submit(request('cmd-1', 0, { type: 'sync' }))).rejects.toMatchObject({
      code: 'COMMAND_ID_CONFLICT',
    });
    await expect(verifier.submit(request('gap', 3))).rejects.toMatchObject({
      code: 'SEQUENCE_GAP',
      expectedSequence: 1,
    });
    await expect(verifier.submit(request('stale', 0))).rejects.toMatchObject({
      code: 'STALE_CURSOR',
      expectedSequence: 1,
      recovery: { cursor: { runId: '42', sequence: 1 }, canonicalState: expect.any(String) },
    });
  });

  it('does not consume a sequence when canonical rules reject a command', async () => {
    const { verifier } = setup();
    await expect(
      verifier.submit(
        request('too-expensive', 0, { type: 'buy-habitat', habitat: 'forest', quantity: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'RULES_REJECTED' });
    const accepted = await verifier.submit(request('valid', 0));
    expect(accepted.cursor.sequence).toBe(1);
  });

  it('recovers deterministically after verifier restart and ignores client timestamps', async () => {
    const persistence = new MemoryVerifierPersistence();
    const firstVerifier = setup(persistence).verifier;
    await firstVerifier.submit(request('cmd-1', 0));
    const { verifier: restarted, clock } = setup(persistence);
    clock.now = MONDAY_EPOCH_MS + 4_000;
    const recovered = await restarted.recover('valid', '42');
    expect(recovered.state.sequence).toBe(1);
    expect(recovered.state.earnedNatureAtoms).toBe(1_000_000_000_000n);
    const next = await restarted.submit(request('cmd-2', 1, { type: 'sync' }));
    expect(next.serverTimeMs).toBe(MONDAY_EPOCH_MS + 4_000);
    expect(next.state.earnedNatureAtoms).toBe(1_000_000_000_000n);
  });

  it('replays a V3 Nature Surge purchase idempotently and keeps the run pinned to rules 3', async () => {
    const persistence = new MemoryVerifierPersistence();
    const { clock, authority } = setup(persistence);
    authority.rulesVersion = 3;
    const verifier = new LocalVerifier(auth, authority, persistence, clock);
    for (let sequence = 0; sequence < 15; sequence++)
      await verifier.submit(request(`fund-v3-${sequence}`, sequence, { type: 'heart-click', quantity: 100 }));

    const surgeRequest = request('v3-surge', 15, {
      type: 'buy-temporary-upgrade', upgrade: 'nature-surge',
    });
    const bought = await verifier.submit(surgeRequest);
    expect(bought.cursor.rulesVersion).toBe(3);
    expect(bought.spentAtoms).toBe(1_500_000_000_000_000n);
    expect((bought.state as import('./rulesV3').CanonicalRunState).temporaryMs['nature-surge']).toBe(30_000);

    const restarted = new LocalVerifier(auth, authority, persistence, clock);
    await expect(restarted.submit(surgeRequest)).resolves.toEqual(bought);
    const recovered = await restarted.recover('valid', '42');
    expect(recovered.cursor.rulesVersion).toBe(3);
    expect(recovered.state.sequence).toBe(16);
    expect((recovered.state as import('./rulesV3').CanonicalRunState).natureAtoms).toBe(0n);
  });

  it('replays V2 habitat-upgrade commands idempotently after persistence recovery', async () => {
    const persistence = new MemoryVerifierPersistence();
    const clock = new TestClock();
    const authority: RunAuthorityReader = {
      async getRunContext() {
        return {
          player: session.wallet,
          chainId: session.chainId,
          verifyingContract: session.verifyingContract,
          active: true,
          currentSeasonId: 0,
          rulesVersion: 2,
          input: {
            ...new TestAuthority().input,
            seasonalPP: 10_000n,
            upgradeChoices: [{ upgradeId: 'awakening', quantity: 100 }],
          },
        };
      },
    };
    const firstVerifier = new LocalVerifier(auth, authority, persistence, clock);
    const buy = await firstVerifier.submit(
      request('buy-ten-water', 0, { type: 'buy-habitat', habitat: 'water', quantity: 10 }),
    );
    clock.now = MONDAY_EPOCH_MS + 6 * 60 * 1_000;
    const upgrade = await firstVerifier.submit(
      request('water-milestone-10', 1, {
        type: 'buy-habitat-production-upgrade',
        habitat: 'water',
        milestone: 10,
      }),
    );
    expect(buy.cursor.rulesVersion).toBe(2);
    expect(
      (upgrade.state as import('./rulesV2').CanonicalRunState).habitatProductionUpgrades.water,
    ).toEqual([10]);

    const restarted = new LocalVerifier(auth, authority, persistence, clock);
    const recovered = await restarted.recover('valid', '42');
    expect(recovered.cursor).toEqual(upgrade.cursor);
    expect(
      (recovered.state as import('./rulesV2').CanonicalRunState).habitatProductionUpgrades.water,
    ).toEqual([10]);
    expect(
      await restarted.submit(
        request('water-milestone-10', 1, {
          type: 'buy-habitat-production-upgrade',
          habitat: 'water',
          milestone: 10,
        }),
      ),
    ).toEqual(upgrade);
  });

  it('settles passive production from verifier time, capped by rules, not client time', async () => {
    const { verifier, clock } = setup();
    clock.now = MONDAY_EPOCH_MS + 1_000;
    for (let sequence = 0; sequence < 10; sequence += 1)
      await verifier.submit(request(`click-${sequence}`, sequence));
    await verifier.submit(
      request('buy-water', 10, { type: 'buy-habitat', habitat: 'water', quantity: 1 }),
    );
    clock.now = MONDAY_EPOCH_MS + 4_000;
    const receipt = await verifier.submit(request('sync', 11, { type: 'sync' }));
    expect(receipt.creditedAtoms).toBe(900_000_000_000n);
    expect(receipt.state.lastServerTimeMs).toBe(clock.now);
    expect(receipt.state.earnedNatureAtoms).toBe(10_900_000_000_000n);
  });

  it('rejects commands across season rollover without mutating accepted state', async () => {
    const { verifier, authority, clock } = setup();
    const accepted = await verifier.submit(request('cmd-1', 0));
    authority.currentSeasonId = 1;
    clock.now = MONDAY_EPOCH_MS + 7 * 24 * 60 * 60 * 1_000 + 100;
    await expect(verifier.submit(request('next-season', 1))).rejects.toMatchObject({
      code: 'SEASON_EXPIRED',
    });
    const recovered = await verifier.recover('valid', '42');
    expect(recovered.cursor.sequence).toBe(accepted.cursor.sequence);
    expect(recovered.state.earnedNatureAtoms).toBe(accepted.state.earnedNatureAtoms);
  });

  it('fails closed on missing or inconsistent persisted command history', async () => {
    const { verifier, persistence } = setup();
    await verifier.submit(request('cmd-1', 0));
    class TruncatedPersistence implements VerifierPersistence {
      async read(key: string) {
        const journal = await persistence.read(key);
        return journal ? { ...journal, events: [], headSequence: 1 } : null;
      }
      findCommand(key: string, commandId: string) {
        return persistence.findCommand(key, commandId);
      }
      initializeIfAbsent(key: string, state: string) {
        return persistence.initializeIfAbsent(key, state);
      }
      appendIfCurrentSequence(
        key: string,
        seq: number,
        event: Parameters<VerifierPersistence['appendIfCurrentSequence']>[2],
      ) {
        return persistence.appendIfCurrentSequence(key, seq, event);
      }
    }
    const corrupted = new LocalVerifier(
      auth,
      new TestAuthority(),
      new TruncatedPersistence(),
      new TestClock(),
    );
    await expect(corrupted.recover('valid', '42')).rejects.toMatchObject({
      code: 'RECOVERY_FAILED',
    });
  });

  it('serializes concurrent commands using compare-and-swap and never forks the cursor', async () => {
    const { verifier } = setup();
    const outcomes = await Promise.allSettled([
      verifier.submit(request('a', 0)),
      verifier.submit(request('b', 0)),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(VerifierError);
    const recovered = await verifier.recover('valid', '42');
    expect(recovered.cursor.sequence).toBe(1);
    expect(recovered.state.sequence).toBe(1);
  });
});
