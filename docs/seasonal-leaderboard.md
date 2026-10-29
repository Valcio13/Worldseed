# Seasonal Live Leaderboard

The Live leaderboard reads confirmed `RebirthSettled` events from the configured V3 contract. It ranks the current contract season by settled CP (descending), then Nature reported for settled runs (descending). Wallet addresses are shortened in the UI. Guest/simulated progress is never included.

Nature is indexed from the settlement event's `natureCollectedAtoms` field. It therefore represents Nature earned in runs that have completed Rebirth; un-settled active or abandoned runs are not represented. Values are stored as integer atoms (`10^12` atoms per Nature) and aggregated with integer arithmetic.

The public `GET /api/v3/leaderboard` endpoint scans at most 1,000 confirmed blocks per request and resumes from a D1 cursor. Reopening or refreshing the leaderboard advances historical indexing until current confirmed history is reached. Duplicate event ingestion is prevented by transaction hash and log index. A changed checkpoint block hash triggers a rebuild of the index for that contract.

The modal also shows community-wide CP for the season directly from the contract's `totalSeasonCP` and `MAX_SEASON_POINTS` getters. The bar is progress toward the contract's shared seasonal CP cap (currently 1,000,000), not a separate community reward goal. It remains accurate even while the leaderboard event index is catching up.

## Deployment note

Before deploying a verifier build with leaderboard support, apply `migrations/0004_seasonal_leaderboard.sql` to each isolated verifier D1 database (Sepolia and Mainnet separately). This migration only adds the leaderboard scan cursor, settlement-event index, and season/player lookup index. Then deploy the matching verifier and frontend builds. No contract change or onchain transaction is required.
