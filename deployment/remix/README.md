# Compile Worldseed V3 in Remix

The complete Solidity Standard JSON input is `WorldseedGameV3.standard-input.json`. It contains the final `WorldseedGameV3.sol` source and the production compiler settings:

- Solidity `0.8.24` (`0.8.24+commit.e11b9ed9`)
- Optimizer enabled, 500 runs
- `viaIR: true`
- EVM version `shanghai`

The contract is standalone and has no imported Solidity dependencies.

## Remix steps

1. Open Remix and enable the **File Explorer** and **Solidity Compiler** plugins.
2. In File Explorer, create `project/contracts/WorldseedGameV3.sol` and place the exact source from `contracts/WorldseedGameV3.sol` there. Keep this virtual path: the JSON input uses the same source-unit name so the compiler metadata and bytecode match the local production artifact.
3. Add `WorldseedGameV3.standard-input.json` to the Remix workspace from this folder.
4. Open **Solidity Compiler** and select compiler `0.8.24`.
5. Open **Advanced Configuration**, choose **Use configuration file**, and select `WorldseedGameV3.standard-input.json`. Remix's config-file mode uses the JSON settings and the source files present in its workspace; the source path in step 2 must therefore match the JSON key.
6. Compile, then select `WorldseedGameV3` in the contract selector. Confirm the compiler details show optimizer enabled with 500 runs, `viaIR` enabled, and EVM version `shanghai`.
7. For deployment, the constructor inputs are two addresses, in this order:
   1. `owner_` — the intended contract owner.
   2. `attester_` — the verifier's attestation-signing address.

Both constructor addresses must be nonzero and distinct. Decide and verify those public addresses independently before deployment; no addresses are embedded in this file. Compilation does not deploy the contract or submit a transaction.

Remix's Solidity Compiler supports a JSON configuration file in Advanced Configuration; see the [Remix compiler documentation](https://remix-ide.readthedocs.io/en/latest/compile.html#json-file-for-compiler-configuration).
