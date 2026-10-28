import type { D1DatabaseLike } from '../server/d1VerifierStore';

export interface WorkerAssets {
  fetch(request: Request): Promise<Response>;
}

export interface WorldseedWorkerEnv {
  WORLDSEED_DB: D1DatabaseLike;
  ASSETS?: WorkerAssets;
  V3_CHAIN_ID: string;
  V3_RPC_URL: string;
  V3_CONTRACT_ADDRESS: string;
  V3_DEPLOYMENT_BLOCK: string;
  V3_CONFIRMATIONS: string;
  V3_ALLOWED_ORIGINS: string;
  V3_ATTESTER_PRIVATE_KEY: string;
}
