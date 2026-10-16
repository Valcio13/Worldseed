import type { Env } from '../functions/_shared/types';
import { json } from '../functions/_shared/types';
import { onRequestPost as onChallengePost } from '../functions/api/expedition/challenge';
import { onRequestPost as onCandidatesPost } from '../functions/api/expedition/candidates';
import { onRequestPost as onSelectionPost } from '../functions/api/expedition/selection';

interface AssetFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkerEnv extends Env {
  ASSETS: AssetFetcher;
}

type RouteHandler = (context: { request: Request; env: Env }) => Promise<Response>;

const POST_ROUTES: Record<string, RouteHandler> = {
  '/api/expedition/challenge': onChallengePost,
  '/api/expedition/candidates': onCandidatesPost,
  '/api/expedition/selection': onSelectionPost,
};

function methodNotAllowed(): Response {
  return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const handler = POST_ROUTES[url.pathname];
    if (handler) {
      if (request.method !== 'POST') return methodNotAllowed();
      return handler({ request, env });
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'API route not found.' }, 404);
    return env.ASSETS.fetch(request);
  },
};
