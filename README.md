# Worldseed: Shattered Isles

Worldseed is a cozy island restoration game built for the Hemi Arcade 2 contest. Restore a small 7×7 island by placing Water, Grass, and Forest habitats, connect healthy ecosystems, uncover five regions, and complete the Island Heart. The shared World Tree records weekly contributions from wallet players.

## Gameplay modes

- **Guest mode:** Play and save an island locally without connecting a wallet. Guest resources are practice resources and do not create onchain rewards.
- **Wallet mode:** Connect an injected browser wallet and use Hemi Sepolia. Start a wallet-bound island, synchronize restoration progress, claim region rewards, play rewarded 2048 rounds, spend verified Gold in the habitat shop, finish the island, and contribute to the World Tree.
- **2048 practice:** Play locally without wallet prompts or spendable rewards. Rewarded rounds are separate and commit a start transaction plus move checkpoints.
- **H2 candidate preview:** A connected Hemi Sepolia wallet can request three signed candidate previews sourced from Ethereum Sepolia, Hemi Sepolia, and Bitcoin Testnet4 transactions. H2 persistence is offchain in D1; the deployed V1 contract cannot commit the selection or start repeatable expeditions.

## Hemi Sepolia deployment

The V1 reference contract is `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4`. The fresh-state V2 expedition contract is `0x7695494E1BB9f0696A52564BF15AA244819a882A`, both on Hemi Sepolia chain ID `743111`. No Hemi Mainnet contract is configured or authorized.

- [Hemi Sepolia V2 contract explorer](https://testnet.explorer.hemi.xyz/address/0x7695494E1BB9f0696A52564BF15AA244819a882A)
- [Hemi Sepolia V1 reference explorer](https://testnet.explorer.hemi.xyz/address/0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4)

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

Vite serves the app at `http://localhost:5173/` and uses strict port checking. The public testnet contract address is in `.env.example`. `.env.local` is ignored by Git. Frontend hosting does not require a private key, RPC credential, or backend service.

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

## Deploy the frontend to Cloudflare Pages

Create a Cloudflare Pages project from the repository and set:

| Setting                | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Build command          | `npm run build`                                                                 |
| Build output directory | `dist`                                                                          |
| Node.js version        | `22`                                                                            |
| Environment variable   | `VITE_WORLDSEED_V2_CONTRACT_ADDRESS=0x7695494E1BB9f0696A52564BF15AA244819a882A` |

The contract address is public and embedded in the browser build. Do not add `HEMI_SEPOLIA_PRIVATE_KEY`, `HEMI_MAINNET_PRIVATE_KEY`, or other secrets to Pages settings. Pages provides SPA fallback for this project because it has no top-level `404.html`. After deployment, test the HTTPS origin, refresh, the Seed Shrine lazy-loaded 2048 screen, wallet connection, and direct navigation.

See [deployment and release gates](docs/deployment.md) for testnet details, wallet QA steps, and the Mainnet checklist. Cloudflare Pages has not been deployed from this workspace.

See [H2 candidate issuance](docs/H2-CANDIDATE-SERVICE.md) for source confirmation rules, D1 setup, Functions configuration, signing keys, and current limitations. The H2 service needs a D1 binding and server-side variables/secrets; do not expose its attestation key in a browser build.

The [H3 V2 contract implementation and review notes](docs/H3-V2-CONTRACT-PROPOSAL.md) describe the fresh-state V2 contract. V1 remains a separate testnet reference; V2 does not migrate V1 balances. Candidate issuance also requires the Pages Functions and D1 server bindings described in the H2 guide.

## Project structure

- `src/game/`: deterministic island generation, placement rules, and restoration state.
- `src/puzzle/`: 2048 engine and reward calculations.
- `src/components/`: island, terrain, and puzzle interfaces.
- `src/blockchain/`: Hemi Sepolia configuration, contract ABI, and transaction handling.
- `src/persistence/`: local guest island storage.
- `src/expeditions/` and `functions/api/expedition/`: testnet provenance, candidate preview and attestation service.
- `contracts/`, `contract-test/`: Solidity ledger and Hardhat tests.
- `docs/`: architecture, gameplay, contract interface, and deployment instructions.

## Known limitations and release status

- A separate clean-wallet browser journey on the public HTTPS build is still required. Automated tests and direct contract transactions do not verify injected-wallet prompts or hosted browser behavior.
- Cloudflare Pages hosting has not been configured or published.
- The production build reports a 611.81 KB main JavaScript chunk (184.91 KB gzip). The 2048 game is already emitted as a separate lazy-loaded chunk.
- Rewarded 2048 rounds require multiple wallet approvals. A previously exercised 140-move round used eight approvals and 9,672,779 gas; actual usage varies.
- Economy values and contest acceptance remain subject to release review. Do not treat this project as Mainnet-ready based on automated tests alone.

## License

Worldseed is distributed under the [MIT License](LICENSE).
