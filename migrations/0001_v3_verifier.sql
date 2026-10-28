CREATE TABLE IF NOT EXISTS verifier_runs (
  run_key TEXT PRIMARY KEY,
  initial_state TEXT NOT NULL,
  head_sequence INTEGER NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS verifier_commands (
  run_key TEXT NOT NULL REFERENCES verifier_runs(run_key) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  command_id TEXT NOT NULL,
  expected_sequence INTEGER NOT NULL CHECK (expected_sequence >= 0),
  command_json TEXT NOT NULL,
  server_time_ms INTEGER NOT NULL,
  state_after TEXT NOT NULL,
  credited_atoms TEXT NOT NULL,
  spent_atoms TEXT NOT NULL,
  PRIMARY KEY (run_key, sequence),
  UNIQUE (run_key, command_id)
);

CREATE TRIGGER IF NOT EXISTS verifier_command_sequence_guard
BEFORE INSERT ON verifier_commands
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM verifier_runs
    WHERE run_key = NEW.run_key AND head_sequence = NEW.expected_sequence
      AND NEW.sequence = NEW.expected_sequence + 1
  ) THEN RAISE(ABORT, 'sequence conflict') END;
END;

CREATE TRIGGER IF NOT EXISTS verifier_run_head_guard
BEFORE UPDATE OF head_sequence ON verifier_runs
WHEN NEW.head_sequence != OLD.head_sequence
BEGIN
  SELECT CASE WHEN NEW.head_sequence != OLD.head_sequence + 1 OR NOT EXISTS (
    SELECT 1 FROM verifier_commands
    WHERE run_key = NEW.run_key AND sequence = NEW.head_sequence
      AND expected_sequence = OLD.head_sequence
  ) THEN RAISE(ABORT, 'sequence head conflict') END;
END;

CREATE TABLE IF NOT EXISTS wallet_challenges (
  challenge_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  verifying_contract TEXT NOT NULL,
  origin TEXT NOT NULL,
  run_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS wallet_sessions (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  verifying_contract TEXT NOT NULL,
  origin TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES wallet_challenges(challenge_id)
);
CREATE INDEX IF NOT EXISTS wallet_sessions_expiry ON wallet_sessions(expires_at_ms);

CREATE TABLE IF NOT EXISTS attestation_slots (
  chain_id TEXT NOT NULL,
  verifying_contract TEXT NOT NULL,
  player TEXT NOT NULL,
  nonce TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  run_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  signature TEXT,
  signer_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'cancelled')),
  PRIMARY KEY (chain_id, verifying_contract, player, nonce)
);

CREATE TABLE IF NOT EXISTS chain_checkpoints (
  chain_id TEXT NOT NULL,
  verifying_contract TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, verifying_contract)
);
