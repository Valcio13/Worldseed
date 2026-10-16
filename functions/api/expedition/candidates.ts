import { isAddress, verifyMessage, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { issueCandidateSet } from '../../../src/expeditions/issuer';
import { selectSourceTransactions, SourceUnavailableError } from '../../../src/expeditions/sources';
import type { CandidateSet, SourceId, SourceTransaction } from '../../../src/expeditions/model';
import type { PagesContext } from '../../_shared/types';
import { json, readJson } from '../../_shared/types';

interface CandidateRequest {
  player?: string;
  challengeId?: string;
  signature?: `0x${string}`;
}
interface ChallengeRow {
  player: string;
  message: string;
  expires_at: number;
}
interface CandidateRow {
  payload: string;
  selected_source: string | null;
}

export async function onRequestPost({ request, env }: PagesContext): Promise<Response> {
  const input = await readJson<CandidateRequest>(request);
  if (!input?.player || !isAddress(input.player) || !input.challengeId || !input.signature)
    return json({ error: 'A wallet challenge and signature are required.' }, 400);
  const player = input.player.toLowerCase();
  const challenge = await env.WORLDSEED_DB.prepare(
    'SELECT player, message, expires_at FROM issuance_challenges WHERE id = ?',
  )
    .bind(input.challengeId)
    .first<ChallengeRow>();
  if (
    !challenge ||
    challenge.player !== player ||
    challenge.expires_at < Math.floor(Date.now() / 1000)
  )
    return json({ error: 'This wallet challenge expired. Request a new one.' }, 401);
  let valid = false;
  try {
    valid = await verifyMessage({
      address: input.player as Address,
      message: challenge.message,
      signature: input.signature,
    });
  } catch {
    /* malformed signatures are invalid */
  }
  if (!valid) return json({ error: 'Wallet signature did not match this challenge.' }, 401);
  if (!challenge.message.includes('Action: Issue candidate set'))
    return json({ error: 'This signature is not an issuance challenge.' }, 401);
  const expeditionMatch = challenge.message.match(
    /\nExpedition: (\d+) \(fresh V2 test environment\)/,
  );
  const expeditionNumber = expeditionMatch ? Number(expeditionMatch[1]) : NaN;
  if (!Number.isSafeInteger(expeditionNumber) || expeditionNumber < 1)
    return json({ error: 'The signed challenge has no valid expedition number.' }, 401);
  const consumed = await env.WORLDSEED_DB.prepare(
    'DELETE FROM issuance_challenges WHERE id = ? AND player = ? AND expires_at >= ?',
  )
    .bind(input.challengeId, player, Math.floor(Date.now() / 1000))
    .run();
  if ((consumed.meta?.changes ?? 0) !== 1)
    return json({ error: 'This wallet challenge was already used.' }, 409);

  if (
    !isAddress(env.WORLDSEED_V2_CONTRACT_ADDRESS) ||
    env.WORLDSEED_V2_CONTRACT_ADDRESS.toLowerCase() === `0x${'0'.repeat(40)}` ||
    !isAddress(env.WORLDSEED_V2_ATTESTER_ADDRESS)
  )
    return json({ error: 'The reviewed V2 contract and attester are not configured.' }, 503);
  let configuredSigner: Address;
  try {
    configuredSigner = privateKeyToAccount(env.WORLDSEED_ATTESTATION_PRIVATE_KEY).address;
  } catch {
    return json({ error: 'The candidate attestation signer is unavailable.' }, 503);
  }
  if (configuredSigner.toLowerCase() !== env.WORLDSEED_V2_ATTESTER_ADDRESS.toLowerCase())
    return json({ error: 'The candidate signer does not match the reviewed V2 attester.' }, 503);

  const existing = await env.WORLDSEED_DB.prepare(
    'SELECT payload, selected_source FROM candidate_sets WHERE player = ? AND expedition_number = ?',
  )
    .bind(player, expeditionNumber)
    .first<CandidateRow>();
  try {
    if (existing) {
      const stored = JSON.parse(existing.payload) as CandidateSet;
      if (stored.expiresAt > Math.floor(Date.now() / 1000))
        return json({ candidateSet: stored, selectedSource: existing.selected_source ?? null });
      // Renew only the signature window; preserve the same source records and all three seeds.
      const sourceTransactions = Object.fromEntries(
        stored.candidates.map((candidate) => [candidate.source, candidate.transaction]),
      ) as Record<SourceId, SourceTransaction>;
      const renewed = await issueCandidateSet({
        player: input.player as Address,
        expeditionNumber,
        sourceTransactions,
        hemiContractAddress: env.WORLDSEED_V2_CONTRACT_ADDRESS,
        signingPrivateKey: env.WORLDSEED_ATTESTATION_PRIVATE_KEY,
      });
      await env.WORLDSEED_DB.prepare(
        'UPDATE candidate_sets SET commitment = ?, payload = ?, issued_at = ?, expires_at = ? WHERE player = ? AND expedition_number = ? AND commitment = ?',
      )
        .bind(
          renewed.commitment,
          JSON.stringify(renewed),
          renewed.issuedAt,
          renewed.expiresAt,
          player,
          expeditionNumber,
          stored.commitment,
        )
        .run();
      const winner = await env.WORLDSEED_DB.prepare(
        'SELECT payload, selected_source FROM candidate_sets WHERE player = ? AND expedition_number = ?',
      )
        .bind(player, expeditionNumber)
        .first<CandidateRow>();
      if (!winner) throw new Error('Renewed candidate persistence was not found.');
      return json({
        candidateSet: JSON.parse(winner.payload) as CandidateSet,
        selectedSource: winner.selected_source ?? null,
      });
    }
    const sourceTransactions = await selectSourceTransactions({
      ethereumSepoliaRpcUrl: env.ETHEREUM_SEPOLIA_RPC_URL,
      hemiSepoliaRpcUrl: env.HEMI_SEPOLIA_RPC_URL,
      bitcoinTestnet4ApiUrl: env.BITCOIN_TESTNET4_API_URL,
    });
    const candidateSet = await issueCandidateSet({
      player: input.player as Address,
      expeditionNumber,
      sourceTransactions,
      hemiContractAddress: env.WORLDSEED_V2_CONTRACT_ADDRESS,
      signingPrivateKey: env.WORLDSEED_ATTESTATION_PRIVATE_KEY,
    });
    await env.WORLDSEED_DB.prepare(
      'INSERT OR IGNORE INTO candidate_sets (player, expedition_number, commitment, payload, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        player,
        expeditionNumber,
        candidateSet.commitment,
        JSON.stringify(candidateSet),
        candidateSet.issuedAt,
        candidateSet.expiresAt,
      )
      .run();
    const winner = await env.WORLDSEED_DB.prepare(
      'SELECT payload, selected_source FROM candidate_sets WHERE player = ? AND expedition_number = ?',
    )
      .bind(player, expeditionNumber)
      .first<CandidateRow>();
    if (!winner) throw new Error('Candidate persistence did not return the issued set.');
    return json({
      candidateSet: JSON.parse(winner.payload) as CandidateSet,
      selectedSource: winner.selected_source ?? null,
    });
  } catch (error) {
    if (error instanceof SourceUnavailableError)
      return json({ error: error.message, retryable: true }, 503);
    console.error('Candidate issuance failed.', error);
    return json({ error: 'Candidate issuance failed. Request a new challenge and retry.' }, 503);
  }
}
