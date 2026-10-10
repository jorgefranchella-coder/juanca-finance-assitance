-- Parser revisions never rewrite the original document row or its first interpretation.
CREATE TABLE app.source_interpretations (
  household_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  instrument_code TEXT,
  tentative_event_type TEXT,
  status TEXT NOT NULL CHECK (status IN ('parsed','needs_review')),
  review_reasons TEXT[] NOT NULL DEFAULT '{}',
  interpreted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,assertion_id,parser_version),
  FOREIGN KEY (household_id,assertion_id) REFERENCES app.source_assertions(household_id,id)
);
