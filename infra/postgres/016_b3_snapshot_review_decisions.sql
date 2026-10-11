-- Human review of a snapshot difference. These annotations never publish positions.
CREATE TABLE app.b3_snapshot_review_decisions (
  household_id TEXT NOT NULL,
  id UUID NOT NULL,
  prior_document_id TEXT NOT NULL,
  current_document_id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (candidate_hash ~ '^[0-9a-f]{64}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'dismissed')),
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  supersedes_id UUID,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, prior_document_id, current_document_id, candidate_key, revision),
  UNIQUE (household_id, actor_id, request_key),
  FOREIGN KEY (household_id, prior_document_id) REFERENCES app.source_documents(household_id, id),
  FOREIGN KEY (household_id, current_document_id) REFERENCES app.source_documents(household_id, id),
  FOREIGN KEY (household_id, actor_id) REFERENCES app.memberships(household_id, actor_id),
  FOREIGN KEY (household_id, supersedes_id) REFERENCES app.b3_snapshot_review_decisions(household_id, id)
);
CREATE INDEX b3_snapshot_review_latest ON app.b3_snapshot_review_decisions
  (household_id, prior_document_id, current_document_id, candidate_key, revision DESC);
