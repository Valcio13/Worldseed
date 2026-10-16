export interface D1Result<T = unknown> {
  results?: T[];
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface Env {
  WORLDSEED_DB: D1Database;
  ETHEREUM_SEPOLIA_RPC_URL: string;
  HEMI_SEPOLIA_RPC_URL: string;
  BITCOIN_TESTNET4_API_URL?: string;
  WORLDSEED_ATTESTATION_PRIVATE_KEY: `0x${string}`;
  WORLDSEED_V2_CONTRACT_ADDRESS: `0x${string}`;
  WORLDSEED_V2_ATTESTER_ADDRESS: `0x${string}`;
}

export interface PagesContext {
  request: Request;
  env: Env;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
