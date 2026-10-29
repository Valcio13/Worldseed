import { isAddress, type Address, type Hex } from 'viem';
import { createCanonicalRun, type GameplayCommand } from '../versionedRules';
import { natureAtomsForSettlement } from '../natureStatistics';
import { MAX_HEART_CLICK_BATCH, type UpgradeChoice } from '../rulesV1';
import type { Habitat as HabitatV2, HabitatUpgradeMilestone } from '../rulesV2';
import { LocalVerifier, commandReceiptToWire } from '../localVerifier';
import {
  VerifierError,
  type AuthenticatedWalletSession,
  type CommandRequest,
  type V3AttestationData,
} from '../verifierProtocol';
import { hashUpgradeChoices, toSolidityUpgradeChoices } from '../server/upgradeChoices';
import { AttestationConflictError, type V3AttestationIssuer } from '../server/attestationIssuer';
import type { V3ChainStateReader } from '../server/v3ChainReader';
import type { D1VerifierStore } from '../server/d1VerifierStore';
import type { WorkersWalletSessions } from '../server/workersWalletSessions';

const BODY_LIMIT = 64 * 1024;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
type ResponseHeaders = Record<string, string>;

export interface WorkerVerifierHttpOptions {
  allowedOrigins: ReadonlySet<string>;
  store: D1VerifierStore;
  sessions: WorkersWalletSessions;
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

function json(body: unknown, status = 200, headers?: ResponseHeaders): Response {
  return new Response(
    JSON.stringify(body, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers,
      },
    },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const sizeHeader = request.headers.get('content-length');
  if (sizeHeader && Number(sizeHeader) > BODY_LIMIT)
    throw new HttpError(413, 'Request body is too large.');
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(
      new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes) || '{}',
    );
    if (!isObject(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function tokenFrom(request: Request): string {
  const match = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
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
  if (value.type === 'sync') return { type: value.type };
  if (value.type === 'heart-click') {
    const quantity = value.quantity === undefined ? 1 : value.quantity;
    if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > MAX_HEART_CLICK_BATCH)
      throw new HttpError(400, `Heart batch quantity must be an integer from 1 through ${MAX_HEART_CLICK_BATCH}.`);
    return { type: 'heart-click', quantity: quantity as number };
  }
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
    if (!['sunny-season', 'deep-roots', 'nature-surge'].includes(String(value.upgrade)))
      throw new HttpError(400, 'Temporary upgrade is malformed.');
    return {
      type: 'buy-temporary-upgrade',
      upgrade: value.upgrade as 'sunny-season' | 'deep-roots' | 'nature-surge',
    };
  }
  if (value.type === 'buy-fertile-soil' || value.type === 'buy-time-bloom')
    return { type: value.type };
  throw new HttpError(400, 'Unsupported gameplay command.');
}

async function authenticate(
  options: WorkerVerifierHttpOptions,
  request: Request,
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

/** Fetch-native API handler shared by the Worker entrypoint and Miniflare tests. */
export function createWorkerVerifierHandler(options: WorkerVerifierHttpOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') ?? '';
    const cors: ResponseHeaders =
      origin && options.allowedOrigins.has(origin)
        ? {
            'access-control-allow-origin': origin,
            vary: 'Origin',
            'access-control-allow-headers': 'authorization, content-type',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
          }
        : {};
    try {
      if (url.pathname === '/health' && request.method === 'GET')
        return json({ ok: true }, 200, cors);
      if (request.method === 'OPTIONS') {
        if (!options.allowedOrigins.has(origin))
          throw new HttpError(403, 'Request origin is not allowed.');
        return new Response(null, {
          status: 204,
          headers: { 'cache-control': 'no-store', ...cors },
        });
      }
      if (!url.pathname.startsWith('/api/v3/'))
        throw new HttpError(404, 'Verifier endpoint was not found.');
      if (!origin || !options.allowedOrigins.has(origin))
        throw new HttpError(403, 'Request origin is not allowed.');
      const body = request.method === 'POST' ? await readBody(request) : {};

      if (request.method === 'POST' && url.pathname === '/api/v3/auth/challenge') {
        if (
          typeof body.wallet !== 'string' ||
          !isAddress(body.wallet) ||
          typeof body.chainId !== 'string' ||
          typeof body.verifyingContract !== 'string' ||
          typeof body.runId !== 'string'
        )
          throw new HttpError(400, 'Wallet challenge request is malformed.');
        try {
          return json(
            await options.sessions.issueChallenge({
              wallet: body.wallet,
              chainId: body.chainId,
              verifyingContract: body.verifyingContract,
              origin,
              runId: body.runId,
            }),
            200,
            cors,
          );
        } catch {
          throw new HttpError(400, 'Wallet challenge does not match the configured deployment.');
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/v3/auth/complete') {
        if (typeof body.challengeId !== 'string' || typeof body.signature !== 'string')
          throw new HttpError(400, 'Wallet signature response is malformed.');
        const challenge = await options.store.getChallenge(body.challengeId);
        if (!challenge || challenge.origin !== origin)
          throw new HttpError(403, 'Challenge origin does not match this request.');
        try {
          return json(
            await options.sessions.completeChallenge(body.challengeId, body.signature as Hex),
            200,
            cors,
          );
        } catch {
          throw new HttpError(
            401,
            'Wallet signature was rejected or the challenge was already used.',
          );
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/v3/runs/start-attestation') {
        const session = await authenticate(options, request, origin);
        const start = await options.chain.getStartRunContext(session.wallet);
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
          player: session.wallet as Address,
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
        return json(
          {
            attestation: serializeAttestation(issued.attestation),
            signature: issued.signature,
            digest: issued.digest,
            upgradeChoices: toSolidityUpgradeChoices(choices),
          },
          200,
          cors,
        );
      }
      const recoverMatch = url.pathname.match(/^\/api\/v3\/runs\/([1-9][0-9]*)\/recover$/);
      if (request.method === 'GET' && recoverMatch) {
        const session = await authenticate(options, request, origin);
        const recovered = await options.verifier.recover(tokenFrom(request), recoverMatch[1]!);
        return json(
          {
            cursor: recovered.cursor,
            canonicalState: JSON.stringify(recovered.state, (_key, value: unknown) =>
              typeof value === 'bigint' ? value.toString() : value,
            ),
            scoreTier: recovered.scoreTier,
            wallet: session.wallet,
          },
          200,
          cors,
        );
      }
      const commandMatch = url.pathname.match(/^\/api\/v3\/runs\/([1-9][0-9]*)\/commands$/);
      if (request.method === 'POST' && commandMatch) {
        await authenticate(options, request, origin);
        if (
          typeof body.commandId !== 'string' ||
          body.commandId.length < 1 ||
          body.commandId.length > 128 ||
          !Number.isSafeInteger(body.expectedSequence) ||
          (body.expectedSequence as number) < 0
        )
          throw new HttpError(400, 'Command envelope is malformed.');
        const command: CommandRequest = {
          sessionToken: tokenFrom(request),
          runId: commandMatch[1]!,
          commandId: body.commandId,
          expectedSequence: body.expectedSequence as number,
          command: parseCommand(body.command),
        };
        return json(commandReceiptToWire(await options.verifier.submit(command)), 200, cors);
      }
      const settleMatch = url.pathname.match(
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
          player: session.wallet as Address,
          runId,
          seasonId: BigInt(recovered.state.seasonId),
          rulesVersion: chain.rulesVersion,
          scoreTier: recovered.scoreTier,
          natureCollectedAtoms:
            action === 'REBIRTH' ? natureAtomsForSettlement(recovered.state.earnedNatureAtoms) : 0n,
          actionType: action,
          upgradeChoicesHash: ZERO_HASH,
        });
        return json(
          {
            attestation: serializeAttestation(issued.attestation),
            signature: issued.signature,
            digest: issued.digest,
          },
          200,
          cors,
        );
      }
      throw new HttpError(404, 'Verifier endpoint was not found.');
    } catch (error) {
      if (error instanceof HttpError)
        return json({ code: error.code, message: error.message }, error.status, cors);
      if (error instanceof VerifierError)
        return json(
          {
            code: error.code,
            message: error.message,
            ...(error.expectedSequence === undefined
              ? {}
              : { expectedSequence: error.expectedSequence }),
            ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
          },
          verifierStatus(error),
          cors,
        );
      if (error instanceof AttestationConflictError)
        return json({ code: 'REQUEST_REJECTED', message: error.message }, 409, cors);
      return json(
        {
          code: 'VERIFIER_UNAVAILABLE',
          message: 'Verifier could not confirm authoritative state.',
        },
        503,
        cors,
      );
    }
  };
}
