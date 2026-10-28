CREATE TABLE IF NOT EXISTS run_started_event_scans (
  chain_id TEXT NOT NULL,
  verifying_contract TEXT NOT NULL,
  player TEXT NOT NULL,
  run_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  next_block INTEGER NOT NULL,
  scanned_through INTEGER NOT NULL,
  scanned_block_hash TEXT,
  event_json TEXT,
  event_block_number INTEGER,
  event_block_hash TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, verifying_contract, player, run_id, season_id)
);
