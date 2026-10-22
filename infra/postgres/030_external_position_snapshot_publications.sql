-- Reviewed snapshots from non-B3 custodians; source documents remain immutable.
CREATE TABLE app.external_position_snapshot_publications (
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
CREATE FUNCTION app.reject_external_snapshot_publication_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EXTERNAL_SNAPSHOT_PUBLICATIONS_APPEND_ONLY'; END $$;
CREATE TRIGGER external_snapshot_publications_append_only
  BEFORE UPDATE OR DELETE ON app.external_position_snapshot_publications
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_snapshot_publication_mutation();
