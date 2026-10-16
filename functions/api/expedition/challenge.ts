import { isAddress } from 'viem';
import type { PagesContext } from '../../_shared/types';
import { json, readJson } from '../../_shared/types';

interface ChallengeRequest {
  player?: string;
  purpose?: 'issue' | 'select';
  commitment?: string;
  source?: string;
  expeditionNumber?: number;
}

export async function onRequestPost({ request, env }: PagesContext): Promise<Response> {
  const input = await readJson<ChallengeRequest>(request);
  if (!input?.player || !isAddress(input.player))
    return json({ error: 'A valid wallet address is required.' }, 400);
  if (
    input.purpose === 'select' &&
    (!input.commitment || !['ethereum', 'hemi', 'bitcoin'].includes(input.source ?? ''))
  )
    return json({ error: 'A candidate commitment and source are required for selection.' }, 400);
  if (input.purpose && input.purpose !== 'issue' && input.purpose !== 'select')
    return json({ error: 'Unsupported wallet challenge purpose.' }, 400);
  const player = input.player.toLowerCase();
  const expeditionNumber = input.expeditionNumber ?? 1;
  if (
    input.purpose !== 'select' &&
    (!Number.isSafeInteger(expeditionNumber) || expeditionNumber < 1)
  )
    return json({ error: 'A positive expedition number is required.' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 600) * 600;
  await env.WORLDSEED_DB.prepare(
    'INSERT INTO challenge_rate_limits (player, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(player, window_start) DO UPDATE SET attempts = attempts + 1',
  )
    .bind(player, windowStart)
    .run();
  const rate = await env.WORLDSEED_DB.prepare(
    'SELECT attempts FROM challenge_rate_limits WHERE player = ? AND window_start = ?',
  )
    .bind(player, windowStart)
    .first<{ attempts: number }>();
  if ((rate?.attempts ?? 0) > 8)
    return json({ error: 'Too many candidate requests. Try again in a few minutes.' }, 429);
  await env.WORLDSEED_DB.prepare('DELETE FROM issuance_challenges WHERE expires_at < ?')
    .bind(now)
    .run();
  await env.WORLDSEED_DB.prepare('DELETE FROM challenge_rate_limits WHERE window_start < ?')
    .bind(windowStart - 3600)
    .run();
  const id = crypto.randomUUID();
  const expiresAt = now + 300;
  const messageParts = [
    'Worldseed H2 candidate request',
    `Address: ${player}`,
    'Network: hemi-sepolia (743111)',
    `Expedition: ${expeditionNumber} (fresh V2 test environment)`,
    `Action: ${input.purpose === 'select' ? 'Select island' : 'Issue candidate set'}`,
    `Challenge: ${id}`,
    `Expires: ${expiresAt}`,
  ];
  if (input.purpose === 'select') {
    messageParts.push(`Commitment: ${input.commitment}`, `Source: ${input.source}`);
  }
  const message = messageParts.join('\n');
  await env.WORLDSEED_DB.prepare(
    'INSERT INTO issuance_challenges (id, player, message, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, player, message, expiresAt)
    .run();
  return json({ challengeId: id, message, expiresAt });
}
