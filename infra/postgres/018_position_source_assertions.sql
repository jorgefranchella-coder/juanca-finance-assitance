-- Preserve the exact source row that introduced each persisted position identity.
ALTER TABLE app.position_identities ADD COLUMN source_assertion_id TEXT;
ALTER TABLE app.position_identities ADD CONSTRAINT position_identity_source_assertion
  FOREIGN KEY (household_id,source_assertion_id)
  REFERENCES app.source_assertions(household_id,id);
CREATE UNIQUE INDEX position_identity_source_assertion_unique
  ON app.position_identities(household_id,source_assertion_id)
  WHERE source_assertion_id IS NOT NULL;
