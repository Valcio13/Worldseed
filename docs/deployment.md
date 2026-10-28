# Deployment and release notes

## Current environments

Worldseed has separate Hemi Mainnet and Hemi Sepolia Live environments. Each environment uses its own frontend build configuration, verifier Worker, D1 database, RPC secret, and attester secret. Do not mix configuration between networks.

| Environment | Chain ID | Frontend Worker     | Verifier Worker                 | V3 contract                                  |
| ----------- | -------: | ------------------- | ------------------------------- | -------------------------------------------- |
| Mainnet     |  `43111` | `worldseed-mainnet` | `worldseed-v3-verifier-mainnet` | `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4` |
| Sepolia     | `743111` | `worldseed`         | `worldseed-v3-verifier`         | `0x3764b775a099fe887B164f85eB95dA6E0C22151D` |

Mainnet deployment record: transaction `0x11ed5d33084b90c6089a1d7f3124aa30bdb2765c56d4c06574e66878cfc3cc79`, block `5612849`; V3 was reported active at launch. The Mainnet frontend and verifier URLs are listed in the root README. This record documents prior deployment; it is not a live health check.

## Local development

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
npm run build
npm run preview
```

Keep `.env`, `.env.local`, and `.dev.vars` local. `VITE_*` variables are public build-time values and are embedded in the browser bundle. Never put RPC credentials or private keys in them.

## Cloudflare configuration locations

- Root [`../wrangler.toml`](../wrangler.toml): default static frontend Worker `worldseed`; keep this file at the root for the existing deployment integration.
- [`../deployment/cloudflare/wrangler.mainnet.example.toml`](../deployment/cloudflare/wrangler.mainnet.example.toml): separate Mainnet static frontend Worker.
- [`../deployment/cloudflare/wrangler.v3-verifier.toml`](../deployment/cloudflare/wrangler.v3-verifier.toml): Sepolia verifier Worker and D1 binding.
- [`../deployment/cloudflare/wrangler.v3-verifier.mainnet.toml`](../deployment/cloudflare/wrangler.v3-verifier.mainnet.toml): Mainnet verifier Worker and isolated D1 binding.
- [`../deployment/cloudflare/wrangler.v3-verifier.mainnet.example.toml`](../deployment/cloudflare/wrangler.v3-verifier.mainnet.example.toml): template only; its database ID is intentionally unresolved.
- [`../deployment/cloudflare/mainnet.frontend.env.example`](../deployment/cloudflare/mainnet.frontend.env.example): public Mainnet frontend variables; Wrangler does not load this file automatically.

The separate Mainnet verifier uses `WORLDSEED_DB`, chain ID `43111`, contract `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4`, deployment block `5612849`, and the Mainnet frontend origin. Its D1 database and secrets must stay isolated from Sepolia.

## Build and dry-run commands

Run from the repository root. Dry runs bundle and validate local configuration; they do not deploy or validate remote secrets/database state.

```powershell
npm run build
npx wrangler deploy --dry-run
npx wrangler deploy --config deployment/cloudflare/wrangler.mainnet.example.toml --dry-run
npx wrangler deploy --config deployment/cloudflare/wrangler.v3-verifier.toml --dry-run
npx wrangler deploy --config deployment/cloudflare/wrangler.v3-verifier.mainnet.toml --dry-run
```

Deployment commands are intentionally explicit and should be run only with authorization:

```powershell
npx wrangler deploy
npx wrangler deploy --config deployment/cloudflare/wrangler.mainnet.example.toml
npx wrangler deploy --config deployment/cloudflare/wrangler.v3-verifier.toml
npx wrangler deploy --config deployment/cloudflare/wrangler.v3-verifier.mainnet.toml
```

Build the frontend with the correct public `VITE_*` variables for the intended environment before deploying its static Worker. Do not use one build output for both networks. The root `wrangler.toml` deploys only the existing `worldseed` frontend; it does not deploy the verifier.

## Verifier secrets and D1

`V3_RPC_URL` and `V3_ATTESTER_PRIVATE_KEY` are runtime Worker secrets. Configure them interactively against the corresponding verifier config, never in source or frontend settings. Confirm the signing key derives the deployed contract's `attester()` address locally without printing the key.

D1 migrations live in [`../migrations/`](../migrations/). Before applying any remote migration, inspect the target database and migration history. Keep Mainnet and Sepolia databases distinct. The Worker uses the `WORLDSEED_DB` binding.

## Post-deployment checks

For the intended frontend URL, confirm the page and generated assets return HTTP 200 and direct navigation works. For the matching verifier, check `/health` and CORS from the actual frontend origin. A health response alone does not prove RPC, D1, contract, or attester correctness. Complete an authenticated wallet smoke test before describing a release as fully verified.

Never commit secrets, deploy to the wrong Worker, or treat a dry run as a live deployment check.
