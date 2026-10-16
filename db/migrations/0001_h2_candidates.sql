CREATE TABLE IF NOT EXISTS candidate_sets (
  player TEXT NOT NULL,
  expedition_number INTEGER NOT NULL,
  commitment TEXT NOT NULL,
  payload TEXT NOT NULL,
  selected_source TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (player, expedition_number)
);

CREATE TABLE IF NOT EXISTS issuance_challenges (
  id TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS issuance_challenges_expiry ON issuance_challenges(expires_at);

CREATE TABLE IF NOT EXISTS challenge_rate_limits (
  player TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (player, window_start)
);
