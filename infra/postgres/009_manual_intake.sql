-- Original written evidence is immutable; interpretation and application are separate.
CREATE TABLE app.manual_intakes (
  household_id TEXT NOT NULL,
  id UUID NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  owner_id TEXT NOT NULL,
  original_text TEXT NOT NULL CHECK (length(original_text) BETWEEN 1 AND 8000),
  occurred_on DATE,
  status TEXT NOT NULL DEFAULT 'awaiting_review' CHECK (status IN ('awaiting_review','linked','rejected')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  UNIQUE (household_id,request_key),
  FOREIGN KEY (household_id,owner_id) REFERENCES app.owners(household_id,id)
);
CREATE INDEX manual_intakes_owner_received ON app.manual_intakes(household_id,owner_id,received_at DESC);
