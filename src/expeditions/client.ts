import type { Address, Hex } from 'viem';
import type { CandidateSet } from './model';

interface ChallengeResponse {
  challengeId: string;
  message: string;
  expiresAt: number;
}

export interface CandidateResponse {
  candidateSet: CandidateSet;
  selectedSource: string | null;
}

export async function fetchCandidateSet(
  player: Address,
  signMessage: (message: string) => Promise<Hex>,
  fetcher: typeof fetch = fetch,
  expeditionNumber = 1,
): Promise<CandidateResponse> {
  const challengeResponse = await fetcher('/api/expedition/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ player, purpose: 'issue', expeditionNumber }),
  });
  const challenge = (await challengeResponse.json()) as ChallengeResponse | { error?: string };
  if (!challengeResponse.ok || !('message' in challenge))
    throw new Error(
      ('error' in challenge && challenge.error) || 'Could not prepare wallet verification.',
    );
  const signature = await signMessage(challenge.message);
  const response = await fetcher('/api/expedition/candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ player, challengeId: challenge.challengeId, signature }),
  });
  const body = (await response.json()) as
    CandidateResponse | { error?: string; retryable?: boolean };
  if (!response.ok || !('candidateSet' in body))
    throw new Error(('error' in body && body.error) || 'Could not load island candidates.');
  return body;
}

export async function persistCandidateSetSelection(
  player: Address,
  commitment: string,
  source: string,
  signMessage: (message: string) => Promise<Hex>,
  fetcher: typeof fetch = fetch,
  expeditionNumber = 1,
): Promise<void> {
  const response = await fetcher('/api/expedition/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ player, purpose: 'select', commitment, source, expeditionNumber }),
  });
  const challenge = (await response.json()) as ChallengeResponse | { error?: string };
  if (!response.ok || !('message' in challenge))
    throw new Error(
      ('error' in challenge && challenge.error) || 'Could not prepare selection verification.',
    );
  const signature = await signMessage(challenge.message);
  const result = await fetcher('/api/expedition/selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      player,
      challengeId: challenge.challengeId,
      signature,
      commitment,
      source,
      expeditionNumber,
    }),
  });
  if (!result.ok) {
    const body = (await result.json()) as { error?: string };
    throw new Error(body.error || 'Could not save this candidate selection.');
  }
}
