# Contest release checklist

## Current deployment record

- Mainnet V3 contract: `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4`, Hemi chain `43111`, deployment block `5612849`.
- Mainnet frontend: `https://worldseed-mainnet.valcio222.workers.dev`.
- Mainnet verifier: `https://worldseed-v3-verifier-mainnet.valcio222.workers.dev`.
- Sepolia uses separate frontend/verifier Workers, D1, and secrets. See [deployment configuration](deployment.md).

These values record the configured/reported release. Recheck live URLs and perform authenticated wallet QA before a release claim; this document does not probe remote services.

## Before a release

- [ ] Build with public frontend variables for exactly one target network.
- [ ] Confirm the frontend contract, chain ID, verifier URL, and mode labels all match.
- [ ] Confirm the matching verifier config, D1 binding, migration state, RPC secret, attester secret, and CORS origin.
- [ ] Run relevant automated checks and Wrangler dry runs.
- [ ] Deploy the verifier first when its API or configuration changed; verify health and API compatibility.
- [ ] Deploy only the intended static frontend Worker and confirm the page and assets load.
- [ ] Complete an authenticated wallet smoke test on the hosted origin before calling the game fully verified.

The root `wrangler.toml` targets the existing static `worldseed` frontend. The separate Mainnet frontend and both verifier configurations live in `deployment/cloudflare/`. Never deploy the Mainnet and Sepolia configurations interchangeably.

## Rollback

Redeploy the prior known-good Worker version for the affected environment. Roll back verifier and frontend as a coordinated pair when API compatibility changed. Do not roll back or reuse the other network's D1 database, secrets, or contract configuration. Preserve the current contract and database state; application rollback does not undo on-chain transactions.
