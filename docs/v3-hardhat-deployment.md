# Worldseed V3 Hardhat deployment

This workflow uses the existing `WorldseedGameV3` artifact and the production Hardhat compiler profile. It does not change contract source or run automatically as part of a build.

## Compiler and constructor

- Solidity: `0.8.24`
- Optimizer: enabled, 500 runs
- `viaIR`: enabled
- EVM target: Shanghai (the Solidity 0.8.24 default, confirmed in the generated build info)
- Constructor argument order: `owner_`, then `attester_`
- Both constructor addresses must be valid, nonzero, and different.
- Hemi Sepolia chain ID: `743111`

The script prints the artifact creation-bytecode Keccak-256 hash and the deployment initcode Keccak-256 hash (the latter includes the selected constructor arguments). These are review identifiers, not a source-verification result.

## Local simulation

In PowerShell, supply the two public addresses for the simulation:

```powershell
$env:WORLDSEED_V3_OWNER_ADDRESS = Read-Host "Owner public address"
$env:WORLDSEED_V3_ATTESTER_ADDRESS = Read-Host "Attester public address"
$env:WORLDSEED_V3_MODE = "simulate"
npm run contract:compile
npm run contract:deploy:v3
```

Simulation uses an in-memory Hardhat network, deploys the final artifact there, and checks the constructor getters. It does not connect to Hemi Sepolia or broadcast a public transaction.

## Owner-operated Hemi Sepolia deployment

First configure the existing Hardhat variables `HEMI_SEPOLIA_RPC_URL` and `HEMI_SEPOLIA_PRIVATE_KEY` in the owner's local environment using the project's established secret-handling process. The private key must belong to a funded Hemi Sepolia deployer. Do not put it in source control or pass it as a command-line argument.

Then set the public constructor addresses and run:

```powershell
$env:WORLDSEED_V3_OWNER_ADDRESS = Read-Host "Owner public address"
$env:WORLDSEED_V3_ATTESTER_ADDRESS = Read-Host "Attester public address"
$env:WORLDSEED_V3_MODE = "deploy"
npm run contract:compile
npm run contract:deploy:v3
```

The script connects specifically to the configured `hemiSepolia` network, checks chain ID `743111`, estimates gas and the execution fee, and prints all constructor inputs and bytecode hashes. It proceeds only after the operator types `DEPLOY HEMI SEPOLIA`. The wallet configured in Hardhat then submits the transaction. The script waits for the receipt and checks `owner()`, `attester()`, and the chain ID before reporting success. A fee estimate may exclude Hemi's chain-specific L1 data fee; inspect the wallet/RPC estimate before approving.

If the chain check fails, the script stops before submitting. To cancel at the confirmation prompt, enter anything else or press Ctrl+C. The default mode is `simulate`; deployment is never the default.

## After manual deployment

Save the resulting address, transaction hash, block number, receipt status, and gas used. Verify the constructor values on Hemi Sepolia and verify the source using the explorer's supported Solidity Standard JSON workflow with the same compiler settings. Do not treat the printed bytecode hash alone as source verification.
