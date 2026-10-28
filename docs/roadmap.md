# Worldseed roadmap

Worldseed is planned as a focused weekly incremental island-building game. The roadmap has five milestones; each is reviewed before the next begins.

| Milestone                                     | Scope                                                                                                                                     | Status                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1. Guest incremental economy                  | Local Nature production, habitat upgrades, temporary boosts, simulated PP/CP, and rebirth loop.                                           | Implemented; provisionally accepted          |
| 2. Weekly seasons and persistence             | Monday 00:00 UTC seasons, seasonal resets, lifetime records, idempotent archives, versioned saves, and capped local offline production.   | Implemented; pending review                  |
| 3. Optional Record Points                     | Define and implement an optional Record Points transaction flow without making it a progression blocker.                                  | Planned; requires design and security review |
| 4. V3 verified wallet progression             | Reviewed V3 contract and trusted score verification. Keep guest simulation separate; only verified rebirth contributes Community Points.  | Planned; no V3 implementation started        |
| 5. Seasonal community leaderboard and release | Rank verified seasonal Community Points, retain lifetime achievements and contribution history, and complete hosted release verification. | Planned                                      |

Guest PP and CP remain local simulations and never become wallet rewards. Seasonal progression resets weekly; lifetime achievements and contribution history persist. Offline Nature is local, capped at eight hours, and does not authorize onchain rewards.

The current V1 island and World Tree integration remains separate from the future V3 economy. No migration of V1 balances is implied by this roadmap.
