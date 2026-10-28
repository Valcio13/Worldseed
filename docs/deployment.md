# Deployment and release gates

## Existing V1 testnet deployment

| Setting  | Value                                                                                  |
| -------- | -------------------------------------------------------------------------------------- |
| Network  | Hemi Sepolia                                                                           |
| Chain ID | `743111`                                                                               |
| Contract | `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4`                                           |
| Explorer | <https://testnet.explorer.hemi.xyz/address/0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4> |
| Sourcify | <https://repo.sourcify.dev/743111/0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4>          |

The source was submitted through Sourcify's documented API and returned exact creation and runtime matches. This is the existing Sepolia legacy contract; the Mainnet V3 deployment is recorded separately below.

## Hemi Mainnet V3 deployment

| Setting | Value |
| --- | --- |
| Network | Hemi Mainnet |
| Chain ID | `43111` |
| Contract | `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4` |
| Deployment transaction | `0x11ed5d33084b90c6089a1d7f3124aa30bdb2765c56d4c06574e66878cfc3cc79` |
| Block | `5612849` |
| Receipt | Success; `3,492,836` gas |
| Owner | `0x8cc769177F7991dcB3C36AF1F7D64F1E9259b418` |
| Attester | `0x74f908FE3b0c85cD5c06cc3ed95B033982674E8F` |
| Active rules | Version `3`; tuple `(42,10,1000,1,100000,100000,100,7)` |

The deployment receipt and onchain roles/rules were verified by read-only RPC calls. This does not indicate that the Mainnet verifier or frontend has been deployed.

## Local development and production preview

Requirements: Node.js 22 or later and npm.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
npm run build
npm run preview
```

The Vite development server binds to port `5173` with strict port checking. The production output is `dist/`. Vite also emits a small deferred wallet/CCIP chunk. The legacy puzzle screen is not imported by the active app, though its source remains in the repository temporarily.

## Cloudflare Workers Static Assets deployment

Worldseed uses two Workers. Root `wrangler.toml` configures the static-assets-only frontend Worker named `worldseed`, serving `dist/` with SPA fallback. It has no verifier entrypoint or D1 binding. `wrangler.v3-verifier.toml` configures the separate `worldseed-v3-verifier` Worker, which handles `/api/v3/*` and `/health` and binds `WORLDSEED_DB`. The frontend's `VITE_VERIFIER_API_URL` points to that verifier origin, and `V3_ALLOWED_ORIGINS` must allow the exact frontend origin.

The frontend wallet target is Hemi Sepolia, chain ID `743111`. Configure the Vite build environment (not Wrangler `[vars]`) with:

- `VITE_ENABLE_V3_IDLE=true` to expose the Guest / Verified shell.
- `VITE_WORLDSEED_V3_CONTRACT_ADDRESS` set to the actually deployed V3 contract on Hemi Sepolia.
- `VITE_WORLDSEED_CONTRACT_ADDRESS=0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4` for existing V1 contract flows.
- Leave `VITE_VERIFIER_API_URL` empty for a same-origin API; for a separate API use its HTTPS base URL without `/api/v3`.

Configure verifier runtime values in `wrangler.v3-verifier.toml`: `V3_CHAIN_ID=743111`, the deployed `V3_CONTRACT_ADDRESS`, actual `V3_DEPLOYMENT_BLOCK`, selected `V3_CONFIRMATIONS`, and the exact HTTPS game origin in `V3_ALLOWED_ORIGINS`. The D1 binding points to the existing `worldseed-v3-verifier` database. The owner previously reported applying migrations 0001–0003 through the Cloudflare dashboard; check the remote migration history before applying anything again. Set `V3_RPC_URL` and `V3_ATTESTER_PRIVATE_KEY` as secrets on the verifier Worker, and verify the key derives the deployed contract's `attester()` address. Secrets are not stored in this repository.

Deployment order and release blockers are in the [contest release checklist](contest-release-checklist.md), and details for D1 and verifier setup are in [V3 Workers and D1](v3-cloudflare-workers-d1.md). From a configured checkout, build and validate without credentials using:

```powershell
npm run build
npx wrangler deploy --dry-run
```

The root dry run validates only the static frontend Worker. To inspect the separate verifier bundle, use `npx wrangler deploy --config wrangler.v3-verifier.toml --dry-run`. Dry runs do not validate remote D1 migration status, secrets, RPC connectivity, deployed bytecode, or signer. The owner deploys each Worker separately; the frontend command is `npx wrangler deploy`, and the verifier command is `npx wrangler deploy --config wrangler.v3-verifier.toml`. Keep Vite `base` at `/` for a root domain or `*.workers.dev` origin.

After an authorized deployment, verify the HTTPS origin, SPA fallback on refresh, `/health` liveness, wallet authentication, and an owner-run command/recovery/settlement journey with a disposable wallet on Hemi Sepolia. `/health` alone does not prove D1, RPC, contract, or signer health.

## Hemi Sepolia contract deployment (reference only)

The existing contract is already deployed; do not run this procedure for staging. For a future explicitly authorized testnet deployment, first set `HEMI_SEPOLIA_RPC_URL` and `HEMI_SEPOLIA_PRIVATE_KEY` in the deployment shell through a local secret manager, confirm chain ID `743111` and deployer funding, then run:

```powershell
npm run contract:compile
npm run contract:test
npm run contract:deploy:testnet
```

Never put private keys in `VITE_*` variables, source files, shell transcripts, frontend hosting settings, or version control. Do not paste a key or seed phrase into chat. The separate Mainnet verifier template is `wrangler.v3-verifier.mainnet.example.toml`. Keep its D1 database, RPC secret, attester key, and frontend origin isolated from Sepolia. A Mainnet Worker deployment or remote migration still requires explicit authorization.

## Clean-wallet manual QA

Use a separate funded test wallet with no existing island. Record the account, chain ID, action, transaction hash, receipt status, and `gasUsed` for each submitted transaction. Never record a private key or recovery phrase.

1. Open the HTTPS staging origin and select **Connect Wallet**. Approve the connection in the wallet. If prompted, approve switching to Hemi Sepolia. Confirm the connected address and chain ID `743111` in the UI/wallet.
2. Start the island. Record the transaction hash. Wait for a successful receipt and confirm the starter Water and Grass inventory appears. Read `islandState(player)` and confirm `started=true`, cursor `0`, and initial inventory.
3. Place a valid habitat or two, then select **Save Progress**. Record the hash and gas. Confirm the save notice, inventory update, and cursor increment. Read `islandState(player)` and compare its cursor and habitats to the screen.
4. Continue restoring until a region unlocks. Confirm its reward appears once. Read `unlockedThrough`, `claimed`, inventory, and weekly contributions; retrying the same cursor should fail without duplicate rewards.
5. In a separate action, reject a wallet prompt. Confirm the UI reports rejection and preserves queued island actions. Retry and confirm a successful receipt. For a revert, confirm the UI does not report success or clear queued actions. Check the transaction in the explorer before retrying after a timeout or replacement.
6. Finish restoring the island and submit **Finish Island**. Record hash, status, and gas. Confirm completion, the completion reward, and the World Tree contribution. Read `islandState(player)` (`complete=true`) and `weeklyContributions(currentWeek())`.
7. Refresh the completed island and confirm the final state persists. Save all transaction hashes and receipt gas in the QA record.

## Mainnet readiness checklist

- [ ] Clean-wallet connected-browser test passes on the public HTTPS origin, including chain switching and recovery from rejection/revert.
- [ ] Start, progress, region rewards, completion, and World Tree behavior are verified against the deployed testnet contract.
- [ ] Transaction hashes, receipt statuses, and target-chain gas are recorded for all wallet write paths.
- [ ] Hosted build has correct public configuration, survives refresh/direct navigation, and has no missing chunks or uncaught console errors.
- [ ] Contest rules, economy values, security review, and operational ownership are reviewed.
- [ ] Mainnet chain configuration, contract address, funding, and deployment authority are reviewed separately.
- [ ] Explicit authorization for Mainnet deployment is provided.

Passing automated tests alone does not satisfy these gates.
