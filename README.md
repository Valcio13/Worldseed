# Worldseed: Shattered Isles

Worldseed is a cozy pixel-fantasy incremental island game. Collect Nature from the Island Heart, grow habitats, build production, and rebirth for seasonal progression. Guest play is local and simulated; Live play uses the V3 verifier and Hemi contract.

## Game modes

- **Guest:** local save and simulated Nature, Personal Points, and Community Points.
- **Live:** wallet-linked runs validated by the Worldseed verifier and settled on Hemi. Guest saves are never submitted or converted into Live rewards.

The 7×7 restoration game, legacy V1/V2 contracts, and puzzle engine remain in the repository as separate legacy systems; they are not the main V3 progression loop.

## Live deployments

| Environment | Frontend                                                                                   | Chain                 | Contract                                      | Verifier                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Mainnet     | [worldseed-mainnet.valcio222.workers.dev](https://worldseed-mainnet.valcio222.workers.dev) | Hemi `43111`          | `0x133B0fDbaC7D6535C68Be5945d15C328F3d371E4`  | [worldseed-v3-verifier-mainnet.valcio222.workers.dev](https://worldseed-v3-verifier-mainnet.valcio222.workers.dev) |
| Sepolia     | [worldseed.valcio222.workers.dev](https://worldseed.valcio222.workers.dev)                 | Hemi Sepolia `743111` | See the environment-specific V3 configuration | [worldseed-v3-verifier.valcio222.workers.dev](https://worldseed-v3-verifier.valcio222.workers.dev)                 |

Contract addresses are public. Verifier signing keys and RPC credentials are server-side secrets and must never be included in `VITE_*` variables or source control.

## Local development

Requirements: Node.js 22+ and npm.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Vite runs at `http://localhost:5173/` and uses strict port checking. `.env.local`, `.env`, and `.dev.vars` are local configuration; never commit them. Guest play does not require a wallet. Live development requires the matching public V3 contract and verifier configuration.

## Useful commands

```powershell
npm run dev
npm run build
npm run preview
npm test
npm run typecheck
npm run typecheck:worker
npm run lint
npm run format:check
npm run contract:compile
npm run contract:test
```

`npm run build` typechecks the app and creates static assets in `dist/`.

## Cloudflare deployment configuration

The root [wrangler.toml](wrangler.toml) is intentionally retained as the default static-assets frontend configuration for the existing `worldseed` Worker. The separate frontend and verifier configurations are organized under [`deployment/cloudflare/`](deployment/cloudflare/README.md). Testnet and Mainnet use separate Workers, databases, build variables, and verifier secrets.

For the existing frontend Worker, build with its intended public Vite variables, then run from the repository root:

```powershell
npm run build
npx wrangler deploy --dry-run
npx wrangler deploy
```

For the separate Mainnet frontend, use the Mainnet config explicitly:

```powershell
npm run build
npx wrangler deploy --config deployment/cloudflare/wrangler.mainnet.example.toml --dry-run
npx wrangler deploy --config deployment/cloudflare/wrangler.mainnet.example.toml
```

Verifier deployment commands and the required D1/RPC/attester settings are documented in [deployment and release](docs/deployment.md) and [V3 Workers and D1](docs/v3-cloudflare-workers-d1.md). Deploy the verifier before a frontend that depends on a changed verifier API. Never deploy or migrate remote resources without authorization.

## Repository map

- `src/`: React application, island gameplay, incremental rules, verifier, and Worker implementation.
- `public/`, `art/`: browser assets and source artwork.
- `contracts/`, `contract-test/`: Solidity contracts and local contract tests.
- `migrations/`: D1 schema migrations.
- `deployment/`: deployment artifacts, Remix inputs, and environment-specific Cloudflare configuration.
- Temporary balance simulations and investigation tests are developer-only material and are not part of the release.
- `docs/`: architecture, API, deployment, and release notes.

## Limitations

- Guest points are simulated and are not on-chain rewards.
- Live progression depends on the matching chain, contract, and verifier being available.
- Automated checks do not replace manual wallet testing of the hosted application.
- Legacy systems remain in source but are separate from the active incremental progression loop.

## License

MIT; see [LICENSE](LICENSE).
