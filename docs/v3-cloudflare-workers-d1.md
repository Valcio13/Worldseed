# V3 verifier on Cloudflare Workers + D1

The verifier is a separate Worker from the static frontend. Root `wrangler.toml` deploys the `worldseed` static-assets-only frontend; `wrangler.v3-verifier.toml` deploys `worldseed-v3-verifier`, which handles `/api/v3/*` and `/health` and binds D1 as `WORLDSEED_DB`. The frontend points to the verifier origin with `VITE_VERIFIER_API_URL`. `LocalVerifier`, canonical rules, EIP-712 construction, chain reader, and transaction semantics are shared with the Node/SQLite reference. Node-only SQLite and `node:crypto` modules are not in the Worker dependency graph.

## Files

- `src/incremental/worker/index.ts`: Workers module entry and environment validation.
- `wrangler.toml`: static-assets-only frontend Worker configuration.
- `wrangler.v3-verifier.toml`: verifier Worker settings, D1 binding, and public runtime configuration.
- `src/incremental/worker/httpHandler.ts`: Fetch API adapter implementing the documented `/api/v3` protocol.
- `src/incremental/server/d1VerifierStore.ts`: D1 persistence for command journals, sessions, challenges, attestation slots, and chain checkpoints.
- `src/incremental/server/workersWalletSessions.ts`: Web Crypto wallet challenge/session implementation.
- `migrations/0001_v3_verifier.sql` through `0003_run_started_event_scans.sql`: D1 schema, command cursor guards, and resumable per-run `RunStarted` scan cursors.
- `src/incremental/server/localServer.ts` and `sqliteVerifierStore.ts`: retained Node/SQLite local reference.
- `docs/v3-verifier-api.md`: API contract for frontend integration.

`D1Database.batch()` is used for command insertion plus cursor advancement and challenge consumption plus session creation. Database triggers validate the command sequence transition. Attestation slots use a unique `(chain, contract, player, nonce)` key; conditional writes and a confirmed block checkpoint allow only one payload/signature to win. Any D1 error returns an unavailable response; the Worker does not fall back to memory or SQLite.

## Free-plan limits and current operating boundary

Chain checkpointing verifies the prior stored block hash and then compare-and-swaps to the latest confirmed block, so downtime does not cause one RPC/D1 operation per intervening block. Command journals use periodic snapshots and replay at most 127 tail commands per request. `RunStarted` history recovery reads at most 1,000 confirmed blocks per request and stores its cursor, scan-boundary hash, and any matching event in D1. A partial scan returns recoverable `RECOVERY_FAILED` (HTTP 503); retrying the authenticated request resumes at the next page. RPC errors do not advance the cursor. The reader checks the previous scan boundary and any cached event block against canonical hashes before reuse; a mismatch restarts that run's scan from the configured deployment block. These costs still grow with chain age and the number of requests needed to recover old runs, so this is for controlled low-volume testnet QA and has not been load-tested for sustained public traffic on the Free plan. Expired challenge/session rows and command journals also need a retention policy before substantial usage.

There is no application-level rate limiter in the Worker. Before enabling public traffic, configure Cloudflare edge rate limiting/WAF controls for `/api/v3/*`, especially unauthenticated challenge issuance, and monitor Worker CPU, request count, D1 rows read/written, and storage. D1 quota exhaustion makes database-backed verifier requests fail closed; it does not fall back to local or in-memory state.

The D1 tests execute the migration and SQL against SQLite using a D1-shaped adapter. They cover authentication, command concurrency/idempotency, restart recovery, attestation reservation/signature winner, a failed transactional write, and a successful Rebirth-attestation response with a test-only already-verified score fixture. The latter tests the issuance path only; production scoring still replays accepted commands and enforces the actual contract threshold.

## Manual Cloudflare setup (not performed)

1. Deploy V3 manually to the selected test chain first. Record chain ID, contract address, deployment block, and the deployed `attester()` value. This project does not add a contract deployment command or deployment pipeline.
2. Use the existing `worldseed-v3-verifier` D1 database configured in `wrangler.v3-verifier.toml`; do not create a duplicate. The configured binding is `WORLDSEED_DB` and its ID is the dashboard-provided database ID.
3. The owner previously reported applying migrations 0001–0003 through the Cloudflare dashboard SQL console. Confirm the migration history in that database before applying anything again. For future migrations, target the verifier config explicitly when using Wrangler.
4. Check the non-secret `[vars]` in `wrangler.v3-verifier.toml`: chain ID, contract address, deployment block, confirmations, and allowed frontend origin must match the deployed contract and frontend.
5. Store the HTTPS RPC endpoint as a verifier Worker secret with `npx wrangler secret put V3_RPC_URL --config wrangler.v3-verifier.toml`; RPC URLs can contain provider credentials. Derive the attester address locally from the intended signing key, compare it to the contract's `attester()`, then set the key with `npx wrangler secret put V3_ATTESTER_PRIVATE_KEY --config wrangler.v3-verifier.toml`. Enter both secrets only at their interactive prompts. Never place either in a `VITE_` variable, either Wrangler config, browser bundle, logs, or source control. Use disposable test keys for testnet.
6. Check frontend and verifier configurations without publishing: `npm run build`, `npm run typecheck:worker`, `npx wrangler deploy --dry-run`, and `npx wrangler deploy --config wrangler.v3-verifier.toml --dry-run`. A dry run does not verify credentials, live D1 migration status, RPC reachability, deployed bytecode, or signatures.
7. The verifier `/health` endpoint was previously reported live. After any separately authorized deployment, authenticate with a disposable wallet, confirm a challenge is one-use, test run start and command replay, and compare attester/nonce/season reads to chain. Never enable real players until D1 recovery and chain reconciliation are confirmed.

Do not run remote migration/deployment commands from this task. `V3_ATTESTER_PRIVATE_KEY` and `V3_RPC_URL` are secrets; the chain ID, contract address, deployment block, confirmation count, allowed origin, and D1 ID are runtime configuration. D1 contains session token digests rather than bearer tokens.

## Test-only Rebirth

The unit/integration test injects a trusted `recover()` result into the HTTP handler and uses the real D1 reservation path plus a disposable EIP-712 signer to verify the returned signature. This is deterministic and does not add a production bypass, alter V3 rules, modify the deployed contract, or fabricate a client score. It does not replace a natural end-to-end progression test.
