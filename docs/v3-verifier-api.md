# Worldseed V3 Verifier API Contract

This is the frontend integration contract for Kiro. The API lives on the same Cloudflare Worker as the static app at `/api/v3`. All requests and responses are JSON except `GET /health`. The Worker signs attestations server-side; no signing key is exposed to the browser.

## Authentication

### `POST /api/v3/auth/challenge`

No session token required. The browser sends its connected account and the V3 deployment it selected:

```json
{
  "wallet": "0x...",
  "chainId": "<decimal uint256>",
  "verifyingContract": "0x...",
  "runId": "<decimal uint64>"
}
```

The `Origin` header must exactly match a configured `V3_ALLOWED_ORIGINS` entry. The verifier validates the chain/contract pair and returns:

```json
{ "challengeId": "<uuid>", "message": "<exact wallet message>", "expiresAtMs": 0 }
```

The wallet signs `message` with `personal_sign`/`signMessage`; this signature is for login only and is not a transaction authorization.

Before authentication, the frontend reads the connected chain ID, configured V3 contract, and current run context. The challenge includes the run ID as signed context, but the resulting session remains scoped to the wallet, chain, contract, and origin and can continue across that wallet's runs. Each requested run is independently checked against confirmed chain ownership, status, and rules by the verifier.

### `POST /api/v3/auth/complete`

```json
{ "challengeId": "<uuid>", "signature": "0x..." }
```

Success returns `{ "sessionToken": "<opaque bearer token>", "expiresAtMs": 0 }`. The token is valid for four hours, is returned once, and only its SHA-256 digest is persisted. The challenge is single-use and expires after five minutes. Include `Authorization: Bearer <sessionToken>` on all following requests. Sessions are bound to wallet, chain, contract, and origin, and may be reused for subsequent runs owned by that wallet.

## Start Run

### `POST /api/v3/runs/start-attestation`

Requires an authenticated wallet session. The verifier derives the next run ID and upgrade eligibility from confirmed chain state. Body:

```json
{
  "upgradeChoices": [{ "upgradeId": "growth", "quantity": 1 }]
}
```

Choices are optional; if present, IDs must be unique, in canonical order, and affordable from confirmed seasonal PP. The response is:

```json
{
  "attestation": {
    "player": "0x...",
    "runId": "<decimal uint64>",
    "seasonId": "<decimal uint64>",
    "chainId": "<decimal uint256>",
    "verifyingContract": "0x...",
    "scoreTier": 0,
    "natureCollectedAtoms": "0",
    "nonce": "<decimal uint64>",
    "issuedAt": "<unix seconds>",
    "expiresAt": "<unix seconds>",
    "rulesVersion": 1,
    "signerEpoch": 1,
    "upgradeChoicesHash": "0x<bytes32>",
    "actionType": "START_RUN"
  },
  "signature": "0x<65-byte EIP-712 signature>",
  "digest": "0x<bytes32>",
  "upgradeChoices": [{ "upgradeId": 0, "quantity": 1 }]
}
```

Submit this payload and its choices to `startRun` on the configured V3 contract. The verifier reports an attestation only after it reserves and persists the matching wallet nonce/signature. The app must wait for a successful chain receipt before showing the run as started.

The API serializes `actionType` symbolically; map it to the contract enum when constructing the Solidity tuple: `START_RUN = 1`, `RECORD_POINTS = 2`, `REBIRTH = 3` (`NONE = 0` is never issued). `natureCollectedAtoms` is a decimal `uint256` string: it is zero for `START_RUN` and `RECORD_POINTS`, and on `REBIRTH` is the verifier-replayed cumulative Nature earned during that run, independent of spending. Values above `uint256` are saturated at `uint256.max` before signing and the lifetime counter also saturates. `upgradeChoices` already contains the numeric Solidity IDs and quantities.

## Run state and commands

### `GET /api/v3/runs/{runId}/recover`

Requires a session. Response:

```json
{
  "cursor": { "runId": "<decimal uint64>", "sequence": 0, "rulesVersion": 1 },
  "canonicalState": "<JSON-encoded canonical run state; integer amounts are decimal strings>",
  "scoreTier": 0,
  "wallet": "0x..."
}
```

### `POST /api/v3/runs/{runId}/commands`

Requires the same-origin `Origin`, `Content-Type: application/json`, and
`Authorization: Bearer <sessionToken>` headers. The session must be bound to the path's wallet,
chain, contract, and run ID. The JSON request envelope is:

```json
{
  "commandId": "<stable client-generated idempotency key, 1–128 characters>",
  "expectedSequence": 0,
  "command": { "type": "heart-click", "quantity": 25 }
}
```

`expectedSequence` is a nonnegative safe integer; a new run starts at sequence `0`. The client must
persist the command ID and exact command before sending so it can retry the same request after an
uncertain response. The verifier assigns `serverTimeMs`; client timestamps and client-provided
balances, production rates, credited/spent amounts, canonical state, and score values are not
accepted as authoritative inputs. Unrecognized envelope fields are ignored.

Supported commands:

```json
{ "type": "heart-click", "quantity": 25 }
{ "type": "sync" }
{ "type": "buy-habitat", "habitat": "water|grass|forest", "quantity": 1 }
{ "type": "buy-temporary-upgrade", "upgrade": "sunny-season|deep-roots" }
```

Heart `quantity` is optional for backwards compatibility (omitted means one click) and, when
present, must be an integer from 1 through 100. A batch is one ordered, idempotent verifier
command; Nature is credited only when the verifier accepts it using canonical rules.

Habitat quantity must be an integer from 1 through 1,000. The verifier validates available Nature,
purchase costs, levels, run status, season, and elapsed server time using rules version 1. Rejected
commands do not advance the sequence. Passive production is based on verifier time and capped at
the rules' eight-hour offline limit.

Success (`200`) returns this JSON-safe shape; `canonicalState` is itself a JSON-encoded string and
all Nature atom amounts inside it are decimal strings:

```json
{
  "accepted": true,
  "commandId": "<same command ID>",
  "cursor": { "runId": "<decimal uint64>", "sequence": 1, "rulesVersion": 1 },
  "serverTimeMs": 0,
  "canonicalState": "{\"rulesVersion\":1,\"runId\":\"1\",\"seasonId\":0,\"natureAtoms\":\"1000000000000\",\"earnedNatureAtoms\":\"1000000000000\",\"sequence\":1}",
  "creditedAtoms": "1000000000000",
  "spentAtoms": "0",
  "scoreTier": 0
}
```

`creditedAtoms` includes verified passive production during the elapsed interval and any Heart-click
credit for this command. `spentAtoms` is the exact canonical command cost. Purchases reduce only
spendable `natureAtoms`; `earnedNatureAtoms` and score tier are monotonic.

For an exact retry (same wallet/run, command ID, expected sequence, and normalized command), the
server returns the originally committed receipt without appending another row or advancing the
cursor. Reusing an ID with different content returns `409 COMMAND_ID_CONFLICT`. A competing or
stale sequence returns a recoverable `409` with the current expected sequence; a future sequence
returns `409 SEQUENCE_GAP`. Rejected rule commands do not consume an ID or sequence, so after
recovering the cursor the client may correct the action and use a new command ID.

## Checkpoint and Rebirth

### `POST /api/v3/runs/{runId}/record-attestation`

Requires a session; empty JSON body is accepted. Returns the current verified score as an EIP-712 `RECORD_POINTS` attestation with `signature` and `digest`. Submit it to V3 `recordPoints`. It awards no PP/CP. If no score tier above the last on-chain checkpoint exists, the API returns a conflict.

### `POST /api/v3/runs/{runId}/rebirth-attestation`

Requires a session; empty JSON body is accepted. Returns an EIP-712 `REBIRTH` attestation only if the replayed score meets the active on-chain rule threshold and is not below the last checkpoint. A prior checkpoint transaction is optional. Submit the response to V3 `rebirth`; clear/advance local run state only after a successful receipt or matching confirmed chain read.

The verifier rechecks confirmed nonce and signer epoch and stores an idempotent payload/signature slot. Attestations bind player, run, season, chain, contract, score, cumulative Nature atoms, nonce, issue/expiry, rules version, signer epoch, upgrade commitment, and action. `natureCollectedAtoms` is zero except on Rebirth; there it is the verifier-replayed run's monotonic `earnedNatureAtoms`, saturated at `uint256.max` for the signed/on-chain metric. The contract accumulates this and the existing `scoreTier` only after successful Rebirth settlement. Expired/consumed nonces require chain recovery before a new request.

Repeating the same request intent (player, run, season, action, score, rules version, upgrade commitment, and confirmed nonce/epoch) while its attestation is pending returns the same persisted payload and signature, including after a lost response or Worker restart. A different intent cannot replace a still-valid pending signature for that nonce; submit or recover the existing transaction, or wait for its expiry before requesting a different attestation. This avoids minting fresh timestamps and conflicting signatures on ordinary retries.

## Errors and recovery

Errors use `{ "code": "...", "message": "..." }`; sequence/recovery errors may include `expectedSequence` and `recovery`.

| HTTP | Common codes                                                                                                                    | Client behavior                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `REQUEST_REJECTED`                                                                                                              | Fix malformed JSON, command shape, command ID, or cursor; do not retry unchanged.                                                                                                                                                                                                               |
| 401  | `UNAUTHENTICATED`                                                                                                               | Reauthenticate wallet, then recover run.                                                                                                                                                                                                                                                        |
| 403  | `REQUEST_REJECTED`                                                                                                              | Check exact allowed Origin and deployment binding.                                                                                                                                                                                                                                              |
| 404  | `RUN_NOT_FOUND`                                                                                                                 | Reconcile run ID and wallet against chain.                                                                                                                                                                                                                                                      |
| 409  | `COMMAND_ID_CONFLICT`, `STALE_CURSOR`, `SEQUENCE_GAP`, `SEASON_EXPIRED`, `RULES_REJECTED`, `RUN_NOT_ACTIVE`, `REQUEST_REJECTED` | Recover server cursor/state. Reuse the same command ID for uncertain retries.                                                                                                                                                                                                                   |
| 503  | `PERSISTENCE_CONFLICT`, `RECOVERY_FAILED`, `VERIFIER_UNAVAILABLE`                                                               | Fail closed; retain local queue and retry only after service/RPC recovery and cursor reconciliation. A `RECOVERY_FAILED` response while resolving a historical `RunStarted` event can mean one bounded page was scanned; repeat the same authenticated request to resume the saved scan cursor. |

For a `409` command response, only retry an identical request automatically when the client cannot
determine whether it was accepted. Otherwise recover with `GET /api/v3/runs/{runId}/recover`, use
the returned sequence, and resolve any command-ID conflict before continuing. Do not infer success
from a local optimistic state update.

Wallet rejection occurs in the browser before submission; preserve the local run and show a retry path. A reverted on-chain transaction does not confirm the action. On an unknown receipt, read run, nonce, checkpoint, and balances before requesting a new signature.

`GET /health` returns `{ "ok": true }` when the API route is reachable. It is a liveness check, not proof that D1, RPC, contract, or attester configuration is healthy.
