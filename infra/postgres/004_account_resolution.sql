-- Explicitly confirmed source-to-account mapping; original source rows remain immutable.
CREATE TABLE app.account_resolutions (
  run_id TEXT NOT NULL REFERENCES app.migration_runs(id),
  household_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision='same_account_confirmed_by_user'),
  actor_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,household_id,source_record_id),
  FOREIGN KEY(run_id,household_id,snapshot_id) REFERENCES app.snapshots(run_id,household_id,id),
  FOREIGN KEY(household_id,account_id) REFERENCES app.accounts(household_id,id),
  FOREIGN KEY(household_id,actor_id) REFERENCES app.memberships(household_id,actor_id)
);
