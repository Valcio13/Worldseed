import { describe, expect, it, vi } from 'vitest';
import worker, { type WorkerEnv } from './worker';

function environment(assetResponse = new Response('asset')): WorkerEnv {
  return {
    ASSETS: { fetch: vi.fn(async () => assetResponse) },
  } as unknown as WorkerEnv;
}

describe('Workers entrypoint', () => {
  it('routes known API paths to the existing Pages-compatible handler', async () => {
    const response = await worker.fetch(
      new Request('https://worldseed.example/api/expedition/challenge', {
        method: 'POST',
        body: '{}',
      }),
      environment(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A valid wallet address is required.' });
  });

  it('returns JSON for unknown API paths instead of the SPA shell', async () => {
    const response = await worker.fetch(
      new Request('https://worldseed.example/api/unknown'),
      environment(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'API route not found.' });
  });

  it('passes non-API requests to the static asset binding', async () => {
    const assets = environment(new Response('index shell'));
    const response = await worker.fetch(new Request('https://worldseed.example/'), assets);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('index shell');
    expect(assets.ASSETS.fetch).toHaveBeenCalledOnce();
  });

  it('rejects unsupported methods on API routes', async () => {
    const response = await worker.fetch(
      new Request('https://worldseed.example/api/expedition/challenge'),
      environment(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});
