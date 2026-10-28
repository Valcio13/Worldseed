# Worldseed roadmap

This document describes the current product state, not the original milestone plan. Guest progression remains local and simulated; Live progression is separately verifier-authoritative.

| Area                                  | Current status                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guest incremental game                | Implemented: seasonal Nature, six habitats, boosts, PP/CP simulation, Rebirth, and local persistence.                                                                    |
| Seasonal behavior                     | Implemented locally: Monday 00:00 UTC boundaries, seasonal resets, lifetime records, archives, and capped offline Nature.                                                |
| Live V3 progression                   | Implemented and deployed for Hemi Mainnet and Hemi Sepolia. Runs are versioned; Start Run, commands, optional Record Points, and Rebirth use the verifier/contract flow. |
| Hosted environments                   | Separate frontend and verifier Workers with isolated network configuration. Manual authenticated browser QA remains the release-level validation for wallet flows.       |
| Future leaderboard experience         | Not part of the current core loop; do not treat stored CP/high-score data as a shipped leaderboard UI.                                                                   |
| Legacy restoration and puzzle systems | Retained separately in source; they do not become verified incremental progress or transfer into V3.                                                                     |

Guest PP and CP are simulations and never become wallet rewards. V1/V2 balances and World Tree contributions are not migrated into V3. See [deployment notes](deployment.md) for environment details and release checks.
