# V3 Local Verifier Foundation (Milestone 4A)

This is an implementation note for the local-only foundation. The approved architecture and reward semantics remain in [the V3 design](./v3-contract-and-score-verification-design.md). This work adds no wallet transactions, signature service, public API, or contract.

Milestone 4A recorded the foundation before durable server infrastructure was added. Its persistence/security gaps below describe the 4A state and are superseded by [Milestone 4B](./v3-verifier-infrastructure-4b.md); 4B still does not run a public service or sign attestations.

## Modules

- `src/incremental/rulesV1.ts` is the pure rules implementation. It uses `BigInt` Nature atoms and is independent of React, browser storage, wallets, and network APIs.
- `src/incremental/localVerifier.ts` validates authenticated, sequenced commands against that rules module. It has injected clock, wallet-session, onchain-run authority, and persistence interfaces. It is a library, not a running verifier service.
- `src/incremental/verifierProtocol.ts` defines request, receipt, cursor, error, and future attestation data contracts.
- `src/incremental/verified/index.ts` is the import boundary for the V3 rules and verifier surface.

The existing guest engine and IndexedDB save path are unchanged. Guest saves are not read by this verifier and cannot become verified wallet progression through this implementation.

## Canonical rules

`RULES_VERSION` is `1`. Nature uses `10^12` atoms per Nature; zero is `0n`, values below one atom do not exist, positive rational credits round down, and costs round up. The implementation preserves the current economy's listed base habitat prices, cost growth ratios, production rates, adjacency bonuses, milestones, temporary upgrades, PP upgrade effects, and run-start awakening grant. This fixes arithmetic semantics; it is not a balance change or endorsement of final reward constants.

Production is calculated with integer rational multipliers. Elapsed server milliseconds are multiplied by atom-per-second production; a remainder in milli-atoms is carried so splitting the same interval across syncs does not lose fractions. Per-operation floors apply to gains and ceilings to prices. Purchases deduct only spendable `natureAtoms`; the run's `earnedNatureAtoms` is cumulative and cannot decrease. Only the portion actually credited within the spendable cap is counted as earned, matching the approved spec. Starting grant and purchased upgrades do not increase the score.

`scoreTierFromEarnedNature` implements the approved integer-only bucket function, returns zero below one Nature, floors the integer significand, and saturates at `65,535` with the specified atom bound. There is no conversion to JavaScript `Number` in Nature or score calculations.

## Command contract and sequencing

The frontend sends `CommandRequest`: session token, run ID, stable command ID, expected previous sequence, and a typed command. A client timestamp may be present for diagnostics but is ignored. The verifier derives wallet identity from `WalletSessionAuthenticator`, then uses `RunAuthorityReader` to confirm the run and season against the chain. Neither identity, run status, season, time, cost, state, nor score is trusted from the request.

Sequences are counts of accepted commands: a new run begins at sequence `0`; its first accepted event has sequence `1`. The verifier replays from the chain-derived run-start context, applies server receipt time and shared rules, then atomically appends the event with the new state, credited/spent atom strings, timestamp, command ID, and sequence. A retry of the same ID and same payload returns the stored receipt. Reusing an ID with different content is rejected. A lower cursor returns `STALE_CURSOR` with the canonical sequence; a higher cursor returns `SEQUENCE_GAP` with the expected sequence. Rules rejection does not consume a sequence.

`CommandReceipt` is the in-process form. At an HTTP boundary, Nature amounts and state `BigInt`s must be decimal strings (`CommandReceiptWire.canonicalState` uses canonical JSON); they must never be JSON numbers. The client reconciles on `(runId, sequence, rulesVersion)` and treats local optimistic state as pending until accepted.

The typed `V3AttestationData` matches the approved future `ScoreAttestation` fields, including the upgrade choices commitment and action type. This library does not create that commitment, EIP-712 digest, or signature. Final commitment encoding must use the contract's reviewed `keccak256(abi.encode(...))` vector before wallet integration.

## Persistence and recovery contract

`VerifierPersistence` requires:

1. `initializeIfAbsent` for the canonical state derived from the onchain run start;
2. append-only ordered command events;
3. an atomic compare-and-swap on head sequence plus unique constraints for `(run, sequence)` and `(run, commandId)`;
4. persistence of the command result and state transition in the same transaction.

The included `MemoryVerifierPersistence` is for local tests only. A future database adapter must implement those transaction and uniqueness guarantees. On restart, the verifier replays every event, checks sequence continuity, recomputes each state/result, checks the journal head and the authoritative initial run state, and fails closed if anything differs. It does not recover verified progress from IndexedDB.

Passive production uses the verifier's injected clock, at most eight hours per accepted interval, and never crosses the run season end. Client timestamps and queued offline actions are not backdated. A request after rollover is rejected; the old accepted log remains recoverable for reconciliation, but cannot earn more or mint a new-season result. The chain remains authoritative for whether a run is active.

## Deliberate gaps before contract implementation

- No durable database adapter, wallet challenge/session issuer, request transport, CSRF/rate-limit layer, chain reader, indexer, or signing key exists here.
- `MemoryVerifierPersistence` does not provide cross-process locking, backup, durability, or production security.
- No client UI is connected to these rules; existing guest gameplay remains on its current engine.
- The pinned rules build hash and published cross-language test vectors must be produced in a release process.
- Solidity-compatible upgrade choice encoding, EIP-712 signing/recovery, contract nonce behavior, and V3 state transitions require separate implementation and adversarial tests.
- Reward constants and gameplay balance remain provisional; this milestone does not simulate or adjust them.
