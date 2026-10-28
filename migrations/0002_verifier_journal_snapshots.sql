CREATE TABLE IF NOT EXISTS verifier_snapshots (
  run_key TEXT NOT NULL REFERENCES verifier_runs(run_key) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  state TEXT NOT NULL,
  PRIMARY KEY (run_key, sequence)
);

CREATE INDEX IF NOT EXISTS verifier_commands_command_lookup
  ON verifier_commands(run_key, command_id);
