# Contest release checklist

## Readiness snapshot

- **Frontend build:** `npm run build` passes. The Vite production bundle has a non-blocking warning for a 669 kB JavaScript chunk; the build completes successfully.
- **Static assets:** literal `/assets/...` image/font paths found in `src/` resolve under `public/`.
- **Existing V1 deployment:** the frontend's wallet config targets Hemi Sepolia (chain `743111`) and `.env.example` contains the existing public V1 contract address. This is not the V3 contract.
- **V3 release:** not deploy-ready. `wrangler.toml` still contains a zero D1 ID and placeholder chain, contract, origin, and block settings. V3 contract deployment details and Worker secrets are not configured in this workspace.

## Hosting path

Use the Cloudflare Workers Static Assets setup in `wrangler.toml`. It serves `dist/` and routes `/api/v3/*` and `/health` through the same Worker origin. Cloudflare Pages alone does not provide those API routes.

If hosting static assets on Pages instead, separately route `/api/v3/*` to the verifier Worker or use its own HTTPS API origin. In the latter case set `VITE_VERIFIER_API_URL` to that real API base (without `/api/v3`) and set the Worker allow-origin list to the exact game origin.

Keep Vite `base` at `/` for a root domain or `*.pages.dev` / Worker origin.

## Required configuration

### Frontend build-time variables

Set these in the build environment; Wrangler `[vars]` are Worker runtime variables and do not automatically configure Vite. Placeholder names are listed in `.env.example`:

- `VITE_ENABLE_V3_IDLE=true` to expose the existing Guest / Verified shell.
- `VITE_WORLDSEED_V3_CONTRACT_ADDRESS=<deployed V3 contract address>` for the contract on the wallet's configured chain. The current frontend wallet target is Hemi Sepolia (`743111`); deployment to another chain requires coordinated frontend changes.
- `VITE_WORLDSEED_CONTRACT_ADDRESS=0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4` only for the existing V1 contract flows still exposed in the app.
- `VITE_VERIFIER_API_URL` may remain unset when the same-origin Worker handles `/api/v3/*`; set it only when the verifier uses a separate HTTPS origin.

`.env.example` deliberately keeps the V3 UI disabled and uses a non-address placeholder until deployment. Vite embeds `VITE_*` values in public browser assets. Do not put secrets there.

### Worker and D1 runtime

Before deploying, replace the placeholders in `wrangler.toml` with values confirmed for the selected V3 contract and game origin:

- `[[d1_databases]].database_id`: the actual D1 database ID; the all-zero value is a placeholder.
- `V3_CHAIN_ID=743111` to match the frontend's Hemi Sepolia wallet configuration, plus the deployed `V3_CONTRACT_ADDRESS`, actual `V3_DEPLOYMENT_BLOCK`, chosen `V3_CONFIRMATIONS`, and exact HTTPS `V3_ALLOWED_ORIGINS`.
- Worker secrets `V3_RPC_URL` (HTTPS RPC endpoint) and `V3_ATTESTER_PRIVATE_KEY` (must derive the deployed contract's `attester()` address). Set through the secret manager / interactive Wrangler prompts. Never place them in Git, Pages variables, or browser configuration.
- `WORLDSEED_DB` binding must exist and the database must have all migrations applied, including `0003_run_started_event_scans.sql`.

## Deployment order

1. Finish and approve the V3 contract / settlement implementation. Deploy on the frontend's configured Hemi Sepolia chain (`743111`) through the separately authorized manual procedure. Record the real address, deployment block, owner, and attester. The existing Hemi Sepolia V1 address is not a substitute.
2. Create the production D1 database, put its ID in `wrangler.toml`, and apply all pending migrations remotely.
3. Set the Worker runtime variables and secrets. Verify the RPC reports the configured chain and the private key's address matches the on-chain `attester()`.
4. Set the frontend build-time variables for the same deployed V3 address and chain. Run `npm run build` and `npx wrangler deploy --dry-run`.
5. After owner approval, deploy the configured Worker Static Assets application. If Pages is chosen instead, first make the Worker route/API origin and CORS configuration reachable, then build and publish Pages with the matching API URL.

## Post-deployment verification

- Open the HTTPS game origin, refresh it, and confirm the SPA shell, CSS, and image assets load with no missing chunks. Confirm direct navigation falls back to `index.html`.
- Check `GET /health` for liveness. This alone does **not** prove D1, RPC, contract, or signer health.
- With a disposable test wallet on the configured chain, complete a one-use wallet challenge and authenticate; verify the Worker can read chain state and persist/recover D1 session state.
- Owner-run manual wallet QA: connect, start a run, submit a command, reload/recover the cursor, and exercise settlement against the deployed contract. Verify transaction receipts and on-chain run/attester state. Do not treat automated tests or `/health` as a substitute.
- Confirm logs and monitoring are available. Before public traffic, configure edge rate limiting/WAF for `/api/v3/*` and decide D1/session/journal retention; the current Worker has no application-level rate limiter and the docs identify it as controlled low-volume testnet infrastructure.

## Blockers and documentation follow-up

**Critical for V3 contest release:** final V3 contract deployment and matching frontend/Worker chain configuration; real D1 ID plus migrations; Worker RPC and attester secrets; exact HTTPS game origin; feature flag and V3 address in the frontend build; one coherent Pages/Worker routing setup; successful owner-run wallet QA. None of these deployment steps were performed in this review.

**Documentation:** `README.md` and `docs/deployment.md` now describe the Worker Static Assets architecture and distinguish the existing V1 contract from the required V3 deployment. Keep them aligned if the hosting target or V3 configuration changes.

**Optional:** split the large JavaScript chunk (current build warning only). It is not a release blocker based on the successful production build.
