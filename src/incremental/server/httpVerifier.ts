import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { isAddress, type Hex } from 'viem';
import { createCanonicalRun } from '../versionedRules';
import { natureAtomsForSettlement } from '../natureStatistics';
import type { GameplayCommand } from '../versionedRules';
import type { UpgradeChoice } from '../rulesV1';
import type { Habitat as HabitatV2, HabitatUpgradeMilestone } from '../rulesV2';
import { LocalVerifier, commandReceiptToWire } from '../localVerifier';
import {
  VerifierError,
  type AuthenticatedWalletSession,
  type CommandRequest,
  type V3AttestationData,
} from '../verifierProtocol';
import { hashUpgradeChoices, toSolidityUpgradeChoices } from './upgradeChoices';
import type { V3AttestationIssuer } from './attestationIssuer';
import type { V3ChainStateReader } from './v3ChainReader';
import type { SqliteVerifierStore } from './sqliteVerifierStore';
import type { SqliteWalletSessions } from './walletSessions';

const BODY_LIMIT = 64 * 1024;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
export interface LocalVerifierHttpOptions {
  allowedOrigins: ReadonlySet<string>;
  store: SqliteVerifierStore;
  sessions: SqliteWalletSessions;
  verifier: LocalVerifier;
  chain: V3ChainStateReader;
  issuer: V3AttestationIssuer;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'REQUEST_REJECTED',
  ) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of request) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(raw) > BODY_LIMIT) throw new HttpError(413, 'Request body is too large.');
  }
  try {
    const value: unknown = JSON.parse(raw || '{}');
    if (!isObject(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function tokenFrom(request: IncomingMessage): string {
  const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) throw new HttpError(401, 'A valid wallet session is required.', 'UNAUTHENTICATED');
  return match[1]!;
}

function serializeAttestation(data: V3AttestationData) {
  return {
    ...data,
    runId: data.runId.toString(),
    seasonId: data.seasonId.toString(),
    chainId: data.chainId.toString(),
    natureCollectedAtoms: data.natureCollectedAtoms.toString(),
    nonce: data.nonce.toString(),
    issuedAt: data.issuedAt.toString(),
    expiresAt: data.expiresAt.toString(),
  };
}

function parseChoices(value: unknown): UpgradeChoice[] {
  if (!Array.isArray(value) || value.length > 4)
    throw new HttpError(400, 'Upgrade choices must be an array.');
  const choices = value.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.upgradeId !== 'string' ||
      !Number.isSafeInteger(entry.quantity)
    )
      throw new HttpError(400, 'Upgrade choice is malformed.');
    return {
      upgradeId: entry.upgradeId as UpgradeChoice['upgradeId'],
      quantity: entry.quantity as number,
    };
  });
  if (choices.some((choice) => choice.upgradeId === 'rebirth'))
    throw new HttpError(
      400,
      'The verified Rebirth PP upgrade is disabled because it has no benefit.',
    );
  try {
    toSolidityUpgradeChoices(choices);
  } catch {
    throw new HttpError(400, 'Upgrade choices must be unique, sorted, and within uint16 bounds.');
  }
  return choices;
}

function parseCommand(value: unknown): GameplayCommand {
  if (!isObject(value) || typeof value.type !== 'string')
    throw new HttpError(400, 'Gameplay command is malformed.');
  if (value.type === 'heart-click' || value.type === 'sync') return { type: value.type };
  if (value.type === 'buy-habitat') {
    if (
      !['water', 'grass', 'forest', 'mountain', 'crystal-cavern', 'ancient-grove'].includes(
        String(value.habitat),
      ) ||
      !Number.isSafeInteger(value.quantity)
    )
      throw new HttpError(400, 'Habitat purchase is malformed.');
    return {
      type: 'buy-habitat',
      habitat: value.habitat as HabitatV2,
      quantity: value.quantity as number,
    };
  }
  if (value.type === 'buy-habitat-production-upgrade') {
    if (
      !['water', 'grass', 'forest', 'mountain', 'crystal-cavern', 'ancient-grove'].includes(
        String(value.habitat),
      ) ||
      typeof value.milestone !== 'number' ||
      ![10, 25, 50, 100].includes(value.milestone)
    )
      throw new HttpError(400, 'Habitat production upgrade is malformed.');
    return {
      type: 'buy-habitat-production-upgrade',
      habitat: value.habitat as HabitatV2,
      milestone: value.milestone as HabitatUpgradeMilestone,
    };
  }
  if (value.type === 'buy-temporary-upgrade') {
    if (!['sunny-season', 'deep-roots'].includes(String(value.upgrade)))
      throw new HttpError(400, 'Temporary upgrade is malformed.');
    return {
      type: 'buy-temporary-upgrade',
      upgrade: value.upgrade as 'sunny-season' | 'deep-roots',
    };
  }
  throw new HttpError(400, 'Unsupported gameplay command.');
}

async function authenticate(
  options: LocalVerifierHttpOptions,
  request: IncomingMessage,
  origin: string,
): Promise<AuthenticatedWalletSession> {
  if (!options.allowedOrigins.has(origin))
    throw new HttpError(403, 'Request origin is not allowed.');
  const session = await options.sessions.authenticate(tokenFrom(request));
  if (!session || session.origin !== origin)
    throw new HttpError(401, 'Wallet session is invalid for this origin.', 'UNAUTHENTICATED');
  return session;
}

function verifierStatus(error: VerifierError): number {
  if (error.code === 'UNAUTHENTICATED') return 401;
  if (error.code === 'RUN_NOT_FOUND') return 404;
  if (error.code === 'PERSISTENCE_CONFLICT' || error.code === 'RECOVERY_FAILED') return 503;
  return 409;
}

export function createLocalVerifierHttpServer(options: LocalVerifierHttpOptions): Server {
  return createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
        throw new HttpError(403, 'Local verifier accepts loopback hosts only.');
      const origin = request.headers.origin ?? '';
      if (origin && options.allowedOrigins.has(origin)) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
        response.setHeader('access-control-allow-headers', 'authorization, content-type');
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
      if (request.method === 'OPTIONS') {
        if (!options.allowedOrigins.has(origin))
          throw new HttpError(403, 'Request origin is not allowed.');
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      if (request.method === 'GET' && path === '/health') {
        json(response, 200, { ok: true });
        return;
      }
      const body = request.method === 'POST' ? await readBody(request) : {};

      if (request.method === 'POST' && path === '/api/v3/auth/challenge') {
        if (
          typeof body.wallet !== 'string' ||
          !isAddress(body.wallet) ||
          typeof body.chainId !== 'string' ||
          typeof body.verifyingContract !== 'string' ||
          typeof body.runId !== 'string'
        )
          throw new HttpError(400, 'Wallet challenge request is malformed.');
        try {
          json(
            response,
            200,
            options.sessions.issueChallenge({
              wallet: body.wallet,
              chainId: body.chainId,
              verifyingContract: body.verifyingContract,
              origin,
              runId: body.runId,
            }),
          );
        } catch {
          throw new HttpError(400, 'Wallet challenge does not match the local deployment.');
        }
        return;
      }
      if (request.method === 'POST' && path === '/api/v3/auth/complete') {
        if (typeof body.challengeId !== 'string' || typeof body.signature !== 'string')
          throw new HttpError(400, 'Wallet signature response is malformed.');
        const challenge = options.store.getChallenge(body.challengeId);
        if (!challenge || challenge.origin !== origin || !options.allowedOrigins.has(origin))
          throw new HttpError(403, 'Challenge origin does not match this request.');
        try {
          json(
            response,
            200,
            await options.sessions.completeChallenge(body.challengeId, body.signature as Hex),
          );
        } catch {
          throw new HttpError(
            401,
            'Wallet signature was rejected or the challenge was already used.',
            'UNAUTHENTICATED',
          );
        }
        return;
      }
      if (request.method === 'POST' && path === '/api/v3/runs/start-attestation') {
        const session = await authenticate(options, request, origin);
        const start = await options.chain.getStartRunContext(session.wallet);
        if (start.runId.toString() !== session.runId)
          throw new HttpError(409, 'Session is not bound to the next on-chain run ID.');
        const choices = parseChoices(body.upgradeChoices ?? []);
        const issuedAtMs = Number((await options.chain.getConfirmedTimestampSeconds()) * 1_000n);
        try {
          createCanonicalRun(start.rulesVersion, {
            runId: start.runId.toString(),
            seasonId: Number(start.seasonId),
            startedAtMs: issuedAtMs,
            seasonalPP: start.seasonalPP,
            existingUpgrades: start.upgradeLevels,
            seasonRebirths: start.seasonRebirths,
            upgradeChoices: choices,
          });
        } catch {
          throw new HttpError(409, 'Upgrade choices exceed current PP or verified level limits.');
        }
        const issued = await options.issuer.issue({
          player: session.wallet as `0x${string}`,
          runId: start.runId,
          seasonId: start.seasonId,
          rulesVersion: start.rulesVersion,
          scoreTier: 0,
          natureCollectedAtoms: 0n,
          actionType: 'START_RUN',
          upgradeChoicesHash: hashUpgradeChoices(choices),
          expectedNonce: start.nonce,
          expectedSignerEpoch: start.signerEpoch,
        });
        json(response, 200, {
          attestation: serializeAttestation(issued.attestation),
          signature: issued.signature,
          digest: issued.digest,
          upgradeChoices: toSolidityUpgradeChoices(choices),
        });
        return;
      }

      const recoverMatch = path.match(/^\/api\/v3\/runs\/([1-9][0-9]*)\/recover$/);
      if (request.method === 'GET' && recoverMatch) {
        const session = await authenticate(options, request, origin);
        const recovered = await options.verifier.recover(tokenFrom(request), recoverMatch[1]!);
        json(response, 200, {
          cursor: recovered.cursor,
          canonicalState: JSON.stringify(recovered.state, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
          scoreTier: recovered.scoreTier,
          wallet: session.wallet,
        });
        return;
      }
      const commandMatch = path.match(/^\/api\/v3\/runs\/([1-9][0-9]*)\/commands$/);
      if (request.method === 'POST' && commandMatch) {
        await authenticate(options, request, origin);
        if (typeof body.commandId !== 'string' || !Number.isSafeInteger(body.expectedSequence))
          throw new HttpError(400, 'Command envelope is malformed.');
        const command: CommandRequest = {
          sessionToken: tokenFrom(request),
          runId: commandMatch[1]!,
          commandId: body.commandId,
          expectedSequence: body.expectedSequence as number,
          command: parseCommand(body.command),
        };
        json(response, 200, commandReceiptToWire(await options.verifier.submit(command)));
        return;
      }
      const settleMatch = path.match(
        /^\/api\/v3\/runs\/([1-9][0-9]*)\/(record|rebirth)-attestation$/,
      );
      if (request.method === 'POST' && settleMatch) {
        const session = await authenticate(options, request, origin);
        const runId = BigInt(settleMatch[1]!);
        const recovered = await options.verifier.recover(tokenFrom(request), runId.toString());
        const chain = await options.chain.getRunSettlementContext(session.wallet, runId);
        if (chain.rulesVersion !== recovered.cursor.rulesVersion)
          throw new HttpError(409, 'Run rules version is unsupported by this verifier.');
        const action = settleMatch[2] === 'record' ? 'RECORD_POINTS' : 'REBIRTH';
        if (action === 'RECORD_POINTS' && recovered.scoreTier <= chain.lastRecordedScoreTier)
          throw new HttpError(409, 'No newer checkpoint is available.');
        if (
          action === 'REBIRTH' &&
          (recovered.scoreTier < chain.lastRecordedScoreTier ||
            recovered.scoreTier < chain.rebirthThresholdTier)
        )
          throw new HttpError(409, 'Verified score has not reached the rebirth requirement.');
        const issued = await options.issuer.issue({
          player: session.wallet as `0x${string}`,
          runId,
          seasonId: BigInt(recovered.state.seasonId),
          rulesVersion: chain.rulesVersion,
          scoreTier: recovered.scoreTier,
          natureCollectedAtoms:
            action === 'REBIRTH' ? natureAtomsForSettlement(recovered.state.earnedNatureAtoms) : 0n,
          actionType: action,
          upgradeChoicesHash: ZERO_HASH,
        });
        json(response, 200, {
          attestation: serializeAttestation(issued.attestation),
          signature: issued.signature,
          digest: issued.digest,
        });
        return;
      }
      throw new HttpError(404, 'Verifier endpoint was not found.');
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        json(response, error.status, { code: error.code, message: error.message });
        return;
      }
      if (error instanceof VerifierError) {
        json(response, verifierStatus(error), {
          code: error.code,
          message: error.message,
          ...(error.expectedSequence === undefined
            ? {}
            : { expectedSequence: error.expectedSequence }),
          ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
        });
        return;
      }
      json(response, 503, {
        code: 'VERIFIER_UNAVAILABLE',
        message: 'Verifier could not confirm authoritative state.',
      });
    });
  });
}
