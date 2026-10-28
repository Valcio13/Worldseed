import {
  getAddress,
  hashMessage,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from 'viem';
import type { AuthenticatedWalletSession } from '../verifierProtocol';
import type { WalletSessionAuthenticator } from '../localVerifier';
import type { WalletChallengeRow, WalletSessionStore } from './verifierStoreTypes';
import { V3_WALLET_SESSION_TTL_MS } from './walletSessionPolicy';

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = V3_WALLET_SESSION_TTL_MS;
const UINT64_MAX = (1n << 64n) - 1n;

export interface WalletChallengeRequest {
  wallet: string;
  chainId: string;
  verifyingContract: string;
  origin: string;
  runId: string;
}

export interface WalletChallengeResponse {
  challengeId: string;
  message: string;
  expiresAtMs: number;
}

export interface WalletSessionResponse {
  sessionToken: string;
  expiresAtMs: number;
}

export interface WorkersWalletSignatureVerifier {
  isValidSignature(chainId: bigint, wallet: string, digest: Hex, signature: Hex): Promise<boolean>;
}

function canonicalUint(value: string, field: string, maximum: bigint): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${field} is invalid.`);
  const parsed = BigInt(value);
  if (parsed > maximum) throw new Error(`${field} is out of bounds.`);
  return parsed;
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('Origin must be a bare origin.');
  return parsed.origin;
}

function randomHex(bytes: number): Hex {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function randomToken(): string {
  const value = new Uint8Array(32);
  crypto.getRandomValues(value);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Workers/WebCrypto version of the short-lived, single-use wallet session adapter. */
export class WorkersWalletSessions implements WalletSessionAuthenticator {
  constructor(
    private readonly store: WalletSessionStore,
    private readonly contractSignatures: WorkersWalletSignatureVerifier,
    private readonly deployments: ReadonlyMap<string, string>,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly nowMilliseconds: () => number = Date.now,
  ) {}

  async issueChallenge(request: WalletChallengeRequest): Promise<WalletChallengeResponse> {
    const now = this.nowMilliseconds();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Authentication clock is invalid.');
    if (!isAddress(request.wallet) || !isAddress(request.verifyingContract))
      throw new Error('Wallet and verifying contract must be valid EVM addresses.');
    const wallet = getAddress(request.wallet);
    const verifyingContract = getAddress(request.verifyingContract);
    const chainId = canonicalUint(request.chainId, 'chainId', (1n << 256n) - 1n);
    const runId = canonicalUint(request.runId, 'runId', UINT64_MAX);
    const configured = this.deployments.get(chainId.toString());
    if (!configured || getAddress(configured) !== verifyingContract)
      throw new Error('Unsupported chain or V3 contract address.');
    const origin = normalizeOrigin(request.origin);
    if (!this.allowedOrigins.has(origin)) throw new Error('Origin is not allowlisted.');

    const challengeId = crypto.randomUUID();
    const nonce = randomHex(32);
    const expiresAtMs = now + CHALLENGE_TTL_MS;
    const message = [
      'Worldseed V3 wallet session',
      `Challenge: ${challengeId}`,
      `Nonce: ${nonce}`,
      `Wallet: ${wallet}`,
      `Chain ID: ${chainId}`,
      `Verifying contract: ${verifyingContract}`,
      `Run ID: ${runId}`,
      `Origin: ${origin}`,
      `Issued at (ms): ${now}`,
      `Expires at (ms): ${expiresAtMs}`,
      'Sign this message to authenticate this wallet session. This does not authorize a blockchain transaction.',
    ].join('\n');
    const record: WalletChallengeRow = {
      challengeId,
      nonce,
      wallet,
      chainId: chainId.toString(),
      verifyingContract,
      origin,
      runId: runId.toString(),
      message,
      createdAtMs: now,
      expiresAtMs,
    };
    await this.store.cleanupExpired(now, 25);
    await this.store.createChallenge(record);
    return { challengeId, message, expiresAtMs };
  }

  async completeChallenge(challengeId: string, signature: Hex): Promise<WalletSessionResponse> {
    const challenge = await this.store.getChallenge(challengeId);
    const now = this.nowMilliseconds();
    if (!challenge || !Number.isSafeInteger(now) || now < 0 || challenge.expiresAtMs <= now)
      throw new Error('Challenge is missing or expired.');
    let valid: boolean;
    try {
      const recovered = await recoverMessageAddress({ message: challenge.message, signature });
      valid = recovered.toLowerCase() === challenge.wallet.toLowerCase();
    } catch {
      valid = false;
    }
    if (!valid) {
      try {
        valid = await this.contractSignatures.isValidSignature(
          BigInt(challenge.chainId),
          challenge.wallet,
          hashMessage(challenge.message),
          signature,
        );
      } catch {
        valid = false;
      }
    }
    const verifiedAtMs = this.nowMilliseconds();
    if (
      !valid ||
      !Number.isSafeInteger(verifiedAtMs) ||
      verifiedAtMs < now ||
      verifiedAtMs >= challenge.expiresAtMs ||
      !Number.isSafeInteger(verifiedAtMs + SESSION_TTL_MS)
    )
      throw new Error('Wallet signature is invalid or its challenge expired.');

    const token = randomToken();
    const session = {
      tokenHash: await tokenDigest(token),
      sessionId: crypto.randomUUID(),
      wallet: challenge.wallet,
      chainId: challenge.chainId,
      verifyingContract: challenge.verifyingContract,
      origin: challenge.origin,
      runId: challenge.runId,
      createdAtMs: verifiedAtMs,
      expiresAtMs: verifiedAtMs + SESSION_TTL_MS,
      challengeId: challenge.challengeId,
    };
    if (
      !(await this.store.consumeChallengeAndCreateSession(
        challenge.challengeId,
        challenge.nonce,
        verifiedAtMs,
        session,
      ))
    )
      throw new Error('Challenge was already used, expired, or could not be committed.');
    return { sessionToken: token, expiresAtMs: session.expiresAtMs };
  }

  async authenticate(sessionToken: string): Promise<AuthenticatedWalletSession | null> {
    const now = this.nowMilliseconds();
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken) || !Number.isSafeInteger(now) || now < 0)
      return null;
    const row = await this.store.getSession(await tokenDigest(sessionToken), now);
    if (!row) return null;
    return {
      wallet: row.wallet as Address,
      chainId: BigInt(row.chainId),
      verifyingContract: row.verifyingContract,
      sessionId: row.sessionId,
      runId: row.runId,
      origin: row.origin,
    };
  }

  async revoke(sessionToken: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return;
    await this.store.revokeSession(await tokenDigest(sessionToken), this.nowMilliseconds());
  }
}
