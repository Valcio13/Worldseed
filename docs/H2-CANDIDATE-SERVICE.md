# H2 candidate issuance service

## Scope and source networks

H2 uses **Ethereum Sepolia (11155111)**, **Hemi Sepolia (743111)**, and **Bitcoin Testnet4**. It never queries the corresponding production mainnets. EVM source configuration is rejected if `eth_chainId` differs from the expected testnet. Ethereum and Hemi candidates require 12 confirmations; Bitcoin Testnet4 candidates require 6.

The default providers are Ethereum Sepolia PublicNode, Hemi Sepolia's testnet RPC, and the public mempool.space Testnet4 API. All endpoints can be overridden for local/test use. Public endpoints are best effort and may rate limit requests; no API credential is required. A failed, stale, noncanonical, or under-confirmed source fails the entire issuance and can be retried. There is no fallback to mainnet or to cached alternate transactions.

Selection is cryptographically randomized with rejection sampling: first choose a block height uniformly from the configured recent confirmed-height window, then choose a transaction uniformly from that block (Bitcoin coinbase is excluded). This is deliberately documented as block-weighted selection, not uniform selection over every transaction in the window. The committed provenance includes network ID, txid, block hash/height, transaction index, and observed/required confirmation counts.

## Storage, authentication, and attestation

Cloudflare Pages Functions host same-origin endpoints. D1 durably stores one candidate set per lowercased wallet and expedition number, plus short-lived one-use wallet challenges. The wallet signs a five-minute EIP-191 challenge; this proves wallet control and does not request an onchain transaction. Candidate sets are persisted before a response is returned. Concurrent requests use a unique `(player, expedition_number)` key and return the row that won insertion. A repeated authenticated request returns that same row, never a newly selected set.

The candidate-set EIP-712 attestation binds the player, expedition number, ordered ETH/HEMI/BTC source commitment, three full 32-byte candidate seeds, combined character seed, island/character/selection-policy versions, issue time, Hemi Sepolia chain ID, and configured V2 verifying-contract address. Candidate previews use `generateIslandV2`: terrain varies deterministically per seed while the 7×7 board, legal-cell mask, witness cells, and restoration rules match V1. H3 consumes these selections only through `WorldseedGameV2`. Attestations expire after seven days. An expired row is re-signed with its stored source records and same seeds; source reselection is not allowed for that expedition. The signature is server-side only. The private key must be a Cloudflare Pages secret binding; never a `VITE_` variable. V2 is deployed at `0x7695494E1BB9f0696A52564BF15AA244819a882A`, but the service is not active until its D1 binding, source endpoints, and matching signer are configured. V1 cannot verify or lock this attestation.

## Local setup

1. Install Wrangler for your shell if it is not already available. For remote setup, run `npx wrangler d1 create worldseed-h2` and replace the placeholder `database_id` in `wrangler.toml` with the returned ID. For local-only use, `npx wrangler pages dev dist --d1 WORLDSEED_DB=worldseed-h2` creates an isolated local D1 binding.
2. Apply the migration locally with `npx wrangler d1 migrations apply worldseed-h2 --local`. For an explicitly configured remote test database, use `npx wrangler d1 migrations apply worldseed-h2 --remote`.
3. Copy `.dev.vars.example` to `.dev.vars`; replace the signer key with a disposable local-only key and keep a placeholder contract address. `.dev.vars` is ignored by Git.
4. Set `ETHEREUM_SEPOLIA_RPC_URL`, `HEMI_SEPOLIA_RPC_URL`, and `BITCOIN_TESTNET4_API_URL` to the testnet endpoints.
5. Run `npm run build`, then `npx wrangler pages dev dist` to serve the app and Functions on one origin. Vite's normal dev server does not execute Pages Functions.

For real wallet flows, use an isolated wallet and never reuse a production signer. Requests are scoped to a sequential expedition number in a fresh V2 environment. H3 defines eligibility, abandonment, and onchain selection locking. The service itself remains unpublished and must be tested with the deployed V2 contract and a configured D1 before use.

## Failure and recovery

- Wallet rejection occurs before candidate issuance; request a new challenge and retry.
- Expired/replayed challenges are rejected and cannot be used to issue another set.
- Provider, confirmation, canonicality, or timeout errors return retryable HTTP 503 and do not return a partial set. A new challenge can retry.
- Once persisted, refreshes/retries return the same signed set.
- D1 stores the chosen source under wallet + expedition. A different candidate cannot overwrite that choice for the same commitment. After refresh, the wallet reauthenticates with a message signature and gets the same choice with the candidate set.
- If a response is interrupted after D1 persistence, a fresh wallet challenge retrieves the already stored set.
- Challenge creation is capped at eight per wallet per ten-minute window; deployment should also configure edge-level abuse controls for IP-level floods.

## Hosting

Cloudflare Pages is compatible with static Vite output plus Pages Functions. Configure a D1 binding named `WORLDSEED_DB` and the same source/signing environment bindings in the Pages project's production environment. Set the RPC URLs and Testnet4 API URL as regular server-side variables, `WORLDSEED_V2_CONTRACT_ADDRESS` to the reviewed V2 address, and `WORLDSEED_V2_ATTESTER_ADDRESS` to the address returned by the deployed contract's `attester()` read. Set `WORLDSEED_ATTESTATION_PRIVATE_KEY` as a Pages secret. The function compares the secret's derived address with `WORLDSEED_V2_ATTESTER_ADDRESS` and fails closed when they differ. Do not add any of these server values with a `VITE_` prefix. Configure static output directory `dist`; the existing Pages SPA fallback serves the app shell on direct routes.

The service depends on public testnet providers and is not an SLA-backed production randomness oracle. Before contest release, independently review the selection policy, source confirmation policy, signer custody/rotation, D1 retention, rate limiting, and provider limits. H2 does not provide V1 balance migration or multiple expedition lifecycle support.
