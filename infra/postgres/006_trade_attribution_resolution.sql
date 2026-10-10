-- A user-confirmed owner and custody assignment for one immutable source trade.
CREATE TABLE app.trade_attribution_resolutions(
  run_id TEXT NOT NULL REFERENCES app.migration_runs(id),
  household_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_owner_ref TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision='owner_and_account_confirmed_by_user'),
  actor_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,household_id,source_record_id),
  FOREIGN KEY(run_id,household_id,snapshot_id) REFERENCES app.snapshots(run_id,household_id,id),
  FOREIGN KEY(household_id,owner_id) REFERENCES app.owners(household_id,id),
  FOREIGN KEY(household_id,account_id) REFERENCES app.accounts(household_id,id),
  FOREIGN KEY(household_id,actor_id) REFERENCES app.memberships(household_id,actor_id)
);
