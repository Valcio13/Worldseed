// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { SqliteVerifierStore } from './sqliteVerifierStore';
import { EoaAndContractWalletMessageVerifier, SqliteWalletSessions } from './walletSessions';

const disposableWallet = privateKeyToAccount(`0x${'0'.repeat(63)}2`);
const contract = '0x0000000000000000000000000000000000000004';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(now: { value: number }) {
  const directory = mkdtempSync(join(tmpdir(), 'worldseed-session-'));
  directories.push(directory);
  const store = new SqliteVerifierStore(join(directory, 'session.sqlite'));
  const eip1271 = { isValidSignature: async () => false };
  const sessions = new SqliteWalletSessions(
    store,
    new EoaAndContractWalletMessageVerifier(eip1271),
    {
      deployments: new Map([['31337', contract]]),
      allowedOrigins: new Set(['https://worldseed.example']),
      nowMilliseconds: () => now.value,
    },
  );
  return { directory, store, sessions };
}

describe('wallet challenge and session security', () => {
  it('authenticates recovered signer, binds origin/chain/contract/run, and prevents challenge replay', async () => {
    const now = { value: 10_000 };
    const { directory, store, sessions } = setup(now);
    const challenge = sessions.issueChallenge({
      wallet: disposableWallet.address,
      chainId: '31337',
      verifyingContract: contract,
      origin: 'https://worldseed.example',
      runId: '42',
    });
    const signature = await disposableWallet.signMessage({ message: challenge.message });
    const [first, second] = await Promise.all(
      [
        sessions.completeChallenge(challenge.challengeId, signature),
        sessions.completeChallenge(challenge.challengeId, signature),
      ].map((promise) =>
        promise.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      ),
    );
    const successes = [first, second].filter((result) => 'value' in result);
    const failures = [first, second].filter((result) => 'error' in result);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const token = successes[0]!.value!.sessionToken;
    expect(await sessions.authenticate(token)).toMatchObject({
      wallet: disposableWallet.address,
      chainId: 31_337n,
      verifyingContract: contract,
      runId: '42',
      origin: 'https://worldseed.example',
    });
    expect(store.getSession(token, now.value)).toBeNull(); // only the SHA-256 digest is persisted
    store.close();

    const recoveredStore = new SqliteVerifierStore(join(directory, 'session.sqlite'));
    const recoveredSessions = new SqliteWalletSessions(
      recoveredStore,
      new EoaAndContractWalletMessageVerifier({ isValidSignature: async () => false }),
      {
        deployments: new Map([['31337', contract]]),
        allowedOrigins: new Set(['https://worldseed.example']),
        nowMilliseconds: () => now.value,
      },
    );
    expect(await recoveredSessions.authenticate(token)).toMatchObject({
      wallet: disposableWallet.address,
      runId: '42',
    });
    expect(await recoveredSessions.authenticate(`${token}x`)).toBeNull();
    recoveredSessions.revoke(token);
    expect(await recoveredSessions.authenticate(token)).toBeNull();
    recoveredStore.close();
  });

  it('rejects unconfigured chain/contract and unapproved origins before issuing a challenge', () => {
    const { store, sessions } = setup({ value: 10_000 });
    const request = {
      wallet: disposableWallet.address,
      chainId: '31337',
      verifyingContract: contract,
      origin: 'https://worldseed.example',
      runId: '1',
    };
    expect(() => sessions.issueChallenge({ ...request, chainId: '1' })).toThrow(
      /Unsupported chain/,
    );
    expect(() =>
      sessions.issueChallenge({ ...request, verifyingContract: disposableWallet.address }),
    ).toThrow(/Unsupported chain/);
    expect(() => sessions.issueChallenge({ ...request, origin: 'https://evil.example' })).toThrow(
      /allowlisted/,
    );
    store.close();
  });

  it('enforces challenge and session expiry using the injected server clock', async () => {
    const now = { value: 1_000 };
    const directory = mkdtempSync(join(tmpdir(), 'worldseed-session-expiry-'));
    directories.push(directory);
    const store = new SqliteVerifierStore(join(directory, 'session.sqlite'));
    const sessions = new SqliteWalletSessions(
      store,
      new EoaAndContractWalletMessageVerifier({ isValidSignature: async () => false }),
      {
        deployments: new Map([['31337', contract]]),
        allowedOrigins: new Set(['https://worldseed.example']),
        nowMilliseconds: () => now.value,
        challengeTtlMs: 100,
        sessionTtlMs: 200,
      },
    );
    const expired = sessions.issueChallenge({
      wallet: disposableWallet.address,
      chainId: '31337',
      verifyingContract: contract,
      origin: 'https://worldseed.example',
      runId: '1',
    });
    now.value += 101;
    const expiredSignature = await disposableWallet.signMessage({ message: expired.message });
    await expect(sessions.completeChallenge(expired.challengeId, expiredSignature)).rejects.toThrow(
      /expired/,
    );

    now.value = 2_000;
    const valid = sessions.issueChallenge({
      wallet: disposableWallet.address,
      chainId: '31337',
      verifyingContract: contract,
      origin: 'https://worldseed.example',
      runId: '1',
    });
    const signature = await disposableWallet.signMessage({ message: valid.message });
    const response = await sessions.completeChallenge(valid.challengeId, signature);
    now.value += 201;
    expect(await sessions.authenticate(response.sessionToken)).toBeNull();
    store.close();
  });

  it('does not finish authentication if verification itself crosses challenge expiry', async () => {
    const now = { value: 5_000 };
    const directory = mkdtempSync(join(tmpdir(), 'worldseed-session-expired-during-verify-'));
    directories.push(directory);
    const store = new SqliteVerifierStore(join(directory, 'session.sqlite'));
    let challengeExpiry = 0;
    const sessions = new SqliteWalletSessions(
      store,
      {
        verify: async () => {
          now.value = challengeExpiry;
          return true;
        },
      },
      {
        deployments: new Map([['31337', contract]]),
        allowedOrigins: new Set(['https://worldseed.example']),
        nowMilliseconds: () => now.value,
        challengeTtlMs: 10,
      },
    );
    now.value = 5_000;
    const challenge = sessions.issueChallenge({
      wallet: disposableWallet.address,
      chainId: '31337',
      verifyingContract: contract,
      origin: 'https://worldseed.example',
      runId: '1',
    });
    challengeExpiry = challenge.expiresAtMs;
    await expect(sessions.completeChallenge(challenge.challengeId, '0x1234')).rejects.toThrow(
      /expired/,
    );
    store.close();
  });
});
