-- Deterministic readings of written evidence; these never change portfolio facts.
CREATE TABLE app.manual_trade_interpretations (
  household_id TEXT NOT NULL,
  intake_id UUID NOT NULL,
  parser_version TEXT NOT NULL,
  interpretation_status TEXT NOT NULL CHECK (interpretation_status IN ('parsed_review','needs_manual_review','not_detected')),
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_reasons TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,intake_id),
  FOREIGN KEY (household_id,intake_id) REFERENCES app.manual_intakes(household_id,id)
);
