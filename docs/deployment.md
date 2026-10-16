# Deployment and release gates

## Current testnet deployment

| Setting                | Value                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Network                | Hemi Sepolia                                                                           |
| Chain ID               | `743111`                                                                               |
| Contract               | `0x7695494E1BB9f0696A52564BF15AA244819a882A`                                           |
| Explorer               | <https://testnet.explorer.hemi.xyz/address/0x7695494E1BB9f0696A52564BF15AA244819a882A> |
| Deployment transaction | `0x457ff7e168468e2a6d34fd2688f1be6292d21e52ff36f0439b888c4f886d36f0`                   |
| Attester               | `0x8E2F2FEB6dCfBD6FBA3DC4F0c17e406941806D9B`                                           |

The V2 deployment receipt and role reads are recorded above. Public source verification for this V2 address is a separate pending step; do not treat matching local bytecode as equivalent to explorer verification. The V1 reference has its own historical verification record. Do not use Hemi Mainnet for this milestone.

## Local development and production preview

Requirements: Node.js 22 or later and npm.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
npm run build
npm run preview
```

The Vite development server binds to port `5173` with strict port checking. The production output is `dist/`. The 2048 route is already lazy-loaded into its own JavaScript chunk; Vite also emits a small deferred wallet/CCIP chunk. Dynamic imports use Vite's generated asset URLs and must be tested on the published origin.

## Public HTTPS staging

Cloudflare Pages is the selected simple static host. It serves the built files and supports custom domains with HTTPS. Configure the Pages project with:

- Build command: `npm run build`
- Build output directory: `dist`
- Production build variable: `VITE_WORLDSEED_V2_CONTRACT_ADDRESS=0x7695494E1BB9f0696A52564BF15AA244819a882A`
- Node.js version: `22`

Cloudflare Pages treats a project without a top-level `404.html` as a single-page application and serves `index.html` for unmatched navigation paths. This project has no `404.html`, so no wildcard rewrite is needed. The app currently navigates its game screens in client state rather than through URL routes. Keep the Vite base path at `/` when using a project root or `*.pages.dev` origin.

`VITE_WORLDSEED_V2_CONTRACT_ADDRESS` is public and is embedded in browser assets at build time. No RPC credential or private key is required by the frontend. Do not define `HEMI_SEPOLIA_PRIVATE_KEY`, `HEMI_MAINNET_PRIVATE_KEY`, or any other secret in the Pages build environment. Hosting authorization and account credentials are required to publish; none are configured here, so no preview URL has been created. `VITE_WORLDSEED_CONTRACT_ADDRESS` remains the separate V1 reference setting.

After publishing, verify the HTTPS origin loads, open the app and the 2048 screen, refresh both screens, and confirm there are no failed dynamic asset requests. Connect a disposable wallet only after confirming it is set to Hemi Sepolia.

## Hemi Sepolia contract deployment (reference only)

The reviewed V2 contract is already deployed; do not run this procedure again for staging. For a future explicitly authorized testnet deployment, first set `HEMI_SEPOLIA_RPC_URL` and `HEMI_SEPOLIA_PRIVATE_KEY` in the deployment shell through a local secret manager, confirm chain ID `743111` and deployer funding, then run:

```powershell
npm run contract:compile
npm run contract:test
npm run contract:deploy:testnet
```

Never put private keys in `VITE_*` variables, source files, shell transcripts, frontend hosting settings, or version control. Do not paste a key or seed phrase into chat. Mainnet variables are reserved and unused; this repository does not authorize a Mainnet deployment.

## V2 deployment preparation checklist

This is a preparation checklist only. It does not authorize deployment.

### Wallets and RPC

- [ ] Choose a funded disposable **owner** wallet for administrative actions.
- [ ] Choose a separate funded disposable **attester** wallet for candidate signatures.
- [ ] Confirm both addresses and confirm `owner != attester`.
- [ ] Set `HEMI_SEPOLIA_RPC_URL` to an Hemi Sepolia RPC and verify `eth_chainId` is `0xB5B07` (`743111`).
- [ ] Fund the owner with enough Hemi Sepolia test ETH for deployment and one verification transaction. Keep the attester funded only if it will submit onchain transactions.

Required deployment-shell variables (set through a local secret manager or session-only environment):

```text
HEMI_SEPOLIA_RPC_URL=<Hemi Sepolia RPC URL>
HEMI_SEPOLIA_PRIVATE_KEY=<owner/deployer key; never commit or print>
HEMI_V2_OWNER_ADDRESS=<owner address>
WORLDSEED_ATTESTER_ADDRESS=<attester address>
```

Run the guarded procedure only after the preflight review:

```powershell
npm ci
npm run contract:compile
npm run contract:test
npm run contract:deploy:v2:testnet
```

Record the printed V2 address, deployment transaction, block, receipt status, and gas. Read the deployed `attester()` and compare it to `WORLDSEED_ATTESTER_ADDRESS`. Do not reuse the V1 address for V2 configuration.

### Remote D1 and Pages Functions

Identify the intended production D1 database first. If it does not exist, create it once, then apply migrations from the repository:

```powershell
npx wrangler d1 list
npx wrangler d1 create worldseed-h2
# Only if the list shows no intended database. Copy the returned database_id into wrangler.toml.
# Do not commit credentials or a placeholder ID.
npx wrangler d1 migrations apply worldseed-h2 --remote
```

In the Cloudflare Pages project, bind that database as `WORLDSEED_DB`. Configure these **server-side** variables and secrets:

```text
ETHEREUM_SEPOLIA_RPC_URL=<Ethereum Sepolia RPC>
HEMI_SEPOLIA_RPC_URL=<Hemi Sepolia RPC>
BITCOIN_TESTNET4_API_URL=https://mempool.space/testnet4/api
WORLDSEED_V2_CONTRACT_ADDRESS=0x7695494E1BB9f0696A52564BF15AA244819a882A
WORLDSEED_V2_ATTESTER_ADDRESS=0x8E2F2FEB6dCfBD6FBA3DC4F0c17e406941806D9B
WORLDSEED_ATTESTATION_PRIVATE_KEY=<attester key as a Pages secret>
```

Set `WORLDSEED_ATTESTATION_PRIVATE_KEY` with `wrangler pages secret put` or the Pages dashboard secret UI. Never put it in a `VITE_*` variable. The candidate function fails closed if the derived signer does not match the configured attester address.

After configuring Pages, build with the public browser variable only:

```text
VITE_WORLDSEED_V2_CONTRACT_ADDRESS=0x7695494E1BB9f0696A52564BF15AA244819a882A
```

Then verify the deployed address, chain ID, attester address, D1 binding, and a fresh candidate issuance before allowing a connected-wallet test. Source verification can be attempted with the officially supported explorer/Sourcify route after deployment; matching local bytecode alone is not public source verification.

### Rollback and blockers

If deployment or attester configuration fails, stop issuance, remove the Pages secret/binding, and leave the existing V1 and V2 testnet contracts untouched. Do not redeploy to Mainnet. A new V2 deployment requires a new address propagation and a fresh D1/service configuration review.

Current blockers remain connected-browser testing, Hemi Sepolia gas measurements for every V2 write path, and a hosted HTTPS build verification. No deployment or Pages authorization is assumed by this document.

## Clean-wallet manual QA

Use a separate funded test wallet with no existing island or active puzzle round. Record the account, chain ID, action, transaction hash, receipt status, and `gasUsed` for each submitted transaction. Never record a private key or recovery phrase.

1. Open the HTTPS staging origin and select **Connect Wallet**. Approve the connection in the wallet. If prompted, approve switching to Hemi Sepolia. Confirm the connected address and chain ID `743111` in the UI/wallet.
2. Start the island. Record the transaction hash. Wait for a successful receipt and confirm the starter Water and Grass inventory appears. Read `islandState(player)` and confirm `started=true`, cursor `0`, and initial inventory.
3. Place a valid habitat or two, then select **Save Progress**. Record the hash and gas. Confirm the save notice, inventory update, and cursor increment. Read `islandState(player)` and compare its cursor and habitats to the screen.
4. Continue restoring until a region unlocks. Confirm its reward appears once. Read `unlockedThrough`, `claimed`, inventory, and weekly contributions; retrying the same cursor should fail without duplicate rewards.
5. Open the Seed Shrine and start a **Rewarded** round. Approve the transaction and record hash, gas, stamina, and active puzzle state. Confirm the board matches `puzzleState(player)`.
6. Make at least 20 valid moves and submit one checkpoint. Record the hash and gas. Confirm the move count, board, and RNG state onchain match the UI. An ordinary 20-move checkpoint is one wallet approval. Rejected prompts must leave the move queue available for retry.
7. Reload the page. Reconnect the same account if necessary. Confirm island and puzzle state restore from chain; same-browser unsubmitted actions should also replay from local storage when their seed and cursor match.
8. In a second action, reject a wallet prompt. Confirm the UI says it was rejected and leaves local actions intact. Retry and confirm a successful receipt. For a revert, confirm the UI does not report success or clear queued actions. Check the transaction in the explorer before retrying after a timeout or replacement.
9. Finish restoring the island and submit **Finish Island**. Record hash, status, and gas. Confirm completion, the completion reward, and the World Tree contribution. Read `islandState(player)` (`complete=true`) and `weeklyContributions(currentWeek())`.
10. Refresh the completed island and confirm the final state persists. Save all transaction hashes and receipt gas in the QA record.

For the previously exercised 140-move rewarded round, the flow took eight approvals (start plus seven checkpoints) and used `9,672,779` total gas. Actual prompts and gas can vary by wallet, move count, and whether the round ends early.

## Mainnet readiness checklist

- [ ] Clean-wallet connected-browser test passes on the public HTTPS origin, including chain switching and recovery from rejection/revert.
- [ ] Start, progress, region rewards, puzzle settlement, shop, completion, and World Tree behavior are verified against the deployed testnet contract.
- [ ] Transaction hashes, receipt statuses, and target-chain gas are recorded for all wallet write paths.
- [ ] Hosted build has correct public configuration, survives refresh/direct navigation, and has no missing chunks or uncaught console errors.
- [ ] Contest rules, economy values, security review, and operational ownership are reviewed.
- [ ] Mainnet chain configuration, contract address, funding, and deployment authority are reviewed separately.
- [ ] Explicit authorization for Mainnet deployment is provided.

Passing automated tests alone does not satisfy these gates.
