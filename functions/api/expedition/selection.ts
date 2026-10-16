import { isAddress, verifyMessage, type Address } from 'viem';
import type { CandidateSet, SourceId } from '../../../src/expeditions/model';
import type { PagesContext } from '../../_shared/types';
import { json, readJson } from '../../_shared/types';

interface SelectionRequest {
  player?: string;
  challengeId?: string;
  signature?: `0x${string}`;
  commitment?: string;
  source?: SourceId;
  expeditionNumber?: number;
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
  const input = await readJson<SelectionRequest>(request);
  if (
    !input?.player ||
    !isAddress(input.player) ||
    !input.challengeId ||
    !input.signature ||
    !input.commitment ||
    !['ethereum', 'hemi', 'bitcoin'].includes(input.source ?? '')
  )
    return json({ error: 'A valid wallet challenge and candidate selection are required.' }, 400);
  const player = input.player.toLowerCase();
  const expeditionNumber = input.expeditionNumber ?? 1;
  if (!Number.isSafeInteger(expeditionNumber) || expeditionNumber < 1)
    return json({ error: 'A valid expedition number is required.' }, 400);
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
  if (
    !challenge.message.includes('Action: Select island') ||
    !challenge.message.includes(`Expedition: ${expeditionNumber} (fresh V2 test environment)`) ||
    !challenge.message.includes(`Commitment: ${input.commitment}`) ||
    !challenge.message.includes(`Source: ${input.source}`)
  )
    return json({ error: 'This signature does not authorize the requested selection.' }, 401);
  const consumed = await env.WORLDSEED_DB.prepare(
    'DELETE FROM issuance_challenges WHERE id = ? AND player = ? AND expires_at >= ?',
  )
    .bind(input.challengeId, player, Math.floor(Date.now() / 1000))
    .run();
  if ((consumed.meta?.changes ?? 0) !== 1)
    return json({ error: 'This wallet challenge was already used.' }, 409);

  const candidate = await env.WORLDSEED_DB.prepare(
    'SELECT payload, selected_source FROM candidate_sets WHERE player = ? AND expedition_number = ?',
  )
    .bind(player, expeditionNumber)
    .first<CandidateRow>();
  if (!candidate) return json({ error: 'No candidate set exists for this wallet yet.' }, 404);
  const set = JSON.parse(candidate.payload) as CandidateSet;
  if (
    set.commitment !== input.commitment ||
    !set.candidates.some(({ source }) => source === input.source)
  )
    return json({ error: 'Selection does not belong to this candidate set.' }, 409);
  await env.WORLDSEED_DB.prepare(
    'UPDATE candidate_sets SET selected_source = COALESCE(selected_source, ?) WHERE player = ? AND expedition_number = ? AND commitment = ?',
  )
    .bind(input.source, player, expeditionNumber, input.commitment)
    .run();
  const locked = await env.WORLDSEED_DB.prepare(
    'SELECT payload, selected_source FROM candidate_sets WHERE player = ? AND expedition_number = ?',
  )
    .bind(player, expeditionNumber)
    .first<CandidateRow>();
  if (!locked || locked.selected_source !== input.source)
    return json(
      {
        error: `This expedition already has the ${locked?.selected_source ?? 'saved'} candidate selected.`,
      },
      409,
    );
  return json({ selectedSource: locked.selected_source, commitment: set.commitment });
}
