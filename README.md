# Worldseed: Shattered Isles

Worldseed is a cozy weekly incremental island-building game. Generate Nature from the Island Heart, grow habitats, and rebirth to build seasonal momentum. Seasons begin Monday at 00:00 UTC and last seven days. The 7×7 restoration scene remains available as optional island content.

## Gameplay modes

- **Guest mode:** Play and save the complete incremental loop locally: generate Nature, upgrade habitats, and rebirth for simulated seasonal PP and CP. These guest points are never wallet rewards.
- **Wallet mode:** The existing Hemi Sepolia V1 island and World Tree integration remains in the repository. A feature-flagged V3 verified progression shell uses a V3 contract and verifier API; it requires a separately deployed and configured V3 service. Guest progress cannot be converted into wallet rewards.

The project roadmap has five milestones. See [docs/roadmap.md](docs/roadmap.md) for their status and scope.

## Hemi Sepolia deployment

The current testnet contract is `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4` on chain ID `743111`. Its source has exact creation and runtime matches on Sourcify. The frontend is configured for Hemi Sepolia; no Hemi Mainnet contract is configured or authorized.

- [Hemi Sepolia contract explorer](https://testnet.explorer.hemi.xyz/address/0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4)
- [Sourcify source record](https://repo.sourcify.dev/743111/0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4)

## Requirements

- Node.js 22 or later
- npm
- A browser wallet and Hemi Sepolia test ETH for connected-wallet play; guest mode needs neither

## Install and run locally

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Vite serves the app at `http://localhost:5173/` and uses strict port checking. The public testnet contract address is in `.env.example`. `.env.local` is ignored by Git. Guest play and the existing V1 frontend do not need a backend service; verified V3 play also requires its Worker verifier and D1 configuration.

## Development and verification commands

```powershell
npm run dev
npm run build
npm run preview
npm test
npm run typecheck
npm run lint
npm run format:check
npm run contract:compile
npm run contract:test
```

`npm run build` typechecks and writes the production site to `dist/`. Hardhat compiles with Solidity 0.8.24; the lockfile pins the installed dependency graph for `npm ci`.

## Deploy to Cloudflare Workers

Worldseed uses two separate Cloudflare Workers. The root `wrangler.toml` configures the static-assets-only frontend Worker named `worldseed`; it serves Vite's `dist/` files and does not have a D1 binding or verifier entrypoint. `wrangler.v3-verifier.toml` configures `worldseed-v3-verifier` with the `WORLDSEED_DB` D1 binding. The frontend sends `/api/v3/*` requests to the verifier's separate HTTPS origin using `VITE_VERIFIER_API_URL`; its allowed origin must match the frontend origin.

Before building, configure the public Vite variables in the build environment:

- `VITE_WORLDSEED_CONTRACT_ADDRESS` for the existing V1 Hemi Sepolia contract, if those flows are needed.
- `VITE_ENABLE_V3_IDLE=true` to expose the Guest / Verified shell.
- `VITE_WORLDSEED_V3_CONTRACT_ADDRESS` for the deployed V3 contract on the frontend's configured Hemi Sepolia chain (`743111`).
- Leave `VITE_VERIFIER_API_URL` empty for the same-origin Worker API; set it to the verifier's HTTPS base URL only if the API is hosted separately. Do not append `/api/v3`.

The V3 contract address is public and embedded in browser assets. Verifier runtime configuration belongs to `wrangler.v3-verifier.toml`; `V3_RPC_URL` and `V3_ATTESTER_PRIVATE_KEY` are Cloudflare Worker secrets and must never be placed in `VITE_*` variables, source, or the browser build. The signing key must match the deployed contract's `attester()` value. `.env.example` contains public frontend settings and empty local deployment placeholders, not production secrets.

Build and deploy the frontend Worker after setting the public Vite variables in its build environment:

```powershell
npm ci
npm run build
npx wrangler deploy --dry-run
npx wrangler deploy
```

`wrangler deploy` from the project root publishes only the static frontend Worker. The separate verifier is deployed with `npx wrangler deploy --config wrangler.v3-verifier.toml`; it uses its own D1 binding and Cloudflare secrets. Both are explicit deployment actions. See [deployment and release gates](docs/deployment.md), [V3 Worker and D1 setup](docs/v3-cloudflare-workers-d1.md), and the [contest release checklist](docs/contest-release-checklist.md) for configuration and verification steps. The verifier `/health` endpoint was previously reported live; the latest frontend changes in this commit have not been deployed or remotely verified.

## Project structure

- `src/game/`: deterministic island generation, placement rules, and restoration state.
- `src/puzzle/`: temporarily retained legacy puzzle engine and wallet reward code; not exposed in current game navigation or progression.
- `src/components/`: island and terrain interfaces, plus a temporarily retained legacy puzzle screen.
- `src/blockchain/`: Hemi Sepolia configuration, contract ABI, and transaction handling.
- `src/persistence/`: local guest island storage.
- `contracts/`, `contract-test/`: Solidity ledger and Hardhat tests.
- `docs/`: architecture, gameplay, contract interface, and deployment instructions.

## Known limitations and release status

- A separate clean-wallet browser journey on the public HTTPS build is still required. Automated tests and direct contract transactions do not verify injected-wallet prompts or hosted browser behavior.
- The latest frontend source still needs a Cloudflare Workers deployment and browser verification. The separate verifier's `/health` endpoint was previously reported healthy; this repository checkout cannot confirm its current remote state or secrets.
- Legacy puzzle logic and contract entry points remain temporarily in source, but the game is no longer accessible from the player-facing app and grants no incremental progression.
- Economy values and contest acceptance remain subject to release review. Do not treat this project as Mainnet-ready based on automated tests alone.

## License

Worldseed is distributed under the [MIT License](LICENSE).
