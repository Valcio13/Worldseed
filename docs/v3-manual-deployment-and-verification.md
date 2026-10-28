# Worldseed V3 Manual Deployment Notes

This is a manual deployment checklist for the separate V3 contract. There is no V3 deployment script or CI/CD deployment workflow in this repository. Do not use the V1/V2 deployment command for V3.

## Constructor arguments

`WorldseedGameV3(address owner_, address attester_)`

Pass arguments in this order:

1. `owner_`: the intended multisig address. It receives pause, unpause, delayed signer/rules administration, and ownership-transfer authority.
2. `attester_`: the address derived from the EOA key that the verifier will use to sign V3 EIP-712 attestations.

Both must be nonzero and distinct. The attester key must remain outside source control and must never be the owner key. V3 source does not create a World Tree contribution; rebirth awards seasonal/lifetime CP only. Existing V1/V2 World Tree accounting is separate.

## Before deploying

- Decide the explicit target chain and chain ID; this contract has no Hemi-specific network guard. Review the selected network in the wallet/deployment tool before signing.
- Deploy the exact compiled source at `contracts/WorldseedGameV3.sol` with Solidity 0.8.24 and the production settings in `hardhat.config.ts`: optimizer enabled, 500 runs, and `viaIR: true`. Record compiler version, settings, source hash, and deployment artifact.

Lifetime statistic reads are available through `lifetimeNatureCollectedAtoms(address)`, `totalAccumulatedRebirthScore(address)`, and `seasonalAccumulatedRebirthScore(address,uint64)`. `RebirthSettled` includes the settled `rulesVersion` and per-run `natureCollectedAtoms`; its existing `scoreTier` is the individual Rebirth Score.

- Confirm owner and attester addresses independently. Fund only the deployer with that target chain’s native gas token. Do not use a player wallet or reuse a V1/V2 signing key.
- Run `npm run contract:compile` and `npm run contract:test -- --no-compile` against the same source/artifact before deployment.
- Review the contest rules in `docs/v3-solidity-implementation-4c.md`. V1 Rebirth threshold is tier 35; V2 tier 42 remains inactive until the owner completes the delayed rules proposal. The verifier derives score from accepted commands and never accepts a client-supplied score.
- Prepare the verifier’s chain ID, contract address, deployment block, event start block, confirmation depth, rules version, attester key custody, durable database, backup/recovery, HTTPS/session origin, request limits, and monitoring before enabling player traffic. The local SQLite verifier is not a production host configuration.

## After deployment

Read the following from the selected chain and compare against the deployment record:

- Receipt is successful; record transaction hash, block number, gas used, and deployed address.
- `owner()` equals the intended multisig; `attester()` equals the intended signer address; the two differ; `signerEpoch()` starts at `1`; `paused()` is `false`.
- `activeRulesVersion()` is `1`. Read `rewardRules(1)` and confirm threshold tier `35`, PP parameters, season caps, max upgrade level, and CP milestone step `7`. Read `seasonalHighScoreTier(player, seasonId)` for a test wallet and confirm it starts at zero.
- `currentSeasonId()` agrees with `floor((block.timestamp - 345600) / 604800)` for the confirmed block timestamp. `seasonStart(id)` and `seasonEnd(id)` should delimit that Monday-to-Monday UTC week.
- `MAX_ATTESTATION_LIFETIME()` is 300 seconds. The deployed ABI exposes `startRun`, `recordPoints`, `rebirth`, and `abandonRun` with the argument shapes documented in the 4C record.
- Confirm deployed bytecode corresponds to the reviewed production artifact and submit source verification using the selected chain’s supported explorer process. A matching local bytecode hash is useful deployment evidence, but is not public source verification.

Do not enable the verifier until its configured chain, contract, confirmed deployment block, owner/attester addresses, signer epoch, and EIP-712 domain all match these on-chain reads. Then exercise the two required transactions with a disposable test wallet and a verified attainable score before player launch.

To enable canonical rules V2 (threshold tier `42`), the owner must call `proposeRewardRules(2, (42, 10, 1000, 1, 100000, 100000, 100, 7))`, wait the existing two-day delay, and call `activateRewardRules(2)`. The tuple order is `(rebirthThresholdTier, ppStep, ppPerRebirthCap, ppBase, seasonPPCap, seasonCPCap, maxUpgradeLevel, cpMilestoneStep)`. New runs use the active version; already-started runs retain their pinned version. Each new rules version must keep per-player seasonal caps at or below the preceding active version so a version switch cannot reopen cap capacity.

## Current validation status

The V3 contract was compiled locally with solc 0.8.24 and the contract suite passed. The local loopback integration now covers authenticated Start Run, canonical command progression to a V1 score in tiers 42–48, Record Points, verifier-issued Rebirth, and successful onchain settlement with PP, CP, and seasonal high-water assertions. The verifier remains a local development implementation; it is not a hosted service and is not connected to the public frontend. No V3 contract deployment has been performed by this work.
