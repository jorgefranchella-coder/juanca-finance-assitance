-- Human decisions about evidence correspondence; these do not apply financial facts.
CREATE TABLE app.manual_b3_link_decisions (
  household_id TEXT NOT NULL,
  id UUID NOT NULL,
  intake_id UUID NOT NULL,
  assertion_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>0),
  decision TEXT NOT NULL CHECK (decision IN ('related','not_related')),
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  supersedes_id UUID,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  UNIQUE (household_id,intake_id,assertion_id,revision),
  UNIQUE (household_id,actor_id,request_key),
  FOREIGN KEY (household_id,intake_id) REFERENCES app.manual_intakes(household_id,id),
  FOREIGN KEY (household_id,assertion_id) REFERENCES app.source_assertions(household_id,id),
  FOREIGN KEY (household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
  FOREIGN KEY (household_id,supersedes_id) REFERENCES app.manual_b3_link_decisions(household_id,id)
);
CREATE INDEX manual_b3_link_decisions_latest ON app.manual_b3_link_decisions(household_id,intake_id,assertion_id,revision DESC);
