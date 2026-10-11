-- A B3 assertion can identify the custodian account for a legacy snapshot row.
-- This links identity evidence only; it does not apply position or transaction facts.
CREATE TABLE app.position_account_resolutions (
  run_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  resolution_version INTEGER NOT NULL CHECK (resolution_version > 0),
  snapshot_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  custody_account_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision='same_custody_account_confirmed_by_institution_uniqueness'),
  actor_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,household_id,source_record_id,resolution_version),
  FOREIGN KEY (run_id,household_id,snapshot_id) REFERENCES app.snapshots(run_id,household_id,id),
  FOREIGN KEY (household_id,assertion_id) REFERENCES app.source_assertions(household_id,id),
  FOREIGN KEY (household_id,custody_account_id) REFERENCES app.custody_accounts(household_id,id),
  FOREIGN KEY (household_id,actor_id) REFERENCES app.memberships(household_id,actor_id)
);
CREATE INDEX position_account_resolution_latest ON app.position_account_resolutions(run_id,household_id,source_record_id,resolution_version DESC);
CREATE OR REPLACE FUNCTION app.reject_position_account_resolution_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POSITION_ACCOUNT_RESOLUTIONS_APPEND_ONLY'; END $$;
CREATE TRIGGER position_account_resolutions_append_only
  BEFORE UPDATE OR DELETE ON app.position_account_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.reject_position_account_resolution_mutation();
