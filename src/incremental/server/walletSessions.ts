import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, hashMessage, isAddress, recoverMessageAddress, type Hex } from 'viem';
import type { AuthenticatedWalletSession } from '../verifierProtocol';
import type { WalletSessionAuthenticator } from '../localVerifier';
import { V3_WALLET_SESSION_TTL_MS } from './walletSessionPolicy';
import {
  SqliteVerifierStore,
  type WalletChallengeRow,
  type WalletSessionRow,
} from './sqliteVerifierStore';

const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
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

export interface Eip1271SignatureReader {
  isValidSignature(chainId: bigint, wallet: string, digest: Hex, signature: Hex): Promise<boolean>;
}

export interface WalletMessageVerifier {
  verify(wallet: string, chainId: bigint, message: string, signature: Hex): Promise<boolean>;
}

/** EOA verification first; EIP-1271 contract wallets are delegated to a chain-specific RPC reader. */
export class EoaAndContractWalletMessageVerifier implements WalletMessageVerifier {
  constructor(private readonly eip1271: Eip1271SignatureReader) {}

  async verify(wallet: string, chainId: bigint, message: string, signature: Hex): Promise<boolean> {
    let recovered: string | undefined;
    try {
      recovered = await recoverMessageAddress({ message, signature });
    } catch {
      recovered = undefined;
    }
    if (recovered?.toLowerCase() === wallet.toLowerCase()) return true;
    try {
      return await this.eip1271.isValidSignature(chainId, wallet, hashMessage(message), signature);
    } catch {
      return false;
    }
  }
}

export interface WalletSessionOptions {
  deployments: ReadonlyMap<string, string>;
  allowedOrigins: ReadonlySet<string>;
  nowMilliseconds: () => number;
  sessionTtlMs?: number;
  challengeTtlMs?: number;
}

function canonicalUint(value: string, field: string, maximum: bigint): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`${field} must be a canonical unsigned integer.`);
  const parsed = BigInt(value);
  if (parsed > maximum) throw new Error(`${field} exceeds its supported bound.`);
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
    throw new Error('Origin must be a bare origin without path, credentials, query, or fragment.');
  return parsed.origin;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Durable, short-lived bearer sessions. Tokens are returned once and only their SHA-256 hashes are stored. */
export class SqliteWalletSessions implements WalletSessionAuthenticator {
  private readonly challengeTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(
    private readonly store: SqliteVerifierStore,
    private readonly verifier: WalletMessageVerifier,
    private readonly options: WalletSessionOptions,
  ) {
    this.challengeTtlMs = options.challengeTtlMs ?? CHALLENGE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    if (
      !Number.isSafeInteger(this.challengeTtlMs) ||
      this.challengeTtlMs <= 0 ||
      !Number.isSafeInteger(this.sessionTtlMs) ||
      this.sessionTtlMs <= 0
    )
      throw new Error('Challenge and session TTLs must be positive safe integer milliseconds.');
  }

  issueChallenge(request: WalletChallengeRequest): WalletChallengeResponse {
    const now = this.options.nowMilliseconds();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Authentication clock is invalid.');
    if (!isAddress(request.wallet) || !isAddress(request.verifyingContract))
      throw new Error('Wallet and verifying contract must be valid EVM addresses.');
    const wallet = getAddress(request.wallet);
    const verifyingContract = getAddress(request.verifyingContract);
    const chainId = canonicalUint(request.chainId, 'chainId', (1n << 256n) - 1n);
    const runId = canonicalUint(request.runId, 'runId', UINT64_MAX);
    const expectedContract = this.options.deployments.get(chainId.toString());
    if (!expectedContract || getAddress(expectedContract) !== verifyingContract)
      throw new Error('Unsupported chain or V3 contract address.');
    const origin = normalizeOrigin(request.origin);
    if (!this.options.allowedOrigins.has(origin)) throw new Error('Origin is not allowlisted.');
    if (!Number.isSafeInteger(now + this.challengeTtlMs))
      throw new Error('Challenge expiry exceeds safe timestamp bounds.');

    const challengeId = randomUUID();
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const expiresAtMs = now + this.challengeTtlMs;
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
    this.store.createChallenge(record);
    return { challengeId, message, expiresAtMs };
  }

  async completeChallenge(challengeId: string, signature: Hex): Promise<WalletSessionResponse> {
    const challenge = this.store.getChallenge(challengeId);
    const now = this.options.nowMilliseconds();
    if (!challenge || !Number.isSafeInteger(now) || now < 0 || challenge.expiresAtMs <= now)
      throw new Error('Challenge is missing or expired.');
    const valid = await this.verifier.verify(
      challenge.wallet,
      BigInt(challenge.chainId),
      challenge.message,
      signature,
    );
    if (!valid) throw new Error('Wallet signature does not match this challenge.');
    const verifiedAtMs = this.options.nowMilliseconds();
    if (
      !Number.isSafeInteger(verifiedAtMs) ||
      verifiedAtMs < now ||
      verifiedAtMs >= challenge.expiresAtMs ||
      !Number.isSafeInteger(verifiedAtMs + this.sessionTtlMs)
    )
      throw new Error('Challenge expired before verification completed.');

    const token = randomBytes(32).toString('base64url');
    const session: WalletSessionRow = {
      tokenHash: tokenDigest(token),
      sessionId: randomUUID(),
      wallet: challenge.wallet,
      chainId: challenge.chainId,
      verifyingContract: challenge.verifyingContract,
      origin: challenge.origin,
      runId: challenge.runId,
      createdAtMs: verifiedAtMs,
      expiresAtMs: verifiedAtMs + this.sessionTtlMs,
    };
    if (
      !this.store.consumeChallengeAndCreateSession(
        challenge.challengeId,
        challenge.nonce,
        verifiedAtMs,
        session,
      )
    )
      throw new Error('Challenge was already used, expired, or could not be committed.');
    return { sessionToken: token, expiresAtMs: session.expiresAtMs };
  }

  async authenticate(sessionToken: string): Promise<AuthenticatedWalletSession | null> {
    const now = this.options.nowMilliseconds();
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken) || !Number.isSafeInteger(now) || now < 0)
      return null;
    const row = this.store.getSession(tokenDigest(sessionToken), now);
    if (!row) return null;
    return {
      wallet: row.wallet,
      chainId: BigInt(row.chainId),
      verifyingContract: row.verifyingContract,
      sessionId: row.sessionId,
      runId: row.runId,
      origin: row.origin,
    };
  }

  revoke(sessionToken: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return;
    this.store.revokeSession(tokenDigest(sessionToken), this.options.nowMilliseconds());
  }
}
