-- Human-reviewed relationships between source assertions. These never publish facts.
CREATE TABLE app.source_assertion_link_decisions (
  household_id TEXT NOT NULL,
  id UUID NOT NULL,
  left_assertion_id TEXT NOT NULL,
  right_assertion_id TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('same_event','distinct_events')),
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  supersedes_id UUID,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  CHECK (left_assertion_id < right_assertion_id),
  UNIQUE (household_id,left_assertion_id,right_assertion_id,revision),
  UNIQUE (household_id,actor_id,request_key),
  FOREIGN KEY (household_id,left_assertion_id) REFERENCES app.source_assertions(household_id,id),
  FOREIGN KEY (household_id,right_assertion_id) REFERENCES app.source_assertions(household_id,id),
  FOREIGN KEY (household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
  FOREIGN KEY (household_id,supersedes_id) REFERENCES app.source_assertion_link_decisions(household_id,id)
);
CREATE INDEX source_assertion_link_decisions_latest
  ON app.source_assertion_link_decisions(household_id,left_assertion_id,right_assertion_id,revision DESC);
CREATE OR REPLACE FUNCTION app.reject_source_assertion_link_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SOURCE_ASSERTION_LINK_DECISIONS_APPEND_ONLY'; END $$;
CREATE TRIGGER source_assertion_link_decisions_append_only
  BEFORE UPDATE OR DELETE ON app.source_assertion_link_decisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_source_assertion_link_mutation();
