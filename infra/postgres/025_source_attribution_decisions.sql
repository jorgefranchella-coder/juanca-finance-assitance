-- Append-only correction layer for source observations whose uploader/owner attribution was wrong.
-- Raw documents and source_assertions remain immutable; consumers must use the latest decision.
CREATE TABLE app.source_attribution_decisions (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_owner_id TEXT NOT NULL,
  attributed_owner_id TEXT NOT NULL,
  custody_account_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('user_confirmed_attribution')),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  supersedes_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  UNIQUE (household_id,assertion_id,revision),
  UNIQUE (household_id,actor_id,request_key),
  FOREIGN KEY (household_id,assertion_id) REFERENCES app.source_assertions(household_id,id),
  FOREIGN KEY (household_id,source_owner_id) REFERENCES app.owners(household_id,id),
  FOREIGN KEY (household_id,attributed_owner_id) REFERENCES app.owners(household_id,id),
  FOREIGN KEY (household_id,custody_account_id,attributed_owner_id) REFERENCES app.custody_accounts(household_id,id,owner_id),
  FOREIGN KEY (household_id,supersedes_id) REFERENCES app.source_attribution_decisions(household_id,id),
  CHECK ((revision=1 AND supersedes_id IS NULL) OR (revision>1 AND supersedes_id IS NOT NULL))
);
CREATE INDEX source_attribution_decisions_latest
  ON app.source_attribution_decisions(household_id,assertion_id,revision DESC);
CREATE OR REPLACE FUNCTION app.reject_source_attribution_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SOURCE_ATTRIBUTION_DECISIONS_APPEND_ONLY' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER source_attribution_decisions_append_only
  BEFORE UPDATE OR DELETE ON app.source_attribution_decisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_source_attribution_decision_mutation();
