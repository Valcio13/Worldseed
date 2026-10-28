# V3 verifier on Cloudflare Workers and D1

The verifier is a separate Worker from both static frontend Workers. Its shared implementation is in `src/incremental/worker/`; Node/SQLite remains the local reference. Node-only SQLite and `node:crypto` are excluded from the Workers bundle.

## Configuration and source files

- `wrangler.toml`: default static-assets frontend Worker (`worldseed`), not the verifier.
- `deployment/cloudflare/wrangler.v3-verifier.toml`: Hemi Sepolia verifier config.
- `deployment/cloudflare/wrangler.v3-verifier.mainnet.toml`: separate Hemi Mainnet verifier config and D1 database.
- `src/incremental/worker/index.ts`: Worker entrypoint and environment validation.
- `src/incremental/worker/httpHandler.ts`: Fetch API adapter for the documented `/api/v3` protocol.
- `src/incremental/server/d1VerifierStore.ts`: D1 persistence for sessions, commands, attestations, and chain checkpoints.
- `src/incremental/server/workersWalletSessions.ts`: Web Crypto wallet challenge/session implementation.
- `migrations/`: ordered D1 migrations.
- `docs/v3-verifier-api.md`: frontend API contract.

The Wrangler files live under `deployment/cloudflare/`; their `main` and `migrations_dir` paths are relative to that directory. Use `--config` explicitly to select the intended environment.

D1 batches command insertion with cursor advancement and challenge consumption with session creation. Triggers validate command sequence transitions. Attestation slots have a unique `(chain, contract, player, nonce)` key. D1 failures fail closed; the Worker does not fall back to memory or SQLite.

## Environment isolation

Mainnet and Sepolia must use different Worker names, D1 databases, RPC secrets, and attester secrets. Public chain/address/origin values belong in the corresponding Wrangler `[vars]`; `V3_RPC_URL` and `V3_ATTESTER_PRIVATE_KEY` are Cloudflare Worker secrets. Never put secrets in frontend `VITE_*` values, source files, logs, or Git.

For example, after independently confirming the target environment, set secrets interactively with the matching config:

```powershell
npx wrangler secret put V3_RPC_URL --config deployment/cloudflare/wrangler.v3-verifier.toml
npx wrangler secret put V3_ATTESTER_PRIVATE_KEY --config deployment/cloudflare/wrangler.v3-verifier.toml
```

Use `wrangler.v3-verifier.mainnet.toml` for Mainnet instead. Before applying remote migrations, inspect the target D1 database and its migration history; never point a Mainnet migration command at the Sepolia database or vice versa.

## Local validation

```powershell
npm run typecheck:worker
npx wrangler deploy --dry-run --config deployment/cloudflare/wrangler.v3-verifier.toml
npx wrangler deploy --dry-run --config deployment/cloudflare/wrangler.v3-verifier.mainnet.toml
```

A dry run does not verify remote migrations, secrets, RPC reachability, deployed bytecode, signatures, or live Worker health.

## Operating limits

Chain checkpointing validates the previous stored block hash before advancing. Command replay uses periodic snapshots and limits tail replay to 127 commands per request. `RunStarted` recovery scans at most 1,000 confirmed blocks per request and persists its cursor; a partial scan returns recoverable `RECOVERY_FAILED`, and an RPC error does not advance the cursor. These bounds make each request resumable but do not make long histories free. D1 quota exhaustion fails closed.

There is no application-level rate limiter. This implementation is intended for controlled usage; monitor Worker CPU/request count, D1 rows read/written and storage, plus RPC errors. Define retention and edge rate limits before substantially increasing traffic.
