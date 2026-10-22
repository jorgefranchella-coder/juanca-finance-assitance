-- Explicit approval to replace a holder's B3 positions with a complete position report.
-- Movement assertions remain evidence only and are never applied by this command.
ALTER TABLE app.position_account_resolutions
  DROP CONSTRAINT position_account_resolutions_decision_check,
  ADD CONSTRAINT position_account_resolutions_decision_check CHECK (decision IN (
    'same_custody_account_confirmed_by_institution_uniqueness',
    'user_confirmed_institution_uniqueness',
    'custody_account_reference_observed'
  ));
CREATE TABLE app.b3_snapshot_publications (
  household_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  run_id TEXT NOT NULL REFERENCES app.migration_runs(id),
  portfolio_version TEXT NOT NULL,
  position_count INTEGER NOT NULL CHECK (position_count > 0),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, document_id),
  UNIQUE (household_id, actor_id, request_key),
  FOREIGN KEY (household_id, document_id) REFERENCES app.source_documents(household_id, id),
  FOREIGN KEY (household_id, actor_id) REFERENCES app.memberships(household_id, actor_id),
  FOREIGN KEY (household_id, portfolio_version) REFERENCES app.portfolio_versions(household_id, id)
);
CREATE FUNCTION app.reject_b3_snapshot_publication_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'B3_SNAPSHOT_PUBLICATIONS_APPEND_ONLY'; END $$;
CREATE TRIGGER b3_snapshot_publications_append_only
  BEFORE UPDATE OR DELETE ON app.b3_snapshot_publications
  FOR EACH ROW EXECUTE FUNCTION app.reject_b3_snapshot_publication_mutation();
