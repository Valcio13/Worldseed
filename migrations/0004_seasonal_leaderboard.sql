CREATE TABLE IF NOT EXISTS leaderboard_scans (
  chain_id TEXT NOT NULL,
  verifying_contract TEXT NOT NULL,
  next_block INTEGER NOT NULL,
  scanned_through INTEGER NOT NULL,
  scanned_block_hash TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, verifying_contract)
);

CREATE TABLE IF NOT EXISTS leaderboard_rebirth_events (
  chain_id TEXT NOT NULL,
  verifying_contract TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  season_id TEXT NOT NULL,
  player TEXT NOT NULL,
  nature_atoms TEXT NOT NULL,
  cp_awarded TEXT NOT NULL,
  PRIMARY KEY (chain_id, verifying_contract, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS leaderboard_season_player
  ON leaderboard_rebirth_events(chain_id, verifying_contract, season_id, player);
